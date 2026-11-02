// 源代码管理视图：暂存/取消暂存/放弃更改、提交、分支切换、推送拉取、历史、差异对比，以及编辑器行内修改标记。
import { ctx } from './state.js';
import { bus, path, escapeHtml, fileIcon, debounce, h } from './util.js';
import { icon } from './icons.js';
import { toast, confirm, prompt, showMenu, contextMenu } from './ui.js';
import * as editors from './editors.js';
import { log } from './output.js';

let view;
let body;
let status = null;
const sectionCollapsed = { staged: false, changes: false, log: true };

export function getStatus() {
  return status;
}

export async function refreshGit() {
  if (!ctx.root) {
    status = null;
    render();
    bus.emit('git:status', null);
    return;
  }
  status = await window.ide.git.status(ctx.root);
  render();
  bus.emit('git:status', status);
  const badge = document.getElementById('git-badge');
  const n = status && status.isRepo ? status.files.length : 0;
  badge.hidden = !n;
  badge.textContent = n > 99 ? '99+' : n;
  updateGutter();
}

const STATUS_LABEL = { M: '已修改', A: '已添加', D: '已删除', R: '已重命名', C: '已复制', U: '冲突', '?': '未跟踪' };

function letter(code) {
  return code === '?' ? 'U' : code;
}

function render() {
  const title = view.querySelector('.view-title');
  if (!ctx.root) {
    title.textContent = '源代码管理';
    body.innerHTML = `<div class="empty">${icon('git')}<div>打开文件夹后即可使用 Git</div></div>`;
    return;
  }
  if (!status || !status.isRepo) {
    title.textContent = '源代码管理';
    body.innerHTML = `<div class="empty">${icon('git')}<div>当前文件夹不是 Git 仓库${status && status.error ? '<br><span style="font-size:12px">' + escapeHtml(status.error) + '</span>' : ''}</div><button class="btn btn-primary btn-sm">初始化仓库</button></div>`;
    body.querySelector('button').onclick = async () => {
      try {
        await window.ide.git.init(ctx.root);
        toast('已初始化 Git 仓库', 'success');
        refreshGit();
      } catch (err) {
        toast(err.message, 'error');
      }
    };
    return;
  }
  title.textContent = '源代码管理';
  const staged = status.files.filter((f) => f.index !== ' ' && f.index !== '?');
  const changes = status.files.filter((f) => f.worktree !== ' ' || f.index === '?');
  const prevMsg = body.querySelector('textarea') ? body.querySelector('textarea').value : '';
  body.innerHTML = '';

  const branchBar = h(`<div class="git-branch-bar">${icon('branch')}<b>${escapeHtml(status.branch || '(无分支)')}</b>${status.upstream ? `<span class="muted">→ ${escapeHtml(status.upstream)}</span>` : ''}${status.ahead ? `<span class="tabular">↑${status.ahead}</span>` : ''}${status.behind ? `<span class="tabular">↓${status.behind}</span>` : ''}</div>`);
  body.appendChild(branchBar);

  const box = h(`<div class="commit-box"><textarea class="input" placeholder="提交信息（Ctrl+Enter 提交）" spellcheck="false"></textarea><div class="row-btns"><button class="btn btn-primary btn-sm">${icon('check')} 提交</button><button class="btn btn-sm" title="更多">${icon('more')}</button></div></div>`);
  const ta = box.querySelector('textarea');
  ta.value = prevMsg;
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) doCommit(ta);
  });
  const [commitBtn, moreBtn] = box.querySelectorAll('button');
  commitBtn.onclick = () => doCommit(ta);
  moreBtn.onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    showMenu(
      [
        { label: '提交（修正上次提交）', action: () => doCommit(ta, { amend: true }) },
        { label: '提交全部（含未暂存）', action: () => doCommit(ta, { all: true }) },
        { type: 'sep' },
        { label: '拉取 (pull)', icon: 'download', action: () => remote(['pull']) },
        { label: '推送 (push)', icon: 'upload', action: () => remote(status.upstream ? ['push'] : ['push', '-u', 'origin', status.branch]) },
        { label: '获取 (fetch)', icon: 'sync', action: () => remote(['fetch', '--all', '--prune']) },
        { type: 'sep' },
        { label: '切换分支…', icon: 'branch', action: switchBranch },
        { label: '新建分支…', action: createBranch },
        { type: 'sep' },
        { label: '暂存全部更改', action: () => stage(changes.map((f) => f.path)) },
        { label: '取消暂存全部', action: () => unstage(staged.map((f) => f.path)) },
        { label: '储藏 (stash)', action: () => remote(['stash', 'push', '-u']) },
        { label: '弹出储藏 (stash pop)', action: () => remote(['stash', 'pop']) },
      ],
      r.left,
      r.bottom + 4,
    );
  };
  body.appendChild(box);

  if (staged.length) body.appendChild(section('staged', '暂存的更改', staged, true));
  body.appendChild(section('changes', '更改', changes, false));
  if (!status.files.length) body.appendChild(h(`<div class="empty" style="padding:20px">${icon('check')}<div>工作区很干净，没有需要提交的更改</div></div>`));
  body.appendChild(logSection());
}

