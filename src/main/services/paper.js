'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const paths = require('./paths');
const net = require('./net');
const java = require('./java');

/**
 * Paper client for the v3 API at fill.papermc.io.
 *
 *   GET /v3/projects/paper                              the version list
 *   GET /v3/projects/paper/versions/{mc}                java requirement, support, builds
 *   GET /v3/projects/paper/versions/{mc}/builds         every build, newest first
 *
 * The v2 API on api.papermc.io was retired (it answers 410), so v3 is the only
 * one to talk to. Every response is cached on disk, which is what makes the app
 * usable with no network at all: browsing, and starting a server that is already
 * installed, never need the API.
 */

const BASE = 'https://fill.papermc.io/v3/projects';
const PROJECT_TTL = 3 * 60 * 60 * 1000; // 3 hours
const BUILDS_TTL = 60 * 60 * 1000; // 1 hour

function projectKey(project) {
  return String(project || 'paper');
}

function cachePrefix(project) {
  const p = projectKey(project);
  return p === 'paper' ? 'paper' : p;
}

function projectApi(project) {
  return `${BASE}/${encodeURIComponent(projectKey(project))}`;
}

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
    // a full disk must not break the app; the data is refetchable
    console.warn('[paper] could not write cache', file, err.message);
  }
}

/** Fetch with the disk cache in front and the previous answer behind it. */
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
    // a stale copy of the version list is far better than no list at all
    const stale = await readStale(file);
    if (stale) {
      console.warn('[paper] using stale cache for', cacheName, '-', err.message);
      return stale;
    }
    throw err;
  }
}

/** A cache read that ignores the TTL. */
async function readStale(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed?.data ?? null;
  } catch {
    return null;
  }
}

/* ------------------------------- versions ------------------------------- */

/**
 * Sort newest first, with a stable release ahead of its own pre-releases.
 *
 * `1.21.11` and `1.21.11-rc3` compare equal numerically, so the tie is broken by
 * the suffix - otherwise the newest release could be pushed off the top row by
 * its own release candidate.
 */
function sortVersions(list) {
  const rank = (v) => {
    const s = String(v).toLowerCase();
    if (s.includes('-rc')) return -1;
    if (s.includes('-pre')) return -2;
    return 0;
  };
  // `compareVersions(b, a)` for newest-first; the rank term then pushes a stable
  // release ahead of the release candidates that share its number
  return [...list].sort((a, b) => java.compareVersions(b, a) || rank(b) - rank(a));
}

/**
 * Every Minecraft version Paper has a build for, newest first.
 *
 * @returns {Promise<{versions:Array, error:string|null, cached:boolean, source:string}>}
 */
async function listVersions({ refresh = false, signal = null, project = 'paper' } = {}) {
  let data;
  let source = 'network';
  try {
    data = await cached(projectApi(project), `${cachePrefix(project)}-versions.json`, PROJECT_TTL, { refresh, signal });
  } catch (err) {
    return { versions: [], error: friendly(err), cached: false, source };
  }
  if (!data || !data.versions) {
    return { versions: [], error: `the ${projectKey(project)} API returned something unexpected`, cached: false, source };
  }
  if (cacheAge(paths.cacheFile(`${cachePrefix(project)}-versions.json`)) > PROJECT_TTL) source = 'stale-cache';

  // the API groups versions ("1.21" -> ["1.21.11", "1.21.10", ...])
  const all = [];
  for (const group of Object.keys(data.versions)) {
    for (const id of data.versions[group] || []) all.push(id);
  }

  return { versions: sortVersions([...new Set(all)]), error: null, cached: source !== 'network', source };
}

/** Turn an HTTP failure into something a person can act on. */
function friendly(err, project = 'paper') {
  const message = String(err?.message || err || '');
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) {
    return `could not reach fill.papermc.io - check your internet connection`;
  }
  if (/timeout|ETIMEDOUT|ECONNRESET/i.test(message)) {
    return `the ${projectKey(project)} API timed out - try again in a moment`;
  }
  if (/HTTP 4\d\d/.test(message)) return `the ${projectKey(project)} API refused the request (${message.split(' for ')[0]})`;
  return message;
}

