import { h } from '../dom.js';

const HOST = () => document.getElementById('toasts');

/**
 * Show a transient message.
 * @param {string} message
 * @param {'ok'|'err'|'info'} kind
 */
export function toast(message, kind = 'info', ttl = 3200) {
  const el = h('div.toast', { class: `toast--${kind}` }, h('span.toast__dot'), h('span', { text: message }));
  HOST().appendChild(el);

  const close = () => {
    el.classList.add('is-out');
    setTimeout(() => el.remove(), 180);
  };
  const timer = setTimeout(close, ttl);
  el.addEventListener('click', () => {
    clearTimeout(timer);
    close();
  });
  return el;
}