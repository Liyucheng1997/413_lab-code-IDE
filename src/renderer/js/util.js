// 通用工具：路径、语言识别、文件图标、事件总线、模糊匹配。
import { icon } from './icons.js';

export const isWin = navigator.userAgent.includes('Windows');
export const SEP = isWin ? '\\' : '/';

export const path = {
  basename(p) {
    const parts = p.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || p;
  },
  dirname(p) {
    const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    if (i <= 0) return p;
    const d = p.slice(0, i);
    return /^[a-zA-Z]:$/.test(d) ? d + SEP : d;
  },
  extname(p) {
    const b = path.basename(p);
    const i = b.lastIndexOf('.');
    return i > 0 ? b.slice(i).toLowerCase() : '';
  },
  join(...parts) {
    return parts
      .filter(Boolean)
      .join(SEP)
      .replace(/[\\/]+/g, SEP);
  },
  relative(root, p) {
    if (!root) return p;
    const r = root.replace(/[\\/]+$/, '');
    if (path.isInside(r, p) && !path.same(r, p)) return p.slice(r.length + 1);
    return p;
  },
  isInside(root, p) {
    const r = norm(root).replace(/[\\/]+$/, '');
    const q = norm(p);
    return q === r || q.startsWith(r + '\\') || q.startsWith(r + '/');
  },
  same(a, b) {
    return norm(a) === norm(b);
  },
};

export function norm(p) {
  return isWin ? p.replace(/\//g, '\\').toLowerCase() : p;
}

// 文件扩展名 / 特殊文件名 → Monaco 语言 ID
const EXT_LANG = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'typescript',
  '.json': 'json', '.jsonc': 'json', '.json5': 'json', '.webmanifest': 'json',
  '.html': 'html', '.htm': 'html', '.xhtml': 'html', '.vue': 'html', '.svelte': 'html',
  '.css': 'css', '.scss': 'scss', '.sass': 'scss', '.less': 'less',
  '.py': 'python', '.pyw': 'python', '.pyi': 'python',
  '.c': 'c', '.h': 'cpp', '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp', '.hxx': 'cpp', '.ino': 'cpp',
  '.m': 'objective-c', '.mm': 'objective-c',
  '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.scala': 'scala', '.groovy': 'java', '.gradle': 'java',
  '.cs': 'csharp', '.csx': 'csharp', '.fs': 'fsharp', '.fsx': 'fsharp', '.vb': 'vb',
  '.go': 'go', '.rs': 'rust', '.swift': 'swift', '.dart': 'dart', '.zig': 'rust',
  '.rb': 'ruby', '.php': 'php', '.lua': 'lua', '.pl': 'perl', '.pm': 'perl', '.r': 'r', '.jl': 'julia',
  '.ex': 'elixir', '.exs': 'elixir', '.clj': 'clojure', '.cljs': 'clojure', '.coffee': 'coffeescript', '.hs': 'plaintext',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.fish': 'shell', '.ps1': 'powershell', '.psm1': 'powershell', '.bat': 'bat', '.cmd': 'bat',
  '.md': 'markdown', '.markdown': 'markdown', '.mdx': 'mdx', '.rst': 'restructuredtext',
  '.xml': 'xml', '.svg': 'xml', '.xsd': 'xml', '.xsl': 'xml', '.plist': 'xml', '.csproj': 'xml', '.vcxproj': 'xml', '.config': 'xml',
  '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'ini', '.ini': 'ini', '.cfg': 'ini', '.conf': 'ini', '.properties': 'ini', '.env': 'ini',
  '.sql': 'sql', '.mysql': 'mysql', '.pgsql': 'pgsql', '.graphql': 'graphql', '.gql': 'graphql', '.proto': 'protobuf',
  '.sol': 'solidity', '.tf': 'hcl', '.hcl': 'hcl', '.pas': 'pascal', '.tcl': 'tcl', '.sv': 'systemverilog', '.v': 'systemverilog',
  '.hbs': 'handlebars', '.pug': 'pug', '.twig': 'twig', '.liquid': 'liquid', '.razor': 'razor', '.cshtml': 'razor',
  '.wgsl': 'wgsl', '.txt': 'plaintext', '.log': 'plaintext',
};
const NAME_LANG = { dockerfile: 'dockerfile', makefile: 'shell', 'cmakelists.txt': 'plaintext', '.gitignore': 'ini', '.editorconfig': 'ini', '.npmrc': 'ini', '.babelrc': 'json', '.prettierrc': 'json', '.eslintrc': 'json', 'tsconfig.json': 'json', 'jsconfig.json': 'json' };

