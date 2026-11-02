// 命令面板 / 快速打开：
//   无前缀 → 搜索文件   ">" → 命令   ":" → 跳到行   "@" → 当前文件符号   "?" → 帮助
import { ctx } from './state.js';
import { bus, path, escapeHtml, fileIcon, fuzzy, highlight, h } from './util.js';
import { allCommands, runCommand, keyLabel } from './commands.js';
import * as editors from './editors.js';

let fileCache = null;
let fileCacheRoot = null;
const recentFiles = [];
const recentCommands = [];
let current = null;

bus.on('fs:changed', () => (fileCache = null));
bus.on('editor:active', (tab) => {
  if (tab && tab.type === 'file' && !tab.path.startsWith('untitled:')) {
    const i = recentFiles.findIndex((p) => path.same(p, tab.path));
    if (i >= 0) recentFiles.splice(i, 1);
    recentFiles.unshift(tab.path);
    if (recentFiles.length > 50) recentFiles.pop();
  }
});

async function files() {
  if (!ctx.root) return [];
  if (!fileCache || fileCacheRoot !== ctx.root) {
    fileCacheRoot = ctx.root;
    fileCache = await window.ide.fs.listAll(ctx.root);
  }
  return fileCache;
}

function close() {
  if (!current) return;
  current.overlay.remove();
  current = null;
}

// 通用选择器。items: [{label, desc, key, icon(html), action}] 或 provider(query) → items
export function openPicker({ placeholder = '', value = '', items, provider, onAccept }) {
  close();
  const overlay = h(`<div class="palette-overlay"><div class="palette"><input class="input" spellcheck="false" placeholder="${escapeHtml(placeholder)}"><div class="palette-list"></div></div></div>`);
  document.body.appendChild(overlay);
  const input = overlay.querySelector('input');
  const list = overlay.querySelector('.palette-list');
  let shown = [];
  let sel = 0;
  const state = { overlay, input };
  current = state;
  input.value = value;

  const renderList = async () => {
    const q = input.value;
    let result;
    if (provider) result = await provider(q, state);
    else {
      result = items
        .map((it) => {
          const m = fuzzy(q, it.label + (it.matchDesc ? ' ' + it.desc : ''));
          return m ? { ...it, _score: m.score, _pos: m.positions } : null;
        })
        .filter(Boolean);
      if (q) result.sort((a, b) => b._score - a._score);
    }
    if (current !== state) return;
    shown = result.slice(0, 200);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    if (!shown.length) {
      list.innerHTML = `<div class="palette-empty">${state.emptyText || '没有匹配的结果'}</div>`;
      return;
    }
    list.innerHTML = '';
    shown.forEach((it, i) => {
      if (it.group) list.appendChild(h(`<div class="palette-group">${escapeHtml(it.group)}</div>`));
      const row = h(`<div class="palette-item${i === sel ? ' selected' : ''}">${it.icon || ''}<span class="label">${highlight(it.label, it._pos && it._pos.filter((p) => p < it.label.length))}</span><span class="desc">${escapeHtml(it.desc || '')}</span>${it.key ? `<kbd>${escapeHtml(keyLabel(it.key))}</kbd>` : ''}</div>`);
      row.addEventListener('mousemove', () => {
        if (sel !== i) {
          sel = i;
          list.querySelectorAll('.palette-item').forEach((r, j) => r.classList.toggle('selected', j === sel));
        }
      });
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        accept(i);
      });
      list.appendChild(row);
    });
    const selEl = list.querySelectorAll('.palette-item')[sel];
    if (selEl) selEl.scrollIntoView({ block: 'nearest' });
  };

  const accept = (i, e) => {
    const it = shown[i];
    if (!it && !onAccept) return;
    close();
    if (onAccept) onAccept(it, input.value, e);
    else if (it && it.action) it.action(e);
  };

  input.addEventListener('input', () => {
    sel = 0;
    renderList();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      sel = Math.min(shown.length - 1, sel + 1);
      renderList();
    } else if (e.key === 'ArrowUp') {
      sel = Math.max(0, sel - 1);
      renderList();
    } else if (e.key === 'PageDown') {
      sel = Math.min(shown.length - 1, sel + 10);
      renderList();
    } else if (e.key === 'PageUp') {
      sel = Math.max(0, sel - 10);
      renderList();
    } else if (e.key === 'Enter') accept(sel, e);
    else if (e.key === 'Escape') close();
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });
  input.addEventListener('blur', () => setTimeout(() => current === state && document.activeElement !== input && close(), 100));
  renderList();
  setTimeout(() => input.focus());
  state.refresh = renderList;
  return state;
}

