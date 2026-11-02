// 编辑器管理：文档模型、标签页、拆分编辑器分组、保存、差异对比、图片/Markdown 预览、导航历史。
import { ctx, saveState } from './state.js';
import { bus, path, languageForFile, fileIcon, escapeHtml, debounce, formatBytes, h, norm } from './util.js';
import { icon } from './icons.js';
import { toast, confirm, contextMenu } from './ui.js';
import { renderMarkdown } from './markdown.js';

const docs = new Map(); // norm(path) → Doc
let untitledSeq = 1;
let tabSeq = 1;
const groups = [];
let activeGroup = null;
let area = null;

const history = { back: [], forward: [], suppress: false };

// ---------------- 文档 ----------------

class Doc {
  constructor(p, model, info = {}) {
    this.path = p;
    this.model = model;
    this.encoding = info.encoding || 'utf8';
    this.mtime = info.mtime || 0;
    this.untitled = !!info.untitled;
    this.savedVersion = model.getAlternativeVersionId();
    this.background = !!info.background; // 没有标签页引用的后台模型（例如跳转定义时加载的文件）
    this.listeners = [
      model.onDidChangeContent(() => {
        bus.emit('doc:changed', this);
        updateDirty(this);
        if (ctx.settings.autoSave === 'afterDelay' && !this.untitled) this.autoSave();
      }),
    ];
    this.autoSave = debounce(() => {
      if (this.isDirty() && !this.model.isDisposed()) saveDoc(this, { auto: true });
    }, ctx.settings.autoSaveDelay || 1000);
  }
  isDirty() {
    return !this.model.isDisposed() && this.model.getAlternativeVersionId() !== this.savedVersion;
  }
  dispose() {
    this.listeners.forEach((l) => l.dispose());
    if (!this.model.isDisposed()) this.model.dispose();
    docs.delete(norm(this.path));
  }
}

function uriFor(p) {
  return ctx.monaco.Uri.file(p);
}

export function getDoc(p) {
  return docs.get(norm(p));
}

export function allDocs() {
  return [...docs.values()];
}

// 读取文件并创建模型（已有则直接返回）
export async function ensureDoc(p, { background = false } = {}) {
  const existing = getDoc(p);
  if (existing) {
    if (!background) existing.background = false;
    return existing;
  }
  const info = await window.ide.fs.readFile(p);
  if (info.kind !== 'text') return { kind: info.kind, info };
  // 并发打开同一个文件时避免重复创建
  const again = getDoc(p);
  if (again) return again;
  const monaco = ctx.monaco;
  const uri = uriFor(p);
  let model = monaco.editor.getModel(uri);
  if (model) model.setValue(info.content);
  else model = monaco.editor.createModel(info.content, languageForFile(p), uri);
  applyModelOptions(model);
  const doc = new Doc(p, model, { encoding: info.encoding, mtime: info.mtime, background });
  docs.set(norm(p), doc);
  bus.emit('doc:opened', doc);
  return doc;
}

function applyModelOptions(model) {
  const s = ctx.settings;
  model.updateOptions({ tabSize: s.tabSize, insertSpaces: s.insertSpaces, trimAutoWhitespace: true });
  if (s.detectIndentation) model.detectIndentation(s.insertSpaces, s.tabSize);
}

function newUntitled(content = '', language = 'plaintext') {
  const name = `Untitled-${untitledSeq++}`;
  const p = `untitled:${name}`;
  const model = ctx.monaco.editor.createModel(content, language, ctx.monaco.Uri.parse(p));
  applyModelOptions(model);
  const doc = new Doc(p, model, { untitled: true });
  docs.set(norm(p), doc);
  return doc;
}

function tabsForDoc(doc) {
  const out = [];
  for (const g of groups) for (const t of g.tabs) if (t.path && path.same(t.path, doc.path) && (t.type === 'file')) out.push(t);
  return out;
}

function updateDirty(doc) {
  for (const g of groups) g.renderTabs();
  bus.emit('dirty:changed');
}

export function dirtyDocs() {
  return allDocs().filter((d) => d.isDirty());
}

// ---------------- 保存 ----------------

export async function saveDoc(doc, { auto = false, as = false } = {}) {
  if (!doc) return false;
  let target = doc.path;
  if (doc.untitled || as) {
    target = await window.ide.dialog.saveFile(doc.untitled ? path.join(ctx.root || ctx.info.home, doc.path.replace('untitled:', '') + '.txt') : doc.path);
    if (!target) return false;
  }
  const model = doc.model;
  const s = ctx.settings;
  if (!auto && s.formatOnSave && !doc.untitled) {
    const ed = editorForModel(model);
    if (ed) {
      try {
        await ed.getAction('editor.action.formatDocument')?.run();
      } catch {}
    }
  }
  if (s.trimTrailingWhitespace && !auto) trimWhitespace(model);
  let text = model.getValue();
  if (s.insertFinalNewline && text && !text.endsWith('\n')) {
    const eol = model.getEOL();
    model.pushEditOperations([], [{ range: endRange(model), text: eol }], () => null);
    text = model.getValue();
  }
  try {
    const r = await window.ide.fs.writeFile(target, text, doc.encoding);
    if (doc.untitled || as) {
      // 另存为：用新路径建立文档并替换标签
      const oldPath = doc.path;
      const created = await reopenAs(doc, target, text);
      created.mtime = r.mtime;
      for (const g of groups) {
        for (const t of g.tabs) if (t.type === 'file' && t.path === oldPath) t.path = target;
      }
      doc.dispose();
      for (const g of groups) {
        g.renderTabs();
        if (g.active) g.show(g.active);
      }
      persistTabs();
    } else {
      doc.mtime = r.mtime;
      doc.savedVersion = model.getAlternativeVersionId();
    }
    updateDirty(doc);
    bus.emit('doc:saved', getDoc(target) || doc);
    return true;
  } catch (err) {
    toast('保存失败：' + err.message, 'error', 5000);
    return false;
  }
}

