// 调试控制台：显示调试输出，底部输入框可在当前栈帧上求值（REPL）。
import { escapeHtml, h } from './util.js';
import { icon } from './icons.js';

let listEl;
let inputEl;
let evaluator = null;
let expander = null;
const history = [];
let histIndex = -1;
const MAX_ROWS = 5000;

export function setEvaluator(fn, expandFn) {
  evaluator = fn;
  expander = expandFn;
}

function atBottom() {
  return listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 40;
}

function trim() {
  while (listEl.children.length > MAX_ROWS) listEl.firstChild.remove();
}

// category: stdout | stderr | console | important | input | result | error
export function appendOutput(text, category = 'stdout') {
  if (!listEl || !text) return;
  const stick = atBottom();
  // 连续的同类输出合并到同一行元素，避免逐字符输出时产生大量节点
  const last = listEl.lastElementChild;
  if (last && last.dataset.cat === category && last.dataset.open === '1' && (category === 'stdout' || category === 'stderr')) {
    last.textContent += text;
  } else {
    const row = h(`<div class="dc-row dc-${category}" data-cat="${category}"></div>`);
    row.textContent = text;
    listEl.appendChild(row);
  }
  const lastRow = listEl.lastElementChild;
  lastRow.dataset.open = text.endsWith('\n') ? '0' : '1';
  if (text.endsWith('\n')) lastRow.textContent = lastRow.textContent.replace(/\n$/, '');
  trim();
  if (stick) listEl.scrollTop = listEl.scrollHeight;
}

// 可展开的求值结果
export function appendResult(label, value, variablesReference) {
  if (!listEl) return;
  const stick = atBottom();
  const row = h(`<div class="dc-row dc-result"><span class="dc-twisty">${variablesReference ? icon('chevron') : ''}</span><span>${label ? `<span class="dc-label">${escapeHtml(label)}</span> ` : ''}${escapeHtml(value)}</span></div>`);
  if (variablesReference && expander) {
    const kids = h('<div class="dc-children" hidden></div>');
    row.querySelector('.dc-twisty').style.cursor = 'pointer';
    row.addEventListener('click', async () => {
      kids.hidden = !kids.hidden;
      row.classList.toggle('open', !kids.hidden);
      if (!kids.hidden && !kids.childElementCount) await expander(kids, variablesReference);
    });
    listEl.appendChild(row);
    listEl.appendChild(kids);
  } else listEl.appendChild(row);
  trim();
  if (stick) listEl.scrollTop = listEl.scrollHeight;
}

export function clearConsole() {
  if (listEl) listEl.innerHTML = '';
}

export function focusConsoleInput() {
  if (inputEl) inputEl.focus();
}

export function initDebugConsole(container) {
  container.innerHTML = `<div class="debug-console"><div class="dc-list"></div><div class="dc-input-row">${icon('chevron')}<input class="dc-input" spellcheck="false" placeholder="在当前栈帧中求值表达式（↑↓ 浏览历史）"></div></div>`;
  listEl = container.querySelector('.dc-list');
  inputEl = container.querySelector('.dc-input');
  inputEl.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && inputEl.value.trim()) {
      const expr = inputEl.value;
      history.unshift(expr);
      histIndex = -1;
      inputEl.value = '';
      appendOutput(expr + '\n', 'input');
      if (!evaluator) return appendOutput('没有正在进行的调试会话\n', 'error');
      try {
        const r = await evaluator(expr);
        appendResult('', r.result, r.variablesReference);
      } catch (err) {
        appendOutput(err.message + '\n', 'error');
      }
    } else if (e.key === 'ArrowUp' && history.length) {
      histIndex = Math.min(history.length - 1, histIndex + 1);
      inputEl.value = history[histIndex];
      e.preventDefault();
    } else if (e.key === 'ArrowDown') {
      histIndex = Math.max(-1, histIndex - 1);
      inputEl.value = histIndex >= 0 ? history[histIndex] : '';
      e.preventDefault();
    }
  });
  listEl.addEventListener('mouseup', () => {
    if (!window.getSelection().toString()) inputEl.focus();
  });
}
