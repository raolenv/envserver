'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const net = require('./net');
const paths = require('./paths');

/**
 * Version updates and going back to an older one.
 *
 * EnvServer has no installer logic of its own: a release is a plain NSIS Setup
 * on GitHub, so "update" means download that file and run it, and "go back"
 * means running the Setup of an older release. Neither touches the data folder,
 * which is the whole point - `paths.init()` puts servers, JDKs and settings
 * under `%APPDATA%\envserver\data`, never inside the install folder, so
 * replacing or rolling back the application cannot take a world with it.
 *
 * What this module deliberately does NOT do:
 *
 *   - silently download and install. A Minecraft server manager restarting its
 *     own UI without being asked is not something to surprise anybody with, so
 *     every install starts from a click and shows its progress.
 *   - patch in place. Rewriting `app.asar` under a running Electron is how you
 *     get a half-written program that only fails on the next launch.
 */

const REPO = process.env.ENVSERVER_REPO || 'raolenv/envserver';
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
const CACHE_NAME = 'releases.json';
/** Six hours: often enough to see a release the day it ships, rare enough not to hammer GitHub. */
const CACHE_TTL = 6 * 60 * 60 * 1000;

/* ------------------------------- versions -------------------------------- */

/** `1.2.3`, `v1.2.3`, `1.2`, `1` -> comparable numbers. Anything else -> null. */
function parseVersion(raw) {
  const m = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(raw || ''));
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2] || 0), patch: Number(m[3] || 0), text: `${Number(m[1])}.${Number(m[2] || 0)}.${Number(m[3] || 0)}` };
}

/** Negative when `a` is older than `b`. Unparseable versions sort last. */
function compare(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;
  return pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch;
}

/* ------------------------------- history --------------------------------- */

/**
 * Which versions have been run on this machine.
 *
 * This is what makes "go back" possible without shipping anything: the app
 * writes its own version here on every launch, so the panel can offer to
 * reinstall a build that used to run here even if it is long gone from the
 * releases list.
 */
function historyFile() {
  return path.join(paths.base(), 'installed.json');
}

function readHistory() {
  try {
    const raw = JSON.parse(fs.readFileSync(historyFile(), 'utf8'));
    const entries = Array.isArray(raw?.entries) ? raw.entries : [];
    return entries
      .filter((e) => e && parseVersion(e.version))
      .map((e) => ({ version: parseVersion(e.version).text, firstSeen: Number(e.firstSeen) || 0, lastSeen: Number(e.lastSeen) || 0 }))
      .sort((a, b) => compare(b.version, a.version));
  } catch {
    return [];
  }
}

function writeHistory(entries) {
  try {
    fs.mkdirSync(path.dirname(historyFile()), { recursive: true });
    fs.writeFileSync(historyFile(), JSON.stringify({ entries }, null, 2));
  } catch {
    /* the history is a convenience, never a reason to fail a launch */
  }
}

/** Note that `version` is running here. Called once per launch. */
function recordInstalled(version) {
  const v = parseVersion(version);
  if (!v) return readHistory();
  const entries = readHistory();
  const found = entries.find((e) => e.version === v.text);
  if (found) {
    if (found.lastSeen === Date.now()) return entries;
    found.lastSeen = Date.now();
  } else {
    entries.unshift({ version: v.text, firstSeen: Date.now(), lastSeen: Date.now() });
  }
  writeHistory(entries);
  return entries;
}

/* ------------------------------- releases -------------------------------- */

function assetFor(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  // the NSIS installer is the one that can replace an existing install; the
  // portable build extracts to a temp folder and would leave two copies of the app
  const setup = assets.find((a) => /-Setup(\.\w+)?\.exe$/i.test(a.name || ''));
  return setup || assets.find((a) => /\.exe$/i.test(a.name || '')) || null;
}

function toRelease(raw) {
  const v = parseVersion(raw?.tag_name || raw?.name);
  if (!v) return null;
  const asset = assetFor(raw);
  return {
    version: v.text,
    tag: raw.tag_name || `v${v.text}`,
    notes: typeof raw.body === 'string' ? raw.body.trim().slice(0, 4000) : '',
    published: Number(raw.published_at) || 0,
    prerelease: Boolean(raw.prerelease),
    draft: Boolean(raw.draft),
    url: raw.html_url || '',
    asset: asset ? { name: asset.name, url: asset.browser_download_url, size: Number(asset.size) || 0 } : null,
  };
}

