// LSP（Language Server Protocol）桥：在主进程里启动各语言的语言服务器，
// 渲染进程通过 IPC 发送请求，从而获得补全、悬停、跳转定义、诊断等能力。
const { spawn } = require('child_process');
const path = require('path');
const { app } = require('electron');
const { pathToFileURL } = require('url');
const crypto = require('crypto');
const settings = require('./settings');
const { which } = require('./terminal-service');

let send = () => {};
const servers = new Map(); // key: serverId|root

function setSender(fn) {
  send = fn;
}

function pyrightPath() {
  try {
    return require.resolve('pyright/langserver.index.js');
  } catch {
    return null;
  }
}

// 内置的服务器配置。Python 使用随应用安装的 Pyright；其余语言检测本机 PATH。
function builtinServers(root) {
  const jdtlsData = path.join(app.getPath('userData'), 'jdtls', crypto.createHash('md5').update(root).digest('hex').slice(0, 10));
  return [
    { id: 'pyright', name: 'Pyright', languages: ['python'], node: pyrightPath(), args: ['--stdio'], install: 'pyright 随 IDE 一起安装' },
    { id: 'clangd', name: 'clangd', languages: ['c', 'cpp', 'objective-c'], command: 'clangd', args: ['--background-index', '--header-insertion=never'], install: '安装 LLVM 或 clangd 并加入 PATH' },
    { id: 'gopls', name: 'gopls', languages: ['go'], command: 'gopls', args: [], install: 'go install golang.org/x/tools/gopls@latest' },
    { id: 'rust-analyzer', name: 'rust-analyzer', languages: ['rust'], command: 'rust-analyzer', args: [], install: 'rustup component add rust-analyzer' },
    { id: 'jdtls', name: 'Eclipse JDT LS', languages: ['java'], command: 'jdtls', args: ['-data', jdtlsData], install: '安装 jdtls 并加入 PATH' },
    { id: 'csharp-ls', name: 'csharp-ls', languages: ['csharp'], command: 'csharp-ls', args: [], install: 'dotnet tool install --global csharp-ls' },
    { id: 'intelephense', name: 'Intelephense', languages: ['php'], command: 'intelephense', args: ['--stdio'], install: 'npm i -g intelephense' },
    { id: 'bash-ls', name: 'bash-language-server', languages: ['shell'], command: 'bash-language-server', args: ['start'], install: 'npm i -g bash-language-server' },
    { id: 'lua-ls', name: 'lua-language-server', languages: ['lua'], command: 'lua-language-server', args: [], install: '安装 lua-language-server 并加入 PATH' },
    { id: 'solargraph', name: 'Solargraph', languages: ['ruby'], command: 'solargraph', args: ['stdio'], install: 'gem install solargraph' },
    { id: 'kotlin-ls', name: 'kotlin-language-server', languages: ['kotlin'], command: 'kotlin-language-server', args: [], install: '安装 kotlin-language-server 并加入 PATH' },
    { id: 'dart', name: 'Dart Analysis Server', languages: ['dart'], command: 'dart', args: ['language-server', '--protocol=lsp'], install: '安装 Dart SDK' },
    { id: 'yaml-ls', name: 'yaml-language-server', languages: ['yaml'], command: 'yaml-language-server', args: ['--stdio'], install: 'npm i -g yaml-language-server' },
    { id: 'zls', name: 'zls', languages: ['zig'], command: 'zls', args: [], install: '安装 zls 并加入 PATH' },
  ];
}

// Monaco 语言 ID → LSP 语言 ID
const LSP_LANGUAGE_ID = { shell: 'shellscript' };

function resolveConfig(languageId, root) {
  // 用户在 settings.json 的 "lsp" 中的配置优先
  const user = settings.get().lsp || {};
  if (user[languageId] && user[languageId].command) {
    const u = user[languageId];
    return { id: 'user-' + languageId, name: u.command, languages: [languageId], command: u.command, args: u.args || [] };
  }
  return builtinServers(root).find((s) => s.languages.includes(languageId)) || null;
}

class LspServer {
  constructor(config, root) {
    this.config = config;
    this.root = root;
    this.key = `${config.id}|${root}`;
    this.seq = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.ready = null;
    this.capabilities = {};
    this.dead = false;
  }

