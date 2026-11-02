// 渲染进程入口：加载设置与 Monaco，初始化各模块，恢复上次的工作区。
import { ctx } from './state.js';
import { hydrateIcons } from './icons.js';
import { loadMonaco } from './monaco-setup.js';
import { installKeyHandler } from './commands.js';
import { initEditors, showWelcome, openFile } from './editors.js';
import { initExplorer } from './explorer.js';
import { initSearch } from './search-view.js';
import { initGit } from './git-view.js';
import { initRunView } from './run-view.js';
import { initTerminal, hasTerminals, newTerminal } from './terminal.js';
import { initProblems } from './problems.js';
import { initOutput, log } from './output.js';
import { initStatusbar } from './statusbar.js';
import { initLsp } from './lsp-client.js';
import { registerSnippets } from './snippets.js';
import { initWorkbench, applyTheme, openFolder } from './workbench.js';
import { initDebug } from './debug.js';
import { initDebugConsole } from './debug-console.js';
import { runCommand } from './commands.js';
import * as editorsApi from './editors.js';
import * as lspApi from './lsp-client.js';
import * as debugApi from './debug.js';

// Monaco 在切换模型时会取消进行中的请求，产生无害的 Canceled 拒绝，这里静默掉
window.addEventListener('unhandledrejection', (e) => {
  if (e.reason && (e.reason.name === 'Canceled' || e.reason.message === 'Canceled')) e.preventDefault();
});

async function boot() {
  const [info, settings, state] = await Promise.all([window.ide.app.info(), window.ide.settings.get(), window.ide.state.get()]);
  ctx.info = info;
  ctx.settings = settings;
  document.body.classList.add('platform-' + info.platform);
  hydrateIcons();
  await applyTheme();

  ctx.monaco = await loadMonaco();
  ctx.monaco.editor.setTheme(ctx.isDark ? 'lumen-dark' : 'lumen-light');

  initLsp();
  registerSnippets(ctx.monaco);
  initEditors();
  initExplorer();
  initSearch();
  initGit();
  initRunView();
  initTerminal(document.querySelector('.panel-view[data-panel=terminal]'));
  initProblems(document.querySelector('.panel-view[data-panel=problems]'));
  initOutput(document.querySelector('.panel-view[data-panel=output]'));
  initStatusbar();
  initDebugConsole(document.querySelector('.panel-view[data-panel=debug]'));
  initDebug();
  await initWorkbench(state);
  installKeyHandler();
  // 调试/自动化测试入口
  window.__lumen = { ctx, runCommand, editors: editorsApi, lsp: lspApi, openFolder, debug: debugApi };
  log('Lumen', `Lumen IDE ${info.version} 已启动（Electron ${info.electron}）`);

  // 命令行参数优先，其次恢复上次打开的文件夹
  const arg = info.argvPath;
  if (arg) {
    const st = await window.ide.fs.stat(arg);
    if (st && st.isDir) return openFolder(arg);
    if (st) {
      showWelcome();
      return openFile(arg, { pinned: true });
    }
  }
  if (state.lastRoot && (await window.ide.fs.stat(state.lastRoot))) await openFolder(state.lastRoot);
  else showWelcome();
  // 上次关闭时终端面板是打开的：自动开一个终端
  if (!document.body.classList.contains('panel-hidden') && !document.querySelector('.panel-view[data-panel=terminal]').hidden && !hasTerminals()) newTerminal();
}

boot().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend', `<pre style="position:fixed;inset:60px;z-index:9999;background:#fff;color:#d70015;padding:20px;border-radius:12px;white-space:pre-wrap;user-select:text">启动失败：\n${String(err && err.stack || err)}</pre>`);
});
