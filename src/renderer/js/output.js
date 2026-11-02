// 输出面板：按通道（LSP / Git / 运行 / Lumen）记录日志。
import { bus, escapeHtml } from './util.js';

const channels = new Map([['Lumen', []], ['LSP', []], ['Git', []]]);
let current = 'LSP';
let el = null;
const MAX = 3000;

export function log(channel, text) {
  if (!channels.has(channel)) {
    channels.set(channel, []);
    bus.emit('output:channels');
  }
  const time = new Date().toTimeString().slice(0, 8);
  const lines = channels.get(channel);
  for (const line of String(text).split('\n')) lines.push(`[${time}] ${line}`);
  if (lines.length > MAX) lines.splice(0, lines.length - MAX);
  if (el && channel === current) render();
}

function render() {
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  el.innerHTML = escapeHtml((channels.get(current) || []).join('\n'));
  if (atBottom) el.scrollTop = el.scrollHeight;
}

export function initOutput(container) {
  container.innerHTML = '<div class="output-view"></div>';
  el = container.querySelector('.output-view');
  render();
}

export function outputActions() {
  const sel = document.createElement('select');
  const fill = () => {
    sel.innerHTML = [...channels.keys()].map((c) => `<option ${c === current ? 'selected' : ''}>${c}</option>`).join('');
  };
  fill();
  bus.on('output:channels', fill);
  sel.onchange = () => {
    current = sel.value;
    render();
  };
  const wrap = document.createElement('span');
  wrap.className = 'output-toolbar';
  wrap.appendChild(sel);
  return { el: wrap, clear: () => (channels.set(current, []), render()) };
}

export function showChannel(name) {
  current = name;
  if (el) render();
  bus.emit('output:channels');
}

export function channelNames() {
  return [...channels.keys()];
}

export function channelText(name, lines = 200) {
  const key = [...channels.keys()].find((k) => k.toLowerCase() === String(name || '').toLowerCase()) || name;
  const list = channels.get(key);
  return list ? list.slice(-lines).join('\n') : null;
}
