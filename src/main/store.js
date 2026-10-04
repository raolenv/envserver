'use strict';

const fs = require('fs');
const path = require('path');
const paths = require('./services/paths');

/**
 * Settings and the server registry.
 *
 * The settings file is the single source of truth for both. A server's own folder
 * holds everything the *server* owns (world, plugins, logs, properties); anything
 * EnvServer decided for it - which Minecraft version, which build, which JVM, how
 * much RAM - lives here, so a server folder stays portable and nothing important
 * can be lost by copying it somewhere else.
 */

/**
 * The default port for a software.
 *
 * Kept here as a two-line table rather than pulled from `services/runtime.js` so
 * the store stays free of service dependencies: reading a setting must not need a
 * catalogue that might fail to load. `tools/../test` asserts this matches
 * `runtime.js` and `catalog.js`.
 */
const PORTS = { bedrock: 19132, pocketmine: 19132 };

function softwarePort(type, fallback = 25565) {
  return PORTS[String(type || '').toLowerCase()] || fallback;
}

const DEFAULTS = {
  /** where server folders live; empty means under the app's data folder */
  serversDir: '',

  /** global Java override; empty means "match each server automatically" */
  javaPath: '',

  /**
   * serverId -> path to a JVM pinned to that specific server.
   *
   * Empty means automatic: pick the Java feature version the Paper release
   * targets. A pin wins over the global javaPath even when it does not fit,
   * because the user chose it by name.
   */
  javaPerServer: {},

  /**
   * Global PHP override, for PocketMine-MP.
   *
   * Same shape as javaPath and the same reasoning: empty means "find a PHP 8.1+
   * on this machine". PocketMine is the only Bedrock software that needs one,
   * because it is the only one written in PHP.
   */
  phpPath: '',

  /** defaults for a new server */
  memory: { min: 1024, max: 4096 },
  port: 25565,
  extraArgs: '',
  useRecommendedFlags: true,

  /** auto-download a matching Temurin JDK instead of only using what is installed */
  autoInstallJava: true,

  /** world backups */
  autoBackupHours: 0,
  backupsKeep: 10,

  /** stop every server when the window closes, rather than orphaning the JVMs */
  stopOnExit: true,

  /**
   * Close button hides to the tray instead of quitting, so a download or a running
   * server survives the user clicking the X.
   */
  trayOnClose: true,

  /** show the terms screen before anything else can be used */
  termsAccepted: false,

  /** invented players, so the dashboard can be checked without a second human */
  demoPlayers: false,

  /** how many console lines the view keeps in memory */
  consoleLines: 2000,

  /** seen the welcome screen once */
  onboarded: false,

  activeServerId: '',

  window: { width: 1240, height: 820 },

  /**
   * @type {Array<{
   *   id:string, name:string, mcVersion:string, build:number,
   *   memory:{min:number,max:number}, port:number, extraArgs:string,
   *   javaPath:string, createdAt:number, lastStartedAt:number
   * }>}
   */
  servers: [],
};

let file = '';
let cache = null;

/* ------------------------------- validation ------------------------------ */

/**
 * Clamp an integer setting into a range.
 *
 * `null`, `undefined` and `''` fall back rather than becoming 0: `Number(null)` is
 * 0, and `Number('')` is 0 too, so without this an absent `max-players` in a
 * hand-edited settings file would silently become 1 instead of keeping its
 * default.
 */