  start() {
    const { config } = this;
    let file;
    let args;
    let useShell = false;
    const env = { ...process.env };
    if (config.node) {
      file = process.execPath;
      args = [config.node, ...config.args];
      env.ELECTRON_RUN_AS_NODE = '1';
    } else {
      file = which(config.command);
      if (!file) {
        this.ready = Promise.reject(new Error(`未找到 ${config.command}。${config.install || ''}`));
        this.ready.catch(() => {});
        return this.ready;
      }
      args = config.args;
      useShell = /\.(cmd|bat)$/i.test(file);
      if (useShell) file = `"${file}"`;
    }

    this.proc = spawn(file, args, { cwd: this.root, env, windowsHide: true, shell: useShell });
    this.proc.stdout.on('data', (chunk) => this.onData(chunk));
    this.proc.stderr.on('data', (d) => send('lsp:log', { server: config.name, text: d.toString() }));
    this.proc.on('exit', (code) => this.onExit(code));
    this.proc.on('error', (err) => this.onExit(-1, err));

    const rootUri = pathToFileURL(this.root).href;
    this.ready = this.request('initialize', {
      processId: process.pid,
      clientInfo: { name: 'Lumen IDE', version: app.getVersion() },
      locale: 'zh-cn',
      rootPath: this.root,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: path.basename(this.root) }],
      initializationOptions: {},
      capabilities: {
        general: { positionEncodings: ['utf-16'] },
        workspace: { workspaceFolders: true, configuration: true, applyEdit: true, didChangeConfiguration: { dynamicRegistration: true }, workspaceEdit: { documentChanges: true } },
        window: { workDoneProgress: true, showMessage: {} },
        textDocument: {
          synchronization: { didSave: true, willSave: false, dynamicRegistration: false },
          completion: {
            contextSupport: true,
            completionItem: {
              snippetSupport: true,
              documentationFormat: ['markdown', 'plaintext'],
              deprecatedSupport: true,
              preselectSupport: true,
              insertReplaceSupport: true,
              labelDetailsSupport: true,
              tagSupport: { valueSet: [1] },
              resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] },
            },
            completionItemKind: { valueSet: Array.from({ length: 25 }, (_, i) => i + 1) },
          },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'], parameterInformation: { labelOffsetSupport: true }, activeParameterSupport: true }, contextSupport: true },
          definition: { linkSupport: true },
          declaration: { linkSupport: true },
          typeDefinition: { linkSupport: true },
          implementation: { linkSupport: true },
          references: {},
          documentHighlight: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true, symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) } },
          formatting: {},
          rangeFormatting: {},
          rename: { prepareSupport: true },
          codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ['', 'quickfix', 'refactor', 'refactor.extract', 'refactor.inline', 'refactor.rewrite', 'source', 'source.organizeImports'] } }, isPreferredSupport: true },
          publishDiagnostics: { relatedInformation: true, tagSupport: { valueSet: [1, 2] } },
          inlayHint: {},
          foldingRange: { lineFoldingOnly: true },
        },
      },
    }).then((res) => {
      this.capabilities = res.capabilities || {};
      this.notify('initialized', {});
      send('lsp:status', { server: config.name, languages: config.languages, root: this.root, state: 'ready' });
      return this.capabilities;
    });
    return this.ready;
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.slice(0, headerEnd).toString('ascii');
      const m = header.match(/Content-Length:\s*(\d+)/i);
      if (!m) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const len = +m[1];
      const start = headerEnd + 4;
      if (this.buffer.length < start + len) return;
      const body = this.buffer.slice(start, start + len).toString('utf8');
      this.buffer = this.buffer.slice(start + len);
      try {
        this.onMessage(JSON.parse(body));
      } catch (err) {
        console.warn('LSP 消息解析失败', err.message);
      }
    }
  }

  onMessage(msg) {
    if (msg.id !== undefined && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
      else p.resolve(msg.result);
      return;
    }
    if (msg.id !== undefined && msg.method) return this.onServerRequest(msg);
    send('lsp:notification', { server: this.config.name, root: this.root, method: msg.method, params: msg.params });
  }

  onServerRequest(msg) {
    let result = null;
    switch (msg.method) {
      case 'workspace/configuration':
        result = (msg.params.items || []).map((item) => {
          if (item.section === 'python' || item.section === 'python.analysis') return item.section === 'python' ? { analysis: { autoImportCompletions: true, typeCheckingMode: 'basic' } } : { autoImportCompletions: true, typeCheckingMode: 'basic' };
          return null;
        });
        break;
      case 'workspace/workspaceFolders':
        result = [{ uri: pathToFileURL(this.root).href, name: path.basename(this.root) }];
        break;
      case 'workspace/applyEdit':
        send('lsp:apply-edit', { edit: msg.params.edit });
        result = { applied: true };
        break;
      default:
        result = null; // client/registerCapability、window/workDoneProgress/create 等
    }
    this.write({ jsonrpc: '2.0', id: msg.id, result });
  }

  write(obj) {
    if (this.dead || !this.proc || !this.proc.stdin.writable) return;
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    this.proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.proc.stdin.write(body);
  }

  request(method, params, timeout = 30000) {
    if (this.dead) return Promise.reject(new Error('语言服务器已退出'));
    const id = this.seq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          this.write({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } });
          reject(new Error('请求超时：' + method));
        }
      }, timeout);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    this.write({ jsonrpc: '2.0', method, params });
  }

  onExit(code, err) {
    if (this.dead) return;
    this.dead = true;
    for (const p of this.pending.values()) p.reject(new Error('语言服务器已退出'));
    this.pending.clear();
    servers.delete(this.key);
    send('lsp:status', { server: this.config.name, languages: this.config.languages, root: this.root, state: 'stopped', message: err ? err.message : `退出码 ${code}` });
  }

  stop() {
    if (this.dead) return;
    const proc = this.proc;
    this.request('shutdown', null, 2000)
      .catch(() => {})
      .then(() => {
        this.notify('exit', null);
        setTimeout(() => proc && proc.kill(), 500);
      });
  }
}

