// AI 助手：在主进程里调用 Claude API（官方 SDK），运行“对话 + 工具调用”循环。
// 开启“优先使用 Claude 订阅”时先走本机 Claude Code 的订阅额度（见 ai-subscription.js），用不了再切换到 API。
// API Key 用系统加密（Windows DPAPI）保存，只留在主进程，不会发给界面。
// 工具（读写文件、搜索、运行命令）交给界面执行，这样能读到未保存的编辑器内容，并由用户确认修改。
const Anthropic = require('@anthropic-ai/sdk').default;
const { app, safeStorage } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const settings = require('./settings');
const subscription = require('./ai-subscription');

const DEFAULT_MODEL = 'claude-opus-5-5';
const MAX_ROUNDS = 200;
// 服务端网页搜索（仅官方接口）：查文档、查报错
const WEB_SEARCH = { type: 'web_search_20260209', name: 'web_search', max_uses: 8 };

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
    useSubscription: !!s.aiUseSubscription,
    subscription: subscription.status(),
  };
}

function hasApiKey() {
  return !!(loadKey() || process.env.ANTHROPIC_API_KEY);
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

const PATH_DESC = '相对工作区根目录的路径（也可以是工作区内的绝对路径）';

const TOOLS = [
  // ---- 规划 ----
  {
    name: 'update_plan',
    description: '记录并更新本次任务的执行计划，会以清单形式显示给用户。多步骤任务开始时先列出计划，每完成一步就更新状态。始终只有一个步骤是 in_progress。',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: '完整的步骤列表（每次都传全部步骤）',
          items: { type: 'object', properties: { content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } }, required: ['content', 'status'] },
        },
      },
      required: ['items'],
    },
  },
  // ---- 项目与文件 ----
  {
    name: 'create_project',
    description: '新建一个项目文件夹并在 IDE 中打开它作为工作区（之后的文件操作都在这个新项目里进行）。会先请用户确认位置。用于“从零开始写一个 xxx 项目”这类请求。',
    input_schema: { type: 'object', properties: { name: { type: 'string', description: '项目文件夹名，建议用英文和短横线，例如 todo-app' }, location: { type: 'string', description: '可选：父目录的绝对路径。不填则用默认项目目录' } }, required: ['name'] },
  },
  {
    name: 'open_folder',
    description: '在 IDE 中打开一个已有的文件夹作为工作区。会先请用户确认。',
    input_schema: { type: 'object', properties: { path: { type: 'string', description: '文件夹的绝对路径' } }, required: ['path'] },
  },
  {
    name: 'list_files',
    description: '列出工作区中的文件（相对路径），已排除 node_modules、.git 等目录。可用 pattern 过滤，支持 * 通配符或子串，例如 "*.py"、"src/"。',
    input_schema: { type: 'object', properties: { pattern: { type: 'string', description: '可选的过滤条件' } }, required: [] },
  },
  {
    name: 'read_file',
    description: '读取文件内容。返回带行号的文本（格式“行号<TAB>内容”），行号只用于定位，编辑时不要把行号写进 old_text。如果文件在编辑器里有未保存的修改，返回的是编辑器里的最新内容。大文件可用 offset/limit 分段读取。',
    input_schema: { type: 'object', properties: { path: { type: 'string', description: PATH_DESC }, offset: { type: 'integer', description: '起始行号（从 1 开始）' }, limit: { type: 'integer', description: '最多读取的行数，默认 2000' } }, required: ['path'] },
  },
  {
    name: 'search_text',
    description: '在工作区所有文件中搜索文本，返回“路径:行号: 内容”。',
    input_schema: { type: 'object', properties: { query: { type: 'string' }, is_regex: { type: 'boolean' }, include: { type: 'string', description: '只搜索这些文件，glob，例如 "*.ts, src/**"' } }, required: ['query'] },
  },
  {
    name: 'edit_file',
    description: '把文件中的 old_text 替换为 new_text。old_text 必须与文件内容逐字一致（含缩进），并且在文件中唯一；不唯一时请带上更多上下文，或设置 replace_all。按用户设置，可能先给用户看差异再生效。',
    eager_input_streaming: true,
    input_schema: { type: 'object', properties: { path: { type: 'string', description: PATH_DESC }, old_text: { type: 'string' }, new_text: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['path', 'old_text', 'new_text'] },
  },
  {
    name: 'write_file',
    description: '创建新文件（自动创建所需的上级文件夹）或整体覆盖文件内容。修改已有文件的局部时优先用 edit_file。',
    eager_input_streaming: true,
    input_schema: { type: 'object', properties: { path: { type: 'string', description: PATH_DESC }, content: { type: 'string' } }, required: ['path', 'content'] },
  },
  {
    name: 'create_directory',
    description: '在工作区内创建文件夹（可多级）。',
    input_schema: { type: 'object', properties: { path: { type: 'string', description: PATH_DESC } }, required: ['path'] },
  },
  {
    name: 'move_path',
    description: '移动或重命名工作区内的文件/文件夹。',
    input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
  },
  {
    name: 'delete_path',
    description: '删除工作区内的文件或文件夹（移到回收站，需要用户确认）。',
    input_schema: { type: 'object', properties: { path: { type: 'string', description: PATH_DESC } }, required: ['path'] },
  },
  {
    name: 'open_file',
    description: '在 IDE 编辑器中打开文件给用户看，可定位到某一行。',
    input_schema: { type: 'object', properties: { path: { type: 'string', description: PATH_DESC }, line: { type: 'integer' } }, required: ['path'] },
  },
  // ---- 运行与输出 ----
  {
    name: 'run_command',
    description: '在工作区根目录（或 cwd）运行一条命令，等它结束后返回退出码和输出（Windows 上用 PowerShell）。适合运行测试、构建、安装依赖、脚手架、git 等。命令必须能非交互地自行结束；需要一直运行的程序（开发服务器、监听模式）请用 run_in_terminal。',
    input_schema: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string', description: '可选：工作目录（工作区内的路径）' }, timeout_seconds: { type: 'integer', description: '超时秒数，默认 180，最大 900' } }, required: ['command'] },
  },
  {
    name: 'run_file',
    description: '像 IDE 的“运行”按钮一样运行一个源文件（自动选择解释器/编译器：Python、JS、TS、C/C++、Java、Go、Rust 等），返回退出码和输出。程序如果需要从标准输入读数据，用 stdin 参数提供。',
    input_schema: { type: 'object', properties: { path: { type: 'string', description: PATH_DESC }, stdin: { type: 'string', description: '可选：提供给程序的标准输入' }, timeout_seconds: { type: 'integer' } }, required: ['path'] },
  },
  {
    name: 'run_in_terminal',
    description: '在 IDE 的“AI 终端”里运行命令（用户能看到），适合启动开发服务器等长期运行的程序。命令不会被等待结束：等待 wait_seconds 秒后返回终端目前的输出，程序继续在后台运行。之后用 read_terminal 查看最新输出。再次调用会在同一个终端里执行；如果上一个程序还在运行，先传 interrupt=true 发送 Ctrl+C。',
    input_schema: { type: 'object', properties: { command: { type: 'string' }, wait_seconds: { type: 'integer', description: '等待多少秒后读取输出，默认 5，最大 60' }, interrupt: { type: 'boolean', description: '运行前先按 Ctrl+C 结束终端里正在运行的程序' } }, required: ['command'] },
  },
  {
    name: 'read_terminal',
    description: '读取 IDE 集成终端最近的输出。不传 name 时读取“AI 终端”（没有则读当前终端）。可传 name 读取用户的其他终端，例如“运行”“调试”“终端 1”。',
    input_schema: { type: 'object', properties: { name: { type: 'string' }, lines: { type: 'integer', description: '读取最后多少行，默认 120' } }, required: [] },
  },
  {
    name: 'get_ide_output',
    description: '查看 IDE 面板中的输出：source 为 "problems"（问题列表）、"debug"（调试控制台）、"output"（输出面板，可用 channel 指定 LSP / Git / 运行 等频道）、"terminals"（列出所有终端）。',
    input_schema: { type: 'object', properties: { source: { type: 'string', enum: ['problems', 'debug', 'output', 'terminals'] }, channel: { type: 'string' }, lines: { type: 'integer' } }, required: ['source'] },
  },
  {
    name: 'get_diagnostics',
    description: '获取编辑器/语言服务器检测到的错误和警告。可指定 path 只看某个文件（会先打开该文件让语言服务器分析）。',
    input_schema: { type: 'object', properties: { path: { type: 'string', description: PATH_DESC } }, required: [] },
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
    if (p.type === 'array' && !Array.isArray(value)) return `参数 ${key} 应为数组`;
    if (p.enum && !p.enum.includes(value)) return `参数 ${key} 只能是 ${p.enum.join(' / ')}`;
  }
  return null;
}

