'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const paths = require('./paths');
const net = require('./net');
const java = require('./java');

/**
 * Vanilla server jar from Mojang's official piston-meta.
 *
 *   GET https://piston-meta.mojang.com/mc/game/version_manifest_v2.json
 *   GET https://piston-meta.mojang.com/v1/packages/{sha1}/{version}.json
 *
 * The manifest lists every release; each version's detail JSON has
 * `downloads.server` with the official server jar URL, size and sha1.
 */

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const MANIFEST_TTL = 3 * 60 * 60 * 1000; // 3 hours

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
    console.warn('[vanilla] could not write cache', file, err.message);
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
    const stale = await readCache(file);
    if (stale) {
      console.warn('[vanilla] using stale cache for', cacheName, '-', err.message);
      return stale;
    }
    throw err;
  }
}

/**
 * Every release version, newest first.
 *
 * @returns {Promise<{versions:Array<string>, error:string|null, cached:boolean, source:string}>}
 */
async function listVersions({ refresh = false, signal = null } = {}) {
  let data;
  let source = 'network';
  try {
    data = await cached(MANIFEST_URL, 'vanilla-versions.json', MANIFEST_TTL, { refresh, signal });
  } catch (err) {
    return { versions: [], error: friendly(err), cached: false, source };
  }
  if (!data || !Array.isArray(data.versions)) {
    return { versions: [], error: 'the Mojang manifest returned something unexpected', cached: false, source };
  }
  if (cacheAge(paths.cacheFile('vanilla-versions.json')) > MANIFEST_TTL) source = 'stale-cache';

  const releases = data.versions
    .filter((v) => v.type === 'release')
    .map((v) => v.id);

  return { versions: releases, error: null, cached: source !== 'network', source };
}

function friendly(err) {
  const message = String(err?.message || err || '');
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) {
    return 'could not reach piston-meta.mojang.com - check your internet connection';
  }
  if (/timeout|ETIMEDOUT|ECONNRESET/i.test(message)) {
    return 'the Mojang manifest timed out - try again in a moment';
  }
  if (/HTTP 4\d\d/.test(message)) return `Mojang refused the request (${message.split(' for ')[0]})`;
  return message;
}

/**
 * Download the official server jar for one Minecraft version.
 *
 * @returns {Promise<{skipped:boolean, size:number, file:string}>}
 */
async function installJar({ serverId, mcVersion, onProgress = null, signal = null }) {
  const id = paths.segment(serverId);
  const target = paths.serverJar(id);

  const manifest = await cached(MANIFEST_URL, 'vanilla-versions.json', MANIFEST_TTL, { signal });
  const entry = manifest?.versions?.find((v) => v.id === mcVersion);
  if (!entry) throw new Error(`Mojang has no server jar for Minecraft ${mcVersion}`);

  const detail = await net.getJson(entry.url, { signal, retries: 2 });
  const server = detail?.downloads?.server;
  if (!server?.url) throw new Error(`Mojang's version detail for ${mcVersion} has no server download`);

  await net.download(server.url, target, {
    sha1: server.sha1 || null,
    expectedSize: server.size || null,
    signal,
    onProgress,
  });

  return { skipped: false, size: paths.sizeOf(target), file: target };
}

/** The Java feature version this release needs, from the manifest detail. */
function requiredJava(mcVersion) {
  return java.requirementFor(mcVersion);
}

module.exports = {
  listVersions,
  installJar,
  requiredJava,
  friendly,
};
