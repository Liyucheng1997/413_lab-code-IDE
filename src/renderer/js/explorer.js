// 资源管理器：文件树（懒加载）、新建/重命名/删除/复制/移动、拖放、Git 状态标记。
import { ctx, saveState } from './state.js';
import { bus, path, fileIcon, escapeHtml, h, norm, isWin } from './util.js';
import { icon } from './icons.js';
import { toast, confirm, contextMenu } from './ui.js';
import * as editors from './editors.js';
import { runCommand } from './commands.js';

let view;
let treeEl;
let rootNode = null;
const nodes = new Map(); // norm(path) → node
let selected = null;
let clipboard = null; // { paths, cut }
let gitStatus = new Map(); // norm(path) → 'M' | 'U' | 'A' | 'D'
let gitDirs = new Map();
let editing = null; // { parent, node?, kind }

function makeNode(p, name, isDir, parent) {
  const n = { path: p, name, isDir, parent, expanded: false, children: null };
  nodes.set(norm(p), n);
  return n;
}

async function loadChildren(n) {
  try {
    const list = await window.ide.fs.readDir(n.path);
    const prev = new Map((n.children || []).map((c) => [c.name, c]));
    n.children = list.map((e) => {
      const old = prev.get(e.name);
      if (old && old.isDir === e.isDir) return old;
      return makeNode(e.path, e.name, e.isDir, n);
    });
    for (const [name, old] of prev) if (!list.some((e) => e.name === name)) forget(old);
  } catch {
    n.children = [];
  }
}

function forget(n) {
  nodes.delete(norm(n.path));
  if (n.children) n.children.forEach(forget);
}

export async function setRoot(root) {
  nodes.clear();
  selected = null;
  if (!root) {
    rootNode = null;
    render();
    return;
  }
  rootNode = makeNode(root, path.basename(root), true, null);
  rootNode.expanded = true;
  await loadChildren(rootNode);
  // 恢复展开状态
  const st = await window.ide.state.get();
  const expanded = (st['expanded:' + root] || []).sort((a, b) => a.length - b.length);
  for (const p of expanded) {
    const n = nodes.get(norm(p));
    if (n && n.isDir) {
      n.expanded = true;
      await loadChildren(n);
    }
  }
  render();
}

function persistExpanded() {
  if (!rootNode) return;
  const list = [];
  for (const n of nodes.values()) if (n.isDir && n.expanded && n !== rootNode) list.push(n.path);
  saveState({ ['expanded:' + rootNode.path]: list });
}

function visibleRows() {
  const rows = [];
  const walk = (n, depth) => {
    for (const c of n.children || []) {
      rows.push({ node: c, depth });
      if (editing && editing.parent === c && c.expanded) rows.push({ input: true, depth: depth + 1 });
      if (c.isDir && c.expanded) walk(c, depth + 1);
    }
  };
  if (rootNode) {
    if (editing && editing.parent === rootNode && !editing.node) rows.push({ input: true, depth: 0 });
    walk(rootNode, 0);
  }
  return rows;
}

