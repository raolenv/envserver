'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const paths = require('./paths');
const net = require('./net');
const zip = require('./zip');

/**
 * Java runtime discovery, per-Minecraft-version matching, and self-download.
 *
 * A Paper jar is compiled to a specific class-file version, so the JVM has to be
 * the one the release targets:
 *
 *   1.13 - 1.16.5   Java 8
 *   1.17 - 1.17.1   Java 16
 *   1.18 - 1.20.4   Java 17
 *   1.20.5 - 1.21.x Java 21
 *   26.x and newer  Java 25
 *
 * The Paper API states this per version (`java.version.minimum`), and that answer
 * is preferred over the table below; the table is only the offline fallback.
 *
 * The folder name is worthless as a hint - a folder called `jdk-17` can hold
 * Java 11 - so every candidate is probed with `java -version` and nothing is
 * believed until it answers.
 */

const COMMON_ROOTS = [
  'C:\\Program Files\\Eclipse Adoptium',
  'C:\\Program Files\\Java',
  'C:\\Program Files\\Microsoft',
  'C:\\Program Files\\Microsoft\\jdk',
  'C:\\Program Files\\Zulu',
  'C:\\Program Files\\BellSoft',
  'C:\\Program Files\\Amazon Corretto',
  'C:\\Program Files\\LibreOffice',
  'C:\\Program Files (x86)\\Java',
];

const JAVA_HOME = process.env.JAVA_HOME || '';
const PROBE_TIMEOUT = 8000;

/** Upper bound on probed executables, so a PATH full of junk cannot stall us. */
const MAX_CANDIDATES = 24;

const TEMURIN_API = 'https://api.adoptium.net/v3/assets/latest';

/* ---------------------------- fallback matrix --------------------------- */

/**
 * Required Java feature version per Minecraft release, newest last.
 *
 * Only used when the Paper API cannot be reached; everything that can talk to
 * the network reads the authoritative number from `java.version.minimum`.
 */
const MATRIX = [
  { min: '1.17', max: '1.17.99', major: 16 },
  { min: '1.18', max: '1.20.4', major: 17 },
  { min: '1.20.5', max: '1.99.99', major: 21 },
];

/** First component of a version, i.e. `26.3` -> 26. */
function majorLine(v) {
  return parseInt(String(v || '').split(/[.\-]/)[0], 10) || 0;
}

/**
 * Java for Minecraft's post-1.x releases.
 *
 * Everything from `2.x` on follows the year-based scheme (26.1, 26.2, 26.3). The
 * 1.x range table above cannot express that: `26.3` sorts above its own
 * `1.99.99` ceiling and would fall through to the Java 8 default, which is
 * exactly the kind of silently-wrong answer that leaves a server refusing to
 * boot with an unreadable error.
 */
const FUTURE_JAVA = 25;

/**
 * Compare two dotted versions numerically, ignoring anything after a dash
 * ("1.21.4-rc1" and "1.21.4" compare equal, which is what we want here).
 */
function compareVersions(a, b) {
  const pa = String(a || '')
    .split('-')[0]
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '')
    .split('-')[0]
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Java feature version a Minecraft release needs, without touching the network. */
function requirementFor(mcVersion) {
  const v = String(mcVersion || '');
  if (!v) return 0;
  // check the year-based line before the 1.x ranges, which cannot describe it
  if (majorLine(v) >= 2) return FUTURE_JAVA;
  for (const row of MATRIX) {
    if (compareVersions(v, row.min) >= 0 && compareVersions(v, row.max) <= 0) return row.major;
  }
  // everything below 1.17 on Paper still targets Java 8
  return 8;
}

/** The Minecraft ranges one Java feature version covers. */
function coverageFor(major) {
  const m = Number(major) || 0;
  if (!m) return [];
  if (m < 8) return [];
  if (m === 8) return [{ min: '1.7.10', max: '1.16.5' }];
  if (m === 16) return [{ min: '1.17', max: '1.17.1' }];
  if (m === 17) return [{ min: '1.18', max: '1.20.4' }];
  if (m === 21) return [{ min: '1.20.5', max: '1.21.x' }];
  if (m >= 22) return [{ min: '26.x', max: 'newer' }];
  return [];
}

