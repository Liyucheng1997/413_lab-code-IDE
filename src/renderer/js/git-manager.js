// Git 管理页：仓库概览（本地与 GitHub 对比、同步状态）、提交历史与详情、分支、标签、远程、储藏，以及发布到 GitHub。
import { ctx } from './state.js';
import { bus, path, escapeHtml, h, debounce, fileIcon } from './util.js';
import { icon } from './icons.js';
import { toast, confirm, prompt, modal, showMenu } from './ui.js';
import * as editors from './editors.js';
import { gitOp, fetchNow, pullNow, pushNow, syncNow, gitBusy, friendlyError } from './git-view.js';

const TABS = [
  ['overview', '概览'],
  ['history', '提交历史'],
  ['branches', '分支'],
  ['tags', '标签'],
  ['remotes', '远程'],
  ['stashes', '储藏'],
];

let current = 'overview';
let host = null; // 当前挂载的 .gm 元素
let root = null; // info 对应的工作区
let info = null;
let cmp = null; // 与上游的差异：incoming / outgoing
let gh = null; // GitHub 仓库信息，或 { error }
let ghKey = '';
let ghLoading = false;
let ghMissing = new Set(); // GitHub 最近提交里本地还没有的
let ghStale = false;
let remoteTags = null; // 远程上的标签名 → sha
let hist = { items: [], query: '', all: false, done: false, selected: null, detail: null, loading: false };
let stashOpen = null;
let stashDetail = null;

const S = (s) => escapeHtml(s == null ? '' : String(s));
const run = (args) => window.ide.git.run(ctx.root, args);

