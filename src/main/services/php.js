'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

/**
 * PHP, for PocketMine-MP.
 *
 * PocketMine is a PHP project, not a Java one, so it needs its own runtime and
 * its own detection - but unlike Java there is nothing sensible for EnvServer to
 * download. PHP for Windows is not a single redistributable binary: it is either
 * the project's own Windows build, a third-party build, or a package from
 * chocolatey/scoop, and the licence travels with each of them. Guessing wrong
 * here would mean shipping somebody else's build under their name.
 *
 * So EnvServer finds an existing PHP, reports exactly what it found and how it
 * compares to what PocketMine needs, and refuses to start with a message that
 * says what to do. That is the honest version of "supports PHP".
 *
 * PocketMine-MP 5 requires PHP 8.1 or newer; 4.x needs 7.2+ and has no
 * 64-bit Windows build, which is why only 8.1+ is worth looking for here.
 */

/** The oldest PHP that can run PocketMine-MP 5. */
const MIN = { major: 8, minor: 1 };

/** How many `php -r` probes one detection is allowed to cost. */
const MAX_CANDIDATES = 16;

const PROBE_TIMEOUT = 8000;

/**
 * Every `php.exe` worth probing, most authoritative first.
 *
 * Mirrors java.js's ordering rule: an explicit setting beats an environment
 * variable, which beats a well-known install location, which beats a blind
 * directory scan. Guessing from the registry is deliberately absent - it is
 * slow and it is how you end up running a PHP you did not think you had.
 */
function* candidates(explicit = '') {
  const out = [];
  const offer = (p) => {
    const full = path.resolve(String(p || '').trim());
    if (full) out.push(full);
  };

  // a setting may name php.exe itself or the folder holding it
  if (explicit) {
    if (/php\.exe$/i.test(String(explicit))) offer(explicit);
    else offer(path.join(String(explicit), 'php.exe'));
  }

  for (const root of [process.env.PHP_PEAR, process.env.PHP_BIN, process.env.PHP_HOME].filter(Boolean)) {
    offer(path.join(root, 'php.exe'));
  }

  // where.exe, so an installed-but-unreferenced PHP is still found
  try {
    const out2 = require('child_process').execFileSync('where.exe', ['php.exe'], {
      windowsHide: true,
      timeout: PROBE_TIMEOUT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of String(out2).split(/\r?\n/)) offer(line);
  } catch {
    /* not on PATH, which is the common case on a machine with no PHP */
  }

  // the places people actually put it
  const fixed = [
    'C:\\php\\php.exe',
    'C:\\tools\\php\\php.exe',
    'C:\\xampp\\php\\php.exe',
    'C:\\laragon\\bin\\php',
    'C:\\Program Files\\PHP\\php.exe',
    'C:\\Program Files (x86)\\PHP\\php.exe',
    'C:\\ProgramData\\chocolatey\\bin\\php.exe',
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'php.exe'),
  ];
  for (const p of fixed) offer(p);

  // scoop keeps versioned directories under apps/php, with php.exe one level in
  const scoop = path.join(process.env.USERPROFILE || '', 'scoop', 'apps', 'php');
  let entries = [];
  try {
    entries = fs.readdirSync(scoop, { withFileTypes: true });
  } catch {
    /* scoop is not installed, which is the common case */
  }
  for (const entry of entries) {
    if (entry.isDirectory()) offer(path.join(scoop, entry.name, 'php.exe'));
  }

  // dedupe last: the same PHP is reachable by several routes (PATH, PHP_PEAR and
  // a well-known path all pointing at C:\php), and probing it twice wastes a
  // process launch on every detection
  const seen = new Set();
  for (const p of out) {
    if (seen.has(p)) continue;
    seen.add(p);
    yield p;
  }
}

/**
 * Ask one php.exe what it is.
 *
 * `PHP_MAJOR_VERSION`/`PHP_MINOR_VERSION` are printed by a one-liner rather than
 * scraped out of `php -v`, because the banner text is localised and its shape
 * changes between builds while the constants never do.
 *
 * @returns {Promise<{exe:string,major:number,minor:number,version:string}|null>}
 */
function probe(exe) {
  return new Promise((resolve) => {
    execFile(
      exe,
      ['-r', 'echo PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION.".".PHP_RELEASE_VERSION;'],
      { windowsHide: true, timeout: PROBE_TIMEOUT, maxBuffer: 64 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        const raw = String(stdout || '').trim();
        const m = /^(\d+)\.(\d+)\.(\d+)/.exec(raw);
        if (!m) return resolve(null);
        resolve({ exe, major: Number(m[1]), minor: Number(m[2]), version: raw });
      }
    );
  });
}

/** Is this PHP new enough for PocketMine? */
function compatible(found) {
  if (!found) return false;
  if (found.major > MIN.major) return true;
  return found.major === MIN.major && found.minor >= MIN.minor;
}

/** A PHP too old to run PocketMine is a different problem from no PHP at all. */
function explainMissing(found = null) {
  if (found && !compatible(found)) {
    return `PocketMine-MP needs PHP ${MIN.major}.${MIN.minor} or newer, and the PHP on this machine is ${found.version}. Install a newer PHP and point EnvServer at it in Settings.`;
  }
  return (
    `PocketMine-MP is written in PHP, and there is no PHP on this machine. Install PHP ${MIN.major}.${MIN.minor} or newer ` +
    '(php.org/downloads has Windows builds), then set its path in Settings. EnvServer does not install PHP for you - the Windows builds are not redistributable under one licence.'
  );
}

/**
 * Every usable PHP on this machine.
 *
 * Sorted best first: new enough before too old, then highest version. A machine
 * with several PHP installs should get the newest one, not whichever was
 * discovered first.
 *
 * @returns {Promise<Array<{exe:string,major:number,minor:number,version:string,ok:boolean}>>}
 */
async function listRuntimes({ phpPath = '' } = {}) {
  const found = [];
  let probes = 0;

  for (const candidate of candidates(phpPath)) {
    if (probes >= MAX_CANDIDATES) break;
    if (!/\.exe$/i.test(candidate)) continue;
    probes++;
    try {
      if (!fs.existsSync(candidate)) continue;
    } catch {
      continue;
    }
    const info = await probe(candidate);
    if (!info) continue;
    found.push({ ...info, ok: compatible(info) });
  }

  const seen = new Set();
  return found
    .filter((f) => (seen.has(f.exe) ? false : seen.add(f.exe)))
    .sort((a, b) => {
      if (a.ok !== b.ok) return a.ok ? -1 : 1;
      return b.major - a.major || b.minor - a.minor;
    });
}

/**
 * The PHP to run PocketMine with.
 *
 * A pin that resolves to something too old is still returned, with `ok: false`,
 * because "you have PHP 7.4 and it will not work" is more useful than "no PHP" -
 * but `start()` refuses on the flag rather than launching something that dies
 * with a PHP stack trace.
 *
 * @returns {Promise<{exe:string,major:number,minor:number,version:string,ok:boolean}|null>}
 */
async function resolveFor({ pinned = '' } = {}) {
  const runtimes = await listRuntimes({ phpPath: pinned });
  return runtimes[0] || null;
}

module.exports = {
  MIN,
  listRuntimes,
  resolveFor,
  compatible,
  explainMissing,
  probe,
  candidates,
};
