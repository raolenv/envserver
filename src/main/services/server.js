'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');

const paths = require('./paths');
const java = require('./java');
const php = require('./php');
const runtime = require('./runtime');
const ping = require('./ping');
const config = require('./config');
const zip = require('./zip');

/**
 * The Paper process itself: command line, spawn, console streaming, and the
 * monitor loop that reports players, uptime and memory back to the UI.
 *
 * Exactly one process per server id may be up at a time. The registry below is
 * the only thing that knows about a running JVM, and every exit path goes
 * through `cleanup`, so a stop, a crash and an app quit all leave the same clean
 * state behind.
 */

/** Console events, forwarded to the renderer over IPC as `evt:*`. */
const bus = new EventEmitter();
bus.setMaxListeners(50);

/** serverId -> live state */
const running = new Map();

/* ------------------------------ log parsing ----------------------------- */

// log4j writes real ANSI escapes, so the console stream carries colour codes that
// have to come off before the text reaches the renderer.
const ANSI_CSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g;
const ANSI_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
// control bytes that are not part of a line: everything except tab (0x09) and
// newline (0x0a), which the chunk splitter handles itself
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Strip colour codes and stray control bytes so the UI never renders garbage. */
function cleanLine(text) {
  return String(text || '')
    .replace(ANSI_OSC, '')
    .replace(ANSI_CSI, '')
    .replace(CONTROL, '')
    .replace(/^[\s:]+/, '');
}

/**
 * Severity of one console line.
 *
 * Two shapes exist: `[12:34:56 INFO]: text` on older releases and
 * `[12:34:56] [Server thread/INFO]: text` from 1.17-ish on. A stack trace with no
 * level prefix at all still has to show up as an error.
 */
function classify(line) {
  const levelled = /\[([^\]]*\/(?:TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL)[^\]]*)\]/.exec(line);
  const level = levelled ? levelled[1].split('/').pop().toUpperCase() : '';
  if (level.startsWith('ERROR') || level.startsWith('FATAL')) return 'err';
  if (level.startsWith('WARN')) return 'warn';

  const legacy = /^\[\d{2}:\d{2}:\d{2}\s+([A-Z]+)/.exec(line);
  const legacyLevel = legacy ? legacy[1] : '';
  if (legacyLevel === 'ERROR' || legacyLevel === 'FATAL') return 'err';
  if (legacyLevel === 'WARN') return 'warn';

  if (
    /Exception in thread|Caused by:|^\s*at [\w.$]+\([\w.]+:\d+\)|\b(?:[a-z][\w$]*\.)*[A-Z]\w*(?:Exception|Error)\b/.test(line)
  ) {
    return 'err';
  }
  return 'info';
}

/*
 * Player join/leave, across the shapes Paper has used.
 *
 *   1.20 and older:  "Steve joined the game" / "Steve left the game"
 *   1.21+:           "Steve (/127.0.0.1:51234) logged in with entity id 123 at ..."
 *   every version:   "Steve (/127.0.0.1:51234) lost connection: Disconnected"
 *
 * The last one is the only signal that a player has gone, so it has to be handled
 * even though it is not phrased as a leave - otherwise the dashboard keeps showing
 * somebody who walked away an hour ago.
 */
const JOIN_RE = /(?:<)?([A-Za-z0-9_]{3,16})(?:>)?\s+(joined|left) the game/i;
const LOGIN_RE = /([A-Za-z0-9_]{3,16})\s+\(\/[\d.]+:\d+\)\s+logged in with entity id/i;
const LOST_RE = /([A-Za-z0-9_]{3,16})\s+\(\/[\d.]+\:\d+\)\s+lost connection/i;
const UUID_RE = /UUID of player ([A-Za-z0-9_]{3,16}) is ([0-9a-f-]{36})/i;

/**
 * The line that means "the server is up and the port is open".
 *
 * Per software, because Bedrock does not say this. Paper and vanilla print
 * `Done (12.345s)! For help, type "help"`, PocketMine-MP deliberately prints the
 * same line so that scripts people already have keep working, and Mojang's
 * Bedrock server announces itself differently. `runtime.js` owns the choice; this
 * fallback is the Java one so a software id from an old record still behaves.
 */
const READY_RE = /Done \([^)]*\)! For help, type "help"/;

/* ----------------------------- command line ----------------------------- */

/**
 * Assemble the JVM argv.
 *
 * `-Dfile.encoding=UTF-8` is not optional on Windows: Java 8 defaults to the
 * system code page, so player names and MOTDs with anything outside ASCII come
 * through as mojibake in the console.
 */
