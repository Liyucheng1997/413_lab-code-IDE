// 订阅通道：通过本机已登录的 Claude Code（claude CLI）运行 AI 助手，用的是 Claude 订阅额度而不是 API Key。
// 只适合自己电脑上的个人使用：复用的是你自己在终端里 `claude` 登录的账号。
// IDE 的工具以进程内 MCP 服务器（名字 lumen）提供给 Claude Code，仍由界面执行并确认；Claude Code 自带的工具全部关闭。
// 额度用完、未登录等情况返回 { fallback }，由 ai-service 切换到 API 继续。
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { app } = require('electron');

// 注意：MCP 服务器不能叫 ide，Claude Code 把这个名字留给自己的编辑器集成，会丢掉它的工具
const SERVER = 'lumen';
const PREFIX = `mcp__${SERVER}__`;
// 这些错误说明订阅本身用不了，换 API 能继续；其他错误（过载、参数错误等）换通道也没用
const FALLBACK_ERRORS = new Set(['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required', 'billing_error', 'rate_limit']);
const ERROR_TEXT = {
  authentication_failed: '本机 Claude Code 未登录或登录已过期',
  oauth_org_not_allowed: '当前组织不允许使用订阅登录',
  account_on_hold: '账号被暂停',
  verification_required: '账号需要验证',
  billing_error: '订阅账单异常',
  rate_limit: '订阅额度已用完',
};

let sdk = null;
let cliCache;
let blockedUntil = 0; // 额度用完后到重置时间之前，新对话直接走 API
let blockedReason = '';

// 找本机的 claude 命令（PATH 里的，或官方安装脚本的默认位置）
function findCli() {
  if (cliCache !== undefined) return cliCache;
  cliCache = null;
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['claude'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    cliCache = lines.find((l) => /\.exe$/i.test(l)) || lines[0] || null;
  } catch {}
  if (!cliCache) {
    const p = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
    if (fs.existsSync(p)) cliCache = p;
  }
  return cliCache;
}

function status() {
  const now = Date.now();
  return { cli: !!findCli(), blockedUntil: blockedUntil > now ? blockedUntil : 0, blockedReason: blockedUntil > now ? blockedReason : '' };
}

function available() {
  return !!findCli() && Date.now() >= blockedUntil;
}

async function loadSdk() {
  if (!sdk) {
    const [agent, zod] = await Promise.all([import('@anthropic-ai/claude-agent-sdk'), import('zod')]);
    sdk = { ...agent, z: zod.z };
  }
  return sdk;
}

// 工具的 JSON Schema 转成 SDK 需要的 zod 写法（只用到了简单类型）
function toZod(z, p) {
  let t;
  if (p.enum) t = z.enum(p.enum);
  else if (p.type === 'string') t = z.string();
  else if (p.type === 'integer') t = z.number().int();
  else if (p.type === 'number') t = z.number();
  else if (p.type === 'boolean') t = z.boolean();
  else if (p.type === 'array') t = z.array(p.items ? toZod(z, p.items) : z.any());
  else if (p.type === 'object') t = z.object(shape(z, p));
  else t = z.any();
  return p.description ? t.describe(p.description) : t;
}

function shape(z, schema) {
  const out = {};
  for (const [k, p] of Object.entries(schema.properties || {})) {
    const t = toZod(z, p);
    out[k] = (schema.required || []).includes(k) ? t : t.optional();
  }
  return out;
}

// 给 Claude Code 的环境：去掉 API Key，避免它改用 API 计费；
// 也去掉从别的 Claude 会话继承来的变量（比如在 Claude Code 里启动 IDE 时），它们会改变 CLI 的行为
function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE|ANTHROPIC_|MCP_)/i.test(k) && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
  env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false'; // 不加载 claude.ai 账号里的连接器
  env.CLAUDE_AGENT_SDK_CLIENT_APP = `lumen-ide/${app.getVersion()}`;
  return env;
}

// 输入队列：同一个对话的多轮消息送进同一个 Claude Code 进程
function inputQueue() {
  const items = [];
  let wake = null;
  let closed = false;
  return {
    push(m) {
      items.push(m);
      if (wake) wake();
    },
    close() {
      closed = true;
      if (wake) wake();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (items.length) yield items.shift();
        if (closed) return;
        await new Promise((r) => (wake = r));
        wake = null;
      }
    },
  };
}

