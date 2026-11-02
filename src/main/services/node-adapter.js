// 内置的 Node.js 调试适配器：对外说 DAP，对内通过 Chrome DevTools Protocol（--inspect-brk）控制 node 进程。
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { pathToFileURL, fileURLToPath } = require('url');
const fs = require('fs');
const path = require('path');

const NOISE = /^(Debugger listening on|For help, see|Debugger attached\.|Waiting for the debugger to disconnect\.\.\.)/;

class NodeAdapter extends EventEmitter {
  constructor(nodePath) {
    super();
    this.nodePath = nodePath;
    this.cdpSeq = 1;
    this.cdpPending = new Map();
    this.breakpoints = new Map(); // 文件 → [cdp breakpointId]
    this.handles = new Map();
    this.handleSeq = 1;
    this.frames = [];
    this.paused = false;
    this.configured = false;
    this.startPausePending = false;
    this.seq = 1;
    this.exceptionMode = 'none';
    this.scripts = new Map(); // scriptId → url（新版 V8 的 callFrame.url 可能为空）
  }

  // ---------- DAP 侧 ----------

  write(msg) {
    if (msg.type !== 'request') return;
    Promise.resolve()
      .then(() => this.handle(msg.command, msg.arguments || {}))
      .then((body) => this.emit('message', { type: 'response', seq: this.seq++, request_seq: msg.seq, command: msg.command, success: true, body: body || {} }))
      .catch((err) => this.emit('message', { type: 'response', seq: this.seq++, request_seq: msg.seq, command: msg.command, success: false, message: err.message }));
  }

  event(event, body = {}) {
    this.emit('message', { type: 'event', seq: this.seq++, event, body });
  }

  output(text, category = 'stdout') {
    this.event('output', { category, output: text });
  }

  async handle(command, args) {
    switch (command) {
      case 'initialize':
        return { supportsConfigurationDoneRequest: true, supportsConditionalBreakpoints: true, supportsEvaluateForHovers: true, supportsTerminateRequest: true, supportsLogPoints: true, exceptionBreakpointFilters: [{ filter: 'uncaught', label: '未捕获的异常', default: true }, { filter: 'all', label: '所有异常', default: false }] };
      case 'launch':
        return this.launch(args);
      case 'setBreakpoints':
        return this.setBreakpoints(args);
      case 'setExceptionBreakpoints': {
        const f = args.filters || [];
        this.exceptionMode = f.includes('all') ? 'all' : f.includes('uncaught') ? 'uncaught' : 'none';
        if (this.ws) await this.cdp('Debugger.setPauseOnExceptions', { state: this.exceptionMode });
        return {};
      }
      case 'configurationDone':
        this.configured = true;
        if (this.startPausePending) {
          this.startPausePending = false;
          if (!this.stopOnEntry) await this.cdp('Debugger.resume');
          else this.reportStopped('entry');
        }
        await this.cdp('Runtime.runIfWaitingForDebugger').catch(() => {});
        return {};
      case 'threads':
        return { threads: [{ id: 1, name: '主线程' }] };
      case 'stackTrace':
        return this.stackTrace(args);
      case 'scopes':
        return this.scopes(args);
      case 'variables':
        return this.variables(args);
      case 'evaluate':
        return this.evaluate(args);
      case 'continue':
        await this.cdp('Debugger.resume');
        return { allThreadsContinued: true };
      case 'next':
        await this.cdp('Debugger.stepOver');
        return {};
      case 'stepIn':
        await this.cdp('Debugger.stepInto');
        return {};
      case 'stepOut':
        await this.cdp('Debugger.stepOut');
        return {};
      case 'pause':
        await this.cdp('Debugger.pause');
        return {};
      case 'disconnect':
      case 'terminate':
        this.kill();
        return {};
      default:
        throw new Error('不支持的命令：' + command);
    }
  }

