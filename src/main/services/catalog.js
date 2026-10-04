'use strict';

const paper = require('./paper');
const purpur = require('./purpur');
const vanilla = require('./vanilla');
const bedrock = require('./bedrock');
const pocketmine = require('./pocketmine');
const runtime = require('./runtime');

/**
 * One way to ask "what versions exist, install one" for every server software.
 *
 * This existed as three namespaces - `paper:*`, `vanilla:*`, `purpur:*` - which
 * the renderer then had to branch on, because Spigot and CraftBukkit had no
 * namespace at all despite being listed as software. Adding Bedrock would have
 * meant two more namespaces and two more branches in four places in the renderer.
 *
 * So every software id resolves to a catalogue module with the same five methods,
 * and the renderer's job is to pass an id rather than to know which server talks
 * to which API. `folia` and `paper` share a module because they are the same API
 * with a different project id; `spigot`, `bukkit` and `custom` share the Paper
 * *catalogue* but never install anything, because none of them publish a
 * downloadable jar.
 *
 * Every module provides:
 *   listVersions({ refresh, signal })  -> { versions, error, cached, source }
 *   listBuilds(mcVersion, o)          -> [{ build, url, size, sha256, time }]
 *   meta(mcVersion)                   -> { javaMajor, recommendedFlags, ... } | null
 *   requiredJava(mcVersion)           -> number, 0 when Java is not involved
 *   install({ serverId, mcVersion, build, signal, onProgress })
 *   remove(serverId)
 */

/** Software whose jar the user supplies, so only the *catalogue* is borrowed. */
const MANUAL = new Set(['spigot', 'bukkit', 'custom']);

/**
 * Wrap a catalogue that must not install anything.
 *
 * Spigot and CraftBukkit have no public download API and Custom JAR is by
 * definition something the user already has. Listing versions is still useful -
 * the right one has to be recorded so the right Java is chosen - so the read
 * half of the API is kept and only the write half is replaced.
 */
function readOnly(inner, what) {
  return {
    listVersions: (o) => inner.listVersions(o),
    listBuilds: (v, o) => inner.listBuilds(v, o),
    meta: (v, o) => inner.meta(v, o),
    requiredJava: (v) => inner.requiredJava(v),
    defaultPort: () => 25565,
    install: async () => {
      throw new Error(`${what} has no public download, so EnvServer cannot install it for you - put your own file in the server folder`);
    },
    remove: async () => ({ ok: true, removed: 0 }),
    friendly: (err) => inner.friendly(err),
    manual: true,
  };
}

const CATALOGUES = {
  paper: paper,
  folia: paper,
  purpur,
  vanilla,
  bedrock,
  pocketmine,
  spigot: readOnly(paper, 'Spigot'),
  bukkit: readOnly(paper, 'CraftBukkit'),
  custom: readOnly(paper, 'A custom jar'),
};

/** The catalogue for a software id, or null when the id is unknown. */
function forSoftware(id) {
  const key = String(id || '').toLowerCase();
  if (Object.prototype.hasOwnProperty.call(CATALOGUES, key)) return CATALOGUES[key];
  // an unknown id is an old record, not a crash: paper is the safe default
  return CATALOGUES.paper;
}

/** Is this software one the user has to install by hand? */
function isManual(id) {
  const key = String(id || '').toLowerCase();
  return MANUAL.has(key);
}

/** Can EnvServer download this software's files? */
function canInstall(id) {
  return !isManual(id) && runtime.isKnown(id);
}

/** The port this software listens on by default. */
function defaultPort(id) {
  const cat = forSoftware(id);
  return typeof cat.defaultPort === 'function' ? cat.defaultPort() : 25565;
}

/**
 * The version list for a software id, normalised.
 *
 * Wrapping rather than trusting each module to return the same shape means a new
 * catalogue cannot quietly give the Versions view a different set of fields.
 */
async function listVersions(id, { refresh = false, signal = null } = {}) {
  const key = String(id || '').toLowerCase();
  const cat = forSoftware(key);

  // Spigot/CraftBukkit/Custom read their list from Paper's API but must not
  // report Paper's downloads as if they were installable
  const res = await cat.listVersions({ refresh, signal });
  const versions = Array.isArray(res?.versions) ? res.versions : [];

  return {
    versions,
    error: res?.error || null,
    cached: Boolean(res?.cached),
    source: res?.source || 'network',
    canInstall: canInstall(key),
    port: defaultPort(key),
  };
}

async function listBuilds(id, mcVersion, { refresh = false, signal = null } = {}) {
  const key = String(id || '').toLowerCase();
  const cat = forSoftware(key);
  const builds = (await cat.listBuilds(mcVersion, { refresh, signal })) || [];
  return { builds, meta: cat.meta ? cat.meta(mcVersion) || null : null };
}

/** A one-line description of a failure, from whichever catalogue produced it. */
function friendly(id, err) {
  const cat = forSoftware(id);
  return cat.friendly ? cat.friendly(err) : String(err?.message || err || '');
}

module.exports = {
  CATALOGUES,
  MANUAL,
  forSoftware,
  isManual,
  canInstall,
  defaultPort,
  listVersions,
  listBuilds,
  friendly,
};
