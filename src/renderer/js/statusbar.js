// 状态栏：分支、问题数、语言服务器状态、光标位置、缩进、编码、换行符、语言模式。
import { ctx } from './state.js';
import { bus, h, escapeHtml } from './util.js';
import { icon } from './icons.js';
import { showMenu } from './ui.js';
import * as editors from './editors.js';
import { lspStatus } from './lsp-client.js';
import { runCommand } from './commands.js';
import { openPicker, gotoLine } from './palette.js';

let left;
let right;
const items = {};

function item(container, key, { title, onClick } = {}) {
  const el = h(`<${onClick ? 'button' : 'span'} class="sb-item" title="${escapeHtml(title || '')}"></${onClick ? 'button' : 'span'}>`);
  if (onClick) el.onclick = onClick;
  container.appendChild(el);
  items[key] = el;
  return el;
}

const ENCODING_LABEL = { utf8: 'UTF-8', utf8bom: 'UTF-8 with BOM', utf16le: 'UTF-16 LE', utf16be: 'UTF-16 BE' };

function updateEditorItems() {
  const ed = editors.activeEditor();
  const doc = editors.activeDoc();
  const model = ed && ed.getModel();
  const show = !!model;
  for (const k of ['pos', 'indent', 'encoding', 'eol', 'lang']) items[k].hidden = !show;
  if (!show) return;
  const pos = ed.getPosition() || { lineNumber: 1, column: 1 };
  const sels = ed.getSelections() || [];
  const selChars = sels.reduce((n, s) => n + model.getValueLengthInRange(s), 0);
  items.pos.textContent = `行 ${pos.lineNumber}，列 ${pos.column}${selChars ? `（已选择 ${selChars}）` : ''}${sels.length > 1 ? ` · ${sels.length} 个光标` : ''}`;
  const o = model.getOptions();
  items.indent.textContent = o.insertSpaces ? `空格: ${o.tabSize}` : `制表符长度: ${o.tabSize}`;
  items.encoding.textContent = ENCODING_LABEL[(doc && doc.encoding) || 'utf8'];
  items.eol.textContent = model.getEOL() === '\r\n' ? 'CRLF' : 'LF';
  const langId = model.getLanguageId();
  const lang = ctx.monaco.languages.getLanguages().find((l) => l.id === langId);
  items.lang.textContent = (lang && lang.aliases && lang.aliases[0]) || langId;
  updateLsp(langId);
}

function updateLsp(langId) {
  const st = langId && lspStatus(langId);
  const el = items.lsp;
  if (!st) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  if (st.state === 'starting') el.innerHTML = `${icon('refresh', 'spin')}<span>正在启动语言服务器…</span>`;
  else if (st.state === 'ready') el.innerHTML = `<span class="dot success"></span><span>${escapeHtml(st.name)}</span>`;
  else el.innerHTML = `<span class="dot warning"></span><span>无语言服务器</span>`;
  el.title = st.state === 'missing' ? `${st.message || ''}${st.install ? '\n安装：' + st.install : ''}\n（仍可使用关键字、片段与单词补全）` : '语言服务器提供智能补全、跳转定义、诊断等';
}

function indentMenu(e) {
  const model = editors.activeEditor() && editors.activeEditor().getModel();
  if (!model) return;
  const r = e.currentTarget.getBoundingClientRect();
  const o = model.getOptions();
  const set = (patch) => {
    model.updateOptions(patch);
    updateEditorItems();
  };
  showMenu(
    [
      { type: 'header', label: '缩进方式' },
      { label: '使用空格缩进', checked: o.insertSpaces, action: () => set({ insertSpaces: true }) },
      { label: '使用制表符缩进', checked: !o.insertSpaces, action: () => set({ insertSpaces: false }) },
      { type: 'sep' },
      { type: 'header', label: '缩进宽度' },
      ...[2, 4, 8].map((n) => ({ label: String(n), checked: o.tabSize === n, action: () => set({ tabSize: n }) })),
      { type: 'sep' },
      { label: '从内容检测缩进', action: () => (model.detectIndentation(o.insertSpaces, o.tabSize), updateEditorItems()) },
      { label: '将缩进转换为空格', action: () => editors.activeEditor().trigger('lumen', 'editor.action.indentationToSpaces', null) },
      { label: '将缩进转换为制表符', action: () => editors.activeEditor().trigger('lumen', 'editor.action.indentationToTabs', null) },
    ],
    r.left,
    r.top - 4,
    { above: true },
  );
}

