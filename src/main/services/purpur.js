'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const paths = require('./paths');
const net = require('./net');
const java = require('./java');

/**
 * Purpur client for the v2 API at api.purpurmc.org.
 *
 *   GET /v2/purpur                     every Minecraft version Purpur builds
 *   GET /v2/purpur/{mc}                the build numbers for one version
 *   GET /v2/purpur/{mc}/{build}/download   the jar itself
 *
 * Purpur is a Paper fork, so the jar is the same shape and the same Java matrix
 * applies. Unlike Paper's API the build list carries no per-build metadata - no
 * size, no checksum, no timestamp - and the download URL is derived from the
 * version and build number rather than being handed out. That is why
 * `listBuilds` fills in `sha256: ''` and `size: 0`: the downloader already
 * treats a missing checksum as "skip verification" rather than "fail".
 */

const BASE = 'https://api.purpurmc.org/v2/purpur';
const TTL = 3 * 60 * 60 * 1000; // 3 hours

/* ------------------------------ cache layer ----------------------------- */

function cacheAge(file) {
  try {
    return Date.now() - fs.statSync(file).mtimeMs;
  } catch {
    return Infinity;
  }
}

async function readCache(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
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
    console.warn('[purpur] could not write cache', file, err.message);
  }
}

async function cached(url, cacheName, ttl, { refresh = false, signal = null } = {}) {
  const file = paths.cacheFile(cacheName);

  if (!refresh) {
    const hit = await readCache(file);
    if (hit) return hit;
  }

  try {
    const data = await net.getJson(url, { signal, retries: 2 });
    await writeCache(file, data, ttl);
    return data;
  } catch (err) {
    // a stale build list is still startable; an empty one is not
    const stale = await readCache(file);
    if (stale) {
      console.warn('[purpur] using stale cache for', cacheName, '-', err.message);
      return stale;
    }
    throw err;
  }
}

/* -------------------------------- helpers ------------------------------- */

/**
 * Newest first, with a stable release ahead of its own pre-releases.
 *
 * Shares Paper's comparator so the two catalogues sort identically in the UI.
 */
function sortVersions(list) {
  const rank = (v) => {
    const s = String(v).toLowerCase();
    if (s.includes('-rc')) return -1;
    if (s.includes('-pre')) return -2;
    return 0;
  };
  return [...list].sort((a, b) => java.compareVersions(b, a) || rank(b) - rank(a));
}

function friendly(err) {
  const message = String(err?.message || err || '');
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) {
    return 'could not reach api.purpurmc.org - check your internet connection';
  }
  if (/timeout|ETIMEDOUT|ECONNRESET/i.test(message)) {
    return 'the Purpur API timed out - try again in a moment';
  }
  if (/HTTP 4\d\d/.test(message)) return `the Purpur API refused the request (${message.split(' for ')[0]})`;
  return message;
}

/* ------------------------------- versions ------------------------------- */

/**
 * Every Minecraft version Purpur has a build for, newest first.
 *
 * @returns {Promise<{versions:Array<string>, error:string|null, cached:boolean, source:string}>}
 */
async function listVersions({ refresh = false, signal = null } = {}) {
  let data;
  let source = 'network';
  try {
    data = await cached(BASE, 'purpur-versions.json', TTL, { refresh, signal });
  } catch (err) {
    return { versions: [], error: friendly(err), cached: false, source };
  }
  if (!data || !Array.isArray(data.versions)) {
    return { versions: [], error: 'the Purpur API returned something unexpected', cached: false, source };
  }
  if (cacheAge(paths.cacheFile('purpur-versions.json')) > TTL) source = 'stale-cache';

  return { versions: sortVersions([...new Set(data.versions)]), error: null, cached: source !== 'network', source };
}

/* -------------------------------- builds -------------------------------- */

/**
 * Every build of one Minecraft version, newest first.
 *
 * The URL is derived rather than read, because the API does not publish one.
 *
 * @returns {Promise<Array<{build:number, time:string, channel:string, name:string,
 *                          size:number, sha256:string, url:string}>>}
 */
async function listBuilds(mcVersion, { refresh = false, signal = null } = {}) {
  const id = paths.segment(mcVersion);
  let data;
  try {
    data = await cached(`${BASE}/${encodeURIComponent(id)}`, `purpur-b-${id}.json`, TTL, { refresh, signal });
  } catch (err) {
    throw new Error(friendly(err));
  }

  const all = Array.isArray(data?.builds?.all) ? data.builds.all : Array.isArray(data?.builds) ? data.builds : [];
  return all
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => b - a)
    .map((build) => ({
      build,
      time: '',
      channel: 'DEFAULT',
      name: `purpur-${id}-${build}.jar`,
      size: 0,
      sha256: '',
      url: `${BASE}/${encodeURIComponent(id)}/${build}/download`,
    }));
}

async function resolveBuild(mcVersion, build, opts = {}) {
  const builds = await listBuilds(mcVersion, opts);
  if (!builds.length) return null;
  if (build === null || build === undefined || build === '') return builds[0];
  const want = Number(build);
  if (!Number.isFinite(want)) return null;
  return builds.find((b) => b.build === want) || null;
}

/* -------------------------------- install ------------------------------- */

/**
 * Download a Purpur jar into a server folder.
 *
 * Written as `server.jar`, same as every other software, so the launch command
 * line never has to change when the server is switched over.
 */
async function installJar({ serverId, mcVersion, build = null, onProgress = null, signal = null }) {
  const id = paths.segment(serverId);
  const target = paths.serverJar(id);

  const chosen = await resolveBuild(mcVersion, build, { signal });
  if (!chosen) {
    throw new Error(
      build
        ? `Purpur has no build ${build} for Minecraft ${mcVersion}`
        : `Purpur has no downloadable build for Minecraft ${mcVersion}`
    );
  }

  await net.download(chosen.url, target, {
    sha256: null,
    expectedSize: null,
    signal,
    onProgress,
  });

  return { skipped: false, size: paths.sizeOf(target), build: chosen.build, file: target };
}

/** Java feature version, from the local matrix: Purpur follows vanilla exactly. */
function requiredJava(mcVersion) {
  return java.requirementFor(mcVersion);
}

module.exports = {
  BASE,
  listVersions,
  listBuilds,
  resolveBuild,
  installJar,
  requiredJava,
  sortVersions,
  friendly,
};