/** The release list, from cache when it is fresh enough. */
async function list({ force = false } = {}) {
  const cachePath = paths.cacheFile(CACHE_NAME);
  let cached = null;
  try {
    cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch {
    /* no cache, or a truncated one from a killed process */
  }

  const fresh = cached && !force && Date.now() - Number(cached.at || 0) < CACHE_TTL;
  if (fresh) return cached.releases;

  const raw = await net.getJson(RELEASES_URL, { timeout: 15000, retries: 2 });
  const releases = (Array.isArray(raw) ? raw : [])
    .map(toRelease)
    .filter((r) => r && !r.draft && r.asset)
    .sort((a, b) => compare(b.version, a.version));

  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ at: Date.now(), releases }));
  } catch {
    /* a cache that cannot be written just means the next launch refetches */
  }
  return releases;
}

/* -------------------------------- report --------------------------------- */

/**
 * Everything the update panel needs, in one object.
 *
 * `previous` merges two sources on purpose: releases published on GitHub that
 * are older than what is running, plus versions this machine has run before but
 * that are no longer published. The second group is what a rollback usually
 * needs, and it cannot come from GitHub.
 */
async function report(currentVersion, { force = false } = {}) {
  const current = parseVersion(currentVersion)?.text || '0.0.0';
  const history = readHistory();

  let releases = [];
  let online = false;
  let error = '';
  try {
    releases = await list({ force });
    online = true;
  } catch (err) {
    error = err?.message || String(err);
  }

  const publishedOlder = releases.filter((r) => compare(r.version, current) < 0);
  const knownOlder = history.filter((h) => compare(h.version, current) < 0);
  const seen = new Set(publishedOlder.map((r) => r.version));
  const previous = [...knownOlder.map((h) => ({ ...h, source: 'local', asset: null })), ...publishedOlder.map((r) => ({ ...r, source: 'github' }))]
    .filter((p, i, all) => all.findIndex((x) => x.version === p.version) === i)
    .sort((a, b) => compare(b.version, a.version));

  const latest = releases.find((r) => compare(r.version, current) > 0) || null;

  return {
    ok: true,
    current,
    latest,
    previous,
    updateAvailable: Boolean(latest),
    online,
    error,
    checkedAt: Date.now(),
    // shown in the panel so the "will my servers survive this" question has a
    // concrete answer instead of a reassurance
    dataDir: paths.base(),
  };
}

/* -------------------------------- install -------------------------------- */

function installerPath(version) {
  return path.join(paths.tmpDir(), `EnvServer-${paths.segment(version)}-Setup.exe`);
}

/**
 * Download the installer for `version` and run it.
 *
 * @param {string} version
 * @param {object} opts
 * @param {(p:{received:number,total:number,label:string})=>void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 * @param {()=>void} opts.quit  called once the installer is running
 */
async function install(version, { onProgress, signal, quit } = {}) {
  const wanted = parseVersion(version);
  if (!wanted) throw new Error(`"${version}" is not a version number`);

  const releases = await list();
  const release = releases.find((r) => r.version === wanted.text);
  if (!release || !release.asset) throw new Error(`EnvServer ${wanted.text} is not published on GitHub`);

  const dest = installerPath(wanted.text);
  onProgress?.({ received: 0, total: release.asset.size || 0, label: `EnvServer ${wanted.text}` });

  const res = await net.download(release.asset.url, dest, {
    expectedSize: release.asset.size || null,
    signal,
    onProgress: (p) => onProgress?.({ received: p.received, total: p.total, label: `EnvServer ${wanted.text}` }),
  });

  // A truncated installer is worse than none: NSIS would fail halfway through
  // having already closed the old install.
  if (res.size < 1_000_000) throw new Error('the downloaded installer is too small to be valid');

  // NSIS with oneClick:false still accepts /S, and /D has to be last and unquoted
  const child = spawn(dest, ['/S'], { detached: true, stdio: 'ignore' });
  child.unref();

  // give the installer a moment to grab its lock on the old files before the
  // running instance lets go of them
  setTimeout(() => quit?.(), 1200);

  return { ok: true, version: wanted.text, size: res.size, path: dest };
}

/** Open the releases page, for a version this machine cannot install itself. */
function releasesPage() {
  return `https://github.com/${REPO}/releases`;
}

module.exports = {
  REPO,
  parseVersion,
  compare,
  report,
  list,
  recordInstalled,
  readHistory,
  install,
  installerPath,
  releasesPage,
};