/**
 * Per-version metadata: the Java it needs, whether Paper still supports it, and
 * the recommended JVM flags.
 *
 * @returns {Promise<{id:string, javaMajor:number, supportStatus:string, supportEnd:string,
 *                    recommendedFlags:string[], buildCount:number}|null>}
 */
async function versionMeta(mcVersion, { refresh = false, signal = null, project = 'paper' } = {}) {
  const id = paths.segment(mcVersion);
  let data;
  try {
    data = await cached(`${projectApi(project)}/versions/${encodeURIComponent(id)}`, `${cachePrefix(project)}-v-${id}.json`, BUILDS_TTL, { refresh, signal });
  } catch {
    return null;
  }
  const v = data?.version;
  if (!v) return null;

  return {
    id: v.id || id,
    // the API is authoritative; the matrix is only the offline fallback
    javaMajor: Number(v?.java?.version?.minimum) || java.requirementFor(id),
    supportStatus: String(v?.support?.status || 'UNKNOWN').toUpperCase(),
    supportEnd: String(v?.support?.end || ''),
    recommendedFlags: Array.isArray(v?.java?.flags?.recommended) ? v.java.flags.recommended.slice() : [],
    buildCount: Array.isArray(data?.builds) ? data.builds.length : 0,
  };
}

/**
 * Every build of one Minecraft version, newest first.
 *
 * @returns {Promise<Array<{build:number, time:string, channel:string, name:string,
 *                          size:number, sha256:string, url:string}>>}
 */
async function listBuilds(mcVersion, { refresh = false, signal = null, project = 'paper' } = {}) {
  const id = paths.segment(mcVersion);
  let list;
  try {
    list = await cached(
      `${projectApi(project)}/versions/${encodeURIComponent(id)}/builds`,
      `${cachePrefix(project)}-b-${id}.json`,
      BUILDS_TTL,
      { refresh, signal }
    );
  } catch (err) {
    throw new Error(friendly(err, project));
  }
  if (!Array.isArray(list)) return [];

  return list
    .map((b) => {
      const dl = b?.downloads?.['server:default'] || b?.downloads?.server;
      if (!dl?.url) return null;
      return {
        build: Number(b.id) || 0,
        time: String(b.time || ''),
        channel: String(b.channel || 'DEFAULT').toUpperCase(),
        name: String(dl.name || `paper-${id}-${b.id}.jar`),
        size: Number(dl.size) || 0,
        sha256: String(dl?.checksums?.sha256 || ''),
        url: String(dl.url),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.build - a.build);
}

/** The newest build of a version, without downloading the whole list twice. */
async function latestBuild(mcVersion, opts = {}) {
  const builds = await listBuilds(mcVersion, opts);
  return builds[0] || null;
}

/**
 * Turn whatever the caller passed as `build` into a full build record.
 *
 * Accepts a record (already resolved), a build number, or nothing for "the newest".
 * A number is looked up in the build list rather than being trusted to be current.
 *
 * @returns {Promise<object|null>}
 */
async function resolveBuild(mcVersion, build, signal, project = 'paper') {
  if (build && typeof build === 'object' && build.url) return build;

  const builds = await listBuilds(mcVersion, { signal, project });
  if (!builds.length) return null;

  if (build === null || build === undefined || build === '') return builds[0];

  const want = Number(build);
  if (!Number.isFinite(want)) return null;
  return builds.find((b) => b.build === want) || null;
}

/**
 * Read what is already cached about a Minecraft version without any network.
 *
 * The start path needs the required Java version, and it must work with no
 * connection at all - a server that is already installed has to be startable on
 * a laptop in aeroplane mode. So this only ever reads what a previous fetch left
 * behind, and the caller falls back to the built-in matrix.
 *
 * @returns {{javaMajor:number, recommendedFlags:string[], supportStatus:string,
 *            supportEnd:string, buildCount:number}}
 */
function cachedMeta(mcVersion, projectOrOpts) {
  const project = typeof projectOrOpts === 'string' ? projectOrOpts : projectOrOpts?.project;
  const empty = { javaMajor: 0, recommendedFlags: [], supportStatus: 'UNKNOWN', supportEnd: '', buildCount: 0 };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(paths.cacheFile(`${cachePrefix(project)}-v-${paths.segment(mcVersion)}.json`), 'utf8'));
  } catch {
    return empty;
  }

  const v = parsed?.data?.version;
  if (!v) return empty;

  return {
    javaMajor: Number(v?.java?.version?.minimum) || 0,
    recommendedFlags: Array.isArray(v?.java?.flags?.recommended) ? v.java.flags.recommended.slice() : [],
    supportStatus: String(v?.support?.status || 'UNKNOWN').toUpperCase(),
    supportEnd: String(v?.support?.end || ''),
    buildCount: Array.isArray(parsed?.data?.builds) ? parsed.data.builds.length : 0,
  };
}

