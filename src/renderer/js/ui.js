// 通用界面组件：提示、右键菜单、对话框。
import { escapeHtml, h } from './util.js';
import { icon } from './icons.js';

export function toast(message, type = 'info', ms = 2600) {
  const host = document.getElementById('toast-host');
  const el = h(`<div class="toast toast-${type}">${escapeHtml(message)}</div>`);
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

let openMenus = [];

export function closeMenus() {
  for (const m of openMenus) m.remove();
  openMenus = [];
  document.querySelectorAll('.menu-root.open').forEach((b) => b.classList.remove('open'));
}

// items: [{label, shortcut, action, disabled, checked, submenu, type:'sep'|'header'}]
export function showMenu(items, x, y, { level = 0, onClose, above = false } = {}) {
  if (level === 0) closeMenus();
  else openMenus.splice(level).forEach((m) => m.remove());
  const el = document.createElement('div');
  el.className = 'popover menu';
  for (const item of items) {
    if (!item) continue;
    if (item.type === 'sep') {
      el.appendChild(h('<div class="menu-sep"></div>'));
      continue;
    }
    if (item.type === 'header') {
      el.appendChild(h(`<div class="menu-header">${escapeHtml(item.label)}</div>`));
      continue;
    }
    const row = h(`<div class="menu-item${item.disabled ? ' disabled' : ''}${item.checked ? ' checked' : ''}${item.submenu ? ' has-sub' : ''}">
      <span class="menu-icon">${item.icon ? icon(item.icon) : ''}</span>
      <span class="menu-label">${escapeHtml(item.label)}</span>
      ${item.shortcut ? `<span class="menu-shortcut">${escapeHtml(item.shortcut)}</span>` : ''}
    </div>`);
    if (item.submenu) {
      row.addEventListener('mouseenter', () => {
        const r = row.getBoundingClientRect();
        showMenu(typeof item.submenu === 'function' ? item.submenu() : item.submenu, r.right + 2, r.top - 5, { level: level + 1 });
      });
    } else {
      row.addEventListener('mouseenter', () => openMenus.splice(level + 1).forEach((m) => m.remove()));
      row.addEventListener('mouseup', (e) => {
        if (item.disabled || e.button === 1) return;
        closeMenus();
        onClose && onClose();
        setTimeout(() => item.action && item.action(), 0);
      });
    }
    el.appendChild(row);
  }
  document.body.appendChild(el);
  // 保持菜单在窗口内
  const r = el.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - r.width - 6);
  const top = above ? y - r.height : Math.min(y, window.innerHeight - r.height - 6);
  el.style.left = Math.max(4, left) + 'px';
  el.style.top = Math.max(4, top) + 'px';
  openMenus[level] = el;
  return el;
}

document.addEventListener('mousedown', (e) => {
  if (!openMenus.length) return;
  if (openMenus.some((m) => m.contains(e.target))) return;
  if (e.target.closest('.menu-root')) return;
  closeMenus();
});
window.addEventListener('blur', closeMenus);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openMenus.length) {
    closeMenus();
    e.stopPropagation();
  }
}, true);

export function contextMenu(e, items) {
  e.preventDefault();
  e.stopPropagation();
  showMenu(items, e.clientX, e.clientY);
}

// 模态框：返回 { el, close }，内容由调用方填充
export function modal({ title, body, footer, width = 420, className = '', onClose, closeOnOverlay = true }) {
  const overlay = h(`<div class="modal-overlay"></div>`);
  const box = h(`<div class="modal ${className}" style="width:${width}px"></div>`);
  if (title !== undefined) {
    box.appendChild(h(`<div class="modal-header"><span>${escapeHtml(title)}</span><button class="modal-x">${icon('close')}</button></div>`));
  }
  if (body) {
    const b = typeof body === 'string' ? h(`<div class="modal-body">${body}</div>`) : body;
    box.appendChild(b);
  }
  if (footer) box.appendChild(typeof footer === 'string' ? h(`<div class="modal-footer">${footer}</div>`) : footer);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  let closed = false;
  const close = (value) => {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose && onClose(value);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(null);
    }
  };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay && closeOnOverlay) close(null);
  });
  const x = box.querySelector('.modal-x');
  if (x) x.addEventListener('click', () => close(null));
  return { el: box, overlay, close };
}

export function prompt({ title, message = '', value = '', placeholder = '', okText = '确定', selectBaseName = false, validate }) {
  return new Promise((resolve) => {
    const body = h(`<div class="modal-body">${message ? `<div class="modal-sub">${escapeHtml(message)}</div>` : ''}<input class="input prompt-input" spellcheck="false" placeholder="${escapeHtml(placeholder)}" /><div class="modal-sub" style="color:var(--danger);margin:8px 0 0" hidden></div></div>`);
    const footer = h(`<div class="modal-footer"><button class="btn" data-a="cancel">取消</button><button class="btn btn-primary" data-a="ok">${escapeHtml(okText)}</button></div>`);
    const m = modal({ title, body, footer, onClose: (v) => resolve(v) });
    const input = body.querySelector('input');
    const err = body.querySelectorAll('.modal-sub')[message ? 1 : 0];
    input.value = value;
    setTimeout(() => {
      input.focus();
      if (selectBaseName && value.includes('.')) input.setSelectionRange(0, value.lastIndexOf('.'));
      else input.select();
    });
    const ok = () => {
      const v = input.value.trim();
      const problem = validate ? validate(v) : null;
      if (problem) {
        err.textContent = problem;
        err.hidden = false;
        return;
      }
      m.close(v || null);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') ok();
    });
    footer.querySelector('[data-a=ok]').onclick = ok;
    footer.querySelector('[data-a=cancel]').onclick = () => m.close(null);
  });
}

// 返回被点击按钮的索引；Esc 返回 -1
export function confirm({ title, message = '', buttons = ['确定', '取消'], danger = false, primary = 0 }) {
  return new Promise((resolve) => {
    const body = h(`<div class="modal-body"><div class="modal-msg">${escapeHtml(message)}</div></div>`);
    const footer = h(`<div class="modal-footer"></div>`);
    buttons.forEach((label, i) => {
      const b = h(`<button class="btn ${i === primary ? (danger ? 'btn-primary' : 'btn-primary') : ''}" ${i === primary && danger ? 'style="background:var(--danger)"' : ''}>${escapeHtml(label)}</button>`);
      b.onclick = () => m.close(i);
      footer.appendChild(b);
    });
    // 主要按钮放最右
    const btns = [...footer.children];
    footer.innerHTML = '';
    btns.reverse().forEach((b) => footer.appendChild(b));
    const m = modal({ title, body, footer, width: 400, onClose: (v) => resolve(v === null ? -1 : v) });
    setTimeout(() => footer.querySelectorAll('.btn')[buttons.length - 1 - primary].focus());
  });
}
