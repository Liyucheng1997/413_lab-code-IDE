// Git 服务：调用本机 git 命令行。
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const { shell, net } = require('electron');

function git(cwd, args, { allowFail = false, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args], { cwd, maxBuffer, windowsHide: true, encoding: 'utf8'}, (err, stdout, stderr) => {
      if (err && !allowFail) {
        const msg = (stderr || err.message || '').trim();
        return reject(new Error(msg || 'git 命令失败'));
      }
      resolve({ stdout, stderr, code: err ? err.code : 0 });
    });
  });
}

async function status(root) {
  const probe = await git(root, ['rev-parse', '--show-toplevel'], { allowFail: true });
  if (probe.code !== 0) return { isRepo: false };
  const top = probe.stdout.trim();
  const { stdout } = await git(root, ['status', '--porcelain=v1', '-b', '--untracked-files=all']);
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  let branch = '';
  let ahead = 0;
  let behind = 0;
  let upstream = '';
  const files = [];
  for (const line of lines) {
    if (line.startsWith('## ')) {
      const head = line.slice(3);
      const m = head.match(/^(?:No commits yet on |Initial commit on )?([^.\s]+)(?:\.\.\.(\S+))?(?: \[(.*)\])?/);
      if (m) {
        branch = m[1];
        upstream = m[2] || '';
        const info = m[3] || '';
        ahead = +(info.match(/ahead (\d+)/) || [0, 0])[1];
        behind = +(info.match(/behind (\d+)/) || [0, 0])[1];
      }
      if (head.startsWith('HEAD (no branch)')) branch = 'HEAD（分离）';
      continue;
    }
    const x = line[0];
    const y = line[1];
    let rel = line.slice(3);
    let from = null;
    if (rel.includes(' -> ')) [from, rel] = rel.split(' -> ');
    rel = rel.replace(/^"|"$/g, '');
    files.push({ path: path.join(top, rel), rel, from, index: x, worktree: y });
  }
  return { isRepo: true, top, branch, upstream, ahead, behind, files };
}

async function hasHead(root) {
  return (await git(root, ['rev-parse', '--verify', 'HEAD'], { allowFail: true })).code === 0;
}

async function stage(root, paths) {
  await git(root, ['add', '-A', '--', ...paths]);
}

async function unstage(root, paths) {
  if (await hasHead(root)) await git(root, ['reset', '-q', 'HEAD', '--', ...paths]);
  else await git(root, ['rm', '--cached', '-r', '-q', '--', ...paths]);
}

async function discard(root, files) {
  // files: [{path, untracked}]
  const tracked = files.filter((f) => !f.untracked).map((f) => f.path);
  if (tracked.length) await git(root, ['checkout', '--', ...tracked]);
  for (const f of files.filter((f) => f.untracked)) await shell.trashItem(f.path);
}

async function commit(root, message, { amend = false, all = false } = {}) {
  const args = ['commit', '-m', message];
  if (amend) args.push('--amend');
  if (all) args.push('-a');
  const r = await git(root, args);
  return r.stdout;
}

async function show(root, file, ref = 'HEAD') {
  const top = (await git(root, ['rev-parse', '--show-toplevel'])).stdout.trim();
  const rel = path.relative(top, file).replace(/\\/g, '/');
  const spec = ref === ':0' ? `:${rel}` : `${ref}:${rel}`;
  const r = await git(root, ['show', spec], { allowFail: true });
  return r.code === 0 ? r.stdout : '';
}

async function log(root, n = 100) {
  if (!(await hasHead(root))) return [];
  const { stdout } = await git(root, ['log', `-n${n}`, '--date=format:%Y-%m-%d %H:%M', '--pretty=format:%h\x1f%an\x1f%ad\x1f%s\x1f%D']);
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [hash, author, date, subject, refs] = l.split('\x1f');
      return { hash, author, date, subject, refs };
    });
}

async function branches(root) {
  const { stdout } = await git(root, ['branch', '-a', '--format=%(HEAD)\x1f%(refname:short)']);
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      const [head, name] = l.split('\x1f');
      return { name, current: head === '*', remote: name.includes('/') && !name.startsWith('HEAD') };
    });
}

// 某个文件相对 HEAD 的行级变化（用于编辑器左侧的修改标记）
async function lineChanges(root, file) {
  const r = await git(root, ['diff', '-U0', '--no-ext-diff', 'HEAD', '--', file], { allowFail: true });
  if (r.code !== 0) return [];
  const changes = [];
  for (const m of r.stdout.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const oldCount = m[2] === undefined ? 1 : +m[2];
    const start = +m[3];
    const count = m[4] === undefined ? 1 : +m[4];
    if (count === 0) changes.push({ type: 'deleted', start: Math.max(start, 1), end: Math.max(start, 1) });
    else changes.push({ type: oldCount === 0 ? 'added' : 'modified', start, end: start + count - 1 });
  }
  return changes;
}