function buildArgs(o = {}) {
  const { memory = {}, recommended = [], extra = '', nogui = true, jar = 'paper.jar' } = o;
  const args = [];

  const min = clampMemory(memory.min, 256);
  // -Xmx below -Xms is refused by the JVM outright, so the ceiling follows the
  // minimum rather than producing a command line that can never start
  const max = Math.max(clampMemory(memory.max, min), min);
  args.push(`-Xms${min}M`, `-Xmx${max}M`);

  args.push('-Dfile.encoding=UTF-8');
  // the server has no UI at all; without this a headless AWT check can pop a dialog
  args.push('-Djava.awt.headless=true');

  for (const flag of recommended) {
    const trimmed = String(flag || '').trim();
    if (trimmed) args.push(trimmed);
  }

  for (const extraArg of String(extra || '').split(/\s+/).filter(Boolean)) args.push(extraArg);

  args.push('-jar', jar);
  if (nogui) args.push('nogui');
  return args;
}

function clampMemory(value, fallback) {
  const n = Math.round(Number(value) || 0);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  // the JVM cannot start below about 128 MB, and above ~32 GB it loses its
  // compressed object pointers, so both ends are real limits
  return Math.max(128, Math.min(32 * 1024, n));
}

/* ------------------------------ launch plan ------------------------------ */

/**
 * The command line for a server, for every runtime EnvServer supports.
 *
 * This is the piece that used to be `java -Xms… -Xmx… -jar paper.jar nogui`
 * written inline in `start()`. It is a function now because "how do I run this"
 * is a question with three answers and none of them is "ask a human":
 *
 *   java  java -Xms512M -Xmx2048M -Dfile.encoding=UTF-8 … -jar paper.jar nogui
 *   php   php -d memory_limit=2048M PocketMine-MP.phar
 *   none  bedrock_server.exe
 *
 * The memory fields mean something slightly different in each case, and saying so
 * rather than quietly passing `-Xmx` to something that is not a JVM is the whole
 * point:
 *
 *   java  `-Xmx` is the heap ceiling. The process will still exceed it.
 *   php   PHP has no separate heap; `memory_limit` is the *total* the process may
 *         allocate, so it maps to the ceiling more directly than -Xmx does. The
 *         minimum has no equivalent, so only the ceiling is passed.
 *   none  there is no runtime to configure. Bedrock reads its own settings from
 *         server.properties, so the memory fields are informational only - and
 *         `start()` says so rather than pretending to apply them.
 *
 * @param {object} server the stored record
 * @param {object} o
 * @param {string} o.exe     the runtime executable, already resolved
 * @param {object} [o.memory] { min, max }
 * @param {string[]} [o.recommended] Paper's recommended JVM flags
 * @param {string} [o.extra]  the user's own arguments, verbatim
 * @param {boolean} [o.nogui] Java only
 * @returns {{exe:string, args:string[], runtime:string}}
 */
function launchPlan(server, o = {}) {
  const rt = runtime.forSoftware(server?.type);
  const entry = path.basename(rt.entry);
  const memory = {
    min: clampMemory(o.memory?.min ?? server?.memory?.min ?? 1024, 1024),
    max: Math.max(clampMemory(o.memory?.max ?? server?.memory?.max ?? 4096, 4096), 1),
  };
  if (memory.max < memory.min) memory.max = memory.min;

  const extra = String(o.extra ?? server?.extraArgs ?? '')
    .split(/\s+/)
    .filter(Boolean);

  if (rt.kind === 'php') {
    // `-d memory_limit` is PHP's own ceiling and is the only one that exists
    return { exe: o.exe, args: ['-d', `memory_limit=${memory.max}M`, entry, ...extra], runtime: rt.kind, memory };
  }

  if (rt.kind === 'none') {
    // Bedrock takes no arguments. Passing `nogui` - the Java habit - would be
    // silently ignored by it, and worse, would be copied by anyone reading this
    // code as if it did something.
    return { exe: o.exe, args: [...extra], runtime: rt.kind, memory };
  }

  // java
  const args = buildArgs({
    memory,
    recommended: o.recommended,
    extra: extra.join(' '),
    nogui: o.nogui,
    jar: entry,
  });

  return { exe: o.exe, args, runtime: rt.kind, memory };
}

/** Total RAM on the machine, so the UI can suggest a sane ceiling. */
function totalMemoryMb() {
  return Math.round(os.totalmem() / (1024 * 1024));
}

/* -------------------------------- process ------------------------------- */

/** Resident memory of a process, in MB. `tasklist` is a few ms and needs no admin. */
function memoryMb(pid) {
  return new Promise((resolve) => {
    execFile(
      'tasklist',
      ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'],
      { windowsHide: true, timeout: 6000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) return resolve(0);
        // "java.exe","1234","Console","1","1.234.567 K"
        const m = /"([\d.,\s]+)\s*K"/.exec(stdout);
        if (!m) return resolve(0);
        const kb = parseInt(m[1].replace(/[.,\s]/g, ''), 10);
        return resolve(Number.isFinite(kb) ? Math.round(kb / 1024) : 0);
      }
    );
  });
}

