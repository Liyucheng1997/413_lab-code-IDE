// 搜索视图：在整个工作区中查找 / 替换，支持大小写、全字匹配、正则、包含/排除。
import { ctx } from './state.js';
import { bus, path, escapeHtml, fileIcon, debounce, h } from './util.js';
import { icon } from './icons.js';
import { toast, confirm } from './ui.js';
import * as editors from './editors.js';

let view;
let els = {};
const opts = { matchCase: false, wholeWord: false, isRegex: false };
let lastResult = null;
const collapsed = new Set();
let seq = 0;

function currentOptions() {
  return { query: els.query.value, include: els.include.value, exclude: els.exclude.value, ...opts };
}

async function runSearch() {
  const my = ++seq;
  const o = currentOptions();
  if (!ctx.root) {
    els.summary.textContent = '请先打开文件夹';
    els.results.innerHTML = '';
    return;
  }
  if (!o.query) {
    lastResult = null;
    els.summary.textContent = '';
    els.results.innerHTML = '';
    return;
  }
  els.summary.innerHTML = '<span class="spinner" style="width:12px;height:12px;border-width:2px;display:inline-block;vertical-align:-2px"></span> 搜索中…';
  // 先保存未落盘的修改？不保存，只搜索磁盘内容；但提示
  const res = await window.ide.search.find(ctx.root, o);
  if (my !== seq) return;
  if (res.error) {
    els.summary.textContent = res.error;
    els.results.innerHTML = '';
    return;
  }
  lastResult = res;
  render();
}

function replacePreview(m) {
  const repl = els.replace.value;
  const before = m.preview.slice(0, m.previewOffset);
  const hit = m.preview.slice(m.previewOffset, m.previewOffset + m.length);
  const after = m.preview.slice(m.previewOffset + m.length);
  if (els.replaceRow.hidden || !repl && !els.replace.dataset.touched) return `${escapeHtml(before.trimStart())}<mark>${escapeHtml(hit)}</mark>${escapeHtml(after)}`;
  let newText = repl;
  if (opts.isRegex) {
    try {
      newText = hit.replace(new RegExp(els.query.value, opts.matchCase ? '' : 'i'), repl);
    } catch {}
  }
  return `${escapeHtml(before.trimStart())}<mark class="replace-old">${escapeHtml(hit)}</mark><mark class="replace-new">${escapeHtml(newText)}</mark>${escapeHtml(after)}`;
}

function render() {
  const res = lastResult;
  if (!res) return;
  const fileCount = res.results.length;
  els.summary.textContent = res.total ? `${fileCount} 个文件中有 ${res.total} 个结果${res.truncated ? '（结果过多，已截断）' : ''}` : '未找到结果';
  const frag = document.createDocumentFragment();
  for (const r of res.results) {
    const rel = path.relative(ctx.root, r.file);
    const isCol = collapsed.has(r.file);
    const fileRow = h(`<div class="search-file${isCol ? ' collapsed' : ''}">${icon('chevronDown')}${fileIcon(path.basename(r.file))}<span>${escapeHtml(path.basename(r.file))}</span><span class="muted">${escapeHtml(path.dirname(rel) === rel ? '' : path.dirname(rel))}</span>
      ${!els.replaceRow.hidden ? `<button class="icon-btn act" title="替换此文件中的全部" style="width:22px;height:22px">${icon('replaceAll')}</button>` : ''}
      <span class="count">${r.matches.length}</span></div>`);
    fileRow.onclick = (e) => {
      if (e.target.closest('.act')) return;
      isCol ? collapsed.delete(r.file) : collapsed.add(r.file);
      render();
    };
    const act = fileRow.querySelector('.act');
    if (act) act.onclick = () => replaceIn([r.file]);
    frag.appendChild(fileRow);
    if (isCol) continue;
    for (const m of r.matches) {
      const row = h(`<div class="search-match" title="${escapeHtml(m.preview)}"><span class="ln">${m.line}</span><span class="txt">${replacePreview(m)}</span></div>`);
      row.onclick = () => editors.openFile(r.file, { selection: { startLineNumber: m.line, startColumn: m.col, endLineNumber: m.line, endColumn: m.col + m.length }, preview: true });
      row.ondblclick = () => editors.openFile(r.file, { selection: { startLineNumber: m.line, startColumn: m.col, endLineNumber: m.line, endColumn: m.col + m.length }, pinned: true });
      frag.appendChild(row);
    }
  }
  els.results.innerHTML = '';
  els.results.appendChild(frag);
}