function ago(t) {
  if (!t) return '从未';
  const s = Math.max(0, (Date.now() - new Date(t).getTime()) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`;
  return new Date(t).toLocaleDateString();
}

function mainRemote() {
  if (!info || !info.remotes || !info.remotes.length) return null;
  const up = info.upstream && info.upstream.split('/')[0];
  return info.remotes.find((r) => r.name === up) || info.remotes.find((r) => r.name === 'origin') || info.remotes[0];
}

function githubRemote() {
  const r = mainRemote();
  return r && r.github ? r : (info && info.remotes.find((x) => x.github)) || null;
}

// 远程上对应的分支名：origin/main → main
function remoteBranch() {
  const r = mainRemote();
  return r && info.upstream && info.upstream.startsWith(r.name + '/') ? info.upstream.slice(r.name.length + 1) : '';
}

export async function openGitManager(tab, commit) {
  if (!ctx.root) return toast('请先打开一个文件夹', 'error');
  if (tab) current = tab;
  if (commit) hist.selected = commit;
  await editors.openHtmlTab({ key: 'git-manager', title: 'Git 管理', iconText: icon('git'), html: '<div class="gm"></div>', mount });
  if (commit && host) loadDetail(commit);
}

function mount(aux) {
  host = aux.querySelector('.gm');
  if (root !== ctx.root) reset();
  render();
  load();
}

function reset() {
  root = ctx.root;
  info = cmp = gh = remoteTags = stashDetail = null;
  stashOpen = null;
  ghKey = '';
  ghMissing = new Set();
  hist = { items: [], query: '', all: false, done: false, selected: hist.selected, detail: null, loading: false };
}

const alive = () => host && host.isConnected;

async function load() {
  const r = ctx.root;
  if (!r) return;
  const [i, c] = await Promise.all([window.ide.git.info(r), window.ide.git.compare(r).catch(() => null)]);
  if (r !== ctx.root) return;
  if (root !== r) reset();
  info = i;
  cmp = c;
  if (current === 'history' && !hist.items.length) loadHistory();
  if (current === 'history' && hist.selected && !hist.detail) loadDetail(hist.selected);
  if (current === 'tags' && !remoteTags) loadRemoteTags();
  if (gh && !ghStale) await checkMissing();
  if (alive()) render();
  loadGithub(ghStale);
}

async function loadGithub(force = false) {
  const r = githubRemote();
  if (!r) return;
  const key = `${r.github.owner}/${r.github.repo}@${remoteBranch()}`;
  if (!force && (ghKey === key || ghLoading)) return;
  ghKey = key;
  ghLoading = true;
  ghStale = false;
  if (alive()) render();
  try {
    gh = await window.ide.github.repo(r.github.owner, r.github.repo, remoteBranch() || undefined);
    await checkMissing();
  } catch (err) {
    gh = { error: friendlyError(err.message) };
  }
  ghLoading = false;
  if (alive()) render();
}

// GitHub 最近的提交本地有没有（获取之后会变，所以每次刷新都查一遍，不用再访问 GitHub）
async function checkMissing() {
  if (!gh || !gh.commits) return;
  const checks = await Promise.all(gh.commits.slice(0, 8).map((c) => run(['cat-file', '-t', c.sha]).then(() => null, () => c.sha)));
  ghMissing = new Set(checks.filter(Boolean));
}

async function loadRemoteTags() {
  const r = mainRemote();
  if (!r) return;
  remoteTags = 'loading';
  try {
    const out = await run(['ls-remote', '--tags', r.name]);
    const map = new Map();
    for (const l of out.split(/\r?\n/)) {
      const m = l.match(/^(\w+)\s+refs\/tags\/(.+?)(\^\{\})?$/);
      if (m && !m[3]) map.set(m[2], m[1]);
    }
    remoteTags = map;
  } catch (err) {
    remoteTags = { error: friendlyError(err.message) };
  }
  if (alive() && current === 'tags') renderBody();
}

async function loadHistory(more = false) {
  if (hist.loading) return;
  hist.loading = true;
  const q = hist.query;
  const items = await window.ide.git.logPage(ctx.root, { n: 150, skip: more ? hist.items.length : 0, all: hist.all, query: q }).catch(() => []);
  hist.loading = false;
  if (q !== hist.query) return;
  hist.items = more ? hist.items.concat(items) : items;
  hist.done = items.length < 150;
  updateHistory();
}

// 只更新列表和详情，不重建搜索框（否则输入时会丢焦点）
function updateHistory() {
  if (!alive() || current !== 'history') return;
  const list = host.querySelector('.gm-hitems');
  if (!list) return renderBody();
  renderHistList(list);
  renderDetail(host.querySelector('.gm-hdetail'));
}

async function loadDetail(ref) {
  hist.selected = ref;
  hist.detail = 'loading';
  updateHistory();
  try {
    hist.detail = await window.ide.git.commitDetail(ctx.root, ref);
  } catch (err) {
    hist.detail = { error: friendlyError(err.message) };
  }
  if (hist.selected === ref) updateHistory();
}

// 刷新：重新读取本地信息，GitHub 信息也重新拉
function refreshAll() {
  ghStale = true;
  remoteTags = null;
  hist.items = [];
  hist.detail = null;
  load();
}

// ---------------- 渲染 ----------------

function render() {
  if (!alive()) return;
  if (info && !info.isRepo) {
    host.innerHTML = `<div class="empty" style="padding-top:80px">${icon('git')}<div>当前文件夹还不是 Git 仓库</div><button class="btn btn-primary btn-sm">初始化仓库</button></div>`;
    host.querySelector('button').onclick = () => gitOp('初始化仓库', () => window.ide.git.init(ctx.root), { okMsg: '已初始化 Git 仓库' }).then(refreshAll);
    return;
  }
  const name = info ? path.basename(info.top) : path.basename(ctx.root);
  const prev = host.querySelector('.gm-body');
  const scroll = prev ? prev.scrollTop : 0;
  host.innerHTML = `<div class="gm-head">
      <div class="gm-title"><div class="gm-name">${icon('git')}<span>${S(name)}</span></div><div class="gm-sub"></div></div>
      <div class="gm-actions"></div>
    </div>
    <div class="gm-tabs"><div class="seg">${TABS.map(([k, l]) => `<button data-t="${k}" class="${k === current ? 'active' : ''}">${l}<span class="count"></span></button>`).join('')}</div></div>
    <div class="gm-body"></div>`;
  host.querySelectorAll('[data-t]').forEach((b) => {
    b.onclick = () => {
      current = b.dataset.t;
      host.querySelectorAll('[data-t]').forEach((x) => x.classList.toggle('active', x === b));
      renderBody();
      if (current === 'history' && !hist.items.length) loadHistory();
      if (current === 'history' && hist.selected && !hist.detail) loadDetail(hist.selected);
      if (current === 'tags' && !remoteTags) loadRemoteTags();
    };
  });
  renderHead();
  renderBody();
  host.querySelector('.gm-body').scrollTop = scroll;
}

function renderHead() {
  if (!alive() || !info) return;
  const busy = gitBusy();
  const sub = host.querySelector('.gm-sub');
  sub.innerHTML = `<span class="gm-chip">${icon('branch')}${S(info.branch || '(无分支)')}</span>${info.upstream ? `<span class="muted">跟踪 ${S(info.upstream)}</span>` : ''}<span class="muted">· 上次获取 ${ago(info.lastFetch)}</span>${busy ? `<span class="gm-busy">${icon('refresh', 'spin')}正在${S(busy)}…</span>` : ''}`;
  const acts = host.querySelector('.gm-actions');
  const hasRemote = info.remotes.length > 0;
  acts.innerHTML = '';
  const add = (label, ic, fn, { primary = false, title = '', disabled = false } = {}) => {
    const b = h(`<button class="btn btn-sm${primary ? ' btn-primary' : ''}" title="${S(title)}">${icon(ic)}<span>${label}</span></button>`);
    b.disabled = disabled || !!busy;
    b.onclick = fn;
    acts.appendChild(b);
  };
  if (hasRemote) {
    add('获取', 'cloud', () => fetchNow(), { title: '从远程获取最新状态（不改动工作区）' });
    add(`拉取${info.behind ? ' ' + info.behind : ''}`, 'download', pullNow, { disabled: !info.upstream });
    add(`推送${info.ahead ? ' ' + info.ahead : ''}`, 'upload', pushNow);
    add(info.upstream ? '同步' : '发布分支', 'sync', syncNow, { primary: true, title: info.upstream ? '拉取远程的新提交，再推送本地提交' : '推送当前分支并建立跟踪' });
  } else {
    add('发布到 GitHub', 'cloud', publishDialog, { primary: true });
  }
  const r = h(`<button class="icon-btn" title="刷新">${icon('refresh')}</button>`);
  r.onclick = refreshAll;
  acts.appendChild(r);
  const counts = { branches: info.branches.length, tags: info.tags.length, remotes: info.remotes.length, stashes: info.stashes.length, history: info.commitCount };
  host.querySelectorAll('[data-t]').forEach((b) => (b.querySelector('.count').textContent = counts[b.dataset.t] ? counts[b.dataset.t] : ''));
}

function renderBody() {
  if (!alive()) return;
  const body = host.querySelector('.gm-body');
  if (!body) return;
  if (!info) {
    body.innerHTML = `<div class="empty">${icon('refresh', 'spin')}<div>正在读取仓库信息…</div></div>`;
    return;
  }
  const scroll = body.scrollTop;
  body.innerHTML = '';
  ({ overview, history, branches, tags, remotes, stashes })[current](body);
  body.scrollTop = scroll;
}

// 按钮工具
function btn(label, fn, { cls = 'btn btn-sm', ic, title = '' } = {}) {
  const b = h(`<button class="${cls}" title="${S(title)}">${ic ? icon(ic) : ''}${label ? `<span>${label}</span>` : ''}</button>`);
  b.onclick = (e) => {
    e.stopPropagation();
    fn(e);
  };
  return b;
}

function menuBtn(items) {
  return btn('', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    showMenu(items.filter(Boolean), r.left, r.bottom + 4);
  }, { cls: 'icon-btn', ic: 'more', title: '更多操作' });
}

function card(title, extra = '') {
  return h(`<div class="gm-card"><div class="gm-card-title"><span>${title}</span>${extra}</div><div class="gm-card-body"></div></div>`);
}

function kv(rows) {
  return h(`<div class="gm-kv">${rows.filter(Boolean).map(([k, v]) => `<div class="k">${k}</div><div class="v">${v}</div>`).join('')}</div>`);
}

function refsHtml(refs) {
  if (!refs) return '';
  return refs
    .split(', ')
    .filter(Boolean)
    .map((r) => {
      const t = r.replace('HEAD -> ', '');
      const cls = r.startsWith('tag: ') ? 'tag' : r.startsWith('HEAD') ? 'head' : t.includes('/') ? 'remote' : '';
      return `<span class="gm-ref ${cls}">${S(t.replace('tag: ', ''))}</span>`;
    })
    .join('');
}

function commitRow(c, { onClick, extra = '' } = {}) {
  const row = h(`<div class="gm-commit${hist.selected && (hist.selected === c.hash || hist.selected === c.full) && current === 'history' ? ' selected' : ''}"><div class="subj">${refsHtml(c.refs)}${S(c.subject)}</div><div class="meta"><span class="mono">${S(c.hash)}</span> · ${S(c.author)} · ${S(c.date)}${extra}</div></div>`);
  row.onclick = onClick || (() => openCommit(c.full || c.hash));
  return row;
}

function openCommit(ref) {
  current = 'history';
  render();
  if (!hist.items.length) loadHistory();
  loadDetail(ref);
}

// ---------------- 概览 ----------------

function overview(body) {
  body.appendChild(banner());
  const grid = h('<div class="gm-grid"></div>');
  grid.appendChild(localCard());
  grid.appendChild(remoteCard());
  body.appendChild(grid);
  if (cmp && (cmp.incoming.length || cmp.outgoing.length)) {
    const g2 = h('<div class="gm-grid"></div>');
    if (cmp.incoming.length) g2.appendChild(commitListCard(`待拉取 · ${cmp.incoming.length}`, cmp.incoming, '远程有、本地还没有的提交'));
    if (cmp.outgoing.length) g2.appendChild(commitListCard(`待推送 · ${cmp.outgoing.length}`, cmp.outgoing, '本地已提交、还没推送的提交'));
    body.appendChild(g2);
  }
}

function banner() {
  const r = mainRemote();
  let tone = 'ok';
  let ic = 'check';
  let text;
  let action = null;
  if (!r) {
    tone = 'info';
    ic = 'cloud';
    text = '这个仓库还没有远程仓库，代码只保存在本机';
    action = btn('发布到 GitHub', publishDialog, { cls: 'btn btn-sm btn-primary', ic: 'cloud' });
  } else if (!info.upstream) {
    tone = 'info';
    ic = 'upload';
    text = `分支 ${S(info.branch)} 还没有推送到 ${S(r.name)}`;
    action = btn('发布分支', syncNow, { cls: 'btn btn-sm btn-primary', ic: 'upload' });
  } else if (info.ahead && info.behind) {
    tone = 'warn';
    ic = 'warning';
    text = `本地与 ${S(info.upstream)} 已分叉：远程有 ${info.behind} 个新提交，本地有 ${info.ahead} 个未推送`;
    action = btn('同步', syncNow, { cls: 'btn btn-sm btn-primary', ic: 'sync' });
  } else if (info.behind) {
    tone = 'warn';
    ic = 'download';
    text = `${S(info.upstream)} 上有 ${info.behind} 个新提交，本地还没有`;
    action = btn('拉取', pullNow, { cls: 'btn btn-sm btn-primary', ic: 'download' });
  } else if (info.ahead) {
    tone = 'info';
    ic = 'upload';
    text = `有 ${info.ahead} 个本地提交还没推送到 ${S(info.upstream)}`;
    action = btn('推送', pushNow, { cls: 'btn btn-sm btn-primary', ic: 'upload' });
  } else {
    text = `已与 ${S(info.upstream)} 同步`;
  }
  const el = h(`<div class="gm-banner ${tone}">${icon(ic)}<div class="txt"><div>${text}</div><div class="muted">${info.files.length ? `工作区有 ${info.files.length} 个未提交的更改 · ` : ''}上次获取 ${ago(info.lastFetch)}，获取后才能看到远程的最新提交</div></div></div>`);
  if (action) el.appendChild(action);
  if (r) el.appendChild(btn('获取', () => fetchNow(), { ic: 'cloud' }));
  return el;
}

function localCard() {
  const c = card('本地仓库');
  const b = c.querySelector('.gm-card-body');
  const head = info.head;
  const latestTag = info.tags[0];
  b.appendChild(
    kv([
      ['位置', `<a class="gm-link" data-a="open">${S(info.top)}</a>`],
      ['当前分支', `${S(info.branch)}${info.upstream ? ` <span class="muted">→ ${S(info.upstream)}</span>` : ''}`],
      ['最新提交', head ? `<a class="gm-link mono" data-a="head">${S(head.short)}</a> ${S(head.subject)}<div class="muted">${S(head.author)} · ${S(head.date)}</div>` : '<span class="muted">还没有提交</span>'],
      ['提交总数', String(info.commitCount)],
      ['未提交更改', info.files.length ? `${info.files.length} 个文件` : '<span class="muted">无</span>'],
      ['最新标签', latestTag ? `${S(latestTag.name)} <span class="muted">${S(latestTag.date)}</span>` : '<span class="muted">无</span>'],
      ['提交身份', `${info.user.name ? `${S(info.user.name)} <span class="muted">&lt;${S(info.user.email)}&gt;</span>` : '<span style="color:var(--danger)">未设置</span>'} <a class="gm-link" data-a="ident">修改</a>`],
    ]),
  );
  b.querySelector('[data-a=open]').onclick = () => window.ide.app.openPath(info.top);
  const hd = b.querySelector('[data-a=head]');
  if (hd) hd.onclick = () => openCommit(head.hash);
  b.querySelector('[data-a=ident]').onclick = identityDialog;
  return c;
}

function remoteCard() {
  const r = githubRemote() || mainRemote();
  if (!r) {
    const c = card('GitHub');
    const b = c.querySelector('.gm-card-body');
    b.appendChild(h(`<div class="gm-note">把仓库发布到 GitHub 后，就能在这里看到 GitHub 上的版本、发布和提交，并一键同步。</div>`));
    const row = h('<div class="gm-btns"></div>');
    row.appendChild(btn('发布到 GitHub', publishDialog, { cls: 'btn btn-sm btn-primary', ic: 'cloud' }));
    row.appendChild(btn('添加已有的远程地址', addRemoteDialog, { ic: 'plus' }));
    b.appendChild(row);
    return c;
  }
  if (!r.github) {
    const c = card(`远程仓库 · ${S(r.name)}`);
    c.querySelector('.gm-card-body').appendChild(kv([['地址', `<span class="mono">${S(r.fetch)}</span>`], ['说明', '<span class="muted">不是 GitHub 仓库，只显示 Git 本身的同步状态</span>']]));
    return c;
  }
  const c = card('GitHub', `<a class="gm-link" data-a="web">在浏览器中打开</a>`);
  c.querySelector('[data-a=web]').onclick = () => window.ide.app.openExternal(r.web);
  const b = c.querySelector('.gm-card-body');
  if (ghLoading && !gh) {
    b.innerHTML = `<div class="gm-note">${icon('refresh', 'spin')} 正在读取 GitHub…</div>`;
    return c;
  }
  if (!gh || gh.error) {
    b.innerHTML = `<div class="gm-note">无法读取 GitHub：${S(gh ? gh.error : '')}</div>`;
    b.appendChild(btn('重试', () => loadGithub(true), { ic: 'refresh' }));
    return c;
  }
  if (!gh.found) {
    b.innerHTML = `<div class="gm-note">GitHub 上找不到 <b>${S(r.github.owner)}/${S(r.github.repo)}</b>。${gh.authenticated ? '仓库可能已删除或改名。' : '如果是私有仓库，请安装 GitHub CLI 并运行 <code>gh auth login</code> 登录。'}</div>`;
    return c;
  }
  const latest = gh.commits[0];
  let state = '';
  if (latest && info.head) {
    if (latest.sha === info.head.hash) state = `<span class="gm-pill ok">${icon('check')}与本地一致</span>`;
    else if (ghMissing.has(latest.sha)) state = `<span class="gm-pill warn">本地没有，需要拉取</span>`;
    else if (cmp && cmp.outgoing.some((x) => x.full === info.head.hash)) state = `<span class="gm-pill info">本地领先 ${cmp.outgoing.length} 个提交</span>`;
    else state = `<span class="gm-pill">与本地不同</span>`;
  }
  const localTags = new Set(info.tags.map((t) => t.name));
  const newTags = gh.tags.filter((t) => !localTags.has(t.name));
  b.appendChild(h(`<div class="gm-gh-head"><a class="gm-link gm-gh-name" data-a="repo">${S(gh.fullName)}</a><span class="gm-pill">${gh.private ? '私有' : '公开'}</span>${gh.authenticated ? '' : '<span class="gm-pill" title="未登录 gh，只能访问公开仓库">匿名访问</span>'}</div>`));
  if (gh.description) b.appendChild(h(`<div class="gm-gh-desc">${S(gh.description)}</div>`));
  b.appendChild(h(`<div class="gm-gh-stats"><span>★ ${gh.stars}</span><span>Fork ${gh.forks}</span><span>Issue ${gh.issues}</span><span>最近推送 ${ago(gh.pushedAt)}</span></div>`));
  b.appendChild(
    kv([
      ['默认分支', S(gh.defaultBranch)],
      latest && [`${S(gh.branch)} 最新`, `<a class="gm-link mono" data-a="latest">${S(latest.short)}</a> ${S(latest.subject)} ${state}<div class="muted">${S(latest.author)} · ${ago(latest.date)}</div>`],
      ['最新发布', gh.release ? `<a class="gm-link" data-a="release">${S(gh.release.name)}</a> <span class="muted">${S(gh.release.tag)} · ${ago(gh.release.date)}</span>${localTags.has(gh.release.tag) ? '' : ' <span class="gm-pill warn">本地没有此标签</span>'}` : '<span class="muted">还没有发布</span>'],
      newTags.length && ['新标签', `${newTags.map((t) => `<span class="gm-ref tag">${S(t.name)}</span>`).join('')} <a class="gm-link" data-a="fetchtags">获取到本地</a>`],
    ]),
  );
  const on = (a, fn) => {
    const el = b.querySelector(`[data-a=${a}]`);
    if (el) el.onclick = fn;
  };
  on('repo', () => window.ide.app.openExternal(gh.url));
  on('latest', () => window.ide.app.openExternal(latest.url));
  on('release', () => window.ide.app.openExternal(gh.release.url));
  on('fetchtags', () => fetchNow());
  if (gh.commits.length > 1) {
    const list = h(`<div class="gm-gh-commits"><div class="gm-sub-title">GitHub 上最近的提交</div></div>`);
    for (const x of gh.commits.slice(0, 6)) {
      const missing = ghMissing.has(x.sha);
      const row = h(`<div class="gm-commit${missing ? ' missing' : ''}" title="${missing ? '本地还没有这个提交' : '点击查看详情'}"><div class="subj">${S(x.subject)}</div><div class="meta"><span class="mono">${S(x.short)}</span> · ${S(x.author)} · ${ago(x.date)}${missing ? ' · <span style="color:var(--warning)">本地没有</span>' : ''}</div></div>`);
      row.onclick = () => (missing ? window.ide.app.openExternal(x.url) : openCommit(x.sha));
      list.appendChild(row);
    }
    b.appendChild(list);
  }
  return c;
}

function commitListCard(title, items, desc) {
  const c = card(title);
  const b = c.querySelector('.gm-card-body');
  b.appendChild(h(`<div class="muted" style="font-size:12px;margin-bottom:6px">${desc}</div>`));
  for (const x of items.slice(0, 30)) b.appendChild(commitRow(x));
  if (items.length > 30) b.appendChild(h(`<div class="muted" style="font-size:12px;padding:4px 8px">还有 ${items.length - 30} 个…</div>`));
  return c;
}

// ---------------- 提交历史 ----------------

function history(body) {
  const wrap = h(`<div class="gm-history"><div class="gm-hlist"><div class="gm-hbar"><input class="input" placeholder="搜索提交信息" spellcheck="false"><label class="gm-check"><input type="checkbox"> 全部分支</label></div><div class="gm-hitems"></div></div><div class="gm-hdetail"></div></div>`);
  const input = wrap.querySelector('.gm-hbar input');
  input.value = hist.query;
  input.oninput = debounce(() => {
    hist.query = input.value.trim();
    loadHistory();
  }, 300);
  const all = wrap.querySelector('.gm-check input');
  all.checked = hist.all;
  all.onchange = () => {
    hist.all = all.checked;
    loadHistory();
  };
  renderHistList(wrap.querySelector('.gm-hitems'));
  renderDetail(wrap.querySelector('.gm-hdetail'));
  body.appendChild(wrap);
}

function renderHistList(list) {
  const top = list.scrollTop;
  list.innerHTML = '';
  if (!hist.items.length) list.innerHTML = `<div class="muted" style="padding:12px">${!info.head ? '还没有提交' : hist.loading ? '加载中…' : hist.query ? '没有匹配的提交' : '加载中…'}</div>`;
  for (const c of hist.items) list.appendChild(commitRow(c, { onClick: () => loadDetail(c.full) }));
  if (hist.items.length && !hist.done) list.appendChild(btn('加载更多', () => loadHistory(true), { cls: 'btn btn-sm gm-more' }));
  list.scrollTop = top;
}

function renderDetail(el) {
  const d = hist.detail;
  if (!d) {
    el.innerHTML = `<div class="empty">${icon('history')}<div>选择一个提交查看详情</div></div>`;
    return;
  }
  if (d === 'loading') {
    el.innerHTML = `<div class="empty">${icon('refresh', 'spin')}<div>加载中…</div></div>`;
    return;
  }
  if (d.error) {
    el.innerHTML = `<div class="empty">${icon('warning')}<div>${S(d.error)}</div></div>`;
    return;
  }
  const rest = d.body.split('\n').slice(1).join('\n').trim();
  const ghr = githubRemote();
  el.innerHTML = `<div class="gm-dhead"><div class="gm-dsubj">${S(d.subject)}</div>${d.refs ? `<div style="margin-top:6px">${refsHtml(d.refs)}</div>` : ''}${rest ? `<pre class="gm-dbody">${S(rest)}</pre>` : ''}</div>`;
  el.appendChild(
    kv([
      ['提交', `<span class="mono">${S(d.hash)}</span> <a class="gm-link" data-a="copy">复制</a>`],
      ['作者', `${S(d.author)} <span class="muted">&lt;${S(d.email)}&gt;</span>`],
      ['时间', S(d.date)],
      d.parents.length && ['父提交', d.parents.map((p) => `<a class="gm-link mono" data-p="${S(p)}">${S(p.slice(0, 7))}</a>`).join(' ')],
    ]),
  );
  el.querySelector('[data-a=copy]').onclick = () => navigator.clipboard.writeText(d.hash).then(() => toast('已复制提交哈希', 'success'));
  el.querySelectorAll('[data-p]').forEach((a) => (a.onclick = () => loadDetail(a.dataset.p)));
  const acts = h('<div class="gm-btns"></div>');
  if (ghr) acts.appendChild(btn('在 GitHub 上查看', () => window.ide.app.openExternal(`${ghr.web}/commit/${d.hash}`), { ic: 'cloud' }));
  acts.appendChild(btn('从这里新建分支', () => newBranchDialog(d.hash, d.short), { ic: 'branch' }));
  acts.appendChild(
    menuBtn([
      { label: '检出此提交（分离 HEAD）', action: () => gitOp('检出', ['checkout', d.hash], { okMsg: `已检出 ${d.short}` }) },
      { label: '在此提交上打标签…', action: () => newTagDialog(d.hash) },
      { label: '挑选到当前分支 (cherry-pick)', action: () => gitOp('挑选提交', ['cherry-pick', d.hash]) },
      { type: 'sep' },
      { label: '撤销此提交 (revert)…', action: () => revertCommit(d) },
      { label: '将当前分支重置到这里…', action: () => resetTo(d) },
    ]),
  );
  el.appendChild(acts);
  const files = h(`<div class="gm-files"><div class="gm-sub-title">改动的文件 · ${d.files.length}<span class="muted" style="margin-left:auto;font-weight:400">+${d.files.reduce((n, f) => n + (f.added || 0), 0)} −${d.files.reduce((n, f) => n + (f.deleted || 0), 0)}</span></div></div>`);
  for (const f of d.files) files.appendChild(fileRow(f, d.hash, d.short));
  el.appendChild(files);
}

function fileRow(f, ref, short) {
  const dir = f.rel.includes('/') ? f.rel.split('/').slice(0, -1).join('/') : '';
  const L = f.status === 'R' ? 'R' : f.status;
  const row = h(`<div class="git-row" title="${S(f.from ? `${f.from} → ${f.rel}` : f.rel)}">${fileIcon(path.basename(f.rel))}<span class="name git-name-${L}">${S(path.basename(f.rel))}</span><span class="dir">${S(dir)}</span><span class="gm-num">${f.added == null ? '二进制' : `<span class="add">+${f.added}</span> <span class="del">−${f.deleted}</span>`}</span><span class="st git-${L}">${S(L)}</span></div>`);
  row.style.paddingLeft = '8px';
  row.onclick = async () => {
    const { before, after } = await window.ide.git.fileAtCommit(ctx.root, ref, f.rel, f.from);
    editors.openTextDiff({ path: path.join(info.top, f.rel), original: before, modified: after, title: `${path.basename(f.rel)} (${short}^ ↔ ${short})`, key: `commit:${ref}:${f.rel}` });
  };
  return row;
}

async function revertCommit(d) {
  const r = await confirm({ title: '撤销提交', message: `将新建一个提交，把“${d.subject}”带来的改动反向撤销。历史记录不会被改写，可以安全地推送。`, buttons: ['撤销', '取消'] });
  if (r === 0) gitOp('撤销提交', d.parents.length > 1 ? ['revert', '--no-edit', '-m', '1', d.hash] : ['revert', '--no-edit', d.hash]);
}

async function resetTo(d) {
  const r = await confirm({ title: `将 ${info.branch} 重置到 ${d.short}`, message: '之后的提交会从当前分支上移除。“保留更改”会把这些提交的改动留在工作区；“丢弃”会彻底删除它们以及所有未提交的更改。已推送的提交重置后需要强制推送。', buttons: ['保留更改', '丢弃所有更改', '取消'] });
  if (r === 0) gitOp('重置', ['reset', '--mixed', d.hash]);
  if (r === 1) {
    const sure = await confirm({ title: '确认丢弃', message: '未提交的更改和之后的提交都会丢失，确定继续吗？', buttons: ['丢弃', '取消'], danger: true });
    if (sure === 0) gitOp('重置', ['reset', '--hard', d.hash]);
  }
}

// ---------------- 分支 ----------------

function branches(body) {
  const bar = h('<div class="gm-btns" style="margin-bottom:12px"></div>');
  bar.appendChild(btn('新建分支', () => newBranchDialog(), { cls: 'btn btn-sm btn-primary', ic: 'plus' }));
  if (info.remotes.length) bar.appendChild(btn('获取远程分支', () => fetchNow(), { ic: 'refresh' }));
  body.appendChild(bar);

  const c = card(`本地分支 · ${info.branches.length}`);
  const b = c.querySelector('.gm-card-body');
  for (const br of info.branches) {
    let trk = '<span class="muted">未跟踪远程</span>';
    if (br.gone) trk = `<span class="gm-pill warn">远程分支已删除</span>`;
    else if (br.upstream) trk = `<span class="muted">→ ${S(br.upstream)}</span>${br.behind ? ` <span class="gm-pill warn">↓${br.behind}</span>` : ''}${br.ahead ? ` <span class="gm-pill info">↑${br.ahead}</span>` : ''}${!br.ahead && !br.behind ? ' <span class="gm-pill ok">已同步</span>' : ''}`;
    const row = h(`<div class="gm-row"><div class="main"><div class="title">${icon('branch')}<b>${S(br.name)}</b>${br.current ? '<span class="gm-pill ok">当前</span>' : ''} ${trk}</div><div class="meta"><span class="mono">${S(br.hash)}</span> · ${S(br.subject)} · ${S(br.date)}</div></div><div class="acts"></div></div>`);
    const acts = row.querySelector('.acts');
    if (!br.current) acts.appendChild(btn('切换', () => gitOp('切换分支', ['checkout', br.name], { okMsg: `已切换到 ${br.name}` })));
    acts.appendChild(
      menuBtn([
        !br.current && { label: `合并到 ${info.branch}`, action: () => mergeInto(br.name) },
        { label: br.upstream && !br.gone ? '推送' : '推送并跟踪远程', action: () => pushBranch(br) },
        { label: '查看提交', action: () => openCommit(br.name) },
        { type: 'sep' },
        { label: '重命名…', action: () => renameBranch(br.name) },
        !br.current && { label: '删除', action: () => deleteBranch(br.name) },
      ]),
    );
    b.appendChild(row);
  }
  body.appendChild(c);

  if (info.remoteBranches.length) {
    const c2 = card(`远程分支 · ${info.remoteBranches.length}`);
    const b2 = c2.querySelector('.gm-card-body');
    const local = new Set(info.branches.map((x) => x.name));
    for (const rb of info.remoteBranches) {
      const short = rb.name.replace(/^[^/]+\//, '');
      const row = h(`<div class="gm-row"><div class="main"><div class="title">${icon('cloud')}<b>${S(rb.name)}</b>${local.has(short) ? '<span class="muted">本地已有</span>' : ''}</div><div class="meta"><span class="mono">${S(rb.hash)}</span> · ${S(rb.subject)} · ${S(rb.date)}</div></div><div class="acts"></div></div>`);
      const acts = row.querySelector('.acts');
      if (!local.has(short)) acts.appendChild(btn('检出', () => gitOp('检出分支', ['checkout', '--track', rb.name], { okMsg: `已检出 ${short}` })));
      acts.appendChild(
        menuBtn([
          { label: `合并到 ${info.branch}`, action: () => mergeInto(rb.name) },
          { label: '查看提交', action: () => openCommit(rb.name) },
          { type: 'sep' },
          { label: '删除远程分支…', action: () => deleteRemoteBranch(rb.name) },
        ]),
      );
      b2.appendChild(row);
    }
    body.appendChild(c2);
  }
}

async function newBranchDialog(from, label) {
  const name = await prompt({ title: '新建分支', message: from ? `基于提交 ${label}` : `基于当前分支 ${info.branch}`, placeholder: '分支名称', validate: validRef });
  if (name) gitOp('新建分支', from ? ['checkout', '-b', name, from] : ['checkout', '-b', name], { okMsg: `已创建并切换到 ${name}` });
}

function validRef(v) {
  if (!v) return '请输入名称';
  if (/[\s~^:?*[\\]|\.\.|^[-/.]|[/.]$|\.lock$|@\{/.test(v)) return '名称不能包含空格或 ~ ^ : ? * [ \\ 等字符';
  return null;
}

async function mergeInto(name) {
  const r = await confirm({ title: '合并分支', message: `把 ${name} 合并到当前分支 ${info.branch}？`, buttons: ['合并', '取消'] });
  if (r === 0) gitOp('合并', ['merge', '--no-edit', name], { okMsg: `已合并 ${name}` });
}

function pushBranch(br) {
  const r = mainRemote();
  if (!r) return toast('还没有配置远程仓库', 'error');
  gitOp('推送', br.upstream && !br.gone ? ['push', r.name, br.name] : ['push', '-u', r.name, br.name], { okMsg: `已推送 ${br.name}` });
}

async function renameBranch(name) {
  const next = await prompt({ title: '重命名分支', value: name, validate: validRef });
  if (next && next !== name) gitOp('重命名分支', ['branch', '-m', name, next]);
}

async function deleteBranch(name) {
  const r = await confirm({ title: '删除分支', message: `删除本地分支 ${name}？`, buttons: ['删除', '取消'], danger: true });
  if (r !== 0) return;
  const ok = await gitOp('删除分支', ['branch', '-d', name], { quiet: true });
  if (ok) return toast(`已删除 ${name}`, 'success');
  const force = await confirm({ title: '分支尚未合并', message: `${name} 上有还没合并的提交，强制删除会丢失它们。仍要删除吗？`, buttons: ['强制删除', '取消'], danger: true });
  if (force === 0) gitOp('删除分支', ['branch', '-D', name]);
}

async function deleteRemoteBranch(full) {
  const [remote, ...rest] = full.split('/');
  const name = rest.join('/');
  const r = await confirm({ title: '删除远程分支', message: `将从 ${remote}（例如 GitHub）上删除分支 ${name}，其他人也将无法再获取它。`, buttons: ['删除', '取消'], danger: true });
  if (r === 0) gitOp('删除远程分支', ['push', remote, '--delete', name]);
}

// ---------------- 标签 ----------------

function tags(body) {
  const r = mainRemote();
  const bar = h('<div class="gm-btns" style="margin-bottom:12px"></div>');
  bar.appendChild(btn('新建标签', () => newTagDialog(), { cls: 'btn btn-sm btn-primary', ic: 'plus' }));
  if (r) {
    bar.appendChild(btn('推送全部标签', () => gitOp('推送标签', ['push', r.name, '--tags']).then(() => (remoteTags = null) || loadRemoteTags()), { ic: 'upload' }));
    bar.appendChild(btn('获取远程标签', () => fetchNow().then(() => loadRemoteTags()), { ic: 'download' }));
  }
  body.appendChild(bar);
  const loaded = remoteTags instanceof Map;
  if (remoteTags && remoteTags.error) body.appendChild(h(`<div class="gm-note" style="margin-bottom:10px">无法读取远程标签：${S(remoteTags.error)}</div>`));
  const ghr = githubRemote();
  const c = card(`本地标签 · ${info.tags.length}`);
  const b = c.querySelector('.gm-card-body');
  if (!info.tags.length) b.appendChild(h('<div class="muted" style="padding:8px">还没有标签。给发布的版本打上标签（例如 v1.0.0），方便以后找到它。</div>'));
  for (const t of info.tags) {
    let st = '';
    if (r) st = remoteTags === 'loading' ? '<span class="muted">检查中…</span>' : loaded ? (remoteTags.has(t.name) ? '<span class="gm-pill ok">已推送</span>' : '<span class="gm-pill warn">未推送</span>') : '';
    const row = h(`<div class="gm-row"><div class="main"><div class="title"><span class="gm-ref tag">${S(t.name)}</span>${st}</div><div class="meta"><a class="gm-link mono">${S(t.hash)}</a> · ${S(t.subject)} · ${S(t.date)}</div></div><div class="acts"></div></div>`);
    row.querySelector('.meta a').onclick = () => openCommit(t.hash);
    const acts = row.querySelector('.acts');
    if (r && loaded && !remoteTags.has(t.name)) acts.appendChild(btn('推送', () => gitOp('推送标签', ['push', r.name, `refs/tags/${t.name}`], { okMsg: `已推送 ${t.name}` }).then(loadRemoteTags)));
    acts.appendChild(
      menuBtn([
        ghr && { label: '在 GitHub 上查看', action: () => window.ide.app.openExternal(`${ghr.web}/releases/tag/${encodeURIComponent(t.name)}`) },
        { label: '检出此标签', action: () => gitOp('检出', ['checkout', t.name]) },
        { type: 'sep' },
        { label: '删除本地标签', action: () => deleteTag(t.name, false) },
        r && loaded && remoteTags.has(t.name) && { label: `同时从 ${r.name} 删除…`, action: () => deleteTag(t.name, true) },
      ]),
    );
    b.appendChild(row);
  }
  body.appendChild(c);
  if (loaded) {
    const local = new Set(info.tags.map((t) => t.name));
    const only = [...remoteTags.keys()].filter((n) => !local.has(n));
    if (only.length) {
      const c2 = card(`仅在 ${S(r.name)} 上的标签 · ${only.length}`, '');
      const b2 = c2.querySelector('.gm-card-body');
      b2.appendChild(h(`<div style="padding:4px 2px 8px">${only.map((n) => `<span class="gm-ref tag">${S(n)}</span>`).join(' ')}</div>`));
      b2.appendChild(btn('获取到本地', () => fetchNow().then(() => loadRemoteTags()), { ic: 'download' }));
      body.appendChild(c2);
    }
  }
}

async function newTagDialog(target) {
  const latest = info.tags[0] && info.tags[0].name;
  const vals = await form({
    title: '新建标签',
    sub: target ? `标记提交 ${target.slice(0, 7)}` : `标记当前提交 ${info.head ? info.head.short : ''}`,
    fields: [
      { key: 'name', label: '标签名', placeholder: latest ? `例如 ${bumpVersion(latest)}` : '例如 v1.0.0', value: latest ? bumpVersion(latest) : '', validate: validRef },
      { key: 'message', label: '说明（可选）', placeholder: '这个版本的说明' },
      mainRemote() && { key: 'push', label: `创建后推送到 ${mainRemote().name}`, type: 'check', value: true },
    ],
    ok: '创建',
  });
  if (!vals) return;
  const args = vals.message ? ['tag', '-a', vals.name, '-m', vals.message] : ['tag', vals.name];
  if (target) args.push(target);
  const ok = await gitOp('新建标签', args, { okMsg: `已创建标签 ${vals.name}` });
  if (ok && vals.push) await gitOp('推送标签', ['push', mainRemote().name, `refs/tags/${vals.name}`], { okMsg: `已推送标签 ${vals.name}` });
  remoteTags = null;
  if (current === 'tags') loadRemoteTags();
}

function bumpVersion(tag) {
  const m = tag.match(/^(.*?)(\d+)\.(\d+)\.(\d+)$/);
  return m ? `${m[1]}${m[2]}.${+m[3] + 1}.0` : '';
}

async function deleteTag(name, remote) {
  const r = mainRemote();
  const res = await confirm({ title: '删除标签', message: remote ? `从本地和 ${r.name} 上删除标签 ${name}？` : `删除本地标签 ${name}？远程上的同名标签不受影响。`, buttons: ['删除', '取消'], danger: true });
  if (res !== 0) return;
  if (remote) await gitOp('删除远程标签', ['push', r.name, '--delete', `refs/tags/${name}`], { quiet: true });
  await gitOp('删除标签', ['tag', '-d', name], { okMsg: `已删除标签 ${name}` });
  remoteTags = null;
  loadRemoteTags();
}

// ---------------- 远程 ----------------

function remotes(body) {
  const bar = h('<div class="gm-btns" style="margin-bottom:12px"></div>');
  bar.appendChild(btn('添加远程', addRemoteDialog, { cls: 'btn btn-sm' + (info.remotes.length ? '' : ' btn-primary'), ic: 'plus' }));
  if (!info.remotes.some((r) => r.github)) bar.appendChild(btn('发布到 GitHub', publishDialog, { cls: 'btn btn-sm btn-primary', ic: 'cloud' }));
  body.appendChild(bar);
  if (!info.remotes.length) {
    body.appendChild(h(`<div class="empty">${icon('cloud')}<div>还没有远程仓库<br><span style="font-size:12px">发布到 GitHub，或者添加一个已有仓库的地址（例如 https://github.com/用户名/仓库.git）</span></div></div>`));
    return;
  }
  for (const r of info.remotes) {
    const c = card(`${icon(r.github ? 'cloud' : 'git')}<span>${S(r.name)}</span>${r.github ? '<span class="gm-pill">GitHub</span>' : ''}`);
    const b = c.querySelector('.gm-card-body');
    b.appendChild(kv([['获取地址', `<span class="mono">${S(r.fetch)}</span>`], r.push && r.push !== r.fetch && ['推送地址', `<span class="mono">${S(r.push)}</span>`], r.github && ['GitHub', `<a class="gm-link" data-a="web">${S(r.github.owner)}/${S(r.github.repo)}</a>`]]));
    const web = b.querySelector('[data-a=web]');
    if (web) web.onclick = () => window.ide.app.openExternal(r.web);
    const acts = h('<div class="gm-btns"></div>');
    acts.appendChild(btn('获取', () => gitOp('获取', ['fetch', r.name, '--prune', '--tags']), { ic: 'refresh' }));
    acts.appendChild(btn('修改地址', () => editRemoteDialog(r), {}));
    acts.appendChild(btn('复制地址', () => navigator.clipboard.writeText(r.fetch).then(() => toast('已复制', 'success')), {}));
    acts.appendChild(
      menuBtn([
        { label: '重命名…', action: () => renameRemote(r.name) },
        { label: '移除…', action: () => removeRemote(r.name) },
      ]),
    );
    b.appendChild(acts);
    body.appendChild(c);
  }
}

