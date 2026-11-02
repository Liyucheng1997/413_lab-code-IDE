// 加载 Monaco（AMD 版本，中文界面），定义与界面一致的浅色/深色主题。
const VS = 'app://ide/node_modules/monaco-editor/min/vs';

export function loadMonaco() {
  return new Promise((resolve, reject) => {
    const req = window.require;
    req.config({ paths: { vs: VS } });
    globalThis._VSCODE_NLS_LANGUAGE = 'zh-cn';
    req(['vs/nls.messages.zh-cn'], () => {
      req(['vs/editor/editor.main'], () => {
        defineThemes(window.monaco);
        configureLanguages(window.monaco);
        resolve(window.monaco);
      }, reject);
    }, () => req(['vs/editor/editor.main'], () => resolve(window.monaco), reject));
  });
}

function defineThemes(monaco) {
  monaco.editor.defineTheme('lumen-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '8e8e93', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'ad3da4' },
      { token: 'keyword.control', foreground: 'ad3da4' },
      { token: 'string', foreground: 'c41a16' },
      { token: 'string.escape', foreground: 'c93400' },
      { token: 'number', foreground: '1c00cf' },
      { token: 'regexp', foreground: 'c93400' },
      { token: 'type', foreground: '0b4f79' },
      { token: 'type.identifier', foreground: '0b4f79' },
      { token: 'identifier', foreground: '1d1d1f' },
      { token: 'delimiter', foreground: '3a3a3c' },
      { token: 'tag', foreground: 'ad3da4' },
      { token: 'attribute.name', foreground: '836c28' },
      { token: 'attribute.value', foreground: 'c41a16' },
      { token: 'metatag', foreground: '643820' },
      { token: 'annotation', foreground: '643820' },
      { token: 'variable', foreground: '0f68a0' },
      { token: 'constant', foreground: '1c00cf' },
      { token: 'predefined', foreground: '326d74' },
    ],
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#1d1d1f',
      'editorLineNumber.foreground': '#aeaeb2',
      'editorLineNumber.activeForeground': '#1d1d1f',
      'editor.lineHighlightBackground': '#f5f5f7',
      'editor.lineHighlightBorder': '#00000000',
      'editor.selectionBackground': '#b3d7ff',
      'editor.inactiveSelectionBackground': '#dde7f5',
      'editorCursor.foreground': '#0071e3',
      'editorIndentGuide.background1': '#ececf0',
      'editorIndentGuide.activeBackground1': '#d2d2d7',
      'editorWhitespace.foreground': '#d2d2d7',
      'editorWidget.background': '#ffffff',
      'editorWidget.border': '#e5e5ea',
      'editorSuggestWidget.background': '#ffffff',
      'editorSuggestWidget.border': '#e5e5ea',
      'editorSuggestWidget.selectedBackground': '#e8f2fd',
      'editorSuggestWidget.highlightForeground': '#0071e3',
      'editorHoverWidget.background': '#ffffff',
      'editorHoverWidget.border': '#e5e5ea',
      'list.hoverBackground': '#f5f5f7',
      'list.activeSelectionBackground': '#0071e3',
      'list.focusBackground': '#e8f2fd',
      'list.highlightForeground': '#0071e3',
      'focusBorder': '#0071e380',
      'scrollbarSlider.background': '#d2d2d780',
      'scrollbarSlider.hoverBackground': '#aeaeb2a0',
      'minimap.background': '#ffffff',
      'editorGutter.background': '#ffffff',
      'editorBracketMatch.background': '#e8f2fd',
      'editorBracketMatch.border': '#0071e360',
      'diffEditor.insertedTextBackground': '#248a3d22',
      'diffEditor.removedTextBackground': '#d7001522',
      'editorError.foreground': '#d70015',
      'editorWarning.foreground': '#c93400',
      'editorInfo.foreground': '#0071e3',
      'quickInput.background': '#ffffff',
      'input.background': '#ffffff',
      'input.border': '#d2d2d7',
      'peekViewEditor.background': '#fbfbfd',
      'peekViewResult.background': '#f5f5f7',
      'peekView.border': '#0071e3',
    },
  });

  monaco.editor.defineTheme('lumen-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '7f8c98', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'ff7ab2' },
      { token: 'string', foreground: 'ff8170' },
      { token: 'string.escape', foreground: 'ffa14f' },
      { token: 'number', foreground: 'd9c97c' },
      { token: 'regexp', foreground: 'ffa14f' },
      { token: 'type', foreground: '6bdfff' },
      { token: 'type.identifier', foreground: '6bdfff' },
      { token: 'identifier', foreground: 'f5f5f7' },
      { token: 'delimiter', foreground: 'c7c7cc' },
      { token: 'tag', foreground: 'ff7ab2' },
      { token: 'attribute.name', foreground: 'd9c97c' },
      { token: 'attribute.value', foreground: 'ff8170' },
      { token: 'metatag', foreground: 'fd8f3f' },
      { token: 'annotation', foreground: 'fd8f3f' },
      { token: 'variable', foreground: '4eb0cc' },
      { token: 'constant', foreground: 'd9c97c' },
      { token: 'predefined', foreground: 'b281eb' },
    ],
    colors: {
      'editor.background': '#1c1c1e',
      'editor.foreground': '#f5f5f7',
      'editorLineNumber.foreground': '#636366',
      'editorLineNumber.activeForeground': '#f5f5f7',
      'editor.lineHighlightBackground': '#2c2c2e',
      'editor.lineHighlightBorder': '#00000000',
      'editor.selectionBackground': '#0a84ff55',
      'editor.inactiveSelectionBackground': '#0a84ff28',
      'editorCursor.foreground': '#0a84ff',
      'editorIndentGuide.background1': '#2c2c2e',
      'editorIndentGuide.activeBackground1': '#48484a',
      'editorWhitespace.foreground': '#48484a',
      'editorWidget.background': '#2c2c2e',
      'editorWidget.border': '#38383a',
      'editorSuggestWidget.background': '#2c2c2e',
      'editorSuggestWidget.border': '#38383a',
      'editorSuggestWidget.selectedBackground': '#0a84ff40',
      'editorSuggestWidget.highlightForeground': '#409cff',
      'editorHoverWidget.background': '#2c2c2e',
      'editorHoverWidget.border': '#38383a',
      'list.hoverBackground': '#3a3a3c',
      'list.activeSelectionBackground': '#0a84ff',
      'list.focusBackground': '#0a84ff40',
      'list.highlightForeground': '#409cff',
      'focusBorder': '#0a84ff80',
      'scrollbarSlider.background': '#48484a80',
      'scrollbarSlider.hoverBackground': '#636366a0',
      'minimap.background': '#1c1c1e',
      'editorGutter.background': '#1c1c1e',
      'editorBracketMatch.background': '#0a84ff30',
      'editorBracketMatch.border': '#0a84ff80',
      'diffEditor.insertedTextBackground': '#30d15822',
      'diffEditor.removedTextBackground': '#ff453a22',
      'editorError.foreground': '#ff453a',
      'editorWarning.foreground': '#ff9f0a',
      'editorInfo.foreground': '#0a84ff',
      'quickInput.background': '#2c2c2e',
      'input.background': '#1c1c1e',
      'input.border': '#48484a',
      'peekViewEditor.background': '#161618',
      'peekViewResult.background': '#232325',
      'peekView.border': '#0a84ff',
    },
  });
}

