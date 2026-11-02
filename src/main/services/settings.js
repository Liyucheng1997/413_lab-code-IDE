// 用户设置（settings.json）与会话状态（state.json），保存在 userData 目录。
const { app, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  theme: 'system', // light | dark | system
  fontSize: 14,
  fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, 'Courier New', monospace",
  fontLigatures: true,
  lineHeight: 22,
  tabSize: 4,
  insertSpaces: true,
  detectIndentation: true,
  wordWrap: 'off',
  minimap: true,
  lineNumbers: 'on',
  renderWhitespace: 'selection',
  bracketPairColorization: true,
  stickyScroll: true,
  cursorBlinking: 'smooth',
  smoothScrolling: true,
  autoSave: 'off', // off | afterDelay | onFocusChange
  autoSaveDelay: 1000,
  formatOnSave: false,
  trimTrailingWhitespace: false,
  insertFinalNewline: false,
  autoClosingBrackets: 'always',
  suggestOnTriggerCharacters: true,
  quickSuggestions: true,
  inlayHints: true,
  terminalFontSize: 13,
  terminalShell: '', // 为空时自动选择
  excludeGlobs: ['**/node_modules', '**/.git', '**/__pycache__', '**/.venv', '**/dist', '**/build', '**/out', '**/target', '**/.idea', '**/.vs'],
  aiModel: 'claude-opus-5-5',
  aiBaseURL: '', // 留空使用官方 API
  aiEffort: 'high', // low | medium | high | xhigh | max
  aiAutoApply: false, // 自动应用 AI 的文件修改
  aiAutoRun: false, // 自动运行 AI 请求的命令
  aiWebSearch: true, // 允许 AI 搜索网页（仅官方接口）
  aiProjectsDir: '', // AI 新建项目的默认位置，留空为“文档/LumenProjects”
  pythonPath: '', // 调试用的 Python 解释器，留空自动查找
  runCommands: {}, // 例如 { ".py": "python -u \"${file}\"" }
  lsp: {}, // 例如 { "go": { "command": "gopls", "args": [] } }
};

let cache = null;
let stateCache = null;

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const statePath = () => path.join(app.getPath('userData'), 'state.json');

function readJson(file, fallback) {
  try {
    // 允许 settings.json 里写 // 注释
    const text = fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '');
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function get() {
  if (!cache) {
    cache = { ...DEFAULTS, ...readJson(settingsPath(), {}) };
    if (!fs.existsSync(settingsPath())) writeJson(settingsPath(), {});
  }
  return cache;
}

function reload() {
  cache = null;
  return get();
}

// 只把与默认值不同的项写入文件，保持 settings.json 精简
function set(patch) {
  const next = { ...get(), ...patch };
  const diff = {};
  for (const [k, v] of Object.entries(next)) {
    if (JSON.stringify(v) !== JSON.stringify(DEFAULTS[k])) diff[k] = v;
  }
  writeJson(settingsPath(), diff);
  cache = next;
  return cache;
}

function getState() {
  if (!stateCache) stateCache = readJson(statePath(), {});
  return stateCache;
}

function setState(patch) {
  stateCache = { ...getState(), ...patch };
  writeJson(statePath(), stateCache);
  return stateCache;
}

function isDark() {
  const t = get().theme;
  return t === 'dark' || (t === 'system' && nativeTheme.shouldUseDarkColors);
}

module.exports = { DEFAULTS, get, set, reload, getState, setState, isDark, settingsPath };