/** Kill a process tree on Windows; `child.kill()` would orphan the JVM. */
function killTree(pid, signalName = 'SIGKILL') {
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 8000 }, () => resolve());
  });
}

/**
 * The JVM's own heap numbers, straight from the JVM.
 *
 * Why this has to exist: `-Xmx` is a ceiling on the *heap*, and the heap is only
 * one of the places a JVM keeps things. On top of it sit metaspace and the code
 * cache, one stack per thread (a Paper server runs well over a hundred), and -
 * the big one - Netty's network buffers, which Paper allocates off-heap through
 * `PlatformDependent.allocateDirect` and which are counted by Task Manager but
 * by no `-X` flag. A server with `-Xmx512M` legitimately shows 700-900 MB of
 * working set while being nowhere near out of memory. Reading the working set
 * and calling it "memory used" against a 512 MB ceiling is not a rounding
 * error, it is the wrong number entirely.
 *
 * `jcmd <pid> GC.heap_info` is the supported way to ask, and costs a few
 * milliseconds. It needs a JDK rather than a bare JRE, so when there is no
 * jcmd.exe next to the java.exe this server was launched with, the answer is
 * null and the UI shows the ceiling and the process total as two separate facts
 * instead of pretending the first one is the second.
 *
 * @returns {Promise<{usedMb:number,maxMb:number}|null>}
 */
async function heapInfo(pid, javaExe) {
  if (!pid || !javaExe) return null;

  // jcmd lives in the same bin/ as the java it inspects; it must match the
  // running JVM or the attach fails with a version error
  const jcmd = path.join(path.dirname(javaExe), 'jcmd.exe');
  try {
    if (!fs.existsSync(jcmd)) return null;
  } catch {
    return null;
  }

  const out = await new Promise((resolve) => {
    execFile(jcmd, [String(pid), 'GC.heap_info'], { windowsHide: true, timeout: 10_000, maxBuffer: 512 * 1024 }, (err, stdout) =>
      resolve(err ? '' : String(stdout || ''))
    );
  });

  return parseHeapInfo(out);
}

/**
 * `jcmd GC.heap_info` output -> MB, or null when it is not the shape we know.
 *
 * Two spellings, depending on the JDK, and the difference matters:
 *
 *   8/11: "garbage-first heap   total 524288K, used 209432K"
 *   21+:  "garbage-first heap   total reserved 524288K, committed 524288K, used 212672K"
 *
 * In the second one `total reserved` is how large the heap is *allowed* to grow,
 * which is not `-Xmx` - only `committed` is. Reading the wrong field would
 * report a 512 MB server as having a 32 GB heap and quietly defeat the point of
 * asking at all.
 */
function parseHeapInfo(text) {
  const m =
    /committed\s+(\d+)K,\s*used\s+(\d+)K/i.exec(String(text || '')) ||
    /total\s+(\d+)K,\s*used\s+(\d+)K/i.exec(String(text || ''));
  if (!m) return null;
  const maxKb = Number(m[1]);
  const usedKb = Number(m[2]);
  if (!Number.isFinite(maxKb) || !Number.isFinite(usedKb) || maxKb <= 0) return null;
  return { usedMb: Math.round(usedKb / 1024), maxMb: Math.round(maxKb / 1024) };
}

/** `jcmd` attaches to the JVM and takes a safepoint; every 4 s would show. */
const HEAP_TTL_MS = 15_000;

/**
 * Start a server.
 *
 * Which runtime is involved is decided by `runtime.js`, not here. Everything this
 * function does that used to be unconditional - check for a jar, match a Java
 * major, refuse without an accepted eula.txt - is now conditional on it, and a
 * Bedrock or PocketMine server reaches the same spawn with none of that.
 *
 * @param {object} server the stored record: id, name, type, mcVersion, memory...
 * @param {object} o
 * @param {number} [o.requiredMajor] Java feature version this release needs
 * @param {string[]} [o.recommended] Paper's recommended JVM flags
 * @param {object} [o.settings] global settings (extra args, memory overrides)
 */
