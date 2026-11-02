// 调试：断点（含条件断点、日志点）、调试会话、单步、变量/监视/调用堆栈、浮动工具栏、悬停求值。
import { ctx, saveState } from './state.js';
import { bus, path, escapeHtml, h, norm, debounce, languageForFile } from './util.js';
import { icon } from './icons.js';
import { toast, confirm, prompt, contextMenu } from './ui.js';
import { registerCommand, keyLabel } from './commands.js';
import * as editors from './editors.js';
import { newTerminal, runInTerminal, killTerminal } from './terminal.js';
import { appendOutput, appendResult, clearConsole, setEvaluator } from './debug-console.js';

// ---------------- 断点 ----------------
// norm(path) → { path, items: [{ line, condition, logMessage, enabled, verified }] }
const breakpoints = new Map();
const modelDecos = new Map(); // model → decoration ids
let exceptionFilters = null; // 用户选择的异常断点

function bpList(p) {
  const k = norm(p);
  if (!breakpoints.has(k)) breakpoints.set(k, { path: p, items: [] });
  return breakpoints.get(k).items;
}

function persist() {
  if (!ctx.root) return;
  const data = [...breakpoints.values()].filter((b) => b.items.length).map((b) => ({ path: b.path, items: b.items.map(({ line, condition, logMessage, enabled }) => ({ line, condition, logMessage, enabled })) }));
  saveState({ ['bps:' + ctx.root]: data, ['watch:' + ctx.root]: watches });
}

function modelForPath(p) {
  const d = editors.getDoc(p);
  return d && !d.model.isDisposed() ? d.model : null;
}

function decorate(model) {
  if (!model || model.isDisposed() || model.uri.scheme !== 'file') return;
  const entry = breakpoints.get(norm(model.uri.fsPath));
  const items = entry ? entry.items : [];
  const decos = items.map((b) => {
    let cls = 'bp-glyph';
    if (!b.enabled) cls += ' bp-disabled';
    else if (b.logMessage) cls += ' bp-log';
    else if (b.condition) cls += ' bp-cond';
    if (b.verified === false) cls += ' bp-unverified';
    const tip = b.logMessage ? `日志点：${b.logMessage}` : b.condition ? `条件断点：${b.condition}` : '断点';
    return {
      range: new ctx.monaco.Range(b.line, 1, b.line, 1),
      options: { glyphMarginClassName: cls, glyphMarginHoverMessage: { value: tip }, stickiness: ctx.monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges, overviewRuler: { color: '#ff3b3099', position: ctx.monaco.editor.OverviewRulerLane.Left } },
    };
  });
  modelDecos.set(model, model.deltaDecorations(modelDecos.get(model) || [], decos));
}

function decorateAllFor(p) {
  const m = modelForPath(p);
  if (m) decorate(m);
}

// 编辑后断点跟随行移动
function syncLinesFromModel(model) {
  const ids = modelDecos.get(model);
  const entry = breakpoints.get(norm(model.uri.fsPath));
  if (!ids || !entry) return;
  let changed = false;
  ids.forEach((id, i) => {
    const r = model.getDecorationRange(id);
    const b = entry.items[i];
    if (r && b && b.line !== r.startLineNumber) {
      b.line = r.startLineNumber;
      changed = true;
    }
  });
  if (changed) {
    // 合并移动后重叠的断点
    const seen = new Set();
    entry.items = entry.items.filter((b) => (seen.has(b.line) ? false : seen.add(b.line)));
    persist();
    renderSidebar();
    sendBreakpoints(entry.path);
  }
}

export function toggleBreakpoint(p, line, extra = {}) {
  const items = bpList(p);
  const i = items.findIndex((b) => b.line === line);
  if (i >= 0 && !extra.force) items.splice(i, 1);
  else if (i >= 0) Object.assign(items[i], extra.props);
  else items.push({ line, enabled: true, ...(extra.props || {}) });
  items.sort((a, b) => a.line - b.line);
  decorateAllFor(p);
  persist();
  renderSidebar();
  sendBreakpoints(p);
}

async function editBreakpoint(p, line, kind) {
  const items = bpList(p);
  const existing = items.find((b) => b.line === line);
  const isLog = kind === 'log';
  const v = await prompt({
    title: isLog ? '日志点' : '条件断点',
    message: isLog ? '命中时输出消息而不暂停，用 {表达式} 插入变量值，例如：x = {x}' : '表达式为真时才暂停，例如：i > 10',
    value: existing ? (isLog ? existing.logMessage : existing.condition) || '' : '',
    placeholder: isLog ? 'x = {x}' : 'i > 10',
  });
  if (v === null) return;
  const props = isLog ? { logMessage: v, condition: undefined, enabled: true } : { condition: v, logMessage: undefined, enabled: true };
  toggleBreakpoint(p, line, { force: true, props });
}

function setEnabled(p, line, enabled) {
  const b = bpList(p).find((x) => x.line === line);
  if (!b) return;
  b.enabled = enabled;
  decorateAllFor(p);
  persist();
  renderSidebar();
  sendBreakpoints(p);
}