async function replaceIn(files) {
  if (!lastResult || !lastResult.total) return;
  const n = files ? lastResult.results.filter((r) => files.includes(r.file)).reduce((a, r) => a + r.matches.length, 0) : lastResult.total;
  const fileN = files ? files.length : lastResult.results.length;
  const ok = await confirm({ title: '全部替换', message: `将在 ${fileN} 个文件中把 ${n} 处“${els.query.value}”替换为“${els.replace.value}”。\n此操作会直接写入磁盘。`, buttons: ['替换', '取消'] });
  if (ok !== 0) return;
  // 有未保存修改的文件先保存，避免覆盖
  const targets = files || lastResult.results.map((r) => r.file);
  for (const f of targets) {
    const d = editors.getDoc(f);
    if (d && d.isDirty()) await editors.saveDoc(d);
  }
  const r = await window.ide.search.replace(ctx.root, currentOptions(), els.replace.value, files);
  toast(`已替换 ${r.count} 处`, 'success');
  await editors.onExternalChange(r.files);
  runSearch();
}

function toggleBtn(key, label, title) {
  const b = h(`<button class="toggle" title="${title}">${label}</button>`);
  b.onclick = () => {
    opts[key] = !opts[key];
    b.classList.toggle('on', opts[key]);
    runSearch();
  };
  return b;
}

export function focusSearch(text, replace = false) {
  bus.emit('view:show', 'search');
  if (text) els.query.value = text;
  if (replace) els.replaceRow.hidden = false;
  els.query.focus();
  els.query.select();
  if (text) runSearch();
}

export function initSearch() {
  view = document.querySelector('.view[data-view=search]');
  view.innerHTML = `
    <div class="view-header"><span class="view-title">搜索</span>
      <div class="view-actions">
        <button class="icon-btn" data-a="refresh" title="刷新">${icon('refresh')}</button>
        <button class="icon-btn" data-a="clear" title="清除结果">${icon('clear')}</button>
        <button class="icon-btn" data-a="collapse" title="全部折叠">${icon('collapse')}</button>
      </div></div>
    <div class="search-form">
      <div class="search-row"><button class="icon-btn" data-a="toggle-replace" title="切换替换">${icon('chevron')}</button>
        <div class="search-box"><input class="input" data-k="query" placeholder="搜索" spellcheck="false"><div class="toggles"></div></div></div>
      <div class="search-row" data-k="replaceRow" hidden><span style="width:28px"></span>
        <div class="search-box"><input class="input" data-k="replace" placeholder="替换" spellcheck="false" style="padding-right:12px"></div>
        <button class="icon-btn" data-a="replace-all" title="全部替换">${icon('replaceAll')}</button></div>
      <div class="search-details">
        <label>包含的文件</label><input class="input" data-k="include" placeholder="例如 *.ts, src/**" spellcheck="false">
        <label>排除的文件</label><input class="input" data-k="exclude" placeholder="例如 *.min.js, test/**" spellcheck="false">
      </div>
    </div>
    <div class="search-summary"></div>
    <div class="view-body search-results"></div>`;
  view.querySelectorAll('[data-k]').forEach((e) => (els[e.dataset.k] = e));
  els.summary = view.querySelector('.search-summary');
  els.results = view.querySelector('.search-results');
  const toggles = view.querySelector('.toggles');
  toggles.append(toggleBtn('matchCase', 'Aa', '区分大小写 (Alt+C)'), toggleBtn('wholeWord', 'ab', '全字匹配 (Alt+W)'), toggleBtn('isRegex', '.*', '使用正则表达式 (Alt+R)'));

  const debounced = debounce(runSearch, 300);
  els.query.addEventListener('input', debounced);
  els.include.addEventListener('input', debounced);
  els.exclude.addEventListener('input', debounced);
  els.query.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runSearch();
    if (e.altKey && ['c', 'w', 'r'].includes(e.key.toLowerCase())) {
      toggles.children[{ c: 0, w: 1, r: 2 }[e.key.toLowerCase()]].click();
      e.preventDefault();
    }
  });
  els.replace.addEventListener('input', () => {
    els.replace.dataset.touched = '1';
    render();
  });
  els.replace.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) replaceIn();
  });
  const toggleReplace = view.querySelector('[data-a=toggle-replace]');
  view.querySelector('[data-a=toggle-replace]').onclick = () => {
    els.replaceRow.hidden = !els.replaceRow.hidden;
    toggleReplace.querySelector('svg').style.transform = els.replaceRow.hidden ? '' : 'rotate(90deg)';
    render();
  };
  view.querySelector('[data-a=replace-all]').onclick = () => replaceIn();
  view.querySelector('[data-a=refresh]').onclick = runSearch;
  view.querySelector('[data-a=clear]').onclick = () => {
    els.query.value = '';
    runSearch();
  };
  view.querySelector('[data-a=collapse]').onclick = () => {
    if (lastResult) lastResult.results.forEach((r) => collapsed.add(r.file));
    render();
  };
  bus.on('search:in-folder', (rel) => {
    els.include.value = rel.replace(/\\/g, '/') + '/**';
    focusSearch();
  });
  bus.on('doc:saved', () => lastResult && debounced());
}
