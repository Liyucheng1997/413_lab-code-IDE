// 设置界面：分组表单，修改即时生效；也可以直接编辑 settings.json。
import { ctx, updateSettings } from './state.js';
import { bus, escapeHtml, h } from './util.js';
import { updateStatus } from './update.js';
import { modal, toast } from './ui.js';
import * as editors from './editors.js';
import { allCommands, keyLabel } from './commands.js';

const SECTIONS = [
  ['appearance', '外观'],
  ['editor', '编辑器'],
  ['files', '文件'],
  ['terminal', '终端'],
  ['run', '运行与语言'],
  ['git', 'Git'],
  ['ai', 'AI 助手'],
  ['update', '更新'],
  ['keys', '快捷键'],
];

const DEFS = [
  { s: 'appearance', key: 'theme', title: '颜色主题', desc: '跟随系统时会随 Windows 深浅色自动切换', type: 'seg', options: [['light', '浅色'], ['dark', '深色'], ['system', '跟随系统']] },
  { s: 'appearance', key: 'fontSize', title: '字号', type: 'number', min: 8, max: 40 },
  { s: 'appearance', key: 'fontFamily', title: '编辑器字体', desc: '多个字体用逗号分隔，靠前的优先', type: 'text' },
  { s: 'appearance', key: 'lineHeight', title: '行高', desc: '0 表示按字号自动计算', type: 'number', min: 0, max: 80 },
  { s: 'appearance', key: 'fontLigatures', title: '连字', desc: '需要字体支持，例如 Cascadia Code、Fira Code', type: 'bool' },
  { s: 'appearance', key: 'minimap', title: '小地图', type: 'bool' },
  { s: 'appearance', key: 'lineNumbers', title: '行号', type: 'select', options: [['on', '显示'], ['relative', '相对行号'], ['off', '隐藏']] },
  { s: 'appearance', key: 'renderWhitespace', title: '显示空白字符', type: 'select', options: [['none', '不显示'], ['selection', '仅选中部分'], ['boundary', '单词边界'], ['all', '全部']] },
  { s: 'appearance', key: 'bracketPairColorization', title: '括号配对着色', type: 'bool' },
  { s: 'appearance', key: 'stickyScroll', title: '粘性滚动', desc: '滚动时在顶部固定当前所在的函数/类', type: 'bool' },
  { s: 'appearance', key: 'cursorBlinking', title: '光标动画', type: 'select', options: [['smooth', '平滑'], ['blink', '闪烁'], ['phase', '渐隐'], ['expand', '展开'], ['solid', '不闪烁']] },
  { s: 'appearance', key: 'smoothScrolling', title: '平滑滚动', type: 'bool' },

  { s: 'editor', key: 'tabSize', title: '缩进宽度', type: 'number', min: 1, max: 16 },
  { s: 'editor', key: 'insertSpaces', title: '用空格代替 Tab', type: 'bool' },
  { s: 'editor', key: 'detectIndentation', title: '自动检测缩进', desc: '打开文件时根据内容判断缩进方式', type: 'bool' },
  { s: 'editor', key: 'wordWrap', title: '自动换行', type: 'select', options: [['off', '关闭'], ['on', '按窗口宽度'], ['bounded', '按窗口宽度与列数']] },
  { s: 'editor', key: 'autoClosingBrackets', title: '自动闭合括号', type: 'select', options: [['always', '总是'], ['languageDefined', '按语言'], ['beforeWhitespace', '仅在空白前'], ['never', '从不']] },
  { s: 'editor', key: 'quickSuggestions', title: '输入时自动提示', desc: '关闭后可用 Ctrl+Space 手动触发补全', type: 'bool' },
  { s: 'editor', key: 'suggestOnTriggerCharacters', title: '触发字符提示', desc: '输入 . 等字符时弹出补全', type: 'bool' },
  { s: 'editor', key: 'inlayHints', title: '内联提示', desc: '在代码中显示参数名、推断类型等', type: 'bool' },
  { s: 'editor', key: 'formatOnSave', title: '保存时格式化', type: 'bool' },
  { s: 'editor', key: 'trimTrailingWhitespace', title: '保存时删除行尾空格', type: 'bool' },
  { s: 'editor', key: 'insertFinalNewline', title: '保存时在末尾插入空行', type: 'bool' },

  { s: 'files', key: 'autoSave', title: '自动保存', type: 'select', options: [['off', '关闭'], ['afterDelay', '延迟后保存'], ['onFocusChange', '失去焦点时保存']] },
  { s: 'files', key: 'autoSaveDelay', title: '自动保存延迟（毫秒）', type: 'number', min: 100, max: 60000 },
  { s: 'files', key: 'excludeGlobs', title: '排除的文件', desc: '文件索引、快速打开和搜索会跳过这些路径（每行一个 glob）', type: 'list' },

  { s: 'terminal', key: 'terminalFontSize', title: '终端字号', type: 'number', min: 8, max: 40 },
  { s: 'terminal', key: 'terminalShell', title: '终端 Shell', desc: '留空自动选择（Windows 优先 pwsh，其次 PowerShell）。例如 cmd.exe、C:\\Program Files\\Git\\bin\\bash.exe', type: 'text' },

  { s: 'git', key: 'gitAutoFetch', title: '自动获取', desc: '每 5 分钟在后台从远程获取一次，及时显示“落后 n 个提交”。不会改动你的文件', type: 'bool' },
  { s: 'git', key: 'gitSyncRebase', title: '拉取时变基', desc: '拉取和同步时用 rebase 把本地提交接到远程之后，历史更整齐；关闭时使用 merge', type: 'bool' },

  { s: 'ai', key: '__aikey', title: 'API Key', desc: '你的 Claude API Key，用系统加密保存在本机，不会写进 settings.json', type: 'aikey' },
  { s: 'ai', key: 'aiBaseURL', title: 'Base URL', desc: '留空使用官方 API（api.anthropic.com）。使用代理或中转服务时填写其地址', type: 'text' },
  { s: 'ai', key: 'aiModel', title: '模型', desc: '默认 claude-opus-5-5（Claude Opus 5.5）', type: 'text' },
  { s: 'ai', key: 'aiEffort', title: '思考强度', desc: '越高越仔细，耗时和费用也越高。写代码推荐“高”', type: 'select', options: [['low', '低'], ['medium', '中'], ['high', '高'], ['xhigh', '很高'], ['max', '最高']] },
  { s: 'ai', key: 'aiAutoApply', title: '自动应用文件修改', desc: '关闭时每次修改都会先显示差异，由你确认', type: 'bool' },
  { s: 'ai', key: 'aiAutoRun', title: '全自动', desc: '开启后运行命令、新建项目、删除文件也不再确认。建议只在信任的项目中开启', type: 'bool' },
  { s: 'ai', key: 'aiWebSearch', title: '允许搜索网页', desc: '让 AI 查文档、查报错（仅官方接口，搜索按次计费）', type: 'bool' },
  { s: 'ai', key: 'aiProjectsDir', title: '新项目默认位置', desc: 'AI 新建项目时的默认父目录。留空则使用当前工作区的上一级，或“文档/LumenProjects”', type: 'text' },
  { s: 'update', key: 'autoUpdate', title: '自动更新', desc: '启动后和每隔 4 小时检查一次新版本，在后台下载，关闭 IDE 时自动安装。便携版只提示，不自动安装', type: 'bool' },
  { s: 'update', key: '__update', title: '检查更新', desc: '立即检查 GitHub 上是否有新版本', type: 'update' },
  { s: 'run', key: 'pythonPath', title: 'Python 解释器', desc: '调试 Python 时使用的解释器完整路径，留空则使用 PATH 中的 python。需要安装 debugpy', type: 'text' },
  { s: 'run', key: 'runCommands', title: '自定义运行命令', desc: '按扩展名覆盖 F5 运行命令。可用变量：${file} ${fileDir} ${fileBase} ${fileNoExt} ${outFile}', type: 'json', placeholder: '{\n  ".py": "python -u \\"${file}\\""\n}' },
  { s: 'run', key: 'lsp', title: '自定义语言服务器', desc: '按语言 ID 指定服务器命令，例如 { "go": { "command": "gopls", "args": [] } }', type: 'json', placeholder: '{\n  "cpp": { "command": "clangd", "args": [] }\n}' },
];