// 系统提示保持固定（便于提示缓存）；每轮变化的 IDE 状态放在用户消息里
function systemPrompt() {
  return [
    '你是 Lumen IDE 内置的 AI 软件工程师。你不只是回答问题：你可以直接在用户的电脑上新建项目、创建和修改文件、运行程序和命令、查看终端与 IDE 输出，像一位真正的程序员一样把任务做完。',
    `操作系统：${process.platform === 'win32' ? 'Windows，命令使用 PowerShell 语法（用 ; 连接命令，不要用 &&）' : process.platform}。`,
    '每条用户消息开头的 <ide_state> 是 IDE 当前状态（工作区、打开的文件、光标、选中代码、问题数量），用它理解用户指的是什么。',
    '',
    '# 工作流程',
    '1. 理解：先用 list_files / read_file / search_text 了解现有代码和约定，不要凭猜测修改。',
    '2. 计划：多步骤的任务先用 update_plan 列出步骤，执行过程中及时更新状态。',
    '3. 实现：修改已有文件用 edit_file（精确替换，改动尽量小），新文件用 write_file。需要从零开始的项目，用 create_project 新建并打开项目文件夹；没有打开工作区时也应这样做，而不是只在回答里贴代码。',
    '4. 验证：写完代码一定要验证。用 run_file 运行程序、run_command 运行测试/构建/安装依赖，用 get_diagnostics 检查语法和类型错误。',
    '5. 修复：根据输出和错误信息继续修改，再次运行，直到真正可用。不要在验证失败的情况下宣称完成。',
    '6. 总结：最后简要说明做了什么、如何运行、还有什么需要用户注意。',
    '',
    '# 运行与输出',
    '- run_command 会等待命令结束；开发服务器、watch 模式等长期运行的程序用 run_in_terminal 启动，再用 read_terminal 查看输出。',
    '- 用户说“看看终端/输出/报错”时，用 read_terminal 或 get_ide_output 查看，而不是让用户复制粘贴。',
    '- 脚手架和安装命令要使用非交互参数（例如 npm init -y、npm create vite@latest app -- --template react、pip install -q），避免卡在等待输入。',
    '- 需要查最新的库用法、报错原因或文档时，如果有 web_search 工具可以搜索。',
    '',
    '# 原则',
    '- 只做用户要求的事，保持项目原有的代码风格；新项目使用该语言社区的常规结构和最佳实践。',
    '- 文件操作只能在当前工作区内进行。修改和命令可能需要用户确认；如果用户拒绝，询问原因或换一种做法，不要重复提交同样的操作。',
    '- 不要执行破坏性操作（删除大量文件、git reset --hard、格式化磁盘等），除非用户明确要求。',
    '- 用户用什么语言提问就用什么语言回答。回答简洁，代码块注明语言。',
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
    session = { messages: [], running: false, mode: null };
    sessions.set(sessionId, session);
  }
  if (session.running) throw new Error('上一条消息还在处理中');
  session.running = true;
  session.aborted = false;
  // 每个对话第一次发消息时决定通道；订阅用不了时切到 API 后，这个对话就一直用 API
  if (!session.mode) session.mode = settings.get().aiUseSubscription && subscription.available() ? 'subscription' : 'api';

  try {
    if (session.mode === 'subscription') {
      const r = await subscription.runTurn(session, userText, {
        config,
        tools: TOOLS,
        validateInput,
        systemPrompt,
        maxRounds: MAX_ROUNDS,
        webSearch: () => settings.get().aiWebSearch !== false,
        cwd: () => (ctx && ctx.root) || null,
        emit: (payload) => emit(sessionId, payload),
        callTool: (id, name, input) => callTool(sessionId, id, name, input),
      });
      if (!r.fallback || session.aborted) return;
      subscription.close(session);
      session.mode = 'api';
      if (!hasApiKey()) {
        emit(sessionId, { type: 'error', message: `订阅通道不可用：${r.fallback}。也没有配置 API Key，无法切换到 API。` });
        return;
      }
      emit(sessionId, { type: 'notice', message: `订阅通道不可用：${r.fallback}。已切换到 API 继续。` });
      session.messages = [{ role: 'user', content: subscription.handoffText(session, r.partial) }];
    } else if (session.transcript && !session.messages.length) {
      // 之前在订阅通道的对话（比如额度用完后新开的轮次）
      session.transcript.push(`【用户】\n${userText}`);
      session.messages = [{ role: 'user', content: subscription.handoffText(session, false) }];
    } else session.messages.push({ role: 'user', content: userText });
    await apiLoop(sessionId, session);
  } finally {
    session.running = false;
    emit(sessionId, { type: 'done', aborted: !!session.aborted });
  }
}