function section(key, title, files, isStaged) {
  const wrap = document.createElement('div');
  const head = h(`<div class="section-title${sectionCollapsed[key] ? ' collapsed' : ''}">${icon('chevronDown')}<span>${title}</span>
    <span class="count">${files.length}</span></div>`);
  const acts = h(`<span class="acts" style="display:flex;margin-left:4px"></span>`);
  const btn = (ic, t, fn) => {
    const b = h(`<button class="icon-btn" title="${t}" style="width:22px;height:22px">${icon(ic)}</button>`);
    b.onclick = (e) => {
      e.stopPropagation();
      fn();
    };
    acts.appendChild(b);
  };
  if (isStaged) btn('minus', '取消暂存全部', () => unstage(files.map((f) => f.path)));
  else if (files.length) {
    btn('undo', '放弃全部更改', () => discard(files));
    btn('plus', '暂存全部', () => stage(files.map((f) => f.path)));
  }
  head.appendChild(acts);
  head.onclick = () => {
    sectionCollapsed[key] = !sectionCollapsed[key];
    render();
  };
  wrap.appendChild(head);
  if (sectionCollapsed[key]) return wrap;
  for (const f of files) {
    const code = isStaged ? f.index : f.index === '?' ? '?' : f.worktree;
    const L = letter(code);
    const dir = path.dirname(f.rel) === f.rel ? '' : f.rel.split('/').slice(0, -1).join('/');
    const row = h(`<div class="git-row" title="${escapeHtml(f.rel)} · ${STATUS_LABEL[code] || code}">${fileIcon(path.basename(f.rel))}<span class="name git-name-${L}">${escapeHtml(path.basename(f.rel))}</span><span class="dir">${escapeHtml(dir)}</span><span class="acts"></span><span class="st git-${L}">${L}</span></div>`);
    const acts2 = row.querySelector('.acts');
    const b = (ic, t, fn) => {
      const x = h(`<button class="icon-btn" title="${t}">${icon(ic)}</button>`);
      x.onclick = (e) => {
        e.stopPropagation();
        fn();
      };
      acts2.appendChild(x);
    };
    b('openFile', '打开文件', () => editors.openFile(f.path, { pinned: true }));
    if (isStaged) b('minus', '取消暂存', () => unstage([f.path]));
    else {
      b('undo', '放弃更改', () => discard([f]));
      b('plus', '暂存更改', () => stage([f.path]));
    }
    row.onclick = () => {
      if (code === '?' || code === 'A' || code === 'D') editors.openFile(f.path, { preview: true }).catch(() => {});
      else editors.openDiff(f.path, isStaged ? 'HEAD' : 'HEAD');
    };
    row.addEventListener('contextmenu', (e) =>
      contextMenu(e, [
        { label: '打开更改', action: () => editors.openDiff(f.path, 'HEAD') },
        { label: '打开文件', action: () => editors.openFile(f.path, { pinned: true }) },
        { type: 'sep' },
        isStaged ? { label: '取消暂存', action: () => unstage([f.path]) } : { label: '暂存更改', action: () => stage([f.path]) },
        !isStaged && { label: '放弃更改', action: () => discard([f]) },
        { type: 'sep' },
        { label: '在资源管理器中显示', action: () => bus.emit('explorer:reveal', f.path) },
        { label: '添加到 .gitignore', action: () => addToGitignore(f.rel) },
      ]),
    );
    wrap.appendChild(row);
  }
  return wrap;
}

