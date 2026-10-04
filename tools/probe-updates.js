/*
 * Updates panel probe.
 *
 *   npx electron . --probe=tools/probe-updates.js
 *
 * The repository does not exist yet when this runs, which is the useful case:
 * the panel must still render, say it could not reach GitHub, and show where the
 * user's data lives so "will my servers survive an update" has an answer.
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const btn = document.getElementById('btn-updates');
  const host = document.getElementById('updates');

  const out = { button: {}, closed: {}, opened: {}, reopen: {} };

  out.button = {
    exists: Boolean(btn),
    inControls: Boolean(btn?.closest('.titlebar__controls')),
    beforeMinimize: (() => {
      const labels = [...document.querySelectorAll('.titlebar__controls > *')].map((n) => n.dataset.wc || n.id);
      return labels;
    })(),
  };

  // closed by default
  out.closed = { hidden: host?.hidden, mounted: Boolean(host?.firstChild) };

  btn?.click();
  await sleep(2500);

  const text = (host?.textContent || '').replace(/\s+/g, ' ').trim();
  out.opened = {
    hidden: host?.hidden,
    title: document.title,
    hasCurrent: /v\d+\.\d+\.\d+/.test(text),
    current: text.match(/v\d+\.\d+\.\d+/)?.[0] || null,
    mentionsDataDir: /%APPDATA%|data/i.test(text),
    hasDataPathNode: Boolean(host?.querySelector('.updates__path')),
    sections: [...(host?.querySelectorAll('.updates__section') || [])].map((n) => n.textContent),
    buttons: [...(host?.querySelectorAll('button') || [])].map((n) => n.textContent.trim()),
    overflows: (() => {
      const r = host?.getBoundingClientRect();
      if (!r) return 'no panel';
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), vh: window.innerHeight, vw: window.innerWidth };
    })(),
    scrollable: (() => {
      const b = host?.querySelector('.updates__body');
      return b ? { client: b.clientHeight, scroll: b.scrollHeight } : null;
    })(),
  };

  // clicking away closes it
  document.getElementById('sidebar')?.click();
  await sleep(400);
  out.reopen = { hiddenAfterOutsideClick: host?.hidden };

  // and the titlebar button brings it back
  btn?.click();
  await sleep(400);
  out.reopen.reopened = !host?.hidden;

  return out;
})()