let current = 'appearance';
let filter = '';

function control(def) {
  const v = ctx.settings[def.key];
  let el;
  switch (def.type) {
    case 'bool':
      el = h(`<label class="switch"><input type="checkbox" ${v ? 'checked' : ''}><span></span></label>`);
      el.querySelector('input').onchange = (e) => updateSettings({ [def.key]: e.target.checked });
      break;
    case 'number':
      el = h(`<input class="input num" type="number" min="${def.min}" max="${def.max}" value="${v}">`);
      el.onchange = () => {
        const n = Math.min(def.max, Math.max(def.min, +el.value || 0));
        el.value = n;
        updateSettings({ [def.key]: n });
      };
      break;
    case 'select':
      el = h(`<select class="input">${def.options.map(([k, l]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`);
      el.onchange = () => updateSettings({ [def.key]: el.value });
      break;
    case 'seg':
      el = h(`<div class="seg">${def.options.map(([k, l]) => `<button data-v="${k}" class="${k === v ? 'active' : ''}">${l}</button>`).join('')}</div>`);
      el.querySelectorAll('button').forEach((b) => {
        b.onclick = () => {
          el.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
          updateSettings({ [def.key]: b.dataset.v });
        };
      });
      break;
    case 'list':
      el = h(`<textarea class="input" rows="5" spellcheck="false">${escapeHtml((v || []).join('\n'))}</textarea>`);
      el.onchange = () => updateSettings({ [def.key]: el.value.split('\n').map((x) => x.trim()).filter(Boolean) });
      break;
    case 'json':
      el = h(`<textarea class="input" rows="5" spellcheck="false" placeholder="${escapeHtml(def.placeholder || '')}">${escapeHtml(v && Object.keys(v).length ? JSON.stringify(v, null, 2) : '')}</textarea>`);
      el.onchange = () => {
        try {
          updateSettings({ [def.key]: el.value.trim() ? JSON.parse(el.value) : {} });
          el.style.borderColor = '';
        } catch {
          el.style.borderColor = 'var(--danger)';
          toast('JSON 格式不正确', 'error');
        }
      };
      break;
    case 'aikey': {
      el = h(`<div class="ai-key-ctl"><input class="input" type="password" placeholder="sk-ant-…" autocomplete="off" spellcheck="false"><button class="btn btn-sm btn-primary">保存</button><button class="btn btn-sm">测试</button><button class="btn btn-sm">清除</button><div class="setting-desc ai-key-state"></div></div>`);
      const input = el.querySelector('input');
      const [saveBtn, testBtn, clearBtn] = el.querySelectorAll('button');
      const state = el.querySelector('.ai-key-state');
      const show = async () => {
        const c = await window.ide.ai.config();
        state.textContent = c.hasKey ? `已保存：${c.keyHint}` : c.envKey ? '未保存，正在使用环境变量 ANTHROPIC_API_KEY' : '尚未配置';
        import('./ai-panel.js').then((m) => m.refreshAiConfig());
      };
      saveBtn.onclick = async () => {
        if (!input.value.trim()) return;
        await window.ide.ai.setKey(input.value.trim());
        input.value = '';
        show();
      };
      testBtn.onclick = async () => {
        state.textContent = '正在测试…';
        const r = await window.ide.ai.test();
        state.textContent = r.message;
      };
      clearBtn.onclick = async () => {
        await window.ide.ai.setKey('');
        show();
      };
      show();
      break;
    }
    case 'update': {
      el = h(`<div class="ai-key-ctl"><button class="btn btn-sm">检查更新</button><div class="setting-desc"></div></div>`);
      const state = el.querySelector('.setting-desc');
      const show = (s) => {
        const tail = { checking: '正在检查…', none: '已是最新', downloading: `正在下载 ${s.version}（${s.percent || 0}%）`, downloaded: `${s.version} 已下载，重启后生效`, available: `有新版本 ${s.version}`, error: `检查失败：${s.message}` }[s.state];
        state.textContent = `当前版本 ${ctx.info.version}${tail ? ' · ' + tail : ''}`;
      };
      show(updateStatus());
      const off = bus.on('update:changed', (s) => (el.isConnected ? show(s) : off()));
      el.querySelector('button').onclick = () => window.ide.update.check();
      break;
    }
    default:
      el = h(`<input class="input" value="${escapeHtml(v || '')}" spellcheck="false">`);
      el.onchange = () => updateSettings({ [def.key]: el.value });
  }
  return el;
}