function logSection() {
  const wrap = document.createElement('div');
  const head = h(`<div class="section-title${sectionCollapsed.log ? ' collapsed' : ''}">${icon('chevronDown')}<span>提交历史</span></div>`);
  head.onclick = () => {
    sectionCollapsed.log = !sectionCollapsed.log;
    render();
  };
  wrap.appendChild(head);
  if (!sectionCollapsed.log) {
    const list = h('<div><div class="muted" style="padding:6px 12px;font-size:12px">加载中…</div></div>');
    wrap.appendChild(list);
    window.ide.git.log(ctx.root, 80).then((items) => {
      list.innerHTML = items.length ? '' : '<div class="muted" style="padding:6px 12px;font-size:12px">还没有提交</div>';
      for (const c of items) {
        const refs = c.refs ? c.refs.split(', ').filter(Boolean).map((r) => `<span class="ref">${escapeHtml(r.replace('HEAD -> ', ''))}</span> `).join('') : '';
        list.appendChild(h(`<div class="log-item" title="${escapeHtml(c.subject)}"><div class="subj">${refs}${escapeHtml(c.subject)}</div><div class="meta">${escapeHtml(c.hash)} · ${escapeHtml(c.author)} · ${escapeHtml(c.date)}</div></div>`));
      }
    });
  }
  return wrap;
}

async function wrap(fn, okMsg) {
  try {
    const out = await fn();
    if (out) log('Git', out);
    if (okMsg) toast(okMsg, 'success');
  } catch (err) {
    log('Git', err.message);
    toast(err.message.split('\n')[0], 'error', 5000);
  }
  refreshGit();
}

const stage = (paths) => paths.length && wrap(() => window.ide.git.stage(ctx.root, paths));
const unstage = (paths) => paths.length && wrap(() => window.ide.git.unstage(ctx.root, paths));

async function discard(files) {
  const r = await confirm({ title: '放弃更改', message: files.length === 1 ? `确定放弃对“${path.basename(files[0].rel)}”的更改吗？此操作不可撤销。` : `确定放弃 ${files.length} 个文件的更改吗？此操作不可撤销。`, buttons: ['放弃更改', '取消'], danger: true });
  if (r !== 0) return;
  await wrap(() => window.ide.git.discard(ctx.root, files.map((f) => ({ path: f.path, untracked: f.index === '?' }))));
  await editors.onExternalChange(files.map((f) => f.path));
}

async function doCommit(ta, opts = {}) {
  const msg = ta.value.trim();
  if (!msg) {
    toast('请输入提交信息', 'error');
    ta.focus();
    return;
  }
  const staged = status.files.filter((f) => f.index !== ' ' && f.index !== '?');
  if (!staged.length && !opts.all && !opts.amend) {
    const r = await confirm({ title: '没有暂存的更改', message: '要暂存所有更改并直接提交吗？', buttons: ['全部暂存并提交', '取消'] });
    if (r !== 0) return;
    await window.ide.git.stage(ctx.root, ['.']);
  }
  await editors.saveAll();
  await wrap(async () => {
    const out = await window.ide.git.commit(ctx.root, msg, opts);
    ta.value = '';
    return out;
  }, '提交成功');
}

async function remote(args) {
  toast(`正在执行 git ${args[0]}…`);
  await wrap(() => window.ide.git.run(ctx.root, args), `git ${args[0]} 完成`);
  editors.onExternalChange(editors.allDocs().map((d) => d.path));
}

