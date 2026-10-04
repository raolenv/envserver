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
 *   GET  https://net-secondary.web.minecraft-services.net/api/v1.0/download/links
 *   GET  <downloadUrl from that response>
 *
 * **Where the version list comes from, and why it is this URL.**
 *
 * The obvious thing to scrape is the download page,
 * `https://www.minecraft.net/en-us/download/server/bedrock`, and that is what an
 * earlier version of this file did. It cannot work: the page is an AEM shell
 * whose download card is rendered by a JavaScript component, and the zip links
 * are not in the served HTML. Fetching it returns ~390 KB with zero
 * occurrences of `bedrock-server-*.zip` in it, so the scraper always returned
 * an empty list and the version dropdown was always empty.
 *
 * The same page's component calls, in its own words,
 * `mc.propertyUtils.coreServices().serverDownloadLatest()` and
 * `serverDownload()`, which resolve to `window.MinecraftUser.getLatestVersion`
 * and `.getDownloadLinks` - i.e.
 *
 *   GET /api/v1.0/download/latest   -> {"result":"26.3"}
 *   GET /api/v1.0/download/links    -> {"result":{"links":[
 *         {"downloadType":"serverBedrockWindows",       "downloadUrl":".../bin-win/bedrock-server-1.26.52.3.zip"},
 *         {"downloadType":"serverBedrockLinux",         "downloadUrl":".../bin-linux/bedrock-server-1.26.52.3.zip"},
 *         {"downloadType":"serverBedrockPreviewWindows","downloadUrl":".../bin-win-preview/bedrock-server-1.26.60.29.zip"},
 *         {"downloadType":"serverBedrockPreviewLinux",  "downloadUrl":".../bin-linux-preview/bedrock-server-1.26.60.29.zip"},
 *         {"downloadType":"serverJar",                  "downloadUrl":"https://piston-data.mojang.com/.../server.jar"}]}}
 *
 * That is the real source, it answers 200 to an ordinary `EnvServer/1.2.0`
 * User-Agent with no browser impersonation, and it is what Mojang's own page
 * renders from. It names the current stable and current preview build and no
 * history, so every version ever seen is merged into the disk cache and kept:
 * old zips are never deleted from Mojang's bucket, so an old version stays
 * installable for as long as the app remembers it.
 *
 * The URLs are used verbatim rather than rebuilt from the version number,
 * because preview builds live under `bin-win-preview/` and asking for
 * `bin-win/bedrock-server-<preview>.zip` is a 404.
 *
 * Every release is a zip of native binaries, not a jar: there is no JVM, no
 * `-Xmx`, and no `eula.txt`. The server starts when `bedrock_server.exe` runs.
 * Accepted port is 19132 (Bedrock's UDP port).
 */

const API_LINKS = 'https://net-secondary.web.minecraft-services.net/api/v1.0/download/links';
/** The same host, for error messages: a person can block or allow a host, not a path. */
const API_HOST = 'net-secondary.web.minecraft-services.net';
const ZIP_BASE = 'https://www.minecraft.net/bedrockdedicatedserver/bin-win/';
const PAGE_TTL = 6 * 60 * 60 * 1000; // 6 hours
const DEFAULT_PORT = 19132;

/** The two download types that are a Windows Bedrock server. */
const STABLE_LINK = 'serverBedrockWindows';
const PREVIEW_LINK = 'serverBedrockPreviewWindows';

/** `bedrock-server-1.21.1.0.zip` -> `1.21.1.0`. */
const ZIP_RE = /bedrock-server-(\d+(?:\.\d+)+)\.zip/;

/* --------------------------------- cache -------------------------------- */

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
    if (parsed && Array.isArray(parsed.data?.versions)) return parsed;
  } catch {
    /* no usable cache */
  }
  return null;
}

