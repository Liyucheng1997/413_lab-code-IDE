// 调试服务：实现 DAP（Debug Adapter Protocol）客户端。
// Python → debugpy，C/C++ → gdb -i=dap，JavaScript → 内置的 Node 调试适配器（node-adapter.js）。
const { spawn, execFile } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { EventEmitter } = require('events');
const settings = require('./settings');
const { which } = require('./terminal-service');
const { NodeAdapter } = require('./node-adapter');

let send = () => {};
const sessions = new Map();
let nextId = 1;
const pendingReverse = new Map(); // `${sessionId}:${seq}` → session

function setSender(fn) {
  send = fn;
}

const fwd = (p) => p.replace(/\\/g, '/');

// 通过 stdio 与外部调试适配器通信
class StdioAdapter extends EventEmitter {
  constructor(command, args, opts) {
    super();
    this.proc = spawn(command, args, { windowsHide: true, ...opts });
    this.buffer = Buffer.alloc(0);
    this.proc.stdout.on('data', (d) => this.onData(d));
    this.proc.stderr.on('data', (d) => this.emit('message', { type: 'event', event: 'output', body: { category: 'stderr', output: d.toString() } }));
    this.proc.on('exit', (code) => this.emit('exit', code));
    this.proc.on('error', (err) => this.emit('error', err));
  }
  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const i = this.buffer.indexOf('\r\n\r\n');
      if (i < 0) return;
      const m = this.buffer.slice(0, i).toString('ascii').match(/Content-Length:\s*(\d+)/i);
      if (!m) {
        this.buffer = this.buffer.slice(i + 4);
        continue;
      }
      const n = +m[1];
      if (this.buffer.length < i + 4 + n) return;
      const body = this.buffer.slice(i + 4, i + 4 + n).toString('utf8');
      this.buffer = this.buffer.slice(i + 4 + n);
      try {
        this.emit('message', JSON.parse(body));
      } catch {}
    }
  }
  write(msg) {
    if (!this.proc.stdin.writable) return;
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    this.proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.proc.stdin.write(body);
  }
  kill() {
    try {
      this.proc.kill();
    } catch {}
  }
}

class DebugSession {
  constructor(id, adapter, config) {
    this.id = id;
    this.adapter = adapter;
    this.config = config;
    this.seq = 1;
    this.pending = new Map();
    this.capabilities = {};
    this.ended = false;
    this.initialized = new Promise((r) => (this.resolveInitialized = r));
    adapter.on('message', (m) => this.onMessage(m));
    adapter.on('exit', () => this.end());
    adapter.on('error', (err) => {
      send('dap:event', { id: this.id, event: 'output', body: { category: 'stderr', output: `调试适配器出错：${err.message}\n` } });
      this.end();
    });
  }

  onMessage(msg) {
    if (msg.type === 'response') {
      const p = this.pending.get(msg.request_seq);
      if (!p) return;
      this.pending.delete(msg.request_seq);
      if (msg.success) p.resolve(msg.body || {});
      else p.reject(new Error(msg.message || (msg.body && msg.body.error && msg.body.error.format) || '请求失败'));
    } else if (msg.type === 'event') {
      if (msg.event === 'initialized') this.resolveInitialized();
      send('dap:event', { id: this.id, event: msg.event, body: msg.body || {} });
      if (msg.event === 'terminated') setTimeout(() => this.stop(), 200);
    } else if (msg.type === 'request') {
      // 适配器反向请求（runInTerminal 等）交给界面处理
      if (msg.command === 'runInTerminal') {
        pendingReverse.set(`${this.id}:${msg.seq}`, this);
        send('dap:reverse', { id: this.id, seq: msg.seq, command: msg.command, arguments: msg.arguments });
      } else {
        this.adapter.write({ type: 'response', seq: this.seq++, request_seq: msg.seq, command: msg.command, success: false, message: '不支持的请求' });
      }
    }
  }

  request(command, args = {}) {
    if (this.ended) return Promise.reject(new Error('调试会话已结束'));
    const seq = this.seq++;
    return new Promise((resolve, reject) => {
      this.pending.set(seq, { resolve, reject });
      this.adapter.write({ type: 'request', seq, command, arguments: args });
    });
  }

  respondReverse(seq, command, body, success = true) {
    this.adapter.write({ type: 'response', seq: this.seq++, request_seq: seq, command, success, body });
  }