function renderContent(content) {
  content.innerHTML = '';
  if (current === 'keys' && !filter) return renderKeys(content);
  const defs = DEFS.filter((d) => (filter ? (d.title + (d.desc || '') + d.key).toLowerCase().includes(filter.toLowerCase()) : d.s === current));
  if (!defs.length) content.appendChild(h('<div class="empty">没有匹配的设置</div>'));
  for (const d of defs) {
    const row = h(`<div class="setting"><div class="setting-text"><div class="setting-title">${escapeHtml(d.title)}</div>${d.desc ? `<div class="setting-desc">${escapeHtml(d.desc)}</div>` : ''}</div></div>`);
    row.appendChild(control(d));
    content.appendChild(row);
  }
}

function renderKeys(content) {
  const cmds = allCommands().filter((c) => c.key);
  cmds.sort((a, b) => (a.category || '').localeCompare(b.category || ''));
  const extra = [
    ['触发建议（代码补全）', 'Ctrl+Space'],
    ['转到定义', 'F12'],
    ['速览定义', 'Alt+F12'],
    ['查找所有引用', 'Shift+F12'],
    ['重命名符号', 'F2'],
    ['快速修复', 'Ctrl+.'],
    ['查找 / 替换', 'Ctrl+F / Ctrl+H'],
    ['切换行注释', 'Ctrl+/'],
    ['多光标：在上/下方添加', 'Ctrl+Alt+↑ / ↓'],
    ['选中下一个相同内容', 'Ctrl+D'],
    ['选中所有相同内容', 'Ctrl+Shift+L'],
    ['上/下移动行', 'Alt+↑ / ↓'],
    ['复制行', 'Shift+Alt+↑ / ↓'],
    ['删除行', 'Ctrl+Shift+K'],
    ['折叠 / 展开', 'Ctrl+Shift+[ / ]'],
    ['格式化文档', 'Shift+Alt+F'],
    ['编辑器命令面板', 'F1'],
  ];
  content.innerHTML = `<div class="settings-group-title">工作台</div><table class="keys-table">${cmds.map((c) => `<tr><td>${escapeHtml((c.category ? c.category + '：' : '') + c.title)}</td><td><kbd>${escapeHtml(keyLabel(c.key))}</kbd></td></tr>`).join('')}</table>
    <div class="settings-group-title">编辑器</div><table class="keys-table">${extra.map(([t, k]) => `<tr><td>${escapeHtml(t)}</td><td><kbd>${escapeHtml(k)}</kbd></td></tr>`).join('')}</table>`;
}