function configureLanguages(monaco) {
  const ts = monaco.languages.typescript;
  const compilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    allowNonTsExtensions: true,
    allowJs: true,
    checkJs: false,
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    strict: false,
    noEmit: true,
    lib: ['esnext', 'dom', 'dom.iterable'],
  };
  ts.typescriptDefaults.setCompilerOptions(compilerOptions);
  ts.javascriptDefaults.setCompilerOptions(compilerOptions);
  // 2307/2792：找不到模块（node_modules 未加载类型时会大量出现，屏蔽掉）
  const diag = { noSemanticValidation: false, noSyntaxValidation: false, diagnosticCodesToIgnore: [2307, 2792, 7016, 1375, 1378, 2691] };
  ts.typescriptDefaults.setDiagnosticsOptions(diag);
  ts.javascriptDefaults.setDiagnosticsOptions(diag);
  ts.typescriptDefaults.setEagerModelSync(true);
  ts.javascriptDefaults.setEagerModelSync(true);
  ts.typescriptDefaults.setInlayHintsOptions({ includeInlayParameterNameHints: 'literals', includeInlayFunctionLikeReturnTypeHints: true, includeInlayVariableTypeHints: false });
  ts.javascriptDefaults.setInlayHintsOptions({ includeInlayParameterNameHints: 'literals' });

  monaco.languages.json.jsonDefaults.setDiagnosticsOptions({ validate: true, allowComments: true, trailingCommas: 'ignore', enableSchemaRequest: false });
}
