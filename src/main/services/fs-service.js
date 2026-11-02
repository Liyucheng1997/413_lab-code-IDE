// 文件系统服务：读写、目录列表、新建/重命名/删除、文件索引、目录监听。
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { shell } = require('electron');
const glob = require('./glob');
const settings = require('./settings');

const IMAGE_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };
const MAX_TEXT_SIZE = 50 * 1024 * 1024;

let send = () => {};
let watcher = null;
let watchRoot = null;
let pending = new Set();
let flushTimer = null;

function setSender(fn) {
  send = fn;
}

function excluder(root) {
  const test = glob.compile(settings.get().excludeGlobs);
  return (abs) => {
    if (!test) return false;
    const rel = path.relative(root, abs).replace(/\\/g, '/');
    return rel && test(rel);
  };
}

async function readDir(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const list = entries.map((e) => {
    const p = path.join(dir, e.name);
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) {
      try {
        isDir = fs.statSync(p).isDirectory();
      } catch {}
    }
    return { name: e.name, path: p, isDir };
  });
  list.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })));
  return list;
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// 识别 BOM / UTF-16，其余按 UTF-8 解码
function decode(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { text: buf.slice(3).toString('utf8'), encoding: 'utf8bom' };
  if (buf[0] === 0xff && buf[1] === 0xfe) return { text: buf.slice(2).toString('utf16le'), encoding: 'utf16le' };
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.slice(2));
    swapped.swap16();
    return { text: swapped.toString('utf16le'), encoding: 'utf16be' };
  }
  return { text: buf.toString('utf8'), encoding: 'utf8' };
}

function encode(text, encoding) {
  if (encoding === 'utf8bom') return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
  if (encoding === 'utf16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  if (encoding === 'utf16be') {
    const b = Buffer.from(text, 'utf16le');
    b.swap16();
    return Buffer.concat([Buffer.from([0xfe, 0xff]), b]);
  }
  return Buffer.from(text, 'utf8');
}

async function readFile(file) {
  const stat = await fsp.stat(file);
  const ext = path.extname(file).toLowerCase();
  if (IMAGE_EXT[ext]) {
    const buf = await fsp.readFile(file);
    return { kind: 'image', size: stat.size, mtime: stat.mtimeMs, dataUrl: `data:${IMAGE_EXT[ext]};base64,${buf.toString('base64')}` };
  }
  if (stat.size > MAX_TEXT_SIZE) return { kind: 'toolarge', size: stat.size, mtime: stat.mtimeMs };
  const buf = await fsp.readFile(file);
  if (looksBinary(buf)) return { kind: 'binary', size: stat.size, mtime: stat.mtimeMs };
  const { text, encoding } = decode(buf);
  return { kind: 'text', content: text, encoding, size: stat.size, mtime: stat.mtimeMs };
}

async function writeFile(file, content, encoding = 'utf8') {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, encode(content, encoding));
  const stat = await fsp.stat(file);
  return { mtime: stat.mtimeMs };
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function createFile(file) {
  if (await exists(file)) throw new Error('已存在同名文件：' + path.basename(file));
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, '');
}

async function createDir(dir) {
  if (await exists(dir)) throw new Error('已存在同名文件夹：' + path.basename(dir));
  await fsp.mkdir(dir, { recursive: true });
}

async function rename(from, to) {
  if (from.toLowerCase() !== to.toLowerCase() && (await exists(to))) throw new Error('目标已存在：' + path.basename(to));
  await fsp.rename(from, to);
}

// 删除走系统回收站，可以恢复
async function remove(p) {
  await shell.trashItem(p);
}

async function copy(from, toDir) {
  let target = path.join(toDir, path.basename(from));
  if (path.resolve(target) === path.resolve(from) || (await exists(target))) {
    const ext = path.extname(from);
    const base = path.basename(from, ext);
    let n = 1;
    do target = path.join(toDir, `${base} copy${n > 1 ? ' ' + n : ''}${ext}`);
    while (await exists(target) && ++n);
  }
  await fsp.cp(from, target, { recursive: true });
  return target;
}

// 列出工作区所有文件（用于 Ctrl+P 快速打开），跳过排除目录
async function listAllFiles(root, limit = 50000) {
  const isExcluded = excluder(root);
  const out = [];
  const stack = [root];
  while (stack.length && out.length < limit) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (isExcluded(p)) continue;
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) out.push(p);
    }
  }
  return out;
}

// 监听整个工作区，合并 150ms 内的变化后统一通知渲染进程
function watch(root) {
  unwatch();
  watchRoot = root;
  const isExcluded = excluder(root);
  try {
    watcher = fs.watch(root, { recursive: true }, (_type, name) => {
      if (!name) return;
      const abs = path.join(root, name.toString());
      if (isExcluded(abs) && !abs.includes(`${path.sep}.git${path.sep}HEAD`)) return;
      pending.add(abs);
      clearTimeout(flushTimer);
      flushTimer = setTimeout(() => {
        const paths = [...pending];
        pending = new Set();
        send('fs:changed', { root: watchRoot, paths });
      }, 150);
    });
    watcher.on('error', () => {});
  } catch (err) {
    console.warn('watch failed', err.message);
  }
}

function unwatch() {
  if (watcher) watcher.close();
  watcher = null;
}

function register(ipc) {
  ipc.handle('fs:read-dir', (_e, dir) => readDir(dir));
  ipc.handle('fs:read-file', (_e, file) => readFile(file));
  ipc.handle('fs:write-file', (_e, file, content, encoding) => writeFile(file, content, encoding));
  ipc.handle('fs:create-file', (_e, file) => createFile(file));
  ipc.handle('fs:create-dir', (_e, dir) => createDir(dir));
  ipc.handle('fs:rename', (_e, from, to) => rename(from, to));
  ipc.handle('fs:delete', (_e, p) => remove(p));
  ipc.handle('fs:copy', (_e, from, toDir) => copy(from, toDir));
  ipc.handle('fs:exists', (_e, p) => exists(p));
  ipc.handle('fs:stat', async (_e, p) => {
    try {
      const s = await fsp.stat(p);
      return { isDir: s.isDirectory(), size: s.size, mtime: s.mtimeMs };
    } catch {
      return null;
    }
  });
  ipc.handle('fs:list-all', (_e, root) => listAllFiles(root));
  ipc.handle('fs:watch', (_e, root) => watch(root));
}

module.exports = { register, setSender, unwatch, readFile, listAllFiles, excluder };