async function addRemoteDialog() {
  const vals = await form({
    title: '添加远程仓库',
    fields: [
      { key: 'name', label: '名称', value: info.remotes.some((r) => r.name === 'origin') ? 'upstream' : 'origin', validate: validRef },
      { key: 'url', label: '地址', placeholder: 'https://github.com/用户名/仓库.git', validate: (v) => (v ? null : '请输入地址') },
    ],
    ok: '添加',
  });
  if (!vals) return;
  const ok = await gitOp('添加远程', ['remote', 'add', vals.name, vals.url], { okMsg: `已添加远程 ${vals.name}` });
  if (ok) gitOp('获取', ['fetch', vals.name], { quiet: true });
}

async function editRemoteDialog(r) {
  const url = await prompt({ title: `修改 ${r.name} 的地址`, value: r.fetch, validate: (v) => (v ? null : '请输入地址') });
  if (url && url !== r.fetch) gitOp('修改远程地址', ['remote', 'set-url', r.name, url]);
}

async function renameRemote(name) {
  const next = await prompt({ title: '重命名远程', value: name, validate: validRef });
  if (next && next !== name) gitOp('重命名远程', ['remote', 'rename', name, next]);
}

async function removeRemote(name) {
  const r = await confirm({ title: '移除远程', message: `移除远程 ${name}？只会删除本地的配置，远程仓库本身不受影响。`, buttons: ['移除', '取消'], danger: true });
  if (r === 0) gitOp('移除远程', ['remote', 'remove', name]);
}