  // 标准启动流程：initialize → launch → (initialized) → 断点 → configurationDone
  async start() {
    this.capabilities = await this.request('initialize', {
      clientID: 'lumen',
      clientName: 'Lumen IDE',
      adapterID: this.config.type,
      locale: 'zh-cn',
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: 'path',
      supportsVariableType: true,
      supportsRunInTerminalRequest: this.config.type === 'python',
      supportsProgressReporting: false,
      supportsInvalidatedEvent: true,
    });
    const launched = this.request('launch', this.config.launch);
    launched.catch(() => {});
    await Promise.race([this.initialized, launched.then(() => this.initialized)]);
    for (const [file, bps] of Object.entries(this.config.breakpoints || {})) {
      try {
        const r = await this.request('setBreakpoints', { source: { path: this.config.pathFix ? this.config.pathFix(file) : file }, breakpoints: bps, lines: bps.map((b) => b.line) });
        send('dap:event', { id: this.id, event: 'lumen.breakpointsSet', body: { file, breakpoints: r.breakpoints || [] } });
      } catch {}
    }
    if (this.capabilities.exceptionBreakpointFilters) {
      const filters = this.config.exceptionFilters || this.capabilities.exceptionBreakpointFilters.filter((f) => f.default).map((f) => f.filter);
      await this.request('setExceptionBreakpoints', { filters }).catch(() => {});
    }
    if (this.capabilities.supportsConfigurationDoneRequest !== false) await this.request('configurationDone', {}).catch(() => {});
    await launched;
    return this.capabilities;
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    for (const p of this.pending.values()) p.reject(new Error('调试会话已结束'));
    this.pending.clear();
    sessions.delete(this.id);
    send('dap:event', { id: this.id, event: 'lumen.ended', body: {} });
  }

  async stop() {
    if (this.ended) return;
    try {
      await Promise.race([this.request('disconnect', { terminateDebuggee: true, restart: false }), new Promise((r) => setTimeout(r, 1500))]);
    } catch {}
    this.adapter.kill();
    if (this.config.cleanup) this.config.cleanup();
    this.end();
  }
}

// ---------------- 生成各语言的启动配置 ----------------

function pythonPath() {
  return settings.get().pythonPath || which('python') || which('python3') || 'python';
}

function checkDebugpy(python) {
  return new Promise((resolve) => {
    execFile(python, ['-c', 'import debugpy, sys; print(debugpy.__version__)'], { windowsHide: true, timeout: 15000 }, (err, stdout) => resolve(err ? null : stdout.trim()));
  });
}

function compile(compiler, args, cwd) {
  return new Promise((resolve) => {
    execFile(compiler, args, { cwd, windowsHide: true, timeout: 120000 }, (err, stdout, stderr) => resolve({ ok: !err, output: (stdout + stderr).trim() }));
  });
}