async function apiLoop(sessionId, session) {
  const s = config();
  let c;
  try {
    c = client();
  } catch (err) {
    emit(sessionId, { type: 'error', message: friendlyError(err), code: err.code });
    return;
  }
  const official = isOfficialEndpoint();
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const params = {
        model: s.model,
        max_tokens: 64000,
        system: systemPrompt(),
        messages: session.messages,
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: s.effort },
        cache_control: { type: 'ephemeral' },
        tools: official && settings.get().aiWebSearch !== false ? [...TOOLS, WEB_SEARCH] : TOOLS,
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
      emit(sessionId, { type: 'usage', channel: 'api', usage, model: message.model });

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
  }
}

function stop(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  s.aborted = true;
  if (s.stream) s.stream.abort();
  subscription.interrupt(s);
  for (const [callId, p] of pendingTools) {
    if (p.sessionId === sessionId) {
      pendingTools.delete(callId);
      p.resolve({ content: '用户已停止', isError: true });
    }
  }
  // 停止 AI 时一并结束它启动的命令
  for (const proc of running.values()) {
    proc.killedByUser = true;
    killTree(proc);
  }
}

// 运行命令（用户确认后由界面调用）：输出实时推给界面，可以中途终止
const running = new Map(); // execId → 子进程

function killTree(proc) {
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
  else proc.kill('SIGTERM');
}