/* ------------------------------ discovery ------------------------------- */

/**
 * Every `java.exe` worth probing, most authoritative first:
 * explicit override -> self-downloaded -> JAVA_HOME -> Program Files -> PATH.
 *
 * Ordering only decides ties; correctness of the *match* comes from the probe.
 */
function* candidates(explicit) {
  if (explicit) {
    yield /java\.exe$/i.test(explicit) ? explicit : path.join(explicit, 'bin', 'java.exe');
  }

  // runtimes this app downloaded for itself live under <data>/runtime/<major>
  let bundled = [];
  try {
    bundled = fs.readdirSync(paths.runtimeDir(), { withFileTypes: true });
  } catch {
    bundled = [];
  }
  for (const entry of bundled) {
    if (!entry.isDirectory()) continue;
    const found = findJavaExe(paths.runtimeDirFor(entry.name), 3);
    if (found) yield found;
  }

  if (JAVA_HOME) yield path.join(JAVA_HOME, 'bin', 'java.exe');

  for (const root of COMMON_ROOTS) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const found = findJavaExe(path.join(root, entry.name), 2);
      if (found) yield found;
    }
    // Adoptium also drops a "jdk-17.0.9+7" folder directly in the root
    if (fs.existsSync(path.join(root, 'bin', 'java.exe'))) {
      yield path.join(root, 'bin', 'java.exe');
    }
  }

  yield path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'java.exe');
  yield 'java';
}

/**
 * Depth-limited search for `bin/java.exe`.
 *
 * A JDK archive unpacks to `<zip root>/jdk-21.0.12+1/bin/java.exe`, so the runtime
 * folder is one level deeper than the java.exe itself suggests.
 */
function findJavaExe(root, depth = 2) {
  const direct = path.join(root, 'bin', 'java.exe');
  if (fs.existsSync(direct)) return direct;
  if (depth <= 0) return null;
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findJavaExe(path.join(root, entry.name), depth - 1);
    if (found) return found;
  }
  return null;
}

/**
 * Turn a bare command name into a real file path using PATH + PATHEXT.
 *
 * `child.spawnfile` keeps the original `"java"` on Windows, so without this the
 * PATH lookup and the absolute path behind it would be reported as two separate
 * runtimes of the same JDK.
 */
function resolveExecutable(name) {
  const input = String(name || '');
  if (!input || input.includes(path.sep)) return input;

  const exts = (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .filter(Boolean);

  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, input + ext);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {
        /* not here */
      }
    }
  }
  return input;
}

/**
 * Run `java -version` and read the feature version.
 *
 * `java -version` writes to **stderr**, not stdout - a probe that only listened on
 * stdout would report nothing at all.
 *
 * @returns {Promise<{javaExe:string, home:string, rawVersion:string, major:number, ok:boolean}|null>}
 */