export async function switchBranch() {
  if (!status || !status.isRepo) return;
  const list = await window.ide.git.branches(ctx.root);
  const { openPicker } = await import('./palette.js');
  openPicker({
    placeholder: '选择要切换到的分支',
    items: [{ label: '+ 新建分支…', action: createBranch }, ...list.map((b) => ({ label: b.name, desc: b.current ? '当前分支' : b.remote ? '远程分支' : '', action: () => checkout(b.remote ? b.name.replace(/^[^/]+\//, '') : b.name) }))],
  });
}

async function checkout(name) {
  await wrap(() => window.ide.git.checkout(ctx.root, name, false), `已切换到 ${name}`);
  editors.onExternalChange(editors.allDocs().map((d) => d.path));
}

async function createBranch() {
  const name = await prompt({ title: '新建分支', placeholder: '分支名称', validate: (v) => (/\s/.test(v) ? '分支名不能包含空格' : null) });
  if (name) await wrap(() => window.ide.git.checkout(ctx.root, name, true), `已创建并切换到 ${name}`);
}

async function addToGitignore(rel) {
  const file = path.join(ctx.root, '.gitignore');
  const cur = (await window.ide.fs.exists(file)) ? (await window.ide.fs.readFile(file)).content || '' : '';
  await window.ide.fs.writeFile(file, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + rel + '\n');
  refreshGit();
}

// ---------------- 编辑器行号旁的修改标记 ----------------

const gutterDecos = new WeakMap();

async function updateGutterFor(editor) {
  const model = editor.getModel();
  if (!model || model.uri.scheme !== 'file' || !status || !status.isRepo) return;
  const p = model.uri.fsPath;
  const changes = await window.ide.git.lineChanges(ctx.root, p);
  const deco = changes.map((c) => ({
    range: new ctx.monaco.Range(c.start, 1, c.end, 1),
    options: {
      isWholeLine: true,
      linesDecorationsClassName: `git-gutter-${c.type}`,
      overviewRuler: { color: c.type === 'added' ? '#34c75980' : c.type === 'deleted' ? '#ff3b3080' : '#0a84ff80', position: ctx.monaco.editor.OverviewRulerLane.Left },
    },
  }));
  let col = gutterDecos.get(editor);
  if (!col) {
    col = editor.createDecorationsCollection();
    gutterDecos.set(editor, col);
  }
  if (editor.getModel() === model) col.set(deco);
}

function updateGutter() {
  for (const g of editors.allGroups()) if (g.active && g.active.type === 'file') updateGutterFor(g.editor);
}

export function initGit() {
  view = document.querySelector('.view[data-view=git]');
  view.innerHTML = `<div class="view-header"><span class="view-title">源代码管理</span>
    <div class="view-actions">
      <button class="icon-btn" data-a="branch" title="切换分支">${icon('branch')}</button>
      <button class="icon-btn" data-a="pull" title="拉取">${icon('download')}</button>
      <button class="icon-btn" data-a="push" title="推送">${icon('upload')}</button>
      <button class="icon-btn" data-a="refresh" title="刷新">${icon('refresh')}</button>
    </div></div><div class="view-body"></div>`;
  body = view.querySelector('.view-body');
  view.querySelector('[data-a=refresh]').onclick = refreshGit;
  view.querySelector('[data-a=branch]').onclick = switchBranch;
  view.querySelector('[data-a=pull]').onclick = () => status && status.isRepo && remote(['pull']);
  view.querySelector('[data-a=push]').onclick = () => status && status.isRepo && remote(status.upstream ? ['push'] : ['push', '-u', 'origin', status.branch]);
  const debounced = debounce(refreshGit, 500);
  bus.on('doc:saved', debounced);
  bus.on('fs:changed', debounced);
  bus.on('editor:active', (tab, group) => tab && tab.type === 'file' && group && updateGutterFor(group.editor));
  render();
}
