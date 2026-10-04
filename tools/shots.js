'use strict';

/**
 * Capture the README screenshots into `docs/screenshots/`.
 *
 *   npm run docs
 *   npm run docs -- --only=console
 *
 * Two decisions worth knowing about, because both were wrong the first time:
 *
 * **Every shot is cropped to the thing it documents.** A full-window screenshot
 * of the console view is 90% sidebar and empty space; a reader looking at it
 * learns nothing about the console. `region` names the element to capture and the
 * capture is clipped to it.
 *
 * **Navigation goes through `setView`, not a click on the sidebar.** The nav
 * item's text carries a live count when a job or a player is present, so a text
 * match misses, and the Plugins tab does not exist at all for vanilla. Five of
 * the shots used to come out byte-identical because the click silently did
 * nothing.
 *
 * `--only=<name>` re-captures a single shot while editing.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');

/**
 * Captures run against a throwaway Electron profile, not the real one.
 *
 * Two reasons, and the second is the important one. The real profile has the
 * user's own servers in it, so the screenshots would show their worlds and their
 * names; and capturing needs to *make* a server (the dashboard, console, config,
 * versions and plugins views all render a "no server selected" placeholder
 * without one), which would leave junk in the install they actually use.
 * `--user-data-dir` is Electron's own switch, so this needs no app-side support.
 */
const PROFILE = path.join(ROOT, 'tmp', 'docs-profile');

/**
 * `setup` runs in the live renderer before the capture. `region` is a CSS
 * selector for the element to crop to; leave it out for the whole window.
 * `server: true` means the view is useless without a server selected.
 */
const SHOTS = [
  {
    name: 'welcome',
    // the first-run modal. It only appears on a fresh install, so it is opened
    // explicitly rather than hoped for - otherwise a capture on an already
    // set-up profile silently falls through to the ordinary dashboard.
    region: '.welcome__card',
    pad: 24,
    setup: `const { welcomeBox } = await import('./js/ui/overlay.js');
      welcomeBox();`,
  },
  {
    name: 'terms',
    // the screen that must be accepted before the app does anything
    region: '#content-body',
    pad: 0,
    setup: `const { state } = await import('./js/state.js');
      state.settings.termsAccepted = false;
      window.__envSetView('about');`,
  },
  {
    name: 'dashboard',
    server: true,
    region: '.dash',
    pad: 8,
    setup: "window.__envSetView('dashboard');",
  },
  {
    name: 'new-server',
    region: '.createcard',
    pad: 12,
    setup: `window.__envSetView('home');
      await new Promise((r) => setTimeout(r, 500));
      document.querySelector('button.serverpick__new')?.click();`,
  },
  {
    name: 'console',
    server: true,
    region: '.console-pane',
    pad: 8,
    setup: "window.__envSetView('console');",
  },
  {
    name: 'config',
    server: true,
    region: '#content-body',
    pad: 0,
    setup: "window.__envSetView('config');",
  },
  {
    name: 'versions',
    server: true,
    region: '#content-body',
    pad: 0,
    setup: "window.__envSetView('versions');",
  },
  {
    name: 'plugins',
    server: true,
    region: '#content-body',
    pad: 0,
    setup: "window.__envSetView('plugins');",
  },
  {
    name: 'settings',
    region: '.settings',
    pad: 8,
    setup: "window.__envSetView('settings');",
  },
  {
    name: 'memory',
    // just the memory panel: it is where the heap-vs-working-set explanation
    // lives, and it is small enough that cropping keeps it readable
    region: '.panel--memory',
    pad: 12,
    setup: "window.__envSetView('settings');",
  },
];

/**
 * The terms gate blocks every view until it is accepted, so every shot but the
 * terms one agrees first - the same way a person would, and against a throwaway
 * profile, so the real settings file is never touched.
 *
 * A server is created when there is none. The five server-scoped views render a
 * "no server selected" placeholder without one, and a screenshot of a
 * placeholder documents nothing; the nav guard also bounces the view away, which
 * is why cropping them used to find nothing at all.
 *
 * The *order* below is the whole ballgame, and getting it wrong is why every shot
 * used to come back as a picture of the Terms screen:
 *
 *   1. wait for boot to finish, because `state.init()` reads the settings file
 *      after the window opens and overwrites anything seeded earlier
 *   2. click Agree, which is what a person does and the only thing that persists
 *   3. create a server if there is none
 *   4. only then run the shot's own setup
 *
 * Setting `state.settings.termsAccepted = true` at step 0 looks equivalent and is
 * not: the store re-read lands afterwards and puts it back to false, so the
 * capture lands on Terms while the setup code cheerfully sets a view that cannot
 * be rendered.
 */