export async function publishDialog() {
  if (!ctx.root) return;
  const st = await window.ide.github.status();
  if (!st.installed || !st.loggedIn) {
    const r = await confirm({
      title: '发布到 GitHub',
      message: st.installed ? '需要先登录 GitHub CLI：在终端中运行 gh auth login，按提示登录后再试。' : '一键发布需要 GitHub CLI（gh）。安装后在终端中运行 gh auth login 登录即可。也可以先在 GitHub 网页上新建仓库，再用“添加远程”填写地址。',
      buttons: [st.installed ? '知道了' : '下载 GitHub CLI', '添加远程地址', '取消'],
    });
    if (r === 0 && !st.installed) window.ide.app.openExternal('https://cli.github.com/');
    if (r === 1) addRemoteDialog();
    return;
  }
  const base = path.basename(ctx.root).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'my-project';
  const vals = await form({
    title: '发布到 GitHub',
    sub: `将以 ${st.user} 的身份在 GitHub 上新建仓库，设为 origin 并推送`,
    fields: [
      { key: 'name', label: '仓库名', value: base, validate: (v) => (/^[\w.-]+(\/[\w.-]+)?$/.test(v) ? null : '只能包含字母、数字、- _ .') },
      { key: 'description', label: '简介（可选）', placeholder: '一句话介绍这个项目' },
      { key: 'visibility', label: '可见性', type: 'seg', options: [['public', '公开'], ['private', '私有']], value: 'public' },
    ],
    ok: '发布',
  });
  if (!vals) return;
  if (!(await window.ide.git.status(ctx.root)).isRepo) await window.ide.git.init(ctx.root);
  const ok = await gitOp('发布到 GitHub', () => window.ide.github.publish(ctx.root, vals), { okMsg: '已发布到 GitHub' });
  if (ok) refreshAll();
}