  launch({ program, cwd, stopOnEntry }) {
    this.stopOnEntry = stopOnEntry;
    // 用真实路径（含正确的盘符大小写），保证与 node 报告的脚本 URL 一致
    try {
      program = fs.realpathSync.native(program);
    } catch {}
    this.program = program;
    return new Promise((resolve, reject) => {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      this.proc = spawn(this.nodePath, ['--inspect-brk=127.0.0.1:0', program], { cwd, env, windowsHide: true });
      let stderrBuf = '';
      let connected = false;
      this.proc.stdout.on('data', (d) => this.output(d.toString(), 'stdout'));
      this.proc.stderr.on('data', (d) => {
        const text = d.toString();
        if (!connected) {
          stderrBuf += text;
          const m = stderrBuf.match(/ws:\/\/[^\s]+/);
          if (m) {
            connected = true;
            this.connect(m[0]).then(resolve, reject);
          }
        }
        const visible = text
          .split(/\r?\n/)
          .filter((l) => l && !NOISE.test(l))
          .join('\n');
        if (visible) this.output(visible + '\n', 'stderr');
        // 脚本结束后 node 会等待调试器断开，这时主动断开
        if (/Waiting for the debugger to disconnect/.test(text)) this.closeSocket();
      });
      this.proc.on('exit', (code) => {
        this.closeSocket();
        this.event('exited', { exitCode: code ?? 0 });
        this.event('terminated', {});
        this.emit('exit', code);
      });
      this.proc.on('error', (err) => reject(err));
    });
  }