async function ensure(languageId, root) {
  const config = resolveConfig(languageId, root);
  if (!config) return { ok: false, reason: 'none' };
  if (config.node === null) return { ok: false, reason: 'missing', message: '未找到 pyright' };
  const key = `${config.id}|${root}`;
  let server = servers.get(key);
  if (!server) {
    server = new LspServer(config, root);
    servers.set(key, server);
    send('lsp:status', { server: config.name, languages: config.languages, root, state: 'starting' });
    server.start().catch((err) => {
      servers.delete(key);
      server.dead = true;
      send('lsp:status', { server: config.name, languages: config.languages, root, state: 'error', message: err.message });
    });
  }
  try {
    const capabilities = await server.ready;
    return { ok: true, name: config.name, capabilities, lspLanguageId: LSP_LANGUAGE_ID[languageId] || languageId };
  } catch (err) {
    return { ok: false, reason: 'missing', message: err.message, install: config.install };
  }
}

function serverFor(languageId, root) {
  const config = resolveConfig(languageId, root);
  return config && servers.get(`${config.id}|${root}`);
}

function disposeAll() {
  for (const s of servers.values()) s.stop();
  servers.clear();
}

function register(ipc) {
  ipc.handle('lsp:start', (_e, languageId, root) => ensure(languageId, root));
  ipc.handle('lsp:request', async (_e, languageId, root, method, params) => {
    const s = serverFor(languageId, root);
    if (!s) throw new Error('语言服务器未启动');
    await s.ready;
    return s.request(method, params);
  });
  ipc.on('lsp:notify', (_e, languageId, root, method, params) => {
    const s = serverFor(languageId, root);
    if (s) s.ready.then(() => s.notify(method, params)).catch(() => {});
  });
  ipc.handle('lsp:restart', (_e, languageId, root) => {
    const s = serverFor(languageId, root);
    if (s) {
      s.stop();
      servers.delete(s.key);
    }
    return ensure(languageId, root);
  });
  ipc.handle('lsp:list', () => [...servers.values()].map((s) => ({ name: s.config.name, root: s.root, languages: s.config.languages })));
  ipc.handle('lsp:stop-root', (_e, root) => {
    for (const s of [...servers.values()]) if (s.root === root) {
      s.stop();
      servers.delete(s.key);
    }
  });
}

module.exports = { register, setSender, disposeAll };
