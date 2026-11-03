// 自动更新：后台下载完成后提示重启；便携版提示去下载页；“帮助 → 检查更新”手动检查。
import { bus, escapeHtml, h } from './util.js';
import { toast } from './ui.js';
import { registerCommand } from './commands.js';
import { prepareClose } from './workbench.js';

let status = { state: 'idle' };
let prompted = null; // 已经弹出过提示的版本，自动检查不重复打扰
let notice = null;

export function updateStatus() {
  return status;
}

function showNotice({ title, message, notes, okText, onOk }) {
  if (notice) notice.remove();
  notice = h(`<div class="update-notice">
    <div class="update-notice-title">${escapeHtml(title)}</div>
    <div class="update-notice-msg">${escapeHtml(message)}</div>
    ${notes ? `<details><summary>更新内容</summary><div class="update-notice-notes">${escapeHtml(notes)}</div></details>` : ''}
    <div class="update-notice-actions"><button class="btn btn-sm" data-a="later">稍后</button><button class="btn btn-sm btn-primary" data-a="ok">${escapeHtml(okText)}</button></div>
  </div>`);
  const el = notice;
  const close = () => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
    if (notice === el) notice = null;
  };
  el.querySelector('[data-a=later]').onclick = close;
  el.querySelector('[data-a=ok]').onclick = () => {
    close();
    onOk();
  };
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
}

async function restart() {
  if (status.state !== 'downloaded') return;
  if (!(await prepareClose())) return;
  await window.ide.update.install();
}

function openDownload() {
  if (status.url) window.ide.app.openExternal(status.url);
}

function onStatus(s) {
  const prev = status;
  status = s;
  bus.emit('update:changed', s);
  if (s.state === 'downloaded' && (s.manual || prompted !== s.version)) {
    prompted = s.version;
    return showNotice({
      title: `Lumen IDE ${s.version} 已下载`,
      message: '重启即可完成更新。选择“稍后”也没关系，下次关闭 IDE 时会自动安装。',
      notes: s.notes,
      okText: '立即重启',
      onOk: restart,
    });
  }
  if (s.state === 'available' && (s.manual || prompted !== s.version)) {
    prompted = s.version;
    return showNotice({
      title: `发现新版本 ${s.version}`,
      message: `当前版本 ${s.current}。便携版无法自动替换自身，请下载新版本的便携版或改用安装版（安装版会自动更新）。`,
      notes: s.notes,
      okText: '前往下载',
      onOk: openDownload,
    });
  }
  if (!s.manual) return;
  if (s.state === 'checking') toast('正在检查更新…');
  else if (s.state === 'none') toast(`已是最新版本（${s.current}）`, 'success');
  else if (s.state === 'error') toast(`检查更新失败：${s.message}`, 'error', 4000);
  else if (s.state === 'downloading' && prev.state !== 'downloading') toast(`发现新版本 ${s.version}，正在后台下载`);
}

export async function initUpdate() {
  registerCommand({ id: 'update.check', title: '检查更新…', category: '帮助', run: () => window.ide.update.check() });
  registerCommand({ id: 'update.restart', title: '重启以完成更新', category: '帮助', run: restart, palette: false });
  registerCommand({ id: 'update.download', title: '前往下载新版本', category: '帮助', run: openDownload, palette: false });
  window.ide.update.onStatus(onStatus);
  onStatus(await window.ide.update.status());
}