function endRange(model) {
  const line = model.getLineCount();
  const col = model.getLineMaxColumn(line);
  return new ctx.monaco.Range(line, col, line, col);
}

function trimWhitespace(model) {
  const edits = [];
  for (let i = 1; i <= model.getLineCount(); i++) {
    const line = model.getLineContent(i);
    const m = line.match(/\s+$/);
    if (m) edits.push({ range: new ctx.monaco.Range(i, line.length - m[0].length + 1, i, line.length + 1), text: '' });
  }
  if (edits.length) model.pushEditOperations([], edits, () => null);
}

async function reopenAs(doc, target, text) {
  let d = getDoc(target);
  if (!d) {
    const model = ctx.monaco.editor.createModel(text, languageForFile(target), uriFor(target));
    applyModelOptions(model);
    d = new Doc(target, model, { encoding: doc.encoding });
    docs.set(norm(target), d);
    bus.emit('doc:opened', d);
  } else {
    d.model.setValue(text);
    d.savedVersion = d.model.getAlternativeVersionId();
  }
  return d;
}

export async function saveActive(as = false) {
  const t = activeGroup && activeGroup.active;
  if (!t || t.type !== 'file') return;
  const doc = getDoc(t.path);
  return saveDoc(doc, { as });
}

export async function saveAll() {
  for (const d of dirtyDocs()) if (!d.untitled) await saveDoc(d);
}

// ---------------- 编辑器分组 ----------------

function editorOptions() {
  const s = ctx.settings;
  return {
    theme: ctx.isDark ? 'lumen-dark' : 'lumen-light',
    automaticLayout: true,
    fontSize: s.fontSize,
    fontFamily: s.fontFamily,
    fontLigatures: s.fontLigatures,
    lineHeight: s.lineHeight,
    wordWrap: s.wordWrap,
    minimap: { enabled: s.minimap, renderCharacters: false, scale: 1, showSlider: 'mouseover' },
    lineNumbers: s.lineNumbers,
    glyphMargin: true,
    renderWhitespace: s.renderWhitespace,
    bracketPairColorization: { enabled: s.bracketPairColorization },
    guides: { bracketPairs: 'active', indentation: true },
    stickyScroll: { enabled: s.stickyScroll },
    cursorBlinking: s.cursorBlinking,
    cursorSmoothCaretAnimation: 'on',
    smoothScrolling: s.smoothScrolling,
    autoClosingBrackets: s.autoClosingBrackets,
    quickSuggestions: s.quickSuggestions ? { other: true, comments: false, strings: true } : false,
    suggestOnTriggerCharacters: s.suggestOnTriggerCharacters,
    inlayHints: { enabled: s.inlayHints ? 'on' : 'off' },
    suggest: { showStatusBar: true, preview: true, localityBonus: true, shareSuggestSelections: true },
    wordBasedSuggestions: 'allDocuments',
    padding: { top: 8, bottom: 8 },
    scrollBeyondLastLine: true,
    renderLineHighlight: 'all',
    roundedSelection: true,
    linkedEditing: true,
    formatOnPaste: false,
    mouseWheelZoom: true,
    multiCursorModifier: 'alt',
    dragAndDrop: true,
    fixedOverflowWidgets: true,
    colorDecorators: true,
    folding: true,
    showFoldingControls: 'mouseover',
    scrollbar: { verticalScrollbarSize: 12, horizontalScrollbarSize: 12, useShadows: false },
    overviewRulerBorder: false,
    hover: { delay: 300 },
    'semanticHighlighting.enabled': true,
  };
}