// 每个 IDE 对话对应一个常驻的 Claude Code 进程
async function open(session, deps) {
  const { query, createSdkMcpServer, tool, z } = await loadSdk();
  const s = deps.config();
  const web = deps.webSearch();
  const server = createSdkMcpServer({
    name: SERVER,
    alwaysLoad: true,
    tools: deps.tools.map((t) =>
      tool(t.name, t.description, shape(z, t.input_schema), async (args, extra) => {
        const id = (extra && extra._meta && extra._meta['claudecode/toolUseId']) || `call_${Date.now()}`;
        const problem = deps.validateInput(t.name, args);
        if (problem) {
          deps.emit({ type: 'tool_invalid', id, message: problem });
          return { content: [{ type: 'text', text: `INVALID_INPUT: ${problem}` }], isError: true };
        }
        const r = await deps.callTool(id, t.name, args);
        return { content: [{ type: 'text', text: String(r.content || '（无输出）') }], ...(r.isError ? { isError: true } : {}) };
      }),
    ),
  });
  const inbox = inputQueue();
  const stderr = [];
  const q = query({
    prompt: inbox,
    options: {
      pathToClaudeCodeExecutable: findCli(),
      env: cleanEnv(),
      cwd: deps.cwd() || os.homedir(),
      model: s.model,
      effort: s.effort,
      thinking: { type: 'adaptive', display: 'summarized' },
      systemPrompt: deps.systemPrompt(),
      tools: web ? ['WebSearch'] : [],
      allowedTools: [...deps.tools.map((t) => PREFIX + t.name), ...(web ? ['WebSearch'] : [])],
      mcpServers: { [SERVER]: server },
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
      includePartialMessages: true,
      maxTurns: deps.maxRounds,
      stderr: (d) => {
        stderr.push(d);
        if (stderr.length > 40) stderr.shift();
      },
    },
  });
  session.sub = { q, inbox, stderr, model: s.model, effort: s.effort };
  return session.sub;
}

function close(session) {
  const sub = session.sub;
  if (!sub) return;
  session.sub = null;
  sub.inbox.close();
  try {
    sub.q.close();
  } catch {}
}

function interrupt(session) {
  if (session.sub) session.sub.q.interrupt().catch(() => {});
}

function plainName(name) {
  return name && name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name;
}

