'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const paths = require('./paths');
const net = require('./net');
const zip = require('./zip');

/**
 * Mojang's official Bedrock Dedicated Server, for Windows.
 *
 *   GET https://www.minecraft.net/en-us/download/server/bedrock
 *   GET https://www.minecraft.net/bedrockdedicatedserver/bin-win/bedrock-server-<version>.zip
 *
 * There is no manifest API for Bedrock the way piston-meta serves Java, and no
 * JSON listing of the published zips. The download page does embed the full set
 * of `bedrock-server-<version>.zip` links in its markup, and that page is the
 * only thing that has ever been authoritative about which versions exist - so it
 * is what this reads.
 *
 * Every release is a zip of native binaries, not a jar: there is no JVM, no
 * `-Xmx`, and no `eula.txt`. The server starts when `bedrock_server.exe` runs.
 * Accepted size is 19132 (Bedrock's UDP port), which the config view already
 * handles as an ordinary property.
 */

const PAGE_URL = 'https://www.minecraft.net/en-us/download/server/bedrock';
const ZIP_BASE = 'https://www.minecraft.net/bedrockdedicatedserver/bin-win/';
const PAGE_TTL = 6 * 60 * 60 * 1000; // 6 hours
const DEFAULT_PORT = 19132;

/** `bedrock-server-1.21.1.0.zip` -> `1.21.1.0`. */
const ZIP_RE = /bedrock-server-(\d+(?:\.\d+)+)\.zip/gi;

function cacheAge(file) {
  try {
    return Date.now() - fs.statSync(file).mtimeMs;
  } catch {
    return Infinity;
  }
}

async function readCache(file) {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (parsed && Date.now() - Number(parsed.at) < Number(parsed.ttl)) return parsed.data;
  } catch {
    /* no usable cache */
  }
  return null;
}

async function writeCache(file, data, ttl) {
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify({ at: Date.now(), ttl, data }), 'utf8');
  } catch (err) {
    console.warn('[bedrock] could not write cache', file, err.message);
  }
}

/**
 * Turn the download page into a version list, newest first.
 *
 * @param {string} html
 * @returns {string[]}
 */
