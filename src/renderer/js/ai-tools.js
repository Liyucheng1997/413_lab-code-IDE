// AI 助手的工具执行：项目与文件管理、读写搜索、运行程序与命令、读取终端和 IDE 输出。
// 文件路径一律限制在工作区内；写入、删除、运行命令按用户选择的权限模式确认。
import { ctx } from './state.js';
import { path, norm, SEP } from './util.js';
import * as editors from './editors.js';
import { externalDiagnostics } from './lsp-client.js';
import { openFolder } from './workbench.js';
import { aiTerminal, findTerminal, terminalText, listTerminals } from './terminal.js';
import { channelText, channelNames } from './output.js';
import { consoleText } from './debug-console.js';

const MAX_READ_LINES = 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function needRoot() {
  if (!ctx.root) throw new Error('还没有打开工作区。新项目请先用 create_project 创建，已有项目用 open_folder 打开');
}

function resolve(p) {
  needRoot();
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

const rel = (p) => (ctx.root ? path.relative(ctx.root, p).replace(/\\/g, '/') : p);

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

function diagnosticsText(target) {
  const M = ctx.monaco.MarkerSeverity;
  const out = [];
  const push = (file, m) => {
    if (target && norm(file) !== target) return;
    if (m.severity < M.Warning) return;
    out.push(`${rel(file)}:${m.startLineNumber}:${m.startColumn} ${m.severity === M.Error ? '错误' : '警告'} ${m.message.split('\n')[0]}${m.source ? ` [${m.source}]` : ''}`);
  };
  for (const m of ctx.monaco.editor.getModelMarkers({})) if (m.resource.scheme === 'file') push(m.resource.fsPath, m);
  for (const v of externalDiagnostics.values()) for (const m of v.markers) push(v.path, m);
  return out.length ? out.slice(0, 200).join('\n') : '没有发现错误或警告（只包含 IDE 已分析过的文件）';
}

let execSeq = 1;

async function runAndCapture(command, cwd, timeout, ui, stdin) {
  const execId = 'x' + Date.now() + '-' + execSeq++;
  ui.startExec(execId);
  const r = await window.ide.ai.exec(execId, command, { cwd, timeout: timeout || 180, stdin });
  ui.endExec(execId, r.code);
  return `退出码：${r.code}\n${r.output.trim() || '（无输出）'}`;
}

function defaultProjectsDir() {
  if (ctx.settings.aiProjectsDir) return ctx.settings.aiProjectsDir;
  if (ctx.root) return path.dirname(ctx.root);
  return path.join(ctx.info.home, 'Documents', 'LumenProjects');
}

const tools = {
  async update_plan({ items }, ui) {
    ui.plan(items);
    const done = items.filter((i) => i.status === 'completed').length;
    return `计划已更新（${done}/${items.length} 完成）`;
  },

  async create_project({ name, location }, ui) {
    if (!/^[^<>:"|?*\\/]+$/.test(name) || /^\.+$/.test(name)) throw new Error('项目名不能包含 \\ / : * ? " < > | 等字符');
    let target = path.join(location || defaultProjectsDir(), name);
    const chosen = await ui.approve({ kind: 'project', path: target });
    if (!chosen) return { content: '用户取消了新建项目', isError: true };
    target = typeof chosen === 'string' ? chosen : target;
    const st = await window.ide.fs.stat(target);
    if (st && !st.isDir) throw new Error('同名文件已存在：' + target);
    if (st) {
      const entries = await window.ide.fs.readDir(target);
      if (entries.length) throw new Error(`文件夹已存在且不为空：${target}。请换一个项目名，或用 open_folder 打开它`);
    } else await window.ide.fs.createDir(target);
    await openFolder(target);
    if (!ctx.root || !path.same(ctx.root, target)) return { content: '项目文件夹已创建，但没有打开（可能用户取消了切换）：' + target, isError: true };
    return `已创建并打开项目：${target}\n现在它是当前工作区，可以用相对路径创建文件了。`;
  },

  async open_folder({ path: p }, ui) {
    const st = await window.ide.fs.stat(p);
    if (!st || !st.isDir) throw new Error('文件夹不存在：' + p);
    if (ctx.root && path.same(ctx.root, p)) return '这个文件夹已经是当前工作区';
    const ok = await ui.approve({ kind: 'open', path: p });
    if (!ok) return { content: '用户拒绝打开该文件夹', isError: true };
    await openFolder(p);
    return ctx.root && path.same(ctx.root, p) ? `已打开工作区：${p}` : { content: '没有切换工作区（可能用户取消了）', isError: true };
  },

  async list_files({ pattern }) {
    needRoot();
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
    if (!shown.length) return pattern ? '没有匹配的文件' : '工作区是空的';
    return shown.join('\n') + (files.length > shown.length ? `\n…（共 ${files.length} 个文件，只列出前 ${shown.length} 个，可用 pattern 缩小范围）` : '');
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
    needRoot();
    const r = await window.ide.search.find(ctx.root, { query, isRegex: !!is_regex, matchCase: false, wholeWord: false, include: include || '', exclude: '', maxResults: 300 });
    if (r.error) throw new Error(r.error);
    if (!r.total) return '没有找到匹配项';
    const out = [];
    for (const f of r.results) for (const m of f.matches) out.push(`${rel(f.file)}:${m.line}: ${m.preview.trim()}`);
    return out.slice(0, 200).join('\n') + (r.total > 200 ? `\n…（共 ${r.total} 处，只显示前 200 处）` : '');
  },

  async edit_file({ path: p, old_text, new_text, replace_all }, ui) {
    const abs = resolve(p);
    const { text, exists } = await currentText(abs);
    if (!exists) throw new Error(`文件不存在：${p}。新建文件请用 write_file`);
    if (!old_text) throw new Error('old_text 不能为空');
    // 文件可能是 CRLF，模型给的一般是 LF：两种都试
    let oldT = old_text;
    let newT = new_text;
    if (!text.includes(oldT) && text.includes('\r\n')) {
      oldT = old_text.replace(/\r?\n/g, '\r\n');
      newT = new_text.replace(/\r?\n/g, '\r\n');
    }
    const count = text.split(oldT).length - 1;
    if (count === 0) throw new Error('在文件中没有找到 old_text，请先用 read_file 确认当前内容（注意不要包含行号）');
    if (count > 1 && !replace_all) throw new Error(`old_text 在文件中出现了 ${count} 次，请提供更多上下文让它唯一，或设置 replace_all`);
    const next = replace_all ? text.split(oldT).join(newT) : text.replace(oldT, () => newT);
    const ok = await ui.approve({ kind: 'edit', path: abs, original: text, modified: next });
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
    return `${exists ? '已覆盖' : '已创建'} ${rel(abs)}（${content.split('\n').length} 行）`;
  },

  async create_directory({ path: p }) {
    const abs = resolve(p);
    const st = await window.ide.fs.stat(abs);
    if (st && st.isDir) return `文件夹已存在：${rel(abs)}`;
    await window.ide.fs.createDir(abs);
    return `已创建文件夹 ${rel(abs)}`;
  },

  async move_path({ from, to }, ui) {
    const a = resolve(from);
    const b = resolve(to);
    if (!(await window.ide.fs.stat(a))) throw new Error('源路径不存在：' + from);
    const ok = await ui.approve({ kind: 'move', from: rel(a), to: rel(b) });
    if (!ok) return { content: '用户拒绝了移动', isError: true };
    await window.ide.fs.createDir(path.dirname(b)).catch(() => {});
    await window.ide.fs.rename(a, b);
    editors.onPathRenamed(a, b);
    return `已移动 ${rel(a)} → ${rel(b)}`;
  },

  async delete_path({ path: p }, ui) {
    const abs = resolve(p);
    if (path.same(abs, ctx.root)) throw new Error('不能删除整个工作区');
    if (!(await window.ide.fs.stat(abs))) throw new Error('路径不存在：' + p);
    const ok = await ui.approve({ kind: 'delete', path: rel(abs) });
    if (!ok) return { content: '用户拒绝了删除', isError: true };
    await window.ide.fs.delete(abs);
    await editors.onPathDeleted(abs);
    return `已将 ${rel(abs)} 移到回收站`;
  },

  async open_file({ path: p, line }) {
    const abs = resolve(p);
    await editors.openFile(abs, { line: line || undefined, pinned: true, focus: false });
    return `已在编辑器中打开 ${rel(abs)}${line ? ` 第 ${line} 行` : ''}`;
  },

  async run_command({ command, cwd, timeout_seconds }, ui) {
    needRoot();
    const dir = cwd ? resolve(cwd) : ctx.root;
    const ok = await ui.approve({ kind: 'command', command });
    if (!ok) return { content: '用户拒绝运行这条命令', isError: true };
    return runAndCapture(command, dir, timeout_seconds, ui);
  },

  async run_file({ path: p, stdin, timeout_seconds }, ui) {
    const abs = resolve(p);
    const doc = editors.getDoc(abs);
    if (doc && doc.isDirty()) await editors.saveDoc(doc);
    const r = await window.ide.run.commandFor(abs, 'powershell');
    if (r.error) throw new Error(r.error);
    if (r.open) {
      await window.ide.app.openPath(r.open);
      return '已在默认浏览器中打开该页面（HTML 文件无法捕获输出）';
    }
    // 卡片上只显示真正执行的命令，去掉 IDE 自动加的 Set-Location 包装
    const shown = r.command.replace(/^Set-Location -LiteralPath "[^"]*"; if \(\$\?\) \{ ([\s\S]*) \}$/, '$1');
    const ok = await ui.approve({ kind: 'command', command: `运行 ${rel(abs)}`, detail: shown });
    if (!ok) return { content: '用户拒绝运行', isError: true };
    return runAndCapture(r.command, r.cwd, timeout_seconds, ui, stdin);
  },

  async run_in_terminal({ command, wait_seconds, interrupt }, ui) {
    needRoot();
    const ok = await ui.approve({ kind: 'command', command, terminal: true });
    if (!ok) return { content: '用户拒绝运行这条命令', isError: true };
    const t = await aiTerminal(ctx.root);
    if (interrupt) {
      window.ide.term.write(t.id, '\x03');
      await sleep(600);
    }
    const before = terminalText(t, 2000).split('\n').length;
    t.sendText(command);
    const wait = Math.min(Math.max(wait_seconds || 5, 1), 60);
    ui.progress(`在 AI 终端中运行，等待 ${wait} 秒…`);
    await sleep(wait * 1000);
    const fresh = terminalText(t, 2000).split('\n').slice(Math.max(0, before - 1)).join('\n');
    return `命令已在“AI 终端”中启动（程序会继续运行，之后可用 read_terminal 查看）。目前的输出：\n${fresh.slice(-12000) || '（暂无输出）'}`;
  },

  async read_terminal({ name, lines }) {
    const t = findTerminal(name);
    if (!t) {
      const list = listTerminals();
      return list.length ? `没有找到终端“${name}”。现有终端：${list.map((x) => x.name).join('、')}` : '当前没有打开的终端';
    }
    const text = terminalText(t, Math.min(lines || 120, 1000));
    return `终端“${t.name}”${t.exited ? '（已退出）' : ''}最近的输出：\n${text || '（空）'}`;
  },

  async get_ide_output({ source, channel, lines }) {
    const n = Math.min(lines || 200, 1000);
    if (source === 'problems') return diagnosticsText(null);
    if (source === 'debug') return consoleText(n) || '调试控制台是空的';
    if (source === 'terminals') {
      const list = listTerminals();
      return list.length ? list.map((t) => `${t.name}${t.active ? '（当前）' : ''}${t.exited ? '（已退出）' : ''}`).join('\n') : '当前没有打开的终端';
    }
    if (source === 'output') {
      if (!channel) return `输出面板的频道：${channelNames().join('、')}。请用 channel 参数指定要看哪个。`;
      const text = channelText(channel, n);
      return text === null ? `没有名为“${channel}”的输出频道。现有频道：${channelNames().join('、')}` : text || '（空）';
    }
    throw new Error('未知的 source：' + source);
  },

  async get_diagnostics({ path: p }) {
    let target = null;
    if (p) {
      const abs = resolve(p);
      target = norm(abs);
      // 文件还没打开时先载入，让语言服务器分析一下
      if (!editors.getDoc(abs)) {
        await editors.ensureDoc(abs, { background: true }).catch(() => {});
        await sleep(2500);
      }
    }
    return diagnosticsText(target);
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
  const p = (input.path || '').replace(/\\/g, '/');
  switch (name) {
    case 'update_plan':
      return ['更新计划', ''];
    case 'create_project':
      return ['新建项目', input.name || ''];
    case 'open_folder':
      return ['打开文件夹', p];
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
    case 'create_directory':
      return ['新建文件夹', p];
    case 'move_path':
      return ['移动', `${input.from || ''} → ${input.to || ''}`];
    case 'delete_path':
      return ['删除', p];
    case 'open_file':
      return ['打开', p];
    case 'run_command':
      return ['运行命令', input.command || ''];
    case 'run_file':
      return ['运行', p];
    case 'run_in_terminal':
      return ['在终端运行', input.command || ''];
    case 'read_terminal':
      return ['查看终端', input.name || 'AI 终端'];
    case 'get_ide_output':
      return ['查看输出', { problems: '问题', debug: '调试控制台', output: '输出' + (input.channel ? '：' + input.channel : ''), terminals: '终端列表' }[input.source] || ''];
    case 'web_search':
      return ['搜索网页', input.query || ''];
    default:
      return [name, ''];
  }
}