export function removeAllBreakpoints() {
  const files = [...breakpoints.values()].map((b) => b.path);
  breakpoints.clear();
  for (const f of files) {
    decorateAllFor(f);
    sendBreakpoints(f);
  }
  persist();
  renderSidebar();
}

function dapBreakpoints(p) {
  return bpList(p)
    .filter((b) => b.enabled)
    .map((b) => ({ line: b.line, condition: b.condition || undefined, logMessage: b.logMessage || undefined }));
}

async function sendBreakpoints(p) {
  if (!session || session.ending) return;
  try {
    const r = await window.ide.dap.request(session.id, 'setBreakpoints', { source: { path: p, name: path.basename(p) }, breakpoints: dapBreakpoints(p), lines: dapBreakpoints(p).map((b) => b.line) });
    markVerified(p, r.breakpoints || []);
  } catch {}
}

function markVerified(p, results) {
  const enabled = bpList(p).filter((b) => b.enabled);
  enabled.forEach((b, i) => {
    const r = results[i];
    b.verified = r ? r.verified !== false : undefined;
  });
  decorateAllFor(p);
}

// ---------------- 会话 ----------------

let session = null; // { id, file, type, label, capabilities, status, threadId, frames, frameId }
let lastLaunch = null;
const lineDecos = new Map(); // model → ids（当前执行行）
let toolbar = null;

export function isDebugging() {
  return !!session;
}

export function isStopped() {
  return !!session && session.status === 'stopped';
}

export async function startDebugging(file, opts = {}) {
  if (session) {
    if (session.status === 'stopped') return cont();
    return toast('调试会话正在运行');
  }
  if (!file) {
    const t = editors.activeTab();
    if (!t || t.type !== 'file') return toast('请先打开要调试的文件', 'error');
    file = t.path;
  }
  let doc = editors.getDoc(file);
  if (doc && doc.untitled) {
    if (!(await editors.saveDoc(doc))) return;
    file = editors.activeTab().path;
    doc = editors.getDoc(file);
  }
  if (doc && doc.isDirty()) await editors.saveDoc(doc);

  lastLaunch = { file, opts };
  clearConsole();
  bus.emit('panel:show', 'debug');
  bus.emit('view:show', 'run');
  appendOutput(`正在启动调试：${path.basename(file)}\n`, 'console');
  session = { id: 0, file, status: 'starting', frames: [], threads: [] };
  renderAll();
  const bps = {};
  for (const b of breakpoints.values()) if (b.items.some((x) => x.enabled)) bps[b.path] = dapBreakpoints(b.path);
  const r = await window.ide.dap.start(file, { breakpoints: bps, stopOnEntry: !!opts.stopOnEntry });
  if (r.error) {
    session = null;
    renderAll();
    if (r.error === 'missing-debugpy') return offerDebugpy(r.python);
    if (r.error === 'compile') {
      appendOutput(r.output + '\n', 'stderr');
      return toast('编译失败，详情见调试控制台', 'error', 4000);
    }
    appendOutput(r.message + '\n', 'error');
    return toast(r.message, 'error', 5000);
  }
  session = { ...session, id: r.id, type: r.type, label: r.label, capabilities: r.capabilities || {}, status: session.status === 'stopped' ? 'stopped' : 'running' };
  if (pendingStop && pendingStop.id === r.id) {
    const ev = pendingStop;
    pendingStop = null;
    onStopped(ev.body);
  }
  if (r.type === 'python') bus.emit('panel:show', 'terminal');
  renderAll();
}

async function offerDebugpy(python) {
  const r = await confirm({ title: '需要安装 debugpy', message: `调试 Python 需要 debugpy 调试器，当前解释器还没有安装：\n${python}\n\n是否在终端中运行下面的命令安装？\n${python} -m pip install debugpy`, buttons: ['安装', '取消'] });
  if (r !== 0) return;
  const quoted = /\s/.test(python) ? `"${python}"` : python;
  const cmd = ctx.info.platform === 'win32' ? `& ${quoted} -m pip install debugpy` : `${quoted} -m pip install debugpy`;
  await runInTerminal(cmd, ctx.root);
  toast('安装完成后再按 F5 开始调试');
}

export async function stopDebugging() {
  if (!session) return;
  const id = session.id;
  session.ending = true;
  if (id) await window.ide.dap.stop(id);
  endSession();
}

export async function restartDebugging() {
  const last = lastLaunch;
  await stopDebugging();
  if (last) setTimeout(() => startDebugging(last.file, last.opts), 300);
}

function endSession() {
  if (!session) return;
  session = null;
  clearExecutionLine();
  for (const b of breakpoints.values()) b.items.forEach((x) => (x.verified = undefined));
  for (const b of breakpoints.values()) decorateAllFor(b.path);
  renderAll();
  bus.emit('debug:ended');
}

async function req(command, args) {
  if (!session || !session.id) throw new Error('没有正在进行的调试会话');
  return window.ide.dap.request(session.id, command, args);
}