function render() {
  const header = view.querySelector('.view-title');
  if (!rootNode) {
    header.textContent = '资源管理器';
    treeEl.innerHTML = `<div class="empty">${icon('folderOpen')}<div>尚未打开文件夹</div><button class="btn btn-primary btn-sm" id="exp-open">打开文件夹</button><div class="muted" style="font-size:12px">也可以把文件夹拖到窗口里</div></div>`;
    treeEl.querySelector('#exp-open').onclick = () => runCommand('workbench.openFolder');
    return;
  }
  header.textContent = rootNode.name.toUpperCase();
  header.title = rootNode.path;
  const active = editors.activeTab();
  const activePath = active && active.path;
  const frag = document.createDocumentFragment();
  for (const row of visibleRows()) {
    if (row.input) {
      frag.appendChild(inputRow(row.depth));
      continue;
    }
    const n = row.node;
    if (editing && editing.node === n) {
      frag.appendChild(inputRow(row.depth, n));
      continue;
    }
    const st = gitStatus.get(norm(n.path)) || (n.isDir ? gitDirs.get(norm(n.path)) : null);
    const el = h(`<div class="tree-row${n === selected ? ' selected' : ''}${n.expanded ? ' expanded' : ''}${activePath && path.same(activePath, n.path) ? ' active-file' : ''}${clipboard && clipboard.cut && clipboard.paths.includes(n.path) ? ' cut' : ''}" draggable="true" style="padding-left:${8 + row.depth * 14}px">
      <span class="tree-twisty">${n.isDir ? icon('chevron') : ''}</span>
      ${fileIcon(n.name, n.isDir, n.expanded)}
      <span class="tree-name ${st ? 'git-name-' + st : ''}">${escapeHtml(n.name)}</span>
      ${st && !n.isDir ? `<span class="tree-git git-${st}">${st}</span>` : st && n.isDir ? `<span class="dot" style="background:var(--git-${st === 'U' ? 'added' : 'modified'});width:5px;height:5px;margin-left:6px"></span>` : ''}
    </div>`);
    el.title = n.path;
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      select(n);
    });
    el.addEventListener('click', () => {
      if (n.isDir) toggle(n);
      else editors.openFile(n.path, { preview: true, focus: false });
    });
    el.addEventListener('dblclick', () => {
      if (!n.isDir) editors.openFile(n.path, { pinned: true });
    });
    el.addEventListener('contextmenu', (e) => {
      select(n);
      contextMenu(e, nodeMenu(n));
    });
    setupDrag(el, n);
    frag.appendChild(el);
  }
  const oldInput = treeEl.querySelector('.tree-input');
  const keepValue = oldInput && editing ? oldInput.value : null;
  if (oldInput) oldInput.dataset.stale = '1';
  treeEl.innerHTML = '';
  treeEl.appendChild(frag);
  const input = treeEl.querySelector('.tree-input');
  if (input && keepValue !== null) {
    input.value = keepValue;
    input.focus();
  } else if (input) {
    input.focus();
    const v = input.value;
    if (editing.node && !editing.node.isDir && v.includes('.')) input.setSelectionRange(0, v.lastIndexOf('.'));
    else input.select();
  }
}

function inputRow(depth, node) {
  const kind = node ? 'rename' : editing.kind;
  const el = h(`<div class="tree-row" style="padding-left:${8 + depth * 14}px">
    <span class="tree-twisty"></span>${fileIcon(node ? node.name : '', kind === 'folder' || (node && node.isDir))}
    <input class="tree-input" spellcheck="false" value="${node ? escapeHtml(node.name) : ''}" />
  </div>`);
  const input = el.querySelector('input');
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    const ed = editing;
    editing = null;
    if (commit && name && (!node || name !== node.name)) {
      const problem = validateName(name);
      if (problem) {
        toast(problem, 'error');
      } else if (node) await doRename(node, name);
      else await doCreate(ed.parent, name, ed.kind);
    }
    render();
    treeEl.focus();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('input', () => input.classList.toggle('invalid', !!validateName(input.value.trim())));
  input.addEventListener('blur', () => !input.dataset.stale && finish(true));
  return el;
}

