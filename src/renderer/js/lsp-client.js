// LSP 客户端：把主进程里的语言服务器接到 Monaco 的各种 Provider 上
// （补全、悬停、签名、定义、引用、高亮、大纲、格式化、重命名、代码操作、内联提示、诊断）。
import { ctx } from './state.js';
import { bus, path, norm } from './util.js';
import * as editors from './editors.js';
import { log } from './output.js';

// Monaco 语言 → 状态 { state, name, capabilities, lspLanguageId, message }
const langState = new Map();
const registered = new Set();
const opened = new Map(); // uri → { languageId, version }
// 未打开文件的诊断（例如 pyright 扫描整个工作区）
export const externalDiagnostics = new Map(); // norm(path) → markers

const SUPPORTED = new Set(['python', 'c', 'cpp', 'objective-c', 'go', 'rust', 'java', 'csharp', 'php', 'shell', 'lua', 'ruby', 'kotlin', 'dart', 'yaml']);

export function lspStatus(languageId) {
  return langState.get(languageId);
}

export function allLspStatus() {
  return [...langState.entries()];
}

function isFileModel(model) {
  return model.uri.scheme === 'file';
}

function toPos(p) {
  return { line: p.lineNumber - 1, character: p.column - 1 };
}

function toRange(r) {
  const m = ctx.monaco;
  return new m.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);
}

function fromRange(r) {
  return { start: { line: r.startLineNumber - 1, character: r.startColumn - 1 }, end: { line: r.endLineNumber - 1, character: r.endColumn - 1 } };
}

function uriToPath(uri) {
  return ctx.monaco.Uri.parse(uri).fsPath;
}

function modelFor(uri) {
  const p = uriToPath(uri);
  const d = editors.getDoc(p);
  return d ? d.model : ctx.monaco.editor.getModel(ctx.monaco.Uri.file(p));
}

function markdown(contents) {
  if (!contents) return [];
  const arr = Array.isArray(contents) ? contents : [contents];
  return arr
    .map((c) => {
      if (typeof c === 'string') return { value: c };
      if (c.kind) return { value: c.kind === 'plaintext' ? escapeMd(c.value) : c.value };
      if (c.language) return { value: '```' + c.language + '\n' + c.value + '\n```' };
      return { value: String(c.value || '') };
    })
    .filter((x) => x.value);
}