function parseVersions(html) {
  const seen = new Set();
  const out = [];
  for (const m of String(html || '').matchAll(ZIP_RE)) {
    const v = m[1];
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  // 1.21.1.10 sorts after 1.21.1.9 as text but is older, so the segments are
  // compared numerically - and reversed, because every version list in this app
  // is newest first and the create form puts the default at the top.
  return out.sort((a, b) => compareVersions(b, a));
}

/** `1.21.1.10` vs `1.21.1.9`: numerically, not lexicographically. */
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Every published Bedrock Dedicated Server version, newest first.
 *
 * @returns {Promise<{versions:Array<string>, error:string|null, cached:boolean, source:string}>}
 */
async function listVersions({ refresh = false, signal = null } = {}) {
  const file = paths.cacheFile('bedrock-versions.json');

  if (!refresh) {
    const hit = await readCache(file);
    if (hit) return { versions: hit, error: null, cached: true, source: 'cache' };
  }

  let html;
  try {
    html = await net.getText(PAGE_URL, { signal, retries: 2, timeout: 45_000 });
  } catch (err) {
    const stale = await readCache(file);
    if (stale) {
      console.warn('[bedrock] using stale version list -', err.message);
      return { versions: stale, error: friendly(err), cached: true, source: 'stale-cache' };
    }
    return { versions: [], error: friendly(err), cached: false, source: 'network' };
  }

  const versions = parseVersions(html);
  if (!versions.length) {
    return {
      versions: [],
      error: 'the Mojang download page loaded but listed no Bedrock server zips - EnvServer cannot tell which versions exist',
      cached: false,
      source: 'network',
    };
  }

  await writeCache(file, versions, PAGE_TTL);
  return { versions, error: null, cached: false, source: 'network' };
}

/**
 * Build metadata for one version.
 *
 * Mojang publishes exactly one archive per Bedrock version - there are no
 * numbered builds to choose between - so this synthesises a single entry rather
 * than pretending the Versions view has something to pick.
 */
async function listBuilds(mcVersion, { refresh = false, signal = null } = {}) {
  if (!mcVersion) return [];
  const list = await listVersions({ refresh, signal });
  if (list.error || !list.versions.includes(mcVersion)) return [];
  return [
    {
      build: mcVersion,
      time: '',
      channel: 'bedrock',
      url: `${ZIP_BASE}bedrock-server-${mcVersion}.zip`,
      size: 0,
      sha256: '',
    },
  ];
}

/** No Java, so there is nothing to report and nothing to match against. */
function requiredJava() {
  return 0;
}

function meta() {
  return { javaMajor: 0, recommendedFlags: [], supportStatus: '', supportEnd: '', buildCount: 1 };
}

/**
 * Download and unpack the dedicated server.
 *
 * The archive is unpacked straight into the server folder rather than into a
 * subfolder: `bedrock_server.exe` resolves its `world/`, `bedrock_server_how_to.html`
 * and its libraries relative to its own location, so a nested folder would start
 * and then write an empty world somewhere else.
 *
 * @returns {Promise<{skipped:boolean, size:number, file:string, build:string}>}
 */
async function install({ serverId, mcVersion, onProgress = null, signal = null }) {
  const id = paths.segment(serverId);
  const dir = paths.serverDir(id);
  const version = String(mcVersion || '').trim();
  if (!version) throw new Error('pick a Bedrock version first');

  const url = `${ZIP_BASE}bedrock-server-${version}.zip`;
  const archive = path.join(paths.tmpDir(), `bedrock-server-${version}.zip`);

  await fsp.mkdir(paths.tmpDir(), { recursive: true });
  await fsp.mkdir(dir, { recursive: true });

  await net.download(url, archive, { signal, onProgress });

  if (!paths.exists(archive) || paths.sizeOf(archive) === 0) {
    throw new Error(`Mojang's download for Bedrock ${version} came back empty`);
  }

  try {
    await zip.extractAll(archive, dir, { signal, onProgress: () => {} });
  } catch (err) {
    throw new Error(`the Bedrock archive for ${version} would not unpack: ${err.message}`);
  } finally {
    await fsp.rm(archive, { force: true }).catch(() => {});
  }

  const exe = path.join(dir, 'bedrock_server.exe');
  if (!paths.exists(exe)) {
    const found = (await listNames(dir)).filter((n) => /\.exe$/i.test(n));
    throw new Error(
      `the Bedrock archive for ${version} unpacked but has no bedrock_server.exe in it${
        found.length ? ` (found ${found.slice(0, 4).join(', ')})` : ''
      } - Mojang may have changed the archive layout`
    );
  }

  return { skipped: false, size: paths.sizeOf(exe), file: exe, build: version };
}

async function listNames(dir) {
  try {
    return await fsp.readdir(dir);
  } catch {
    return [];
  }
}

/**
 * Remove the server files.
 *
 * The world is left alone. Deleting an install someone forgot EnvServer about is
 * not the same as deleting their world, and the Versions tab says it only
 * removes the server files.
 */
async function remove(serverId) {
  const id = paths.segment(serverId);
  const dir = paths.serverDir(id);
  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return { ok: true, removed: 0 };
  }

  // everything Mojang ships lives at the top level except the world itself
  const keep = new Set(['world', 'worlds', 'server.properties', 'permissions.json', 'allowlist.json']);
  let removed = 0;
  for (const name of entries) {
    if (keep.has(name)) continue;
    await fsp.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {});
    removed++;
  }
  return { ok: true, removed };
}

/** Turn a network failure into something a person can act on. */
function friendly(err) {
  const message = String(err?.message || err || '');
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) {
    return 'could not reach www.minecraft.net - check your internet connection or firewall';
  }
  if (/timeout|ETIMEDOUT|ECONNRESET|socket hang up/i.test(message)) {
    return 'www.minecraft.net timed out - Mojang is slow or blocked on this network, try again in a moment';
  }
  if (/HTTP 4\d\d/.test(message)) return `Mojang refused the request (${message.split(' for ')[0]})`;
  return message || 'the Bedrock download failed for an unknown reason';
}

/** The port Bedrock listens on, which is not 25565. */
function defaultPort() {
  return DEFAULT_PORT;
}

module.exports = {
  PAGE_URL,
  ZIP_BASE,
  DEFAULT_PORT,
  listVersions,
  listBuilds,
  install,
  remove,
  requiredJava,
  meta,
  parseVersions,
  compareVersions,
  defaultPort,
  friendly,
};