// ---------------- 储藏 ----------------

function stashes(body) {
  const bar = h('<div class="gm-btns" style="margin-bottom:12px"></div>');
  bar.appendChild(btn('储藏当前更改', stashDialog, { cls: 'btn btn-sm btn-primary', ic: 'plus' }));
  body.appendChild(bar);
  if (!info.stashes.length) {
    body.appendChild(h(`<div class="empty">${icon('history')}<div>没有储藏<br><span style="font-size:12px">储藏可以把还没写完的改动先收起来，切换分支或拉取后再取回</span></div></div>`));
    return;
  }
  const c = card(`储藏 · ${info.stashes.length}`);
  const b = c.querySelector('.gm-card-body');
  for (const s of info.stashes) {
    const row = h(`<div class="gm-row clickable"><div class="main"><div class="title">${icon(stashOpen === s.ref ? 'chevronDown' : 'chevron')}<b class="mono">${S(s.ref)}</b> ${S(s.subject)}</div><div class="meta">${S(s.date)}</div></div><div class="acts"></div></div>`);
    row.onclick = () => toggleStash(s.ref);
    const acts = row.querySelector('.acts');
    acts.appendChild(btn('弹出', () => gitOp('弹出储藏', ['stash', 'pop', s.ref]), { title: '取回改动并删除这个储藏' }));
    acts.appendChild(
      menuBtn([
        { label: '应用（保留储藏）', action: () => gitOp('应用储藏', ['stash', 'apply', s.ref]) },
        { label: '删除…', action: () => dropStash(s.ref) },
      ]),
    );
    b.appendChild(row);
    if (stashOpen === s.ref) {
      const list = h('<div class="gm-stash-files"></div>');
      if (!stashDetail || stashDetail.ref !== s.ref) list.innerHTML = '<div class="muted" style="padding:6px 8px">加载中…</div>';
      else for (const f of stashDetail.files) list.appendChild(fileRow(f, s.ref, s.ref));
      b.appendChild(list);
    }
  }
  body.appendChild(c);
}

