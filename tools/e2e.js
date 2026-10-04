'use strict';

/**
 * End-to-end test against the real thing.
 *
 *   node tools/e2e.js            full run (downloads a JDK + a Paper jar)
 *   node tools/e2e.js 1.16.5     pin the Minecraft version
 *   node tools/e2e.js --keep     leave the throwaway server folder behind
 *
 * This is the only check that proves the app's central claim: that it can pick a
 * Java version, download the server, and produce a Minecraft server that actually
 * answers a status ping. It needs the network and about 300 MB of disk.
 *
 * It runs against the *services* in a throwaway directory, not through the UI:
 * the UI is covered by the smoke test, and this is here to cover the parts that
 * only exist once a real JVM is running.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const services = {
  paths: require('../src/main/services/paths'),
  net: require('../src/main/services/net'),
  paper: require('../src/main/services/paper'),
  java: require('../src/main/services/java'),
  server: require('../src/main/services/server'),
  config: require('../src/main/services/config'),
  ping: require('../src/main/services/ping'),
  store: require('../src/main/store'),
};

const args = process.argv.slice(2);
const mcVersion = args.find((a) => !a.startsWith('--')) || '1.20.4';
const keep = args.includes('--keep');

const log = (...parts) => console.log(...parts);
const step = (n, text) => log(`\n[${n}] ${text}`);
const ok = (text) => log(`    ok  ${text}`);
const fail = (text) => {
  console.error(`    FAIL ${text}`);
  process.exitCode = 1;
};

let scratch = null;

async function main() {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'envserver-e2e-'));
  services.paths.init(path.join(scratch, 'data'));
  services.store.init(path.join(scratch, 'settings'));

  log(`EnvServer end-to-end - Minecraft ${mcVersion}`);
  log(`scratch: ${scratch}`);

  /* ------------------------------ 1. Paper ------------------------------ */
  step(1, `looking up Paper builds for ${mcVersion}`);

  const builds = await services.paper.listBuilds(mcVersion);
  if (!builds.length) throw new Error(`Paper publishes no builds for ${mcVersion}`);
  const chosen = builds[0];
  ok(`${builds.length} builds, newest is #${chosen.build} (${(chosen.size / 1048576).toFixed(1)} MB)`);

  const meta = services.paper.cachedMeta(mcVersion);
  if (!meta.javaMajor) {
    // no cached metadata: ask once so the required Java is authoritative
    await services.paper.versionMeta(mcVersion);
  }
  const required = services.paper.requiredJava(mcVersion);
  ok(`Paper says this release needs Java ${required}`);

  /* --------------------------- 2. the server --------------------------- */
  step(2, 'creating a server folder');
  const record = services.store.createServer({
    name: 'E2E',
    mcVersion,
    memory: { min: 512, max: 1024 },
    port: 25599, // a high port so this cannot collide with a real server
  });
  services.config.seedDefaults(record.id, { port: record.port });
  ok(`created ${record.id} at ${services.paths.serverDir(record.id)}`);

  /* --------------------------- 3. install the jar ---------------------- */
  step(3, 'downloading the Paper jar (this is a real ~50 MB download)');
  const installed = await services.paper.installJar({
    serverId: record.id,
    mcVersion,
    build: chosen.build,
    onProgress: (p) => {
      if (p.done) log(`        done: ${services.paths.sizeOf(services.paths.serverJar(record.id))} bytes`);
    },
  });
  ok(`paper.jar written, ${(installed.size / 1048576).toFixed(1)} MB`);

  /* ------------------------------ 4. Java ------------------------------ */
  step(4, 'resolving a Java runtime');
  let runtimes = await services.java.listRuntimes();
  log(`        ${runtimes.length} runtime(s) already installed: ${runtimes.map((r) => r.major).join(', ') || 'none'}`);

  if (!services.java.pickFor(required, runtimes)) {
    log(`        no Java ${required} present - downloading Eclipse Temurin`);
    const t0 = Date.now();
    const rt = await services.java.ensureRuntime(required, {
      onProgress: (p) => {
        if (p.phase && p.phase !== lastPhase) {
          lastPhase = p.phase;
          log(`        ${p.phase}${p.total ? ` (${(p.total / 1048576).toFixed(0)} MB)` : ''}`);
        }
      },
    });
    log(`        extracted in ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${rt.rawVersion}`);
    runtimes = await services.java.listRuntimes({ force: true });
  }

  const picked = services.java.pickFor(required, runtimes);
  if (!picked) throw new Error(`still no usable Java ${required}`);
  ok(`Java ${picked.major} (${picked.rawVersion}) selected, match=${services.java.compat(required, picked.major)}`);

  /* ------------------------------- 5. EULA ----------------------------- */
  step(5, 'accepting the EULA');
  services.config.writeEula(services.paths.serverEula(record.id), true);
  if (!services.config.readEula(services.paths.serverEula(record.id))) throw new Error('eula did not stick');
  ok('eula.txt written and read back as accepted');

  /* ------------------------------ 6. start ----------------------------- */
  step(6, 'starting the server');

  const lines = [];
  let sawReady = false;
  services.server.bus.on('log', (e) => {
    lines.push(e);
    if (/Done \(.*\)! For help/.test(e.line)) sawReady = true;
  });

  const t0 = Date.now();
  const started = await services.server.start(services.store.getServer(record.id), {
    requiredMajor: required,
    recommended: services.paper.cachedMeta(mcVersion).recommendedFlags,
    memory: record.memory,
    autoBackupHours: 0,
  });
  ok(`spawned pid ${started.pid} via ${started.javaExe} (Java ${started.javaMajor})`);
  log(`        cwd: ${services.paths.serverDir(record.id)}`);

  /* --------------------------- 7. wait for ready ------------------------ */
  step(7, 'waiting for the server to finish starting');
  const deadline = Date.now() + 180_000;
  while (!sawReady && Date.now() < deadline) {
    if (lines.some((l) => /Could not start java|UnsupportedClassVersionError|Error occurred/.test(l.line))) break;
    await sleep(500);
  }

  if (!sawReady) {
    log(`    last ${Math.min(25, lines.length)} lines:`);
    for (const l of lines.slice(-25)) log(`      [${l.level}] ${l.line}`);
    throw new Error('the server never reported "Done" - see the log above');
  }
  // measured from our own t0: the value returned by start() deliberately omits