class EditorGroup {
  constructor(index) {
    this.index = index;
    this.tabs = [];
    this.active = null;
    this.viewStates = new Map();
    this.el = h(`<div class="editor-group">
      <div class="tabs"><div class="tabs-scroll"></div><div class="tabs-actions"></div></div>
      <div class="breadcrumbs"></div>
      <div class="editor-body"><div class="editor-host"></div><div class="diff-host" hidden></div><div class="aux-host" hidden></div></div>
    </div>`);
    this.tabsEl = this.el.querySelector('.tabs-scroll');
    this.actionsEl = this.el.querySelector('.tabs-actions');
    this.crumbsEl = this.el.querySelector('.breadcrumbs');
    this.host = this.el.querySelector('.editor-host');
    this.diffHost = this.el.querySelector('.diff-host');
    this.aux = this.el.querySelector('.aux-host');

    this.editor = ctx.monaco.editor.create(this.host, { ...editorOptions(), model: null });
    this.editor.onDidFocusEditorWidget(() => setActiveGroup(this));
    this.editor.onDidChangeCursorPosition((e) => {
      if (activeGroup === this) bus.emit('editor:cursor', this.editor);
      if (e.reason === 3 /* Explicit 跳转 */ || e.source === 'api') return;
    });
    this.editor.onDidChangeCursorSelection(() => activeGroup === this && bus.emit('editor:cursor', this.editor));
    this.editor.onDidBlurEditorWidget(() => {
      if (ctx.settings.autoSave === 'onFocusChange') {
        const d = this.active && getDoc(this.active.path);
        if (d && d.isDirty() && !d.untitled) saveDoc(d, { auto: true });
      }
    });
    // 一旦开始编辑，预览标签固定下来
    this.editor.onDidChangeModelContent(() => {
      if (this.active && this.active.preview) {
        this.active.preview = false;
        this.renderTabs();
      }
    });
    bus.emit('editor:created', this.editor, this);

    this.el.addEventListener('mousedown', () => setActiveGroup(this), true);
    this.tabsEl.addEventListener('dblclick', (e) => {
      if (e.target === this.tabsEl) newFile();
    });
    this.tabsEl.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        this.tabsEl.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    }, { passive: false });
    this.setupDrop();
    this.renderActions();
  }

  setupDrop() {
    const body = this.el;
    body.addEventListener('dragover', (e) => {
      const types = e.dataTransfer.types;
      if (types.includes('application/x-lumen-tab') || types.includes('application/x-lumen-path') || types.includes('Files')) {
        e.preventDefault();
        if (!e.target.closest('.tab')) this.el.classList.add('drop-target');
      }
    });
    body.addEventListener('dragleave', (e) => {
      if (!this.el.contains(e.relatedTarget)) this.el.classList.remove('drop-target');
    });
    body.addEventListener('drop', (e) => {
      this.el.classList.remove('drop-target');
      const tabData = e.dataTransfer.getData('application/x-lumen-tab');
      const p = e.dataTransfer.getData('application/x-lumen-path');
      e.preventDefault();
      if (tabData) {
        const { group, id } = JSON.parse(tabData);
        const from = groups[group];
        const tab = from && from.tabs.find((t) => t.id === id);
        if (tab && from !== this) moveTab(tab, from, this);
        return;
      }
      if (p) return openFile(p, { group: this, pinned: true });
      for (const f of e.dataTransfer.files) {
        const fp = window.ide.pathForFile(f);
        if (fp) openFile(fp, { group: this, pinned: true });
      }
    });
  }

  renderActions() {
    this.actionsEl.innerHTML = '';
    const mk = (ic, title, fn) => {
      const b = h(`<button class="icon-btn" title="${title}">${icon(ic)}</button>`);
      b.onclick = fn;
      this.actionsEl.appendChild(b);
      return b;
    };
    this.runBtn = mk('play', '运行当前文件 (Ctrl+F5)', () => bus.emit('run:active'));
    this.debugBtn = mk('bug', '调试当前文件 (F5)', () => bus.emit('cmd', 'debug.start'));
    this.previewBtn = mk('eye', '打开预览 (Ctrl+Shift+V)', () => this.active && openMarkdownPreview(this.active.path, this));
    mk('split', '向右拆分编辑器 (Ctrl+\\)', () => splitEditor(this));
    mk('more', '更多操作', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      import('./ui.js').then(({ showMenu }) =>
        showMenu(
          [
            { label: '关闭所有编辑器', action: () => this.closeAll() },
            { label: '关闭已保存的编辑器', action: () => this.closeSaved() },
            { type: 'sep' },
            { label: '自动换行', checked: ctx.settings.wordWrap === 'on', action: () => bus.emit('cmd', 'view.toggleWordWrap') },
            { label: '显示小地图', checked: ctx.settings.minimap, action: () => bus.emit('cmd', 'view.toggleMinimap') },
          ],
          r.left,
          r.bottom + 4,
        ),
      );
    });
    this.updateActionVisibility();
  }

  updateActionVisibility() {
    const t = this.active;
    const isFile = t && t.type === 'file';
    this.runBtn.hidden = !isFile;
    this.debugBtn.hidden = !(isFile && /\.(py|pyw|js|mjs|cjs|c|cpp|cc|cxx)$/i.test(t.path));
    this.previewBtn.hidden = !(isFile && /\.(md|markdown)$/i.test(t.path));
  }

  renderTabs() {
    this.tabsEl.innerHTML = '';
    for (const tab of this.tabs) {
      const doc = tab.type === 'file' ? getDoc(tab.path) : null;
      const dirty = doc && doc.isDirty();
      const label = tabLabel(tab);
      const desc = duplicateDesc(tab);
      const el = h(`<div class="tab${tab === this.active ? ' active' : ''}${tab.preview ? ' preview' : ''}${dirty ? ' dirty' : ''}${tab.problem ? ' has-' + tab.problem : ''}" draggable="true" title="${escapeHtml(tab.path || label)}">
        ${tabIcon(tab)}<span class="tab-label">${escapeHtml(label)}</span>${desc ? `<span class="tab-desc">${escapeHtml(desc)}</span>` : ''}
        <button class="tab-close" title="关闭 (Ctrl+W)">${icon('close')}</button>
      </div>`);
      el.addEventListener('mousedown', (e) => {
        if (e.button === 1) {
          e.preventDefault();
          this.closeTab(tab);
        } else if (e.button === 0 && !e.target.closest('.tab-close')) this.activate(tab);
      });
      el.addEventListener('dblclick', () => {
        tab.preview = false;
        this.renderTabs();
      });
      el.querySelector('.tab-close').addEventListener('click', (e) => {
        e.stopPropagation();
        this.closeTab(tab);
      });
      el.addEventListener('contextmenu', (e) => contextMenu(e, this.tabMenu(tab)));
      el.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('application/x-lumen-tab', JSON.stringify({ group: this.index, id: tab.id }));
        if (tab.path) e.dataTransfer.setData('text/plain', tab.path);
        el.classList.add('dragging');
      });
      el.addEventListener('dragend', () => el.classList.remove('dragging'));
      el.addEventListener('dragover', (e) => {
        if (e.dataTransfer.types.includes('application/x-lumen-tab')) {
          e.preventDefault();
          el.classList.add('drop-before');
        }
      });
      el.addEventListener('dragleave', () => el.classList.remove('drop-before'));
      el.addEventListener('drop', (e) => {
        el.classList.remove('drop-before');
        const data = e.dataTransfer.getData('application/x-lumen-tab');
        if (!data) return;
        e.preventDefault();
        e.stopPropagation();
        const { group, id } = JSON.parse(data);
        const from = groups[group];
        const moving = from && from.tabs.find((t) => t.id === id);
        if (!moving || moving === tab) return;
        if (from !== this) moveTab(moving, from, this, this.tabs.indexOf(tab));
        else {
          this.tabs.splice(this.tabs.indexOf(moving), 1);
          this.tabs.splice(this.tabs.indexOf(tab), 0, moving);
          this.renderTabs();
        }
      });
      this.tabsEl.appendChild(el);
      if (tab === this.active) requestAnimationFrame(() => el.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    }
  }

  tabMenu(tab) {
    const items = [
      { label: '关闭', shortcut: 'Ctrl+W', action: () => this.closeTab(tab) },
      { label: '关闭其他', action: () => this.closeOthers(tab) },
      { label: '关闭右侧', action: () => this.closeRight(tab) },
      { label: '关闭已保存', action: () => this.closeSaved() },
      { label: '全部关闭', action: () => this.closeAll() },
      { type: 'sep' },
    ];
    if (tab.path && !tab.path.startsWith('untitled:')) {
      items.push(
        { label: '复制路径', action: () => navigator.clipboard.writeText(tab.path) },
        { label: '复制相对路径', action: () => navigator.clipboard.writeText(path.relative(ctx.root, tab.path)) },
        { label: '在资源管理器中显示', action: () => bus.emit('explorer:reveal', tab.path) },
        { label: '在系统文件管理器中显示', action: () => window.ide.app.reveal(tab.path) },
        { type: 'sep' },
        { label: '向右拆分', action: () => splitEditor(this, tab) },
      );
      if (tab.type === 'file') items.push({ label: '与 HEAD 比较', action: () => openDiff(tab.path, 'HEAD') });
    }
    return items;
  }

  ensureDiffEditor() {
    if (!this.diffEditor) {
      this.diffEditor = ctx.monaco.editor.createDiffEditor(this.diffHost, {
        ...editorOptions(),
        renderSideBySide: true,
        originalEditable: false,
        ignoreTrimWhitespace: false,
        renderOverviewRuler: true,
      });
    }
    return this.diffEditor;
  }

  saveViewState() {
    const t = this.active;
    if (!t) return;
    if (t.type === 'file') this.viewStates.set(t.id, this.editor.saveViewState());
  }

  async show(tab) {
    this.host.hidden = true;
    this.diffHost.hidden = true;
    this.aux.hidden = true;
    this.aux.innerHTML = '';
    if (tab.type === 'file') {
      const doc = getDoc(tab.path);
      if (!doc || doc.model.isDisposed()) return;
      this.host.hidden = false;
      if (this.editor.getModel() !== doc.model) this.editor.setModel(doc.model);
      const vs = this.viewStates.get(tab.id);
      if (vs) this.editor.restoreViewState(vs);
      this.editor.layout();
    } else if (tab.type === 'diff') {
      this.diffHost.hidden = false;
      const de = this.ensureDiffEditor();
      de.setModel({ original: tab.original, modified: tab.modified });
      de.layout();
    } else if (tab.type === 'image') {
      this.aux.hidden = false;
      this.aux.innerHTML = `<div class="image-view"><img src="${tab.dataUrl}"><div class="meta tabular">${escapeHtml(path.basename(tab.path))} · ${formatBytes(tab.size)}</div></div>`;
      const img = this.aux.querySelector('img');
      img.onload = () => (this.aux.querySelector('.meta').textContent += ` · ${img.naturalWidth}×${img.naturalHeight}`);
    } else if (tab.type === 'binary') {
      this.aux.hidden = false;
      this.aux.innerHTML = `<div class="empty" style="padding-top:120px">${icon('files')}<div>此文件是二进制文件或过大（${formatBytes(tab.size)}），无法在编辑器中显示。</div><button class="btn btn-sm">用系统默认程序打开</button></div>`;
      this.aux.querySelector('button').onclick = () => window.ide.app.openPath(tab.path);
    } else if (tab.type === 'markdown') {
      this.aux.hidden = false;
      const doc = getDoc(tab.path);
      const render = () => {
        const d = getDoc(tab.path);
        const text = d && !d.model.isDisposed() ? d.model.getValue() : '';
        this.aux.innerHTML = `<div class="markdown-view">${renderMarkdown(text)}</div>`;
      };
      render();
      if (doc && !tab.listener) tab.listener = doc.model.onDidChangeContent(debounce(() => this.active === tab && render(), 200));
    } else if (tab.type === 'welcome') {
      this.aux.hidden = false;
      bus.emit('welcome:render', this.aux);
    } else if (tab.type === 'html') {
      this.aux.hidden = false;
      this.aux.innerHTML = tab.html;
      tab.mount && tab.mount(this.aux);
    }
    this.renderCrumbs(tab);
    this.updateActionVisibility();
  }

  renderCrumbs(tab) {
    if (!tab || !tab.path || tab.path.startsWith('untitled:')) {
      this.crumbsEl.innerHTML = '';
      this.crumbsEl.hidden = !tab || tab.type !== 'file';
      return;
    }
    this.crumbsEl.hidden = false;
    const rel = ctx.root && path.isInside(ctx.root, tab.path) ? path.relative(ctx.root, tab.path) : tab.path;
    const parts = rel.split(/[\\/]/).filter(Boolean);
    this.crumbsEl.innerHTML = parts.map((p, i) => `<span class="crumb" data-i="${i}">${escapeHtml(p)}</span>`).join(icon('chevron'));
    this.crumbsEl.querySelectorAll('.crumb').forEach((c) => {
      c.onclick = () => bus.emit('explorer:reveal', tab.path);
    });
  }

  async activate(tab, { focus = true } = {}) {
    if (this.active && this.active !== tab) {
      this.saveViewState();
      recordHistory(this);
    }
    this.active = tab;
    setActiveGroup(this, false);
    await this.show(tab);
    this.renderTabs();
    if (focus && tab.type === 'file') this.editor.focus();
    bus.emit('editor:active', tab, this);
    persistTabs();
  }

  addTab(tab, { index } = {}) {
    tab.id = tabSeq++;
    if (index === undefined) {
      const ai = this.tabs.indexOf(this.active);
      index = ai >= 0 ? ai + 1 : this.tabs.length;
    }
    this.tabs.splice(index, 0, tab);
    return tab;
  }

  async closeTab(tab, { force = false } = {}) {
    const doc = tab.type === 'file' ? getDoc(tab.path) : null;
    if (doc && doc.isDirty() && !force && tabsForDoc(doc).length === 1) {
      const r = await confirm({ title: '保存更改？', message: `是否保存对 ${path.basename(doc.path)} 的更改？\n不保存，更改将丢失。`, buttons: ['保存', '不保存', '取消'] });
      if (r === 2 || r === -1) return false;
      if (r === 0 && !(await saveDoc(doc))) return false;
    }
    const i = this.tabs.indexOf(tab);
    if (i < 0) return true;
    this.tabs.splice(i, 1);
    if (tab.type === 'file' && !tab.path.startsWith('untitled:')) bus.emit('tab:closed', tab.path);
    this.viewStates.delete(tab.id);
    if (tab.listener) tab.listener.dispose();
    if (tab.type === 'diff') {
      if (this.diffEditor) this.diffEditor.setModel(null);
      tab.original && tab.original.dispose();
      if (tab.modifiedOwned) tab.modified.dispose();
    }
    if (doc && tabsForDoc(doc).length === 0) releaseDoc(doc);
    if (this.active === tab) {
      this.active = null;
      const next = this.tabs[Math.min(i, this.tabs.length - 1)] || null;
      if (next) await this.activate(next);
      else {
        this.editor.setModel(null);
        this.host.hidden = true;
        this.aux.hidden = true;
        this.diffHost.hidden = true;
        this.crumbsEl.innerHTML = '';
        this.updateActionVisibility();
        bus.emit('editor:active', null, this);
      }
    }
    this.renderTabs();
    if (!this.tabs.length && groups.length > 1) removeGroup(this);
    else if (!this.tabs.length && groups.length === 1) showWelcome();
    persistTabs();
    return true;
  }

  async closeOthers(keep) {
    for (const t of [...this.tabs]) if (t !== keep) if (!(await this.closeTab(t))) return;
  }
  async closeRight(tab) {
    const i = this.tabs.indexOf(tab);
    for (const t of this.tabs.slice(i + 1)) if (!(await this.closeTab(t))) return;
  }
  async closeSaved() {
    for (const t of [...this.tabs]) {
      const d = t.type === 'file' && getDoc(t.path);
      if (!d || !d.isDirty()) await this.closeTab(t);
    }
  }
  async closeAll() {
    for (const t of [...this.tabs]) if (!(await this.closeTab(t))) return false;
    return true;
  }

  updateOptions() {
    const opts = editorOptions();
    this.editor.updateOptions(opts);
    if (this.diffEditor) this.diffEditor.updateOptions(opts);
  }

  dispose() {
    this.editor.dispose();
    if (this.diffEditor) this.diffEditor.dispose();
    this.el.remove();
  }
}

