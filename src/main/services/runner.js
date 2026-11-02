// 根据文件类型生成“运行当前文件”的命令，交给集成终端执行。
const path = require('path');
const fs = require('fs');
const os = require('os');
const settings = require('./settings');
const { which } = require('./terminal-service');

const isWin = process.platform === 'win32';

// ${file} 等变量在用户自定义命令中也可使用
const TEMPLATES = {
  '.py': () => `${which('python') || !which('python3') ? 'python' : 'python3'} -u "\${file}"`,
  '.js': 'node "${file}"',
  '.mjs': 'node "${file}"',
  '.cjs': 'node "${file}"',
  '.ts': 'npx --yes tsx "${file}"',
  '.mts': 'npx --yes tsx "${file}"',
  '.c': { build: 'gcc "${file}" -o "${outFile}" -lm', run: '"${outFile}"' },
  '.cpp': { build: 'g++ -std=c++17 "${file}" -o "${outFile}"', run: '"${outFile}"' },
  '.cc': { build: 'g++ -std=c++17 "${file}" -o "${outFile}"', run: '"${outFile}"' },
  '.cxx': { build: 'g++ -std=c++17 "${file}" -o "${outFile}"', run: '"${outFile}"' },
  '.rs': { build: 'rustc "${file}" -o "${outFile}"', run: '"${outFile}"' },
  '.go': 'go run "${file}"',
  '.java': 'java "${file}"',
  '.kt': { build: 'kotlinc "${file}" -include-runtime -d "${fileDir}/${fileNoExt}.jar"', run: 'java -jar "${fileDir}/${fileNoExt}.jar"' },
  '.cs': 'dotnet run',
  '.rb': 'ruby "${file}"',
  '.php': 'php "${file}"',
  '.lua': 'lua "${file}"',
  '.pl': 'perl "${file}"',
  '.r': 'Rscript "${file}"',
  '.jl': 'julia "${file}"',
  '.dart': 'dart run "${file}"',
  '.swift': 'swift "${file}"',
  '.scala': 'scala "${file}"',
  '.hs': 'runghc "${file}"',
  '.ex': 'elixir "${file}"',
  '.exs': 'elixir "${file}"',
  '.zig': 'zig run "${file}"',
  '.sh': 'bash "${file}"',
  '.ps1': isWin ? 'powershell -ExecutionPolicy Bypass -File "${file}"' : 'pwsh -File "${file}"',
  '.bat': 'cmd /c "${file}"',
  '.cmd': 'cmd /c "${file}"',
};

function vars(file) {
  const ext = path.extname(file);
  const dir = path.dirname(file);
  const noExt = path.basename(file, ext);
  const outDir = path.join(os.tmpdir(), 'lumen-ide-build');
  fs.mkdirSync(outDir, { recursive: true });
  return {
    file,
    fileDir: dir,
    fileBase: path.basename(file),
    fileNoExt: noExt,
    fileExt: ext,
    outFile: path.join(outDir, noExt + (isWin ? '.exe' : '')),
  };
}

function fill(tpl, v) {
  return tpl.replace(/\$\{(\w+)\}/g, (_, k) => (v[k] !== undefined ? v[k] : ''));
}

// PowerShell 里带引号的命令需要 & 调用；&& 在 Windows PowerShell 5.1 不可用
function joinSteps(steps, shellName) {
  const ps = isWin && /powershell|pwsh/i.test(shellName || 'powershell');
  const fix = (s) => (ps && s.startsWith('"') ? '& ' + s : s);
  if (steps.length === 1) return fix(steps[0]);
  return ps ? steps.map(fix).join('; if ($?) { ') + ' }'.repeat(steps.length - 1) : steps.join(' && ');
}

function commandFor(file, shellName) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.html' || ext === '.htm') return { open: file };
  const custom = (settings.get().runCommands || {})[ext];
  const tplRaw = custom || TEMPLATES[ext];
  if (!tplRaw) return { error: `不知道如何运行 ${ext || '该'} 文件，可在设置 runCommands 中自定义。` };
  const v = vars(file);
  const tpl = typeof tplRaw === 'function' ? tplRaw() : tplRaw;
  const steps = typeof tpl === 'string' ? [fill(tpl, v)] : [fill(tpl.build, v), fill(tpl.run, v)];
  const cd = isWin && /powershell|pwsh/i.test(shellName || 'powershell') ? `Set-Location -LiteralPath "${v.fileDir}"` : `cd "${v.fileDir}"`;
  return { command: joinSteps([cd, ...steps], shellName), cwd: v.fileDir };
}

function register(ipc) {
  ipc.handle('run:command-for', (_e, file, shellName) => commandFor(file, shellName));
}

module.exports = { register };
