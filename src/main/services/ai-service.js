// AI 助手：在主进程里调用 Claude API（官方 SDK），运行“对话 + 工具调用”循环。
// API Key 用系统加密（Windows DPAPI）保存，只留在主进程，不会发给界面。
// 工具（读写文件、搜索、运行命令）交给界面执行，这样能读到未保存的编辑器内容，并由用户确认修改。
const Anthropic = require('@anthropic-ai/sdk').default;
const { app, safeStorage } = require('electron');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const settings = require('./settings');

const DEFAULT_MODEL = 'claude-opus-5-5';
const MAX_ROUNDS = 60;

let send = () => {};
const sessions = new Map(); // sessionId → { messages, stream, running, aborted }
const pendingTools = new Map(); // callId → { resolve }
let toolSeq = 1;

function setSender(fn) {
  send = fn;
}

// ---------------- API Key ----------------

const keyFile = () => path.join(app.getPath('userData'), 'ai-key.bin');

function loadKey() {
  try {
    const buf = fs.readFileSync(keyFile());
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : null;
  } catch {
    return null;
  }
}

function saveKey(key) {
  if (!key) {
    fs.rmSync(keyFile(), { force: true });
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密不可用，无法安全保存 API Key');
  fs.writeFileSync(keyFile(), safeStorage.encryptString(key.trim()));
}

function config() {
  const s = settings.get();
  const key = loadKey();
  return {
    hasKey: !!key,
    keyHint: key ? key.slice(0, 7) + '…' + key.slice(-4) : '',
    envKey: !key && !!process.env.ANTHROPIC_API_KEY,
    baseURL: s.aiBaseURL || '',
    model: s.aiModel || DEFAULT_MODEL,
    effort: s.aiEffort || 'high',
  };
}

function client() {
  const s = settings.get();
  const apiKey = loadKey() || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const err = new Error('还没有配置 API Key');
    err.code = 'no-key';
    throw err;
  }
  return new Anthropic({ apiKey, baseURL: s.aiBaseURL || undefined, maxRetries: 2 });
}

function isOfficialEndpoint() {
  const b = settings.get().aiBaseURL;
  return !b || /^https:\/\/api\.anthropic\.com\/?$/.test(b);
}

function friendlyError(err) {
  if (err.code === 'no-key') return err.message;
  if (err instanceof Anthropic.AuthenticationError) return 'API Key 无效或已过期（401），请在设置里检查。';
  if (err instanceof Anthropic.PermissionDeniedError) return '没有权限使用该模型（403）：' + err.message;
  if (err instanceof Anthropic.NotFoundError) return '找不到模型或接口地址（404），请检查模型名称和 Base URL。';
  if (err instanceof Anthropic.RateLimitError) return '请求太频繁或额度不足（429），请稍后再试。';
  if (err instanceof Anthropic.BadRequestError) return '请求参数有误（400）：' + err.message;
  if (err instanceof Anthropic.InternalServerError) return 'API 服务暂时不可用（' + err.status + '），请稍后重试。';
  if (err instanceof Anthropic.APIConnectionError) return '无法连接到 API，请检查网络或 Base URL。';
  if (err instanceof Anthropic.APIError) return `API 错误（${err.status}）：${err.message}`;
  return err.message || String(err);
}

// 测试连接：查询模型信息，不消耗 token
async function testConnection() {
  try {
    const c = client();
    const model = config().model;
    const info = await c.models.retrieve(model);
    return { ok: true, message: `连接成功：${info.display_name || info.id}` };
  } catch (err) {
    return { ok: false, message: friendlyError(err) };
  }
}

// ---------------- 工具定义 ----------------

const TOOLS = [
  {
    name: 'list_files',
    description: '列出工作区中的文件（相对路径），已排除 node_modules、.git 等目录。可用 pattern 过滤，支持 * 通配符或子串，例如 "*.py"、"src/"。',
    input_schema: { type: 'object', properties: { pattern: { type: 'string', description: '可选的过滤条件' } }, required: [] },
  },
  {
    name: 'read_file',
    description: '读取文件内容。返回带行号的文本（格式“行号<TAB>内容”），行号只用于定位，编辑时不要把行号写进 old_text。如果文件在编辑器里有未保存的修改，返回的是编辑器里的最新内容。大文件可用 offset/limit 分段读取。',
    input_schema: { type: 'object', properties: { path: { type: 'string', description: '相对工作区根目录的路径' }, offset: { type: 'integer', description: '起始行号（从 1 开始）' }, limit: { type: 'integer', description: '最多读取的行数，默认 2000' } }, required: ['path'] },
  },
  {
    name: 'search_text',
    description: '在工作区所有文件中搜索文本，返回“路径:行号: 内容”。',
    input_schema: { type: 'object', properties: { query: { type: 'string' }, is_regex: { type: 'boolean' }, include: { type: 'string', description: '只搜索这些文件，glob，例如 "*.ts, src/**"' } }, required: ['query'] },
  },
  {
    name: 'edit_file',
    description: '把文件中的 old_text 替换为 new_text。old_text 必须与文件内容逐字一致（含缩进），并且在文件中唯一；不唯一时请带上更多上下文，或设置 replace_all。修改会先给用户看差异，用户确认后才生效。',
    eager_input_streaming: true,
    input_schema: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['path', 'old_text', 'new_text'] },
  },
  {
    name: 'write_file',
    description: '创建新文件或整体覆盖文件内容。修改已有文件时优先用 edit_file。用户确认后才写入。',
    eager_input_streaming: true,
    input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  },
  {
    name: 'run_command',
    description: '在工作区根目录运行一条命令并返回输出（Windows 上用 PowerShell）。适合运行测试、构建、安装依赖、查看 git 状态等。不要运行需要交互输入或长期不退出的命令（如开发服务器）。用户确认后才执行，超时 120 秒。',
    input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
  {
    name: 'get_diagnostics',
    description: '获取编辑器检测到的错误和警告（来自语言服务器）。可指定 path 只看某个文件。',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: [] },
  },
];

