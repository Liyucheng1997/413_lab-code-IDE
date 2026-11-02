// 跨文件搜索与替换（纯 Node 实现，不依赖 ripgrep）。
const fsp = require('fs').promises;
const path = require('path');
const glob = require('./glob');
const { listAllFiles } = require('./fs-service');

const MAX_FILE_SIZE = 2 * 1024 * 1024;

function buildRegex({ query, isRegex, matchCase, wholeWord }) {
  let src = isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (wholeWord) src = `\\b${src}\\b`;
  return new RegExp(src, matchCase ? 'gm' : 'gim');
}

async function candidateFiles(root, opts) {
  const files = await listAllFiles(root);
  const inc = glob.compile(String(opts.include || '').split(','));
  const exc = glob.compile(String(opts.exclude || '').split(','));
  return files.filter((f) => {
    const rel = path.relative(root, f).replace(/\\/g, '/');
    if (inc && !inc(rel)) return false;
    if (exc && exc(rel)) return false;
    return true;
  });
}

async function readText(file) {
  const stat = await fsp.stat(file);
  if (stat.size > MAX_FILE_SIZE) return null;
  const buf = await fsp.readFile(file);
  if (buf.subarray(0, 8000).includes(0)) return null;
  return buf.toString('utf8');
}

async function search(root, opts) {
  if (!opts.query) return { results: [], total: 0, truncated: false };
  let re;
  try {
    re = buildRegex(opts);
  } catch (err) {
    return { error: '正则表达式无效：' + err.message, results: [], total: 0 };
  }
  const max = opts.maxResults || 20000;
  const files = await candidateFiles(root, opts);
  const results = [];
  let total = 0;
  let truncated = false;

  for (const file of files) {
    let text;
    try {
      text = await readText(file);
    } catch {
      continue;
    }
    if (text == null) continue;
    re.lastIndex = 0;
    if (!re.test(text)) continue;

    const lines = text.split(/\r?\n/);
    const matches = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line))) {
        if (m[0].length === 0) {
          re.lastIndex++;
          continue;
        }
        // 预览文本过长时截取匹配附近的内容
        const start = Math.max(0, m.index - 40);
        matches.push({
          line: i + 1,
          col: m.index + 1,
          length: m[0].length,
          preview: line.slice(start, m.index + m[0].length + 80),
          previewOffset: m.index - start,
        });
        total++;
        if (total >= max) break;
      }
      if (total >= max) break;
    }
    if (matches.length) results.push({ file, matches });
    if (total >= max) {
      truncated = true;
      break;
    }
  }
  return { results, total, truncated };
}

async function replace(root, opts, replacement, onlyFiles) {
  const re = buildRegex(opts);
  const files = onlyFiles && onlyFiles.length ? onlyFiles : await candidateFiles(root, opts);
  let count = 0;
  const changed = [];
  for (const file of files) {
    let text;
    try {
      text = await readText(file);
    } catch {
      continue;
    }
    if (text == null) continue;
    let n = 0;
    const next = text.replace(re, (...args) => {
      n++;
      // 支持 $1、$& 等替换语法
      return opts.isRegex ? args[0].replace(new RegExp(re.source, re.flags.replace('g', '')), replacement) : replacement;
    });
    if (n) {
      await fsp.writeFile(file, next, 'utf8');
      count += n;
      changed.push(file);
    }
  }
  return { count, files: changed };
}

function register(ipc) {
  ipc.handle('search:find', (_e, root, opts) => search(root, opts));
  ipc.handle('search:replace', (_e, root, opts, replacement, files) => replace(root, opts, replacement, files));
}

module.exports = { register };
