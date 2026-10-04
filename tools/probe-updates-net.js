/*
 * What does the updater actually get back from GitHub?
 *
 *   npx electron . --probe=tools/probe-updates-net.js
 *
 * The panel rendering is already covered by probe-updates.js. This one asks the
 * service directly, because "the panel shows Recheck" and "the panel found
 * nothing" look identical from the outside and are not the same bug.
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};

  // straight from the renderer process, through the preload bridge
  out.bridge = await window.env.updates.report();
  out.bridgeError = null;
  try {
    await window.env.updates.report();
  } catch (e) {
    out.bridgeError = e.message;
  }

  // straight from Chromium, to tell an app bug from a network one
  try {
    const r = await fetch('https://api.github.com/repos/raolenv/envserver/releases?per_page=5', {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'EnvServer' },
    });
    out.rawFetch = { status: r.status, ok: r.ok };
    const j = await r.json();
    out.rawFetch = {
      status: r.status,
      count: Array.isArray(j) ? j.length : null,
      tags: Array.isArray(j) ? j.map((x) => x.tag_name) : j && j.message,
      assets: Array.isArray(j) ? j[0].assets.map((a) => a.name) : null,
    };
  } catch (e) {
    out.rawFetch = { error: e.message, cause: e.cause && e.cause.message };
  }

  // and the cache location, since a stale cache would also look like "nothing
  // found" from the panel
  try {
    const s = await window.env.settings.read();
    out.dataDir = s.dataDir;
  } catch (e) {
    out.dataDir = e.message;
  }

  await sleep(200);
  return out;
})()