async function prepare(file, opts) {
  const ext = path.extname(file).toLowerCase();
  const cwd = opts.cwd || path.dirname(file);
  if (ext === '.py' || ext === '.pyw') {
    const python = pythonPath();
    const ver = await checkDebugpy(python);
    if (!ver) return { error: 'missing-debugpy', python, message: `当前 Python（${python}）没有安装 debugpy。` };
    return {
      type: 'python',
      adapter: { command: python, args: ['-m', 'debugpy.adapter'], env: { ...process.env, PYDEVD_DISABLE_FILE_VALIDATION: '1' } },
      launch: { type: 'python', request: 'launch', name: path.basename(file), program: file, cwd, console: opts.console || 'integratedTerminal', justMyCode: true, stopOnEntry: !!opts.stopOnEntry, showReturnValue: true },
      exceptionFilters: ['uncaught'],
      label: `Python ${ver}`,
    };
  }
  if (['.js', '.mjs', '.cjs'].includes(ext)) {
    const node = which('node');
    if (!node) return { error: 'missing', message: '没有找到 Node.js，请先安装并加入 PATH。' };
    return { type: 'node', inproc: true, node, launch: { program: file, cwd, stopOnEntry: !!opts.stopOnEntry }, label: 'Node.js' };
  }
  if (['.c', '.cpp', '.cc', '.cxx'].includes(ext)) {
    const gdb = which('gdb');
    const isC = ext === '.c';
    const compiler = which(isC ? 'gcc' : 'g++');
    if (!gdb || !compiler) return { error: 'missing', message: `调试 C/C++ 需要 ${!compiler ? (isC ? 'gcc' : 'g++') : ''}${!compiler && !gdb ? ' 和 ' : ''}${!gdb ? 'gdb（14 及以上）' : ''}，请安装 MinGW-w64 或 MSYS2 并加入 PATH。` };
    const outDir = path.join(os.tmpdir(), 'lumen-ide-debug');
    fs.mkdirSync(outDir, { recursive: true });
    const out = path.join(outDir, 'debug-' + Date.now() + (process.platform === 'win32' ? '.exe' : ''));
    // 用相对文件名编译：调试信息里写入绝对的中文路径时，gdb 会无法加载符号
    const args = ['-g', '-O0', path.basename(file), '-o', out, ...(isC ? ['-lm'] : ['-std=c++17'])];
    send('dap:event', { id: 0, event: 'output', body: { category: 'console', output: `> ${path.basename(compiler)} ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}\n` } });
    const r = await compile(compiler, args, path.dirname(file));
    if (!r.ok) return { error: 'compile', message: '编译失败', output: r.output };
    if (r.output) send('dap:event', { id: 0, event: 'output', body: { category: 'stderr', output: r.output + '\n' } });
    return {
      type: 'gdb',
      adapter: { command: gdb, args: ['-i=dap', '-q'] },
      // gdb 的命令行会把反斜杠当转义符，路径要换成正斜杠
      launch: { program: fwd(out), cwd, args: [], stopAtBeginningOfMainSubprogram: !!opts.stopOnEntry },
      // 路径含中文时 gdb 匹配不到完整路径，改用文件名（单文件编译不会有歧义）
      pathFix: (p) => (/[^\x00-\x7f]/.test(p) ? path.basename(p) : fwd(p)),
      exceptionFilters: [],
      cleanup: () => setTimeout(() => fs.rm(out, { force: true }, () => {}), 1000),
      label: 'GDB',
    };
  }
  if (['.ts', '.mts', '.tsx'].includes(ext)) return { error: 'missing', message: '暂不支持直接调试 TypeScript，可以先编译成 JS 再调试，或按 Ctrl+F5 直接运行。' };
  return { error: 'missing', message: `暂不支持调试 ${ext || '该类型'} 文件。目前支持 Python、JavaScript、C/C++。` };
}

async function start(file, opts = {}) {
  const cfg = await prepare(file, opts);
  if (cfg.error) return cfg;
  cfg.breakpoints = opts.breakpoints || {};
  const id = nextId++;
  let adapter;
  if (cfg.inproc) adapter = new NodeAdapter(cfg.node);
  else adapter = new StdioAdapter(cfg.adapter.command, cfg.adapter.args, { cwd: cfg.launch.cwd, env: cfg.adapter.env || process.env });
  const session = new DebugSession(id, adapter, cfg);
  sessions.set(id, session);
  try {
    const capabilities = await session.start();
    return { id, type: cfg.type, label: cfg.label, capabilities };
  } catch (err) {
    session.stop();
    return { error: 'launch', message: '启动调试失败：' + err.message };
  }
}

function register(ipc) {
  ipc.handle('dap:start', (_e, file, opts) => start(file, opts));
  ipc.handle('dap:request', (_e, id, command, args) => {
    const s = sessions.get(id);
    if (!s) throw new Error('调试会话已结束');
    if (command === 'setBreakpoints' && s.config.pathFix && args.source && args.source.path) args = { ...args, source: { ...args.source, path: s.config.pathFix(args.source.path) } };
    return s.request(command, args);
  });
  ipc.handle('dap:stop', (_e, id) => {
    const s = sessions.get(id);
    if (s) return s.stop();
  });
  ipc.on('dap:reverse-response', (_e, id, seq, command, body, success) => {
    const s = pendingReverse.get(`${id}:${seq}`);
    pendingReverse.delete(`${id}:${seq}`);
    if (s && !s.ended) s.respondReverse(seq, command, body, success);
  });
  ipc.handle('dap:python-path', () => pythonPath());
}

function disposeAll() {
  for (const s of sessions.values()) s.stop();
}

module.exports = { register, setSender, disposeAll };