  async connect(url) {
    this.ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error('无法连接到 Node 调试端口'));
    });
    this.ws.onmessage = (e) => this.onCdp(JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString()));
    this.ws.onclose = () => (this.ws = null);
    await this.cdp('Runtime.enable');
    await this.cdp('Debugger.enable');
    await this.cdp('Debugger.setPauseOnExceptions', { state: this.exceptionMode });
    this.event('initialized');
    return {};
  }

  closeSocket() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
  }

  kill() {
    this.closeSocket();
    if (this.proc && this.proc.exitCode === null) {
      try {
        this.proc.kill();
      } catch {}
    }
  }

  // ---------- CDP 侧 ----------

  cdp(method, params = {}) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('调试连接已断开'));
    const id = this.cdpSeq++;
    return new Promise((resolve, reject) => {
      this.cdpPending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  onCdp(msg) {
    if (msg.id) {
      const p = this.cdpPending.get(msg.id);
      if (!p) return;
      this.cdpPending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'Debugger.scriptParsed') this.scripts.set(msg.params.scriptId, msg.params.url);
    else if (msg.method === 'Debugger.paused') this.onPaused(msg.params);
    else if (msg.method === 'Debugger.resumed') {
      this.paused = false;
      this.handles.clear();
      this.event('continued', { threadId: 1, allThreadsContinued: true });
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      this.output(((d.exception && d.exception.description) || d.text) + '\n', 'stderr');
    }
  }

  onPaused(p) {
    this.paused = true;
    this.frames = p.callFrames;
    this.handles.clear();
    // --inspect-brk 会先停在第一行：配置完成前记下来，完成后再决定是否继续
    if (!this.startedOnce) {
      this.startedOnce = true;
      if (!this.configured) {
        this.startPausePending = true;
        return;
      }
      if (!this.stopOnEntry) {
        this.cdp('Debugger.resume').catch(() => {});
        return;
      }
      return this.reportStopped('entry');
    }
    let reason = 'pause';
    if (p.reason === 'exception' || p.reason === 'promiseRejection') reason = 'exception';
    else if (p.hitBreakpoints && p.hitBreakpoints.length) reason = 'breakpoint';
    else if (p.reason === 'other') reason = 'step';
    const text = reason === 'exception' && p.data ? p.data.description : undefined;
    this.reportStopped(reason, text);
  }

  reportStopped(reason, text) {
    this.event('stopped', { reason, threadId: 1, allThreadsStopped: true, text, description: text });
  }

  async setBreakpoints({ source, breakpoints = [] }) {
    let file = source.path;
    try {
      file = fs.realpathSync.native(file);
    } catch {}
    const key = file.toLowerCase();
    for (const id of this.breakpoints.get(key) || []) await this.cdp('Debugger.removeBreakpoint', { breakpointId: id }).catch(() => {});
    const ids = [];
    const result = [];
    const url = pathToFileURL(file).href;
    for (const bp of breakpoints) {
      let condition = bp.condition || '';
      // 日志点：输出后返回 false，不真正停下
      if (bp.logMessage) {
        const tpl = '`' + bp.logMessage.replace(/`/g, '\\`').replace(/\{([^}]+)\}/g, '${$1}') + '`';
        condition = `(console.log(${tpl}), false)`;
      }
      try {
        const r = await this.cdp('Debugger.setBreakpointByUrl', { lineNumber: bp.line - 1, url, columnNumber: 0, condition });
        ids.push(r.breakpointId);
        const loc = r.locations && r.locations[0];
        result.push({ verified: true, line: loc ? loc.lineNumber + 1 : bp.line });
      } catch (err) {
        result.push({ verified: false, line: bp.line, message: err.message });
      }
    }
    this.breakpoints.set(key, ids);
    return { breakpoints: result };
  }

  handle_(value) {
    const id = this.handleSeq++;
    this.handles.set(id, value);
    return id;
  }

  stackTrace() {
    const stackFrames = this.frames.map((f, i) => {
      const url = f.url || this.scripts.get(f.location.scriptId) || '';
      let source;
      if (url.startsWith('file:')) {
        const p = fileURLToPath(url);
        source = { name: path.basename(p), path: p };
      } else source = { name: url.replace(/^node:/, '') || 'Node 内部', presentationHint: 'deemphasize' };
      return { id: i + 1, name: f.functionName || '(匿名函数)', source, line: f.location.lineNumber + 1, column: (f.location.columnNumber || 0) + 1, presentationHint: url.startsWith('file:') ? 'normal' : 'subtle' };
    });
    return { stackFrames, totalFrames: stackFrames.length };
  }

  scopes({ frameId }) {
    const f = this.frames[frameId - 1];
    if (!f) return { scopes: [] };
    const NAMES = { local: '局部变量', closure: '闭包', block: '块作用域', catch: 'catch', with: 'with', module: '模块', script: '脚本', global: '全局', eval: 'eval' };
    const scopes = f.scopeChain.map((s) => ({ name: NAMES[s.type] || s.type, variablesReference: this.handle_({ objectId: s.object.objectId, scope: s.type }), expensive: s.type === 'global' }));
    return { scopes };
  }

  describe(o) {
    if (!o) return 'undefined';
    if (o.type === 'string') return JSON.stringify(o.value);
    if (o.type === 'undefined') return 'undefined';
    if (o.unserializableValue) return o.unserializableValue;
    if (o.type === 'object' && o.subtype === 'null') return 'null';
    if ('value' in o && o.type !== 'object') return String(o.value);
    if (o.type === 'function') return (o.description || 'function').split('\n')[0].slice(0, 120);
    return o.description || o.className || o.type;
  }

  toVariable(name, o) {
    const expandable = o && o.objectId && (o.type === 'object' || o.type === 'function') && o.subtype !== 'null';
    return { name, value: this.describe(o), type: o && (o.subtype || o.type), variablesReference: expandable ? this.handle_({ objectId: o.objectId }) : 0 };
  }

  async variables({ variablesReference }) {
    const h = this.handles.get(variablesReference);
    if (!h) return { variables: [] };
    const r = await this.cdp('Runtime.getProperties', { objectId: h.objectId, ownProperties: true, generatePreview: false });
    const vars = [];
    for (const p of r.result || []) {
      if (!p.value && !p.get) continue;
      if (h.scope === 'global' && p.value && p.value.type === 'function') continue;
      vars.push(this.toVariable(p.name, p.value || { type: 'undefined', description: '(getter)' }));
    }
    if (h.scope === 'global') vars.splice(200);
    return { variables: vars };
  }

  async evaluate({ expression, frameId, context }) {
    let r;
    const f = frameId && this.frames[frameId - 1];
    if (this.paused && f) r = await this.cdp('Debugger.evaluateOnCallFrame', { callFrameId: f.callFrameId, expression, throwOnSideEffect: context === 'hover', silent: context === 'hover' });
    else r = await this.cdp('Runtime.evaluate', { expression, replMode: true, silent: context === 'hover' });
    if (r.exceptionDetails) {
      if (context === 'hover') throw new Error('无法求值');
      throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    }
    const v = this.toVariable(expression, r.result);
    return { result: v.value, type: v.type, variablesReference: v.variablesReference };
  }
}

module.exports = { NodeAdapter };