export function languageForFile(p) {
  const name = path.basename(p).toLowerCase();
  if (NAME_LANG[name]) return NAME_LANG[name];
  if (name.startsWith('dockerfile')) return 'dockerfile';
  if (name.startsWith('.env')) return 'ini';
  return EXT_LANG[path.extname(p)] || 'plaintext';
}

// 文件图标：小方块 + 扩展名缩写，只用少量沉稳纯色
const ICONS = {
  js: ['JS', 'orange'], mjs: ['JS', 'orange'], cjs: ['JS', 'orange'], jsx: ['JSX', 'blue'], ts: ['TS', 'blue'], tsx: ['TSX', 'blue'], mts: ['TS', 'blue'],
  json: ['{}', 'ink'], html: ['<>', 'orange'], htm: ['<>', 'orange'], css: ['#', 'blue'], scss: ['#', 'blue'], less: ['#', 'blue'], vue: ['V', 'green'], svelte: ['S', 'orange'],
  py: ['PY', 'blue'], c: ['C', 'blue'], h: ['H', 'ink'], cpp: ['C++', 'blue'], cc: ['C++', 'blue'], hpp: ['H', 'ink'], cs: ['C#', 'green'],
  java: ['JV', 'orange'], kt: ['KT', 'blue'], go: ['GO', 'blue'], rs: ['RS', 'orange'], rb: ['RB', 'orange'], php: ['PHP', 'blue'], swift: ['SW', 'orange'], dart: ['DT', 'blue'],
  lua: ['LUA', 'blue'], r: ['R', 'blue'], sh: ['$', 'green'], bash: ['$', 'green'], ps1: ['PS', 'blue'], bat: ['BAT', 'ink'], cmd: ['CMD', 'ink'],
  md: ['MD', 'ink'], txt: ['TXT', 'gray'], log: ['LOG', 'gray'], xml: ['XML', 'orange'], svg: ['SVG', 'orange'], yml: ['YML', 'ink'], yaml: ['YML', 'ink'], toml: ['TML', 'ink'], ini: ['INI', 'gray'],
  sql: ['SQL', 'blue'], png: ['IMG', 'green'], jpg: ['IMG', 'green'], jpeg: ['IMG', 'green'], gif: ['IMG', 'green'], webp: ['IMG', 'green'], ico: ['IMG', 'green'],
  lock: ['LCK', 'gray'], env: ['ENV', 'gray'], gitignore: ['GIT', 'gray'], dockerfile: ['DK', 'blue'], exe: ['EXE', 'gray'], zip: ['ZIP', 'gray'], pdf: ['PDF', 'orange'],
};

export function fileIcon(name, isDir = false, open = false) {
  if (isDir) return `<span class="file-icon folder">${icon(open ? 'folderOpen' : 'folder')}</span>`;
  const lower = name.toLowerCase();
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : lower;
  const [label, color] = ICONS[ext] || ICONS[lower] || [ext.slice(0, 3) || '·', 'gray'];
  return `<span class="file-icon fi-${color}">${escapeHtml(label)}</span>`;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

// 简单事件总线
export class Emitter {
  constructor() {
    this.map = new Map();
  }
  on(name, fn) {
    if (!this.map.has(name)) this.map.set(name, new Set());
    this.map.get(name).add(fn);
    return () => this.map.get(name).delete(fn);
  }
  emit(name, ...args) {
    const set = this.map.get(name);
    if (set) for (const fn of [...set]) fn(...args);
  }
}

export const bus = new Emitter();

// 模糊匹配：子序列匹配并打分，连续命中、词首命中加分。返回 null 或 {score, positions}
export function fuzzy(query, text) {
  if (!query) return { score: 0, positions: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let last = -2;
  const positions = [];
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      positions.push(i);
      score += 1;
      if (last === i - 1) score += 4;
      const prev = text[i - 1];
      if (i === 0 || '/\\_-. '.includes(prev) || (text[i] !== t[i] && prev === prev.toLowerCase())) score += 3;
      last = i;
      qi++;
    }
  }
  if (qi < q.length) return null;
  score -= t.length * 0.02;
  return { score, positions };
}

export function highlight(text, positions) {
  if (!positions || !positions.length) return escapeHtml(text);
  const set = new Set(positions);
  let out = '';
  for (let i = 0; i < text.length; i++) out += set.has(i) ? `<b>${escapeHtml(text[i])}</b>` : escapeHtml(text[i]);
  return out;
}

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
