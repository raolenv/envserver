import { h } from './dom.js';

/**
 * Icon set: inline SVG, 24x24, 1.75px stroke, round caps.
 *
 * Inline rather than sprite sheets or icon fonts because this app has a strict
 * CSP with no remote origins and no build step for assets - an `<svg>` element
 * cannot 404, cannot flash unstyled, and inherits `currentColor` so an icon
 * always matches the text next to it.
 */

const PATHS = {
  // ---- navigation ----
  dashboard: 'M4 13h6V4H4v9Zm0 7h6v-5H4v5Zm10 0h6v-9h-6v9Zm0-16v5h6V4h-6Z',
  terminal: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm3 4 2.5 2.5L7 14m4 0h5',
  sliders: 'M4 7h10m4 0h2M4 17h4m4 0h8M14 4v6M8 14v6',
  layers: 'M12 3 3 7.5l9 4.5 9-4.5L12 3Zm9 9-9 4.5-9-4.5m18 4.5-9 4.5-9-4.5',
  puzzle:
    'M10 4a2 2 0 1 1 4 0v1h2.5a1 1 0 0 1 1 1V9H19a2 2 0 1 1 0 4h-1.5v2.5a1 1 0 0 1-1 1H14v-1a2 2 0 1 0-4 0v1H7.5a1 1 0 0 1-1-1V13H5a2 2 0 1 1 0-4h1.5V6a1 1 0 0 1 1-1H10V4Z',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z',

  // ---- actions ----
  play: 'M7 4.5 19.5 12 7 19.5v-15Z',
  stop: 'M6.5 6.5h11v11h-11z',
  power: 'M12 3v9m-6.36-6.36a9 9 0 1 0 12.72 0',
  refresh: 'M20 11a8 8 0 1 0-.6 4M20 4v7h-7',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  trash: 'M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0v12a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V7',
  folder: 'M3 7a1 1 0 0 1 1-1h5l2 2.5h8a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z',
  download: 'M12 3v12m0 0 4.5-4.5M12 15l-4.5-4.5M4 19h16',
  upload: 'M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M4 20h16',
  check: 'M4.5 12.5 9 17l10.5-10.5',
  close: 'M6 6l12 12M18 6 6 18',
  alert: 'M12 8v5m0 3.5v.5M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0Z',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13.5v.5m0 3.5v5',
  external: 'M14 4h6v6m0-6L10 14M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5 -2 4.5 4.5',
  copy: 'M9 9V6a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-3M6 9h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z',
  chevronRight: 'M9 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  save: 'M5 4h11l3 3v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm2 0v6h8V4M8 21v-7h8v7',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13v5l3.5 2',
  users: 'M16 20v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20M9.5 10.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM21 20v-1.5a4 4 0 0 0-3-3.87M16 3.6a4 4 0 0 1 0 7.75',
  cpu: 'M6 6h12v12H6zM9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3',
  database: 'M12 7.5c4.4 0 8-1.1 8-2.5S16.4 2.5 12 2.5 4 3.6 4 5s3.6 2.5 8 2.5ZM4 5v14c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5V5M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5',
  package: 'M21 8 12 3 3 8m18 0-9 5m9-5v8l-9 5m0-8L3 8m9 5v8M3 8v8l9 5',
  server: 'M4 4h16v6H4zM4 14h16v6H4zM7.5 7h.5M7.5 17h.5M12 7h5M12 17h5',
  cube: 'M12 2.5 21 7v10l-9 4.5L3 17V7l9-4.5Zm0 0V21m9-14-9 4.5-9-4.5',
  hardDrive: 'M3 12h18M5.5 12 7 5h10l1.5 7m-13 0 1.5 7h10l1.5-7',
  zap: 'M13 2 4.5 13.5H11L10 22l8.5-11.5H12L13 2Z',
  shield: 'M12 3 4.5 6v6c0 4.4 3 7.9 7.5 9 4.5-1.1 7.5-4.6 7.5-9V6L12 3Z',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Zm12.5 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  file: 'M13 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8l-5-5Zm0 0v5h5',
};

/** Icons that read better filled than stroked. */
const FILLED = new Set(['play', 'stop']);

/**
 * An icon element.
 *
 * @param {string} name key in PATHS
 * @param {object} [o]
 * @param {number} [o.size=18]
 * @param {string} [o.class] extra class
 * @param {string} [o.title] accessible name; omit for decorative use
 */
export function icon(name, o = {}) {
  const { size = 18, class: cls = '', title = '' } = o;
  const d = PATHS[name];
  if (!d) throw new Error(`unknown icon "${name}"`);

  const svg = h(
    'svg',
    {
      class: `icon${cls ? ` ${cls}` : ''}`,
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      'aria-hidden': title ? null : 'true',
      role: title ? 'img' : null,
      focusable: 'false',
    },
    title ? h('title', { text: title }) : null,
    h('path', {
      d,
      fill: FILLED.has(name) ? 'currentColor' : 'none',
      stroke: FILLED.has(name) ? 'none' : 'currentColor',
      'stroke-width': 1.75,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    })
  );

  return svg;
}

export function hasIcon(name) {
  return Object.prototype.hasOwnProperty.call(PATHS, name);
}

export const iconNames = Object.keys(PATHS);