// ---------------- 仓库信息、远程同步与 GitHub ----------------

const US = '\x1f';
const lines = (s) => s.split(/\r?\n/).filter(Boolean);
const fields = (s) => lines(s).map((l) => l.split(US));

// 从远程地址里认出 GitHub 仓库：https://github.com/o/r(.git)、git@github.com:o/r.git、ssh://git@github.com/o/r
function parseGithub(url) {
  const m = String(url || '').match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

async function remotes(root) {
  const { stdout } = await git(root, ['remote', '-v'], { allowFail: true });
  const map = new Map();
  for (const l of lines(stdout)) {
    const m = l.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!m) continue;
    const r = map.get(m[1]) || { name: m[1], fetch: '', push: '' };
    r[m[3]] = m[2];
    map.set(m[1], r);
  }
  return [...map.values()].map((r) => {
    const gh = parseGithub(r.fetch);
    return { ...r, github: gh, web: gh ? `https://github.com/${gh.owner}/${gh.repo}` : '' };
  });
}

async function config(root, key) {
  return (await git(root, ['config', '--get', key], { allowFail: true })).stdout.trim();
}

// 把 for-each-ref 的 upstream:track（"[ahead 1, behind 2]"、"[gone]"）拆成数字
function track(t) {
  return { ahead: +(t.match(/ahead (\d+)/) || [0, 0])[1], behind: +(t.match(/behind (\d+)/) || [0, 0])[1], gone: t.includes('gone') };
}

async function commitMeta(root, ref) {
  const { stdout } = await git(root, ['show', '-s', `--format=%H${US}%h${US}%an${US}%ae${US}%ad${US}%P${US}%D${US}%s`, '--date=format:%Y-%m-%d %H:%M', ref, '--']);
  const [hash, short, author, email, date, parents, refs, subject] = stdout.trim().split(US);
  return { hash, short, author, email, date, parents: parents ? parents.split(' ') : [], refs, subject };
}

async function info(root) {
  const st = await status(root);
  if (!st.isRepo) return st;
  const head = (await hasHead(root)) ? await commitMeta(root, 'HEAD') : null;
  const [rems, userName, userEmail, count, fetchHead, local, remote, tags, stashes] = await Promise.all([
    remotes(root),
    config(root, 'user.name'),
    config(root, 'user.email'),
    head ? git(root, ['rev-list', '--count', 'HEAD']).then((r) => +r.stdout.trim()) : 0,
    git(root, ['rev-parse', '--git-path', 'FETCH_HEAD']).then((r) => path.resolve(root, r.stdout.trim())),
    git(root, ['for-each-ref', 'refs/heads', '--sort=-committerdate', `--format=%(HEAD)${US}%(refname:short)${US}%(upstream:short)${US}%(upstream:track)${US}%(objectname:short)${US}%(committerdate:format:%Y-%m-%d %H:%M)${US}%(subject)`]).then((r) => fields(r.stdout)),
    git(root, ['for-each-ref', 'refs/remotes', '--sort=-committerdate', `--format=%(refname:short)${US}%(objectname:short)${US}%(committerdate:format:%Y-%m-%d %H:%M)${US}%(subject)`]).then((r) => fields(r.stdout)),
    git(root, ['for-each-ref', 'refs/tags', '--sort=-creatordate', `--format=%(refname:short)${US}%(objectname:short)${US}%(*objectname:short)${US}%(creatordate:format:%Y-%m-%d %H:%M)${US}%(subject)`]).then((r) => fields(r.stdout)),
    // 不能加 --date：那样 %gd 会变成 stash@{日期} 而不是 stash@{0}
    git(root, ['stash', 'list', `--format=%gd${US}%s${US}%ci`], { allowFail: true }).then((r) => fields(r.stdout)),
  ]);
  let lastFetch = 0;
  try {
    lastFetch = fs.statSync(fetchHead).mtimeMs;
  } catch {}
  return {
    ...st,
    head,
    remotes: rems,
    user: { name: userName, email: userEmail },
    commitCount: count,
    lastFetch,
    branches: local.map(([h, name, upstream, t, hash, date, subject]) => ({ name, current: h === '*', upstream, ...track(t || ''), hash, date, subject })),
    remoteBranches: remote.filter(([name]) => name.includes('/') && !name.endsWith('/HEAD')).map(([name, hash, date, subject]) => ({ name, hash, date, subject })),
    tags: tags.map(([name, hash, target, date, subject]) => ({ name, hash: target || hash, date, subject, annotated: !!target })),
    stashes: stashes.map(([ref, subject, date]) => ({ ref, subject, date: (date || '').slice(0, 16) })),
  };
}

