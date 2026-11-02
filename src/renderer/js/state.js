// 全局上下文：工作区、设置、Monaco 实例等，供各模块共享。
import { bus } from './util.js';

export const ctx = {
  root: null, // 当前打开的文件夹
  settings: {},
  monaco: null,
  info: {},
  isDark: false,
};

export async function updateSettings(patch) {
  ctx.settings = await window.ide.settings.set(patch);
  bus.emit('settings:changed', ctx.settings, patch);
  return ctx.settings;
}

export async function reloadSettings() {
  ctx.settings = await window.ide.settings.reload();
  bus.emit('settings:changed', ctx.settings, ctx.settings);
}

// 会话状态（打开的文件、布局尺寸等）防抖写盘
let pendingState = {};
let stateTimer = null;
export function saveState(patch) {
  Object.assign(pendingState, patch);
  clearTimeout(stateTimer);
  stateTimer = setTimeout(() => {
    window.ide.state.set(pendingState);
    pendingState = {};
  }, 400);
}

export function flushState() {
  clearTimeout(stateTimer);
  if (Object.keys(pendingState).length) window.ide.state.set(pendingState);
  pendingState = {};
}