function snippetFor(shot) {
  return `run::(async () => {
    // 1. boot has to finish before the store has read the settings file
    const m = await import('./js/state.js');
    for (let i = 0; i < 60; i++) {
      if (m.state.ready) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    await new Promise((r) => setTimeout(r, 600));

    // 2. agree the way a person would, which is also the only way it persists
    if (document.querySelector('.terms')) {
      const agree = [...document.querySelectorAll('button')].find((b) => /agree/i.test(b.textContent));
      if (!agree) throw new Error('the Terms screen is up but there is no Agree button on it');
      agree.click();
      await new Promise((r) => setTimeout(r, 900));
    }
    if (document.querySelector('.terms')) throw new Error('Agree did not dismiss the Terms screen');

    // 3. a server, so the five server-scoped views have something to render
    if (!m.state.servers.length) {
      const made = await window.env.servers.create({
        name: 'ENV#1',
        type: 'paper',
        mcVersion: '1.21.4',
        memory: { min: 1024, max: 2048 }
      });
      const server = made && (made.server || made);
      if (!made || made.ok === false || !server || !server.id) {
        throw new Error('could not create the demo server: ' + JSON.stringify(made));
      }
      await window.__envRefreshServers();
    }
    if (m.state.servers[0]) await window.__envOpenServer(m.state.servers[0].id);
    await new Promise((r) => setTimeout(r, 500));

    // 4. the shot's own setup, on a renderer that is finally past the gate
    ${shot.setup}
  })()`;
}

const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice('--only='.length);
const list = only ? SHOTS.filter((s) => s.name === only) : SHOTS;

if (!list.length) {
  console.error(`no shot named "${only}". known: ${SHOTS.map((s) => s.name).join(', ')}`);
  process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(PROFILE, { recursive: true });

const electron = require(path.join(ROOT, 'node_modules', 'electron'));
const failed = [];

for (const shot of list) {
  const file = path.join(OUT, `${shot.name}.png`);
  console.log(`\n--- ${shot.name} -> ${path.relative(ROOT, file)}${shot.region ? ` [${shot.region}]` : ''}`);

  const args = [
    ROOT,
    `--user-data-dir=${PROFILE}`,
    `--screenshot=${file}`,
    '--screenshot-size=1240x820',
    // the flag matters: main.js only reads a snippet out of `--screenshot-view=`,
    // so passing the snippet bare handed it an argument nobody looked at. Every
    // shot then captured whatever the app happened to be showing after boot -
    // which, on a fresh profile, is the Terms screen. Six of the ten crops matched
    // nothing and the other four were all the same screen.
    `--screenshot-view=${snippetFor(shot)}`,
    shot.region ? `--screenshot-region=${shot.region}` : '',
    shot.pad ? `--screenshot-pad=${shot.pad}` : '',
  ].filter(Boolean);

  // an orphan from the previous shot holds d3dcompiler_47.dll and the next one
  // then dies with "Access is denied", so make sure the port is clear first
  spawnSync('taskkill', ['/IM', 'electron.exe', '/F'], { windowsHide: true });

  const r = spawnSync(String(electron), args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180_000,
    windowsHide: true,
  });

  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const line = out.split(/\r?\n/).find((l) => l.startsWith('SCREENSHOT'));

  if (line && fs.existsSync(file) && fs.statSync(file).size > 4096) {
    console.log(`  ${line}`);
  } else {
    const noise = /cache_util_win|disk_cache|gpu_disk|Autofill|GPU state invalid/;
    const why = (out.split(/\r?\n/).filter((l) => l.trim() && !noise.test(l)).pop() || '').trim();
    console.error(`  FAILED (${why || r.error?.message || 'no output'})`);
    failed.push(shot.name);
  }
}

console.log(failed.length ? `\n${failed.length} failed: ${failed.join(', ')}` : `\nall ${list.length} captured`);
process.exit(failed.length ? 1 : 0);