function probe(javaExe) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    let timer = null;
    let child = null;

    const finish = (ok) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try {
        child?.kill();
      } catch {
        /* already gone */
      }
      const m = /version "([^"]+)"/.exec(out);
      if (!m) return resolve(null);
      const info = describeVersion(m[1]);
      if (!info) return resolve(null);
      resolve({ javaExe, home: path.dirname(path.dirname(javaExe)), rawVersion: info.raw, major: info.major, ok });
    };

    try {
      child = spawn(javaExe, ['-version'], { windowsHide: true });
      child.stdout?.on('data', (d) => (out += d));
      child.stderr?.on('data', (d) => (out += d));
      child.on('error', () => resolve(null));
      child.on('close', (code) => finish(code === 0));
      timer = setTimeout(() => finish(false), PROBE_TIMEOUT);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Parse a `java -version` string into a feature version.
 *
 *   "1.8.0_382"       -> 8    (legacy 1.x scheme)
 *   "17.0.9+11"       -> 17
 *   "21.0.1"          -> 21
 *   "9-ea"            -> 9
 *   "24-internal"     -> 24
 */
function describeVersion(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;

  const m = /^(\d+)(?:\.(\d+))?/.exec(s);
  if (!m) return null;

  const first = Number(m[1]);
  const second = Number(m[2]);
  if (!Number.isFinite(first)) return null;

  // the 1.x scheme: 1.8 means 8, 1.7 means 7. Java never shipped 1.9 this way.
  const major = first === 1 ? second : first;
  return { raw: s, major: Number.isFinite(major) ? major : 0 };
}

/* ------------------------------- matching ------------------------------- */

/**
 * How usable is `actualMajor` for a release that wants `requiredMajor`?
 *
 * @returns {'exact'|'newer'|'older'|'none'}
 */
function compat(requiredMajor, actualMajor) {
  if (!actualMajor) return 'none';
  if (actualMajor === Number(requiredMajor)) return 'exact';
  return actualMajor > Number(requiredMajor) ? 'newer' : 'older';
}

/**
 * Is a "newer" JVM actually safe, or only probably fine?
 *
 * There is no LWJGL problem on a server, so a forward-compatible JVM generally
 * runs a Paper release. The one real exception is the ancient Java 8 line: those
 * jars poke at JVM internals that have been closed off since Java 9, so Java 8
 * Paper on a modern JVM is a genuine risk rather than a formality.
 */
function forwardRisk(requiredMajor, actualMajor) {
  if (compat(requiredMajor, actualMajor) !== 'newer') return false;
  return Number(requiredMajor) <= 8 && Number(actualMajor) >= 17;
}

function byMajorAsc(a, b) {
  return a.major - b.major;
}

function byMajorDesc(a, b) {
  return b.major - a.major;
}

/** Newest patch release first, so 21.0.9 wins over 21.0.1. */
function byVersionDesc(a, b) {
  const pa = String(a.rawVersion || '').split(/[.\-_+]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b.rawVersion || '').split(/[.\-_+]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
  }
  return 0;
}

/**
 * Choose the runtime for a Minecraft release.
 *
 *  1. the exact feature version - the only real guarantee
 *  2. otherwise the *smallest* runtime above it, which is genuinely forward
 *     compatible and avoids handing the user a bleeding-edge JDK when a close
 *     match is already there
 *  3. otherwise nothing: an older JVM cannot load the class files at all
 *
 * Pure, so it is unit tested with no runtime installed.
 *
 * @param {number} requiredMajor
 * @param {Array<{javaExe:string, major:number, rawVersion?:string}>} runtimes
 */
function pickFor(requiredMajor, runtimes) {
  const list = (runtimes || []).filter((r) => r && r.major);
  if (!list.length) return null;

  const want = Number(requiredMajor) || 0;
  if (!want) return list.slice().sort(byMajorDesc)[0] || null;

  const exact = list.filter((r) => r.major === want);
  if (exact.length) return exact.slice().sort(byVersionDesc)[0];

  const newer = list.filter((r) => r.major > want).sort(byMajorAsc);
  if (newer.length) return newer[0];

  return null;
}

/** Human-readable reason why no runtime fits. */
function explainMissing(requiredMajor, mcVersion = '') {
  const what = mcVersion ? `Paper ${mcVersion}` : 'this Paper version';
  return (
    `${what} needs Java ${requiredMajor} and no usable runtime was found. ` +
    `EnvServer can download it for you from the Settings -> Java panel.`
  );
}

function explainMismatch(requiredMajor, actualMajor, mcVersion = '') {
  const what = mcVersion ? `Paper ${mcVersion}` : 'this Paper version';
  if (Number(actualMajor) < Number(requiredMajor)) {
    return (
      `${what} is compiled for Java ${requiredMajor}. Java ${actualMajor} cannot load its class files - ` +
      `it fails with UnsupportedClassVersionError before the server ever starts.`
    );
  }
  if (forwardRisk(requiredMajor, actualMajor)) {
    return (
      `${what} targets Java ${requiredMajor}. It may start on Java ${actualMajor}, but releases from that ` +
      `era reach into JVM internals that were closed off in Java 9 - expect crashes if it does run.`
    );
  }
  return `${what} targets Java ${requiredMajor}; Java ${actualMajor} is newer and should work.`;
}

/* -------------------------------- public -------------------------------- */

/**
 * Every usable runtime, newest feature version first.
 *
 * @param {object} [o]
 * @param {string} [o.javaPath] explicit override, probed first
 * @returns {Promise<Array<{javaExe:string, home:string, rawVersion:string, major:number}>>}
 */
async function listRuntimes({ javaPath } = {}) {
  const out = [];
  const seen = new Set();
  let probes = 0;

  for (const candidate of candidates(javaPath)) {
    if (candidate.includes(path.sep) && !fs.existsSync(candidate)) continue;
    if (++probes > MAX_CANDIDATES) break;

    const exe = resolveExecutable(candidate);
    const info = await probe(exe);
    if (!info?.ok || !info.major) continue;

    // dedupe on the resolved binary, because `java` on PATH and the absolute path
    // behind it are one runtime and every candidate ends in java.exe
    let key;
    try {
      key = fs.realpathSync(info.javaExe).toLowerCase();
    } catch {
      key = path.resolve(info.javaExe).toLowerCase();
    }
    if (seen.has(key)) continue;
    seen.add(key);

    out.push(info);
  }

  out.sort((a, b) => b.major - a.major || byVersionDesc(a, b));
  return out;
}

/**
 * Does this probed runtime correspond to the given path?
 *
 * A pin or an override can name either `...\bin\java.exe` or the JDK root, and
 * Windows paths are case-insensitive, so both forms must match.
 */
function sameRuntime(runtime, target) {
  const raw = String(target || '');
  if (!raw) return false;
  try {
    const want = path.resolve(raw).toLowerCase();
    return (
      path.resolve(runtime.javaExe).toLowerCase() === want ||
      path.resolve(runtime.home).toLowerCase() === want
    );
  } catch {
    return false;
  }
}

/**
 * Resolve the JVM for one Paper release.
 *
 * Priority: an explicit pin for this server -> the global override -> the best
 * automatic match. A pin wins even when its feature version does not fit, because
 * the user chose it by name; the mismatch is reported so the UI can warn instead
 * of silently substituting something else.
 *
 * @param {object} o
 * @param {number} o.requiredMajor
 * @param {string} [o.pinned]   java path pinned to this specific server
 * @param {string} [o.javaPath] global override
 * @param {Array} [o.runtimes]  pre-probed runtimes, to avoid a rescan
 * @returns {Promise<null | {
 *   javaExe:string, major:number, rawVersion:string, home:string,
 *   source:'pinned'|'override'|'auto',
 *   match:'exact'|'newer'|'older'|'none',
 *   risk:boolean
 * }>}
 */
async function resolveFor({ requiredMajor, pinned, javaPath, runtimes = null } = {}) {
  const list = runtimes || (await listRuntimes({ javaPath }));
  const find = (target) => list.find((r) => sameRuntime(r, target));

  const fromPath = async (target, source) => {
    const known = find(target);
    const exe = /java\.exe$/i.test(target) ? target : path.join(target, 'bin', 'java.exe');
    const rt = known || (await probe(exe));
    if (!rt || (!rt.ok && !known)) return null;
    return {
      ...rt,
      source,
      match: compat(requiredMajor, rt.major),
      risk: forwardRisk(requiredMajor, rt.major),
    };
  };

  if (pinned) {
    const rt = await fromPath(pinned, 'pinned');
    if (rt) return rt;
    // a pin that no longer exists must not block the automatic match
  }

  if (javaPath) {
    const rt = await fromPath(javaPath, 'override');
    if (rt) return rt;
  }

  const best = pickFor(requiredMajor, list);
  if (!best) return null;
  return {
    ...best,
    source: 'auto',
    match: compat(requiredMajor, best.major),
    risk: forwardRisk(requiredMajor, best.major),
  };
}

/* --------------------------- self-downloaded JDK ------------------------ */

/** Ask Adoptium for the newest GA Temurin JDK of a feature version. */
async function temurinAsset(major) {
  const want = Number(major) || 0;
  if (want < 8) throw new Error(`Java ${want} is not a thing`);
  const url =
    `${TEMURIN_API}/${want}/hotspot` +
    `?architecture=x64&image_type=jdk&os=windows&vendor=eclipse`;
  const data = await net.getJson(url);
  const list = Array.isArray(data) ? data : [data];
  for (const item of list) {
    const pkg = item?.binary?.package;
    if (pkg?.link && pkg?.checksum) {
      return {
        major: Number(item?.version?.major) || want,
        release: item.release_name || `Java ${want}`,
        url: pkg.link,
        sha256: pkg.checksum,
        size: Number(pkg.size) || 0,
        name: pkg.name || `temurin-${want}.zip`,
      };
    }
  }
  throw new Error(`Eclipse Temurin publishes no Java ${want} JDK for Windows x64`);
}

/**
 * Make sure a Java `major` is on disk, downloading it if it is not.
 *
 * The archive is kept so a corrupted or half-extracted runtime can be repaired
 * without going back to the network.
 *
 * @param {number} major
 * @param {object} [o]
 * @param {(p:{received:number,total:number,speed:number,phase:string})=>void} [o.onProgress]
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<{javaExe:string, home:string, rawVersion:string, major:number}>}
 */
async function ensureRuntime(major, o = {}) {
  const { onProgress = null, signal = null, force = false } = o;
  const want = Number(major) || 0;
  if (want < 8) throw new Error(`Java ${want} is not a thing`);

  const targetDir = paths.runtimeDirFor(want);

  if (!force) {
    const found = findJavaExe(targetDir, 3);
    if (found) {
      const rt = await probe(found);
      if (rt?.ok && rt.major === want) return rt;
    }
  }

  onProgress?.({ received: 0, total: 0, speed: 0, phase: 'Looking up Temurin...' });
  const asset = await temurinAsset(want);

  onProgress?.({ received: 0, total: asset.size, speed: 0, phase: `Downloading ${asset.release}` });
  const archive = paths.runtimeZip(want);
  await net.download(asset.url, archive, {
    sha256: asset.sha256,
    expectedSize: asset.size || null,
    signal,
    onProgress: (p) =>
      onProgress?.({ received: p.received, total: p.total || asset.size, speed: p.speed || 0, phase: 'Downloading JDK' }),
  });

  onProgress?.({ phase: 'Extracting JDK', received: asset.size, total: asset.size, speed: 0 });
  // a stale half-extraction would be picked up as a valid install, so clear it
  await fsp.rm(targetDir, { recursive: true, force: true });
  await fsp.mkdir(targetDir, { recursive: true });

  const res = await zip.extractAll(archive, targetDir, {
    signal,
    onProgress: (done, total) => {
      const pct = total ? (done / total) * 100 : 0;
      onProgress?.({ phase: 'Extracting JDK', percent: Math.round(pct) });
    },
  });
  if (!res.files) throw new Error('that archive contained no files');

  const exe = findJavaExe(targetDir, 3);
  if (!exe) throw new Error('the JDK archive unpacked but no bin\\java.exe was found in it');

  const rt = await probe(exe);
  if (!rt?.ok) throw new Error('the downloaded JDK did not answer `java -version`');
  if (rt.major !== want) {
    throw new Error(`asked for Java ${want} but the archive contains Java ${rt.major}`);
  }

  onProgress?.({ phase: 'Ready', received: asset.size, total: asset.size, speed: 0 });
  return rt;
}

/** Runtime folders this app manages itself, keyed by feature version. */
function bundledMajors() {
  try {
    return fs
      .readdirSync(paths.runtimeDir(), { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
      .map((e) => Number(e.name))
      .sort((a, b) => b - a);
  } catch {
    return [];
  }
}

/** Forget a self-downloaded runtime (the zip is kept, so it can be re-extracted). */
function removeRuntime(major) {
  const dir = paths.runtimeDirFor(major);
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true, removed: dir };
}

module.exports = {
  listRuntimes,
  resolveFor,
  probe,
  pickFor,
  compat,
  forwardRisk,
  describeVersion,
  compareVersions,
  requirementFor,
  coverageFor,
  explainMissing,
  explainMismatch,
  temurinAsset,
  ensureRuntime,
  bundledMajors,
  removeRuntime,
  findJavaExe,
  resolveExecutable,
  sameRuntime,
  candidates,
  MATRIX,
  COMMON_ROOTS,
  PROBE_TIMEOUT,
  MAX_CANDIDATES,
};