async function toggleStash(ref) {
  stashOpen = stashOpen === ref ? null : ref;
  renderBody();
  if (stashOpen && (!stashDetail || stashDetail.ref !== ref)) {
    const d = await window.ide.git.commitDetail(ctx.root, ref).catch(() => ({ files: [] }));
    stashDetail = { ref, files: d.files };
    renderBody();
  }
}

async function stashDialog() {
  if (!info.files.length) return toast('没有需要储藏的更改');
  const vals = await form({
    title: '储藏更改',
    fields: [
      { key: 'message', label: '说明（可选）', placeholder: '例如：写到一半的登录页' },
      { key: 'untracked', label: '包括未跟踪的新文件', type: 'check', value: true },
    ],
    ok: '储藏',
  });
  if (!vals) return;
  const args = ['stash', 'push'];
  if (vals.untracked) args.push('-u');
  if (vals.message) args.push('-m', vals.message);
  gitOp('储藏', args, { okMsg: '已储藏更改' });
}

async function dropStash(ref) {
  const r = await confirm({ title: '删除储藏', message: `删除 ${ref}？其中的改动将无法找回。`, buttons: ['删除', '取消'], danger: true });
  if (r === 0) {
    stashDetail = null;
    stashOpen = null;
    gitOp('删除储藏', ['stash', 'drop', ref]);
  }
}

