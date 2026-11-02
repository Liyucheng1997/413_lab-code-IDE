// AI 助手的工具执行：读写文件、搜索、诊断、运行命令。
// 路径一律限制在工作区内；写文件和运行命令要经过用户确认（除非在设置里开启自动）。
import { ctx } from './state.js';
import { path, norm, SEP } from './util.js';
import * as editors from './editors.js';
import { externalDiagnostics } from './lsp-client.js';

const MAX_READ_LINES = 2000;

function resolve(p) {
  if (!ctx.root) throw new Error('没有打开工作区');
  if (!p || typeof p !== 'string') throw new Error('缺少路径');
  const clean = p.replace(/[\\/]+/g, SEP);
  const abs = /^([a-zA-Z]:|[\\/])/.test(clean) ? clean : ctx.root.replace(/[\\/]+$/, '') + SEP + clean;
  // 规范化 . 和 ..，再确认仍在工作区内
  const parts = [];
  for (const seg of abs.split(SEP)) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg !== '') parts.push(seg);
  }
  const resolved = (abs.startsWith('/') ? '/' : '') + parts.join(SEP);
  if (!path.isInside(ctx.root, resolved)) throw new Error(`路径超出了工作区：${p}`);
  return resolved;
}

const rel = (p) => path.relative(ctx.root, p).replace(/\\/g, '/');

// 优先返回编辑器里的内容（可能有未保存的修改）
async function currentText(abs) {
  const d = editors.getDoc(abs);
  if (d && !d.model.isDisposed()) return { text: d.model.getValue(), exists: true };
  const st = await window.ide.fs.stat(abs);
  if (!st) return { text: '', exists: false };
  if (st.isDir) throw new Error('这是一个文件夹');
  const info = await window.ide.fs.readFile(abs);
  if (info.kind !== 'text') throw new Error(info.kind === 'image' ? '这是图片文件' : '这是二进制文件或文件过大，无法读取');
  return { text: info.content, exists: true };
}

// 写入：文件已在编辑器打开则改编辑器模型（可撤销）并保存，否则直接写盘
async function applyContent(abs, text) {
  const d = editors.getDoc(abs);
  if (d && !d.model.isDisposed()) {
    d.model.pushEditOperations([], [{ range: d.model.getFullModelRange(), text }], () => null);
    await editors.saveDoc(d);
  } else {
    await window.ide.fs.writeFile(abs, text);
  }
}

