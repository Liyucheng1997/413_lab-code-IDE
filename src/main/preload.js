// 预加载脚本：通过 contextBridge 向渲染进程暴露受控的 API（window.ide）。
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);
const on = (ch) => (cb) => {
  const fn = (_e, payload) => cb(payload);
  ipcRenderer.on(ch, fn);
  return () => ipcRenderer.removeListener(ch, fn);
};

contextBridge.exposeInMainWorld('ide', {
  // Electron 32+ 不再提供 File.path，需要通过 webUtils 获取拖入文件的真实路径
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  app: {
    info: invoke('app:info'),
    toggleDevTools: invoke('app:toggle-devtools'),
    reload: invoke('app:reload'),
    setTitleColors: invoke('app:set-title-colors'),
    openExternal: invoke('app:open-external'),
    reveal: invoke('app:reveal'),
    openPath: invoke('app:open-path'),
    confirmClose: invoke('app:confirm-close'),
    onBeforeClose: on('app:before-close'),
  },
  dialog: {
    openFolder: invoke('dialog:open-folder'),
    openFile: invoke('dialog:open-file'),
    saveFile: invoke('dialog:save-file'),
    confirm: invoke('dialog:confirm'),
  },
  settings: {
    get: invoke('settings:get'),
    set: invoke('settings:set'),
    reload: invoke('settings:reload'),
  },
  state: {
    get: invoke('state:get'),
    set: invoke('state:set'),
  },
  theme: {
    isDark: invoke('theme:is-dark'),
    onChanged: on('theme:changed'),
  },
  fs: {
    readDir: invoke('fs:read-dir'),
    readFile: invoke('fs:read-file'),
    writeFile: invoke('fs:write-file'),
    createFile: invoke('fs:create-file'),
    createDir: invoke('fs:create-dir'),
    rename: invoke('fs:rename'),
    delete: invoke('fs:delete'),
    copy: invoke('fs:copy'),
    exists: invoke('fs:exists'),
    stat: invoke('fs:stat'),
    listAll: invoke('fs:list-all'),
    watch: invoke('fs:watch'),
    onChanged: on('fs:changed'),
  },
  search: {
    find: invoke('search:find'),
    replace: invoke('search:replace'),
  },
  git: {
    status: invoke('git:status'),
    stage: invoke('git:stage'),
    unstage: invoke('git:unstage'),
    discard: invoke('git:discard'),
    commit: invoke('git:commit'),
    show: invoke('git:show'),
    log: invoke('git:log'),
    branches: invoke('git:branches'),
    checkout: invoke('git:checkout'),
    init: invoke('git:init'),
    lineChanges: invoke('git:line-changes'),
    run: invoke('git:run'),
    info: invoke('git:info'),
    compare: invoke('git:compare'),
    logPage: invoke('git:log-page'),
    commitDetail: invoke('git:commit-detail'),
    fileAtCommit: invoke('git:file-at-commit'),
    sync: invoke('git:sync'),
    clone: invoke('git:clone'),
  },
  github: {
    status: invoke('github:status'),
    repo: invoke('github:repo'),
    publish: invoke('github:publish'),
  },
  term: {
    create: invoke('term:create'),
    write: (id, data) => ipcRenderer.send('term:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('term:resize', id, cols, rows),
    kill: invoke('term:kill'),
    onData: on('term:data'),
    onExit: on('term:exit'),
  },
  lsp: {
    start: invoke('lsp:start'),
    request: invoke('lsp:request'),
    notify: (lang, root, method, params) => ipcRenderer.send('lsp:notify', lang, root, method, params),
    restart: invoke('lsp:restart'),
    list: invoke('lsp:list'),
    stopRoot: invoke('lsp:stop-root'),
    onNotification: on('lsp:notification'),
    onStatus: on('lsp:status'),
    onLog: on('lsp:log'),
    onApplyEdit: on('lsp:apply-edit'),
  },
  run: {
    commandFor: invoke('run:command-for'),
  },
  ai: {
    config: invoke('ai:config'),
    setKey: invoke('ai:set-key'),
    test: invoke('ai:test'),
    send: invoke('ai:send'),
    stop: invoke('ai:stop'),
    reset: invoke('ai:reset'),
    exec: invoke('ai:exec'),
    killExec: invoke('ai:exec-kill'),
    onExecData: on('ai:exec-data'),
    toolResult: (callId, result) => ipcRenderer.send('ai:tool-result', callId, result),
    onEvent: on('ai:event'),
    onToolCall: on('ai:tool-call'),
  },
  update: {
    status: invoke('update:status'),
    check: invoke('update:check'),
    install: invoke('update:install'),
    onStatus: on('update:status'),
  },
  dap: {
    start: invoke('dap:start'),
    request: invoke('dap:request'),
    stop: invoke('dap:stop'),
    pythonPath: invoke('dap:python-path'),
    respondReverse: (id, seq, command, body, success = true) => ipcRenderer.send('dap:reverse-response', id, seq, command, body, success),
    onEvent: on('dap:event'),
    onReverse: on('dap:reverse'),
  },
});
