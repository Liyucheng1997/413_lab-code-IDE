// 集成终端：xterm.js + 主进程的 node-pty，可开多个终端。
import { ctx } from './state.js';
import { bus, h, escapeHtml, path } from './util.js';
import { icon } from './icons.js';
import { contextMenu } from './ui.js';

let stackEl;
let listEl;
const terms = [];
let active = null;
let seq = 1;
// 终端创建的回复可能晚于第一批输出到达，先按 id 暂存，拿到 id 后再写入
const earlyData = new Map();

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function xtermTheme() {
  const dark = ctx.isDark;
  return {
    background: cssVar('--panel'),
    foreground: cssVar('--text'),
    cursor: cssVar('--primary'),
    cursorAccent: cssVar('--panel'),
    selectionBackground: dark ? 'rgba(10,132,255,0.35)' : 'rgba(0,113,227,0.22)',
    black: dark ? '#1c1c1e' : '#1d1d1f',
    red: dark ? '#ff453a' : '#d70015',
    green: dark ? '#30d158' : '#248a3d',
    yellow: dark ? '#ffd60a' : '#a05a00',
    blue: dark ? '#0a84ff' : '#0071e3',
    magenta: dark ? '#bf5af2' : '#ad3da4',
    cyan: dark ? '#64d2ff' : '#0b7285',
    white: dark ? '#d1d1d6' : '#6e6e73',
    brightBlack: dark ? '#636366' : '#86868b',
    brightRed: dark ? '#ff6961' : '#ff3b30',
    brightGreen: dark ? '#4ae070' : '#34c759',
    brightYellow: dark ? '#ffe066' : '#c93400',
    brightBlue: dark ? '#409cff' : '#007aff',
    brightMagenta: dark ? '#da8fff' : '#af52de',
    brightCyan: dark ? '#8ae3ff' : '#32ade6',
    brightWhite: dark ? '#ffffff' : '#1d1d1f',
  };
}

class Term {
  constructor({ cwd, name }) {
    this.name = name || `终端 ${seq}`;
    this.seq = seq++;
    this.cwd = cwd;
    this.el = h('<div class="terminal-instance"></div>');
    stackEl.appendChild(this.el);
    this.xterm = new window.Terminal({
      fontFamily: ctx.settings.fontFamily,
      fontSize: ctx.settings.terminalFontSize || 13,
      lineHeight: 1.25,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowProposedApi: true,
      scrollback: 10000,
      theme: xtermTheme(),
      allowTransparency: true,
    });
    this.fit = new window.FitAddon.FitAddon();
    this.xterm.loadAddon(this.fit);
    this.xterm.loadAddon(new window.WebLinksAddon.WebLinksAddon((_e, uri) => window.ide.app.openExternal(uri)));
    this.xterm.open(this.el);
    this.xterm.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'c' && this.xterm.hasSelection()) {
        navigator.clipboard.writeText(this.xterm.getSelection());
        this.xterm.clearSelection();
        return false;
      }
      if (mod && e.key.toLowerCase() === 'v') {
        navigator.clipboard.readText().then((t) => this.xterm.paste(t));
        e.preventDefault();
        return false;
      }
      return true;
    });
    this.el.addEventListener('contextmenu', (e) =>
      contextMenu(e, [
        { label: '复制', disabled: !this.xterm.hasSelection(), action: () => navigator.clipboard.writeText(this.xterm.getSelection()) },
        { label: '粘贴', action: () => navigator.clipboard.readText().then((t) => this.xterm.paste(t)) },
        { label: '全选', action: () => this.xterm.selectAll() },
        { type: 'sep' },
        { label: '清除', action: () => this.xterm.clear() },
        { label: '终止终端', action: () => killTerminal(this) },
      ]),
    );
    this.xterm.onData((d) => this.id && window.ide.term.write(this.id, d));
    this.xterm.onResize(({ cols, rows }) => this.id && window.ide.term.resize(this.id, cols, rows));
    this.xterm.onTitleChange((t) => {
      if (t && !this.fixedName) {
        this.title = t;
        renderList();
      }
    });
    this.ro = new ResizeObserver(() => this.doFit());
    this.ro.observe(this.el);
    this.ready = this.start();
  }

  async start() {
    this.doFit();
    const r = await window.ide.term.create({ cwd: this.cwd || ctx.root, cols: this.xterm.cols, rows: this.xterm.rows });
    this.id = r.id;
    this.shell = r.shell;
    const early = earlyData.get(r.id);
    if (early) {
      earlyData.delete(r.id);
      this.xterm.write(early.join(''));
    }
    if (!r.pty) this.xterm.writeln('\x1b[33m[提示] node-pty 不可用，终端以简化模式运行（无行编辑、无交互程序支持）\x1b[0m');
    renderList();
  }

  doFit() {
    if (this.el.offsetParent === null || !this.el.clientWidth) return;
    try {
      this.fit.fit();
    } catch {}
  }

  async sendText(text, execute = true) {
    await this.ready;
    window.ide.term.write(this.id, text + (execute ? '\r' : ''));
  }

  dispose() {
    this.ro.disconnect();
    this.xterm.dispose();
    this.el.remove();
    if (this.id) window.ide.term.kill(this.id);
  }
}