function short(v, n) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// 跑一轮对话。返回 { ok } 或 { fallback: 原因, partial: 本轮是否已经有输出 }
async function runTurn(session, userText, deps) {
  const transcript = (session.transcript = session.transcript || []);
  transcript.push(`【用户】\n${userText}`);
  let sub;
  try {
    sub = session.sub || (await open(session, deps));
  } catch (err) {
    return { fallback: '无法启动本机 Claude Code：' + (err.message || err), partial: false };
  }
  // 对话中途在面板或设置里改了强度、模型：直接改正在运行的 Claude Code，不用重开对话
  const s = deps.config();
  try {
    if (s.effort !== sub.effort) await sub.q.applyFlagSettings({ effortLevel: s.effort });
    if (s.model !== sub.model) await sub.q.setModel(s.model);
    sub.effort = s.effort;
    sub.model = s.model;
  } catch {}
  sub.inbox.push({ type: 'user', message: { role: 'user', content: userText }, parent_tool_use_id: null });

  let round = -1;
  let partial = false;
  let limit = null; // 本轮收到的 rate_limit_event（rejected）
  let failure = null; // assistant 消息上的错误类型
  const webSearches = new Set();
  const toolNames = new Map();
  let model = null; // 实际回复用的模型（modelUsage 里还有 Claude Code 自己的辅助调用，不能拿第一个）

  while (true) {
    let next;
    try {
      next = await sub.q.next();
    } catch (err) {
      close(session);
      const tail = sub.stderr.join('').trim().split(/\r?\n/).slice(-3).join(' ');
      if (session.aborted) return { ok: true };
      return { fallback: 'Claude Code 出错：' + (err.message || err) + (tail ? `（${tail}）` : ''), partial };
    }
    if (next.done) {
      close(session);
      if (session.aborted) return { ok: true };
      return { fallback: 'Claude Code 进程意外退出', partial };
    }
    const m = next.value;
    // 子代理的消息不显示（这里没有开放子代理，只是保险）
    if (m.parent_tool_use_id) continue;

    if (m.type === 'stream_event') {
      const e = m.event;
      if (e.type === 'message_start') round++;
      else if (e.type === 'content_block_start') {
        const b = e.content_block;
        partial = true;
        if (b.type === 'tool_use' && b.name === 'WebSearch') {
          // Claude Code 的网页搜索显示成和 API 服务端搜索一样的卡片
          webSearches.add(b.id);
          deps.emit({ type: 'block_start', round, index: e.index, kind: 'server_tool_use', name: 'web_search', id: b.id });
        } else deps.emit({ type: 'block_start', round, index: e.index, kind: b.type, name: plainName(b.name), id: b.id });
      } else if (e.type === 'content_block_delta') {
        const d = e.delta;
        if (d.type === 'text_delta') deps.emit({ type: 'delta', round, index: e.index, kind: 'text', text: d.text });
        else if (d.type === 'thinking_delta') deps.emit({ type: 'delta', round, index: e.index, kind: 'thinking', text: d.thinking });
        else if (d.type === 'input_json_delta') deps.emit({ type: 'delta', round, index: e.index, kind: 'input', text: d.partial_json });
      }
    } else if (m.type === 'assistant') {
      if (m.error) {
        failure = m.error;
        continue; // 合成的错误消息，不记进对话
      }
      if (m.message.model) model = m.message.model;
      for (const b of m.message.content) {
        if (b.type === 'text' && b.text.trim()) transcript.push(`【助手】\n${b.text}`);
        else if (b.type === 'tool_use') {
          toolNames.set(b.id, plainName(b.name));
          transcript.push(`【助手调用工具 ${plainName(b.name)}】${short(b.input, 400)}`);
        }
      }
    } else if (m.type === 'user') {
      const content = Array.isArray(m.message.content) ? m.message.content : [];
      for (const b of content) {
        if (b.type !== 'tool_result') continue;
        if (webSearches.has(b.tool_use_id)) deps.emit({ type: 'block_start', round, index: -1, kind: 'web_search_tool_result' });
        const text = Array.isArray(b.content) ? b.content.map((c) => c.text || '').join('\n') : String(b.content || '');
        transcript.push(`【工具结果 ${toolNames.get(b.tool_use_id) || ''}${b.is_error ? '（出错）' : ''}】${short(text, 600)}`);
      }
    } else if (m.type === 'rate_limit_event') {
      const info = m.rate_limit_info || {};
      if (info.status === 'rejected') limit = info;
    } else if (m.type === 'result') {
      const u = m.usage || {};
      const main = model || deps.config().model;
      const aux = Object.keys(m.modelUsage || {}).filter((k) => k !== main);
      deps.emit({ type: 'usage', channel: 'subscription', model: main, aux, usage: { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 } });
      if (session.aborted) return { ok: true };
      if (limit || failure === 'rate_limit') {
        const resets = limit && limit.resetsAt ? limit.resetsAt * 1000 : Date.now() + 15 * 60 * 1000;
        blockedUntil = resets;
        blockedReason = ERROR_TEXT.rate_limit;
        return { fallback: `${ERROR_TEXT.rate_limit}，${new Date(resets).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 重置`, partial };
      }
      if (failure && FALLBACK_ERRORS.has(failure)) return { fallback: ERROR_TEXT[failure], partial };
      if (m.is_error) {
        const detail = (m.errors && m.errors.join('；')) || m.result || m.subtype;
        deps.emit({ type: 'error', message: 'Claude Code 出错：' + detail });
      }
      return { ok: true };
    }
  }
}

// 切换到 API 时，把订阅通道里的对话整理成一条文字消息，让 API 那边接着做
function handoffText(session, partial) {
  const lines = session.transcript || [];
  return [
    '（下面是这个对话之前的记录。之前通过另一个通道进行，现在切换到这里继续。）',
    '',
    lines.join('\n\n'),
    '',
    partial ? '请接着完成最后一条用户请求。上面已经做过的步骤不要重复，先确认当前状态再继续。' : '请回复最后一条用户请求。',
  ].join('\n');
}

function closeAll(sessions) {
  for (const s of sessions.values()) close(s);
}

module.exports = { status, available, runTurn, interrupt, close, closeAll, handoffText };
