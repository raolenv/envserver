/**
 * Tiny hyperscript helper. `h('div.card', { ... }, ...children)`
 *
 * - class/dataset keys are written as-is, `on*` props become listeners
 * - children may be nodes, strings, numbers, arrays, or null/false/undefined
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'path', 'rect', 'circle', 'g', 'line', 'polygon', 'polyline', 'ellipse']);

function parseTag(spec) {
  const m = /^([a-zA-Z][\w-]*)?((?:[.#][\w-]+)*)$/.exec(spec);
  if (!m) throw new Error(`h(): bad tag spec "${spec}"`);
  const tag = m[1] || 'div';
  const classes = [];
  const id = [];
  for (const token of m[2].match(/[.#][\w-]+/g) || []) {
    if (token[0] === '.') classes.push(token.slice(1));
    else id.push(token.slice(1));
  }
  return { tag, classes, id: id[0] };
}

function applyProp(el, key, value) {
  if (value === null || value === undefined || value === false) return;

  if (key === 'class' || key === 'className') {
    for (const c of String(value).split(/\s+/).filter(Boolean)) el.classList.add(c);
    return;
  }
  if (key === 'style' && typeof value === 'object') {
    Object.assign(el.style, value);
    return;
  }
  if (key === 'dataset' && typeof value === 'object') {
    Object.assign(el.dataset, value);
    return;
  }
  if (key === 'text') {
    el.textContent = String(value);
    return;
  }
  if (key === 'html') {
    el.innerHTML = String(value);
    return;
  }
  if (key.startsWith('on') && typeof value === 'function') {
    el.addEventListener(key.slice(2).toLowerCase(), value);
    return;
  }
  if (key === 'value' && 'value' in el) {
    el.value = value;
    return;
  }
  if (key === 'checked' || key === 'disabled' || key === 'hidden' || key === 'selected') {
    el[key] = Boolean(value);
    if (value) el.setAttribute(key, '');
    else el.removeAttribute(key);
    return;
  }
  el.setAttribute(key, value === true ? '' : String(value));
}

function append(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) append(el, child);
    else if (child instanceof Node) el.appendChild(child);
    else el.appendChild(document.createTextNode(String(child)));
  }
}

export function h(spec, props, ...children) {
  const { tag, classes, id } = parseTag(spec);
  const el = SVG_TAGS.has(tag) ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);

  if (classes.length) el.classList.add(...classes);
  if (id) el.id = id;

  if (props && typeof props === 'object' && !(props instanceof Node) && !Array.isArray(props)) {
    for (const [k, v] of Object.entries(props)) applyProp(el, k, v);
  } else if (props !== undefined) {
    children.unshift(props);
  }

  append(el, children);
  return el;
}

export function frag(...children) {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function mount(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}

/** Block-texture <img> tag. */
export function block(name, size = 16, extra = {}) {
  return h('img', { src: `assets/blocks/${name}.png`, width: size, height: size, alt: '', ...extra });
}

/**
 * The branded loading state: the app logo turning on two axes.
 *
 * Used for anything with no result yet - a slow view, a running job in the
 * sidebar. The spin is deliberately unhurried; a fast spinner reads as a glitch.
 *
 * @param {'sm'|'md'|'lg'|'xl'} [size]
 */
export function loader(size = 'md') {
  const cls = size === 'md' ? 'div.loader' : `div.loader.loader--${size}`;
  return h(cls, h('img.loader__cube', { src: 'assets/icon-128.png', alt: '' }));
}

/** A checkbox styled as the kit's switch. */
export function switchBox(checked, onToggle, label = '') {
  const el = h('button.switch', {
    type: 'button',
    role: 'switch',
    'aria-checked': checked ? 'true' : 'false',
    title: label,
    onClick: () => {
      const next = el.getAttribute('aria-checked') !== 'true';
      el.setAttribute('aria-checked', next ? 'true' : 'false');
      onToggle(next);
    },
  });
  return el;
}

/** A label + control row, the shape Settings and Config both use a lot. */
export function switchRow(title, desc, checked, onToggle) {
  return h(
    'div.switch-row',
    h(
      'div.switch-row__text',
      h('div.switch-row__title', { text: title }),
      desc ? h('div.switch-row__desc', { text: desc }) : null
    ),
    switchBox(checked, onToggle, title)
  );
}