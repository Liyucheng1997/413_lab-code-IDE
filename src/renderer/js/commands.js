// 命令注册表 + 全局快捷键（支持 "Ctrl+K Ctrl+O" 这样的组合键）。
import { isWin } from './util.js';

const isMac = navigator.userAgent.includes('Mac');
const commands = new Map();
const keymap = new Map(); // 归一化键串 → 命令 id
const chordPrefixes = new Set();
let pendingChord = null;
let chordTimer = null;

export function registerCommand(cmd) {
  // cmd: { id, title, category?, key?, run, palette? }
  commands.set(cmd.id, cmd);
  if (cmd.key) bindKey(cmd.key, cmd.id);
  return cmd;
}

export function bindKey(key, id) {
  const k = normalizeBinding(key);
  keymap.set(k, id);
  if (k.includes(' ')) chordPrefixes.add(k.split(' ')[0]);
}

export function runCommand(id, ...args) {
  const cmd = commands.get(id);
  if (!cmd) return console.warn('未知命令', id);
  try {
    return cmd.run(...args);
  } catch (err) {
    console.error(err);
  }
}

export function getCommand(id) {
  return commands.get(id);
}

export function allCommands() {
  return [...commands.values()].filter((c) => c.palette !== false && c.title);
}

function normalizeBinding(key) {
  return key
    .split(' ')
    .map((part) => {
      const mods = part.split('+');
      const main = mods.pop();
      const set = new Set(mods.map((m) => m.toLowerCase()));
      const out = [];
      if (set.has('ctrl') || set.has('cmd')) out.push('ctrl');
      if (set.has('shift')) out.push('shift');
      if (set.has('alt')) out.push('alt');
      out.push(main.length === 1 ? main.toUpperCase() : main);
      return out.join('+');
    })
    .join(' ');
}

// 用于在菜单/面板上显示
export function keyLabel(key) {
  if (!key) return '';
  if (isMac) return key.replace(/Ctrl\+/g, '⌘').replace(/Shift\+/g, '⇧').replace(/Alt\+/g, '⌥');
  return key;
}

const CODE_KEYS = {
  Backquote: '`', Backslash: '\\', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=',
  ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', Space: 'Space', Backspace: 'Backspace', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  NumpadAdd: '=', NumpadSubtract: '-',
};

function eventKey(e) {
  let main;
  if (/^Key[A-Z]$/.test(e.code)) main = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) main = e.code.slice(5);
  else if (/^F\d{1,2}$/.test(e.code)) main = e.code;
  else main = CODE_KEYS[e.code];
  if (!main) return null;
  const out = [];
  if (isMac ? e.metaKey : e.ctrlKey) out.push('ctrl');
  if (e.shiftKey) out.push('shift');
  if (e.altKey) out.push('alt');
  out.push(main);
  return out.join('+');
}

export function installKeyHandler() {
  window.addEventListener(
    'keydown',
    (e) => {
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
      // 对话框打开时不处理全局快捷键
      if (document.querySelector('.modal-overlay')) return;
      const k = eventKey(e);
      if (!k) return;
      if (pendingChord) {
        const full = pendingChord + ' ' + k;
        pendingChord = null;
        clearTimeout(chordTimer);
        const id = keymap.get(full);
        if (id) {
          e.preventDefault();
          e.stopPropagation();
          runCommand(id);
        }
        return;
      }
      if (chordPrefixes.has(k) && !keymap.has(k)) {
        pendingChord = k;
        chordTimer = setTimeout(() => (pendingChord = null), 2000);
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const id = keymap.get(k);
      // 终端获得焦点时，把 Ctrl+字母 留给 Shell（Ctrl+W 删词、Ctrl+B 回退等），只保留少数全局键
      if (id && /^ctrl\+[A-Z]$/.test(k) && !'PJ'.includes(k.slice(-1)) && e.target.closest && e.target.closest('.xterm')) return;
      if (id) {
        const cmd = commands.get(id);
        if (cmd.when && !cmd.when(e)) return;
        e.preventDefault();
        e.stopPropagation();
        runCommand(id);
      }
    },
    true,
  );
}

export { isMac, isWin };