function threadArgs() {
  return { threadId: session.threadId || 1 };
}

async function cont() {
  if (!isStopped()) return;
  await req('continue', threadArgs()).catch((e) => toast(e.message, 'error'));
  setRunning();
}
async function stepOver() {
  if (!isStopped()) return;
  await req('next', threadArgs()).catch((e) => toast(e.message, 'error'));
  setRunning();
}
async function stepIn() {
  if (!isStopped()) return;
  await req('stepIn', threadArgs()).catch((e) => toast(e.message, 'error'));
  setRunning();
}
async function stepOut() {
  if (!isStopped()) return;
  await req('stepOut', threadArgs()).catch((e) => toast(e.message, 'error'));
  setRunning();
}
async function pause() {
  if (!session || session.status !== 'running') return;
  await req('pause', threadArgs()).catch((e) => toast(e.message, 'error'));
}

function setRunning() {
  if (!session || session.status !== 'stopped') return;
  session.status = 'running';
  session.frames = [];
  clearExecutionLine();
  renderAll();
}

let pendingStop = null;
let debugTerm = null;

async function onStopped(body) {
  if (!session) return;
  session.status = 'stopped';
  session.threadId = body.threadId || session.threadId || 1;
  session.stopReason = body.reason;
  session.stopText = body.text || body.description;
  try {
    const t = await req('threads', {});
    session.threads = t.threads || [];
    if (!body.threadId && session.threads[0]) session.threadId = session.threads[0].id;
    const st = await req('stackTrace', { threadId: session.threadId, startFrame: 0, levels: 200 });
    session.frames = st.stackFrames || [];
  } catch (err) {
    session.frames = [];
  }
  const top = session.frames.find((f) => f.source && f.source.path) || session.frames[0];
  if (body.reason === 'exception') appendOutput(`已在异常处暂停${session.stopText ? '：' + session.stopText : ''}\n`, 'stderr');
  await selectFrame(top, true);
  window.focus();
}

async function selectFrame(frame, reveal = true) {
  if (!session) return;
  session.frameId = frame ? frame.id : undefined;
  session.scopes = [];
  if (frame) {
    try {
      session.scopes = (await req('scopes', { frameId: frame.id })).scopes || [];
    } catch {}
    if (reveal && frame.source && frame.source.path) {
      const isTop = frame === session.frames[0];
      await editors.openFile(frame.source.path, { line: frame.line, column: Math.max(1, frame.column || 1), pinned: true });
      showExecutionLine(frame.source.path, frame.line, isTop);
    }
  }
  await refreshWatches();
  renderAll();
}

function showExecutionLine(p, line, isTop) {
  clearExecutionLine();
  const model = modelForPath(p);
  if (!model) return;
  const ids = model.deltaDecorations([], [
    {
      range: new ctx.monaco.Range(line, 1, line, 1),
      options: { isWholeLine: true, className: isTop ? 'debug-line' : 'debug-frame-line', glyphMarginClassName: isTop ? 'debug-arrow' : 'debug-frame-arrow', stickiness: 1, overviewRuler: { color: '#ff9f0a', position: ctx.monaco.editor.OverviewRulerLane.Full } },
    },
  ]);
  lineDecos.set(model, ids);
}

function clearExecutionLine() {
  for (const [m, ids] of lineDecos) if (!m.isDisposed()) m.deltaDecorations(ids, []);
  lineDecos.clear();
}

async function evaluate(expression, context = 'repl') {
  const r = await req('evaluate', { expression, frameId: session && session.frameId, context });
  return r;
}

async function fetchVariables(ref) {
  const r = await req('variables', { variablesReference: ref });
  return r.variables || [];
}

// ---------------- 监视表达式 ----------------

let watches = [];
const watchValues = new Map();

async function refreshWatches() {
  watchValues.clear();
  if (!isStopped()) return;
  for (const w of watches) {
    try {
      const r = await evaluate(w, 'watch');
      watchValues.set(w, { value: r.result, ref: r.variablesReference || 0 });
    } catch (err) {
      watchValues.set(w, { error: err.message.split('\n')[0] });
    }
  }
}

async function addWatch(expr) {
  if (!expr) expr = await prompt({ title: '添加监视表达式', placeholder: '例如 user.name 或 len(items)' });
  if (!expr) return;
  watches.push(expr);
  persist();
  await refreshWatches();
  renderSidebar();
}

// ---------------- 侧栏渲染 ----------------

let sidebarEl = null;
const expanded = new Set(); // 变量树展开路径
let showInternalFrames = false;
const collapsedSections = new Set();

function section(key, title, actionsHtml = '') {
  const isCol = collapsedSections.has(key);
  const head = h(`<div class="section-title${isCol ? ' collapsed' : ''}">${icon('chevronDown')}<span>${title}</span><span class="dbg-sec-actions">${actionsHtml}</span></div>`);
  head.addEventListener('click', (e) => {
    if (e.target.closest('.dbg-sec-actions button')) return;
    collapsedSections.has(key) ? collapsedSections.delete(key) : collapsedSections.add(key);
    renderSidebar();
  });
  const body = h('<div class="dbg-sec-body"></div>');
  body.hidden = isCol;
  const wrap = document.createElement('div');
  wrap.append(head, body);
  return { wrap, head, body };
}