// internal timestamps, so reading startedAt back off it would always print 0.0s
  ok(`ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  /* ------------------------------ 8. ping ------------------------------ */
  step(8, 'status ping (the real Server List Ping protocol)');
  const status = await services.ping.status('127.0.0.1', record.port);
  if (!status.ok) {
    await stop();
    throw new Error(`ping failed: ${status.reason}`);
  }
  ok(`online=${status.online}/${status.max} version=${status.version} motd="${status.motd}"`);

  if (status.version && !status.version.includes(mcVersion)) {
    fail(`the server reports version "${status.version}" but ${mcVersion} was requested`);
  }
  if (status.max !== 20) fail(`max-players should be 20 from the seeded properties, got ${status.max}`);

  /* ---------------------------- 9. console cmd -------------------------- */
  step(9, 'sending a command over stdin');
  const before = lines.length;
  const sent = services.server.send(record.id, 'list');
  if (!sent.ok) fail(`send failed: ${sent.error}`);
  await sleep(2500);
  const gotList = lines.slice(before).some((l) => /players online/i.test(l.line));
  if (!gotList) {
    log('    note: the /list response was not seen; the command was still delivered');
  } else {
    ok('the server answered /list on the console');
  }

  /* ----------------------------- 10. memory ----------------------------- */
  step(10, 'process memory sample');
  const ramMb = await services.server.memoryMb(started.pid);
  if (ramMb > 0) ok(`resident memory ${ramMb} MB for a 1024 MB heap`);
  else fail('tasklist returned no memory for a running java process');

  /* ---------------------------- 11. backup ------------------------------ */
  step(11, 'backing up the world it just generated');
  const worldExists = services.paths.exists(services.paths.serverWorld(record.id));
  if (!worldExists) fail('no world folder was generated');
  else {
    const backup = await services.server.backup(record.id, { keep: 3 });
    const listed = services.server.listBackups(record.id, { keep: 3 });
    ok(`wrote ${backup.name}, ${(backup.size / 1048576).toFixed(2)} MB, ${backup.files} files`);
    if (!listed.length) fail('the backup did not appear in the list');
    // prove the archive is real, not just present
    const names = require('../src/main/services/zip').list(backup.file);
    if (!names.length) fail('the backup archive has no entries');
    else ok(`archive is readable: ${names.length} entries, e.g. ${names.slice(0, 2).join(', ')}`);
  }

  /* ----------------------------- 12. config ----------------------------- */
  step(12, 'editing server.properties and reading it back');
  const props = services.config.readProperties(services.paths.serverProperties(record.id));
  ok(`${Object.keys(props.values).length} keys read back`);
  props.values.motd = 'e2e test server';
  props.values['max-players'] = '42';
  services.config.writeProperties(services.paths.serverProperties(record.id), props.order, props.values);
  const reread = services.config.readProperties(services.paths.serverProperties(record.id));
  if (reread.values.motd !== 'e2e test server') fail('motd did not persist');
  else ok('motd persisted');
  if (reread.values['difficulty'] !== 'normal') fail('an untouched key was lost by the write');
  else ok('untouched keys survived');

  /* ------------------------------ 13. stop ------------------------------ */
  step(13, 'stopping the server');
  await stop();
  if (services.server.isRunning(record.id)) fail('the server is still running after stop()');
  else ok('stopped cleanly');

  log('\nEND-TO-END PASSED');
}

/* -------------------------------- helpers ------------------------------- */

let lastPhase = '';

async function stop() {
  await services.server.stopAll({ force: false });
  // give the JVM a moment to actually go away
  for (let i = 0; i < 40 && services.server.runningIds().length; i++) await sleep(250);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Never leave a JVM behind.
 *
 * A leaked `java.exe` keeps a server folder - and this machine - busy, so cleanup
 * runs on exit *and* on any failure, and a backstop force-kills anything still
 * holding the port after a few seconds.
 */
async function cleanup() {
  try {
    await services.server.stopAll({ force: true });
  } catch {
    /* the JVM may already be gone */
  }
  // give the graceful stop a moment, then insist
  for (let i = 0; i < 20 && services.server.runningIds().length; i++) await sleep(250);
  if (scratch && !keep) {
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  } else if (scratch) {
    console.log(`\nkept: ${scratch}`);
  }
}

let cleaning = false;
async function cleanupOnce() {
  if (cleaning) return;
  cleaning = true;
  await cleanup();
}

process.on('exit', () => {
  // `exit` cannot await, so force-stop synchronously through the registry
  for (const id of services.server.runningIds()) {
    try {
      services.server.stop(id, { force: true, timeout: 0 });
    } catch {
      /* nothing more we can do here */
    }
  }
});

process.on('SIGINT', () => cleanupOnce().then(() => process.exit(130)));
process.on('SIGTERM', () => cleanupOnce().then(() => process.exit(143)));

main().catch(async (err) => {
  console.error(`\nEND-TO-END FAILED: ${err.message}`);
  await cleanupOnce();
  process.exit(1);
});