// ---------------- 提交身份 ----------------

async function identityDialog() {
  const vals = await form({
    title: '提交身份',
    sub: '提交记录里显示的作者。用 GitHub 的邮箱，提交才会关联到你的 GitHub 账号',
    fields: [
      { key: 'name', label: '名字', value: info.user.name, validate: (v) => (v ? null : '请输入名字') },
      { key: 'email', label: '邮箱', value: info.user.email, validate: (v) => (/^\S+@\S+$/.test(v) ? null : '邮箱格式不正确') },
      { key: 'scope', label: '应用到', type: 'seg', options: [['local', '仅此仓库'], ['global', '所有仓库']], value: 'local' },
    ],
    ok: '保存',
  });
  if (!vals) return;
  const g = vals.scope === 'global' ? ['--global'] : [];
  await gitOp('保存提交身份', async () => {
    await run(['config', ...g, 'user.name', vals.name]);
    await run(['config', ...g, 'user.email', vals.email]);
    return '';
  }, { okMsg: '已保存提交身份' });
}

// ---------------- 通用表单弹窗 ----------------

function form({ title, sub, fields, ok = '确定' }) {
  fields = fields.filter(Boolean);
  return new Promise((resolve) => {
    const body = h(`<div class="modal-body gm-form">${sub ? `<div class="modal-sub">${S(sub)}</div>` : ''}${fields
      .map((f) => {
        if (f.type === 'check') return `<label class="gm-check"><input type="checkbox" data-k="${f.key}" ${f.value ? 'checked' : ''}> ${S(f.label)}</label>`;
        if (f.type === 'seg') return `<div class="gm-field"><div class="lbl">${S(f.label)}</div><div class="seg" data-k="${f.key}">${f.options.map(([v, l]) => `<button type="button" data-v="${v}" class="${v === f.value ? 'active' : ''}">${l}</button>`).join('')}</div></div>`;
        return `<div class="gm-field"><div class="lbl">${S(f.label)}</div><input class="input" data-k="${f.key}" spellcheck="false" placeholder="${S(f.placeholder || '')}" value="${S(f.value || '')}"></div>`;
      })
      .join('')}<div class="modal-sub gm-err" hidden></div></div>`);
    const footer = h(`<div class="modal-footer"><button class="btn" data-a="cancel">取消</button><button class="btn btn-primary" data-a="ok">${S(ok)}</button></div>`);
    const m = modal({ title, body, footer, width: 460, onClose: (v) => resolve(v) });
    body.querySelectorAll('.seg').forEach((seg) =>
      seg.querySelectorAll('button').forEach((b) => (b.onclick = () => seg.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b)))),
    );
    const err = body.querySelector('.gm-err');
    const submit = () => {
      const vals = {};
      for (const f of fields) {
        const el = body.querySelector(`[data-k="${f.key}"]`);
        vals[f.key] = f.type === 'check' ? el.checked : f.type === 'seg' ? el.querySelector('.active').dataset.v : el.value.trim();
        const problem = f.validate && f.validate(vals[f.key]);
        if (problem) {
          err.textContent = `${f.label}：${problem}`;
          err.hidden = false;
          return;
        }
      }
      m.close(vals);
    };
    body.querySelectorAll('input.input').forEach((i) => i.addEventListener('keydown', (e) => e.key === 'Enter' && submit()));
    footer.querySelector('[data-a=ok]').onclick = submit;
    footer.querySelector('[data-a=cancel]').onclick = () => m.close(null);
    setTimeout(() => {
      const first = body.querySelector('input.input');
      if (first) (first.focus(), first.select());
    });
  });
}