/** The Java feature version this release needs, from cache or the local matrix. */
function requiredJava(mcVersion, projectOrOpts) {
  const project = typeof projectOrOpts === 'string' ? projectOrOpts : projectOrOpts?.project;
  return cachedMeta(mcVersion, project).javaMajor || java.requirementFor(mcVersion);
}

/* -------------------------------- install ------------------------------- */

/**
 * Download a Paper jar into a server folder.
 *
 * `build` accepts either a full build record or a build number. That matters:
 * every caller - the IPC handler, the "Install this" button, the upgrade path -
 * naturally has a number, and silently treating a number as a record produced a
 * "no download URL" error for every single install.
 *
 * The jar is always written as `paper.jar`, whatever the upstream name is, so the
 * launch command line never has to be rebuilt after an upgrade.
 *
 * @returns {Promise<{skipped:boolean, size:number, build:number, file:string}>}
 */
async function installJar({ serverId, mcVersion, build = null, onProgress = null, signal = null, project = 'paper' }) {
  const id = paths.segment(serverId);
  const target = paths.serverJar(id);

  const chosen = await resolveBuild(mcVersion, build, signal, project);
  if (!chosen) {
    throw new Error(
      build
        ? `${projectKey(project)} has no build ${build} for Minecraft ${mcVersion}`
        : `${projectKey(project)} has no downloadable build for Minecraft ${mcVersion}`
    );
  }
  if (!chosen.url) throw new Error(`${projectKey(project)} build ${chosen.build} has no download URL`);

  await net.download(chosen.url, target, {
    sha256: chosen.sha256 || null,
    expectedSize: chosen.size || null,
    signal,
    onProgress,
  });

  return { skipped: false, size: paths.sizeOf(target), build: chosen.build, file: paths.serverJar(id) };
}

/** Remove a server's jar. The rest of the folder (world, plugins) is left alone. */
async function removeJar(serverId) {
  const target = paths.serverJar(paths.segment(serverId));
  try {
    await fsp.rm(target, { force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** What is on disk for a server, so the UI can tell installed from available. */
function installedInfo(serverId) {
  const target = paths.serverJar(paths.segment(serverId));
  if (!paths.exists(target)) return { installed: false, size: 0, modified: 0 };
  try {
    const stat = fs.statSync(target);
    return { installed: true, size: stat.size, modified: stat.mtimeMs };
  } catch {
    return { installed: false, size: 0, modified: 0 };
  }
}

module.exports = {
  BASE,
  API: BASE + '/paper',
  projectApi,
  listVersions,
  versionMeta,
  cachedMeta,
  requiredJava,
  listBuilds,
  latestBuild,
  resolveBuild,
  installJar,
  removeJar,
  installedInfo,
  sortVersions,
  friendly,
};