function renderList() {
  listEl.innerHTML = '';
  for (const t of terms) {
    const item = h(`<div class="term-item${t === active ? ' active' : ''}">${icon('terminal')}<span title="${escapeHtml(t.title || t.name)}">${escapeHtml(t.fixedName ? t.name : t.shell ? `${t.name} · ${t.shell}` : t.name)}</span><button class="icon-btn" title="终止">${icon('trash')}</button></div>`);
    item.onclick = () => setActive(t);
    item.querySelector('button').onclick = (e) => {
      e.stopPropagation();
      killTerminal(t);
    };
    listEl.appendChild(item);
  }
}

function setActive(t) {
  active = t;
  for (const x of terms) x.el.hidden = x !== t;
  renderList();
  requestAnimationFrame(() => {
    t.doFit();
    t.xterm.focus();
  });
}

export function newTerminal(opts = {}) {
  bus.emit('panel:show', 'terminal');
  const t = new Term(opts);
  if (opts.fixedName) t.fixedName = true;
  terms.push(t);
  setActive(t);
  return t;
}

export function killTerminal(t = active) {
  if (!t) return;
  const i = terms.indexOf(t);
  if (i < 0) return; // 已经关闭过
  terms.splice(i, 1);
  t.dispose();
  if (active === t) {
    active = null;
    if (terms.length) setActive(terms[Math.max(0, i - 1)]);
  }
  renderList();
}

export function activeTerminal() {
  return active;
}

export function focusTerminal() {
  if (!terms.length) newTerminal();
  else setActive(active || terms[0]);
}

export function clearTerminal() {
  if (active) active.xterm.clear();
}

// 运行代码用的专用终端：复用同一个，正在运行的程序先 Ctrl+C
export async function runInTerminal(command, cwd) {
  let t = terms.find((x) => x.isRunner && !x.exited);
  if (!t) {
    t = newTerminal({ cwd, name: '运行', fixedName: true });
    t.isRunner = true;
  } else setActive(t);
  bus.emit('panel:show', 'terminal');
  await t.ready;
  t.sendText(command);
  return t;
}

export function stopRunner() {
  const t = terms.find((x) => x.isRunner && !x.exited);
  if (t) window.ide.term.write(t.id, '\x03');
}

export function initTerminal(container) {
  container.innerHTML = '<div class="terminal-layout"><div class="terminal-stack"></div><div class="terminal-list"></div></div>';
  stackEl = container.querySelector('.terminal-stack');
  listEl = container.querySelector('.terminal-list');

  window.ide.term.onData(({ id, data }) => {
    const t = terms.find((x) => x.id === id);
    if (t) t.xterm.write(data);
    else {
      if (!earlyData.has(id)) earlyData.set(id, []);
      earlyData.get(id).push(data);
    }
  });
  window.ide.term.onExit(({ id, code }) => {
    const t = terms.find((x) => x.id === id);
    if (!t) return;
    t.xterm.writeln(`\r\n\x1b[90m[进程已退出，代码 ${code}] 按任意键关闭\x1b[0m`);
    t.id = null;
    t.exited = true;
    const sub = t.xterm.onKey(() => {
      sub.dispose();
      killTerminal(t);
    });
  });
  bus.on('theme:changed', () => {
    for (const t of terms) t.xterm.options.theme = xtermTheme();
  });
  bus.on('settings:changed', (s) => {
    for (const t of terms) {
      t.xterm.options.fontSize = s.terminalFontSize || 13;
      t.xterm.options.fontFamily = s.fontFamily;
      t.doFit();
    }
  });
  bus.on('panel:resized', () => active && active.doFit());
  bus.on('terminal:new', (cwd) => newTerminal({ cwd }));
}

export function terminalActions() {
  return [
    { icon: 'plus', title: '新建终端 (Ctrl+Shift+`)', run: () => newTerminal() },
    { icon: 'clear', title: '清除终端', run: clearTerminal },
    { icon: 'trash', title: '终止终端', run: () => killTerminal() },
  ];
}

export function hasTerminals() {
  return terms.length > 0;
}

export { path };