function toggleEol() {
  const model = editors.activeEditor() && editors.activeEditor().getModel();
  if (!model) return;
  model.pushEOL(model.getEOL() === '\r\n' ? 0 : 1);
  updateEditorItems();
}

export function pickLanguage() {
  const model = editors.activeEditor() && editors.activeEditor().getModel();
  if (!model) return;
  const langs = ctx.monaco.languages.getLanguages();
  openPicker({
    placeholder: '选择语言模式',
    items: langs.map((l) => ({ label: (l.aliases && l.aliases[0]) || l.id, desc: l.id + (l.extensions ? '  ' + l.extensions.slice(0, 4).join(' ') : ''), matchDesc: true, action: () => (ctx.monaco.editor.setModelLanguage(model, l.id), updateEditorItems()) })),
  });
}

export function initStatusbar() {
  left = document.getElementById('sb-left');
  right = document.getElementById('sb-right');
  item(left, 'branch', { title: '切换分支', onClick: () => runCommand('git.checkout') });
  item(left, 'problems', { title: '问题 (Ctrl+Shift+M)', onClick: () => runCommand('view.problems') });
  item(left, 'lsp', { title: '', onClick: () => bus.emit('view:show', 'run') });
  item(left, 'debug', { title: '运行和调试', onClick: () => bus.emit('view:show', 'run') }).hidden = true;
  item(right, 'pos', { title: '转到行 (Ctrl+G)', onClick: gotoLine });
  item(right, 'indent', { title: '选择缩进', onClick: indentMenu });
  item(right, 'encoding', { title: '文件编码' });
  item(right, 'eol', { title: '切换行尾序列', onClick: toggleEol });
  item(right, 'lang', { title: '选择语言模式', onClick: pickLanguage });
  item(right, 'update', { onClick: () => items.update.dataset.cmd && runCommand(items.update.dataset.cmd) }).hidden = true;
  item(right, 'notify', { title: '快捷键', onClick: () => runCommand('help.keys') }).innerHTML = icon('keyboard');

  items.branch.hidden = true;
  items.lsp.hidden = true;
  items.problems.innerHTML = `${icon('error')}<span>0</span>${icon('warning')}<span>0</span>`;

  bus.on('editor:cursor', updateEditorItems);
  bus.on('editor:active', updateEditorItems);
  bus.on('lsp:changed', updateEditorItems);
  bus.on('problems:counts', (c) => {
    items.problems.innerHTML = `${icon('error')}<span>${c.errors}</span>${icon('warning')}<span>${c.warnings}</span>`;
  });
  bus.on('debug:changed', (s) => {
    items.debug.hidden = !s;
    if (s) items.debug.innerHTML = `<span class="dot ${s.status === 'stopped' ? 'warning' : 'success'}"></span><span>${s.status === 'stopped' ? '已暂停' : s.status === 'starting' ? '正在启动调试' : '调试中'}${s.label ? ' · ' + escapeHtml(s.label) : ''}</span>`;
  });
  bus.on('update:changed', (s) => {
    const el = items.update;
    el.hidden = !['downloading', 'downloaded', 'available'].includes(s.state);
    el.classList.toggle('sb-accent', s.state !== 'downloading');
    if (s.state === 'downloading') {
      el.innerHTML = `${icon('download')}<span>${s.percent || 0}%</span>`;
      el.title = `正在下载 Lumen IDE ${s.version}`;
      el.dataset.cmd = '';
    } else if (s.state === 'downloaded') {
      el.innerHTML = `${icon('refresh')}<span>重启以更新</span>`;
      el.title = `Lumen IDE ${s.version} 已下载，点击重启完成更新`;
      el.dataset.cmd = 'update.restart';
    } else if (s.state === 'available') {
      el.innerHTML = `${icon('download')}<span>新版本 ${escapeHtml(s.version)}</span>`;
      el.title = '前往下载页';
      el.dataset.cmd = 'update.download';
    }
  });
  bus.on('git:status', (s) => {
    if (!s || !s.isRepo) {
      items.branch.hidden = true;
      return;
    }
    items.branch.hidden = false;
    items.branch.innerHTML = `${icon('branch')}<span>${escapeHtml(s.branch)}${s.files.length ? '*' : ''}</span>${s.ahead || s.behind ? `<span>${s.behind ? '↓' + s.behind : ''}${s.ahead ? ' ↑' + s.ahead : ''}</span>` : ''}`;
  });
  updateEditorItems();
}