// 文档不再被标签页引用时：TS/JS 文件保留为后台模型（供跨文件补全），其余释放
function releaseDoc(doc) {
  if (doc.isDirty() || doc.untitled) {
    doc.dispose();
    return;
  }
  if (['typescript', 'javascript'].includes(doc.model.getLanguageId()) && ctx.root && path.isInside(ctx.root, doc.path)) {
    doc.background = true;
    return;
  }
  doc.dispose();
}

function tabLabel(tab) {
  if (tab.title) return tab.title;
  if (tab.type === 'welcome') return '欢迎';
  if (tab.path && tab.path.startsWith('untitled:')) return tab.path.slice(9);
  return path.basename(tab.path || '');
}

function tabIcon(tab) {
  if (tab.type === 'welcome') return `<span class="file-icon fi-ink">L</span>`;
  if (tab.type === 'diff') return `<span class="file-icon fi-blue">±</span>`;
  if (tab.type === 'markdown') return `<span class="file-icon fi-ink">${icon('eye')}</span>`;
  if (tab.type === 'html') return `<span class="file-icon fi-ink">${tab.iconText || '·'}</span>`;
  return fileIcon(path.basename(tab.path || ''));
}

// 同名文件显示所在目录以便区分
function duplicateDesc(tab) {
  if (!tab.path || tab.type !== 'file' || tab.path.startsWith('untitled:')) return '';
  const name = path.basename(tab.path).toLowerCase();
  let dup = false;
  for (const g of groups) for (const t of g.tabs) if (t !== tab && t.path && t.type === 'file' && path.basename(t.path).toLowerCase() === name && !path.same(t.path, tab.path)) dup = true;
  if (!dup) return '';
  const dir = path.dirname(tab.path);
  return ctx.root ? path.relative(ctx.root, dir) || path.basename(dir) : path.basename(dir);
}