function valueClass(v) {
  if (/^-?\d/.test(v)) return 'dv-num';
  if (/^["'`b]/.test(v)) return 'dv-str';
  if (/^(true|false|True|False|None|null|undefined|nullptr)$/.test(v)) return 'dv-kw';
  return '';
}

async function renderVarTree(container, ref, depth, keyPrefix) {
  let vars;
  try {
    vars = await fetchVariables(ref);
  } catch (err) {
    container.appendChild(h(`<div class="dvar muted" style="padding-left:${12 + depth * 14}px">${escapeHtml(err.message)}</div>`));
    return;
  }
  if (!vars.length) container.appendChild(h(`<div class="dvar muted" style="padding-left:${12 + depth * 14}px">（空）</div>`));
  for (const v of vars.slice(0, 500)) {
    const key = keyPrefix + '/' + v.name;
    const open = expanded.has(key);
    const row = h(`<div class="dvar${v.variablesReference ? ' expandable' : ''}${open ? ' open' : ''}" style="padding-left:${12 + depth * 14}px" title="${escapeHtml(v.name + ' = ' + v.value)}">
      <span class="dvar-twisty">${v.variablesReference ? icon('chevron') : ''}</span><span class="dvar-name">${escapeHtml(v.name)}</span>${v.value ? `<span class="dvar-sep">=</span><span class="dvar-value ${valueClass(v.value)}">${escapeHtml(v.value)}</span>` : ''}</div>`);
    const kids = h('<div></div>');
    kids.hidden = !open;
    if (v.variablesReference) {
      row.addEventListener('click', async () => {
        if (expanded.has(key)) expanded.delete(key);
        else expanded.add(key);
        row.classList.toggle('open');
        kids.hidden = !kids.hidden;
        if (!kids.hidden && !kids.childElementCount) await renderVarTree(kids, v.variablesReference, depth + 1, key);
      });
      if (open) renderVarTree(kids, v.variablesReference, depth + 1, key);
    }
    row.addEventListener('contextmenu', (e) =>
      contextMenu(e, [
        { label: '复制值', action: () => navigator.clipboard.writeText(v.value) },
        { label: '复制名称', action: () => navigator.clipboard.writeText(v.name) },
        { label: '添加到监视', action: () => addWatch(v.evaluateName || v.name) },
      ]),
    );
    container.append(row, kids);
  }
}

function renderSidebar() {
  if (!sidebarEl) return;
  sidebarEl.innerHTML = '';
  if (session) {
    // 变量
    const vars = section('vars', '变量');
    if (!isStopped()) vars.body.appendChild(h(`<div class="dbg-empty">${session.status === 'starting' ? '正在启动…' : '程序运行中，命中断点或暂停后显示变量'}</div>`));
    else if (!session.scopes || !session.scopes.length) vars.body.appendChild(h('<div class="dbg-empty">当前栈帧没有可显示的变量</div>'));
    else
      for (const sc of session.scopes) {
        const key = 'scope:' + sc.name;
        // 全局、寄存器这类内容多的作用域默认折叠
        const lazy = sc.expensive || sc.presentationHint === 'registers' || /register|寄存器|global|全局/i.test(sc.name);
        const open = lazy ? expanded.has(key) : !expanded.has('closed:' + key);
        const row = h(`<div class="dvar expandable scope${open ? ' open' : ''}" style="padding-left:12px"><span class="dvar-twisty">${icon('chevron')}</span><span class="dvar-scope">${escapeHtml(sc.name)}</span></div>`);
        const kids = h('<div></div>');
        kids.hidden = !open;
        row.addEventListener('click', async () => {
          const nowOpen = kids.hidden;
          if (lazy) nowOpen ? expanded.add(key) : expanded.delete(key);
          else nowOpen ? expanded.delete('closed:' + key) : expanded.add('closed:' + key);
          row.classList.toggle('open', nowOpen);
          kids.hidden = !nowOpen;
          if (nowOpen && !kids.childElementCount) await renderVarTree(kids, sc.variablesReference, 1, key);
        });
        if (open) renderVarTree(kids, sc.variablesReference, 1, key);
        vars.body.append(row, kids);
      }
    sidebarEl.appendChild(vars.wrap);

    // 监视
    const w = section('watch', '监视', `<button class="icon-btn" title="添加表达式">${icon('plus')}</button>`);
    w.head.querySelector('button').onclick = () => addWatch();
    renderWatches(w.body);
    sidebarEl.appendChild(w.wrap);

    // 调用堆栈
    const cs = section('stack', '调用堆栈');
    if (!isStopped()) cs.body.appendChild(h(`<div class="dbg-empty">${session.status === 'starting' ? '正在启动…' : '运行中'}</div>`));
    else {
      if ((session.threads || []).length > 1) cs.body.appendChild(h(`<div class="dbg-thread">${escapeHtml((session.threads.find((t) => t.id === session.threadId) || {}).name || '线程 ' + session.threadId)} · 已暂停</div>`));
      // 连续的内部帧（Node 内部、系统库）折叠成一行
      let hiddenRun = [];
      const flushHidden = () => {
        if (!hiddenRun.length) return;
        const run = hiddenRun;
        hiddenRun = [];
        const row = h(`<div class="dframe subtle more">显示 ${run.length} 个内部栈帧</div>`);
        row.onclick = () => {
          showInternalFrames = true;
          renderSidebar();
        };
        cs.body.appendChild(row);
      };
      for (const f of session.frames) {
        const src = f.source || {};
        if (!showInternalFrames && !src.path && f !== session.frames[0]) {
          hiddenRun.push(f);
          continue;
        }
        flushHidden();
        const row = h(`<div class="dframe${f.id === session.frameId ? ' active' : ''}${src.path ? '' : ' subtle'}"><span class="dframe-name">${escapeHtml(f.name)}</span><span class="dframe-loc">${escapeHtml(src.name || (src.path ? path.basename(src.path) : ''))}${f.line ? ':' + f.line : ''}</span></div>`);
        row.onclick = () => selectFrame(f, true).then(() => {
          if (f.source && f.source.path) showExecutionLine(f.source.path, f.line, f === session.frames[0]);
        });
        cs.body.appendChild(row);
      }
      flushHidden();
    }
    sidebarEl.appendChild(cs.wrap);
  } else if (watches.length) {
    const w = section('watch', '监视', `<button class="icon-btn" title="添加表达式">${icon('plus')}</button>`);
    w.head.querySelector('button').onclick = () => addWatch();
    renderWatches(w.body);
    sidebarEl.appendChild(w.wrap);
  }

  // 断点
  const total = [...breakpoints.values()].reduce((n, b) => n + b.items.length, 0);
  const bp = section('bps', `断点${total ? ` <span class="count">${total}</span>` : ''}`, `<button class="icon-btn" title="删除所有断点">${icon('trash')}</button>`);
  bp.head.querySelector('button').onclick = removeAllBreakpoints;
  if (session && session.capabilities && (session.capabilities.exceptionBreakpointFilters || []).length) {
    const active = exceptionFilters || session.capabilities.exceptionBreakpointFilters.filter((f) => f.default).map((f) => f.filter);
    // gdb 会报告 Ada 专用的过滤器，对 C/C++ 没有意义
    for (const f of session.capabilities.exceptionBreakpointFilters.filter((x) => !x.label.startsWith('Ada ')).slice(0, 4)) {
      const row = h(`<label class="dbp"><input type="checkbox" ${active.includes(f.filter) ? 'checked' : ''}><span>${escapeHtml(f.label)}</span></label>`);
      row.querySelector('input').onchange = (e) => {
        const set = new Set(active);
        e.target.checked ? set.add(f.filter) : set.delete(f.filter);
        exceptionFilters = [...set];
        req('setExceptionBreakpoints', { filters: exceptionFilters }).catch(() => {});
      };
      bp.body.appendChild(row);
    }
  }
  if (!total) bp.body.appendChild(h(`<div class="dbg-empty">点击编辑器行号左侧添加断点（F9）</div>`));
  for (const b of breakpoints.values()) {
    for (const item of b.items) {
      const rel = ctx.root ? path.relative(ctx.root, b.path) : b.path;
      const row = h(`<label class="dbp${item.verified === false ? ' unverified' : ''}" title="${escapeHtml(b.path)}:${item.line}"><input type="checkbox" ${item.enabled ? 'checked' : ''}><span class="dbp-dot ${item.logMessage ? 'log' : item.condition ? 'cond' : ''}"></span><span class="dbp-name">${escapeHtml(path.basename(b.path))}</span><span class="dbp-line tabular">${item.line}</span><span class="dbp-desc">${escapeHtml(item.logMessage ? '日志：' + item.logMessage : item.condition ? '条件：' + item.condition : path.dirname(rel) === rel ? '' : path.dirname(rel))}</span><button class="icon-btn" title="删除">${icon('close')}</button></label>`);
      row.querySelector('input').onchange = (e) => setEnabled(b.path, item.line, e.target.checked);
      row.querySelector('button').onclick = (e) => {
        e.preventDefault();
        toggleBreakpoint(b.path, item.line);
      };
      row.addEventListener('dblclick', () => editors.openFile(b.path, { line: item.line, pinned: true }));
      row.querySelector('.dbp-name').addEventListener('click', (e) => {
        e.preventDefault();
        editors.openFile(b.path, { line: item.line, pinned: true });
      });
      row.addEventListener('contextmenu', (e) =>
        contextMenu(e, [
          { label: '编辑条件…', action: () => editBreakpoint(b.path, item.line, 'cond') },
          { label: '编辑日志消息…', action: () => editBreakpoint(b.path, item.line, 'log') },
          { label: item.enabled ? '禁用' : '启用', action: () => setEnabled(b.path, item.line, !item.enabled) },
          { type: 'sep' },
          { label: '删除', action: () => toggleBreakpoint(b.path, item.line) },
          { label: '删除所有断点', action: removeAllBreakpoints },
        ]),
      );
      bp.body.appendChild(row);
    }
  }
  sidebarEl.appendChild(bp.wrap);
}

function renderWatches(container) {
  if (!watches.length) container.appendChild(h('<div class="dbg-empty">点击 + 添加要监视的表达式</div>'));
  watches.forEach((w, i) => {
    const v = watchValues.get(w);
    const text = !isStopped() ? '（暂停后求值）' : !v ? '…' : v.error ? v.error : v.value;
    const row = h(`<div class="dvar${v && v.ref ? ' expandable' : ''}" style="padding-left:12px" title="${escapeHtml(w)}"><span class="dvar-twisty">${v && v.ref ? icon('chevron') : ''}</span><span class="dvar-name">${escapeHtml(w)}</span><span class="dvar-sep">=</span><span class="dvar-value ${v && v.error ? 'dv-err' : valueClass(text)}">${escapeHtml(text)}</span><button class="icon-btn dvar-del" title="删除">${icon('close')}</button></div>`);
    const kids = h('<div hidden></div>');
    row.querySelector('.dvar-del').onclick = (e) => {
      e.stopPropagation();
      watches.splice(i, 1);
      persist();
      renderSidebar();
    };
    if (v && v.ref) {
      row.addEventListener('click', async () => {
        kids.hidden = !kids.hidden;
        row.classList.toggle('open', !kids.hidden);
        if (!kids.hidden && !kids.childElementCount) await renderVarTree(kids, v.ref, 1, 'watch:' + w);
      });
    }
    row.addEventListener('dblclick', async () => {
      const nv = await prompt({ title: '编辑监视表达式', value: w });
      if (nv) {
        watches[i] = nv;
        persist();
        await refreshWatches();
        renderSidebar();
      }
    });
    container.append(row, kids);
  });
}

// ---------------- 浮动工具栏 ----------------

function renderToolbar() {
  if (!toolbar) {
    toolbar = h('<div class="debug-toolbar" hidden></div>');
    document.body.appendChild(toolbar);
  }
  if (!session) {
    toolbar.hidden = true;
    return;
  }
  toolbar.hidden = false;
  const stopped = isStopped();
  const btn = (ic, title, fn, enabled = true, cls = '') => {
    const b = h(`<button class="icon-btn ${cls}" title="${title}" ${enabled ? '' : 'disabled'}>${icon(ic)}</button>`);
    b.onclick = fn;
    return b;
  };
  toolbar.innerHTML = '';
  toolbar.append(
    h(`<span class="dt-status"><span class="dot ${stopped ? 'warning' : session.status === 'starting' ? 'info' : 'success'}"></span>${stopped ? '已暂停' : session.status === 'starting' ? '启动中' : '运行中'}</span>`),
    stopped ? btn('play', `继续 (${keyLabel('F5')})`, cont) : btn('pause', `暂停 (${keyLabel('F6')})`, pause, session.status === 'running'),
    btn('stepOver', `单步跳过 (${keyLabel('F10')})`, stepOver, stopped),
    btn('stepInto', `单步调试 (${keyLabel('F11')})`, stepIn, stopped),
    btn('stepOut', `单步跳出 (${keyLabel('Shift+F11')})`, stepOut, stopped),
    btn('refresh', `重启 (${keyLabel('Ctrl+Shift+F5')})`, restartDebugging),
    btn('stop', `停止 (${keyLabel('Shift+F5')})`, stopDebugging, true, 'danger'),
  );
}

function renderAll() {
  document.body.classList.toggle('debugging', !!session);
  renderToolbar();
  renderSidebar();
  bus.emit('debug:changed', session);
}

// ---------------- 悬停求值 ----------------

function hoverExpression(model, position) {
  const line = model.getLineContent(position.lineNumber);
  const re = /[A-Za-z_$][\w$]*(?:(?:\.|->)[A-Za-z_$][\w$]*|\[\d+\])*/g;
  let m;
  while ((m = re.exec(line))) {
    const start = m.index + 1;
    const end = start + m[0].length;
    if (position.column >= start && position.column <= end) {
      // 截到鼠标所在的那一段为止
      const word = model.getWordAtPosition(position);
      let exprEnd = end;
      if (word) exprEnd = Math.min(end, word.endColumn);
      const expr = line.slice(start - 1, exprEnd - 1).replace(/(\.|->)$/, '');
      return { expr, range: new ctx.monaco.Range(position.lineNumber, start, position.lineNumber, exprEnd) };
    }
  }
  return null;
}

const KEYWORDS = new Set(['if', 'else', 'for', 'while', 'return', 'def', 'class', 'function', 'const', 'let', 'var', 'import', 'from', 'int', 'void', 'char', 'float', 'double', 'include', 'in', 'not', 'and', 'or', 'new', 'struct', 'printf', 'print']);

function registerHover() {
  ctx.monaco.languages.registerHoverProvider('*', {
    async provideHover(model, position) {
      if (!isStopped()) return null;
      const he = hoverExpression(model, position);
      if (!he || KEYWORDS.has(he.expr)) return null;
      try {
        const r = await evaluate(he.expr, 'hover');
        if (!r || r.result === undefined || r.result === '') return null;
        return { range: he.range, contents: [{ value: '```\n' + he.expr + ' = ' + String(r.result).slice(0, 2000) + '\n```' }] };
      } catch {
        return null;
      }
    },
  });
}

// ---------------- 编辑器集成 ----------------

function attachEditor(editor) {
  const monaco = ctx.monaco;
  const GLYPH = monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN;
  const LINE_NUMBERS = monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS;
  const hoverDeco = editor.createDecorationsCollection();
  editor.onMouseMove((e) => {
    const model = editor.getModel();
    if (e.target.type === GLYPH && model && model.uri.scheme === 'file') {
      const line = e.target.position.lineNumber;
      const has = bpList(model.uri.fsPath).some((b) => b.line === line);
      hoverDeco.set(has ? [] : [{ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: 'bp-hint' } }]);
    } else hoverDeco.clear();
  });
  editor.onMouseLeave(() => hoverDeco.clear());
  editor.onMouseDown((e) => {
    const model = editor.getModel();
    if (!model || model.uri.scheme !== 'file' || !e.target.position) return;
    if (e.target.type !== GLYPH && !(e.target.type === LINE_NUMBERS && e.event.altKey)) return;
    const p = editors.getDoc(model.uri.fsPath) ? editors.getDoc(model.uri.fsPath).path : model.uri.fsPath;
    const line = e.target.position.lineNumber;
    if (e.event.rightButton) {
      const has = bpList(p).find((b) => b.line === line);
      const ev = e.event.browserEvent;
      setTimeout(() =>
        contextMenu(ev, [
          has ? { label: '删除断点', action: () => toggleBreakpoint(p, line) } : { label: '添加断点', action: () => toggleBreakpoint(p, line) },
          { label: has && has.condition ? '编辑条件断点…' : '添加条件断点…', action: () => editBreakpoint(p, line, 'cond') },
          { label: has && has.logMessage ? '编辑日志点…' : '添加日志点…', action: () => editBreakpoint(p, line, 'log') },
          has && { label: has.enabled ? '禁用断点' : '启用断点', action: () => setEnabled(p, line, !has.enabled) },
        ]),
      );
      return;
    }
    toggleBreakpoint(p, line);
    hoverDeco.clear();
  });
}

export function toggleBreakpointAtCursor() {
  const ed = editors.activeEditor();
  const t = editors.activeTab();
  if (!ed || !t || t.type !== 'file' || t.path.startsWith('untitled:')) return;
  toggleBreakpoint(t.path, ed.getPosition().lineNumber);
}

export function setDebugSidebar(el) {
  sidebarEl = el;
  renderSidebar();
}

export async function loadWorkspaceBreakpoints() {
  breakpoints.clear();
  watches = [];
  if (!ctx.root) return renderSidebar();
  const st = await window.ide.state.get();
  for (const b of st['bps:' + ctx.root] || []) breakpoints.set(norm(b.path), { path: b.path, items: b.items.map((x) => ({ ...x, enabled: x.enabled !== false })) });
  watches = st['watch:' + ctx.root] || [];
  for (const m of ctx.monaco.editor.getModels()) decorate(m);
  renderSidebar();
}

// 运行到光标处：临时断点 + 继续
async function runToCursor() {
  const ed = editors.activeEditor();
  const t = editors.activeTab();
  if (!ed || !t || !isStopped()) return;
  const line = ed.getPosition().lineNumber;
  const had = bpList(t.path).some((b) => b.line === line);
  if (!had) toggleBreakpoint(t.path, line);
  await cont();
  if (!had) {
    const off = bus.on('debug:changed', (s) => {
      if (!s || s.status === 'stopped') {
        off();
        if (bpList(t.path).some((b) => b.line === line)) toggleBreakpoint(t.path, line);
      }
    });
  }
}

function addSelectionToWatch() {
  const ed = editors.activeEditor();
  if (!ed) return;
  const sel = ed.getSelection();
  const text = sel.isEmpty() ? (ed.getModel().getWordAtPosition(sel.getPosition()) || {}).word : ed.getModel().getValueInRange(sel);
  if (text) addWatch(text.trim());
}

export function initDebug() {
  setEvaluator(
    async (expr) => {
      if (!session || !session.id) throw new Error('没有正在进行的调试会话');
      return evaluate(expr, 'repl');
    },
    (container, ref) => renderVarTree(container, ref, 0, 'repl:' + ref),
  );

  window.ide.dap.onEvent(async ({ id, event, body }) => {
    if (event === 'output') {
      if (id !== 0 && (!session || session.id !== id)) return;
      if (body.category === 'telemetry') return;
      appendOutput(body.output, body.category === 'stderr' ? 'stderr' : body.category === 'console' || body.category === 'important' ? 'console' : 'stdout');
      return;
    }
    if (!session) return;
    if (session.id === 0 && event === 'stopped') {
      // 启动请求尚未返回时就命中了断点
      pendingStop = { id, body };
      return;
    }
    if (session.id !== id) return;
    switch (event) {
      case 'stopped':
        await onStopped(body);
        break;
      case 'continued':
        setRunning();
        break;
      case 'exited':
        appendOutput(`\n程序已退出，退出码 ${body.exitCode}\n`, 'console');
        break;
      case 'terminated':
      case 'lumen.ended':
        if (session && session.id === id) {
          appendOutput('调试会话已结束\n', 'console');
          endSession();
        }
        break;
      case 'lumen.breakpointsSet':
        markVerified(body.file, body.breakpoints);
        break;
    }
  });

  // debugpy 请求在终端里启动被调试程序（这样 input() 可以交互）
  window.ide.dap.onReverse(async ({ id, seq, command, arguments: a }) => {
    if (command !== 'runInTerminal') return;
    // 每次调试换一个干净的终端，不让旧的调试终端越积越多
    if (debugTerm && !debugTerm.exited) killTerminal(debugTerm);
    const t = newTerminal({ cwd: a.cwd, name: '调试', fixedName: true });
    debugTerm = t;
    await t.ready;
    const ps = /powershell|pwsh/i.test(t.shell || '');
    const isCmd = /cmd/i.test(t.shell || '');
    const q = (s) => (ps ? `'${String(s).replace(/'/g, "''")}'` : isCmd ? `"${s}"` : `'${String(s).replace(/'/g, "'\\''")}'`);
    const env = Object.entries(a.env || {}).filter(([, v]) => v !== null && v !== undefined);
    let cmd;
    if (ps) cmd = env.map(([k, v]) => `$env:${k}=${q(v)}; `).join('') + '& ' + a.args.map(q).join(' ');
    else if (isCmd) cmd = env.map(([k, v]) => `set "${k}=${v}" && `).join('') + a.args.map(q).join(' ');
    else cmd = env.map(([k, v]) => `${k}=${q(v)} `).join('') + a.args.map(q).join(' ');
    t.sendText((ps ? 'cls; ' : isCmd ? 'cls && ' : 'clear; ') + cmd);
    window.ide.dap.respondReverse(id, seq, command, {});
  });

  bus.on('editor:created', (editor) => attachEditor(editor));
  for (const g of editors.allGroups()) attachEditor(g.editor);
  bus.on('doc:opened', (doc) => {
    decorate(doc.model);
    doc.model.onDidChangeContent(debounce(() => syncLinesFromModel(doc.model), 300));
  });
  bus.on('workspace:opened', loadWorkspaceBreakpoints);
  registerHover();

  const C = (id, title, key, run, extra = {}) => registerCommand({ id, title, category: '调试', key, run, ...extra });
  C('debug.start', '开始调试', 'F5', () => (isStopped() ? cont() : startDebugging()));
  C('debug.startStopOnEntry', '开始调试并在入口处暂停', null, () => startDebugging(null, { stopOnEntry: true }));
  C('debug.stop', '停止调试', 'Shift+F5', () => (session ? stopDebugging() : bus.emit('cmd', 'run.stop')));
  C('debug.restart', '重启调试', 'Ctrl+Shift+F5', restartDebugging);
  C('debug.continue', '继续', null, cont);
  C('debug.pause', '暂停', 'F6', pause, { when: () => isDebugging() });
  C('debug.stepOver', '单步跳过', 'F10', stepOver, { when: () => isDebugging() });
  C('debug.stepInto', '单步调试', 'F11', stepIn, { when: () => isDebugging() });
  C('debug.stepOut', '单步跳出', 'Shift+F11', stepOut, { when: () => isDebugging() });
  C('debug.runToCursor', '运行到光标处', null, runToCursor);
  C('debug.toggleBreakpoint', '切换断点', 'F9', toggleBreakpointAtCursor);
  C('debug.conditionalBreakpoint', '添加条件断点…', null, () => {
    const ed = editors.activeEditor();
    const t = editors.activeTab();
    if (ed && t && t.type === 'file') editBreakpoint(t.path, ed.getPosition().lineNumber, 'cond');
  });
  C('debug.logpoint', '添加日志点…', null, () => {
    const ed = editors.activeEditor();
    const t = editors.activeTab();
    if (ed && t && t.type === 'file') editBreakpoint(t.path, ed.getPosition().lineNumber, 'log');
  });
  C('debug.removeAllBreakpoints', '删除所有断点', null, removeAllBreakpoints);
  C('debug.addWatch', '添加到监视', null, addSelectionToWatch);
  C('debug.console', '调试控制台', 'Ctrl+Shift+Y', () => bus.emit('panel:show', 'debug'));
  renderAll();
}

export function debugSupported(file) {
  return ['python', 'javascript', 'c', 'cpp'].includes(languageForFile(file)) && !/\.(jsx|tsx?)$/i.test(file);
}