function intIn(value, min, max, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function str(value, fallback = '', maxLength = 400) {
  if (typeof value !== 'string') return fallback;
  const clean = value.replace(/[\r\n\x00]/g, ' ').trim();
  if (!clean) return fallback;
  return clean.slice(0, maxLength);
}

function bool(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function memoryPair(raw, fallback) {
  const min = intIn(raw?.min, 128, 32 * 1024, fallback.min);
  let max = intIn(raw?.max, 128, 32 * 1024, fallback.max);
  // -Xmx below -Xms is refused by the JVM outright, so clamp rather than
  // letting the user set a combination that can never start
  if (max < min) max = min;
  return { min, max };
}

/**
 * Normalise one server record.
 *
 * Everything here came off disk or over IPC, so every field is re-validated: a
 * hand-edited settings file must not be able to put a traversal string into an
 * id or a negative number into a port.
 */
function cleanServer(raw) {
  if (!raw || typeof raw !== 'object') return null;
  // an id becomes a folder name, so a hand-edited file must not be able to put a
  // traversal string here: drop the record instead of throwing while loading
  let id = '';
  try {
    id = paths.segment(String(raw.id ?? ''));
  } catch {
    return null;
  }
  if (!id) return null;

  return {
    id,
    name: str(raw.name, id, 40),
    mcVersion: str(raw.mcVersion, '', 30),
    build: intIn(raw.build, 0, 1_000_000, 0),
    type: str(raw.type, 'paper', 40),
    memory: memoryPair(raw.memory, DEFAULTS.memory),
    port: intIn(raw.port, 1, 65535, DEFAULTS.port),
    extraArgs: str(raw.extraArgs, '', 600),
    javaPath: str(raw.javaPath, '', 400),
    /** only used by PocketMine; harmless on every other software */
    phpPath: str(raw.phpPath, '', 400),
    createdAt: intIn(raw.createdAt, 0, Number.MAX_SAFE_INTEGER, Date.now()),
    lastStartedAt: intIn(raw.lastStartedAt, 0, Number.MAX_SAFE_INTEGER, 0),
  };
}

function cleanSettings(parsed) {
  if (!parsed || typeof parsed !== 'object') parsed = {};

  const servers = Array.isArray(parsed.servers) ? parsed.servers.map(cleanServer).filter(Boolean) : [];

  // ids are folder names, so a duplicate would make two records fight over one
  // directory. Keep the first and drop the rest.
  const seen = new Set();
  const unique = servers.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));

  const pins = {};
  if (parsed.javaPerServer && typeof parsed.javaPerServer === 'object' && !Array.isArray(parsed.javaPerServer)) {
    for (const [id, value] of Object.entries(parsed.javaPerServer)) {
      if (typeof value !== 'string' || !value.trim()) continue;
      let key = '';
      try {
        key = paths.segment(id);
      } catch {
        // an id that cannot be a folder name cannot have a pin
        continue;
      }
      // a pin for a server that no longer exists is dead state: it can never be
      // applied, and leaving it makes the "per server" list lie about what is set
      if (!unique.some((s) => s.id === key)) continue;
      pins[key] = value.trim().slice(0, 400);
    }
  }

  const activeServerId = unique.some((s) => s.id === parsed.activeServerId) ? parsed.activeServerId : unique[0]?.id || '';

  return {
    ...DEFAULTS,
    ...parsed,
    servers: unique,
    javaPerServer: pins,
    activeServerId,
    memory: memoryPair(parsed.memory, DEFAULTS.memory),
    window: {
      width: intIn(parsed.window?.width, 900, 10000, DEFAULTS.window.width),
      height: intIn(parsed.window?.height, 600, 10000, DEFAULTS.window.height),
    },
    onboarded: bool(parsed.onboarded, false),
    stopOnExit: bool(parsed.stopOnExit, DEFAULTS.stopOnExit),
    trayOnClose: bool(parsed.trayOnClose, DEFAULTS.trayOnClose),
    termsAccepted: bool(parsed.termsAccepted, false),
    demoPlayers: bool(parsed.demoPlayers, false),
    useRecommendedFlags: bool(parsed.useRecommendedFlags, DEFAULTS.useRecommendedFlags),
    autoInstallJava: bool(parsed.autoInstallJava, DEFAULTS.autoInstallJava),
    serversDir: str(parsed.serversDir, '', 400),
    javaPath: str(parsed.javaPath, '', 400),
    phpPath: str(parsed.phpPath, '', 400),
    port: intIn(parsed.port, 1, 65535, DEFAULTS.port),
    extraArgs: str(parsed.extraArgs, '', 600),
    autoBackupHours: Number(parsed.autoBackupHours) > 0 ? Math.min(168, Math.max(0, Number(parsed.autoBackupHours))) : 0,
    backupsKeep: intIn(parsed.backupsKeep, 1, 500, DEFAULTS.backupsKeep),
    consoleLines: intIn(parsed.consoleLines, 200, 20000, DEFAULTS.consoleLines),
  };
}

/* --------------------------------- i/o ---------------------------------- */