function setActiveGroup(g, emit = true) {
  if (activeGroup === g) return;
  activeGroup = g;
  for (const x of groups) x.el.classList.toggle('inactive', x !== g);
  if (emit) bus.emit('editor:active', g.active, g);
  if (g.active && g.active.type === 'file') bus.emit('editor:cursor', g.editor);
}

function addGroup() {
  const g = new EditorGroup(groups.length);
  groups.push(g);
  area.appendChild(g.el);
  return g;
}

function removeGroup(g) {
  const i = groups.indexOf(g);
  groups.splice(i, 1);
  groups.forEach((x, j) => (x.index = j));
  g.dispose();
  if (activeGroup === g) {
    activeGroup = null;
    setActiveGroup(groups[Math.max(0, i - 1)]);
    if (activeGroup.active && activeGroup.active.type === 'file') activeGroup.editor.focus();
  }
  persistTabs();
}

function moveTab(tab, from, to, index) {
  from.tabs.splice(from.tabs.indexOf(tab), 1);
  if (from.active === tab) {
    from.active = null;
    const next = from.tabs[0];
    if (next) from.activate(next, { focus: false });
  }
  from.renderTabs();
  to.addTab(tab, { index });
  to.activate(tab);
  if (!from.tabs.length && groups.length > 1) removeGroup(from);
}

