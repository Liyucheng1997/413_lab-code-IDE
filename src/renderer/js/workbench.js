// 工作台：布局（侧栏/面板/拖拽调整）、菜单栏、主题、欢迎页、工作区打开与关闭、全部命令注册。
import { ctx, saveState, flushState, updateSettings, reloadSettings } from './state.js';
import { bus, path, escapeHtml, h } from './util.js';
import { icon } from './icons.js';
import { showMenu, closeMenus, confirm, toast, modal } from './ui.js';
import { registerCommand, runCommand, getCommand, keyLabel } from './commands.js';
import * as editors from './editors.js';
import * as explorer from './explorer.js';
import { refreshGit, switchBranch, syncNow, fetchNow, pullNow, pushNow, openManager } from './git-view.js';
import { focusSearch } from './search-view.js';
import { quickOpen, commandPalette, gotoLine, openPicker } from './palette.js';
import { newTerminal, killTerminal, clearTerminal, focusTerminal, terminalActions, activeTerminal } from './terminal.js';
import { outputActions } from './output.js';
import { runFile, stopRun } from './run-view.js';
import { openSettings } from './settings-view.js';
import { pickLanguage } from './statusbar.js';
import * as lsp from './lsp-client.js';
import { nextProblem } from './problems.js';

let activeView = 'explorer';
let activePanel = 'terminal';
let recent = [];
const closedTabs = [];

// ---------------- 主题 ----------------

export async function applyTheme() {
  const t = ctx.settings.theme;
  ctx.isDark = t === 'dark' || (t === 'system' && (await window.ide.theme.isDark()));
  document.documentElement.dataset.theme = ctx.isDark ? 'dark' : 'light';
  window.ide.app.setTitleColors(ctx.isDark ? { bg: '#000000', symbol: '#f5f5f7' } : { bg: '#f5f5f7', symbol: '#1d1d1f' });
  const btn = document.getElementById('theme-toggle');
  btn.innerHTML = icon(ctx.isDark ? 'sun' : 'moon');
  bus.emit('theme:changed');
}

function toggleTheme() {
  updateSettings({ theme: ctx.isDark ? 'light' : 'dark' });
}

// ---------------- 布局 ----------------

