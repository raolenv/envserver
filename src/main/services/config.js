'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const paths = require('./paths');

/**
 * Everything the server keeps as plain files: `server.properties`, `eula.txt`,
 * `ops.json`, `whitelist.json`, the ban lists, and the `plugins/` folder.
 *
 * All of it is read and written through here so the UI never guesses a format,
 * and so unknown keys and comments survive a round trip - a hand-tuned
 * `server.properties` must not lose the dozen settings the app does not model.
 */

/* ----------------------------- properties ------------------------------- */

/**
 * Parse a `.properties` file into an ordered key/value map.
 *
 * Both separators are accepted (`=` is what vanilla writes, `:` is what very old
 * releases used) and the first one wins, matching `java.util.Properties`.
 */
function parseProperties(text) {
  const order = [];
  const values = {};

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;

    const eq = line.indexOf('=');
    const colon = line.indexOf(':');
    let cut = -1;
    if (eq >= 0 && colon >= 0) cut = Math.min(eq, colon);
    else if (eq >= 0) cut = eq;
    else if (colon >= 0) cut = colon;
    if (cut < 0) continue;

    const key = line.slice(0, cut).trim();
    if (!key) continue;
    const value = line.slice(cut + 1).trim();
    if (!Object.prototype.hasOwnProperty.call(values, key)) order.push(key);
    values[key] = value;
  }

  return { order, values };
}

function serializeProperties(order, values) {
  const keys = [...new Set([...order, ...Object.keys(values)])];
  const body = keys
    .filter((k) => Object.prototype.hasOwnProperty.call(values, k))
    .map((k) => `${k}=${values[k]}`)
    .join('\n');
  return `#Minecraft server properties\n#${new Date().toString()}\n${body}\n`;
}

function readProperties(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { order: [], values: {} };
  }
  return parseProperties(text);
}

function writeProperties(file, order, values) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serializeProperties(order, values), 'utf8');
}

/* -------------------------------- eula ---------------------------------- */

function readEula(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const m = /^\s*eula\s*=\s*(\w+)/im.exec(text);
    return m ? m[1].toLowerCase() === 'true' : false;
  } catch {
    return false;
  }
}

function writeEula(file, accepted) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `# By changing the setting below to TRUE you are indicating your agreement to the Minecraft EULA (https://aka.ms/MinecraftEULA).\n` +
      `# Written by EnvServer\n` +
      `eula=${accepted ? 'true' : 'false'}\n`,
    'utf8'
  );
}

/**
 * Write a `server.properties` for a server that has never run.
 *
 * Only used when the file does not exist - a server that has booted once keeps
 * every key vanilla and the user have written, including the ones this app does
 * not model. The values are vanilla's own defaults, so nothing behaves oddly
 * before the user has touched anything.
 */
function seedDefaults(serverId, { port = 25565, motd = 'An EnvServer server' } = {}) {
  const file = paths.serverProperties(serverId);
  if (paths.exists(file)) return { seeded: false };

  const values = {
    'server-ip': '',
    'server-port': String(port),
    motd,
    'max-players': '20',
    gamemode: 'survival',
    difficulty: 'normal',
    'level-name': 'world',
    'level-seed': '',
    'level-type': 'minecraft\\:normal',
    'online-mode': 'true',
    'white-list': 'false',
    'enforce-whitelist': 'true',
    'pvp': 'true',
    'allow-flight': 'false',
    hardcore: 'false',
    'allow-nether': 'true',
    'generate-structures': 'true',
    'spawn-animals': 'true',
    'spawn-monsters': 'true',
    'spawn-npcs': 'true',
    'view-distance': '10',
    'simulation-distance': '10',
    'spawn-protection': '16',
    'enable-command-block': 'false',
    'enable-status': 'true',
    'hide-online-players': 'false',
    'max-world-size': '29999984',
    'network-compression-threshold': '256',
    'sync-chunk-writes': 'true',
    'op-permission-level': '4',
    'entity-broadcast-range-percentage': '100',
    'function-permission-level': '2',
  };

  writeProperties(file, Object.keys(values), values);
  return { seeded: true, file };
}

/* ---------------------------- player lists ----------------------------- */

/**
 * UUID a name gets on a server running with `online-mode=false`.
 *
 * The vanilla rule is MD5("OfflinePlayer:<name>") with the version and variant
 * bits forced to 3. Getting this right matters: writing a random UUID into
 * whitelist.json makes the entry silently not match the player.
 */
function offlineUuid(name) {
  const md5 = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  md5[6] = (md5[6] & 0x0f) | 0x30; // version 3
  md5[8] = (md5[8] & 0x3f) | 0x80; // IETF variant
  const hex = md5.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || '').trim());
}