export function splitEditor(group = activeGroup, tab = group && group.active) {
  if (!tab) return;
  let target = groups[group.index + 1];
  if (!target) {
    if (groups.length >= 3) target = groups[groups.length - 1];
    else target = addGroup();
  }
  const copy = { ...tab, id: undefined, listener: null, preview: false };
  if (tab.type === 'diff') return openDiff(tab.path, tab.ref, target);
  target.addTab(copy);
  target.activate(copy);
}

export function focusGroup(i) {
  const g = groups[i];
  if (g) {
    setActiveGroup(g);
    if (g.active && g.active.type === 'file') g.editor.focus();
  }
}

// ---------------- 打开 ----------------

function findTab(predicate) {
  for (const g of groups) {
    const t = g.tabs.find(predicate);
    if (t) return { group: g, tab: t };
  }
  return null;
}

function removeWelcome(g) {
  const w = g.tabs.find((t) => t.type === 'welcome');
  if (w) g.closeTab(w);
}

/**
 * 打开文件。opts: { group, preview, pinned, line, column, selection, focus }
 */
export async function openFile(p, opts = {}) {
  const g = opts.group || activeGroup;
  let tab = g.tabs.find((t) => t.path && path.same(t.path, p) && ['file', 'image', 'binary'].includes(t.type));
  if (!tab) {
    const res = await ensureDoc(p);
    if (res instanceof Doc) tab = { type: 'file', path: res.path };
    else if (res.kind === 'image') tab = { type: 'image', path: p, dataUrl: res.info.dataUrl, size: res.info.size };
    else if (res.kind === 'binary' || res.kind === 'toolarge') tab = { type: 'binary', path: p, size: res.info.size };
    else return;
    const preview = opts.preview && !opts.pinned;
    tab.preview = !!preview;
    // 预览标签会被下一个预览替换
    const existingPreview = preview && g.tabs.find((t) => t.preview);
    if (existingPreview) {
      const i = g.tabs.indexOf(existingPreview);
      g.addTab(tab, { index: i });
      await g.closeTab(existingPreview);
    } else g.addTab(tab);
    removeWelcome(g);
  } else if (opts.pinned && tab.preview) tab.preview = false;
  await g.activate(tab, { focus: opts.focus !== false });
  if (tab.type === 'file') revealPosition(g.editor, opts);
  return tab;
}

function revealPosition(editor, { line, column, selection }) {
  const monaco = ctx.monaco;
  if (selection) {
    const r = new monaco.Range(selection.startLineNumber, selection.startColumn, selection.endLineNumber || selection.startLineNumber, selection.endColumn || selection.startColumn);
    editor.setSelection(r);
    editor.revealRangeInCenterIfOutsideViewport(r, 0);
  } else if (line) {
    const pos = { lineNumber: line, column: column || 1 };
    editor.setPosition(pos);
    editor.revealPositionInCenterIfOutsideViewport(pos, 0);
  }
}