const tools = {
  async list_files({ pattern }) {
    if (!ctx.root) throw new Error('没有打开工作区');
    let files = (await window.ide.fs.listAll(ctx.root)).map(rel);
    if (pattern) {
      const p = pattern.replace(/\\/g, '/');
      if (p.includes('*')) {
        const re = new RegExp('^' + p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
        files = files.filter((f) => re.test(f) || re.test(path.basename(f)));
      } else files = files.filter((f) => f.toLowerCase().includes(p.toLowerCase()));
    }
    files.sort();
    const shown = files.slice(0, 400);
    return shown.join('\n') + (files.length > shown.length ? `\n…（共 ${files.length} 个文件，只列出前 ${shown.length} 个，可用 pattern 缩小范围）` : '') || '（没有匹配的文件）';
  },

  async read_file({ path: p, offset, limit }) {
    const abs = resolve(p);
    const { text, exists } = await currentText(abs);
    if (!exists) throw new Error(`文件不存在：${p}`);
    const lines = text.split(/\r?\n/);
    const start = Math.max(1, offset || 1);
    const count = Math.min(limit || MAX_READ_LINES, MAX_READ_LINES);
    const slice = lines.slice(start - 1, start - 1 + count);
    const width = String(start + slice.length).length;
    let out = slice.map((l, i) => `${String(start + i).padStart(width)}\t${l.length > 2000 ? l.slice(0, 2000) + '…' : l}`).join('\n');
    if (start - 1 + count < lines.length) out += `\n…（共 ${lines.length} 行，已显示 ${start}-${start + slice.length - 1} 行，可用 offset 继续读取）`;
    return out || '（空文件）';
  },

  async search_text({ query, is_regex, include }) {
    if (!ctx.root) throw new Error('没有打开工作区');
    const r = await window.ide.search.find(ctx.root, { query, isRegex: !!is_regex, matchCase: false, wholeWord: false, include: include || '', exclude: '', maxResults: 300 });
    if (r.error) throw new Error(r.error);
    if (!r.total) return '没有找到匹配项';
    const out = [];
    for (const f of r.results) for (const m of f.matches) out.push(`${rel(f.file)}:${m.line}: ${m.preview.trim()}`);
    return out.slice(0, 200).join('\n') + (r.total > 200 ? `\n…（共 ${r.total} 处，只显示前 200 处）` : '');
  },

  async get_diagnostics({ path: p }) {
    const target = p ? norm(resolve(p)) : null;
    const M = ctx.monaco.MarkerSeverity;
    const out = [];
    const push = (file, m) => {
      if (target && norm(file) !== target) return;
      if (m.severity < M.Warning) return;
      out.push(`${rel(file)}:${m.startLineNumber}:${m.startColumn} ${m.severity === M.Error ? '错误' : '警告'} ${m.message.split('\n')[0]}${m.source ? ` [${m.source}]` : ''}`);
    };
    for (const m of ctx.monaco.editor.getModelMarkers({})) if (m.resource.scheme === 'file') push(m.resource.fsPath, m);
    for (const v of externalDiagnostics.values()) for (const m of v.markers) push(v.path, m);
    return out.length ? out.slice(0, 200).join('\n') : '没有发现错误或警告（只包含编辑器已分析过的文件）';
  },

  async edit_file({ path: p, old_text, new_text, replace_all }, ui) {
    const abs = resolve(p);
    const { text, exists } = await currentText(abs);
    if (!exists) throw new Error(`文件不存在：${p}。新建文件请用 write_file`);
    if (!old_text) throw new Error('old_text 不能为空');
    // 文件可能是 CRLF，模型给的一般是 LF：两种都试
    let source = text;
    let oldT = old_text;
    let newT = new_text;
    if (!source.includes(oldT) && source.includes('\r\n')) {
      oldT = old_text.replace(/\r?\n/g, '\r\n');
      newT = new_text.replace(/\r?\n/g, '\r\n');
    }
    const count = source.split(oldT).length - 1;
    if (count === 0) throw new Error('在文件中没有找到 old_text，请先用 read_file 确认当前内容（注意不要包含行号）');
    if (count > 1 && !replace_all) throw new Error(`old_text 在文件中出现了 ${count} 次，请提供更多上下文让它唯一，或设置 replace_all`);
    const next = replace_all ? source.split(oldT).join(newT) : source.replace(oldT, () => newT);
    const ok = await ui.approve({ kind: 'edit', path: abs, original: source, modified: next });
    if (!ok) return { content: '用户拒绝了这次修改', isError: true };
    await applyContent(abs, next);
    return `已修改 ${rel(abs)}（替换 ${replace_all ? count : 1} 处）`;
  },

  async write_file({ path: p, content }, ui) {
    const abs = resolve(p);
    const { text, exists } = await currentText(abs).catch(() => ({ text: '', exists: false }));
    const ok = await ui.approve({ kind: exists ? 'edit' : 'create', path: abs, original: text, modified: content });
    if (!ok) return { content: '用户拒绝了这次修改', isError: true };
    await applyContent(abs, content);
    return `${exists ? '已覆盖' : '已创建'} ${rel(abs)}`;
  },

  async run_command({ command }, ui) {
    if (!ctx.root) throw new Error('没有打开工作区');
    const ok = await ui.approve({ kind: 'command', command });
    if (!ok) return { content: '用户拒绝运行这条命令', isError: true };
    ui.progress('运行中…');
    const r = await window.ide.ai.exec(command, ctx.root);
    ui.output(r.output, r.code);
    return `退出码：${r.code}\n${r.output || '（无输出）'}`;
  },
};

export async function executeTool(name, input, ui) {
  const fn = tools[name];
  if (!fn) return { content: `未知工具：${name}`, isError: true };
  try {
    const r = await fn(input || {}, ui);
    return typeof r === 'string' ? { content: r } : r;
  } catch (err) {
    return { content: err.message || String(err), isError: true };
  }
}

// 工具调用的简短描述，显示在对话里
export function describeTool(name, input = {}) {
  const p = input.path ? input.path.replace(/\\/g, '/') : '';
  switch (name) {
    case 'list_files':
      return ['列出文件', input.pattern || ''];
    case 'read_file':
      return ['读取', p + (input.offset ? `:${input.offset}` : '')];
    case 'search_text':
      return ['搜索', input.query || ''];
    case 'get_diagnostics':
      return ['检查问题', p || '全部文件'];
    case 'edit_file':
      return ['修改', p];
    case 'write_file':
      return ['写入', p];
    case 'run_command':
      return ['运行命令', input.command || ''];
    default:
      return [name, ''];
  }
}
