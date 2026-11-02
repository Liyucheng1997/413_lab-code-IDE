// 运行视图与运行逻辑：运行当前文件（F5）、停止、package.json 脚本、语言服务器状态。
import { ctx } from './state.js';
import { bus, path, escapeHtml, h, languageForFile } from './util.js';
import { icon } from './icons.js';
import { toast } from './ui.js';
import * as editors from './editors.js';
import { runInTerminal, stopRunner, activeTerminal } from './terminal.js';
import { allLspStatus, restartLanguage, ensureLanguage } from './lsp-client.js';
import { log } from './output.js';
import { isDebugging, startDebugging, setDebugSidebar, debugSupported } from './debug.js';

let view;
let body;
let debugEl;
let lastActive = false;

export async function runFile(p) {
  if (!p) {
    const t = editors.activeTab();
    if (!t || t.type !== 'file') return toast('请先打开要运行的文件', 'error');
    p = t.path;
  }
  let doc = editors.getDoc(p);
  if (doc && doc.untitled) {
    if (!(await editors.saveDoc(doc))) return;
    p = editors.activeTab().path;
    doc = editors.getDoc(p);
  }
  if (doc && doc.isDirty()) await editors.saveDoc(doc);
  const shell = (activeTerminal() && activeTerminal().shell) || (ctx.info.platform === 'win32' ? 'powershell' : 'bash');
  const r = await window.ide.run.commandFor(p, shell);
  if (r.error) return toast(r.error, 'error', 4000);
  if (r.open) {
    window.ide.app.openPath(r.open);
    return toast('已在默认浏览器中打开', 'success');
  }
  log('运行', `> ${r.command}`);
  await runInTerminal(r.command, r.cwd);
}

export function stopRun() {
  stopRunner();
}

async function runScript(name) {
  const t = await runInTerminal(`npm run ${name}`, ctx.root);
  void t;
}

let renderSeq = 0;
async function render() {
  const my = ++renderSeq;
  const t = editors.activeTab();
  const file = t && t.type === 'file' && !t.path.startsWith('untitled:') ? t.path : null;
  body.innerHTML = '';

  if (!isDebugging()) {
    const card = h(`<div class="run-card"></div>`);
    if (file) {
      const shell = ctx.info.platform === 'win32' ? 'powershell' : 'bash';
      const r = await window.ide.run.commandFor(file, shell);
      if (my !== renderSeq) return;
      const canDebug = debugSupported(file);
      card.innerHTML = `<b>${escapeHtml(path.basename(file))}</b><div style="margin-top:6px">${r.error ? escapeHtml(r.error) : r.open ? '将在默认浏览器中打开' : `运行命令：<br><code>${escapeHtml(r.command)}</code>`}</div>
        ${canDebug ? `<button class="btn btn-primary" data-a="debug">${icon('bug')} 开始调试 (F5)</button>` : ''}
        <button class="btn ${canDebug ? '' : 'btn-primary'}" data-a="run" style="margin-top:6px" ${r.error ? 'disabled' : ''}>${icon('play')} 运行 (Ctrl+F5)</button>`;
      const dbg = card.querySelector('[data-a=debug]');
      if (dbg) dbg.onclick = () => startDebugging(file);
      card.querySelector('[data-a=run]').onclick = () => runFile(file);
    } else card.innerHTML = '<b>运行和调试</b><div style="margin-top:6px">打开源文件后按 F5 调试、Ctrl+F5 直接运行。调试支持 Python（debugpy）、JavaScript（Node.js）、C/C++（GDB）；运行支持 20 多种语言，可在设置的 runCommands 中自定义。</div>';
    body.appendChild(card);
  }
  body.appendChild(debugEl);

  // npm 脚本
  if (ctx.root) {
    const pkgPath = path.join(ctx.root, 'package.json');
    if ((await window.ide.fs.exists(pkgPath)) && my === renderSeq) {
      try {
        const pkg = JSON.parse((await window.ide.fs.readFile(pkgPath)).content);
        const scripts = Object.entries(pkg.scripts || {});
        if (scripts.length) {
          body.appendChild(h('<div class="section-title" style="cursor:default">NPM 脚本</div>'));
          for (const [name, cmd] of scripts) {
            const row = h(`<div class="script-row"><button class="icon-btn" title="运行">${icon('play')}</button><span class="name">${escapeHtml(name)}</span><span class="cmd" title="${escapeHtml(cmd)}">${escapeHtml(cmd)}</span></div>`);
            row.querySelector('button').onclick = () => runScript(name);
            row.ondblclick = () => runScript(name);
            body.appendChild(row);
          }
        }
      } catch {}
    }
  }

  // 语言服务器
  body.appendChild(h('<div class="section-title" style="cursor:default">语言服务器（智能补全）</div>'));
  const list = allLspStatus();
  if (file) {
    const lang = languageForFile(file);
    if (!list.some(([l]) => l === lang)) ensureLanguage(lang);
  }
  if (!list.length) body.appendChild(h('<div class="lsp-row muted">打开 Python / C++ / Go / Rust / Java 等文件时会自动启动。JS/TS/HTML/CSS/JSON 使用内置语言服务。</div>'));
  for (const [lang, st] of list) {
    const dot = st.state === 'ready' ? 'success' : st.state === 'starting' ? 'info' : 'warning';
    const label = st.state === 'ready' ? st.name : st.state === 'starting' ? '启动中…' : '未安装';
    const row = h(`<div class="lsp-row" title="${escapeHtml(st.message || '')}"><span class="dot ${dot}"></span><span class="name">${escapeHtml(lang)}</span><span class="muted">${escapeHtml(label)}</span><button class="icon-btn" style="width:22px;height:22px" title="重启">${icon('refresh')}</button></div>`);
    row.querySelector('button').onclick = () => restartLanguage(lang).then(render);
    body.appendChild(row);
    if (st.state === 'missing' && (st.install || st.message)) body.appendChild(h(`<div class="lsp-row muted" style="height:auto;padding:0 12px 6px 27px;font-size:11.5px;line-height:1.5">${escapeHtml(st.install ? '安装方法：' + st.install : st.message)}</div>`));
  }
}

export function initRunView() {
  view = document.querySelector('.view[data-view=run]');
  view.innerHTML = `<div class="view-header"><span class="view-title">运行和调试</span><div class="view-actions"><button class="icon-btn" title="刷新">${icon('refresh')}</button></div></div><div class="view-body"></div>`;
  body = view.querySelector('.view-body');
  debugEl = h('<div class="debug-sections"></div>');
  setDebugSidebar(debugEl);
  view.querySelector('.icon-btn').onclick = render;
  const maybe = () => !view.hidden && render();
  bus.on('editor:active', maybe);
  bus.on('lsp:changed', maybe);
  bus.on('view:shown', (v) => v === 'run' && render());
  bus.on('run:active', () => runFile());
  bus.on('run:file', (p) => runFile(p));
  bus.on('debug:changed', (s) => {
    // 只在会话开始/结束时整体重绘，单步时由调试模块自己刷新
    const active = !!s;
    if (active !== lastActive) {
      lastActive = active;
      maybe();
    }
  });
}