export function newFile(content = '', language = 'plaintext') {
  const doc = newUntitled(content, language);
  const g = activeGroup;
  const tab = g.addTab({ type: 'file', path: doc.path });
  removeWelcome(g);
  g.activate(tab);
  return doc;
}

export async function openDiff(p, ref = 'HEAD', group = activeGroup) {
  if (!ctx.root) return;
  const monaco = ctx.monaco;
  const original = await window.ide.git.show(ctx.root, p, ref);
  const lang = languageForFile(p);
  const origModel = monaco.editor.createModel(original, lang, monaco.Uri.parse(`git-${ref.replace(/\W/g, '')}:/${Date.now()}/${encodeURIComponent(path.basename(p))}`));
  let modified;
  let owned = false;
  if (ref === ':0' || ref === 'HEAD') {
    const exists = await window.ide.fs.exists(p);
    if (exists) {
      const d = await ensureDoc(p, { background: true });
      if (d instanceof Doc) modified = d.model;
    }
  }
  if (!modified) {
    modified = monaco.editor.createModel('', lang);
    owned = true;
  }
  const label = ref === 'HEAD' ? 'HEAD' : ref === ':0' ? '暂存' : ref;
  const tab = group.addTab({ type: 'diff', path: p, ref, original: origModel, modified, modifiedOwned: owned, title: `${path.basename(p)} (${label} ↔ 工作区)` });
  removeWelcome(group);
  await group.activate(tab);
}

export async function openMarkdownPreview(p, group = activeGroup) {
  let target = groups[group.index + 1] || (groups.length < 3 ? addGroup() : group);
  const existing = target.tabs.find((t) => t.type === 'markdown' && path.same(t.path, p));
  if (existing) return target.activate(existing);
  await ensureDoc(p, { background: true });
  const tab = target.addTab({ type: 'markdown', path: p, title: '预览 ' + path.basename(p) });
  await target.activate(tab, { focus: false });
}

// 打开一个自定义 HTML 页签（快捷键表等）
export async function openHtmlTab({ key, title, html, mount, iconText }) {
  const found = findTab((t) => t.type === 'html' && t.key === key);
  if (found) return found.group.activate(found.tab);
  const tab = activeGroup.addTab({ type: 'html', key, title, html, mount, iconText });
  removeWelcome(activeGroup);
  await activeGroup.activate(tab);
}

export function showWelcome() {
  const g = groups[0];
  if (g.tabs.some((t) => t.type === 'welcome')) return g.activate(g.tabs.find((t) => t.type === 'welcome'));
  const tab = g.addTab({ type: 'welcome' });
  g.activate(tab, { focus: false });
}

export function rerenderWelcome() {
  for (const g of groups) if (g.active && g.active.type === 'welcome') g.show(g.active);
}

// ---------------- 访问器 ----------------

export function activeEditor() {
  if (!activeGroup || !activeGroup.active) return null;
  if (activeGroup.active.type === 'file') return activeGroup.editor;
  if (activeGroup.active.type === 'diff') return activeGroup.diffEditor.getModifiedEditor();
  return null;
}

export function activeTab() {
  return activeGroup && activeGroup.active;
}

export function activeDoc() {
  const t = activeTab();
  return t && t.type === 'file' ? getDoc(t.path) : null;
}

export function activeGroupRef() {
  return activeGroup;
}

export function allGroups() {
  return groups;
}

export function editorForModel(model) {
  for (const g of groups) if (g.editor.getModel() === model) return g.editor;
  return null;
}

export function closeActiveTab() {
  const g = activeGroup;
  if (g && g.active) g.closeTab(g.active);
}

export async function closeAllGroups() {
  for (const g of [...groups]) if (!(await g.closeAll())) return false;
  return true;
}

export function updateAllOptions() {
  for (const g of groups) g.updateOptions();
  for (const d of docs.values()) applyModelOptions(d.model);
}

export function nextTab(dir = 1) {
  const g = activeGroup;
  if (!g || g.tabs.length < 2) return;
  const i = g.tabs.indexOf(g.active);
  g.activate(g.tabs[(i + dir + g.tabs.length) % g.tabs.length]);
}

// ---------------- 导航历史（Alt+← / Alt+→）----------------

function recordHistory(g) {
  if (history.suppress) return;
  const t = g.active;
  if (!t || t.type !== 'file' || !g.editor.getPosition()) return;
  const pos = g.editor.getPosition();
  history.back.push({ path: t.path, line: pos.lineNumber, column: pos.column });
  if (history.back.length > 100) history.back.shift();
  history.forward = [];
}

export function recordCurrentPosition() {
  if (activeGroup) recordHistory(activeGroup);
}

export async function navigate(dir) {
  const from = dir < 0 ? history.back : history.forward;
  const to = dir < 0 ? history.forward : history.back;
  const item = from.pop();
  if (!item) return;
  const ed = activeEditor();
  const cur = activeTab();
  if (cur && cur.type === 'file' && ed) to.push({ path: cur.path, line: ed.getPosition().lineNumber, column: ed.getPosition().column });
  history.suppress = true;
  try {
    if (getDoc(item.path) || !item.path.startsWith('untitled:')) await openFile(item.path, { line: item.line, column: item.column, pinned: true });
  } finally {
    history.suppress = false;
  }
}

// ---------------- 外部修改 ----------------

