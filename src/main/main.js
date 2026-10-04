'use strict';

const { app, BrowserWindow, ipcMain, screen, shell, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const store = require('./store');
const paths = require('./services/paths');
const ipc = require('./ipc');
const server = require('./services/server');
const updater = require('./services/updater');

const isDev = process.argv.includes('--dev');
const isSmoke = process.argv.includes('--smoke-test');
const shotArg = process.argv.find((a) => a.startsWith('--screenshot='));
const shotViewArg = process.argv.find((a) => a.startsWith('--screenshot-view='));

/**
 * The smoke test gets its own userData folder.
 *
 * Without this it would read the real settings file, find the servers the user
 * actually has, and report a pass or a failure that has nothing to do with the
 * code. It also means the test can create and delete servers without touching
 * anybody's worlds.
 */
if (isSmoke) {
  const dir = path.join(os.tmpdir(), `envserver-smoke-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  app.setPath('userData', dir);
  app.on('will-quit', () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });
}

/** @type {BrowserWindow|null} */
let win = null;

/** Renderer-side errors seen this run; the smoke test fails on a non-empty list. */
const smokeErrors = [];

/** `--screenshot-size=980x640` - force a window size for a capture. */
const shotSizeArg = process.argv.find((a) => a.startsWith('--screenshot-size='));

/**
 * `electron . --probe=<js|file>` - evaluate in the renderer, print, exit.
 *
 * A file path is read from disk and inlined, because a layout measurement is far
 * too long to survive a command line.
 */
const probeArg = process.argv.find((a) => a.startsWith('--probe='));

/**
 * Layout assertions without a screenshot.
 *
 * A PNG of a clipped panel tells you *that* something is wrong and nothing about
 * *what*; measured boxes tell you exactly which element overflows and by how
 * much, which is what a responsive fix actually needs.
 */
async function runProbe(snippet) {
  try {
    const raw = String(snippet);
    const source = fs.existsSync(raw) ? fs.readFileSync(raw, 'utf8') : raw;
    await js('window.__envReady === true', { label: 'ready', timeout: 30000 });
    await js(`(() => {
      const o = document.getElementById('overlay');
      if (!o || o.hidden) return false;
      const b = [...o.querySelectorAll('button')].find((x) => /default|skip/i.test(x.textContent));
      if (b) b.click();
      return true;
    })()`);
    await wait(1600);
    const out = await js(source, { label: 'probe', timeout: 60000 });
    console.log('PROBE ' + JSON.stringify(out, null, 2));
  } catch (err) {
    console.error('PROBE FAILED: ' + err.message);
    process.exitCode = 1;
  }
  hardExit(process.exitCode || 0);
}

function createWindow() {
  const saved = store.read();
  const forced = /^(\d{2,5})x(\d{2,5})$/.exec(shotSizeArg ? shotSizeArg.slice('--screenshot-size='.length) : '');

  win = new BrowserWindow({
    width: forced ? Number(forced[1]) : saved.window?.width || 1240,
    height: forced ? Number(forced[2]) : saved.window?.height || 820,
    minWidth: 980,
    minHeight: 640,
    frame: false,
    backgroundColor: '#17171b',
    show: false,
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'icon-256.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // the renderer only ever loads local files
      webSecurity: true,
    },
  });

  // a frameless window with no system menu still needs this blocked so the user
  // cannot drag the frame out or navigate away from the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Navigation is owned by the main process. Blocking it unconditionally also
  // blocks a reload of our own page, which is what the F5 shortcut and the smoke
  // test use - `location.reload()` fires `will-navigate` too and was silently
  // cancelled, leaving F5 dead. Reloads therefore go through `window:reload`.
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    win.show();
    if (isSmoke) runSmokeTest();
    else if (shotArg) captureScreenshot(shotArg.slice('--screenshot='.length));
    else if (probeArg) runProbe(probeArg.slice('--probe='.length));
  });

  ipc.bind(win);

  if (isDev) win.webContents.openDevTools({ mode: 'detach' });

  // Dev mode: any change under src/ reloads the renderer, so a UI fix is visible
  // without closing the window. Debounced because editors write in bursts.
  if (isDev) {
    let t = null;
    try {
      fs.watch(path.join(__dirname, '..', 'renderer'), { recursive: true }, () => {
        clearTimeout(t);
        t = setTimeout(() => win.webContents.reload(), 250);
      });
      fs.watch(path.join(__dirname, '..', 'main'), { recursive: true }, () => {
        clearTimeout(t);
        t = setTimeout(() => win.webContents.reload(), 250);
      });
    } catch (err) {
      console.warn('[dev] file watch failed:', err.message);
    }
  }

  if (isDev || isSmoke || shotArg || probeArg) {
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      const text = `[renderer:${level}] ${message} (${sourceId}:${line})`;
      // level 2 is an error, 3 a warning; a thrown script in the renderer is
      // exactly what a DOM snapshot would otherwise hide
      if (level >= 2) smokeErrors.push(text);
      console.log(text);
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      smokeErrors.push(`renderer process gone: ${details.reason}`);
      console.error(smokeErrors[smokeErrors.length - 1]);
    });
    win.webContents.on('preload-error', (_e, preloadPath, err) => {
      smokeErrors.push(`preload ${preloadPath}: ${err.message}`);
      console.error(smokeErrors[smokeErrors.length - 1]);
    });
  }

  const notify = () => notifyWindowState();
  for (const ev of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
    win.on(ev, notify);
  }
  // Chromium does not restore the window when Escape leaves full screen, so the
  // only way back to a usable desktop is to handle the key here
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'Escape' && win.isFullScreen()) {
      win.setFullScreen(false);
      event.preventDefault();
    }
  });
  win.on('minimize', () => {
    syncTaskbar();
    notify();
  });
  win.on('restore', () => {
    syncTaskbar();
    notify();
  });
  syncTaskbar();

  // remember the window size so the next launch opens the same way
  let saveTimer = null;
  const saveBounds = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win || win.isDestroyed() || isMaximized() || win.isFullScreen()) return;
      const [width, height] = win.getSize();
      if (width <= 0 || height <= 0) return;
      store.write({ window: { ...store.read().window, width, height } });
    }, 400);
  };
  win.on('resized', saveBounds);

  win.on('closed', () => {
    win = null;
    restoreBounds = null;
  });

  // Closing the X must not throw away a download in flight or a running server:
  // hide to the tray instead, and let the user quit properly from there.
  win.on('close', (event) => {
    if (quitting || isSmoke) return;
    if (!shouldHideToTray()) return;
    event.preventDefault();
    win.hide();
    emitToRenderer('window:hidden-to-tray');
  });
}

function emitToRenderer(channel, payload) {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send(channel, payload);
  } catch {
    /* the window can go away between the check and the send */
  }
}

function getWindowState() {
  return { maximized: isMaximized(), fullScreen: win.isFullScreen() };
}

/* ---------------------------- window chrome ---------------------------- */

/**
 * Maximize, emulated.
 *
 * `BrowserWindow.setMaximized()` blocks the whole main process on Windows in some
 * sessions - it never returns and the event loop stops, so even the timers that
 * would recover it never fire. `setBounds(workArea)` returns immediately and
 * fires the resize events normally.
 *
 * For a window with `frame: false` there is no native title bar to hide, so
 * filling the work area is visually identical to a real maximize. The state is
 * tracked here instead of being read back from the OS, which never enters its
 * own maximized state.
 *
 * @type {Electron.Rectangle|null}
 */
let restoreBounds = null;

function isMaximized() {
  return restoreBounds !== null;
}

function workArea() {
  const fallback = screen.getPrimaryDisplay().workArea;
  if (!win || win.isDestroyed()) return fallback;
  try {
    return screen.getDisplayMatching(win.getBounds()).workArea;
  } catch {
    return fallback;
  }
}

function doMaximize() {
  if (!win || win.isDestroyed() || isMaximized()) return;
  restoreBounds = win.getBounds();
  win.setBounds(workArea());
  syncTaskbar();
  notifyWindowState();
}

function doRestore() {
  if (!win || win.isDestroyed() || !isMaximized()) return;
  const back = restoreBounds;
  restoreBounds = null;
  win.setBounds(back);
  syncTaskbar();
  notifyWindowState();
}

function toggleMaximize() {
  if (isMaximized()) doRestore();
  else doMaximize();
}

/**
 * A frameless window has no taskbar button of its own, so Windows keeps showing
 * the console/other windows in the taskbar preview and the icon flickers.
 *
 * Deliberately NOT wired to `resize`: `setSkipTaskbar` recreates the taskbar
 * button, and doing that from a resize handler stalls the main process once a
 * drag fires the event hundreds of times.
 */
function syncTaskbar() {
  if (!win || win.isDestroyed()) return;
  try {
    win.setSkipTaskbar(win.isMinimized());
  } catch {
    /* not fatal, the window still works */
  }
}

function notifyWindowState() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('window:state', getWindowState());
}

ipcMain.on('window:minimize', () => {
  if (!win || win.isDestroyed()) return;
  win.minimize();
});
ipcMain.on('window:toggle-maximize', () => toggleMaximize());
ipcMain.on('window:reload', () => {
  if (!win || win.isDestroyed()) return;
  win.webContents.reload();
});

/**
 * F11 real full screen.
 *
 * `setFullScreen(true)` is the only way to get a true fullscreen on Windows -
 * `setBounds` covers the work area but keeps the taskbar, which is what users
 * mean by "not really full screen". Escape has to be handled by hand because
 * Chromium does not restore the window on it.
 */
ipcMain.on('window:toggle-fullscreen', () => {
  if (!win || win.isDestroyed()) return;
  win.setFullScreen(!win.isFullScreen());
});
ipcMain.on('window:close', () => {
  if (!win || win.isDestroyed()) return;
  win.close();
});
ipcMain.handle('window:get-state', () =>
  win && !win.isDestroyed() ? getWindowState() : { maximized: false, fullScreen: false }
);

/* ---------------------------- dev utilities ---------------------------- */

/**
 * `executeJavaScript` on a hidden window can never resolve - Chromium stops
 * scheduling work for a hidden renderer - so every call gets a deadline and the
 * window is always restored before we exit.
 */
function js(source, { timeout = 5000, label = 'script' } = {}) {
  if (!win || win.isDestroyed()) return Promise.resolve({ __error: 'no window' });
  return Promise.race([
    win.webContents.executeJavaScript(source),
    new Promise((resolve) => setTimeout(() => resolve({ __error: `${label} timed out` }), timeout)),
  ]);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** `electron . --screenshot=<file>` - render, wait for fonts, save a PNG, exit. */
async function captureScreenshot(outPath) {
  try {
    // dismiss the welcome first, or the screenshot is a picture of a modal
    await js('window.__envReady === true', { label: 'ready', timeout: 30000 });
    await js(`(() => {
      const o = document.getElementById('overlay');
      if (!o || o.hidden) return false;
      const b = [...o.querySelectorAll('button')].find((x) => /default|skip/i.test(x.textContent));
      if (b) b.click();
      return true;
    })()`, { label: 'dismiss welcome' });
    await wait(1500);
    await js('document.fonts.ready.then(() => true)');
    await wait(900);

    // optional: navigate to a specific view before capturing
    if (shotViewArg) {
      const view = shotViewArg.slice('--screenshot-view='.length);
      if (view.startsWith('run::')) {
        // drive the already-booted app, with no reload: a reload throws away the
        // globals these hooks live on and lands back on the default view, which
        // is how the nav shots used to come out as five copies of one screen
        await js(view.slice('run::'.length), { label: 'shot setup' });
        await wait(1200);
      } else if (view.startsWith('env::')) {
        const snippet = view.slice('env::'.length);
        await js(snippet, { label: 'dev env flag' });
        await win.webContents.reload();
        await js('window.__envReady === true', { label: 'ready after reload', timeout: 30000 });
        await wait(900);
      } else {
        // fall back to clicking the nav item if onView isn't wired
        await js(`window.env.onView && window.env.onView('${view}')`, { label: 'navigate' }).catch(() => {});
        await js(`(() => {
          const btn = [...document.querySelectorAll('.navitem')].find((b) => b.textContent.trim().toLowerCase() === '${view}');
          if (btn) btn.click();
          return true;
        })()`, { label: 'click nav' });
        await wait(900);
      }
      if (view === 'new-server') {
        await js(`document.querySelector('button.serverpick__new')?.click() || null`, { label: 'open new server form' });
        await wait(900);
      }
    }

    const image = await win.webContents.capturePage();
    fs.writeFileSync(outPath, image.toPNG());
    const { width, height } = image.getSize();
    console.log(`SCREENSHOT ${outPath} (${width}x${height})`);
  } catch (err) {
    console.error('SCREENSHOT FAILED: ' + err.message);
    process.exitCode = 1;
  }
  hardExit(process.exitCode || 0);
}

/**
 * `npm run smoke` - boot the real app, dump what actually rendered, then exit.
 *
 * Nothing here needs the network: every view has to survive on an empty machine
 * with no Paper versions cached, which is the state a first run is in.
 */
async function runSmokeTest() {
  const watchdog = setTimeout(() => {
    console.error('SMOKE FAILED: watchdog - the run exceeded 150s');
    hardExit(1);
  }, 150_000);
  watchdog.unref?.();

  // wait for the renderer to finish booting rather than guessing a delay
  const deadline = Date.now() + 60_000;
  for (;;) {
    const ready = await js('Boolean(window.__envReady)', { label: 'ready?', timeout: 3000 });
    if (ready === true) break;
    if (typeof ready === 'object' && ready.__error) break;
    if (Date.now() > deadline) {
      console.error('SMOKE FAILED: the renderer never finished booting');
      hardExit(1);
    }
    await wait(250);
  }

  const bootError = await js('window.__envError || null', { label: 'boot error' });
  if (bootError && bootError !== 'null') {
    console.error(`SMOKE FAILED: renderer reported "${bootError}" while booting`);
    process.exitCode = 1;
  }

  await js('document.fonts.ready.then(() => true)', { label: 'fonts' });
  await wait(700);

  // A first run lands on the welcome modal, which is waiting for a click. Dismiss
  // it the way a person would, or everything after this is testing a screen that
  // is deliberately covered up - and the boot chain never finishes, so the version
  // list is never fetched and half the views render empty.
  const dismissed = await js(`(() => {
    const overlay = document.getElementById('overlay');
    if (!overlay || overlay.hidden) return 'no welcome';
    const buttons = [...overlay.querySelectorAll('button')];
    if (!buttons.length) return 'no dismiss button';
    // the safe option is whichever button does not ask for a folder picker
    const safe =
      buttons.find((b) => /default|use the default|skip/i.test(b.textContent)) ||
      buttons[buttons.length - 2] ||
      buttons[0];
    safe.click();
    return 'clicked: ' + safe.textContent.trim().slice(0, 40);
  })()`, { label: 'dismiss welcome' });
  await wait(1200);

  // the boot chain is still settling after the modal closes: wait for it to finish
  // rather than assuming a fixed delay covers it
  for (let i = 0; i < 60; i++) {
    const busy = await js('Boolean(document.querySelector(".overlay__box"))', { label: 'still open?', timeout: 2000 });
    if (busy !== true) break;
    await wait(250);
  }
  await wait(800);

  try {
    const report = await js(`(() => {
      const vis = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return 'MISSING';
        const r = el.getBoundingClientRect();
        return el.hidden ? 'attr-hidden' : r.width > 0 && r.height > 0 ? 'visible' : 'zero-size';
      };
      return {
        title: document.title,
        app: vis('#root-app'),
        welcome: vis('#overlay'),
        // the app ships no webfonts, so this checks the one thing that can still
        // go wrong: the system stack resolving to something with no glyphs
        fontLoaded: document.fonts.check('10px "Noto Sans"') || document.fonts.check('10px "Segoe UI"'),
        navItems: document.querySelectorAll('#sidebar .navitem').length,
        bodyNodes: document.querySelectorAll('#content-body *').length,
        text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 600),
      };
    })()`);

    // the IPC surface has to answer, not just exist
    report.bridge = await js(`(async () => {
      const out = {};
      try {
        const s = await window.env.settings.read();
        out.settings = s.ok === undefined ? 'answered' : s.ok;
        out.servers = (await window.env.servers.list()).servers.length;
        out.totalMemoryMb = s.settings && s.settings.totalMemoryMb;
        const plan = await window.env.java.plan();
        out.runtimes = plan.runtimes.length;
        out.plan = plan.plan.length;
        out.paperVersions = (await window.env.paper.versions(false)).versions.length;
      } catch (err) {
        out.threw = String(err && err.message || err);
      }
      return out;
    })()`, { label: 'bridge', timeout: 60000 });

    // A fresh install has no servers, so half the views would only ever exercise
    // their "no server selected" branch. Create one, reload so the app picks it up
    // the same way a restart would, and then check every view with real content.
    report.fixture = await js(`(async () => {
      const made = await window.env.servers.create({
        name: 'Smoke Test',
        mcVersion: '1.21.4',
        memory: { min: 512, max: 1024 },
      });
      if (!made || !made.ok) return { created: false, error: made && made.error };
      // clear the flag first: it is still true from the first boot, so a waiter
      // would see it immediately and carry on testing the pre-reload state
      window.__envReady = false;
      window.__bootCount = (window.__bootCount || 0) + 1;
      const want = window.__bootCount;
      window.env.window.reload();
      return { created: true, id: made.server.id, want };
    })()`, { label: 'fixture' });

    // wait for the renderer to actually come back up
    const secondBoot = Date.now() + 40_000;
    for (;;) {
      const ready = await js('Boolean(window.__envReady)', { label: 'rebooted?', timeout: 3000 });
      if (ready === true) break;
      if (Date.now() > secondBoot) {
        report.fixture.rebootTimedOut = true;
        break;
      }
      await wait(250);
    }
    await wait(900);
    report.fixture.afterReboot = await js(
      '({ servers: window.__envServers, active: window.__envActive })',
      { label: 'state after reboot' }
    );

    // every view has to render, including with no server created yet
    report.views = await js(`(async () => {
      const views = [
        ['dashboard', './js/views/dashboard.js', 'renderDashboard'],
        ['versions', './js/views/versions.js', 'renderVersions'],
        ['console', './js/views/console.js', 'renderConsole'],
        ['config', './js/views/config.js', 'renderConfig'],
        ['plugins', './js/views/plugins.js', 'renderPlugins'],
        ['settings', './js/views/settings.js', 'renderSettings'],
      ];
      const out = {};
      for (const [name, mod, fn] of views) {
        try {
          const m = await import(mod);
          if (typeof m[fn] !== 'function') throw new Error('no export ' + fn);
          const host = document.createElement('div');
          m[fn](host);
          out[name] = host.querySelectorAll('*').length + ' nodes';
        } catch (err) {
          out[name] = 'THREW: ' + (err && err.message || err);
        }
      }
      return out;
    })()`);

    // is anything invisible sitting on top of the UI?
    report.clickable = await js(`(() => {
      const problems = {};
      const ok = [];
      const painted = (el) => {
        if (typeof el.checkVisibility !== 'function') {
          return el.hidden && el.getBoundingClientRect().width === 0 ? false : true;
        }
        return el.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true });
      };
      const check = (sel, expect) => {
        const el = document.querySelector(sel);
        if (!el) return problems[sel] = 'MISSING from the DOM';
        const on = painted(el);
        if (!expect) {
          if (on) return problems[sel] = 'should be hidden but is painted';
          return void ok.push(sel + ' hidden ok');
        }
        if (!on) return problems[sel] = 'visible in the DOM but not painted';
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return problems[sel] = 'zero size';
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!hit) return problems[sel] = 'nothing at its centre';
        if (hit === el || el.contains(hit)) return void ok.push(sel + ' clickable ok');
        return problems[sel] = 'covered by ' + (hit.id ? '#' + hit.id : hit.className || hit.tagName);
      };

      // anything painted over the app, reported with enough detail to act on
      const strays = [...document.querySelectorAll('body > *')]
        .filter((el) => el.id !== 'root-app' && el.id !== 'toasts' && el.id !== 'titlebar')
        .filter((el) => {
          const s = getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })
        .map((el) => '#' + (el.id || el.className || el.tagName));

      check('#overlay', false);
      check('[data-wc="minimize"]', true);
      check('[data-wc="maximize"]', true);
      check('[data-wc="close"]', true);
      check('.navitem', true);

      const host = document.getElementById('toasts');
      if (!host) problems['#toasts'] = 'MISSING from the DOM';
      else if (getComputedStyle(host).pointerEvents !== 'none') {
        problems['#toasts'] = 'pointer-events must be none or it blocks clicks';
      } else ok.push('#toasts click-through ok');

      return { ok: Object.keys(problems).length === 0, problems, passing: ok, strays };
    })()`);

    // JUNK TEXT: a rendered "null", "undefined" or "NaN" is invisible to a DOM
    // node count but glaringly obvious to a person, and it has a real cause -
    // native `replaceChildren(null)` stringifies null instead of ignoring it,
    // whereas the `append()` helper skips it.
    //
    // Checked twice on purpose: with a server present the header has action
    // buttons, so the bug is invisible. It only appears on a first run, where the
    // dashboard has no actions and the conditional renders nothing at all.
    const JUNK_PROBE = `(() => {
      const BAD = /^(null|undefined|NaN|\\[object Object\\])$/;
      const hits = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const raw = n.textContent.trim();
        if (!raw || raw.length > 20) continue;
        if (!BAD.test(raw)) continue;
        const el = n.parentElement;
        if (!el || !el.offsetParent) continue;
        const sel = el.id ? '#' + el.id : (el.className || el.tagName);
        hits.push({ text: raw, in: String(sel).slice(0, 60) });
      }
      return [...new Map(hits.map((h) => [h.in + '|' + h.text, h])).values()];
    })()`;

    // the no-server state, before any fixture exists
    report.junkTextEmpty = await js(JUNK_PROBE, { label: 'junk probe (no server)' });
    report.junkText = [];

    // drive every nav item the way a click would
    report.nav = await js(`(async () => {
      const labels = [...document.querySelectorAll('#sidebar .navitem span')]
        .map((s) => s.textContent.trim());
      const out = [];
      for (const label of labels) {
        // re-query every time: renderSidebar() replaces the whole nav, so an
        // element captured before a click is detached afterwards and would
        // always report itself inactive
        const item = [...document.querySelectorAll('#sidebar .navitem')]
          .find((el) => el.textContent.includes(label));
        if (!item) {
          out.push({ label, missing: true });
          continue;
        }
        item.click();
        await new Promise((r) => setTimeout(r, 180));
        const now = [...document.querySelectorAll('#sidebar .navitem')]
          .find((el) => el.textContent.includes(label));
        out.push({
          label,
          active: Boolean(now && now.classList.contains('is-active')),
          nodes: document.querySelectorAll('#content-body *').length,
          consolePainted: Boolean(document.querySelector('.term')),
        });
      }
      return out;
    })()`);

    report.rendererErrors = smokeErrors;
    report.welcome = dismissed;
    console.log('SMOKE ' + JSON.stringify(report, null, 2));

    if (smokeErrors.length) {
      console.error(`SMOKE FAILED: ${smokeErrors.length} renderer error(s)`);
      process.exitCode = 1;
    }
    if (report.app !== 'visible') {
      console.error('SMOKE FAILED: the shell did not render');
      process.exitCode = 1;
    }
    for (const [name, result] of Object.entries(report.views || {})) {
      if (typeof result === 'string' && result.startsWith('THREW')) {
        console.error(`SMOKE FAILED: view ${name} -> ${result}`);
        process.exitCode = 1;
      }
    }
    if (report.bridge?.threw) {
      console.error('SMOKE FAILED: bridge -> ' + report.bridge.threw);
      process.exitCode = 1;
    }
    for (const [name, problem] of Object.entries(report.clickable.problems || {})) {
      console.error(`SMOKE FAILED: ${name} - ${problem}`);
      process.exitCode = 1;
    }
    for (const stray of report.clickable.strays || []) {
      console.error(`SMOKE FAILED: ${stray} is painted over the app`);
      process.exitCode = 1;
    }
    for (const junk of [...(report.junkTextEmpty || []), ...(report.junkText || [])]) {
      console.error(`SMOKE FAILED: rendered junk text ${JSON.stringify(junk.text)} inside ${junk.in}`);
      process.exitCode = 1;
    }
    for (const item of report.nav || []) {
      if (item.missing) {
        console.error(`SMOKE FAILED: nav "${item.label}" vanished from the sidebar`);
        process.exitCode = 1;
        continue;
      }
      if (!item.active) {
        console.error(`SMOKE FAILED: nav "${item.label}" did not become active after the click`);
        process.exitCode = 1;
      }
      if (item.nodes < 5) {
        console.error(`SMOKE FAILED: nav "${item.label}" rendered only ${item.nodes} nodes`);
        process.exitCode = 1;
      }
    }

    // the console is the one view whose DOM the smoke test looks at directly
    const consoleRow = (report.nav || []).find((n) => n.label === 'Console');
    if (consoleRow && !consoleRow.consolePainted) {
      console.error('SMOKE FAILED: the console view painted no terminal');
      process.exitCode = 1;
    }

    if (report.fixture && report.fixture.created === false) {
      console.error(`SMOKE FAILED: could not create the test server - ${report.fixture.error}`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('SMOKE FAILED: ' + err.message);
    process.exitCode = 1;
  }
  hardExit(process.exitCode || 0);
}

/**
 * Leave, for real.
 *
 * `app.exit()` alone is not enough: a tray icon, or a lingering renderer or GPU
 * process, can keep the tree alive - which leaves EnvServer.exe running after a
 * smoke test and locks release/, so the next build fails with "Access is denied"
 * on d3dcompiler_47.dll. Destroy what we own, then exit hard, with a backstop in
 * case even that is not enough.
 */
function hardExit(code = 0) {
  try {
    tray?.destroy();
  } catch {
    /* already gone */
  }
  tray = null;
  try {
    if (win && !win.isDestroyed()) win.destroy();
  } catch {
    /* already gone */
  }

  app.exit(code);

  // if Electron has not gone within a couple of seconds, stop waiting for it
  const backstop = setTimeout(() => process.exit(code), 2000);
  backstop.unref?.();
}

/* ------------------------------- tray ---------------------------------- */

/**
 * System tray.
 *
 * The point is that closing the window must not throw away work. A Paper jar is
 * 50 MB and a JDK is 200 MB; if clicking X cancelled those, the app would be
 * unusable for its main job. So while something is in flight the X hides the
 * window and the tray keeps everything alive.
 *
 * @type {Electron.Tray|null}
 */
let tray = null;

/** Would hiding be wrong right now? Only a real quit is always safe. */
function shouldHideToTray() {
  return store.read().trayOnClose !== false;
}

function buildTray() {
  if (tray) return tray;

  // A tray is a reason for Windows to keep the process alive, which is exactly
  // what must not happen under the smoke test: it leaves EnvServer.exe copies
  // running that lock release/ and break the next build.
  if (isSmoke || process.env.ENVSERVER_NO_TRAY === '1') return null;

  const iconPath = path.join(__dirname, '..', 'renderer', 'assets', 'icon-256.png');
  tray = new Tray(iconPath);

  const refresh = () => {
    const jobs = ipc.activeJobCount();
    const running = server.runningIds().length;
    const bits = [];
    if (jobs) bits.push(`${jobs} download${jobs === 1 ? '' : 's'} in progress`);
    if (running) bits.push(`${running} server${running === 1 ? '' : 's'} running`);
    if (!bits.length) bits.push('Nothing running');

    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open EnvServer', click: showWindow },
        { type: 'separator' },
        { label: bits.join(' - '), enabled: false },
        { type: 'separator' },
        { label: 'Quit EnvServer', click: () => { quitting = true; app.quit(); } },
      ])
    );
    tray.setToolTip(bits.join(' - '));
  };

  tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Open EnvServer', click: showWindow }]));
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);

  // the menu text has to follow reality, so rebuild it whenever either changes
  server.bus.on('status', refresh);
  server.bus.on('exit', refresh);
  ipc.onJobChange(refresh);

  return tray;
}

function showWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

/* ------------------------------ lifecycle ------------------------------ */

app.whenReady().then(() => {
  const userData = app.getPath('userData');
  store.init(userData);
  paths.init(userData);
  paths.setServersRoot(store.read().serversDir || '');

  // without this Windows puts the app in its own taskbar group with a generic icon
  app.setAppUserModelId('com.envserver.app');

  ipc.register();
  ipc.startEvents();

  // remember that this build ran here. It is what makes "go back to a version
  // that used to work" possible: the releases list only knows what is published
  // now, and the version that broke something is usually the one you just
  // replaced, not the one you are on
  updater.recordInstalled(app.getVersion());

  buildTray();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/**
 * A server that is still up when the window closes is a JVM holding a pipe to a
 * renderer that no longer exists. Give the clean `stop` a bounded window, then
 * force the rest, so quitting can never hang.
 */
let quitting = false;
app.on('before-quit', (event) => {
  if (quitting) return;
  if (!server.runningIds().length) return;

  event.preventDefault();
  quitting = true;
  console.log(`[main] stopping ${server.runningIds().length} server(s) before quitting`);

  const guard = setTimeout(() => {
    server.stopAll({ force: true });
    app.quit();
  }, 25_000);
  guard.unref?.();

  ipc.shutdown().finally(() => {
    clearTimeout(guard);
    server.stopAll({ force: true });
    app.quit();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});