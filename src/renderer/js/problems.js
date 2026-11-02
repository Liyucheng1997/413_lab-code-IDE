// 问题面板：汇总所有模型的诊断（Monaco 内置语言 + LSP），点击跳转。
import { ctx } from './state.js';
import { bus, path, escapeHtml, fileIcon, debounce, norm } from './util.js';
import { icon } from './icons.js';
import * as editors from './editors.js';
import { externalDiagnostics } from './lsp-client.js';

let el;
const collapsed = new Set();
export const counts = { errors: 0, warnings: 0, infos: 0 };

function collect() {
  const M = ctx.monaco.MarkerSeverity;
  const byFile = new Map();
  for (const m of ctx.monaco.editor.getModelMarkers({})) {
    if (m.severity < M.Info) continue;
    if (m.resource.scheme !== 'file' && m.resource.scheme !== 'untitled') continue;
    const p = m.resource.scheme === 'file' ? m.resource.fsPath : m.resource.toString();
    const key = norm(p);
    if (!byFile.has(key)) byFile.set(key, { path: p, markers: [] });
    byFile.get(key).markers.push(m);
  }
  for (const [key, v] of externalDiagnostics) if (!byFile.has(key)) byFile.set(key, { path: v.path, markers: v.markers.filter((m) => m.severity >= M.Info) });
  return byFile;
}

function render() {
  const M = ctx.monaco.MarkerSeverity;
  const byFile = collect();
  counts.errors = counts.warnings = counts.infos = 0;
  const summary = new Map();
  const files = [...byFile.values()].filter((f) => f.markers.length);
  files.sort((a, b) => a.path.localeCompare(b.path));
  let html = '';
  for (const f of files) {
    f.markers.sort((a, b) => b.severity - a.severity || a.startLineNumber - b.startLineNumber);
    let e = 0;
    let w = 0;
    for (const m of f.markers) {
      if (m.severity === M.Error) e++;
      else if (m.severity === M.Warning) w++;
      else counts.infos++;
    }
    counts.errors += e;
    counts.warnings += w;
    summary.set(norm(f.path), { errors: e, warnings: w });
    const key = norm(f.path);
    const isCollapsed = collapsed.has(key);
    const rel = ctx.root ? path.relative(ctx.root, path.dirname(f.path)) : path.dirname(f.path);
    html += `<div class="problem-file" data-file="${escapeHtml(key)}">${icon(isCollapsed ? 'chevron' : 'chevronDown')}${fileIcon(path.basename(f.path))}<span>${escapeHtml(path.basename(f.path))}</span><span class="muted">${escapeHtml(rel === path.dirname(f.path) ? rel : rel || '')}</span><span class="count">${f.markers.length}</span></div>`;
    if (isCollapsed) continue;
    for (const m of f.markers) {
      const sev = m.severity === M.Error ? 'error' : m.severity === M.Warning ? 'warning' : 'info';
      html += `<div class="problem" data-path="${escapeHtml(f.path)}" data-line="${m.startLineNumber}" data-col="${m.startColumn}"><span class="dot ${sev}"></span><span class="msg" title="${escapeHtml(m.message)}">${escapeHtml(m.message.split('\n')[0])}</span><span class="where">${escapeHtml(m.source || '')}${m.code ? `(${escapeHtml(typeof m.code === 'object' ? m.code.value : m.code)})` : ''} [${m.startLineNumber}, ${m.startColumn}]</span></div>`;
    }
  }
  el.innerHTML = files.length ? html : `<div class="empty">${icon('check')}<div>暂未发现问题</div></div>`;
  el.querySelectorAll('.problem').forEach((row) => {
    row.onclick = () => editors.openFile(row.dataset.path, { line: +row.dataset.line, column: +row.dataset.col, pinned: true });
  });
  el.querySelectorAll('.problem-file').forEach((row) => {
    row.onclick = () => {
      const k = row.dataset.file;
      collapsed.has(k) ? collapsed.delete(k) : collapsed.add(k);
      render();
    };
  });
  document.getElementById('problems-count').textContent = counts.errors + counts.warnings + counts.infos;
  bus.emit('problems:counts', counts);
  bus.emit('markers:changed', summary);
}

export function initProblems(container) {
  container.innerHTML = '<div class="problems-list"></div>';
  el = container.querySelector('.problems-list');
  const r = debounce(render, 250);
  ctx.monaco.editor.onDidChangeMarkers(r);
  bus.on('problems:external', r);
  render();
}

// F8 / Shift+F8：跳到下一个/上一个问题（跨文件）
export function nextProblem(dir = 1) {
  const ed = editors.activeEditor();
  if (ed) ed.trigger('lumen', dir > 0 ? 'editor.action.marker.nextInFiles' : 'editor.action.marker.prevInFiles', null);
}
