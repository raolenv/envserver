'use strict';

const fs = require('fs');
const path = require('path');

/**
 * On-disk layout.
 *
 *   <base>/servers/<id>/        one Paper server instance
 *     paper.jar                the server jar
 *     server.properties        written by vanilla, edited by the Config view
 *     eula.txt                 written by vanilla, edited by the Config view
 *     ops.json / whitelist.json / banned-*.json
 *     world/ plugins/ logs/ config/
 *   <base>/runtime/<major>/    JDKs EnvServer downloaded itself (Temurin)
 *   <base>/runtime-zips/       the downloaded archives, kept for re-extraction
 *   <base>/backups/<id>/       world backups
 *   <base>/tmp/                scratch space for partial downloads
 *   <base>/cache/              Paper API responses, so the app opens offline
 */

const DEFAULT_BASE = path.join(process.env.APPDATA || process.env.HOME || '.', '.envserver');

let base = DEFAULT_BASE;
/** set from settings so users can park big worlds on another drive */
let serversRoot = '';

function init(userDataDir) {
  base = path.join(userDataDir, 'data');
  for (const dir of [base, cacheDir(), runtimeDir(), runtimeZipsDir(), tmpDir(), backupsRootDir()]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return base;
}

function setServersRoot(dir) {
  serversRoot = dir ? path.resolve(dir) : '';
  if (serversRoot) fs.mkdirSync(serversRoot, { recursive: true });
  return serversRoot;
}

const serversRootDir = () => serversRoot || path.join(base, 'servers');
const runtimeDir = () => path.join(base, 'runtime');
const runtimeZipsDir = () => path.join(base, 'runtime-zips');
const backupsRootDir = () => path.join(base, 'backups');
const tmpDir = () => path.join(base, 'tmp');
const cacheDir = () => path.join(base, 'cache');

/**
 * Reject anything that could climb out of, or be silently rewritten inside, the
 * directory it gets joined onto.
 *
 * Applied to every externally-derived path segment. Callers already sanitise
 * their inputs, so a failure here means something unexpected got through and is
 * worth a loud error rather than a quietly mangled folder name.
 */
function segment(name) {
  const s = String(name ?? '').trim();
  if (!s) throw new Error('invalid path segment');
  // "." and ".." are the traversal primitives; separators and NUL would split
  // the segment; the rest are characters Windows refuses in a filename
  if (s === '.' || s === '..') throw new Error(`invalid path segment "${s}"`);
  if (/[\\/\x00]/.test(s)) throw new Error(`invalid path segment "${s}"`);
  if (/[<>:"|?*]/.test(s)) throw new Error(`invalid path segment "${s}"`);
  if (/[\x01-\x1f]/.test(s)) throw new Error(`invalid path segment "${s}"`);
  // a segment ending in a dot or space is silently truncated by Windows, which
  // would make the on-disk name differ from the one we recorded
  if (/[. ]$/.test(s)) throw new Error(`invalid path segment "${s}"`);
  return s;
}

/**
 * A server id: lowercase slug, digits and dashes only.
 *
 * Ids end up as folder names, so they are built here once and never accepted
 * raw from the renderer.
 */
function makeId(name) {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${slug || 'server'}-${rand}`;
}

const serverDir = (id) => path.join(serversRootDir(), segment(id));
const serverJar = (id) => path.join(serverDir(id), 'paper.jar');
const serverWorld = (id) => path.join(serverDir(id), 'world');
const serverPlugins = (id) => path.join(serverDir(id), 'plugins');
const serverLogs = (id) => path.join(serverDir(id), 'logs');
const serverProperties = (id) => path.join(serverDir(id), 'server.properties');
const serverEula = (id) => path.join(serverDir(id), 'eula.txt');
const serverOps = (id) => path.join(serverDir(id), 'ops.json');
const serverWhitelist = (id) => path.join(serverDir(id), 'whitelist.json');
const serverBanned = (id) => path.join(serverDir(id), 'banned-players.json');
const serverBannedIps = (id) => path.join(serverDir(id), 'banned-ips.json');

const runtimeDirFor = (major) => path.join(runtimeDir(), segment(String(major)));
const runtimeZip = (major) => path.join(runtimeZipsDir(), `temurin-${segment(String(major))}.zip`);
const backupsDir = (id) => path.join(backupsRootDir(), segment(id));
const cacheFile = (name) => path.join(cacheDir(), segment(name));

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function sizeOf(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/** Total bytes of a directory tree, for the storage read-out. */
function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* vanished between readdir and stat */
        }
      }
    }
  }
  return total;
}

module.exports = {
  DEFAULT_BASE,
  init,
  setServersRoot,
  segment,
  makeId,
  base: () => base,
  serversRootDir,
  serverDir,
  serverJar,
  serverWorld,
  serverPlugins,
  serverLogs,
  serverProperties,
  serverEula,
  serverOps,
  serverWhitelist,
  serverBanned,
  serverBannedIps,
  runtimeDir,
  runtimeDirFor,
  runtimeZip,
  runtimeZipsDir,
  backupsRootDir,
  backupsDir,
  tmpDir,
  cacheDir,
  cacheFile,
  exists,
  sizeOf,
  dirSize,
};