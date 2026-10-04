/*
 * Behaviour probe for the Config view's player lists.
 *
 *   npx electron . --probe=tools/probe-config.js --screenshot-size=1240x820
 *
 * Two things are checked, and the second is the one that was broken:
 *   1. clicking Add writes the file and the row appears immediately;
 *   2. a write made *behind* the app's back shows up on its own within a poll
 *      interval - which is what "realtime" has to mean for a ban typed in the
 *      server console.
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { steps: [] };

  document.querySelector('.srow')?.click();
  await sleep(1800);
  const nav = [...document.querySelectorAll('.navitem')].find((b) => b.textContent.trim().toLowerCase() === 'config');
  nav?.click();
  await sleep(2200);

  const panelFor = (label) =>
    [...document.querySelectorAll('.panel')].find((p) => (p.querySelector('.panel__title')?.textContent || '').trim() === label);

  const ops = panelFor('Operators');
  if (!ops) return { error: 'no operators panel', body: document.getElementById('content-body')?.textContent.slice(0, 200) };

  const rowsOf = (p) => [...p.querySelectorAll('.checkline')].map((r) => r.querySelector('.checkline__name span')?.textContent);
  out.steps.push({ step: 'start', rows: rowsOf(ops) });

  /* 1 - the Add button */
  const input = ops.querySelector('input.input--sm');
  const addBtn = ops.querySelector('.btn');
  const name = 'ProbeUser';
  input.value = name;
  addBtn.click();
  await sleep(1200);
  out.steps.push({ step: 'after click Add', rows: rowsOf(ops), inputCleared: input.value === '' });

  /* 2 - a write the UI never asked for */
  await window.env.config.addPlayer(window.__envActive, 'banned', 'SilentBan');
  const before = rowsOf(panelFor('Banned players'));
  await sleep(3000);
  const after = rowsOf(panelFor('Banned players'));
  out.steps.push({ step: 'external write', before, after, pickedUp: after.includes('SilentBan') && before.length === after.length - 1 });

  /* 3 - remove it again, so a probe run leaves no trace */
  const banned = panelFor('Banned players');
  const row = [...banned.querySelectorAll('.checkline')].find((r) => /SilentBan/.test(r.textContent));
  row?.querySelector('button')?.click();
  await sleep(1200);
  out.steps.push({ step: 'after remove', rows: rowsOf(banned) });

  /* 4 - leave the view and confirm the poll stops */
  const home = [...document.querySelectorAll('.navitem')].find((b) => b.textContent.trim().toLowerCase() === 'servers');
  home?.click();
  await sleep(400);
  out.leaving = document.getElementById('content-body')?.textContent.slice(0, 40);

  return out;
})()