function validateName(name) {
  if (!name) return '名称不能为空';
  if (isWin && /[<>:"|?*]/.test(name.replace(/[\\/]/g, ''))) return '名称包含非法字符 < > : " | ? *';
  if (/^\.+$/.test(name)) return '名称无效';
  return null;
}

async function doCreate(parent, name, kind) {
  const target = path.join(parent.path, name);
  try {
    if (kind === 'folder') await window.ide.fs.createDir(target);
    else await window.ide.fs.createFile(target);
    await refreshDir(parent);
    // 名称里带子目录时展开父链
    if (name.includes('/') || name.includes('\\')) await reveal(target);
    if (kind !== 'folder') editors.openFile(target, { pinned: true });
    const n = nodes.get(norm(target));
    if (n) select(n);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function doRename(n, name) {
  const target = path.join(path.dirname(n.path), name);
  try {
    await window.ide.fs.rename(n.path, target);
    editors.onPathRenamed(n.path, target);
    await refreshDir(n.parent);
    const nn = nodes.get(norm(target));
    if (nn) select(nn);
    bus.emit('fs:renamed', n.path, target);
  } catch (err) {
    toast('重命名失败：' + err.message, 'error');
  }
}

async function doDelete(n) {
  const r = await confirm({ title: '删除', message: `确定要删除“${n.name}”吗？\n${n.isDir ? '文件夹及其内容' : '文件'}会被移到回收站。`, buttons: ['移到回收站', '取消'], danger: true });
  if (r !== 0) return;
  try {
    await window.ide.fs.delete(n.path);
    await editors.onPathDeleted(n.path);
    await refreshDir(n.parent);
  } catch (err) {
    toast('删除失败：' + err.message, 'error');
  }
}

async function doPaste(targetDir) {
  if (!clipboard) return;
  for (const p of clipboard.paths) {
    try {
      if (clipboard.cut) {
        const to = path.join(targetDir.path, path.basename(p));
        if (path.same(to, p)) continue;
        if (path.isInside(p, targetDir.path)) {
          toast('不能把文件夹移动到它自己里面', 'error');
          continue;
        }
        await window.ide.fs.rename(p, to);
        editors.onPathRenamed(p, to);
      } else await window.ide.fs.copy(p, targetDir.path);
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  if (clipboard.cut) clipboard = null;
  await refreshAll();
}

function startEdit(parent, kind) {
  if (!rootNode) return;
  if (parent !== rootNode && !parent.expanded) {
    parent.expanded = true;
  }
  const go = () => {
    editing = { parent, kind };
    render();
  };
  if (!parent.children) loadChildren(parent).then(go);
  else go();
}

function targetDir() {
  if (!selected) return rootNode;
  return selected.isDir ? selected : selected.parent || rootNode;
}

export function newFileHere() {
  if (!rootNode) return editors.newFile();
  bus.emit('view:show', 'explorer');
  startEdit(targetDir(), 'file');
}

export function newFolderHere() {
  if (!rootNode) return;
  bus.emit('view:show', 'explorer');
  startEdit(targetDir(), 'folder');
}

function nodeMenu(n) {
  const dir = n.isDir ? n : n.parent;
  const rel = path.relative(rootNode.path, n.path);
  return [
    { label: '新建文件…', icon: 'newFile', action: () => startEdit(dir, 'file') },
    { label: '新建文件夹…', icon: 'newFolder', action: () => startEdit(dir, 'folder') },
    { type: 'sep' },
    !n.isDir && { label: '打开', action: () => editors.openFile(n.path, { pinned: true }) },
    !n.isDir && { label: '向右拆分打开', action: async () => {
      await editors.openFile(n.path, { pinned: true });
      editors.splitEditor();
    } },
    !n.isDir && { label: '用系统默认程序打开', action: () => window.ide.app.openPath(n.path) },
    { label: '在系统文件管理器中显示', shortcut: 'Shift+Alt+R', action: () => window.ide.app.reveal(n.path) },
    { label: '在集成终端中打开', icon: 'terminal', action: () => bus.emit('terminal:new', n.isDir ? n.path : path.dirname(n.path)) },
    { type: 'sep' },
    n.isDir && { label: '在文件夹中查找…', icon: 'search', action: () => bus.emit('search:in-folder', rel) },
    !n.isDir && { label: '运行此文件', icon: 'play', action: () => bus.emit('run:file', n.path) },
    !n.isDir && { label: '与 HEAD 比较', action: () => editors.openDiff(n.path, 'HEAD') },
    { type: 'sep' },
    { label: '剪切', shortcut: 'Ctrl+X', action: () => setClipboard([n.path], true) },
    { label: '复制', shortcut: 'Ctrl+C', action: () => setClipboard([n.path], false) },
    { label: '粘贴', shortcut: 'Ctrl+V', disabled: !clipboard, action: () => doPaste(dir) },
    { type: 'sep' },
    { label: '复制路径', action: () => navigator.clipboard.writeText(n.path) },
    { label: '复制相对路径', action: () => navigator.clipboard.writeText(rel) },
    { type: 'sep' },
    { label: '重命名…', shortcut: 'F2', action: () => startRename(n) },
    { label: '删除', shortcut: 'Delete', icon: 'trash', action: () => doDelete(n) },
  ];
}

function setClipboard(paths, cut) {
  clipboard = { paths, cut };
  render();
}

function startRename(n) {
  editing = { node: n };
  render();
}

function select(n) {
  selected = n;
  render();
}

async function toggle(n) {
  n.expanded = !n.expanded;
  if (n.expanded && !n.children) await loadChildren(n);
  render();
  persistExpanded();
}

function setupDrag(el, n) {
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('application/x-lumen-path', n.path);
    e.dataTransfer.setData('text/plain', n.path);
    e.dataTransfer.effectAllowed = 'copyMove';
  });
  el.addEventListener('dragover', (e) => {
    const types = e.dataTransfer.types;
    if (!types.includes('application/x-lumen-path') && !types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = types.includes('Files') ? 'copy' : 'move';
    el.classList.add('drop-target');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
  el.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('drop-target');
    const dir = n.isDir ? n : n.parent;
    const src = e.dataTransfer.getData('application/x-lumen-path');
    if (src) {
      const to = path.join(dir.path, path.basename(src));
      if (path.same(src, to) || path.isInside(src, dir.path)) return;
      try {
        await window.ide.fs.rename(src, to);
        editors.onPathRenamed(src, to);
      } catch (err) {
        toast('移动失败：' + err.message, 'error');
      }
    } else {
      for (const f of e.dataTransfer.files) if (window.ide.pathForFile(f)) await window.ide.fs.copy(window.ide.pathForFile(f), dir.path).catch((err) => toast(err.message, 'error'));
    }
    await refreshAll();
  });
}

async function refreshDir(n) {
  if (!n) return;
  await loadChildren(n);
  render();
}

export async function refreshAll() {
  if (!rootNode) return;
  const dirs = [...nodes.values()].filter((n) => n.isDir && (n.expanded || n === rootNode));
  for (const d of dirs) await loadChildren(d);
  render();
}

// 文件系统变化：只刷新受影响且已加载的目录
export async function onFsChanged(paths) {
  if (!rootNode) return;
  const dirs = new Set();
  for (const p of paths) {
    const d = nodes.get(norm(path.dirname(p)));
    if (d && d.children) dirs.add(d);
  }
  for (const d of dirs) await loadChildren(d);
  if (dirs.size) render();
}

export async function reveal(p) {
  if (!rootNode || !path.isInside(rootNode.path, p)) return;
  bus.emit('view:show', 'explorer');
  const rel = path.relative(rootNode.path, p).split(/[\\/]/);
  let cur = rootNode;
  for (let i = 0; i < rel.length; i++) {
    if (!cur.children) await loadChildren(cur);
    const next = (cur.children || []).find((c) => c.name.toLowerCase() === rel[i].toLowerCase());
    if (!next) break;
    if (i < rel.length - 1) next.expanded = true;
    cur = next;
  }
  selected = cur;
  render();
  persistExpanded();
  const row = treeEl.querySelector('.tree-row.selected');
  if (row) row.scrollIntoView({ block: 'center' });
}

export function collapseAll() {
  for (const n of nodes.values()) if (n !== rootNode) n.expanded = false;
  render();
  persistExpanded();
}

export function setGitStatus(status) {
  gitStatus = new Map();
  gitDirs = new Map();
  if (status && status.isRepo) {
    for (const f of status.files) {
      let st = f.index === '?' ? 'U' : f.worktree === 'D' || f.index === 'D' ? 'D' : f.index === 'A' && f.worktree === ' ' ? 'A' : f.index === 'U' || f.worktree === 'U' ? 'C' : 'M';
      gitStatus.set(norm(f.path), st);
      let d = path.dirname(f.path);
      while (rootNode && path.isInside(rootNode.path, d) && !path.same(d, rootNode.path)) {
        if (!gitDirs.has(norm(d)) || st !== 'U') gitDirs.set(norm(d), st === 'D' ? 'M' : st);
        d = path.dirname(d);
      }
    }
  }
  render();
}

function onKey(e) {
  if (!rootNode || e.target.tagName === 'INPUT') return;
  const rows = visibleRows().filter((r) => !r.input);
  const i = rows.findIndex((r) => r.node === selected);
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'ArrowDown') select((rows[i + 1] || rows[i] || rows[0]).node);
  else if (e.key === 'ArrowUp') select((rows[i - 1] || rows[0]).node);
  else if (e.key === 'ArrowRight' && selected && selected.isDir) {
    if (!selected.expanded) toggle(selected);
    else if (selected.children && selected.children[0]) select(selected.children[0]);
  } else if (e.key === 'ArrowLeft' && selected) {
    if (selected.isDir && selected.expanded) toggle(selected);
    else if (selected.parent && selected.parent !== rootNode) select(selected.parent);
  } else if (e.key === 'Enter' && selected) {
    if (selected.isDir) toggle(selected);
    else editors.openFile(selected.path, { pinned: true });
  } else if (e.key === 'F2' && selected) startRename(selected);
  else if (e.key === 'Delete' && selected) doDelete(selected);
  else if (mod && e.key.toLowerCase() === 'c' && selected) setClipboard([selected.path], false);
  else if (mod && e.key.toLowerCase() === 'x' && selected) setClipboard([selected.path], true);
  else if (mod && e.key.toLowerCase() === 'v') doPaste(targetDir());
  else return;
  e.preventDefault();
  const row = treeEl.querySelector('.tree-row.selected');
  if (row) row.scrollIntoView({ block: 'nearest' });
}

export function initExplorer() {
  view = document.querySelector('.view[data-view=explorer]');
  view.innerHTML = `
    <div class="view-header"><span class="view-title">资源管理器</span>
      <div class="view-actions">
        <button class="icon-btn" data-a="file" title="新建文件">${icon('newFile')}</button>
        <button class="icon-btn" data-a="folder" title="新建文件夹">${icon('newFolder')}</button>
        <button class="icon-btn" data-a="refresh" title="刷新">${icon('refresh')}</button>
        <button class="icon-btn" data-a="collapse" title="全部折叠">${icon('collapse')}</button>
      </div>
    </div>
    <div class="view-body tree" tabindex="0"></div>`;
  treeEl = view.querySelector('.tree');
  const actions = { file: newFileHere, folder: newFolderHere, refresh: refreshAll, collapse: collapseAll };
  view.querySelectorAll('[data-a]').forEach((b) => (b.onclick = () => actions[b.dataset.a]()));
  treeEl.addEventListener('keydown', onKey);
  treeEl.addEventListener('focus', () => treeEl.classList.add('focused'));
  treeEl.addEventListener('blur', () => treeEl.classList.remove('focused'));
  treeEl.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.tree-row') || !rootNode) return;
    contextMenu(e, [
      { label: '新建文件…', icon: 'newFile', action: () => startEdit(rootNode, 'file') },
      { label: '新建文件夹…', icon: 'newFolder', action: () => startEdit(rootNode, 'folder') },
      { label: '粘贴', disabled: !clipboard, action: () => doPaste(rootNode) },
      { type: 'sep' },
      { label: '在系统文件管理器中显示', action: () => window.ide.app.openPath(rootNode.path) },
      { label: '在集成终端中打开', action: () => bus.emit('terminal:new', rootNode.path) },
    ]);
  });
  // 拖到空白处 = 复制到根目录
  treeEl.addEventListener('dragover', (e) => {
    if (rootNode && (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('application/x-lumen-path'))) e.preventDefault();
  });
  treeEl.addEventListener('drop', async (e) => {
    if (!rootNode || e.target.closest('.tree-row')) return;
    e.preventDefault();
    const src = e.dataTransfer.getData('application/x-lumen-path');
    if (src) {
      const to = path.join(rootNode.path, path.basename(src));
      if (!path.same(src, to)) {
        await window.ide.fs.rename(src, to).catch((err) => toast(err.message, 'error'));
        editors.onPathRenamed(src, to);
      }
    } else for (const f of e.dataTransfer.files) if (window.ide.pathForFile(f)) await window.ide.fs.copy(window.ide.pathForFile(f), rootNode.path);
    refreshAll();
  });

  bus.on('editor:active', () => render());
  bus.on('explorer:reveal', (p) => reveal(p));
  render();
}