const LOG_FORMAT = `%H${US}%h${US}%an${US}%ad${US}%s${US}%D`;
function parseLog(stdout) {
  return fields(stdout).map(([full, hash, author, date, subject, refs]) => ({ full, hash, author, date, subject, refs }));
}

// 本地分支与上游之间的差异：incoming = 远程有、本地没有；outgoing = 本地有、还没推送
async function compare(root, upstream = '@{u}') {
  const ok = (await git(root, ['rev-parse', '--verify', '-q', upstream], { allowFail: true })).code === 0;
  if (!ok) return { upstream: '', incoming: [], outgoing: [] };
  const range = (r) => git(root, ['log', '-n200', '--date=format:%Y-%m-%d %H:%M', `--pretty=format:${LOG_FORMAT}`, r, '--']).then((x) => parseLog(x.stdout));
  const [incoming, outgoing, name] = await Promise.all([
    range(`HEAD..${upstream}`),
    range(`${upstream}..HEAD`),
    git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', upstream], { allowFail: true }).then((r) => r.stdout.trim()),
  ]);
  return { upstream: name || upstream, incoming, outgoing };
}

async function logPage(root, { n = 200, skip = 0, all = false, query = '' } = {}) {
  if (!(await hasHead(root))) return [];
  const args = ['log', `-n${n}`, `--skip=${skip}`, '--date=format:%Y-%m-%d %H:%M', `--pretty=format:${LOG_FORMAT}`];
  if (query) args.push('-i', '--fixed-strings', `--grep=${query}`);
  args.push(all ? '--all' : 'HEAD', '--');
  return parseLog((await git(root, args)).stdout);
}

async function commitDetail(root, ref) {
  const meta = await commitMeta(root, ref);
  const body = (await git(root, ['show', '-s', '--format=%B', ref, '--'])).stdout.trim();
  // 合并提交只与第一个父提交比较，和 GitHub 上看到的一致
  const diff = (mode) => git(root, ['show', '--format=', '-M', '--first-parent', '-m', mode, ref, '--']).then((r) => lines(r.stdout).map((l) => l.split('\t')));
  const [ns, num] = await Promise.all([diff('--name-status'), diff('--numstat')]);
  const files = ns.map((parts, i) => {
    const s = num[i] || [];
    return { status: parts[0][0], rel: parts[parts.length - 1], from: parts.length > 2 ? parts[1] : null, added: s[0] === '-' ? null : +s[0] || 0, deleted: s[1] === '-' ? null : +s[1] || 0 };
  });
  return { ...meta, body, files };
}

// 某个提交中文件改动前后的内容，用于差异对比
async function fileAtCommit(root, ref, rel, from) {
  const read = (spec) => git(root, ['show', spec], { allowFail: true }).then((r) => (r.code === 0 ? r.stdout : ''));
  const [before, after] = await Promise.all([read(`${ref}^:${from || rel}`), read(`${ref}:${rel}`)]);
  return { before, after };
}

// 同步：获取 → 落后就拉取 → 领先就推送；还没有上游时推送并建立跟踪
async function sync(root, { rebase = false } = {}) {
  const out = [];
  const keep = (r) => out.push((r.stdout + r.stderr).trim());
  const st = await status(root);
  if (!st.isRepo) throw new Error('当前文件夹不是 Git 仓库');
  if (!st.upstream) {
    const rems = await remotes(root);
    if (!rems.length) throw new Error('还没有配置远程仓库，请先添加远程或发布到 GitHub');
    const remote = rems.find((r) => r.name === 'origin') || rems[0];
    keep(await git(root, ['push', '-u', remote.name, st.branch]));
    return out.join('\n').trim();
  }
  keep(await git(root, ['fetch', '--prune']));
  if ((await status(root)).behind) keep(await git(root, ['pull', rebase ? '--rebase' : '--no-rebase']));
  if ((await status(root)).ahead) keep(await git(root, ['push']));
  return out.filter(Boolean).join('\n').trim();
}

async function clone(url, parent) {
  const m = url.trim().match(/([^/:\\]+?)(?:\.git)?\/?$/);
  const dir = path.join(parent, m ? m[1] : 'repo');
  if (fs.existsSync(dir)) throw new Error(`目标文件夹已存在：${dir}`);
  await git(parent, ['clone', url.trim(), dir]);
  return dir;
}

// ---- GitHub：装了 gh 且已登录时带上它的令牌（能看私有仓库、额度更高），否则匿名访问公开仓库 ----

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, encoding: 'utf8', timeout: 120000, ...opts }, (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout || '', stderr: stderr || (err && err.message) || '' }));
  });
}

let ghToken;
async function githubToken() {
  if (ghToken === undefined) {
    const r = await run('gh', ['auth', 'token'], { timeout: 8000 });
    ghToken = r.ok ? r.stdout.trim() : '';
  }
  return ghToken;
}

