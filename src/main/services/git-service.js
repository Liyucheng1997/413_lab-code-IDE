// Git 服务：调用本机 git 命令行。
const { execFile } = require('child_process');
const path = require('path');
const { shell } = require('electron');

function git(cwd, args, { allowFail = false, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args], { cwd, maxBuffer, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
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
}

module.exports = { register };