async function start(server, o = {}) {
  const id = paths.segment(server.id);
  if (running.has(id)) throw new Error('this server is already running');

  const rt = runtime.forSoftware(server.type);
  const dir = paths.serverDir(id);

  // --- is there anything to run? -------------------------------------------
  const files = runtime.installState(id, server.type);
  if (!files.installed) {
    throw new Error(
      rt.kind === 'java'
        ? 'this server has no server jar yet - install a version first'
        : `this server has no ${rt.missing} yet - install a version first`
    );
  }

  // A world folder can only be owned by one process at a time. If a previous
  // EnvServer quit uncleanly, or a user starts the same server twice, the second
  // process crashes with a crystal-clear `world locked` error and the UI looks
  // broken. Detect the orphaned owner up front and refuse the start with an
  // actionable message instead of a Java stack trace.
  const pidsFile = path.join(paths.tmpDir(), `${id}.pid.json`);
  try {
    const info = JSON.parse(fs.readFileSync(pidsFile, 'utf8'));
    const pid = Number(info?.pid);
    if (pid > 0 && process.kill(pid, 0)) {
      throw new Error(
        `this server's world folder is already owned by another ${rt.kind === 'java' ? 'java' : 'server'} process (PID ${pid}). Stop that process before starting this one.`
      );
    }
  } catch (err) {
    if (err instanceof Error && /already owned/.test(err.message)) throw err;
    // file missing or unreadable: there is no live owner, safe to proceed
  }

  // --- the Mojang EULA gate, for the software that has one ------------------
  // Bedrock's terms are accepted on Mojang's download page and PocketMine has
  // none of its own, so neither writes an eula.txt and neither is blocked here.
  const eulaOk = rt.eula ? config.readEula(paths.serverEula(id)) : true;
  if (!eulaOk) throw new Error('the Minecraft EULA has not been accepted for this server yet');

  // --- resolve the runtime -------------------------------------------------
  let exe = '';
  let javaExe = '';
  let javaInfo = null;
  let phpInfo = null;
  const requiredMajor = rt.kind === 'java' ? o.requiredMajor || java.requirementFor(server.mcVersion) : 0;

  if (rt.kind === 'java') {
    const resolution = await java.resolveFor({
      requiredMajor,
      pinned: server.javaPath || '',
      javaPath: o.javaPath || '',
    });
    if (!resolution) throw new Error(java.explainMissing(requiredMajor, server.mcVersion));
    if (resolution.match === 'older') throw new Error(java.explainMismatch(resolution.major, requiredMajor, server.mcVersion));
    exe = resolution.javaExe;
    javaExe = resolution.javaExe;
    javaInfo = {
      major: resolution.major,
      match: resolution.match,
      risk: Boolean(resolution.risk),
      source: resolution.source,
    };
  } else if (rt.kind === 'php') {
    const found = await php.resolveFor({ pinned: o.phpPath || server.phpPath || '' });
    if (!found) throw new Error(php.explainMissing(null));
    if (!found.ok) throw new Error(php.explainMissing(found));
    exe = found.exe;
    phpInfo = { version: found.version, major: found.major, minor: found.minor, exe: found.exe };
  } else {
    exe = runtime.entryPath(id, server.type);
    if (!paths.exists(exe)) throw new Error(`${rt.missing} is missing from this server's folder`);
  }

  const memory = {
    min: clampMemory(o.memory?.min ?? server.memory?.min ?? 1024, 1024),
    max: clampMemory(o.memory?.max ?? server.memory?.max ?? 4096, 4096),
  };
  if (memory.max < memory.min) memory.max = memory.min;

  const plan = launchPlan(server, {
    exe,
    memory,
    recommended: o.useRecommendedFlags === false ? [] : o.recommended || [],
    extra: o.extraArgs ?? server.extraArgs ?? '',
    nogui: o.nogui !== false,
  });

  await fsp.mkdir(dir, { recursive: true });

  // record the owner so a second launch cannot start the same world
  await fsp.writeFile(pidsFile, JSON.stringify({ pid: 0, exe, ts: Date.now() }));

  const child = spawn(plan.exe, plan.args, {
    cwd: dir,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  const state = {
    serverId: id,
    name: server.name,
    type: server.type,
    child,
    pid: child.pid,
    // `ready` is per software; Bedrock does not print Paper's line
    ready: rt.ready || READY_RE,
    runtimeKind: rt.kind,
    javaExe,
    exe: plan.exe,
    php: phpInfo,
    argv: [plan.exe, ...plan.args],
    memory,
    startedAt: Date.now(),
    readyAt: 0,
    phase: 'starting',
    players: new Map(),
    pendingUuids: new Map(),
    port: Number(server.port) || (rt.kind === 'java' ? 25565 : 19132),
    stopRequested: false,
    exitCode: null,
    stopTimer: null,
    monitor: null,
    backupTimer: null,
  };
  running.set(id, state);
  await fsp.writeFile(pidsFile, JSON.stringify({ pid: child.pid, exe: plan.exe, ts: Date.now() }));

  // --- say what was actually chosen, once, at the moment it matters ---------
  if (rt.kind === 'java') {
    emitLog(id, `Starting with Java ${javaInfo.major} (${javaInfo.match === 'exact' ? 'exact match' : 'newer than required'})`, 'info');
    emitLog(id, `Memory: ${memory.min} MB - ${memory.max} MB (-Xms/-Xmx)`, 'info');
    warnAboutHeapCeiling(id, memory);
  } else if (rt.kind === 'php') {
    emitLog(id, `Starting with PHP ${phpInfo.version} (${phpInfo.exe})`, 'info');
    emitLog(id, `Memory: PHP memory_limit is ${memory.max} MB. PHP has one limit, not a separate heap, so this is the most the process can allocate in total.`, 'info');
  } else {
    emitLog(id, `Starting ${path.basename(plan.exe)} - no JVM involved`, 'info');
    emitLog(
      id,
      'This software configures itself in server.properties, so the memory fields in EnvServer are shown for reference and are not passed to it.',
      'info'
    );
  }

  emitStatus(state);

  attachConsole(state);
  attachExit(state);

  startMonitor(state);
  scheduleAutoBackup(state, o.autoBackupHours);
  await config.pruneLogs(id, o.logsToKeep || 5);

  return publicStatus(state);
}

/**
 * Warn when the heap ceiling cannot be honoured by this machine.
 *
 * Only meaningful for Java. `-Xmx` is a request, not a reservation: asking for
 * more than the machine has does not fail, it crawls, and the pagefile thrashing
 * looks like the server's fault.
 */
function warnAboutHeapCeiling(id, memory) {
  const installedMb = totalMemoryMb();
  const headroomMb = installedMb - memory.max;

  if (installedMb && headroomMb < 2048) {
    emitLog(
      id,
      headroomMb < 0
        ? `Warning: this machine has ${installedMb} MB of RAM, less than the ${memory.max} MB heap you asked for. Expect it to be slow or killed.`
        : `Warning: ${memory.max} MB leaves ${headroomMb} MB for Windows on a ${installedMb} MB machine. About 2 GB is needed to stay responsive.`,
      'warn'
    );
  }

  emitLog(id, 'Note: -Xmx is the heap only. Task Manager will show more - metaspace, thread stacks and off-heap buffers are extra.', 'info');
}

function attachConsole(state) {
  const { serverId } = state;
  let partial = '';

  const handle = (chunk) => {
    partial += chunk;
    let nl = partial.indexOf('\n');
    while (nl >= 0) {
      const line = cleanLine(partial.slice(0, nl));
      partial = partial.slice(nl + 1);
      if (line) handleLine(state, line);
      nl = partial.indexOf('\n');
    }
    // a runaway line with no newline would otherwise grow forever
    if (partial.length > 8000) {
      handleLine(state, cleanLine(partial));
      partial = '';
    }
  };

  state.child.stdout.setEncoding('utf8');
  state.child.stderr.setEncoding('utf8');
  state.child.stdout.on('data', handle);
  state.child.stderr.on('data', handle);
  state.child.on('error', (err) => {
    // deliberately not "could not start java": for a Bedrock or PocketMine
    // server there is no java in the story, and a message naming the wrong
    // runtime sends people looking in the wrong place
    emitLog(serverId, `Could not start the server process: ${err.message}`, 'err');
  });

  return serverId;
}

function handleLine(state, line) {
  const { serverId } = state;
  emitLog(serverId, line, classify(line));

  if (state.ready.test(line) && state.phase === 'starting') {
    state.phase = 'running';
    state.readyAt = Date.now();
    emitLog(serverId, 'Server is ready and accepting connections', 'ok');
    emitStatus(state);
    return;
  }

  const uuidMatch = UUID_RE.exec(line);
  if (uuidMatch) {
    state.pendingUuids.set(uuidMatch[1], uuidMatch[2].toLowerCase());
  }

  const joinMatch = JOIN_RE.exec(line);
  if (joinMatch) {
    const name = joinMatch[1];
    if (/^joined$/i.test(joinMatch[2])) state.players.set(name, { name, since: Date.now() });
    else state.players.delete(name);
    emitStatus(state);
    return;
  }

  const loginMatch = LOGIN_RE.exec(line);
  if (loginMatch) {
    state.players.set(loginMatch[1], { name: loginMatch[1], since: Date.now() });
    emitStatus(state);
    return;
  }

  // a disconnect is a leave, whatever the reason after the colon
  const lostMatch = LOST_RE.exec(line);
  if (lostMatch) {
    state.players.delete(lostMatch[1]);
    emitStatus(state);
    return;
  }

  // "Stopping the server" is the point of no return for a clean shutdown
  if (/Stopping the server|Saving worlds/.test(line) && state.phase !== 'stopping') {
    state.phase = 'stopping';
    emitStatus(state);
  }
}

function attachExit(state) {
  const { serverId } = state;
  state.child.on('close', (code, signal) => {
    state.exitCode = code === null ? null : code;
    if (state.stopTimer) clearTimeout(state.stopTimer);

    const clean = state.stopRequested;
    cleanup(state);

    emitLog(
      serverId,
      clean
        ? 'Server stopped'
        : `Server exited unexpectedly (${signal ? `signal ${signal}` : `code ${code}`})`,
      clean ? 'info' : 'err'
    );
    bus.emit('exit', {
      serverId,
      code: state.exitCode,
      signal: signal || null,
      clean,
      uptime: Date.now() - state.startedAt,
    });
    emitStatusFor(serverId, 'stopped');
  });
}

/** Release everything a live server holds. Safe to call twice. */
function cleanup(state) {
  if (state.monitor) clearInterval(state.monitor);
  if (state.backupTimer) clearInterval(state.backupTimer);
  if (state.stopTimer) clearTimeout(state.stopTimer);
  state.monitor = null;
  state.backupTimer = null;
  state.stopTimer = null;
  running.delete(state.serverId);

  // drop the owner marker so the next start is not blocked
  try {
    fs.unlinkSync(path.join(paths.tmpDir(), `${state.serverId}.pid.json`));
  } catch {
    /* already gone */
  }
}

/**
 * Ask the server to shut down, then insist.
 *
 * `stop` lets the world be saved; the taskkill is only the fallback for a JVM
 * that has stopped answering, which is what happens after a hard crash in a
 * plugin and is the reason the force button exists.
 */
async function stop(serverId, { force = false, timeout = 30000 } = {}) {
  const id = paths.segment(serverId);
  const state = running.get(id);
  if (!state) return { ok: true, already: true };

  state.stopRequested = true;
  state.phase = 'stopping';
  emitStatus(state);

  if (force) {
    emitLog(id, 'Force stopping the server', 'info');
    try {
      state.child.stdin.write('stop\n');
    } catch {
      /* the pipe may already be gone */
    }
    await killTree(state.child.pid);
    return { ok: true, forced: true };
  }

  try {
    state.child.stdin.write('stop\n');
  } catch (err) {
    await killTree(state.child.pid);
    return { ok: true, forced: true, error: err.message };
  }

  return new Promise((resolve) => {
    const poll = setInterval(() => {
      if (!running.has(id)) {
        clearInterval(poll);
        resolve({ ok: true });
      }
    }, 200);

    state.stopTimer = setTimeout(() => {
      clearInterval(poll);
      emitLog(id, 'The server did not stop in time - killing it', 'err');
      killTree(state.child.pid);
      resolve({ ok: true, forced: true });
    }, timeout);
  });
}

/** Write one line to the server console. */
function send(serverId, line) {
  const id = paths.segment(serverId);
  const state = running.get(id);
  if (!state) return { ok: false, error: 'this server is not running' };

  const text = String(line ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (!text) return { ok: false, error: 'nothing to send' };
  if (text.length > 512) return { ok: false, error: 'that command is too long' };

  try {
    state.child.stdin.write(`${text}\n`);
    emitLog(id, `> ${text}`, 'cmd');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* -------------------------------- monitor ------------------------------- */

const MONITOR_MS = 4000;

function startMonitor(state) {
  state.monitor = setInterval(async () => {
    if (!running.has(state.serverId)) return;
    await sampleOnce(state);
  }, MONITOR_MS);
  if (state.monitor.unref) state.monitor.unref();
}

/**
 * One sample of what the server is doing.
 *
 * The player list comes from the console because it is exact, and the ping fills
 * in the MOTD and the advertised maximum. A ping failure is normal - it just
 * means the port is not open yet - so it never raises the log level.
 */
async function sampleOnce(state) {
  const memory = await memoryMb(state.child.pid);

  // the heap is sampled far less often than the player list: it is the honest
  // answer to "how much of my 512 MB is in use", and it only changes on a GC,
  // while jcmd costs a safepoint each time it is asked. Only a JVM has one to ask.
  let heap = state.heap || null;
  if (state.javaExe && Date.now() - (state.heapAt || 0) > HEAP_TTL_MS) {
    heap = await heapInfo(state.child.pid, state.javaExe).catch(() => null);
    state.heap = heap;
    state.heapAt = Date.now();
  }

  // the protocol follows the software, not the port: Bedrock runs RakNet over
  // UDP and never answers the Java status ping, so asking it the Java way would
  // leave every Bedrock server permanently unreachable with a player count of 0
  const status = await ping.statusFor(state.runtimeKind, '127.0.0.1', state.port);

  emit('status', {
    serverId: state.serverId,
    running: true,
    phase: state.phase,
    pid: state.child.pid,
    startedAt: state.startedAt,
    readyAt: state.readyAt,
    uptime: Date.now() - state.startedAt,
    runtimeKind: state.runtimeKind,
    javaMajor: state.javaInfo?.major ?? 0,
    javaExe: state.javaExe || '',
    javaMatch: state.javaInfo?.match || '',
    javaRisk: Boolean(state.javaInfo?.risk),
    javaSource: state.javaInfo?.source || '',
    phpVersion: state.php?.version || '',
    phpExe: state.php?.exe || '',
    memory: state.memory,
    // the whole process working set: heap, metaspace, thread stacks, Netty's
    // off-heap buffers. Always larger than heapUsedMb, and that is correct.
    ramMb: memory,
    heapUsedMb: heap?.usedMb ?? null,
    heapMaxMb: heap?.maxMb ?? null,
    port: state.port,
    players: [...state.players.values()],
    playerCount: state.players.size,
    maxPlayers: status.max,
    motd: status.motd,
    version: status.version,
    reachable: status.ok,
  });
}

/* -------------------------------- backup -------------------------------- */

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/**
 * Zip the world folder.
 *
 * A running server is saved first: `save-off` flushes and stops writing chunks,
 * and without that the archive can capture a half-written region file that the
 * next start has to rebuild. `save-all flush` then `save-on` puts it back.
 */
async function backup(serverId, { onProgress = null, keep = 10 } = {}) {
  const id = paths.segment(serverId);
  const world = paths.serverWorld(id);
  if (!paths.exists(world)) throw new Error('there is no world folder to back up yet');

  const state = running.get(id);
  let paused = false;
  if (state) {
    try {
      state.child.stdin.write('save-off\n');
      paused = true;
      await sleep(2500); // let the in-flight chunk writes finish
    } catch {
      paused = false;
    }
  }

  try {
    const dest = path.join(paths.backupsDir(id), `world-${timestampSlug()}.zip`);
    const res = await zip.zipDir(world, dest, { onProgress });
    pruneBackups(id, keep);
    return { ok: true, file: dest, name: path.basename(dest), size: paths.sizeOf(dest), ...res };
  } finally {
    if (paused && running.has(id)) {
      try {
        state.child.stdin.write('save-all flush\nsave-on\n');
      } catch {
        /* the server may have stopped while we were zipping */
      }
    }
  }
}

/** Keep the newest `keep` archives and delete the rest. */
function pruneBackups(serverId, keep = 10) {
  const dir = paths.backupsDir(paths.segment(serverId));
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.zip'));
  } catch {
    return 0;
  }
  files.sort();
  const excess = files.slice(0, Math.max(0, files.length - keep));
  for (const file of excess) {
    try {
      fs.rmSync(path.join(dir, file), { force: true });
    } catch {
      /* best effort */
    }
  }
  return excess.length;
}

function listBackups(serverId, { keep = 10 } = {}) {
  const dir = paths.backupsDir(paths.segment(serverId));
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return files
    .filter((f) => f.endsWith('.zip'))
    .map((f) => {
      const full = path.join(dir, f);
      let stat = null;
      try {
        stat = fs.statSync(full);
      } catch {
        return null;
      }
      return { name: f, file: full, size: stat.size, modified: stat.mtimeMs };
    })
    .filter(Boolean)
    .sort((a, b) => b.modified - a.modified)
    .slice(0, keep);
}

function deleteBackup(serverId, name) {
  const target = path.join(paths.backupsDir(paths.segment(serverId)), path.basename(String(name || '')));
  if (!target.endsWith('.zip')) return { ok: false, error: 'that is not a backup file' };
  try {
    fs.rmSync(target, { force: true });
    return { ok: true, name: path.basename(target) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function scheduleAutoBackup(state, hours) {
  const every = Number(hours) || 0;
  if (every <= 0) return;

  const interval = Math.max(15, every) * 60 * 60 * 1000;
  state.backupTimer = setInterval(() => {
    if (!running.has(state.serverId)) return;
    backup(state.serverId).then(
      (res) => emitLog(state.serverId, `Auto backup written: ${res.name}`, 'ok'),
      (err) => emitLog(state.serverId, `Auto backup failed: ${err.message}`, 'err')
    );
  }, interval);
  if (state.backupTimer.unref) state.backupTimer.unref();
}

/* -------------------------------- events -------------------------------- */

function emit(type, payload) {
  bus.emit(type, payload);
}

/** `log` payloads are tagged so the renderer can colour them per server. */
function emitLog(serverId, line, level = 'info') {
  bus.emit('log', { serverId, line, level, at: Date.now() });
}

function emitStatus(state) {
  emitStatusFor(state.serverId, state.phase);
}

function emitStatusFor(serverId, phase) {
  const state = running.get(paths.segment(serverId));
  emit('status', {
    serverId: paths.segment(serverId),
    running: Boolean(state),
    phase: phase || (state ? state.phase : 'stopped'),
    pid: state?.child?.pid || null,
    startedAt: state?.startedAt || 0,
    readyAt: state?.readyAt || 0,
    uptime: state ? Date.now() - state.startedAt : 0,
    javaMajor: state?.javaInfo?.major ?? 0,
    javaExe: state?.javaExe || '',
    javaMatch: state?.javaInfo?.match || 'none',
    javaRisk: Boolean(state?.javaInfo?.risk),
    javaSource: state?.javaInfo?.source || 'auto',
    runtimeKind: state?.runtimeKind || 'none',
    phpVersion: state?.php?.version || '',
    phpExe: state?.php?.exe || '',
    memory: state?.memory || null,
    ramMb: 0,
    port: state?.port || 0,
    players: state ? [...state.players.values()] : [],
    playerCount: state ? state.players.size : 0,
    maxPlayers: 0,
    motd: '',
    version: '',
    reachable: false,
  });
}

function publicStatus(state) {
  return {
    serverId: state.serverId,
    running: true,
    phase: state.phase,
    pid: state.child.pid,
    startedAt: state.startedAt,
    uptime: 0,
    javaMajor: state.javaInfo?.major ?? 0,
    javaExe: state.javaExe || '',
    javaMatch: state.javaInfo?.match || '',
    javaRisk: Boolean(state.javaInfo?.risk),
    javaSource: state.javaInfo?.source || '',
    runtimeKind: state.runtimeKind,
    phpVersion: state.php?.version || '',
    phpExe: state.php?.exe || '',
    memory: state.memory,
    port: state.port,
    players: [],
    playerCount: 0,
  };
}

/* -------------------------------- queries ------------------------------- */

function isRunning(serverId) {
  return running.has(paths.segment(serverId));
}

function runningIds() {
  return [...running.keys()];
}

/** Snapshot of one server, or a stopped stub when nothing is up. */
function status(serverId) {
  const id = paths.segment(serverId);
  const state = running.get(id);
  if (!state) {
    return {
      serverId: id,
      running: false,
      phase: 'stopped',
      pid: null,
      startedAt: 0,
      uptime: 0,
      players: [],
      playerCount: 0,
      ramMb: 0,
      reachable: false,
    };
  }
  return {
    serverId: id,
    running: true,
    phase: state.phase,
    pid: state.child.pid,
    startedAt: state.startedAt,
    readyAt: state.readyAt,
    uptime: Date.now() - state.startedAt,
    javaMajor: state.javaInfo?.major ?? 0,
    javaExe: state.javaExe || '',
    javaMatch: state.javaInfo?.match || '',
    javaRisk: Boolean(state.javaInfo?.risk),
    javaSource: state.javaInfo?.source || '',
    runtimeKind: state.runtimeKind,
    phpVersion: state.php?.version || '',
    phpExe: state.php?.exe || '',
    memory: state.memory,
    ramMb: 0,
    port: state.port,
    players: [...state.players.values()],
    playerCount: state.players.size,
  };
}

function players(serverId) {
  const state = running.get(paths.segment(serverId));
  if (!state) return [];
  return [...state.players.values()].map((p) => ({
    ...p,
    uuid: state.pendingUuids.get(p.name) || '',
  }));
}

/** The exact command line, for the "what will it run" read-out. */
function dryRun(serverId, extra = {}) {
  const id = paths.segment(serverId);
  const state = running.get(id);
  if (state) return { ok: true, argv: state.argv, javaExe: state.javaExe, running: true };
  return { ok: true, argv: null, javaExe: '', running: false, ...extra };
}

/** Stop everything. Used on app quit. */
async function stopAll({ force = false } = {}) {
  const ids = runningIds();
  await Promise.all(ids.map((id) => stop(id, { force, timeout: force ? 2000 : 12000 }).catch(() => {})));
  return ids;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  bus,
  start,
  stop,
  stopAll,
  send,
  status,
  statuses: runningIds,
  isRunning,
  runningIds,
  players,
  backup,
  listBackups,
  deleteBackup,
  pruneBackups,
  dryRun,
  buildArgs,
  launchPlan,
  warnAboutHeapCeiling,
  clampMemory,
  cleanLine,
  classify,
  totalMemoryMb,
  memoryMb,
  heapInfo,
  parseHeapInfo,
};