function execCommand(execId, command, { cwd, timeout = 180, stdin } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', FORCE_COLOR: '0' };
    delete env.ELECTRON_RUN_AS_NODE;
    const win = process.platform === 'win32';
    // PowerShell 默认按系统代码页输出，先切到 UTF-8，避免中文乱码
    const args = win ? ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; ${command}`] : ['-lc', command];
    const proc = spawn(win ? 'powershell.exe' : '/bin/bash', args, { cwd, env, windowsHide: true });
    running.set(execId, proc);
    let out = '';
    let timedOut = false;
    const onData = (d) => {
      const text = d.toString('utf8');
      out += text;
      if (out.length > 400000) out = out.slice(-200000);
      send('ai:exec-data', { execId, text });
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    if (stdin) proc.stdin.write(stdin.endsWith('\n') ? stdin : stdin + '\n');
    proc.stdin.end();
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(proc);
    }, Math.min(Math.max(timeout, 5), 900) * 1000);
    const finish = (code) => {
      clearTimeout(timer);
      running.delete(execId);
      if (out.length > 30000) out = out.slice(0, 12000) + `\n…（中间省略 ${out.length - 30000} 个字符）…\n` + out.slice(-18000);
      resolve({ code: timedOut ? `超时（${timeout} 秒）被终止` : proc.killedByUser ? '被用户终止' : code, output: out.replace(/\r\n/g, '\n') });
    };
    proc.on('close', finish);
    proc.on('error', (err) => {
      out += err.message;
      finish(-1);
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
    const s = sessions.get(sessionId);
    if (s) subscription.close(s);
    sessions.delete(sessionId);
  });
  app.on('will-quit', () => subscription.closeAll(sessions));
  ipc.handle('ai:exec', (_e, execId, command, opts) => execCommand(execId, command, opts || {}));
  ipc.handle('ai:exec-kill', (_e, execId) => {
    const proc = running.get(execId);
    if (proc) {
      proc.killedByUser = true;
      killTree(proc);
    }
  });
  ipc.on('ai:tool-result', (_e, callId, result) => {
    const p = pendingTools.get(callId);
    if (!p) return;
    pendingTools.delete(callId);
    p.resolve(result || { content: '' });
  });
}

module.exports = { register, setSender, DEFAULT_MODEL };
