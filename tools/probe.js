/*
 * Layout probe: measures the real boxes in the running app.
 *
 * Run with the window forced to a size:
 *   npx electron . --probe=tools/probe.js --screenshot-size=980x640
 *
 * The script string is read from this file, so it has to be a single expression.
 */
(() => {
  const out = { size: [innerWidth, innerHeight], overflow: [], clipped: [], hidden: [] };

  const label = (el) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}`;
  };

  // anything sticking out past the right edge of the viewport
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right > innerWidth + 1) out.overflow.push({ el: label(el), right: Math.round(r.right), w: Math.round(r.width) });
  }

  // content taller/wider than its own scroll container, where scrolling is impossible
  for (const el of document.querySelectorAll('.panel__body, .sidebar, .content__body, .serverpick, .jobs')) {
    if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflowX === 'hidden') {
      out.clipped.push({ el: label(el), scrollW: el.scrollWidth, clientW: el.clientWidth });
    }
  }

  // interactive rows that are scrolled out of view inside their container
  for (const el of document.querySelectorAll('.navitem, .serverpick__item, .serverpick__new')) {
    const r = el.getBoundingClientRect();
    if (r.bottom > innerHeight + 1 || r.top < -1) out.hidden.push({ el: label(el), text: el.textContent.trim().slice(0, 24), top: Math.round(r.top), bottom: Math.round(r.bottom) });
  }

  const foot = document.querySelector('.sidebar__foot');
  out.foot = foot ? { top: Math.round(foot.getBoundingClientRect().top), scrollH: foot.scrollHeight, clientH: foot.clientHeight } : null;

  return out;
})()