export function showView(name, { toggle = false } = {}) {
  const sidebarHidden = document.body.classList.contains('sidebar-hidden');
  if (toggle && name === activeView && !sidebarHidden) {
    document.body.classList.add('sidebar-hidden');
    saveState({ sidebarHidden: true });
    return;
  }
  activeView = name;
  document.body.classList.remove('sidebar-hidden');
  document.querySelectorAll('#sidebar .view').forEach((v) => (v.hidden = v.dataset.view !== name));
  document.querySelectorAll('.activity[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  saveState({ activeView: name, sidebarHidden: false });
  bus.emit('view:shown', name);
}

function toggleSidebar() {
  const hidden = document.body.classList.toggle('sidebar-hidden');
  saveState({ sidebarHidden: hidden });
  if (!hidden) showView(activeView);
}

export function showPanel(name) {
  activePanel = name;
  document.body.classList.remove('panel-hidden');
  document.querySelectorAll('#panel-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.panel === name));
  document.querySelectorAll('.panel-view').forEach((v) => (v.hidden = v.dataset.panel !== name));
  renderPanelActions();
  saveState({ panelHidden: false, activePanel: name });
  if (name === 'terminal') requestAnimationFrame(() => focusTerminal());
  if (name === 'debug') requestAnimationFrame(() => import('./debug-console.js').then((m) => m.focusConsoleInput()));
  bus.emit('panel:resized');
}

function togglePanel() {
  const hidden = document.body.classList.toggle('panel-hidden');
  saveState({ panelHidden: hidden });
  if (!hidden) showPanel(activePanel);
  else {
    const ed = editors.activeEditor();
    if (ed) ed.focus();
  }
}

let outputBar = null;
function renderPanelActions() {
  const box = document.getElementById('panel-actions');
  box.innerHTML = '';
  const btn = (ic, title, fn) => {
    const b = h(`<button class="icon-btn" title="${title}">${icon(ic)}</button>`);
    b.onclick = fn;
    box.appendChild(b);
  };
  if (activePanel === 'terminal') for (const a of terminalActions()) btn(a.icon, a.title, a.run);
  if (activePanel === 'debug') btn('clear', '清除调试控制台', () => import('./debug-console.js').then((m) => m.clearConsole()));
  if (activePanel === 'output') {
    if (!outputBar) outputBar = outputActions();
    box.appendChild(outputBar.el);
    btn('clear', '清除输出', outputBar.clear);
  }
  const panel = document.getElementById('panel');
  btn(panel.classList.contains('maximized') ? 'restore' : 'maximize', '最大化/还原面板', toggleMaximizePanel);
  btn('close', '关闭面板 (Ctrl+J)', togglePanel);
}

let panelHeightBeforeMax = null;
function toggleMaximizePanel() {
  const panel = document.getElementById('panel');
  if (panel.classList.toggle('maximized')) {
    panelHeightBeforeMax = panel.offsetHeight;
    panel.style.height = document.getElementById('main').offsetHeight - 120 + 'px';
  } else panel.style.height = (panelHeightBeforeMax || 260) + 'px';
  renderPanelActions();
  bus.emit('panel:resized');
}

function setupSashes(state) {
  const sidebar = document.getElementById('sidebar');
  const panel = document.getElementById('panel');
  if (state.sidebarWidth) sidebar.style.width = state.sidebarWidth + 'px';
  if (state.panelHeight) panel.style.height = state.panelHeight + 'px';
  const drag = (sash, horizontal, onMove, onEnd) => {
    sash.addEventListener('mousedown', (e) => {
      e.preventDefault();
      sash.classList.add('dragging');
      document.body.classList.add('resizing');
      if (horizontal) document.body.classList.add('resizing-h');
      const move = (ev) => onMove(ev);
      const up = () => {
        sash.classList.remove('dragging');
        document.body.classList.remove('resizing', 'resizing-h');
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        onEnd();
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  };
  drag(
    document.getElementById('sash-sidebar'),
    false,
    (e) => {
      const left = sidebar.getBoundingClientRect().left;
      const w = Math.max(170, Math.min(window.innerWidth - 400, e.clientX - left));
      sidebar.style.width = w + 'px';
    },
    () => saveState({ sidebarWidth: sidebar.offsetWidth }),
  );
  drag(
    document.getElementById('sash-panel'),
    true,
    (e) => {
      const bottom = panel.getBoundingClientRect().bottom;
      const hgt = Math.max(90, Math.min(document.getElementById('main').offsetHeight - 100, bottom - e.clientY));
      panel.style.height = hgt + 'px';
      bus.emit('panel:resized');
    },
    () => saveState({ panelHeight: panel.offsetHeight }),
  );
  document.getElementById('sash-sidebar').addEventListener('dblclick', () => {
    sidebar.style.width = '272px';
    saveState({ sidebarWidth: 272 });
  });
}

// ---------------- 菜单栏 ----------------

function cmdItem(id, label) {
  const c = getCommand(id);
  return { label: label || (c && c.title) || id, shortcut: c && c.key ? keyLabel(c.key) : c && c.hint, action: () => runCommand(id) };
}

const edAction = (id) => () => {
  const ed = editors.activeEditor();
  if (!ed) return;
  ed.focus();
  ed.trigger('menu', id, null);
};

function menus() {
  const recentItems = recent.length ? recent.slice(0, 10).map((p) => ({ label: p, action: () => openFolder(p) })) : [{ label: '（无）', disabled: true }];
  return [
    ['文件', [
      cmdItem('file.new'),
      cmdItem('explorer.newFile'),
      cmdItem('explorer.newFolder'),
      { type: 'sep' },
      cmdItem('file.open'),
      cmdItem('workbench.openFolder'),
      { label: '打开最近的文件夹', submenu: recentItems },
      cmdItem('git.clone'),
      { type: 'sep' },
      cmdItem('file.save'),
      cmdItem('file.saveAs'),
      cmdItem('file.saveAll'),
      { label: '自动保存', checked: ctx.settings.autoSave !== 'off', action: () => updateSettings({ autoSave: ctx.settings.autoSave === 'off' ? 'afterDelay' : 'off' }) },
      { type: 'sep' },
      cmdItem('workbench.settings'),
      { type: 'sep' },
      cmdItem('editor.close'),
      cmdItem('editor.closeAll'),
      cmdItem('workbench.closeFolder'),
      { type: 'sep' },
      cmdItem('app.quit'),
    ]],
    ['编辑', [
      { label: '撤销', shortcut: 'Ctrl+Z', action: edAction('undo') },
      { label: '重做', shortcut: 'Ctrl+Y', action: edAction('redo') },
      { type: 'sep' },
      { label: '剪切', shortcut: 'Ctrl+X', action: edAction('editor.action.clipboardCutAction') },
      { label: '复制', shortcut: 'Ctrl+C', action: edAction('editor.action.clipboardCopyAction') },
      { label: '粘贴', shortcut: 'Ctrl+V', action: edAction('editor.action.clipboardPasteAction') },
      { type: 'sep' },
      { label: '查找', shortcut: 'Ctrl+F', action: edAction('actions.find') },
      { label: '替换', shortcut: 'Ctrl+H', action: edAction('editor.action.startFindReplaceAction') },
      cmdItem('search.find'),
      cmdItem('search.replace'),
      { type: 'sep' },
      { label: '切换行注释', shortcut: 'Ctrl+/', action: edAction('editor.action.commentLine') },
      { label: '切换块注释', shortcut: 'Shift+Alt+A', action: edAction('editor.action.blockComment') },
      { label: '格式化文档', shortcut: 'Shift+Alt+F', action: edAction('editor.action.formatDocument') },
      { label: '格式化选中内容', action: edAction('editor.action.formatSelection') },
    ]],
    ['选择', [
      { label: '全选', shortcut: 'Ctrl+A', action: edAction('editor.action.selectAll') },
      { label: '扩大选区', shortcut: 'Shift+Alt+→', action: edAction('editor.action.smartSelect.expand') },
      { label: '缩小选区', shortcut: 'Shift+Alt+←', action: edAction('editor.action.smartSelect.shrink') },
      { type: 'sep' },
      { label: '向上复制一行', shortcut: 'Shift+Alt+↑', action: edAction('editor.action.copyLinesUpAction') },
      { label: '向下复制一行', shortcut: 'Shift+Alt+↓', action: edAction('editor.action.copyLinesDownAction') },
      { label: '向上移动一行', shortcut: 'Alt+↑', action: edAction('editor.action.moveLinesUpAction') },
      { label: '向下移动一行', shortcut: 'Alt+↓', action: edAction('editor.action.moveLinesDownAction') },
      { type: 'sep' },
      { label: '在上面添加光标', shortcut: 'Ctrl+Alt+↑', action: edAction('editor.action.insertCursorAbove') },
      { label: '在下面添加光标', shortcut: 'Ctrl+Alt+↓', action: edAction('editor.action.insertCursorBelow') },
      { label: '在行尾添加光标', shortcut: 'Shift+Alt+I', action: edAction('editor.action.insertCursorAtEndOfEachLineSelected') },
      { label: '添加下一个匹配项', shortcut: 'Ctrl+D', action: edAction('editor.action.addSelectionToNextFindMatch') },
      { label: '选择所有匹配项', shortcut: 'Ctrl+Shift+L', action: edAction('editor.action.selectHighlights') },
    ]],
    ['查看', [
      cmdItem('workbench.commandPalette'),
      cmdItem('workbench.quickOpen'),
      { type: 'sep' },
      cmdItem('view.explorer'),
      cmdItem('view.search'),
      cmdItem('view.git'),
      cmdItem('view.run'),
      { type: 'sep' },
      cmdItem('view.problems'),
      cmdItem('view.output'),
      cmdItem('debug.console'),
      cmdItem('view.terminal'),
      { type: 'sep' },
      { ...cmdItem('view.toggleSidebar'), checked: !document.body.classList.contains('sidebar-hidden') },
      { ...cmdItem('view.togglePanel'), checked: !document.body.classList.contains('panel-hidden') },
      { ...cmdItem('view.toggleMinimap'), checked: ctx.settings.minimap },
      { ...cmdItem('view.toggleWordWrap'), checked: ctx.settings.wordWrap !== 'off' },
      { type: 'sep' },
      cmdItem('editor.split'),
      cmdItem('markdown.preview'),
      { type: 'sep' },
      cmdItem('view.zoomIn'),
      cmdItem('view.zoomOut'),
      cmdItem('view.zoomReset'),
      { type: 'sep' },
      { label: '颜色主题', submenu: [['light', '浅色'], ['dark', '深色'], ['system', '跟随系统']].map(([k, l]) => ({ label: l, checked: ctx.settings.theme === k, action: () => updateSettings({ theme: k }) })) },
    ]],
    ['转到', [
      cmdItem('nav.back'),
      cmdItem('nav.forward'),
      { type: 'sep' },
      cmdItem('workbench.quickOpen', '转到文件…'),
      cmdItem('editor.gotoSymbol'),
      cmdItem('editor.gotoLine'),
      { type: 'sep' },
      { label: '转到定义', shortcut: 'F12', action: edAction('editor.action.revealDefinition') },
      { label: '速览定义', shortcut: 'Alt+F12', action: edAction('editor.action.peekDefinition') },
      { label: '转到类型定义', action: edAction('editor.action.goToTypeDefinition') },
      { label: '转到实现', shortcut: 'Ctrl+F12', action: edAction('editor.action.goToImplementation') },
      { label: '查找所有引用', shortcut: 'Shift+F12', action: edAction('editor.action.goToReferences') },
      { type: 'sep' },
      { label: '重命名符号', shortcut: 'F2', action: edAction('editor.action.rename') },
      { label: '快速修复', shortcut: 'Ctrl+.', action: edAction('editor.action.quickFix') },
      { type: 'sep' },
      cmdItem('problems.next'),
      cmdItem('problems.prev'),
    ]],
    ['运行', [
      cmdItem('debug.start'),
      cmdItem('run.file'),
      cmdItem('debug.stop'),
      cmdItem('debug.restart'),
      { type: 'sep' },
      cmdItem('debug.continue'),
      cmdItem('debug.pause'),
      cmdItem('debug.stepOver'),
      cmdItem('debug.stepInto'),
      cmdItem('debug.stepOut'),
      cmdItem('debug.runToCursor'),
      { type: 'sep' },
      cmdItem('debug.toggleBreakpoint'),
      cmdItem('debug.conditionalBreakpoint'),
      cmdItem('debug.logpoint'),
      cmdItem('debug.removeAllBreakpoints'),
      { type: 'sep' },
      cmdItem('run.task'),
      cmdItem('terminal.runSelection'),
      { type: 'sep' },
      cmdItem('run.configure'),
      cmdItem('lsp.restart'),
    ]],
    ['终端', [cmdItem('terminal.new'), cmdItem('terminal.kill'), cmdItem('terminal.clear'), { type: 'sep' }, cmdItem('terminal.runSelection')]],
    ['Git', [
      cmdItem('git.manager'),
      cmdItem('git.history'),
      { type: 'sep' },
      cmdItem('git.sync'),
      cmdItem('git.fetch'),
      cmdItem('git.pull'),
      cmdItem('git.push'),
      { type: 'sep' },
      cmdItem('git.checkout'),
      cmdItem('git.publish'),
      cmdItem('git.clone'),
    ]],
    ['帮助', [cmdItem('help.welcome'), cmdItem('help.keys'), { type: 'sep' }, cmdItem('update.check'), { type: 'sep' }, cmdItem('help.devtools'), cmdItem('app.reload'), { type: 'sep' }, cmdItem('help.about')]],
  ];
}

function setupMenubar() {
  const bar = document.getElementById('menubar');
  let openIndex = -1;
  const open = (btn, i) => {
    const r = btn.getBoundingClientRect();
    bar.querySelectorAll('.menu-root').forEach((b) => b.classList.remove('open'));
    showMenu(menus()[i][1], r.left, r.bottom + 4, { onClose: () => (openIndex = -1) });
    btn.classList.add('open');
    openIndex = i;
  };
  menus().forEach(([label], i) => {
    const btn = h(`<button class="menu-root">${label}</button>`);
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (openIndex === i) {
        closeMenus();
        openIndex = -1;
      } else open(btn, i);
    });
    btn.addEventListener('mouseenter', () => {
      if (openIndex >= 0 && openIndex !== i && document.querySelector('.popover.menu')) open(btn, i);
    });
    bar.appendChild(btn);
  });
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.menu-root') && !e.target.closest('.popover')) openIndex = -1;
  });
}

// ---------------- 欢迎页 ----------------

function renderWelcome(container) {
  const el = h(`<div class="welcome">
    <h1>Lumen IDE</h1>
    <p class="sub">轻快的多语言代码编辑器：智能补全、跳转定义、集成终端、Git、全局搜索，一应俱全。</p>
    <div class="welcome-grid">
      <div><h2>开始</h2><div class="welcome-actions">
        <button class="welcome-action" data-c="file.new">${icon('newFile')}新建文件<kbd>${keyLabel('Ctrl+N')}</kbd></button>
        <button class="welcome-action" data-c="file.open">${icon('openFile')}打开文件…<kbd>${keyLabel('Ctrl+O')}</kbd></button>
        <button class="welcome-action" data-c="workbench.openFolder">${icon('folderOpen')}打开文件夹…<kbd>${keyLabel('Ctrl+Alt+O')}</kbd></button>
        <button class="welcome-action" data-c="workbench.commandPalette">${icon('bolt')}命令面板<kbd>${keyLabel('Ctrl+Shift+P')}</kbd></button>
        <button class="welcome-action" data-c="workbench.settings">${icon('gear')}设置<kbd>${keyLabel('Ctrl+,')}</kbd></button>
      </div></div>
      <div><h2>最近打开</h2><div class="recent-list"></div></div>
    </div>
    <div class="welcome-tips">
      <div class="tip"><b>智能补全</b>JS / TS / HTML / CSS / JSON 内置语言服务；Python 自带 Pyright；C/C++、Go、Rust、Java 等检测到本机语言服务器后自动启用。</div>
      <div class="tip"><b>一键运行</b>按 F5 在集成终端里运行当前文件，支持 20 多种语言，也可以在设置里自定义命令。</div>
      <div class="tip"><b>键盘优先</b>Ctrl+P 打开文件，Ctrl+Shift+P 运行命令，Ctrl+\` 打开终端，Ctrl+\\ 拆分编辑器。</div>
    </div>
  </div>`);
  el.querySelectorAll('[data-c]').forEach((b) => (b.onclick = () => runCommand(b.dataset.c)));
  const list = el.querySelector('.recent-list');
  if (!recent.length) list.innerHTML = '<div class="muted" style="padding:8px 12px">还没有最近打开的文件夹</div>';
  for (const p of recent.slice(0, 8)) {
    const item = h(`<div class="recent-item"><b>${escapeHtml(path.basename(p))}</b><span>${escapeHtml(p)}</span></div>`);
    item.onclick = () => openFolder(p);
    list.appendChild(item);
  }
  container.innerHTML = '';
  container.appendChild(el);
}

// ---------------- 工作区 ----------------

function updateTitle() {
  const t = editors.activeTab();
  const name = ctx.root ? path.basename(ctx.root) : null;
  const file = t && t.path ? (t.title || path.basename(t.path.replace('untitled:', ''))) : null;
  document.getElementById('command-center-label').textContent = name || 'Lumen IDE';
  document.title = [file, name, 'Lumen IDE'].filter(Boolean).join(' — ');
}

export async function openFolder(p) {
  if (!p) {
    p = await window.ide.dialog.openFolder();
    if (!p) return;
  }
  if (!(await window.ide.fs.stat(p))) {
    toast('文件夹不存在：' + p, 'error');
    recent = recent.filter((x) => !path.same(x, p));
    saveState({ recent });
    return;
  }
  if (ctx.root && path.same(ctx.root, p)) return;
  if (!(await confirmDirty())) return;
  if (ctx.root) lsp.resetForWorkspace();
  editors.resetForWorkspace();
  ctx.root = p;
  recent = [p, ...recent.filter((x) => !path.same(x, p))].slice(0, 20);
  saveState({ recent, lastRoot: p });
  await explorer.setRoot(p);
  window.ide.fs.watch(p);
  refreshGit();
  const st = await window.ide.state.get();
  const restored = await editors.restoreTabs(st['tabs:' + p]);
  if (!restored) editors.showWelcome();
  updateTitle();
  showView('explorer');
  setTimeout(preloadScripts, 1500);
  bus.emit('workspace:opened', p);
}

async function closeFolder() {
  if (!ctx.root) return;
  if (!(await confirmDirty())) return;
  lsp.resetForWorkspace();
  editors.resetForWorkspace();
  ctx.root = null;
  saveState({ lastRoot: null });
  await explorer.setRoot(null);
  refreshGit();
  editors.showWelcome();
  updateTitle();
}

// 把工作区里的 JS/TS 文件载入为后台模型，让内置 TS 服务能做跨文件补全与跳转
async function preloadScripts() {
  if (!ctx.root) return;
  const root = ctx.root;
  const list = (await window.ide.fs.listAll(root)).filter((p) => /\.(tsx?|jsx?|mjs|cjs|d\.ts)$/i.test(p));
  if (list.length > 400) return;
  for (const p of list) {
    if (ctx.root !== root) return;
    await editors.ensureDoc(p, { background: true }).catch(() => {});
  }
}

// 关闭窗口或重启安装更新之前：处理未保存的文件并保存会话状态
export async function prepareClose() {
  if (!(await confirmDirty())) return false;
  flushState();
  return true;
}

async function confirmDirty() {
  const dirty = editors.dirtyDocs();
  if (!dirty.length) return true;
  const r = await confirm({ title: '有未保存的更改', message: `${dirty.length} 个文件有未保存的更改：\n${dirty.map((d) => path.basename(d.path)).join('、')}`, buttons: ['全部保存', '不保存', '取消'] });
  if (r === 0) {
    for (const d of dirty) if (!(await editors.saveDoc(d))) return false;
    return true;
  }
  return r === 1;
}

async function openFiles() {
  const files = await window.ide.dialog.openFile();
  for (const f of files) await editors.openFile(f, { pinned: true });
}

function zoom(delta) {
  if (delta === 0) return updateSettings({ fontSize: 14, terminalFontSize: 13 });
  updateSettings({ fontSize: Math.max(8, Math.min(40, ctx.settings.fontSize + delta)), terminalFontSize: Math.max(8, Math.min(40, (ctx.settings.terminalFontSize || 13) + delta)) });
}

function runSelectionInTerminal() {
  const ed = editors.activeEditor();
  if (!ed) return;
  const sel = ed.getSelection();
  const text = sel.isEmpty() ? ed.getModel().getLineContent(sel.startLineNumber) : ed.getModel().getValueInRange(sel);
  const t = activeTerminal() || newTerminal();
  showPanel('terminal');
  t.sendText(text);
}

async function runTask() {
  if (!ctx.root) return toast('请先打开文件夹', 'error');
  const pkgPath = path.join(ctx.root, 'package.json');
  const items = [];
  if (await window.ide.fs.exists(pkgPath)) {
    try {
      const pkg = JSON.parse((await window.ide.fs.readFile(pkgPath)).content);
      for (const [name, cmd] of Object.entries(pkg.scripts || {})) items.push({ label: `npm run ${name}`, desc: cmd, action: () => import('./terminal.js').then((m) => m.runInTerminal(`npm run ${name}`, ctx.root)) });
    } catch {}
  }
  const mk = path.join(ctx.root, 'Makefile');
  if (await window.ide.fs.exists(mk)) items.push({ label: 'make', desc: 'Makefile', action: () => import('./terminal.js').then((m) => m.runInTerminal('make', ctx.root)) });
  const cargo = path.join(ctx.root, 'Cargo.toml');
  if (await window.ide.fs.exists(cargo)) items.push({ label: 'cargo run', desc: 'Cargo.toml', action: () => import('./terminal.js').then((m) => m.runInTerminal('cargo run', ctx.root)) }, { label: 'cargo build', desc: 'Cargo.toml', action: () => import('./terminal.js').then((m) => m.runInTerminal('cargo build', ctx.root)) }, { label: 'cargo test', desc: 'Cargo.toml', action: () => import('./terminal.js').then((m) => m.runInTerminal('cargo test', ctx.root)) });
  const gomod = path.join(ctx.root, 'go.mod');
  if (await window.ide.fs.exists(gomod)) items.push({ label: 'go run .', desc: 'go.mod', action: () => import('./terminal.js').then((m) => m.runInTerminal('go run .', ctx.root)) }, { label: 'go test ./...', desc: 'go.mod', action: () => import('./terminal.js').then((m) => m.runInTerminal('go test ./...', ctx.root)) });
  if (!items.length) return toast('没有找到可运行的任务（package.json / Makefile / Cargo.toml / go.mod）');
  openPicker({ placeholder: '选择要运行的任务', items });
}

function about() {
  const m = modal({
    title: '关于 Lumen IDE',
    body: `<div class="modal-body"><div class="modal-msg">版本 ${escapeHtml(ctx.info.version)}\nElectron ${escapeHtml(ctx.info.electron)}\n编辑器内核：Monaco Editor\n终端：xterm.js + node-pty\nPython 语言服务：Pyright\n\n设置文件：${escapeHtml(ctx.info.settingsPath)}</div></div>`,
    footer: '<div class="modal-footer"><button class="btn" data-a="update">检查更新</button><button class="btn btn-primary" data-a="ok">好</button></div>',
  });
  m.el.querySelector('[data-a=ok]').onclick = () => m.close();
  m.el.querySelector('[data-a=update]').onclick = () => {
    m.close();
    runCommand('update.check');
  };
}

function shortcutsTab() {
  import('./settings-view.js').then((m) => m.openSettings('keys'));
}

// ---------------- 命令 ----------------

function registerAll() {
  const C = (id, title, category, key, run, extra = {}) => registerCommand({ id, title, category, key, run, ...extra });
  const ed = (id) => () => {
    const e = editors.activeEditor();
    if (e) {
      e.focus();
      e.trigger('cmd', id, null);
    }
  };

  C('file.new', '新建文件', '文件', 'Ctrl+N', () => editors.newFile());
  C('explorer.newFile', '在资源管理器中新建文件…', '文件', null, () => explorer.newFileHere());
  C('explorer.newFolder', '新建文件夹…', '文件', null, () => explorer.newFolderHere());
  C('file.open', '打开文件…', '文件', 'Ctrl+O', openFiles);
  C('workbench.openFolder', '打开文件夹…', '文件', 'Ctrl+Alt+O', () => openFolder());
  C('workbench.closeFolder', '关闭文件夹', '文件', null, closeFolder);
  C('file.save', '保存', '文件', 'Ctrl+S', () => editors.saveActive());
  C('file.saveAs', '另存为…', '文件', 'Ctrl+Shift+S', () => editors.saveActive(true));
  C('file.saveAll', '全部保存', '文件', 'Ctrl+Alt+S', () => editors.saveAll());
  C('editor.close', '关闭编辑器', '文件', 'Ctrl+W', () => editors.closeActiveTab());
  C('editor.closeAll', '关闭所有编辑器', '文件', null, () => editors.closeAllGroups());
  C('editor.reopenClosed', '重新打开已关闭的编辑器', '文件', 'Ctrl+Shift+T', () => {
    const p = closedTabs.pop();
    if (p) editors.openFile(p, { pinned: true });
  });
  C('workbench.settings', '打开设置', '首选项', 'Ctrl+,', () => openSettings());
  C('workbench.settingsJson', '打开设置 (JSON)', '首选项', null, () => editors.openFile(ctx.info.settingsPath, { pinned: true }));
  C('app.quit', '退出', '文件', null, () => window.close());
  C('app.reload', '重新加载窗口', '开发者', null, () => window.ide.app.reload());

  C('workbench.commandPalette', '命令面板…', '查看', 'Ctrl+Shift+P', commandPalette);
  C('workbench.quickOpen', '快速打开文件…', '查看', 'Ctrl+P', () => quickOpen());
  C('editor.gotoLine', '转到行…', '转到', 'Ctrl+G', gotoLine);
  C('editor.gotoSymbol', '转到文件中的符号…', '转到', 'Ctrl+Shift+O', ed('editor.action.quickOutline'));
  C('editor.showEditorCommands', '显示编辑器命令', '编辑器', null, ed('editor.action.quickCommand'));
  C('search.find', '在文件中查找', '搜索', 'Ctrl+Shift+F', () => {
    const e = editors.activeEditor();
    const sel = e && e.getModel() && e.getModel().getValueInRange(e.getSelection());
    focusSearch(sel && !sel.includes('\n') ? sel : '');
  });
  C('search.replace', '在文件中替换', '搜索', 'Ctrl+Shift+H', () => focusSearch('', true));
  C('view.explorer', '资源管理器', '查看', 'Ctrl+Shift+E', () => showView('explorer'));
  C('view.search', '搜索', '查看', null, () => showView('search'), { hint: 'Ctrl+Shift+F' });
  C('view.git', '源代码管理', '查看', 'Ctrl+Shift+G', () => showView('git'));
  C('view.run', '运行和调试', '查看', 'Ctrl+Shift+D', () => showView('run'));
  C('view.toggleSidebar', '切换侧栏', '查看', 'Ctrl+B', toggleSidebar);
  C('view.togglePanel', '切换面板', '查看', 'Ctrl+J', togglePanel);
  C('view.terminal', '终端', '查看', 'Ctrl+`', () => {
    if (!document.body.classList.contains('panel-hidden') && activePanel === 'terminal' && document.activeElement && document.activeElement.closest('.xterm')) togglePanel();
    else showPanel('terminal');
  });
  C('view.problems', '问题', '查看', 'Ctrl+Shift+M', () => showPanel('problems'));
  C('view.output', '输出', '查看', 'Ctrl+Shift+U', () => showPanel('output'));
  C('view.toggleWordWrap', '切换自动换行', '查看', 'Alt+Z', () => updateSettings({ wordWrap: ctx.settings.wordWrap === 'off' ? 'on' : 'off' }));
  C('view.toggleMinimap', '切换小地图', '查看', null, () => updateSettings({ minimap: !ctx.settings.minimap }));
  C('view.zoomIn', '放大', '查看', 'Ctrl+=', () => zoom(1));
  C('view.zoomOut', '缩小', '查看', 'Ctrl+-', () => zoom(-1));
  C('view.zoomReset', '重置缩放', '查看', 'Ctrl+0', () => zoom(0));
  C('view.toggleTheme', '切换深色/浅色主题', '查看', 'Ctrl+Alt+T', toggleTheme);
  C('editor.split', '拆分编辑器', '查看', 'Ctrl+\\', () => editors.splitEditor());
  C('editor.focus1', '聚焦第一个编辑器组', '查看', 'Ctrl+1', () => editors.focusGroup(0));
  C('editor.focus2', '聚焦第二个编辑器组', '查看', 'Ctrl+2', () => editors.focusGroup(1));
  C('editor.focus3', '聚焦第三个编辑器组', '查看', 'Ctrl+3', () => editors.focusGroup(2));
  C('editor.nextTab', '下一个编辑器', '查看', 'Ctrl+Tab', () => editors.nextTab(1));
  C('editor.prevTab', '上一个编辑器', '查看', 'Ctrl+Shift+Tab', () => editors.nextTab(-1));
  C('editor.nextTab2', '下一个编辑器', '查看', 'Ctrl+PageDown', () => editors.nextTab(1), { palette: false });
  C('editor.prevTab2', '上一个编辑器', '查看', 'Ctrl+PageUp', () => editors.nextTab(-1), { palette: false });
  C('markdown.preview', '打开 Markdown 预览', '查看', 'Ctrl+Shift+V', () => {
    const t = editors.activeTab();
    if (t && t.type === 'file' && /\.(md|markdown)$/i.test(t.path)) editors.openMarkdownPreview(t.path);
    else toast('当前文件不是 Markdown');
  });
  C('editor.changeLanguage', '更改语言模式', '编辑器', null, pickLanguage);
  C('editor.format', '格式化文档', '编辑器', null, ed('editor.action.formatDocument'), { hint: 'Shift+Alt+F' });
  C('editor.compareHead', '将当前文件与 HEAD 比较', 'Git', null, () => {
    const t = editors.activeTab();
    if (t && t.path) editors.openDiff(t.path, 'HEAD');
  });
  C('explorer.reveal', '在资源管理器中显示当前文件', '文件', null, () => {
    const t = editors.activeTab();
    if (t && t.path) explorer.reveal(t.path);
  });
  C('file.revealInOs', '在系统文件管理器中显示当前文件', '文件', 'Shift+Alt+R', () => {
    const t = editors.activeTab();
    if (t && t.path && !t.path.startsWith('untitled:')) window.ide.app.reveal(t.path);
  });
  C('file.copyPath', '复制当前文件路径', '文件', null, () => {
    const t = editors.activeTab();
    if (t && t.path) navigator.clipboard.writeText(t.path).then(() => toast('已复制路径', 'success'));
  });

  C('nav.back', '后退', '转到', 'Alt+Left', () => editors.navigate(-1));
  C('nav.forward', '前进', '转到', 'Alt+Right', () => editors.navigate(1));
  C('problems.next', '下一个问题', '转到', null, () => nextProblem(1), { hint: 'F8' });
  C('problems.prev', '上一个问题', '转到', null, () => nextProblem(-1), { hint: 'Shift+F8' });

  C('run.file', '运行当前文件（不调试）', '运行', 'Ctrl+F5', () => runFile());
  C('run.stop', '停止运行', '运行', null, stopRun);
  C('run.task', '运行任务…', '运行', 'Ctrl+Shift+B', runTask);
  C('run.configure', '配置运行命令', '运行', null, () => openSettings('run'));
  C('lsp.restart', '重启当前语言的语言服务器', '运行', null, async () => {
    const e = editors.activeEditor();
    if (!e || !e.getModel()) return;
    const lang = e.getModel().getLanguageId();
    toast(`正在重启 ${lang} 语言服务器…`);
    const ok = await lsp.restartLanguage(lang);
    toast(ok ? '语言服务器已重启' : '该语言没有可用的语言服务器', ok ? 'success' : 'error');
  });

  C('terminal.new', '新建终端', '终端', 'Ctrl+Shift+`', () => newTerminal());
  C('terminal.kill', '终止终端', '终端', null, () => killTerminal());
  C('terminal.clear', '清除终端', '终端', null, clearTerminal);
  C('terminal.runSelection', '在终端中运行所选文本', '终端', null, runSelectionInTerminal);

  C('git.checkout', '切换分支…', 'Git', null, switchBranch);
  C('git.refresh', '刷新', 'Git', null, refreshGit);
  C('git.sync', '同步（拉取并推送）', 'Git', null, syncNow);
  C('git.fetch', '获取', 'Git', null, () => fetchNow());
  C('git.pull', '拉取', 'Git', null, pullNow);
  C('git.push', '推送', 'Git', null, pushNow);
  C('git.manager', '打开 Git 管理', 'Git', 'Ctrl+Alt+G', () => openManager());
  C('git.history', '查看提交历史', 'Git', null, () => openManager('history'));
  C('git.publish', '发布到 GitHub…', 'Git', null, () => import('./git-manager.js').then((m) => m.publishDialog()));
  C('git.clone', '克隆仓库…', 'Git', null, () => import('./git-manager.js').then((m) => m.cloneRepo()));

  C('help.welcome', '欢迎页', '帮助', null, () => editors.showWelcome());
  C('help.keys', '键盘快捷方式', '帮助', null, shortcutsTab);
  C('help.devtools', '切换开发者工具', '帮助', 'Ctrl+Shift+I', () => window.ide.app.toggleDevTools());
  C('help.about', '关于', '帮助', null, about);
}

// ---------------- 初始化 ----------------

export async function initWorkbench(state) {
  recent = state.recent || [];
  registerAll();
  setupMenubar();
  setupSashes(state);

  document.querySelectorAll('.activity[data-view]').forEach((b) => (b.onclick = () => showView(b.dataset.view, { toggle: true })));
  document.getElementById('theme-toggle').onclick = toggleTheme;
  document.getElementById('open-settings').onclick = () => openSettings();
  document.getElementById('command-center').onclick = () => quickOpen();
  document.querySelectorAll('#panel-tabs button').forEach((b) => (b.onclick = () => showPanel(b.dataset.panel)));

  if (state.sidebarHidden) document.body.classList.add('sidebar-hidden');
  if (state.panelHidden !== false) document.body.classList.add('panel-hidden');
  activePanel = state.activePanel || 'terminal';
  showView(state.activeView || 'explorer');
  if (state.sidebarHidden) document.body.classList.add('sidebar-hidden');
  document.querySelectorAll('#panel-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.panel === activePanel));
  document.querySelectorAll('.panel-view').forEach((v) => (v.hidden = v.dataset.panel !== activePanel));
  renderPanelActions();

  bus.on('view:show', (v) => showView(v));
  bus.on('panel:show', (p) => {
    if (document.body.classList.contains('panel-hidden') || activePanel !== p) {
      activePanel = p;
      document.body.classList.remove('panel-hidden');
      document.querySelectorAll('#panel-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.panel === p));
      document.querySelectorAll('.panel-view').forEach((v) => (v.hidden = v.dataset.panel !== p));
      renderPanelActions();
      saveState({ panelHidden: false, activePanel: p });
      bus.emit('panel:resized');
    }
  });
  bus.on('welcome:render', renderWelcome);
  bus.on('editor:active', updateTitle);
  bus.on('cmd', (id) => runCommand(id));
  bus.on('settings:changed', async (_s, patch) => {
    if ('theme' in patch) await applyTheme();
  });
  bus.on('doc:saved', (doc) => {
    if (doc && path.same(doc.path, ctx.info.settingsPath)) reloadSettings().then(() => toast('设置已更新', 'success'));
  });
  bus.on('tab:closed', (p) => {
    closedTabs.push(p);
    if (closedTabs.length > 30) closedTabs.shift();
  });
  window.ide.theme.onChanged(() => ctx.settings.theme === 'system' && applyTheme());

  window.ide.fs.onChanged(({ root, paths }) => {
    if (root !== ctx.root) return;
    explorer.onFsChanged(paths);
    editors.onExternalChange(paths);
    bus.emit('fs:changed', paths);
  });

  // 把文件或文件夹拖进窗口
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    for (const f of e.dataTransfer.files) {
      const p = window.ide.pathForFile(f);
      if (!p) continue;
      const st = await window.ide.fs.stat(p);
      if (st && st.isDir) openFolder(p);
      else if (st) editors.openFile(p, { pinned: true });
    }
  });

  window.ide.app.onBeforeClose(async () => {
    if (await prepareClose()) window.ide.app.confirmClose();
  });
}

export { openFiles };