async function quickProvider(q, state) {
  if (q.startsWith('>')) return commandItems(q.slice(1).trim());
  if (q.startsWith(':')) return gotoLineItems(q.slice(1).trim());
  if (q.startsWith('@')) {
    close();
    const ed = editors.activeEditor();
    if (ed) {
      ed.focus();
      ed.trigger('lumen', 'editor.action.quickOutline', null);
    }
    return [];
  }
  if (q.startsWith('?')) {
    return [
      { label: '…', desc: '按名称搜索并打开文件', action: () => quickOpen('') },
      { label: '>', desc: '显示并运行命令', action: () => quickOpen('>') },
      { label: ':', desc: '转到行号（例如 :42 或 :42:7）', action: () => quickOpen(':') },
      { label: '@', desc: '转到当前文件中的符号', action: () => quickOpen('@') },
    ];
  }
  state.emptyText = ctx.root ? '没有匹配的文件' : '尚未打开文件夹';
  const list = await files();
  const query = q.trim().replace(/\\/g, '/');
  let items;
  if (!query) {
    const rec = recentFiles.filter((p) => !ctx.root || path.isInside(ctx.root, p)).slice(0, 15);
    items = rec.map((p, i) => fileItem(p, null, i === 0 ? '最近打开' : null));
    if (!items.length) items = list.slice(0, 50).map((p) => fileItem(p));
    return items;
  }
  // 支持 "文件名:行号"
  const lineMatch = query.match(/^(.*?):(\d+)(?::(\d+))?$/);
  const nameQ = lineMatch ? lineMatch[1] : query;
  const scored = [];
  for (const p of list) {
    const rel = path.relative(ctx.root, p).replace(/\\/g, '/');
    const base = path.basename(p);
    let m = fuzzy(nameQ, base);
    let score;
    let pos = null;
    if (m) {
      score = m.score + 10;
      pos = m.positions;
    } else {
      m = fuzzy(nameQ, rel);
      if (!m) continue;
      score = m.score;
    }
    if (recentFiles.some((r) => path.same(r, p))) score += 5;
    scored.push({ p, score, pos });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 100).map((s) => {
    const it = fileItem(s.p, s.pos);
    if (lineMatch) it.action = () => editors.openFile(s.p, { line: +lineMatch[2], column: +(lineMatch[3] || 1), pinned: true });
    return it;
  });
}

function fileItem(p, pos, group) {
  const rel = ctx.root ? path.relative(ctx.root, path.dirname(p)) : path.dirname(p);
  return {
    label: path.basename(p),
    desc: rel === path.dirname(p) && ctx.root && path.same(path.dirname(p), ctx.root) ? '' : rel,
    icon: fileIcon(path.basename(p)),
    _pos: pos,
    group,
    action: () => editors.openFile(p, { pinned: true }),
  };
}

function commandItems(q) {
  const list = allCommands();
  const scored = [];
  for (const c of list) {
    const label = c.category ? `${c.category}：${c.title}` : c.title;
    const m = fuzzy(q, label + ' ' + c.id);
    if (!m) continue;
    const ri = recentCommands.indexOf(c.id);
    scored.push({ label, key: c.key, _pos: m.positions, _score: m.score + (ri >= 0 ? 20 - ri : 0), action: () => execCommand(c.id) });
  }
  // 最近用过的命令带有加分，空查询时自然排在最前
  scored.sort((a, b) => b._score - a._score);
  return scored;
}

function execCommand(id) {
  const i = recentCommands.indexOf(id);
  if (i >= 0) recentCommands.splice(i, 1);
  recentCommands.unshift(id);
  if (recentCommands.length > 10) recentCommands.pop();
  runCommand(id);
}

function gotoLineItems(q) {
  const ed = editors.activeEditor();
  if (!ed) return [{ label: '没有打开的编辑器' }];
  const model = ed.getModel();
  const [l, c] = q.split(/[:,]/).map((x) => parseInt(x, 10));
  if (!l) return [{ label: `当前行 ${ed.getPosition().lineNumber}，共 ${model.getLineCount()} 行。输入要跳转的行号。` }];
  const line = Math.min(Math.max(1, l), model.getLineCount());
  return [
    {
      label: `转到第 ${line} 行${c ? `，第 ${c} 列` : ''}`,
      action: () => {
        editors.recordCurrentPosition();
        ed.setPosition({ lineNumber: line, column: c || 1 });
        ed.revealLineInCenter(line);
        ed.focus();
      },
    },
  ];
}

export function quickOpen(prefix = '') {
  openPicker({ placeholder: '按名称搜索文件（输入 > 运行命令，: 跳转行，@ 跳转符号，? 帮助）', value: prefix, provider: quickProvider });
}

export function commandPalette() {
  quickOpen('>');
}

export function gotoLine() {
  quickOpen(':');
}