export async function onExternalChange(paths) {
  for (const p of paths) {
    const doc = getDoc(p);
    if (!doc || doc.untitled) continue;
    const st = await window.ide.fs.stat(p);
    if (!st) continue; // 删除：保留编辑器内容
    if (Math.abs(st.mtime - doc.mtime) < 1) continue;
    if (doc.isDirty()) {
      toast(`${path.basename(p)} 已在磁盘上被修改，当前有未保存的更改`, 'error', 4000);
      doc.mtime = st.mtime;
      continue;
    }
    const info = await window.ide.fs.readFile(p);
    if (info.kind !== 'text') continue;
    if (info.content !== doc.model.getValue()) {
      doc.model.pushEditOperations([], [{ range: doc.model.getFullModelRange(), text: info.content }], () => null);
      doc.savedVersion = doc.model.getAlternativeVersionId();
      updateDirty(doc);
    }
    doc.mtime = info.mtime;
  }
}

// 文件被重命名/删除时更新标签
export function onPathRenamed(from, to) {
  for (const d of [...docs.values()]) {
    if (d.untitled || !path.isInside(from, d.path)) continue;
    const np = to + d.path.slice(from.length);
    const text = d.model.getValue();
    const dirty = d.isDirty();
    const model = ctx.monaco.editor.createModel(text, languageForFile(np), uriFor(np));
    applyModelOptions(model);
    const nd = new Doc(np, model, { encoding: d.encoding, mtime: d.mtime });
    if (!dirty) nd.savedVersion = model.getAlternativeVersionId();
    else nd.savedVersion = -1;
    docs.set(norm(np), nd);
    for (const g of groups) {
      for (const t of g.tabs) if (t.path && path.same(t.path, d.path)) t.path = np;
      if (g.editor.getModel() === d.model) g.editor.setModel(model);
    }
    d.dispose();
    bus.emit('doc:opened', nd);
  }
  for (const g of groups) {
    g.renderTabs();
    if (g.active) g.renderCrumbs(g.active);
  }
  persistTabs();
}

export async function onPathDeleted(p) {
  for (const g of groups) for (const t of [...g.tabs]) if (t.path && path.isInside(p, t.path)) {
    const d = getDoc(t.path);
    if (d) d.savedVersion = -1; // 标记为未保存，避免内容丢失
    await g.closeTab(t, { force: true });
  }
}

// ---------------- 持久化 ----------------

const persistTabs = debounce(() => {
  if (!groups.length) return;
  const state = groups.map((g) => ({
    tabs: g.tabs.filter((t) => (t.type === 'file' || t.type === 'image') && !t.path.startsWith('untitled:')).map((t) => t.path),
    active: g.active && g.active.path,
  }));
  if (ctx.root) saveState({ ['tabs:' + ctx.root]: state });
}, 300);

export async function restoreTabs(state) {
  if (!state || !state.length) return false;
  let any = false;
  for (let i = 0; i < state.length; i++) {
    const g = groups[i] || addGroup();
    for (const p of state[i].tabs) {
      if (!(await window.ide.fs.exists(p))) continue;
      const res = await ensureDoc(p);
      if (res instanceof Doc) g.addTab({ type: 'file', path: p }, { index: g.tabs.length });
      else if (res.kind === 'image') g.addTab({ type: 'image', path: p, dataUrl: res.info.dataUrl, size: res.info.size }, { index: g.tabs.length });
      any = true;
    }
    const act = g.tabs.find((t) => state[i].active && path.same(t.path, state[i].active)) || g.tabs[0];
    if (act) await g.activate(act, { focus: false });
    else if (i > 0 && !g.tabs.length) removeGroup(g);
  }
  return any;
}

// ---------------- 初始化 ----------------

export function initEditors() {
  area = document.getElementById('editor-area');
  const g = addGroup();
  activeGroup = g;

  // 跨文件跳转（转到定义、查找引用）时由我们打开对应标签
  ctx.monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      if (resource.scheme !== 'file') return false;
      const opts = { pinned: true };
      if (selectionOrPosition && 'startLineNumber' in selectionOrPosition) opts.selection = selectionOrPosition;
      else if (selectionOrPosition) {
        opts.line = selectionOrPosition.lineNumber;
        opts.column = selectionOrPosition.column;
      }
      recordCurrentPosition();
      openFile(resource.fsPath, opts);
      return true;
    },
  });

  bus.on('settings:changed', () => updateAllOptions());
  bus.on('theme:changed', () => ctx.monaco.editor.setTheme(ctx.isDark ? 'lumen-dark' : 'lumen-light'));
  window.addEventListener('blur', () => {
    if (ctx.settings.autoSave === 'onFocusChange' || ctx.settings.autoSave === 'afterDelay') for (const d of dirtyDocs()) if (!d.untitled) saveDoc(d, { auto: true });
  });
  bus.on('markers:changed', (byPath) => {
    for (const gr of groups) {
      for (const t of gr.tabs) {
        const m = t.path && t.type === 'file' && byPath.get(norm(t.path));
        t.problem = m ? (m.errors ? 'error' : m.warnings ? 'warning' : null) : null;
      }
      gr.renderTabs();
    }
  });
}

export function resetForWorkspace() {
  for (const d of [...docs.values()]) d.dispose();
  for (const g of [...groups].slice(1)) removeGroup(g);
  const g0 = groups[0];
  g0.tabs = [];
  g0.active = null;
  g0.editor.setModel(null);
  g0.renderTabs();
}

export { Doc };