async function ghApi(pathname) {
  const token = await githubToken();
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Lumen-IDE' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await net.fetch(`https://api.github.com${pathname}`, { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(res.status === 403 || res.status === 429 ? 'GitHub 接口访问次数已用完，稍后再试（登录 gh 后额度更高）' : `GitHub 返回 ${res.status}`);
  return res.json();
}

async function githubRepo(owner, repo, branch) {
  const r = await ghApi(`/repos/${owner}/${repo}`);
  const authenticated = !!(await githubToken());
  if (!r) return { found: false, authenticated };
  const ref = branch || r.default_branch;
  const [release, commits, tags] = await Promise.all([
    ghApi(`/repos/${owner}/${repo}/releases/latest`).catch(() => null),
    ghApi(`/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(ref)}&per_page=10`).catch(() => null),
    ghApi(`/repos/${owner}/${repo}/tags?per_page=20`).catch(() => null),
  ]);
  return {
    found: true,
    authenticated,
    fullName: r.full_name,
    description: r.description || '',
    private: r.private,
    url: r.html_url,
    stars: r.stargazers_count,
    forks: r.forks_count,
    issues: r.open_issues_count,
    defaultBranch: r.default_branch,
    pushedAt: r.pushed_at,
    branch: ref,
    release: release && { tag: release.tag_name, name: release.name || release.tag_name, date: release.published_at, url: release.html_url },
    tags: (tags || []).map((t) => ({ name: t.name, sha: t.commit.sha })),
    commits: (commits || []).map((c) => ({ sha: c.sha, short: c.sha.slice(0, 7), subject: c.commit.message.split('\n')[0], author: (c.author && c.author.login) || c.commit.author.name, date: c.commit.author.date, url: c.html_url })),
  };
}

async function ghStatus() {
  const v = await run('gh', ['--version'], { timeout: 8000 });
  if (!v.ok) return { installed: false };
  const a = await run('gh', ['auth', 'status', '--hostname', 'github.com'], { timeout: 8000 });
  const user = (a.stdout + a.stderr).match(/account (\S+)/);
  return { installed: true, loggedIn: a.ok, user: user ? user[1] : '' };
}

// 用 gh 在 GitHub 上新建仓库，把当前文件夹设为 origin，有提交就顺便推送
async function publish(root, { name, visibility = 'public', description = '' }) {
  const args = ['repo', 'create', name, `--${visibility}`, '--source', '.', '--remote', 'origin'];
  if (description) args.push('--description', description);
  if (await hasHead(root)) args.push('--push');
  const r = await run('gh', args, { cwd: root, timeout: 300000 });
  if (!r.ok) throw new Error(r.stderr.trim() || '发布失败');
  return (r.stdout + r.stderr).trim();
}

function register(ipc) {
  ipc.handle('git:status', (_e, root) => status(root).catch((err) => ({ isRepo: false, error: err.message })));
  ipc.handle('git:stage', (_e, root, paths) => stage(root, paths));
  ipc.handle('git:unstage', (_e, root, paths) => unstage(root, paths));
  ipc.handle('git:discard', (_e, root, files) => discard(root, files));
  ipc.handle('git:commit', (_e, root, msg, opts) => commit(root, msg, opts));
  ipc.handle('git:show', (_e, root, file, ref) => show(root, file, ref));
  ipc.handle('git:log', (_e, root, n) => log(root, n));
  ipc.handle('git:branches', (_e, root) => branches(root));
  ipc.handle('git:checkout', (_e, root, name, create) => git(root, create ? ['checkout', '-b', name] : ['checkout', name]).then((r) => r.stdout + r.stderr));
  ipc.handle('git:init', (_e, root) => git(root, ['init']).then((r) => r.stdout));
  ipc.handle('git:line-changes', (_e, root, file) => lineChanges(root, file));
  ipc.handle('git:run', (_e, root, args) => git(root, args).then((r) => (r.stdout + r.stderr).trim()));
  ipc.handle('git:info', (_e, root) => info(root).catch((err) => ({ isRepo: false, error: err.message })));
  ipc.handle('git:compare', (_e, root, upstream) => compare(root, upstream));
  ipc.handle('git:log-page', (_e, root, opts) => logPage(root, opts));
  ipc.handle('git:commit-detail', (_e, root, ref) => commitDetail(root, ref));
  ipc.handle('git:file-at-commit', (_e, root, ref, rel, from) => fileAtCommit(root, ref, rel, from));
  ipc.handle('git:sync', (_e, root, opts) => sync(root, opts));
  ipc.handle('git:clone', (_e, url, parent) => clone(url, parent));
  ipc.handle('github:status', () => ghStatus());
  ipc.handle('github:repo', (_e, owner, repo, branch) => githubRepo(owner, repo, branch));
  ipc.handle('github:publish', (_e, root, opts) => publish(root, opts));
}

module.exports = { register };