// eager_input_streaming 下服务端不再校验输入，这里按 schema 自己校验
function validateInput(name, input) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return `未知工具：${name}`;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '工具输入不是对象';
  const { properties, required } = tool.input_schema;
  for (const key of required) if (!(key in input)) return `缺少参数 ${key}`;
  for (const [key, value] of Object.entries(input)) {
    const p = properties[key];
    if (!p || value === null || value === undefined) continue;
    if (p.type === 'string' && typeof value !== 'string') return `参数 ${key} 应为字符串`;
    if (p.type === 'integer' && !Number.isInteger(value)) return `参数 ${key} 应为整数`;
    if (p.type === 'boolean' && typeof value !== 'boolean') return `参数 ${key} 应为布尔值`;
  }
  return null;
}

function systemPrompt(ctx) {
  return [
    '你是 Lumen IDE 内置的编程助手，帮助用户阅读、编写、修改和调试代码。',
    ctx.root ? `用户当前打开的工作区：${ctx.root}` : '用户还没有打开工作区文件夹，文件相关工具不可用，请直接在回答里给出代码。',
    `操作系统：${process.platform === 'win32' ? 'Windows（命令用 PowerShell 语法）' : process.platform}`,
    '',
    '工作方式：',
    '- 修改代码前先用 read_file / search_text 了解相关代码，不要凭猜测改动。',
    '- 修改已有文件用 edit_file（精确替换），新建文件用 write_file。用户会看到差异并决定是否应用；如果用户拒绝，询问原因或换一种做法，不要重复提交同样的修改。',
    '- 改完后可以用 get_diagnostics 检查错误，必要时用 run_command 运行测试或程序验证。',
    '- 只做用户要求的改动，保持原有代码风格。',
    '- 用户使用什么语言提问，就用什么语言回答。回答简洁，代码块注明语言。',
  ].join('\n');
}

// ---------------- 对话循环 ----------------

function emit(sessionId, payload) {
  send('ai:event', { sessionId, ...payload });
}

// 让界面执行工具，等待结果
function callTool(sessionId, id, name, input) {
  const callId = toolSeq++;
  return new Promise((resolve) => {
    pendingTools.set(callId, { resolve, sessionId });
    send('ai:tool-call', { sessionId, callId, id, name, input });
  });
}