async function writeCache(file, data) {
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify({ at: Date.now(), ttl: PAGE_TTL, data }), 'utf8');
  } catch (err) {
    console.warn('[bedrock] could not write cache', file, err.message);
  }
}

/* -------------------------------- parsing -------------------------------- */

/**
 * Pull every Bedrock version out of anything containing a zip URL.
 *
 * Kept deliberately tolerant - it is fed a JSON payload, a URL, or a whole
 * response body depending on the caller, and matching one known shape is what
 * made this file fragile in the first place.
 *
 * @param {string} text
 * @returns {string[]}
 */
function parseVersions(text) {
  const seen = new Set();
  const out = [];
  for (const m of String(text || '').matchAll(new RegExp(ZIP_RE, 'gi'))) {
    const v = m[1];
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  // 1.21.1.10 sorts after 1.21.1.9 as text but is newer, so the segments are
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
 * Read the download-links payload into what this app needs.
 *
 * Unknown shapes come back as `null` rather than throwing, so the caller can
 * say "Mojang answered, but not with anything about Bedrock" - which is a
 * different problem from "Mojang did not answer" and has a different fix.
 *
 * @param {any} payload the parsed JSON
 * @returns {{stable:string, preview:string, urls:Record<string,string>}|null}
 */
function parseLinks(payload) {
  const links = payload?.result?.links;
  if (!Array.isArray(links)) return null;

  const urls = {};
  let stable = '';
  let preview = '';

  for (const link of links) {
    const type = String(link?.downloadType || '');
    if (type !== STABLE_LINK && type !== PREVIEW_LINK) continue;
    const url = String(link?.downloadUrl || '');
    const m = url.match(ZIP_RE);
    if (!m) continue;
    // the URL is kept whole: preview builds are served from another prefix
    urls[m[1]] = url;
    if (type === STABLE_LINK) stable = m[1];
    else preview = m[1];
  }

  if (!stable && !preview) return null;
  return { stable, preview, urls };
}

/* ------------------------------- version list ---------------------------- */

/**
 * Every Bedrock version EnvServer knows about, newest first.
 *
 * @returns {Promise<{versions:string[], preview:string[], error:string|null,
 *                    cached:boolean, source:string, urls:Record<string,string>}>}
 */
async function listVersions({ refresh = false, signal = null } = {}) {
  const file = paths.cacheFile('bedrock-versions.json');

  if (!refresh) {
    const hit = await readCache(file);
    // `shape` wants the payload, not the envelope: handing it the envelope is
    // how a cache that plainly contains two versions reads back as none
    if (hit && Date.now() - hit.at < (hit.ttl || PAGE_TTL)) {
      return { ...shape(hit.data), error: null, cached: true, source: 'cache' };
    }
  }

  let payload = null;
  let failure = null;
  try {
    payload = await net.getJson(API_LINKS, { signal, retries: 3, timeout: 30_000 });
  } catch (err) {
    failure = err;
  }

  const fresh = payload ? parseLinks(payload) : null;

  if (!fresh) {
    const stale = await readCache(file);
    if (stale) {
      const why = failure ? friendly(failure) : 'the answer listed no Bedrock server download';
      console.warn('[bedrock] using the remembered version list -', why);
      return { ...shape(stale.data), error: `${why} - showing the versions EnvServer saw last time`, cached: true, source: 'stale-cache' };
    }
    return {
      versions: [],
      preview: [],
      urls: {},
      error: failure
        ? friendly(failure)
        : 'Mojang\'s download service answered but listed no Bedrock server build, so EnvServer cannot tell you which versions exist',
      cached: false,
      source: 'network',
    };
  }

  // merge: never forget a version, because Mojang only names the current two
  const previous = (await readCache(file))?.data;
  const urls = { ...(previous?.urls || {}), ...fresh.urls };
  const versions = parseVersions(`${Object.keys(urls).map((v) => `bedrock-server-${v}.zip`).join('\n')}`);

  const data = {
    versions,
    preview: fresh.preview ? [fresh.preview] : [],
    stable: fresh.stable,
    urls,
  };
  await writeCache(file, data);

  return { ...shape(data), error: null, cached: false, source: 'network' };
}

/** Normalise the cached record into what callers are promised. */
function shape(data) {
  const versions = Array.isArray(data?.versions) ? data.versions.slice() : [];
  const preview = Array.isArray(data?.preview) ? data.preview.filter((v) => versions.includes(v)) : [];
  return { versions, preview, urls: data?.urls || {} };
}

/**
 * Build metadata for one version.
 *
 * Mojang publishes exactly one archive per Bedrock version - there are no
 * numbered builds to choose between - so this synthesises a single entry rather
 * than pretending the Versions view has something to pick. The URL comes from
 * the remembered list rather than being rebuilt, because preview builds are
 * served from a different prefix and the rebuilt one 404s.
 */
async function listBuilds(mcVersion, { refresh = false, signal = null } = {}) {
  if (!mcVersion) return [];
  const list = await listVersions({ refresh, signal });
  if (!list.versions.includes(mcVersion)) return [];
  return [
    {
      build: mcVersion,
      time: '',
      channel: list.preview.includes(mcVersion) ? 'bedrock-preview' : 'bedrock',
      url: urlFor(mcVersion, list.urls),
      size: 0,
      sha256: '',
    },
  ];
}

/** The remembered URL, or the stable one rebuilt. Never a preview guess. */
function urlFor(version, urls) {
  const known = urls?.[version];
  if (known) return known;
  return `${ZIP_BASE}bedrock-server-${version}.zip`;
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
async function install({ serverId, mcVersion, build = null, onProgress = null, signal = null }) {
  const id = paths.segment(serverId);
  const dir = paths.serverDir(id);
  // the renderer may pass the version or the build record; both are accepted
  // because the record is the only thing that knows the real URL
  const record = build && typeof build === 'object' ? build : null;
  const version = String(record?.build || mcVersion || (typeof build === 'string' ? build : '') || '').trim();
  if (!version) throw new Error('pick a Bedrock version first');

  const list = await listVersions({ signal });
  const url = record?.url || urlFor(version, list.urls);

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

/**
 * Turn a network failure into something a person can act on.
 *
 * The host is named in every message. When this fails the person needs to know
 * *what* to unblock - a DNS failure, a timeout and a refused request have three
 * different fixes, and "the request failed" tells them none of them.
 *
 * @param {any} err
 * @returns {string}
 */
function friendly(err) {
  // an Error with no message stringifies to "Error", which is not an answer
  const message = (err instanceof Error ? err.message : String(err ?? '')).trim();
  const where = ` (${API_HOST})`;
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) {
    return `could not reach Mojang's download service${where} - check your internet connection, DNS or firewall`;
  }
  if (/timeout|ETIMEDOUT|ECONNRESET|socket hang up|transfer stalled/i.test(message)) {
    return `Mojang's download service${where} did not answer in time - it is slow or blocked on this network, try again in a moment`;
  }
  if (/HTTP 4\d\d/.test(message)) return `Mojang's download service${where} refused the request (${message.split(' for ')[0]})`;
  return message
    ? `${message} (while asking Mojang's download service${where})`
    : `the Bedrock version list at ${API_HOST} could not be loaded, and EnvServer was not told why`;
}

/** The port Bedrock listens on, which is not 25565. */
function defaultPort() {
  return DEFAULT_PORT;
}

module.exports = {
  API_LINKS,
  API_HOST,
  ZIP_BASE,
  DEFAULT_PORT,
  STABLE_LINK,
  PREVIEW_LINK,
  listVersions,
  listBuilds,
  install,
  remove,
  requiredJava,
  meta,
  parseVersions,
  parseLinks,
  compareVersions,
  urlFor,
  defaultPort,
  friendly,
};