// AI 助手面板（窗口右侧）：对话、流式显示思考与回答、工具调用卡片、修改确认、代码块操作。
import { ctx, saveState, updateSettings } from './state.js';
import { bus, path, escapeHtml, h, languageForFile } from './util.js';
import { icon } from './icons.js';
import { toast, prompt } from './ui.js';
import { registerCommand } from './commands.js';
import * as editors from './editors.js';
import { renderMarkdown } from './markdown.js';
import { executeTool, describeTool } from './ai-tools.js';

let panel;
let bodyEl;
let listEl;
let inputEl;
let sendBtn;
let ctxEl;
let usageEl;
let config = null;
let sessionId = newSessionId();
let running = false;
let useContext = true;
let turn = null; // 当前回答：{ el, blocks: Map }

function newSessionId() {
  return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ---------------- 面板显示 ----------------

export function togglePanel(force) {
  const show = force !== undefined ? force : document.body.classList.contains('ai-hidden');
  document.body.classList.toggle('ai-hidden', !show);
  document.querySelector('.activity[data-action=ai]').classList.toggle('active', show);
  saveState({ aiHidden: !show });
  if (show) {
    refreshConfig();
    setTimeout(() => inputEl && inputEl.focus(), 50);
  }
}

async function refreshConfig() {
  config = await window.ide.ai.config();
  panel.querySelector('.ai-model').textContent = config.model;
  renderBody();
}

function ready() {
  return config && (config.hasKey || config.envKey);
}

function renderBody() {
  if (!ready()) {
    renderSetup();
    return;
  }
  if (!listEl.isConnected) {
    bodyEl.innerHTML = '';
    bodyEl.appendChild(listEl);
  }
  if (!listEl.childElementCount) renderEmpty();
}

function renderEmpty() {
  listEl.innerHTML = `<div class="ai-empty">
    <div class="ai-empty-icon">${icon('sparkle')}</div>
    <div class="ai-empty-title">有什么可以帮你？</div>
    <div class="ai-empty-sub">我可以阅读整个项目、修改文件、运行命令。所有修改都会先给你看差异，确认后才写入。</div>
    <div class="ai-suggestions">
      <button>解释一下这个项目的结构</button>
      <button>帮我找出当前文件里的 bug 并修复</button>
      <button>给当前文件写单元测试</button>
    </div></div>`;
  listEl.querySelectorAll('.ai-suggestions button').forEach((b) => (b.onclick = () => send(b.textContent)));
}

function renderSetup() {
  bodyEl.innerHTML = `<div class="ai-setup">
    <div class="ai-empty-icon">${icon('sparkle')}</div>
    <div class="ai-empty-title">配置 AI 助手</div>
    <div class="ai-empty-sub">AI 助手通过 Claude API 工作，需要你自己的 API Key。Key 会用系统加密保存在本机，只在调用 API 时使用。</div>
    <label>API Key</label><input class="input" type="password" data-k="key" placeholder="sk-ant-…" spellcheck="false" autocomplete="off">
    <label>Base URL <span class="muted">（可选，使用代理或中转服务时填写）</span></label><input class="input" data-k="base" placeholder="https://api.anthropic.com" spellcheck="false" value="${escapeHtml(ctx.settings.aiBaseURL || '')}">
    <label>模型</label><input class="input" data-k="model" spellcheck="false" value="${escapeHtml(ctx.settings.aiModel || 'claude-opus-5-5')}">
    <button class="btn btn-primary" data-a="save">保存并测试连接</button>
    <div class="ai-setup-msg"></div>
    <button class="btn-link" data-a="console">还没有 API Key？前往 Anthropic 控制台创建</button>
  </div>`;
  const q = (k) => bodyEl.querySelector(`[data-k=${k}]`);
  const msg = bodyEl.querySelector('.ai-setup-msg');
  bodyEl.querySelector('[data-a=console]').onclick = () => window.ide.app.openExternal('https://console.anthropic.com/');
  bodyEl.querySelector('[data-a=save]').onclick = async () => {
    const key = q('key').value.trim();
    if (!key) {
      msg.textContent = '请填写 API Key';
      return;
    }
    msg.textContent = '正在测试连接…';
    await updateSettings({ aiBaseURL: q('base').value.trim(), aiModel: q('model').value.trim() || 'claude-opus-5-5' });
    await window.ide.ai.setKey(key);
    const r = await window.ide.ai.test();
    msg.textContent = r.message;
    msg.className = 'ai-setup-msg ' + (r.ok ? 'ok' : 'err');
    if (r.ok) setTimeout(refreshConfig, 600);
  };
}

// ---------------- 发送 ----------------

function contextInfo() {
  const t = editors.activeTab();
  if (!useContext || !t || t.type !== 'file' || t.path.startsWith('untitled:')) return null;
  const ed = editors.activeEditor();
  const model = ed && ed.getModel();
  const sel = ed && ed.getSelection();
  const info = { path: t.path, rel: ctx.root ? path.relative(ctx.root, t.path).replace(/\\/g, '/') : t.path, lang: languageForFile(t.path) };
  if (model && sel && !sel.isEmpty()) {
    info.selection = model.getValueInRange(sel);
    info.startLine = sel.startLineNumber;
    info.endLine = sel.endLineNumber;
  }
  return info;
}

function renderContextChip() {
  const c = contextInfo();
  ctxEl.innerHTML = '';
  const chip = h(`<button class="ai-chip${useContext ? ' on' : ''}" title="发送时附带当前文件和选中的代码">${icon('files')}<span></span></button>`);
  chip.querySelector('span').textContent = !useContext ? '不附带当前文件' : c ? `${path.basename(c.path)}${c.selection ? `：第 ${c.startLine}-${c.endLine} 行` : ''}` : '没有打开的文件';
  chip.onclick = () => {
    useContext = !useContext;
    renderContextChip();
  };
  ctxEl.appendChild(chip);
}

function buildMessage(text, extra) {
  const c = contextInfo();
  const parts = [];
  if (c) {
    parts.push(`<当前文件>${c.rel}</当前文件>`);
    if (c.selection) parts.push(`<选中的代码 行="${c.startLine}-${c.endLine}">\n${c.selection}\n</选中的代码>`);
  }
  if (extra) parts.push(extra);
  return { content: (parts.length ? parts.join('\n') + '\n\n' : '') + text, chip: c ? `${path.basename(c.path)}${c.selection ? ` · 第 ${c.startLine}-${c.endLine} 行` : ''}` : '' };
}

export async function send(text, extra) {
  text = (text || '').trim();
  if (!text || running) return;
  if (!ready()) {
    togglePanel(true);
    return toast('请先配置 API Key', 'error');
  }
  togglePanel(true);
  const { content, chip } = buildMessage(text, extra);
  if (listEl.querySelector('.ai-empty')) listEl.innerHTML = '';
  const userEl = h(`<div class="ai-msg user"><div class="ai-bubble"></div>${chip ? `<div class="ai-msg-chip">${icon('files')}${escapeHtml(chip)}</div>` : ''}</div>`);
  userEl.querySelector('.ai-bubble').textContent = text;
  listEl.appendChild(userEl);
  turn = { el: h('<div class="ai-msg assistant"><div class="ai-working"><span class="ai-dots"><i></i><i></i><i></i></span>思考中</div></div>'), blocks: new Map() };
  listEl.appendChild(turn.el);
  scrollToBottom(true);
  inputEl.value = '';
  autoGrow();
  setRunning(true);
  await window.ide.ai.send(sessionId, content, { root: ctx.root || null });
}

function setRunning(v) {
  running = v;
  sendBtn.innerHTML = icon(v ? 'stop' : 'send');
  sendBtn.title = v ? '停止' : '发送 (Enter)';
  sendBtn.classList.toggle('stop', v);
  panel.classList.toggle('running', v);
}

function scrollToBottom(force) {
  const near = bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 120;
  if (force || near) bodyEl.scrollTop = bodyEl.scrollHeight;
}

// ---------------- 渲染回答 ----------------

function block(round, index) {
  return turn && turn.blocks.get(`${round}:${index}`);
}

function hideWorking() {
  const w = turn && turn.el.querySelector('.ai-working');
  if (w) w.remove();
}

function onBlockStart(e) {
  if (!turn) return;
  hideWorking();
  const key = `${e.round}:${e.index}`;
  let b;
  if (e.kind === 'thinking') {
    b = { kind: 'thinking', text: '', el: h(`<details class="ai-thinking"><summary>${icon('bolt')}<span>正在思考…</span></summary><div class="ai-thinking-body"></div></details>`) };
    b.el.hidden = true; // 有内容时再显示
  } else if (e.kind === 'text') {
    b = { kind: 'text', text: '', el: h('<div class="ai-text markdown-view"></div>') };
  } else if (e.kind === 'tool_use') {
    b = { kind: 'tool', name: e.name, id: e.id, inputChars: 0, el: h(`<div class="ai-tool" data-tool="${e.id}"><div class="ai-tool-head">${icon(toolIcon(e.name))}<span class="ai-tool-label">${escapeHtml(describeTool(e.name)[0])}</span><span class="ai-tool-target"></span><span class="ai-tool-status"><span class="spinner"></span></span></div></div>`) };
  } else return;
  turn.blocks.set(key, b);
  turn.el.appendChild(b.el);
  scrollToBottom();
}

function toolIcon(name) {
  return { read_file: 'files', list_files: 'folder', search_text: 'search', edit_file: 'diff', write_file: 'newFile', run_command: 'terminal', get_diagnostics: 'warning' }[name] || 'bolt';
}

let renderTimer = null;
function onDelta(e) {
  const b = block(e.round, e.index);
  if (!b) return;
  if (b.kind === 'text') {
    b.text += e.text;
    if (!renderTimer) renderTimer = setTimeout(flushText, 60);
  } else if (b.kind === 'thinking') {
    b.text += e.text;
    b.el.hidden = !b.text.trim();
    b.el.querySelector('.ai-thinking-body').textContent = b.text;
  } else if (b.kind === 'tool') {
    b.inputChars += e.text.length;
    if (b.name === 'edit_file' || b.name === 'write_file') b.el.querySelector('.ai-tool-status').innerHTML = `<span class="spinner"></span><span class="muted">${b.inputChars} 字符</span>`;
  }
  scrollToBottom();
}

function flushText() {
  renderTimer = null;
  if (!turn) return;
  for (const b of turn.blocks.values()) {
    if (b.kind === 'text' && b.rendered !== b.text.length) {
      b.el.innerHTML = renderMarkdown(b.text);
      b.rendered = b.text.length;
    }
  }
  scrollToBottom();
}

const LANG_ALIAS = { js: 'javascript', ts: 'typescript', py: 'python', sh: 'shell', bash: 'shell', ps1: 'powershell', 'c++': 'cpp', cs: 'csharp', rs: 'rust', md: 'markdown', yml: 'yaml', jsx: 'javascript', tsx: 'typescript' };

// 回答结束后：代码块着色并加上“复制 / 插入”按钮
function finalizeText(el) {
  el.querySelectorAll('pre > code').forEach(async (code) => {
    const pre = code.parentElement;
    const raw = code.textContent;
    let lang = (code.className.match(/lang-([\w+#-]+)/) || [])[1] || '';
    lang = LANG_ALIAS[lang.toLowerCase()] || lang.toLowerCase();
    const bar = h(`<div class="ai-code-bar"><span>${escapeHtml(lang || '代码')}</span><button title="复制">${icon('openFile')}复制</button><button title="插入到编辑器光标处">${icon('plus')}插入</button></div>`);
    const [copyBtn, insertBtn] = bar.querySelectorAll('button');
    copyBtn.onclick = () => navigator.clipboard.writeText(raw).then(() => toast('已复制', 'success'));
    insertBtn.onclick = () => insertIntoEditor(raw);
    pre.parentElement.insertBefore(bar, pre);
    pre.classList.add('ai-code');
    if (lang && ctx.monaco.languages.getLanguages().some((l) => l.id === lang)) {
      try {
        code.innerHTML = await ctx.monaco.editor.colorize(raw, lang, { tabSize: 4 });
      } catch {}
    }
  });
  el.querySelectorAll('a[href]').forEach((a) => {
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      if (/^https?:/.test(a.href)) window.ide.app.openExternal(a.href);
    });
  });
}

function insertIntoEditor(text) {
  const ed = editors.activeEditor();
  if (!ed) return toast('没有打开的编辑器', 'error');
  const sel = ed.getSelection();
  ed.executeEdits('ai', [{ range: sel, text, forceMoveMarkers: true }]);
  ed.focus();
}

// ---------------- 工具调用 ----------------

function toolBlock(id) {
  if (!turn) return null;
  for (const b of turn.blocks.values()) if (b.kind === 'tool' && b.id === id) return b;
  return null;
}

function diffStat(a, b) {
  const count = new Map();
  for (const l of a.split(/\r?\n/)) count.set(l, (count.get(l) || 0) + 1);
  let added = 0;
  for (const l of b.split(/\r?\n/)) {
    const n = count.get(l);
    if (n) count.set(l, n - 1);
    else added++;
  }
  let removed = 0;
  for (const n of count.values()) removed += n;
  return { added, removed };
}

async function onToolCall({ sessionId: sid, callId, id, name, input }) {
  if (sid !== sessionId) return window.ide.ai.toolResult(callId, { content: '会话已切换', isError: true });
  const b = toolBlock(id) || { el: h(`<div class="ai-tool"><div class="ai-tool-head">${icon(toolIcon(name))}<span class="ai-tool-label"></span><span class="ai-tool-target"></span><span class="ai-tool-status"></span></div></div>`) };
  if (!b.el.isConnected && turn) turn.el.appendChild(b.el);
  const [label, target] = describeTool(name, input);
  b.el.querySelector('.ai-tool-label').textContent = label;
  b.el.querySelector('.ai-tool-target').textContent = target;
  b.el.querySelector('.ai-tool-target').title = target;
  const status = b.el.querySelector('.ai-tool-status');
  status.innerHTML = '<span class="spinner"></span>';
  const diffKey = 'ai:' + callId;

  const ui = {
    approve: (req) =>
      new Promise((resolve) => {
        const auto = req.kind === 'command' ? ctx.settings.aiAutoRun : ctx.settings.aiAutoApply;
        const detail = h('<div class="ai-tool-detail"></div>');
        b.el.appendChild(detail);
        // 短命令在标题行已经能看全，长命令或多行命令才单独展开显示
        if (req.kind === 'command') detail.innerHTML = req.command.length > 48 || req.command.includes('\n') ? `<pre class="ai-cmd">${escapeHtml(req.command)}</pre>` : '';
        else {
          const st = diffStat(req.original, req.modified);
          detail.innerHTML = `<div class="ai-diffstat"><span class="add">+${st.added}</span><span class="del">-${st.removed}</span>${req.kind === 'create' ? '<span class="muted">新文件</span>' : ''}<button class="btn-link" data-a="diff">查看差异</button></div>`;
          const showDiff = () => editors.openTextDiff({ path: req.path, original: req.original, modified: req.modified, title: `AI 修改：${path.basename(req.path)}`, key: diffKey });
          detail.querySelector('[data-a=diff]').onclick = showDiff;
          if (!auto) showDiff();
        }
        if (auto) return resolve(true);
        status.innerHTML = '<span class="muted">等待确认</span>';
        const acts = h(`<div class="ai-tool-actions"><button class="btn btn-sm" data-a="no">拒绝</button><button class="btn btn-sm btn-primary" data-a="yes">${req.kind === 'command' ? '运行' : '应用修改'}</button></div>`);
        b.el.appendChild(acts);
        b.el.classList.add('pending');
        scrollToBottom(true);
        const done = (ok) => {
          acts.remove();
          b.el.classList.remove('pending');
          editors.closeTabByKey(diffKey);
          resolve(ok);
        };
        acts.querySelector('[data-a=yes]').onclick = () => done(true);
        acts.querySelector('[data-a=no]').onclick = () => done(false);
        b.cancel = () => done(false);
      }),
    progress: (text) => (status.innerHTML = `<span class="spinner"></span><span class="muted">${escapeHtml(text)}</span>`),
    output: (text, code) => {
      const pre = h(`<pre class="ai-cmd-out${code === 0 ? '' : ' err'}"></pre>`);
      pre.textContent = (text || '（无输出）').slice(-4000);
      b.el.appendChild(pre);
    },
  };

  const r = await executeTool(name, input, ui);
  b.cancel = null;
  status.innerHTML = r.isError ? `<span class="dot error"></span><span class="muted" title="${escapeHtml(r.content)}">${escapeHtml(r.content.split('\n')[0].slice(0, 40))}</span>` : `${icon('check')}`;
  b.el.classList.toggle('failed', !!r.isError);
  window.ide.ai.toolResult(callId, r);
  scrollToBottom();
}

// ---------------- 事件 ----------------

function onEvent(e) {
  if (e.sessionId !== sessionId) return;
  switch (e.type) {
    case 'block_start':
      onBlockStart(e);
      break;
    case 'delta':
      onDelta(e);
      break;
    case 'tool_invalid': {
      const b = toolBlock(e.id);
      if (b) b.el.querySelector('.ai-tool-status').innerHTML = `<span class="dot error"></span><span class="muted">${escapeHtml(e.message)}</span>`;
      break;
    }
    case 'usage':
      renderUsage(e.usage, e.model);
      break;
    case 'error': {
      hideWorking();
      if (e.code === 'no-key') refreshConfig();
      const el = h(`<div class="ai-error"><span class="dot error"></span><span></span></div>`);
      el.querySelector('span:last-child').textContent = e.message;
      (turn ? turn.el : listEl).appendChild(el);
      scrollToBottom(true);
      break;
    }
    case 'done':
      if (renderTimer) {
        clearTimeout(renderTimer);
        flushText();
      }
      if (turn) {
        hideWorking();
        for (const b of turn.blocks.values()) {
          if (b.kind === 'text') finalizeText(b.el);
          if (b.kind === 'thinking') b.el.querySelector('summary span').textContent = '思考过程';
          if (b.kind === 'tool' && b.cancel) b.cancel();
          if (b.kind === 'tool' && b.el.querySelector('.ai-tool-status .spinner')) b.el.querySelector('.ai-tool-status').innerHTML = '<span class="muted">已停止</span>';
        }
        if (e.aborted) turn.el.appendChild(h('<div class="ai-note">已停止</div>'));
      }
      turn = null;
      setRunning(false);
      break;
  }
}

function fmt(n) {
  return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n);
}

function renderUsage(u, model) {
  usageEl.textContent = `本轮 输入 ${fmt(u.input + u.cacheRead + u.cacheWrite)}${u.cacheRead ? `（缓存 ${fmt(u.cacheRead)}）` : ''} · 输出 ${fmt(u.output)} tokens`;
  usageEl.title = `模型：${model}`;
}

function autoGrow() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(220, inputEl.scrollHeight) + 'px';
}

export async function newChat() {
  if (running) await window.ide.ai.stop(sessionId);
  await window.ide.ai.reset(sessionId);
  sessionId = newSessionId();
  turn = null;
  listEl.innerHTML = '';
  usageEl.textContent = '';
  setRunning(false);
  renderBody();
  inputEl.focus();
}

// ---------------- 编辑器里的 AI 操作 ----------------

function selectionOrWarn() {
  const ed = editors.activeEditor();
  const c = contextInfo();
  if (!ed || !c) {
    toast('请先在编辑器中打开文件', 'error');
    return null;
  }
  return c;
}

async function editSelection() {
  const c = selectionOrWarn();
  if (!c) return;
  const instr = await prompt({ title: 'AI 修改代码', message: c.selection ? `修改 ${path.basename(c.path)} 第 ${c.startLine}-${c.endLine} 行` : `修改 ${path.basename(c.path)}`, placeholder: '例如：改成异步写法 / 加上错误处理 / 加注释' });
  if (!instr) return;
  useContext = true;
  send(`${c.selection ? '请按要求修改选中的代码' : '请按要求修改当前文件'}：${instr}`);
}

function explainSelection() {
  const c = selectionOrWarn();
  if (!c) return;
  useContext = true;
  send(c.selection ? '解释一下选中的这段代码是做什么的，有没有潜在问题。' : '解释一下当前文件的作用和主要逻辑。');
}

function fixProblems() {
  const c = selectionOrWarn();
  if (!c) return;
  const M = ctx.monaco.MarkerSeverity;
  const model = editors.activeEditor().getModel();
  const markers = ctx.monaco.editor.getModelMarkers({ resource: model.uri }).filter((m) => m.severity >= M.Warning);
  useContext = true;
  if (!markers.length) return send('检查当前文件，找出可能的 bug 并修复。');
  const list = markers.slice(0, 50).map((m) => `第 ${m.startLineNumber} 行：${m.message.split('\n')[0]}`).join('\n');
  send('修复当前文件中编辑器报告的问题。', `<编辑器报告的问题>\n${list}\n</编辑器报告的问题>`);
}

function attachEditorActions(editor) {
  const add = (id, label, run, order, key) =>
    editor.addAction({ id, label, contextMenuGroupId: '0_ai', contextMenuOrder: order, keybindings: key, run });
  add('lumen.ai.edit', 'AI：修改代码…', editSelection, 1);
  add('lumen.ai.explain', 'AI：解释代码', explainSelection, 2);
  add('lumen.ai.fix', 'AI：修复问题', fixProblems, 3);
}

// ---------------- 初始化 ----------------

function setupSash(state) {
  const sash = document.getElementById('sash-ai');
  if (state.aiWidth) panel.style.width = state.aiWidth + 'px';
  sash.addEventListener('mousedown', (e) => {
    e.preventDefault();
    sash.classList.add('dragging');
    document.body.classList.add('resizing');
    const move = (ev) => {
      const right = panel.getBoundingClientRect().right;
      panel.style.width = Math.max(300, Math.min(window.innerWidth - 500, right - ev.clientX)) + 'px';
    };
    const up = () => {
      sash.classList.remove('dragging');
      document.body.classList.remove('resizing');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      saveState({ aiWidth: panel.offsetWidth });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}

export function initAiPanel(state) {
  panel = document.getElementById('ai-panel');
  panel.innerHTML = `
    <div class="ai-header">${icon('sparkle')}<span class="ai-title">AI 助手</span><span class="ai-model"></span>
      <div class="view-actions">
        <button class="icon-btn" data-a="new" title="新对话">${icon('plus')}</button>
        <button class="icon-btn" data-a="settings" title="AI 设置">${icon('gear')}</button>
        <button class="icon-btn" data-a="close" title="关闭 (Ctrl+Alt+I)">${icon('close')}</button>
      </div></div>
    <div class="ai-body"></div>
    <div class="ai-footer">
      <div class="ai-context"></div>
      <div class="ai-input-wrap"><textarea class="ai-input" rows="1" placeholder="让 AI 帮你写代码、改 bug、解释项目…（Enter 发送，Shift+Enter 换行）" spellcheck="false"></textarea><button class="ai-send" title="发送 (Enter)"></button></div>
      <div class="ai-meta"><span class="ai-usage"></span><label class="ai-auto" title="开启后 AI 的文件修改直接生效，不再逐个确认"><input type="checkbox"> 自动应用修改</label></div>
    </div>`;
  bodyEl = panel.querySelector('.ai-body');
  listEl = h('<div class="ai-list"></div>');
  inputEl = panel.querySelector('.ai-input');
  sendBtn = panel.querySelector('.ai-send');
  ctxEl = panel.querySelector('.ai-context');
  usageEl = panel.querySelector('.ai-usage');
  const auto = panel.querySelector('.ai-auto input');
  auto.checked = !!ctx.settings.aiAutoApply;
  auto.onchange = () => updateSettings({ aiAutoApply: auto.checked });
  setRunning(false);

  inputEl.addEventListener('input', autoGrow);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send(inputEl.value);
    }
  });
  sendBtn.onclick = () => (running ? window.ide.ai.stop(sessionId) : send(inputEl.value));
  panel.querySelector('[data-a=new]').onclick = newChat;
  panel.querySelector('[data-a=close]').onclick = () => togglePanel(false);
  panel.querySelector('[data-a=settings]').onclick = () => import('./settings-view.js').then((m) => m.openSettings('ai'));

  window.ide.ai.onEvent(onEvent);
  window.ide.ai.onToolCall(onToolCall);
  bus.on('editor:active', renderContextChip);
  bus.on('editor:cursor', renderContextChip);
  bus.on('settings:changed', (s, patch) => {
    auto.checked = !!s.aiAutoApply;
    if ('aiModel' in patch || 'aiBaseURL' in patch) refreshConfig();
  });
  bus.on('editor:created', attachEditorActions);
  for (const g of editors.allGroups()) attachEditorActions(g.editor);

  setupSash(state);
  if (state.aiHidden === false) togglePanel(true);
  else document.body.classList.add('ai-hidden');
  renderContextChip();
  refreshConfig();

  const C = (id, title, key, run) => registerCommand({ id, title, category: 'AI', key, run });
  C('ai.toggle', '打开/关闭 AI 助手', 'Ctrl+Alt+I', () => togglePanel());
  C('ai.newChat', '新对话', null, newChat);
  C('ai.edit', '修改选中的代码…', 'Ctrl+Alt+K', editSelection);
  C('ai.explain', '解释选中的代码', null, explainSelection);
  C('ai.fix', '修复当前文件的问题', null, fixProblems);
  C('ai.settings', 'AI 设置', null, () => import('./settings-view.js').then((m) => m.openSettings('ai')));
}

export function refreshAiConfig() {
  return refreshConfig();
}