async function runTurn(sessionId, userText, ctx) {
  let session = sessions.get(sessionId);
  if (!session) {
    session = { messages: [], running: false };
    sessions.set(sessionId, session);
  }
  if (session.running) throw new Error('上一条消息还在处理中');
  session.running = true;
  session.aborted = false;
  const s = config();
  let c;
  try {
    c = client();
  } catch (err) {
    session.running = false;
    emit(sessionId, { type: 'error', message: friendlyError(err), code: err.code });
    return;
  }

  session.messages.push({ role: 'user', content: userText });
  const useTools = !!ctx.root;
  const official = isOfficialEndpoint();
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const params = {
        model: s.model,
        max_tokens: 64000,
        system: systemPrompt(ctx),
        messages: session.messages,
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: s.effort },
        cache_control: { type: 'ephemeral' },
        ...(useTools ? { tools: TOOLS } : {}),
      };
      // 官方接口上开启服务端回退：模型因安全分类拒绝时自动换模型继续
      const stream = official
        ? c.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
        : c.messages.stream(params);
      session.stream = stream;

      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          const b = event.content_block;
          emit(sessionId, { type: 'block_start', round, index: event.index, kind: b.type, name: b.name, id: b.id });
        } else if (event.type === 'content_block_delta') {
          const d = event.delta;
          if (d.type === 'text_delta') emit(sessionId, { type: 'delta', round, index: event.index, kind: 'text', text: d.text });
          else if (d.type === 'thinking_delta') emit(sessionId, { type: 'delta', round, index: event.index, kind: 'thinking', text: d.thinking });
          else if (d.type === 'input_json_delta') emit(sessionId, { type: 'delta', round, index: event.index, kind: 'input', text: d.partial_json });
        }
      }
      const message = await stream.finalMessage();
      session.stream = null;

      const u = message.usage || {};
      usage.input += u.input_tokens || 0;
      usage.output += u.output_tokens || 0;
      usage.cacheRead += u.cache_read_input_tokens || 0;
      usage.cacheWrite += u.cache_creation_input_tokens || 0;
      emit(sessionId, { type: 'usage', usage, model: message.model });

      if (message.stop_reason === 'refusal') {
        const detail = message.stop_details && message.stop_details.explanation;
        emit(sessionId, { type: 'error', message: '模型拒绝了这个请求' + (detail ? '：' + detail : '。') });
        break;
      }
      // 完整保留模型返回的内容块（包括 thinking），保证对话历史只追加不修改
      session.messages.push({ role: 'assistant', content: message.content });

      if (message.stop_reason === 'pause_turn') continue;
      const toolUses = message.content.filter((b) => b.type === 'tool_use');
      if (!toolUses.length) break;
      if (message.stop_reason === 'max_tokens') {
        // 工具输入被截断，不能执行；补上错误结果让历史保持合法
        session.messages.push({ role: 'user', content: toolUses.map((t) => ({ type: 'tool_result', tool_use_id: t.id, is_error: true, content: '输出被截断（max_tokens），工具未执行' })) });
        emit(sessionId, { type: 'error', message: '回复过长被截断，工具未执行。可以让助手分步完成。' });
        break;
      }

      const results = [];
      for (const t of toolUses) {
        if (session.aborted) {
          results.push({ type: 'tool_result', tool_use_id: t.id, is_error: true, content: '用户已停止' });
          continue;
        }
        const problem = validateInput(t.name, t.input);
        if (problem) {
          emit(sessionId, { type: 'tool_invalid', id: t.id, message: problem });
          results.push({ type: 'tool_result', tool_use_id: t.id, is_error: true, content: `INVALID_INPUT: ${problem}` });
          continue;
        }
        const r = await callTool(sessionId, t.id, t.name, t.input);
        results.push({ type: 'tool_result', tool_use_id: t.id, content: String(r.content || '（无输出）'), ...(r.isError ? { is_error: true } : {}) });
      }
      // 所有工具结果放在同一条消息里返回
      session.messages.push({ role: 'user', content: results });
      if (session.aborted) break;
      if (round === MAX_ROUNDS - 1) emit(sessionId, { type: 'error', message: '工具调用轮数过多，已暂停。可以发送“继续”。' });
    }
  } catch (err) {
    session.stream = null;
    if (!(err instanceof Anthropic.APIUserAbortError) && !session.aborted) emit(sessionId, { type: 'error', message: friendlyError(err) });
  } finally {
    session.running = false;
    emit(sessionId, { type: 'done', aborted: !!session.aborted });
  }
}

function stop(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  s.aborted = true;
  if (s.stream) s.stream.abort();
  for (const [callId, p] of pendingTools) {
    if (p.sessionId === sessionId) {
      pendingTools.delete(callId);
      p.resolve({ content: '用户已停止', isError: true });
    }
  }
}

// 运行命令（用户确认后由界面调用）
function execCommand(command, cwd) {
  return new Promise((resolve) => {
    const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    exec(command, { cwd, shell, timeout: 120000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (err.killed ? '超时被终止' : err.code ?? 1) : 0;
      let out = (stdout || '') + (stderr ? (stdout ? '\n' : '') + stderr : '');
      if (out.length > 30000) out = out.slice(0, 15000) + `\n…（中间省略 ${out.length - 30000} 个字符）…\n` + out.slice(-15000);
      resolve({ code, output: out });
    });
  });
}

function register(ipc) {
  ipc.handle('ai:config', () => config());
  ipc.handle('ai:set-key', (_e, key) => {
    saveKey(key);
    return config();
  });
  ipc.handle('ai:test', () => testConnection());
  ipc.handle('ai:send', (_e, sessionId, text, ctx) => runTurn(sessionId, text, ctx || {}));
  ipc.handle('ai:stop', (_e, sessionId) => stop(sessionId));
  ipc.handle('ai:reset', (_e, sessionId) => {
    stop(sessionId);
    sessions.delete(sessionId);
  });
  ipc.handle('ai:exec', (_e, command, cwd) => execCommand(command, cwd));
  ipc.on('ai:tool-result', (_e, callId, result) => {
    const p = pendingTools.get(callId);
    if (!p) return;
    pendingTools.delete(callId);
    p.resolve(result || { content: '' });
  });
}

module.exports = { register, setSender, DEFAULT_MODEL };