function init(userDataDir) {
  fs.mkdirSync(userDataDir, { recursive: true });
  file = path.join(userDataDir, 'envserver.json');
  // Always drop the cache. Pointing at a different folder and then reading the
  // previous folder's values is exactly the kind of stale-state bug that shows up
  // as "the wrong server directory".
  cache = null;
}

function read() {
  if (cache) return cache;

  let parsed = {};
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    parsed = {};
  }
  cache = cleanSettings(parsed);
  return cache;
}

function persist(next) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    console.error('[store] write failed:', err.message);
  }
}

function write(patch) {
  const current = read();
  const next = cleanSettings({ ...current, ...(patch || {}) });
  persist(next);
  cache = next;
  return next;
}

/* -------------------------------- servers -------------------------------- */

/** Every server, newest folder first is not useful - keep creation order. */
function listServers() {
  return read().servers.map((s) => ({ ...s }));
}

function getServer(id) {
  const found = read().servers.find((s) => s.id === id);
  return found ? { ...found } : null;
}

function requireServer(id) {
  const found = getServer(id);
  if (!found) throw new Error('that server no longer exists');
  return found;
}

/**
 * Create a server folder and its record.
 *
 * The folder is created up front, along with a `server.properties` seeded from
 * the defaults, so the Config view has something real to edit before the server
 * has ever run.
 */
function createServer({ name, mcVersion, memory, port, extraArgs, type } = {}) {
  const current = read();
  const cleanName = str(name, 'ENV#1', 40);
  const cleanType = str(type, 'paper', 40) || 'paper';
  let id = paths.makeId(cleanName);

  // the id carries a random suffix, so a clash is very unlikely - but if it ever
  // happens, retry rather than silently writing two records for one folder
  let guard = 0;
  while (current.servers.some((s) => s.id === id) && guard++ < 20) id = paths.makeId(cleanName);
  if (current.servers.some((s) => s.id === id)) throw new Error('could not find a free folder name for that server');

  const record = cleanServer({
    id,
    name: cleanName,
    mcVersion: str(mcVersion, '', 30),
    type: cleanType,
    memory: memory || current.memory,
    // A Bedrock server defaults to 19132 rather than the Java 25565. This is the
    // one default that follows the software, because getting it wrong produces a
    // server that starts perfectly and that nobody can join.
    port: port === undefined ? softwarePort(cleanType, current.port) : port,
    extraArgs: extraArgs === undefined ? current.extraArgs : extraArgs,
    createdAt: Date.now(),
    lastStartedAt: 0,
  });

  fs.mkdirSync(paths.serverDir(id), { recursive: true });

  const servers = [...current.servers, record];
  write({ servers, activeServerId: id });
  return record;
}

function updateServer(id, patch) {
  const current = read();
  const servers = current.servers.map((s) => (s.id === id ? cleanServer({ ...s, ...patch, id: s.id }) : s));
  if (!servers.some((s) => s.id === id)) throw new Error('that server no longer exists');
  write({ servers });
  return getServer(id);
}

function removeServer(id) {
  const current = read();
  const servers = current.servers.filter((s) => s.id !== id);
  if (servers.length === current.servers.length) return { ok: false, error: 'that server no longer exists' };

  const pins = { ...current.javaPerServer };
  delete pins[id];

  const activeServerId =
    current.activeServerId === id ? servers[0]?.id || '' : current.activeServerId;

  write({ servers, javaPerServer: pins, activeServerId });
  return { ok: true, activeServerId };
}

/* --------------------------------- pins --------------------------------- */

function setJavaPin(serverId, javaPath) {
  const current = read();
  if (!current.servers.some((s) => s.id === serverId)) return { ok: false, error: 'that server no longer exists' };

  const pins = { ...current.javaPerServer };
  const clean = str(javaPath, '', 400);
  if (clean) pins[serverId] = clean;
  else delete pins[serverId]; // empty means "back to automatic"

  write({ javaPerServer: pins });
  return { ok: true, pinned: clean };
}

function clearJavaPin(serverId) {
  return setJavaPin(serverId, '');
}

module.exports = {
  DEFAULTS,
  init,
  read,
  write,
  listServers,
  getServer,
  requireServer,
  createServer,
  updateServer,
  removeServer,
  setJavaPin,
  clearJavaPin,
  cleanServer,
  cleanSettings,
  memoryPair,
  intIn,
  str,
  bool,
};