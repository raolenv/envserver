'use strict';

const fsp = require('fs/promises');
const path = require('path');
const paths = require('./paths');
const net = require('./net');

/**
 * PocketMine-MP, the most active Bedrock server software.
 *
 *   GET https://api.github.com/repos/pmmp/PocketMine-MP/releases?per_page=30
 *
 * PocketMine used to publish a manifest at `update.pmmp.io/api`. That endpoint
 * is gone - every path on that host answers 404 - and GitHub releases are where
 * the project actually ships now: each tag carries `PocketMine-MP.phar` plus the
 * `start.cmd`/`start.ps1` wrappers. Reading releases is therefore both the live
 * source and the one that carries the binary's checksum, so the download is
 * verified rather than trusted.
 *
 * PocketMine is PHP. There is no Java anywhere in this path, and `runtime.js`
 * is what keeps that from mattering to the launcher.
 *
 * One thing worth knowing about GitHub as a catalogue: unauthenticated requests
 * are rate limited to 60 an hour, shared by everyone behind one NAT. That is
 * enough for a person clicking around and not enough for a loop, so the version
 * list is cached for six hours and a failed refresh falls back to the cache
 * rather than reporting "no versions".
 */

const RELEASES_URL = 'https://api.github.com/repos/pmmp/PocketMine-MP/releases?per_page=30';
const TTL = 6 * 60 * 60 * 1000;
const PHAR_NAME = 'PocketMine-MP.phar';

function cacheFile() {
  return paths.cacheFile('pocketmine-versions.json');
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
    console.warn('[pocketmine] could not write cache', file, err.message);
  }
}

/**
 * Keep only what the Versions view needs.
 *
 * The full GitHub payload is 70 KB per five releases and is thrown away on the
 * next cache miss anyway; caching the trimmed shape keeps the file readable and
 * stops a GitHub schema addition from silently becoming cached state.
 */
function trim(releases) {
  return (Array.isArray(releases) ? releases : [])
    .map((r) => {
      const asset = (r?.assets || []).find((a) => a?.name === PHAR_NAME);
      if (!asset || !r.tag_name) return null;
      return {
        version: String(r.tag_name),
        assetId: asset.id,
        url: asset.browser_download_url,
        size: Number(asset.size) || 0,
        sha256: asset.digest ? String(asset.digest) : '',
        // the API's date, kept because a release with no date sorts badly
        published: r.published_at || r.created_at || '',
      };
    })
    .filter(Boolean);
}

/**
 * Every published PocketMine-MP release, newest first.
 *
 * @returns {Promise<{versions:Array<string>, error:string|null, cached:boolean, source:string}>}
 */
async function listVersions({ refresh = false, signal = null } = {}) {
  const file = cacheFile();

  if (!refresh) {
    const hit = await readCache(file);
    if (hit) return { versions: hit.map((e) => e.version), error: null, cached: true, source: 'cache' };
  }

  let releases;
  try {
    releases = await net.getJson(RELEASES_URL, { signal, retries: 2, headers: { accept: 'application/vnd.github+json' } });
  } catch (err) {
    const stale = await readCache(file);
    if (stale) {
      console.warn('[pocketmine] using stale version list -', err.message);
      return { versions: stale.map((e) => e.version), error: friendly(err), cached: true, source: 'stale-cache' };
    }
    return { versions: [], error: friendly(err), cached: false, source: 'network' };
  }

  const trimmed = trim(releases);
  if (!trimmed.length) {
    return {
      versions: [],
      error: 'GitHub returned PocketMine-MP releases but none of them carried a PocketMine-MP.phar',
      cached: false,
      source: 'network',
    };
  }

  await writeCache(file, trimmed, TTL);
  return { versions: trimmed.map((e) => e.version), error: null, cached: false, source: 'network' };
}

/**
 * Build metadata for one release.
 *
 * PocketMine ships exactly one phar per release, so this is the single asset,
 * exactly as for Bedrock. GitHub's newer releases carry a `sha256:` digest
 * field, which `net.download` verifies when it is there.
 */
async function listBuilds(mcVersion, { refresh = false, signal = null } = {}) {
  const tag = String(mcVersion || '').trim();
  if (!tag) return [];

  const file = cacheFile();
  let entries = await readCache(file);
  if (!entries || refresh) {
    await listVersions({ refresh: true, signal });
    entries = await readCache(file);
  }

  const hit = (entries || []).find((e) => e.version === tag);
  if (!hit) return [];

  return [
    {
      build: tag,
      time: hit.published || '',
      channel: 'pocketmine',
      url: hit.url,
      size: hit.size,
      sha256: /^sha256:/i.test(hit.sha256 || '') ? hit.sha256 : '',
    },
  ];
}

/** Download the phar for one release. */
async function install({ serverId, mcVersion, onProgress = null, signal = null }) {
  const id = paths.segment(serverId);
  const dir = paths.serverDir(id);
  const tag = String(mcVersion || '').trim();
  if (!tag) throw new Error('pick a PocketMine-MP version first');

  const builds = await listBuilds(tag, { signal });
  const chosen = builds[0];
  if (!chosen?.url) throw new Error(`PocketMine-MP has no ${PHAR_NAME} for release ${tag}`);

  const target = path.join(dir, PHAR_NAME);
  await fsp.mkdir(dir, { recursive: true });

  await net.download(chosen.url, target, {
    sha256: chosen.sha256 || null,
    expectedSize: chosen.size || null,
    signal,
    onProgress,
    headers: { accept: 'application/octet-stream' },
  });

  return { skipped: false, size: paths.sizeOf(target), file: target, build: tag };
}

/** Remove the phar. The world and pocketmine.yml are left alone. */
async function remove(serverId) {
  const id = paths.segment(serverId);
  const target = path.join(paths.serverDir(id), PHAR_NAME);
  try {
    await fsp.rm(target, { force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** No Java. PocketMine needs PHP, and `runtime.js`/`php.js` own that. */
function requiredJava() {
  return 0;
}

function meta() {
  return { javaMajor: 0, recommendedFlags: [], supportStatus: '', supportEnd: '', buildCount: 1 };
}

/** Bedrock's port, which PocketMine also uses. */
function defaultPort() {
  return 19132;
}

function friendly(err) {
  const message = String(err?.message || err || '');
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) {
    return 'could not reach api.github.com - check your internet connection';
  }
  if (/403|rate limit/i.test(message)) {
    return 'GitHub is rate limiting this machine for unauthenticated requests - the version list is cached, try again later';
  }
  if (/timeout|ETIMEDOUT|ECONNRESET/i.test(message)) {
    return 'GitHub timed out - try again in a moment';
  }
  return message || 'the PocketMine-MP version list could not be loaded';
}

module.exports = {
  RELEASES_URL,
  PHAR_NAME,
  listVersions,
  listBuilds,
  install,
  remove,
  requiredJava,
  meta,
  trim,
  defaultPort,
  friendly,
};
