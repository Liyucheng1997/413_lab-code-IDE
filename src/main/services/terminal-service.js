// 集成终端：优先使用 node-pty（真正的伪终端），加载失败时退回普通子进程管道。
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const settings = require('./settings');

let pty = null;
try {
  pty = require('@lydell/node-pty');
} catch (err) {
  console.warn('node-pty 不可用，终端将使用管道模式：', err.message);
}

let send = () => {};
const terms = new Map();
let nextId = 1;

function setSender(fn) {
  send = fn;
}

function which(cmd) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const d of dirs) for (const e of exts) {
    const p = path.join(d, cmd + e);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}

function defaultShell() {
  const custom = settings.get().terminalShell;
  if (custom) return { file: custom, args: [] };
  if (process.platform === 'win32') {
    const pwsh = which('pwsh');
    return { file: pwsh || 'powershell.exe', args: ['-NoLogo'] };
  }
  return { file: process.env.SHELL || '/bin/bash', args: ['-l'] };
}

function create({ cwd, cols = 80, rows = 24, shell: shellOverride } = {}) {
  const id = nextId++;
  const sh = shellOverride ? { file: shellOverride, args: [] } : defaultShell();
  const dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  const env = { ...process.env, TERM_PROGRAM: 'LumenIDE', COLORTERM: 'truecolor' };
  delete env.ELECTRON_RUN_AS_NODE;

  if (pty) {
    try {
      const p = pty.spawn(sh.file, sh.args, { name: 'xterm-256color', cols, rows, cwd: dir, env, useConpty: true });
      p.onData((data) => send('term:data', { id, data }));
      p.onExit(({ exitCode }) => {
        terms.delete(id);
        send('term:exit', { id, code: exitCode });
      });
      terms.set(id, { kind: 'pty', proc: p });
      return { id, shell: path.basename(sh.file), pty: true };
    } catch (err) {
      console.warn('pty spawn 失败，改用管道：', err.message);
    }
  }

  const proc = spawn(sh.file, sh.args, { cwd: dir, env, windowsHide: true });
  const onData = (buf) => send('term:data', { id, data: buf.toString('utf8').replace(/\r?\n/g, '\r\n') });
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('exit', (code) => {
    terms.delete(id);
    send('term:exit', { id, code });
  });
  terms.set(id, { kind: 'pipe', proc, line: '' });
  return { id, shell: path.basename(sh.file), pty: false };
}

function write(id, data) {
  const t = terms.get(id);
  if (!t) return;
  if (t.kind === 'pty') return t.proc.write(data);
  // 管道模式没有行编辑，这里做最基本的回显与退格
  for (const ch of data) {
    if (ch === '\r') {
      send('term:data', { id, data: '\r\n' });
      t.proc.stdin.write(t.line + '\n');
      t.line = '';
    } else if (ch === '\x7f') {
      if (t.line) {
        t.line = t.line.slice(0, -1);
        send('term:data', { id, data: '\b \b' });
      }
    } else if (ch === '\x03') {
      t.proc.kill('SIGINT');
    } else {
      t.line += ch;
      send('term:data', { id, data: ch });
    }
  }
}

function resize(id, cols, rows) {
  const t = terms.get(id);
  if (t && t.kind === 'pty' && cols > 0 && rows > 0) {
    try {
      t.proc.resize(cols, rows);
    } catch {}
  }
}

function kill(id) {
  const t = terms.get(id);
  if (!t) return;
  try {
    t.proc.kill();
  } catch {}
  terms.delete(id);
}

function disposeAll() {
  for (const id of [...terms.keys()]) kill(id);
}

function register(ipc) {
  ipc.handle('term:create', (_e, opts) => create(opts));
  ipc.on('term:write', (_e, id, data) => write(id, data));
  ipc.on('term:resize', (_e, id, cols, rows) => resize(id, cols, rows));
  ipc.handle('term:kill', (_e, id) => kill(id));
}

module.exports = { register, setSender, disposeAll, which };
