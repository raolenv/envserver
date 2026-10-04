'use strict';

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

/**
 * What actually runs a server.
 *
 * EnvServer started as a Paper manager, so `server.js` used to assume a JVM:
 * `java -jar paper.jar`, a Java major to match, `jcmd` for the heap, an `eula.txt`
 * to tick. That assumption is Java-shaped, not Minecraft-shaped, and Bedrock
 * breaks all four at once:
 *
 *   PocketMine-MP        a PHP project  -> `php PocketMine-MP.phar`, no Java at all
 *   Bedrock Dedicated   a native binary -> `bedrock_server.exe`, no runtime at all
 *
 * So every piece of that is looked up here by software id instead of being
 * assumed. Adding a platform means adding a row to `SOFTWARE`, a row here, and a
 * catalogue that can install it - not teaching the launcher about PHP.
 *
 * Kept deliberately separate from the renderer's `software.js`, which owns the
 * wording and the icons. Two tables, one subject each, and a unit test asserting
 * they cover exactly the same ids - a runtime with no UI entry would be software
 * nobody can create, and a UI entry with no runtime would be software that cannot
 * start.
 */

/**
 * @typedef {object} Runtime
 * @property {'java'|'php'|'none'} kind how the process is launched
 * @property {string} entry        file inside the server folder that is executed
 * @property {string} label        what to call the runtime in the UI
 * @property {boolean} eula        whether the Minecraft eula.txt gate applies
 * @property {string} [min]        lowest runtime version that works, for the UI
 * @property {RegExp} ready        the line that means the server is up
 * @property {string} missing      what to call the entry point when it is absent
 * @property {boolean} [native]    true when the entry point is a .exe we did not build
 */

/** @type {Record<string, Runtime>} */
const RUNTIMES = {
  // --- Java: everything that ships a Bukkit/Paper-line server jar -----------
  paper: java('PaperMC'),
  folia: java('Folia'),
  purpur: java('Purpur'),
  vanilla: java('Vanilla'),
  spigot: java('Spigot'),
  bukkit: java('CraftBukkit'),
  custom: java('Custom JAR'),

  // --- Bedrock: no JVM anywhere --------------------------------------------
  bedrock: {
    kind: 'none',
    entry: 'bedrock_server.exe',
    label: 'Native (no Java)',
    eula: false,
    native: true,
    // Mojang's server prints this once the world is loaded and the port is open.
    // It is the only line that means "players can connect", as opposed to the
    // hundreds of lines before it that mean "still starting".
    ready: /\[(?:Server|GameServer)\]\s+Server started/i,
    missing: 'bedrock_server.exe',
  },

  pocketmine: {
    kind: 'php',
    entry: 'PocketMine-MP.phar',
    label: 'PHP',
    // PocketMine has no eula.txt and Mojang's terms are not its terms.
    eula: false,
    min: '8.1',
    // PocketMine-MP deliberately keeps Bukkit's "Done (…)" line so that the
    // scripts people already have keep working.
    ready: /Done \([^)]*\)! For help, type "help"/,
    missing: 'PocketMine-MP.phar',
  },
};

function java(label) {
  return {
    kind: 'java',
    entry: 'paper.jar',
    label: 'Java',
    eula: true,
    // the same line Paper and vanilla print, already used by the Java path
    ready: /Done \([^)]*\)! For help, type "help"/,
    missing: 'Paper jar',
  };
}

/**
 * The runtime for a software id.
 *
 * Unknown ids fall back to Paper rather than throwing: a stored server record
 * can outlive the app version that created it, and a server that cannot be
 * described is a server the user cannot start or explain.
 */
function forSoftware(id) {
  const key = String(id || '').toLowerCase();
  return RUNTIMES[key] || RUNTIMES.paper;
}

/** Does this id have a real row, as opposed to the Paper fallback? */
function isKnown(id) {
  return Object.prototype.hasOwnProperty.call(RUNTIMES, String(id || '').toLowerCase());
}

/** Every software id the runtime table knows, for the parity test. */
function ids() {
  return Object.keys(RUNTIMES);
}

/** Absolute path of the file this software runs. */
function entryPath(serverId, softwareId) {
  return path.join(paths.serverDir(paths.segment(serverId)), forSoftware(softwareId).entry);
}

/**
 * Is the thing this software runs actually on disk?
 *
 * For Bedrock this is more than "the exe exists": Mojang's zip unpacks the
 * binary and its libraries side by side, and a binary with no `world/` and no
 * `server.properties` beside it cannot start. Checking for the exe alone would
 * report a half-unpacked install as ready.
 */
function installState(serverId, softwareId) {
  const rt = forSoftware(softwareId);
  const file = entryPath(serverId, softwareId);

  if (!paths.exists(file)) return { installed: false, size: 0, modified: 0, file };

  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch {
    return { installed: false, size: 0, modified: 0, file };
  }

  // the jar is always written as paper.jar whatever the upstream name is, so the
  // launch command line never has to be rebuilt after an upgrade - and a zero
  // byte jar is a failed download, not an install
  if (rt.kind === 'java' && stat.size === 0) {
    return { installed: false, size: 0, modified: 0, file };
  }

  return { installed: true, size: stat.size, modified: stat.mtimeMs, file };
}

/** The catalogue module that installs a software id, or null for manual jars. */
function catalogueKey(id) {
  const key = String(id || '').toLowerCase();
  return key;
}

/**
 * How to talk about this software's runtime in the UI.
 *
 * Returned to the renderer so the create form, the dashboard and Settings all
 * describe the same thing without each of them re-deriving "is this Java?".
 */
function describe(id) {
  const rt = forSoftware(id);
  return {
    kind: rt.kind,
    label: rt.label,
    eula: rt.eula,
    min: rt.min || '',
    entry: rt.entry,
    native: Boolean(rt.native),
    missing: rt.missing,
  };
}

/**
 * The pre-flight checks for a start, as data rather than as thrown errors.
 *
 * Split out from `start()` so the dashboard can show the same answer before the
 * user presses Start, rather than only after a failed attempt. Each entry is
 * `{ ok, level, text }` and `ok: false` entries are exactly the reasons `start()`
 * will refuse.
 *
 * @param {object} server the stored record
 * @param {object} [o] { runtime, eulaOk }
 * @returns {Array<{ok:boolean, level:string, text:string}>}
 */
function preflight(server, o = {}) {
  const rt = forSoftware(server.type);
  const checks = [];
  const files = installState(server.id, server.type);

  if (!files.installed) {
    checks.push({
      ok: false,
      level: 'warn',
      text: `${rt.missing} is not installed yet - pick a version in the Versions tab and install it.`,
    });
  }

  if (rt.eula && o.eulaOk === false) {
    checks.push({
      ok: false,
      level: 'warn',
      text: 'The Minecraft EULA has not been accepted for this server yet.',
    });
  }

  if (rt.kind === 'java' && o.java && !o.java.ok) {
    checks.push({ ok: false, level: 'warn', text: o.java.reason || 'no suitable Java runtime for this release' });
  }

  if (rt.kind === 'php' && o.php && !o.php.ok) {
    checks.push({ ok: false, level: 'warn', text: o.php.reason || 'no suitable PHP runtime for PocketMine-MP' });
  }

  return checks;
}

module.exports = {
  RUNTIMES,
  forSoftware,
  isKnown,
  ids,
  entryPath,
  installState,
  catalogueKey,
  describe,
  preflight,
};
