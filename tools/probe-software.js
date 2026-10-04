/*
 * Software-aware UI probe.
 *
 *   npx electron . --probe=tools/probe-software.js
 *
 * Creates one throwaway server, then for each software: reload the renderer so
 * the state comes from disk rather than from whatever the last run left behind,
 * open that server, and check the nav bar and dashboard reflect what the
 * software can actually do. Deletes the server at the end.
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const navLabels = () => [...document.querySelectorAll('.navitem')].map((b) => b.textContent.trim());

  const results = [];
  const name = 'ProbeSW';

  // leftovers from an earlier run would be found by the same name match
  for (const s of (await window.env.servers.list()).servers || []) {
    if (s.name === name) {
      await window.env.servers.remove(s.id);
      results.push({ removedLeftover: s.id });
    }
  }

  const created = await window.env.servers.create({ name, mcVersion: '1.21.8', memory: { min: 1024, max: 2048 }, type: 'vanilla' });
  const id = created?.server?.id || created?.id;
  if (!id) return { error: 'create returned no id', created };

  for (const type of ['vanilla', 'purpur', 'paper', 'spigot', 'vanilla']) {
    await window.env.servers.update(id, { type });
    await window.__envRefreshServers();
    await window.__envOpenServer(id);
    await sleep(1800);

    const list = await window.env.servers.list();
    const stored = (list.servers || []).find((s) => s.id === id);
    const nav = navLabels();
    const kv = [...document.querySelectorAll('.kv')].map((r) => r.textContent.trim()).find((t) => /^Plugins/.test(t));
    results.push({
      type,
      storedType: stored?.type,
      title: document.querySelector('.content__title')?.textContent || '',
      hasPluginsTab: nav.includes('Plugins'),
      pluginsKv: kv || null,
      nav: nav.join(' | '),
    });
  }

  // reaching the plugins view on a vanilla server must bounce, not paint
  await window.env.servers.update(id, { type: 'vanilla' });
  await window.__envRefreshServers();
  await window.__envOpenServer(id);
  await sleep(1500);
  const tab = [...document.querySelectorAll('.navitem')].find((b) => b.textContent.trim() === 'Plugins');
  if (tab) tab.click();
  await sleep(1200);
  results.push({ forcedPluginsView: document.querySelector('.content__title')?.textContent || '(no tab to click)' });

  try {
    await window.env.servers.remove(id);
    results.push({ cleanup: 'removed' });
  } catch (err) {
    results.push({ cleanup: 'failed: ' + String(err?.message || err) });
  }

  return results;
})()