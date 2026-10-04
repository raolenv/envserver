/*
 * Layout probe: walk every view at the current window size and report anything
 * that overflows, is clipped, or is too narrow to read.
 *
 *   npx electron . --probe=tools/probe-view.js --screenshot-size=980x640
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const measure = (name) => {
    const out = { name, overflow: [], clipped: [], tiny: 0, nested: [], panels: 0 };

    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > innerWidth + 1) {
        out.overflow.push({ tag: `${el.tagName}.${String(el.className).slice(0, 28)}`, right: Math.round(r.right), w: Math.round(r.width) });
      }
    }

    for (const el of document.querySelectorAll('.panel__body, .sidebar, .content__body, .tablewrap')) {
      const cs = getComputedStyle(el);
      if (el.scrollWidth > el.clientWidth + 2 && cs.overflowX === 'hidden') {
        out.clipped.push({ tag: String(el.className).slice(0, 40), scrollW: el.scrollWidth, clientW: el.clientWidth });
      }
    }

    for (const el of document.querySelectorAll('.panel')) out.tiny += el.getBoundingClientRect().width < 240 ? 1 : 0;

    for (const el of document.querySelectorAll('.panel__body *')) {
      if (el.children.length) continue;
      if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflowX === 'hidden') {
        out.nested.push({ tag: String(el.className).slice(0, 26) || el.tagName, scrollW: el.scrollWidth, clientW: el.clientWidth, text: el.textContent.trim().slice(0, 34) });
      }
    }

    out.panels = document.querySelectorAll('.content__body .panel').length;
    const grid = document.querySelector('.content__body .grid--2');
    out.gridCols = grid ? getComputedStyle(grid).gridTemplateColumns : null;
    return out;
  };

  const results = [];

  // server-scoped views need a server open first
  document.querySelector('.srow')?.click();
  await sleep(1800);

  for (const label of ['Dashboard', 'Config', 'Versions', 'Plugins', 'Settings']) {
    const nav = [...document.querySelectorAll('.navitem')].find((b) => b.textContent.trim().toLowerCase() === label.toLowerCase());
    if (!nav) {
      results.push({ name: label, missing: true });
      continue;
    }
    nav.click();
    await sleep(1600);
    results.push(measure(label));
  }

  // the new-server form on the list page
  document.querySelector('.serverpick__new')?.click();
  await sleep(1200);
  results.push(measure('New server'));
  const create = document.querySelector('.content__body .panel');
  if (create) {
    const fields = [...create.querySelectorAll('.field__label')].map((l) => l.textContent);
    results.push({ name: 'New server fields', fields, options: [...create.querySelectorAll('select')].map((s) => s.options.length) });
  }

  return results;
})()