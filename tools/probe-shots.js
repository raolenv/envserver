/*
 * Why did the README crops find nothing?
 *
 *   npx electron . --probe=tools/probe-shots.js
 *
 * `--screenshot-region=.dash` and `=.createcard` matched nothing while
 * `#content-body` had a size, which reads like the crop never ran but is really
 * the view never rendering the thing being cropped to. This seeds a server the
 * way the capture does and reports what the renderer actually has, so the fix
 * goes in the right place instead of being guessed at a third time.
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};

  const dom = (m) => ({
    view: m.state.view,
    activeId: m.state.activeId || '',
    servers: m.state.servers.length,
    detail: m.state.detail ? m.state.detail.server.id : null,
    creating: Boolean(m.state.homeCreating),
    bodyChildren: (() => {
      const body = document.getElementById('content-body');
      return body ? [...body.children].map((n) => n.className || n.tagName) : null;
    })(),
    selectors: {
      '.dash': !!document.querySelector('.dash'),
      '.createcard': !!document.querySelector('.createcard'),
      '.slist': !!document.querySelector('.slist'),
      '.console-pane': !!document.querySelector('.console-pane'),
      '.settings': !!document.querySelector('.settings'),
      '.welcome__card': !!document.querySelector('.welcome__card'),
    },
  });

  const m = await import('./js/state.js');
  out.hooks = {
    setView: typeof window.__envSetView,
    refreshServers: typeof window.__envRefreshServers,
    openServer: typeof window.__envOpenServer,
    create: typeof window.env.servers.create,
  };
  out.before = dom(m);

  m.state.settings.termsAccepted = true;

  // --- seed exactly the way tools/shots.js does -----------------------------
  try {
    if (!m.state.servers.length) {
      const made = await window.env.servers.create({
        name: 'ENV#1',
        type: 'paper',
        mcVersion: '1.21.4',
        memory: { min: 1024, max: 2048 },
      });
      out.createResult = made;
      await window.__envRefreshServers();
    }
    out.afterSeed = dom(m);

    if (m.state.servers[0]) {
      out.openResult = await window.__envOpenServer(m.state.servers[0].id);
      await sleep(1500);
    }
    out.afterOpen = dom(m);
  } catch (e) {
    out.seedError = e && e.message ? e.message : String(e);
  }

  // --- each view the shots crop --------------------------------------------
  for (const v of ['dashboard', 'console', 'config', 'versions', 'plugins', 'settings']) {
    try {
      window.__envSetView(v);
      await sleep(1800);
      out[`view_${v}`] = dom(m);
    } catch (e) {
      out[`view_${v}`] = 'threw: ' + (e && e.message ? e.message : String(e));
    }
  }

  // --- the new-server shot needs the form open, not a click on a button that
  // --- only exists when there are no servers at all
  try {
    window.__envSetView('home');
    await sleep(1200);
    out.homeBeforeCreating = dom(m);
    const btn = document.querySelector('button.serverpick__new');
    out.newButton = btn ? btn.textContent.trim() : null;
    if (btn) btn.click();
    await sleep(1200);
    out.homeAfterClick = dom(m);
    // the head-bar action is the reliable way in when servers do exist
    m.state.homeCreating = true;
    window.__envSetView('home');
    await sleep(1200);
    out.homeAfterForcing = dom(m);
  } catch (e) {
    out.homeError = e && e.message ? e.message : String(e);
  }

  // --- the modals the shots open -------------------------------------------
  try {
    const { welcomeBox } = await import('./js/ui/overlay.js');
    welcomeBox();
    await sleep(800);
    out.selectors_welcome = !!document.querySelector('.welcome__card');
  } catch (e) {
    out.selectors_welcome = 'threw: ' + e.message;
  }

  return out;
})()