// ---------------- 克隆 ----------------

export async function cloneRepo() {
  const url = await prompt({ title: '克隆仓库', message: '输入仓库地址，例如 https://github.com/用户名/仓库.git', placeholder: '仓库地址', validate: (v) => (v ? null : '请输入地址') });
  if (!url) return;
  const parent = await window.ide.dialog.openFolder();
  if (!parent) return;
  toast('正在克隆…');
  try {
    const dir = await window.ide.git.clone(url, parent);
    toast('克隆完成', 'success');
    const { openFolder } = await import('./workbench.js');
    openFolder(dir);
  } catch (err) {
    toast(friendlyError(err.message), 'error', 6000);
  }
}

// 仓库状态变化（保存、提交、切换分支、远程操作后）时刷新已打开的页面
const reload = debounce(() => alive() && load(), 300);
bus.on('git:status', reload);
// 改动了远程的操作结束后，重新读一次 GitHub（匿名访问每小时只有 60 次，其他操作不去打扰它）
const REMOTE_WRITES = new Set(['同步', '推送', '发布到 GitHub', '推送标签', '删除远程分支', '删除远程标签']);
let lastOp = null;
bus.on('git:busy', (b) => {
  if (b) lastOp = b;
  else if (REMOTE_WRITES.has(lastOp)) ghStale = true;
  renderHead();
});