export function openSettings(section) {
  if (section) current = section;
  filter = '';
  const root = h(`<div style="display:flex;flex:1;min-width:0">
    <div class="settings-nav"><h3>设置</h3>${SECTIONS.map(([k, l]) => `<button data-s="${k}" class="${k === current ? 'active' : ''}">${l}</button>`).join('')}<div class="spacer"></div><button data-a="json">打开 settings.json</button></div>
    <div class="settings-main"><div class="settings-top"><input class="input" placeholder="搜索设置" spellcheck="false"><button class="modal-x" title="关闭">✕</button></div><div class="settings-content"></div></div>
  </div>`);
  const m = modal({ body: root, className: 'settings-modal', width: 880 });
  const content = root.querySelector('.settings-content');
  root.querySelectorAll('[data-s]').forEach((b) => {
    b.onclick = () => {
      current = b.dataset.s;
      root.querySelectorAll('[data-s]').forEach((x) => x.classList.toggle('active', x === b));
      renderContent(content);
    };
  });
  root.querySelector('[data-a=json]').onclick = () => {
    m.close();
    editors.openFile(ctx.info.settingsPath, { pinned: true });
  };
  root.querySelector('.modal-x').onclick = () => m.close();
  const search = root.querySelector('.settings-top input');
  search.oninput = () => {
    filter = search.value.trim();
    renderContent(content);
  };
  renderContent(content);
  setTimeout(() => search.focus());
}