function escapeMd(s) {
  return s.replace(/[\\`*_{}[\]()#+\-.!|]/g, '\\$&');
}

function docString(d) {
  if (!d) return undefined;
  if (typeof d === 'string') return d;
  return d.kind === 'markdown' ? { value: d.value } : d.value;
}

async function request(languageId, method, params) {
  const st = langState.get(languageId);
  if (!st || st.state !== 'ready') return null;
  try {
    return await window.ide.lsp.request(languageId, ctx.root, method, params);
  } catch (err) {
    if (!/取消|cancel|超时/i.test(err.message)) log('LSP', `${method} 失败：${err.message}`);
    return null;
  }
}

function notify(languageId, method, params) {
  window.ide.lsp.notify(languageId, ctx.root, method, params);
}

// ---------------- 文档同步 ----------------

function didOpen(model) {
  const languageId = model.getLanguageId();
  const st = langState.get(languageId);
  if (!st || st.state !== 'ready' || !isFileModel(model)) return;
  const uri = model.uri.toString();
  if (opened.has(uri)) return;
  opened.set(uri, { languageId, version: model.getVersionId() });
  notify(languageId, 'textDocument/didOpen', { textDocument: { uri, languageId: st.lspLanguageId, version: model.getVersionId(), text: model.getValue() } });
}

function didClose(model) {
  const uri = model.uri.toString();
  const o = opened.get(uri);
  if (!o) return;
  opened.delete(uri);
  notify(o.languageId, 'textDocument/didClose', { textDocument: { uri } });
}

function syncKind(st) {
  const s = st.capabilities.textDocumentSync;
  if (typeof s === 'number') return s;
  return s && s.change !== undefined ? s.change : 1;
}

function didChange(model, e) {
  const uri = model.uri.toString();
  const o = opened.get(uri);
  if (!o) return;
  const st = langState.get(o.languageId);
  const version = model.getVersionId();
  const contentChanges = syncKind(st) === 2 ? e.changes.map((c) => ({ range: fromRange(c.range), rangeLength: c.rangeLength, text: c.text })) : [{ text: model.getValue() }];
  notify(o.languageId, 'textDocument/didChange', { textDocument: { uri, version }, contentChanges });
}

function attachModel(model) {
  if (!isFileModel(model)) return;
  model.onDidChangeContent((e) => didChange(model, e));
  model.onWillDispose(() => didClose(model));
  model.onDidChangeLanguage(() => {
    didClose(model);
    ensureLanguage(model.getLanguageId()).then(() => didOpen(model));
  });
  ensureLanguage(model.getLanguageId()).then(() => didOpen(model));
}

// ---------------- 启动语言服务器 ----------------

const starting = new Map();

export function ensureLanguage(languageId) {
  if (!ctx.root || !SUPPORTED.has(languageId)) return Promise.resolve(false);
  const st = langState.get(languageId);
  if (st && (st.state === 'ready' || st.state === 'missing')) return Promise.resolve(st.state === 'ready');
  if (starting.has(languageId)) return starting.get(languageId);
  langState.set(languageId, { state: 'starting' });
  bus.emit('lsp:changed');
  const p = window.ide.lsp
    .start(languageId, ctx.root)
    .then((res) => {
      if (!res.ok) {
        langState.set(languageId, { state: 'missing', message: res.message || '没有可用的语言服务器', install: res.install });
        if (res.reason === 'missing') log('LSP', `${languageId}: ${res.message || ''}`);
        return false;
      }
      langState.set(languageId, { state: 'ready', name: res.name, capabilities: res.capabilities || {}, lspLanguageId: res.lspLanguageId });
      log('LSP', `${res.name} 已就绪（${languageId}）`);
      registerProviders(languageId);
      for (const m of ctx.monaco.editor.getModels()) if (m.getLanguageId() === languageId) didOpen(m);
      return true;
    })
    .finally(() => {
      starting.delete(languageId);
      bus.emit('lsp:changed');
    });
  starting.set(languageId, p);
  return p;
}

export async function restartLanguage(languageId) {
  for (const [uri, o] of [...opened]) if (o.languageId === languageId) opened.delete(uri);
  langState.delete(languageId);
  await window.ide.lsp.restart(languageId, ctx.root);
  langState.delete(languageId);
  return ensureLanguage(languageId);
}

export function resetForWorkspace() {
  if (ctx.root) window.ide.lsp.stopRoot(ctx.root);
  langState.clear();
  opened.clear();
  externalDiagnostics.clear();
  bus.emit('lsp:changed');
}

// ---------------- Provider ----------------

const KIND_NAMES = [null, 'Text', 'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class', 'Interface', 'Module', 'Property', 'Unit', 'Value', 'Enum', 'Keyword', 'Snippet', 'Color', 'File', 'Reference', 'Folder', 'EnumMember', 'Constant', 'Struct', 'Event', 'Operator', 'TypeParameter'];
const SYMBOL_KINDS = [null, 'File', 'Module', 'Namespace', 'Package', 'Class', 'Method', 'Property', 'Field', 'Constructor', 'Enum', 'Interface', 'Function', 'Variable', 'Constant', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Key', 'Null', 'EnumMember', 'Struct', 'Event', 'Operator', 'TypeParameter'];

function completionKind(k) {
  const M = ctx.monaco.languages.CompletionItemKind;
  return M[KIND_NAMES[k]] ?? M.Text;
}

function symbolKind(k) {
  const M = ctx.monaco.languages.SymbolKind;
  return M[SYMBOL_KINDS[k]] ?? M.Variable;
}

function convertTextEdit(e) {
  return { range: toRange(e.range), text: e.newText };
}

function convertCompletion(item, model, position, defaultRange) {
  const monaco = ctx.monaco;
  let range = defaultRange;
  let insertText = item.insertText || item.label;
  if (item.textEdit) {
    insertText = item.textEdit.newText;
    if (item.textEdit.insert) range = { insert: toRange(item.textEdit.insert), replace: toRange(item.textEdit.replace) };
    else range = toRange(item.textEdit.range);
  }
  const label = item.labelDetails ? { label: item.label, detail: item.labelDetails.detail, description: item.labelDetails.description } : item.label;
  return {
    label,
    kind: completionKind(item.kind),
    detail: item.detail,
    documentation: docString(item.documentation),
    insertText,
    insertTextRules: item.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
    range,
    sortText: item.sortText,
    filterText: item.filterText,
    preselect: item.preselect,
    tags: item.deprecated || (item.tags || []).includes(1) ? [1] : undefined,
    commitCharacters: item.commitCharacters,
    additionalTextEdits: (item.additionalTextEdits || []).map(convertTextEdit),
    command: item.command ? { id: 'lumen.lsp.executeCommand', title: item.command.title, arguments: [model.getLanguageId(), item.command] } : undefined,
    _lsp: item,
    _lang: model.getLanguageId(),
  };
}

function convertLocations(res) {
  if (!res) return [];
  const list = Array.isArray(res) ? res : [res];
  return list.map((l) => ({
    uri: ctx.monaco.Uri.file(uriToPath(l.targetUri || l.uri)),
    range: toRange(l.targetSelectionRange || l.targetRange || l.range),
  }));
}

// 跳转目标所在文件需要先有模型，Monaco 才能显示预览（Peek）
async function preloadLocations(locs) {
  for (const l of locs) {
    const p = l.uri.fsPath;
    if (!ctx.monaco.editor.getModel(l.uri)) await editors.ensureDoc(p, { background: true }).catch(() => {});
  }
  return locs;
}

async function convertWorkspaceEdit(we) {
  if (!we) return null;
  const edits = [];
  const push = async (uri, list, version) => {
    const p = uriToPath(uri);
    await editors.ensureDoc(p, { background: true }).catch(() => {});
    const resource = ctx.monaco.Uri.file(p);
    for (const e of list) edits.push({ resource, textEdit: { range: toRange(e.range), text: e.newText }, versionId: version ?? undefined });
  };
  if (we.documentChanges) {
    for (const dc of we.documentChanges) if (dc.edits) await push(dc.textDocument.uri, dc.edits, undefined);
  } else if (we.changes) {
    for (const [uri, list] of Object.entries(we.changes)) await push(uri, list);
  }
  return { edits };
}

function td(model) {
  return { uri: model.uri.toString() };
}

function registerProviders(languageId) {
  if (registered.has(languageId)) return;
  registered.add(languageId);
  const monaco = ctx.monaco;
  const L = monaco.languages;
  const caps = () => (langState.get(languageId) || {}).capabilities || {};
  const ready = (model) => opened.has(model.uri.toString());

  const c = caps();
  L.registerCompletionItemProvider(languageId, {
    triggerCharacters: (c.completionProvider && c.completionProvider.triggerCharacters) || ['.'],
    async provideCompletionItems(model, position, context) {
      if (!ready(model)) return { suggestions: [] };
      const res = await request(languageId, 'textDocument/completion', {
        textDocument: td(model),
        position: toPos(position),
        context: { triggerKind: context.triggerKind === 1 ? 2 : context.triggerKind === 2 ? 3 : 1, triggerCharacter: context.triggerCharacter },
      });
      if (!res) return { suggestions: [] };
      const items = Array.isArray(res) ? res : res.items || [];
      const word = model.getWordUntilPosition(position);
      const defaultRange = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      return { suggestions: items.map((i) => convertCompletion(i, model, position, defaultRange)), incomplete: !!res.isIncomplete };
    },
    async resolveCompletionItem(item) {
      if (!caps().completionProvider || !caps().completionProvider.resolveProvider || !item._lsp) return item;
      const r = await request(item._lang, 'completionItem/resolve', item._lsp);
      if (!r) return item;
      item.detail = r.detail || item.detail;
      item.documentation = docString(r.documentation) || item.documentation;
      if (r.additionalTextEdits) item.additionalTextEdits = r.additionalTextEdits.map(convertTextEdit);
      return item;
    },
  });

  L.registerHoverProvider(languageId, {
    async provideHover(model, position) {
      if (!ready(model) || !caps().hoverProvider) return null;
      const r = await request(languageId, 'textDocument/hover', { textDocument: td(model), position: toPos(position) });
      if (!r || !r.contents) return null;
      return { contents: markdown(r.contents), range: r.range ? toRange(r.range) : undefined };
    },
  });

  L.registerSignatureHelpProvider(languageId, {
    signatureHelpTriggerCharacters: (c.signatureHelpProvider && c.signatureHelpProvider.triggerCharacters) || ['(', ','],
    signatureHelpRetriggerCharacters: (c.signatureHelpProvider && c.signatureHelpProvider.retriggerCharacters) || [','],
    async provideSignatureHelp(model, position, _token, context) {
      if (!ready(model) || !caps().signatureHelpProvider) return null;
      const r = await request(languageId, 'textDocument/signatureHelp', { textDocument: td(model), position: toPos(position), context: { triggerKind: context.triggerKind, triggerCharacter: context.triggerCharacter, isRetrigger: context.isRetrigger } });
      if (!r || !r.signatures || !r.signatures.length) return null;
      return {
        value: {
          signatures: r.signatures.map((s) => ({ label: s.label, documentation: docString(s.documentation), parameters: (s.parameters || []).map((p) => ({ label: p.label, documentation: docString(p.documentation) })), activeParameter: s.activeParameter })),
          activeSignature: r.activeSignature || 0,
          activeParameter: r.activeParameter || 0,
        },
        dispose() {},
      };
    },
  });

  const locProvider = (method, cap) => ({
    async provide(model, position) {
      if (!ready(model) || !caps()[cap]) return null;
      const r = await request(languageId, method, { textDocument: td(model), position: toPos(position) });
      return preloadLocations(convertLocations(r));
    },
  });
  const def = locProvider('textDocument/definition', 'definitionProvider');
  L.registerDefinitionProvider(languageId, { provideDefinition: def.provide });
  const decl = locProvider('textDocument/declaration', 'declarationProvider');
  L.registerDeclarationProvider(languageId, { provideDeclaration: decl.provide });
  const typeDef = locProvider('textDocument/typeDefinition', 'typeDefinitionProvider');
  L.registerTypeDefinitionProvider(languageId, { provideTypeDefinition: typeDef.provide });
  const impl = locProvider('textDocument/implementation', 'implementationProvider');
  L.registerImplementationProvider(languageId, { provideImplementation: impl.provide });

  L.registerReferenceProvider(languageId, {
    async provideReferences(model, position, context) {
      if (!ready(model) || !caps().referencesProvider) return null;
      const r = await request(languageId, 'textDocument/references', { textDocument: td(model), position: toPos(position), context: { includeDeclaration: context.includeDeclaration } });
      return preloadLocations(convertLocations(r));
    },
  });

  L.registerDocumentHighlightProvider(languageId, {
    async provideDocumentHighlights(model, position) {
      if (!ready(model) || !caps().documentHighlightProvider) return null;
      const r = await request(languageId, 'textDocument/documentHighlight', { textDocument: td(model), position: toPos(position) });
      return (r || []).map((x) => ({ range: toRange(x.range), kind: (x.kind || 1) - 1 }));
    },
  });

  L.registerDocumentSymbolProvider(languageId, {
    displayName: 'LSP',
    async provideDocumentSymbols(model) {
      if (!ready(model) || !caps().documentSymbolProvider) return null;
      const r = await request(languageId, 'textDocument/documentSymbol', { textDocument: td(model) });
      if (!r) return null;
      const conv = (s) => ({
        name: s.name,
        detail: s.detail || '',
        kind: symbolKind(s.kind),
        tags: [],
        range: toRange(s.range || s.location.range),
        selectionRange: toRange(s.selectionRange || s.range || s.location.range),
        children: (s.children || []).map(conv),
        containerName: s.containerName,
      });
      return r.map(conv);
    },
  });

  L.registerDocumentFormattingEditProvider(languageId, {
    async provideDocumentFormattingEdits(model, options) {
      if (!ready(model) || !caps().documentFormattingProvider) return null;
      const r = await request(languageId, 'textDocument/formatting', { textDocument: td(model), options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces } });
      return (r || []).map(convertTextEdit);
    },
  });

  L.registerDocumentRangeFormattingEditProvider(languageId, {
    async provideDocumentRangeFormattingEdits(model, range, options) {
      if (!ready(model) || !caps().documentRangeFormattingProvider) return null;
      const r = await request(languageId, 'textDocument/rangeFormatting', { textDocument: td(model), range: fromRange(range), options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces } });
      return (r || []).map(convertTextEdit);
    },
  });

  L.registerRenameProvider(languageId, {
    async provideRenameEdits(model, position, newName) {
      if (!ready(model) || !caps().renameProvider) return null;
      const r = await request(languageId, 'textDocument/rename', { textDocument: td(model), position: toPos(position), newName });
      return (await convertWorkspaceEdit(r)) || { edits: [], rejectReason: '无法重命名此符号' };
    },
    async resolveRenameLocation(model, position) {
      const word = model.getWordAtPosition(position);
      const fallback = word ? { range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn), text: word.word } : null;
      const rp = caps().renameProvider;
      if (!rp || typeof rp !== 'object' || !rp.prepareProvider) return fallback || { rejectReason: '这里没有可以重命名的符号' };
      const r = await request(languageId, 'textDocument/prepareRename', { textDocument: td(model), position: toPos(position) });
      if (!r) return { range: fallback && fallback.range, text: fallback && fallback.text, rejectReason: fallback ? undefined : '这里没有可以重命名的符号' };
      if (r.range) return { range: toRange(r.range), text: r.placeholder || model.getValueInRange(toRange(r.range)) };
      if (r.start) return { range: toRange(r), text: model.getValueInRange(toRange(r)) };
      return fallback;
    },
  });

  L.registerCodeActionProvider(languageId, {
    async provideCodeActions(model, range, context) {
      if (!ready(model) || !caps().codeActionProvider) return { actions: [], dispose() {} };
      const diagnostics = context.markers.map((m) => ({ range: fromRange(m), message: m.message, severity: m.severity === 8 ? 1 : m.severity === 4 ? 2 : 3, code: m.code && (m.code.value || m.code), source: m.source }));
      const r = await request(languageId, 'textDocument/codeAction', { textDocument: td(model), range: fromRange(range), context: { diagnostics, only: context.only ? [context.only] : undefined } });
      const actions = [];
      for (const a of r || []) {
        if (a.command && typeof a.command === 'string') {
          actions.push({ title: a.title, command: { id: 'lumen.lsp.executeCommand', title: a.title, arguments: [languageId, a] } });
          continue;
        }
        actions.push({
          title: a.title,
          kind: a.kind,
          isPreferred: a.isPreferred,
          diagnostics: context.markers,
          edit: a.edit ? await convertWorkspaceEdit(a.edit) : undefined,
          command: a.command ? { id: 'lumen.lsp.executeCommand', title: a.command.title, arguments: [languageId, a.command] } : undefined,
        });
      }
      return { actions, dispose() {} };
    },
  });

  L.registerInlayHintsProvider(languageId, {
    async provideInlayHints(model, range) {
      if (!ready(model) || !caps().inlayHintProvider || !ctx.settings.inlayHints) return { hints: [], dispose() {} };
      const r = await request(languageId, 'textDocument/inlayHint', { textDocument: td(model), range: fromRange(range) });
      const hints = (r || []).map((x) => ({
        label: typeof x.label === 'string' ? x.label : x.label.map((p) => p.value).join(''),
        position: { lineNumber: x.position.line + 1, column: x.position.character + 1 },
        kind: x.kind,
        paddingLeft: x.paddingLeft,
        paddingRight: x.paddingRight,
      }));
      return { hints, dispose() {} };
    },
  });
}

// ---------------- 诊断 ----------------

function severity(s) {
  const M = ctx.monaco.MarkerSeverity;
  return s === 1 ? M.Error : s === 2 ? M.Warning : s === 3 ? M.Info : M.Hint;
}

function onDiagnostics(params, server) {
  const p = uriToPath(params.uri);
  const markers = params.diagnostics.map((d) => ({
    severity: severity(d.severity || 1),
    message: d.message,
    source: d.source || server,
    code: d.code !== undefined ? String(typeof d.code === 'object' ? d.code.value : d.code) : undefined,
    startLineNumber: d.range.start.line + 1,
    startColumn: d.range.start.character + 1,
    endLineNumber: d.range.end.line + 1,
    endColumn: d.range.end.character + 1,
    tags: d.tags,
  }));
  const model = modelFor(params.uri);
  if (model) {
    ctx.monaco.editor.setModelMarkers(model, 'lsp', markers);
    externalDiagnostics.delete(norm(p));
  } else {
    if (markers.length) externalDiagnostics.set(norm(p), { path: p, markers });
    else externalDiagnostics.delete(norm(p));
    bus.emit('problems:external');
  }
}

// ---------------- 初始化 ----------------

export function initLsp() {
  const monaco = ctx.monaco;
  monaco.editor.onDidCreateModel(attachModel);
  for (const m of monaco.editor.getModels()) attachModel(m);

  monaco.editor.registerCommand('lumen.lsp.executeCommand', async (_accessor, languageId, cmd) => {
    if (!cmd) return;
    await request(languageId, 'workspace/executeCommand', { command: cmd.command, arguments: cmd.arguments });
  });

  window.ide.lsp.onNotification(({ server, method, params }) => {
    if (method === 'textDocument/publishDiagnostics') onDiagnostics(params, server);
    else if (method === 'window/logMessage') log('LSP', `[${server}] ${params.message}`);
    else if (method === 'window/showMessage') {
      log('LSP', `[${server}] ${params.message}`);
      if (params.type === 1) import('./ui.js').then(({ toast }) => toast(`${server}: ${params.message}`, 'error', 5000));
    } else if (method === '$/progress' && params.value) bus.emit('lsp:progress', server, params.value);
  });
  window.ide.lsp.onStatus((s) => {
    if (s.root !== ctx.root) return;
    if (s.state === 'stopped' || s.state === 'error') {
      for (const lang of s.languages) {
        if (langState.get(lang) && langState.get(lang).state === 'ready') {
          langState.set(lang, { state: 'missing', message: s.message });
          for (const [uri, o] of [...opened]) if (o.languageId === lang) opened.delete(uri);
        }
      }
      log('LSP', `${s.server} 已停止：${s.message || ''}`);
      bus.emit('lsp:changed');
    }
  });
  window.ide.lsp.onLog(({ server, text }) => log('LSP', `[${server}] ${text.trimEnd()}`));
  window.ide.lsp.onApplyEdit(async ({ edit }) => {
    const we = await convertWorkspaceEdit(edit);
    if (!we) return;
    const byModel = new Map();
    for (const e of we.edits) {
      const m = monaco.editor.getModel(e.resource);
      if (!m) continue;
      if (!byModel.has(m)) byModel.set(m, []);
      byModel.get(m).push({ range: e.textEdit.range, text: e.textEdit.text });
    }
    for (const [m, list] of byModel) m.pushEditOperations([], list, () => null);
  });
}

export { path };