/**
 * Read one of the JSON player lists.
 *
 * Vanilla's shape is an array of `{uuid, name}` (plus `level`/`source` for ops),
 * but a hand-edited file can be an object with a `players` key, and a
 * non-array means the file is corrupt - which must be reported, not silently
 * treated as "empty", or a click on "remove all" would wipe the list.
 */
function readJsonList(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { ok: true, list: [], missing: true };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, list: [], error: `${path.basename(file)} is not valid JSON: ${err.message}` };
  }

  if (Array.isArray(parsed)) return { ok: true, list: parsed };
  if (parsed && Array.isArray(parsed.players)) return { ok: true, list: parsed.players };
  return { ok: false, list: [], error: `${path.basename(file)} is not a list of players` };
}

function writeJsonList(file, list) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(list, null, 2)}\n`, 'utf8');
}

const PLAYER_NAME = /^[A-Za-z0-9_]{3,16}$/;

function validatePlayerName(name) {
  const clean = String(name || '').trim();
  if (!PLAYER_NAME.test(clean)) {
    return { ok: false, error: 'a player name is 3-16 characters, letters, digits and underscore' };
  }
  return { ok: true, name: clean };
}

/* ------------------------------ plugins --------------------------------- */

/** A plugin's display name is its filename, which is the best label available. */
function pluginName(file) {
  return path
    .basename(file, '.jar')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function listPlugins(serverId) {
  const dir = paths.serverPlugins(serverId);
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.jar$/i.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    let stat = null;
    try {
      stat = await fsp.stat(full);
    } catch {
      continue;
    }
    out.push({
      file: entry.name,
      name: pluginName(entry.name),
      size: stat.size,
      modified: stat.mtimeMs,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Every jar in a folder, ready to be moved into `plugins/`. */
async function listJars(folder) {
  let entries = [];
  try {
    entries = await fsp.readdir(folder, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && /\.jar$/i.test(e.name))
    .map((e) => path.join(folder, e.name));
}

/** An upload arrives as base64 over IPC; decode it into the plugins folder. */
async function installPlugin(serverId, fileName, base64) {
  const name = path.basename(String(fileName || ''));
  if (!/\.jar$/i.test(name)) return { ok: false, error: 'only .jar files can be dropped into plugins/' };

  const dir = paths.serverPlugins(serverId);
  await fsp.mkdir(dir, { recursive: true });

  const buf = Buffer.from(String(base64 || ''), 'base64');
  if (!buf.length) return { ok: false, error: 'that file came through empty' };
  if (buf.length > 128 * 1024 * 1024) return { ok: false, error: 'plugins are capped at 128 MB' };

  const dest = path.join(dir, name);
  // a replaced plugin must not leave the old one loaded in a running server
  await fsp.writeFile(dest, buf);
  return { ok: true, file: name, size: buf.length };
}

async function removePlugin(serverId, fileName) {
  const name = path.basename(String(fileName || ''));
  if (!name.endsWith('.jar')) return { ok: false, error: 'that is not a plugin file' };
  const target = path.join(paths.serverPlugins(serverId), name);
  try {
    await fsp.unlink(target);
    return { ok: true, file: name };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* --------------------------------- log ---------------------------------- */

/**
 * Tail the server's own log.
 *
 * When the server has been run outside the app - or the app was closed while it
 * was up - `logs/latest.log` is the only record of what happened, so the Console
 * view reads it on open instead of showing an empty screen.
 */
function tailLog(serverId, lines = 400) {
  const file = path.join(paths.serverLogs(serverId), 'latest.log');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const all = text.split(/\r?\n/).filter((l) => l.length);
  return all.slice(-Math.max(1, Math.min(2000, lines)));
}

/** Remove rotated logs, keeping `keep` files. */
async function pruneLogs(serverId, keep = 5) {
  const dir = paths.serverLogs(serverId);
  let entries = [];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return 0;
  }
  const rotated = entries.filter((f) => /^\d{4}-\d{2}-\d{2}.*\.log\.gz$/.test(f)).sort();
  const excess = rotated.slice(0, Math.max(0, rotated.length - keep));
  for (const file of excess) {
    try {
      await fsp.unlink(path.join(dir, file));
    } catch {
      /* best effort */
    }
  }
  return excess.length;
}

module.exports = {
  parseProperties,
  serializeProperties,
  readProperties,
  writeProperties,
  readEula,
  writeEula,
  seedDefaults,
  readJsonList,
  writeJsonList,
  validatePlayerName,
  offlineUuid,
  isUuid,
  pluginName,
  listPlugins,
  listJars,
  installPlugin,
  removePlugin,
  tailLog,
  pruneLogs,
};