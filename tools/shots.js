'use strict';

/**
 * Capture the README screenshots into `docs/screenshots/`.
 *
 *   npm run docs
 *
 * One Electron boot per shot, because each capture needs the welcome overlay
 * gone and a specific view mounted, and the app deliberately exits after a
 * screenshot rather than sitting there. That costs a boot each time, which is
 * why this is a script and not a loop inside the app: a crash in one shot then
 * only loses one picture instead of the whole set.
 *
 * `--only=<name>` re-captures a single one while editing.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');

/**
 * `view` is the nav item to click, or an `env::` snippet for a shot that needs
 * state set up before the capture. `size` is the window size, because a couple
 * of these read better cropped to the panel they are about.
 */
const SHOTS = [
  { name: 'welcome', view: null, size: '1240x820' },
  { name: 'dashboard', view: 'dashboard', size: '1240x820' },
  { name: 'new-server', view: 'new-server', size: '1240x820' },
  { name: 'console', view: 'console', size: '1240x820' },
  { name: 'config', view: 'config', size: '1240x820' },
  { name: 'versions', view: 'versions', size: '1240x820' },
  { name: 'plugins', view: 'plugins', size: '1240x820' },
  { name: 'settings', view: 'settings', size: '1240x820' },
];

/**
 * Navigate by calling the router directly.
 *
 * Clicking the sidebar was tried first and is not dependable for a capture: the
 * nav item's text carries a live count when a job or a player is present, so a
 * text match misses, and the Plugins tab does not exist at all for vanilla. This
 * goes through the same `setView` the click handler does, so the shot shows what
 * a person clicking there would see.
 */
function navigateTo(view) {
  if (!view) return '';
  if (view === 'new-server') {
    return `run::(() => {
      window.__envSetView('dashboard');
      document.querySelector('button.serverpick__new')?.click();
    })()`;
  }
  return `run::window.__envSetView('${view}')`;
}

const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice('--only='.length);
const list = only ? SHOTS.filter((s) => s.name === only) : SHOTS;

if (!list.length) {
  console.error(`no shot named "${only}". known: ${SHOTS.map((s) => s.name).join(', ')}`);
  process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });

const electron = require(path.join(ROOT, 'node_modules', 'electron'));
const failed = [];

for (const shot of list) {
  const file = path.join(OUT, `${shot.name}.png`);
  console.log(`\n--- ${shot.name} -> ${path.relative(ROOT, file)}`);

  const args = [
    ROOT,
    `--screenshot=${file}`,
    `--screenshot-size=${shot.size}`,
    navigateTo(shot.view) ? `--screenshot-view=${navigateTo(shot.view)}` : '',
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
    const why = (out.split(/\r?\n/).filter((l) => l && !/cache_util_win|disk_cache|gpu_disk|Autofill/.test(l)).pop() || '').trim();
    console.error(`  FAILED (${why || r.error?.message || 'no output'})`);
    failed.push(shot.name);
  }
}

console.log(failed.length ? `\n${failed.length} failed: ${failed.join(', ')}` : `\nall ${list.length} captured`);
process.exit(failed.length ? 1 : 0);