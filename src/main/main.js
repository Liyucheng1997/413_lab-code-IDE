// Lumen IDE 主进程入口：创建窗口、注册 app:// 协议、挂载各项服务的 IPC。
const { app, BrowserWindow, protocol, net, ipcMain, dialog, shell, Menu, nativeTheme } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

const settings = require('./services/settings');
const fsService = require('./services/fs-service');
const searchService = require('./services/search-service');
const gitService = require('./services/git-service');
const terminalService = require('./services/terminal-service');
const lspService = require('./services/lsp-service');
const runner = require('./services/runner');
const dapService = require('./services/dap-service');
const aiService = require('./services/ai-service');
const updateService = require('./services/update-service');

const ROOT = path.join(__dirname, '..', '..');
const isDev = process.argv.includes('--dev');

// app:// 是同源的自定义协议，让 Monaco 的 Web Worker 和 ES 模块都能正常加载
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

let mainWindow = null;
let forceClose = false; // 为 true 时关闭窗口不再询问渲染进程（确认关闭、安装更新）

function themeColors() {
  const dark = settings.isDark();
  return dark
    ? { bg: '#000000', symbol: '#f5f5f7' }
    : { bg: '#f5f5f7', symbol: '#1d1d1f' };
}

function createWindow() {
  const state = settings.getState();
  const bounds = state.windowBounds || { width: 1400, height: 880 };
  const colors = themeColors();

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'Lumen IDE',
    backgroundColor: colors.bg,
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? undefined : { color: colors.bg, symbolColor: colors.symbol, height: 44 },
    icon: path.join(ROOT, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  if (state.maximized) mainWindow.maximize();

  mainWindow.loadURL('app://ide/src/renderer/index.html');
  mainWindow.once('ready-to-show', () => mainWindow.show());
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  // 把渲染进程的警告和错误打印到主进程控制台，方便排查
  mainWindow.webContents.on('console-message', (e) => {
    const level = e.level;
    if (level === 'warning' || level === 'error' || isDev) console.log(`[renderer:${level}] ${e.message} (${e.sourceId}:${e.lineNumber})`);
  });

  const saveBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    settings.setState({ maximized: mainWindow.isMaximized(), windowBounds: mainWindow.isMaximized() ? state.windowBounds : mainWindow.getBounds() });
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);

  // 关闭前让渲染进程检查未保存文件
  mainWindow.on('close', (e) => {
    if (forceClose) return;
    e.preventDefault();
    mainWindow.webContents.send('app:before-close');
  });
  ipcMain.removeHandler('app:confirm-close');
  ipcMain.handle('app:confirm-close', () => {
    forceClose = true;
    mainWindow.close();
  });

  // 外部链接用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) e.preventDefault();
  });

  // 自动化测试钩子：LUMEN_AUTOTEST 指向一个脚本，导出 async ({ js, shot, wait, win }) => {}
  if (process.env.LUMEN_AUTOTEST) {
    mainWindow.webContents.once('did-finish-load', async () => {
      const fs = require('fs');
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const js = (code) => mainWindow.webContents.executeJavaScript(code, true);
      const shot = async (file) => fs.writeFileSync(file, (await mainWindow.webContents.capturePage()).toPNG());
      try {
        await require(process.env.LUMEN_AUTOTEST)({ js, shot, wait, win: mainWindow });
      } catch (err) {
        console.log('[autotest] 失败', err && err.stack);
      }
      if (process.env.LUMEN_AUTOTEST_QUIT) app.exit(0);
    });
  }

  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };
  fsService.setSender(send);
  terminalService.setSender(send);
  lspService.setSender(send);
  dapService.setSender(send);
  aiService.setSender(send);
  updateService.init({ send, beforeInstall: () => (forceClose = true) });
}

function registerIpc() {
  // 窗口与应用
  ipcMain.handle('app:info', () => ({
    platform: process.platform,
    version: app.getVersion(),
    electron: process.versions.electron,
    home: app.getPath('home'),
    settingsPath: settings.settingsPath(),
    argvPath: process.argv.slice(isDev ? 3 : 2).find((a) => !a.startsWith('--')) || null,
  }));
  ipcMain.handle('app:toggle-devtools', () => mainWindow.webContents.toggleDevTools());
  ipcMain.handle('app:reload', () => mainWindow.webContents.reload());
  ipcMain.handle('app:set-title-colors', (_e, { bg, symbol }) => {
    if (process.platform !== 'darwin' && mainWindow.setTitleBarOverlay) mainWindow.setTitleBarOverlay({ color: bg, symbolColor: symbol });
  });
  ipcMain.handle('app:open-external', (_e, url) => shell.openExternal(url));
  ipcMain.handle('app:reveal', (_e, p) => shell.showItemInFolder(p));
  ipcMain.handle('app:open-path', (_e, p) => shell.openPath(p));

  // 对话框
  ipcMain.handle('dialog:open-folder', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('dialog:open-file', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('dialog:save-file', async (_e, defaultPath) => {
    const r = await dialog.showSaveDialog(mainWindow, { defaultPath });
    return r.canceled ? null : r.filePath;
  });
  ipcMain.handle('dialog:confirm', async (_e, { message, detail, buttons }) => {
    const r = await dialog.showMessageBox(mainWindow, { type: 'question', message, detail, buttons, defaultId: 0, cancelId: buttons.length - 1, noLink: true });
    return r.response;
  });

  // 设置与会话状态
  ipcMain.handle('settings:get', () => settings.get());
  ipcMain.handle('settings:set', (_e, patch) => {
    const s = settings.set(patch);
    nativeTheme.themeSource = s.theme === 'system' ? 'system' : s.theme;
    return s;
  });
  ipcMain.handle('settings:reload', () => settings.reload());
  ipcMain.handle('state:get', () => settings.getState());
  ipcMain.handle('state:set', (_e, patch) => settings.setState(patch));
  ipcMain.handle('theme:is-dark', () => nativeTheme.shouldUseDarkColors);
  nativeTheme.on('updated', () => mainWindow && mainWindow.webContents.send('theme:changed', nativeTheme.shouldUseDarkColors));

  fsService.register(ipcMain);
  searchService.register(ipcMain);
  gitService.register(ipcMain);
  terminalService.register(ipcMain);
  lspService.register(ipcMain);
  runner.register(ipcMain);
  dapService.register(ipcMain);
  aiService.register(ipcMain);
  updateService.register(ipcMain);
}

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    const { host, pathname } = new URL(req.url);
    if (host !== 'ide') return new Response('Not found', { status: 404 });
    const file = path.normalize(path.join(ROOT, decodeURIComponent(pathname)));
    if (!file.startsWith(ROOT)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });

  Menu.setApplicationMenu(null);
  const s = settings.get();
  nativeTheme.themeSource = s.theme === 'system' ? 'system' : s.theme;
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  terminalService.disposeAll();
  lspService.disposeAll();
  dapService.disposeAll();
  fsService.unwatch();
  if (process.platform !== 'darwin') app.quit();
});
