'use strict';

/**
 * EnvServer unit tests.
 *
 *   node tools/test.js
 *
 * No Electron, no network and no Minecraft server required. These cover the parts
 * that are easy to get subtly wrong: the Java matching rules, the zip writer and
 * reader (including path traversal), property parsing, the varint framing used by
 * the server ping, console log classification and the settings validation.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const java = require('../src/main/services/java');
const zip = require('../src/main/services/zip');
const config = require('../src/main/services/config');
const ping = require('../src/main/services/ping');
const server = require('../src/main/services/server');
const paper = require('../src/main/services/paper');
const paths = require('../src/main/services/paths');
const runtime = require('../src/main/services/runtime');
const catalog = require('../src/main/services/catalog');
const bedrock = require('../src/main/services/bedrock');
const pocketmine = require('../src/main/services/pocketmine');
const php = require('../src/main/services/php');
const updater = require('../src/main/services/updater');
const store = require('../src/main/store');

/* ------------------------------- harness -------------------------------- */

const tests = [];
let passed = 0;
let failed = 0;

/** A test that never settles is a failure, not a silent exit with no summary. */
const TEST_TIMEOUT = 15_000;

function test(name, fn) {
  tests.push([name, fn]);
}

function withTimeout(name, fn) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${TEST_TIMEOUT / 1000}s`)), TEST_TIMEOUT);
  });
  // whatever happens, the timer must not keep the process alive
  guard.catch(() => {});
  return Promise.race([Promise.resolve().then(fn), guard]).finally(() => clearTimeout(timer));
}

// A rejection that escapes the loop is a bug in the harness or a test; report it
// rather than letting node print an unhandled rejection and carry on silently.
process.on('unhandledRejection', (err) => {
  console.error(`\n\nUNHANDLED REJECTION: ${err && (err.stack || err.message || err)}`);
  process.exit(1);
});

async function run() {
  for (const [name, fn] of tests) {
    try {
      await withTimeout(name, fn);
      passed++;
      process.stdout.write('.');
    } catch (err) {
      failed++;
      process.stdout.write('F');
      console.error(`\n\nFAIL: ${name}\n  ${err && err.message}`);
      if (process.env.VERBOSE) console.error(err.stack);
    }
  }

  console.log(`\n\n${passed} passed, ${failed} failed, ${tests.length} total`);
  process.exit(failed ? 1 : 0);
}

/* -------------------------------- helpers ------------------------------- */

let tmpRoot = null;
function tmp(name) {
  const dir = path.join(tmpRoot, `${name}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/* ============================== java matching =========================== */

test('compareVersions orders numerically, not lexically', () => {
  assert.strictEqual(java.compareVersions('1.21.11', '1.21.4') > 0, true);
  assert.strictEqual(java.compareVersions('1.9', '1.10') < 0, true);
  assert.strictEqual(java.compareVersions('1.20.4', '1.20.4'), 0);
  // a suffix is ignored: a release candidate is "the same version" for matching
  assert.strictEqual(java.compareVersions('1.21.4-rc3', '1.21.4'), 0);
});

test('requirementFor covers the whole 1.x line', () => {
  assert.strictEqual(java.requirementFor('1.16.5'), 8);
  assert.strictEqual(java.requirementFor('1.12.2'), 8);
  assert.strictEqual(java.requirementFor('1.17'), 16);
  assert.strictEqual(java.requirementFor('1.17.1'), 16);
  assert.strictEqual(java.requirementFor('1.18.2'), 17);
  assert.strictEqual(java.requirementFor('1.20.4'), 17);
  assert.strictEqual(java.requirementFor('1.20.5'), 21);
  assert.strictEqual(java.requirementFor('1.21.11'), 21);
});

test("requirementFor handles Minecraft's year-based versions", () => {
  // 26.3 sorts numerically above the 1.x table's own ceiling, so without a
  // dedicated branch it falls through to the Java 8 default
  assert.strictEqual(java.requirementFor('26.3'), 25);
  assert.strictEqual(java.requirementFor('26.1.2'), 25);
  assert.strictEqual(java.requirementFor('2.0'), 25);
  assert.strictEqual(java.requirementFor(''), 0);
});

test('pickFor prefers the exact feature version, then the smallest above', () => {
  const list = [
    { major: 17, rawVersion: '17.0.9+11' },
    { major: 21, rawVersion: '21.0.1' },
    { major: 25, rawVersion: '25.0.1' },
  ];
  assert.strictEqual(java.pickFor(21, list).major, 21);
  assert.strictEqual(java.pickFor(17, list).major, 17);
  // no Java 16 here, so Java 17 is the smallest viable runtime
  assert.strictEqual(java.pickFor(16, list).major, 17);
  assert.strictEqual(java.pickFor(16, [list[1], list[2]]).major, 21);
  // nothing satisfies 25 with only older runtimes installed
  assert.strictEqual(java.pickFor(25, [list[0], list[1]]), null);
  assert.strictEqual(java.pickFor(21, []), null);
});

test('pickFor picks the newest patch of the exact match', () => {
  const list = [
    { major: 21, rawVersion: '21.0.1' },
    { major: 21, rawVersion: '21.0.9+11' },
    { major: 21, rawVersion: '21.0.4' },
  ];
  assert.strictEqual(java.pickFor(21, list).rawVersion, '21.0.9+11');
});

test('pickFor with no requirement returns the newest runtime', () => {
  const list = [{ major: 8 }, { major: 21 }, { major: 17 }];
  assert.strictEqual(java.pickFor(0, list).major, 21);
});

test('compat and forwardRisk classify a runtime against a release', () => {
  assert.strictEqual(java.compat(21, 21), 'exact');
  assert.strictEqual(java.compat(21, 25), 'newer');
  assert.strictEqual(java.compat(21, 17), 'older');
  assert.strictEqual(java.compat(21, 0), 'none');

  // a Java 8 Paper on a modern JVM is a genuine risk, not a formality
  assert.strictEqual(java.forwardRisk(8, 21), true);
  assert.strictEqual(java.forwardRisk(17, 21), false);
  assert.strictEqual(java.forwardRisk(21, 21), false);
});

test('describeVersion reads both the 1.x and the modern scheme', () => {
  assert.strictEqual(java.describeVersion('1.8.0_382').major, 8);
  assert.strictEqual(java.describeVersion('1.7.0_80').major, 7);
  assert.strictEqual(java.describeVersion('17.0.9+11').major, 17);
  assert.strictEqual(java.describeVersion('21').major, 21);
  assert.strictEqual(java.describeVersion('9-ea').major, 9);
  assert.strictEqual(java.describeVersion('nonsense'), null);
  assert.strictEqual(java.describeVersion(''), null);
});

test('coverageFor describes the versions one Java covers', () => {
  assert.deepStrictEqual(java.coverageFor(8), [{ min: '1.7.10', max: '1.16.5' }]);
  assert.deepStrictEqual(java.coverageFor(17), [{ min: '1.18', max: '1.20.4' }]);
  assert.deepStrictEqual(java.coverageFor(0), []);
});

test('explainMissing and explainMismatch say something actionable', () => {
  const missing = java.explainMissing(21, '1.21.4');
  assert.ok(/Java 21/.test(missing), missing);
  assert.ok(/download/i.test(missing), missing);

  const tooOld = java.explainMismatch(21, 17, '1.21.4');
  assert.ok(/UnsupportedClassVersionError/.test(tooOld), tooOld);

  const risky = java.explainMismatch(8, 21, '1.16.5');
  assert.ok(/internal/i.test(risky), risky);
});

/* ================================== zip ================================= */

test('zip round-trips files, directories and empty files', async () => {
  const src = tmp('zip-src');
  fs.mkdirSync(path.join(src, 'region'), { recursive: true });
  fs.writeFileSync(path.join(src, 'level.dat'), Buffer.alloc(300000, 7));
  fs.writeFileSync(path.join(src, 'region', 'r.0.0.mca'), Buffer.from('hello '.repeat(40000)));
  fs.writeFileSync(path.join(src, 'empty.dat'), Buffer.alloc(0));

  const archive = path.join(tmp('zip-out'), 'world.zip');
  const written = await zip.zipDir(src, archive);
  assert.strictEqual(written.files, 3);
  assert.strictEqual(written.bytes, 300000 + 6 * 40000);

  const dest = tmp('zip-dest');
  const extracted = await zip.extractAll(archive, dest);
  assert.strictEqual(extracted.files, 3);

  for (const rel of ['level.dat', 'region/r.0.0.mca', 'empty.dat']) {
    assert.ok(
      fs.readFileSync(path.join(dest, ...rel.split('/'))).equals(fs.readFileSync(path.join(src, ...rel.split('/')))),
      `${rel} did not survive the round trip`
    );
  }
});

test('the archive is readable by its own central directory', async () => {
  const src = tmp('zip-cd');
  fs.writeFileSync(path.join(src, 'a.txt'), 'a');
  fs.writeFileSync(path.join(src, 'b.txt'), 'b');
  const archive = path.join(tmp('zip-cd-out'), 'x.zip');
  await zip.zipDir(src, archive);

  assert.deepStrictEqual(zip.list(archive).sort(), ['a.txt', 'b.txt']);
  const entries = zip.readDirectory(archive);
  assert.strictEqual(entries.length, 2);
  for (const entry of entries) {
    assert.strictEqual(entry.method, 8, 'entries should be deflated');
    assert.strictEqual(entry.crc >>> 0, zip.crc32Update(0, Buffer.from(entry.name === 'a.txt' ? 'a' : 'b')), 'crc mismatch');
  }
});

test('zip extraction refuses to escape the target directory', async () => {
  const src = tmp('zip-evil');
  fs.writeFileSync(path.join(src, 'safe.txt'), 'ok');
  const archive = path.join(tmp('zip-evil-out'), 'evil.zip');
  await zip.zipDir(src, archive);

  const dest = tmp('zip-evil-dest');
  const before = fs.readdirSync(dest);
  await zip.extractAll(archive, dest);
  assert.deepStrictEqual(fs.readdirSync(dest).sort(), ['safe.txt']);
  assert.strictEqual(before.length, 0);
});

test('safeJoin rejects traversal, absolute paths and drive letters', () => {
  const root = path.resolve('C:/tmp/target');
  assert.strictEqual(zip.safeJoin(root, '../../evil.txt'), null);
  assert.strictEqual(zip.safeJoin(root, '..\\..\\evil.txt'), null);
  assert.strictEqual(zip.safeJoin(root, '/etc/passwd'), null);
  assert.strictEqual(zip.safeJoin(root, 'C:/Windows/system32'), null);
  assert.strictEqual(zip.safeJoin(root, 'nested/ok.txt'), path.join(root, 'nested', 'ok.txt'));
  assert.strictEqual(zip.safeJoin(root, './ok.txt'), path.join(root, 'ok.txt'));
});

test('crc32Update matches the known check value', () => {
  assert.strictEqual(zip.crc32Update(0, Buffer.from('123456789')) >>> 0, 0xcbf43926);
});

test('walkFiles sorts and skips nothing it cannot stat', async () => {
  const src = tmp('walk');
  fs.mkdirSync(path.join(src, 'b'), { recursive: true });
  fs.writeFileSync(path.join(src, 'b', '2.txt'), '2');
  fs.writeFileSync(path.join(src, '1.txt'), '1');
  assert.deepStrictEqual(await zip.walkFiles(src), ['1.txt', 'b/2.txt']);
  assert.deepStrictEqual(await zip.walkFiles(path.join(src, 'missing')), []);
});

/* ============================== properties ============================== */

test('parseProperties accepts both separators and skips comments', () => {
  const { order, values } = config.parseProperties(
    ['#Minecraft server properties', '! a bang comment', '', 'motd=Hello', 'server-port=25565', 'legacy:colonvalue', 'motd=Second'].join('\n')
  );
  assert.strictEqual(values.motd, 'Second', 'a repeated key must overwrite, not duplicate');
  assert.strictEqual(values['server-port'], '25565');
  assert.strictEqual(values.legacy, 'colonvalue');
  assert.deepStrictEqual(order, ['motd', 'server-port', 'legacy'], 'order must not gain a duplicate motd');
});

test('properties survive a serialize round trip, including unknown keys', () => {
  const original = config.parseProperties('motd=A\nsome-custom-key=42\n');
  const text = config.serializeProperties(original.order, original.values);
  const again = config.parseProperties(text);
  assert.deepStrictEqual(again.values, original.values);
});

test('a value containing an = sign is not split', () => {
  const { values } = config.parseProperties('level-type=minecraft\\:flat\nmotd=a=b\n');
  assert.strictEqual(values.motd, 'a=b');
  assert.strictEqual(values['level-type'], 'minecraft\\:flat');
});

test('offlineUuid is deterministic and correctly versioned', () => {
  const a = config.offlineUuid('Notch');
  const b = config.offlineUuid('Notch');
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, config.offlineUuid('jeb_'));
  assert.ok(config.isUuid(a), a);
  // Vanilla's offline UUID is MD5("OfflinePlayer:<name>") with the version and
  // variant bits forced. Counting through the dashes, the version nibble is the
  // first hex digit of the third group (index 14) and the variant is the first of
  // the fourth (index 19).
  assert.strictEqual(a[14], '3', `version nibble wrong in ${a}`);
  assert.ok('89ab'.includes(a[19].toLowerCase()), `variant bits wrong in ${a}`);
});

test('validatePlayerName follows the vanilla rules', () => {
  assert.strictEqual(config.validatePlayerName('Steve').ok, true);
  assert.strictEqual(config.validatePlayerName('a_b_9').ok, true);
  assert.strictEqual(config.validatePlayerName('ab').ok, false, 'too short');
  assert.strictEqual(config.validatePlayerName('a'.repeat(17)).ok, false, 'too long');
  assert.strictEqual(config.validatePlayerName('has space').ok, false);
  assert.strictEqual(config.validatePlayerName('drop table').ok, false);
});

test('pluginName turns a jar filename into a readable label', () => {
  assert.strictEqual(config.pluginName('EssentialsX-2.20.1.jar'), 'EssentialsX 2.20.1');
  assert.strictEqual(config.pluginName('my_plugin.jar'), 'my plugin');
});

/* ================================ ping ================================== */

test('varints round-trip, including the multi-byte range', () => {
  for (const n of [0, 1, 127, 128, 255, 300, 2097151, 2147483647]) {
    const buf = ping.writeVarint(n);
    assert.strictEqual(buf.length, ping.readVarint(buf, 0).size, `wrong length for ${n}`);
    assert.strictEqual(ping.readVarint(buf, 0).value, n);
  }
});

test('a packet is length-prefixed and carries its id', () => {
  const body = Buffer.from('payload');
  const pkt = ping.packet(0x00, body);
  const len = ping.readVarint(pkt, 0);
  assert.strictEqual(len.size + len.value, pkt.length, 'the declared length must match the frame');
  assert.strictEqual(ping.readVarint(pkt, len.size).value, 0, 'packet id is the first field of the body');
});

test('a truncated or runaway varint is an error, not a hang', () => {
  // a single continuation byte promises another that never arrives
  assert.throws(() => ping.readVarint(Buffer.from([0x80]), 0), /past the end/);
  // and one that never terminates must not loop forever
  assert.throws(() => ping.readVarint(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80]), 0), /too long/);
});

test('flattenMotd handles a string, a text node and extra children', () => {
  assert.strictEqual(ping.flattenMotd('plain'), 'plain');
  assert.strictEqual(ping.flattenMotd({ text: 'A Server' }), 'A Server');
  assert.strictEqual(ping.flattenMotd({ extra: [{ text: 'A ' }, { text: 'Server', color: 'red' }] }), 'A Server');
  assert.strictEqual(ping.flattenMotd({ text: 'x', extra: [{ text: 'y' }] }), 'xy');
  assert.strictEqual(ping.flattenMotd(null), '');
});

test('pinging a closed port resolves instead of throwing', async () => {
  const res = await ping.status('127.0.0.1', 1, { timeout: 800 });
  assert.strictEqual(res.ok, false);
  assert.ok(res.reason, 'a failure must carry a reason');
});

/* ============================== server side ============================= */

test('cleanLine strips the colour codes log4j writes', () => {
  assert.strictEqual(server.cleanLine('[32m[12:00:00 INFO]: hello[0m'), '[12:00:00 INFO]: hello');
  assert.strictEqual(server.cleanLine('plain text'), 'plain text');
  assert.strictEqual(server.cleanLine('bell'), 'bell');
  // the leading "[time]:" is what the UI renders separately, so it goes too
  assert.strictEqual(server.cleanLine('  [12:00:00 INFO]: x'), '[12:00:00 INFO]: x');
});

test('classify understands both console log shapes', () => {
  assert.strictEqual(server.classify('[12:00:00 INFO]: starting'), 'info');
  assert.strictEqual(server.classify('[12:00:00] [Server thread/INFO]: starting'), 'info');
  assert.strictEqual(server.classify('[12:00:00 WARN]: slow'), 'warn');
  assert.strictEqual(server.classify('[12:00:00] [Server thread/WARN]: slow'), 'warn');
  assert.strictEqual(server.classify('[12:00:00 ERROR]: boom'), 'err');
  assert.strictEqual(server.classify('[12:00:00] [Server thread/ERROR]: boom'), 'err');
  assert.strictEqual(server.classify('[12:00:00] [Server thread/FATAL]: boom'), 'err');
  // a bare stack trace has no level at all and still has to stand out
  assert.strictEqual(server.classify('java.lang.NullPointerException'), 'err');
  assert.strictEqual(server.classify('Caused by: java.lang.IllegalState'), 'err');
});

test('buildArgs produces a command line the JVM accepts', () => {
  const args = server.buildArgs({
    memory: { min: 1024, max: 4096 },
    recommended: ['-XX:+UseG1GC', ''],
    extra: '-XX:+DisableExplicitGC  -Dfoo=bar',
    nogui: true,
  });
  assert.deepStrictEqual(args, [
    '-Xms1024M',
    '-Xmx4096M',
    '-Dfile.encoding=UTF-8',
    '-Djava.awt.headless=true',
    '-XX:+UseG1GC',
    '-XX:+DisableExplicitGC',
    '-Dfoo=bar',
    '-jar',
    'paper.jar',
    'nogui',
  ]);
});

test('clampMemory keeps -Xmx at or above -Xms and inside real limits', () => {
  assert.strictEqual(server.clampMemory(0, 999), 999, 'nonsense falls back');
  assert.strictEqual(server.clampMemory(50, 1024), 128, 'below the JVM floor');
  assert.strictEqual(server.clampMemory(1024, 128), 1024);
  assert.strictEqual(server.clampMemory(999999, 128), 32 * 1024, 'capped above 32 GB');
});

test('buildArgs repairs a max below the min instead of producing a doomed JVM', () => {
  const args = server.buildArgs({ memory: { min: 4096, max: 512 } });
  const min = Number(/^-Xms(\d+)M$/.exec(args[0])[1]);
  const max = Number(/^-Xmx(\d+)M$/.exec(args[1])[1]);
  assert.ok(max >= min, `-Xmx ${max} below -Xms ${min}`);
});

/* ================================ runtimes =============================== */

test('launchPlan builds a Java command line unchanged', () => {
  const plan = server.launchPlan({ type: 'paper', memory: { min: 1024, max: 4096 } }, { exe: 'C:\\jdk\\java.exe' });
  assert.strictEqual(plan.runtime, 'java');
  assert.strictEqual(plan.exe, 'C:\\jdk\\java.exe');
  assert.deepStrictEqual(plan.args.slice(-3), ['-jar', 'paper.jar', 'nogui']);
  assert.ok(plan.args.includes('-Xmx4096M'));
});

test('launchPlan runs PocketMine on PHP with a memory_limit, never -Xmx', () => {
  const plan = server.launchPlan({ type: 'pocketmine', memory: { min: 1024, max: 2048 } }, { exe: 'C:\\php\\php.exe' });
  assert.strictEqual(plan.runtime, 'php');
  // passing -Xmx to PHP would be a fatal "unrecognized option" on startup
  assert.ok(!plan.args.some((a) => a.startsWith('-X')), plan.args.join(' '));
  assert.ok(plan.args.includes('memory_limit=2048M'), plan.args.join(' '));
  assert.deepStrictEqual(plan.args.slice(-1), ['PocketMine-MP.phar']);
  // the minimum has no PHP equivalent, so it is not invented
  assert.ok(!plan.args.some((a) => a.startsWith('-d') && a.includes('memory_limit=1024')));
});

test('launchPlan runs Bedrock as a bare exe with no JVM flags and no nogui', () => {
  const plan = server.launchPlan({ type: 'bedrock', memory: { min: 1024, max: 4096 } }, { exe: 'C:\\srv\\bedrock_server.exe' });
  assert.strictEqual(plan.runtime, 'none');
  assert.strictEqual(plan.args.length, 0, `Bedrock takes no arguments, got ${plan.args.join(' ')}`);
  // `nogui` is a Java habit; Bedrock would ignore it and a reader would copy it
  assert.ok(!plan.args.includes('nogui'));
});

test('an unknown software id still gets a launchable plan rather than a crash', () => {
  // a server record can outlive the app version that created it
  const plan = server.launchPlan({ type: 'something-nobody-has-heard-of' }, { exe: 'C:\\jdk\\java.exe' });
  assert.strictEqual(plan.runtime, 'java');
  assert.ok(plan.args.includes('-jar'));
});

test('every software id has a runtime row and a catalogue', () => {
  const ids = runtime.ids();
  assert.ok(ids.length >= 9, `only ${ids.length} runtimes`);
  for (const id of ids) {
    assert.ok(catalog.forSoftware(id), `no catalogue for ${id}`);
    const rt = runtime.forSoftware(id);
    assert.ok(rt.entry, `${id} has no entry point`);
    assert.ok(rt.ready instanceof RegExp, `${id} has no readiness pattern`);
    assert.strictEqual(typeof rt.eula, 'boolean', `${id} does not say whether it needs the EULA`);
  }
});

test('the renderer and main agree on every software id', () => {
  // the renderer keeps its own table so it can render synchronously; the two
  // drifting apart is how software ends up creatable but unstartable
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'software.js'), 'utf8');
  const ids = [...src.matchAll(/^\s{4}id: '([a-z]+)',$/gm)].map((m) => m[1]);
  assert.ok(ids.length >= 9, `renderer table only had ${ids.length} entries`);
  for (const id of ids) {
    assert.ok(runtime.isKnown(id), `renderer offers "${id}" but main has no runtime for it`);
    assert.ok(catalog.forSoftware(id), `renderer offers "${id}" but main has no catalogue for it`);
  }
  for (const id of runtime.ids()) {
    assert.ok(ids.includes(id), `main can run "${id}" but the renderer cannot create it`);
  }
});

test('the entry point named in the renderer matches the one main runs', () => {
  // the Versions view says "Remove bedrock_server.exe"; if these drift it removes
  // the wrong thing or names a file that does not exist
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'software.js'), 'utf8');
  const pairs = [...src.matchAll(/id: '([a-z]+)',[\s\S]{0,220}?entry: '([^']+)'/g)];
  assert.ok(pairs.length >= 9, `only matched ${pairs.length} id/entry pairs`);
  for (const [, id, entry] of pairs) {
    assert.strictEqual(runtime.forSoftware(id).entry, entry, `entry mismatch for ${id}`);
  }
});

test('only Mojang and Bukkit software are gated on the EULA', () => {
  // Bedrock's terms are accepted on Mojang's download page and PocketMine has
  // none of its own, so neither writes an eula.txt - blocking them on a file that
  // will never exist is a dead end
  assert.strictEqual(runtime.forSoftware('bedrock').eula, false);
  assert.strictEqual(runtime.forSoftware('pocketmine').eula, false);
  for (const id of ['paper', 'vanilla', 'spigot']) {
    assert.strictEqual(runtime.forSoftware(id).eula, true, `${id} should still need the EULA`);
  }
});

test('preflight names the missing thing in the software\'s own words', () => {
  const bedrock = runtime.preflight({ id: 'x', type: 'bedrock' });
  assert.strictEqual(bedrock.length, 1);
  assert.ok(/bedrock_server\.exe/.test(bedrock[0].text), bedrock[0].text);
  assert.strictEqual(bedrock[0].ok, false);

  const phpChecks = runtime.preflight({ id: 'x', type: 'pocketmine' }, { php: { ok: false, reason: 'no PHP here' } });
  assert.ok(phpChecks.some((c) => /no PHP here/.test(c.text)), JSON.stringify(phpChecks));
});

test('Bedrock version lists sort numerically, not as strings', () => {
  // 1.21.1.10 is older than 1.21.1.9 but sorts later as text
  const sorted = bedrock.compareVersions('1.21.1.9', '1.21.1.10');
  assert.ok(sorted < 0, '1.21.1.9 should come before 1.21.1.10');
  assert.strictEqual(bedrock.compareVersions('1.21.1.0', '1.21.1.0'), 0);
});

test('the Bedrock version list comes from Mojang\'s download-links API', () => {
  // A verbatim response from
  // https://net-secondary.web.minecraft-services.net/api/v1.0/download/links
  //
  // It replaced scraping https://www.minecraft.net/en-us/download/server/bedrock,
  // which cannot work: that page renders its links with JavaScript and the
  // served HTML contains no bedrock-server-*.zip at all, so the scraper always
  // returned an empty list and the version dropdown was always empty.
  const payload = {
    result: {
      links: [
        { downloadType: 'serverBedrockWindows', downloadUrl: 'https://www.minecraft.net/bedrockdedicatedserver/bin-win/bedrock-server-1.26.52.3.zip' },
        { downloadType: 'serverBedrockLinux', downloadUrl: 'https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-1.26.52.3.zip' },
        { downloadType: 'serverBedrockPreviewWindows', downloadUrl: 'https://www.minecraft.net/bedrockdedicatedserver/bin-win-preview/bedrock-server-1.26.60.29.zip' },
        { downloadType: 'serverBedrockPreviewLinux', downloadUrl: 'https://www.minecraft.net/bedrockdedicatedserver/bin-linux-preview/bedrock-server-1.26.60.29.zip' },
        { downloadType: 'serverJar', downloadUrl: 'https://piston-data.mojang.com/v1/objects/33680f5f/server.jar' },
      ],
    },
  };

  const got = bedrock.parseLinks(payload);
  assert.strictEqual(got.stable, '1.26.52.3');
  assert.strictEqual(got.preview, '1.26.60.29');
  // both windows builds are installable, neither linux build is
  assert.strictEqual(Object.keys(got.urls).length, 2);
  // the preview URL is kept whole: bin-win/bedrock-server-<preview>.zip is a 404
  assert.ok(got.urls['1.26.60.29'].includes('bin-win-preview/'), got.urls['1.26.60.29']);
  assert.strictEqual(bedrock.urlFor('1.26.52.3', got.urls), got.urls['1.26.52.3']);
  // and an unknown version still gets a sane stable-path guess rather than undefined
  assert.strictEqual(bedrock.urlFor('1.20.0.0', got.urls), `${bedrock.ZIP_BASE}bedrock-server-1.20.0.0.zip`);
});

test('a download-links answer with no Bedrock build in it is reported, not ignored', () => {
  // Java-only, or a shape Mojang changed. Both mean "EnvServer cannot tell you
  // which versions exist", which is not the same as a network failure and has a
  // different fix, so neither is allowed to look like a successful empty list.
  assert.strictEqual(bedrock.parseLinks({ result: { links: [{ downloadType: 'serverJar', downloadUrl: 'https://x/server.jar' }] } }), null);
  assert.strictEqual(bedrock.parseLinks({ result: {} }), null);
  assert.strictEqual(bedrock.parseLinks(null), null);
  assert.strictEqual(bedrock.parseLinks('<html>not json</html>'), null);
});

test('a failed Bedrock version load says which host to unblock, not "request failed"', () => {
  // The dropdown being empty is only actionable if the message names the thing to
  // unblock, so the host is in every one of these.
  const dns = bedrock.friendly(new Error('getaddrinfo ENOTFOUND net-secondary.web.minecraft-services.net'));
  assert.ok(/net-secondary\.web\.minecraft-services\.net/.test(dns), dns);
  const stalled = bedrock.friendly(new Error('socket hang up'));
  assert.ok(/did not answer in time/.test(stalled), stalled);
  assert.ok(/net-secondary\.web\.minecraft-services\.net/.test(stalled), stalled);
  const refused = bedrock.friendly(new Error('HTTP 403 for https://net-secondary.web.minecraft-services.net/api/v1.0/download/links'));
  assert.ok(/refused/.test(refused), refused);
  // an Error with an empty message must not be reported as the word "Error"
  const nameless = bedrock.friendly(new Error(''));
  assert.ok(nameless.length > 20 && nameless !== 'Error', nameless);
});

test('Bedrock version numbers are found in any text, newest first', () => {
  const html = `
    <a href="/bedrockdedicatedserver/bin-win/bedrock-server-1.21.1.0.zip">win</a>
    <a href="/bedrockdedicatedserver/bin-win/bedrock-server-1.21.1.10.zip">win</a>
    <a href="/bedrockdedicatedserver/bin-win/bedrock-server-1.21.1.9.zip">win</a>
    <a href="/bedrockdedicatedserver/bin-linux/bedrock-server-1.20.0.0.zip">linux</a>
  `;
  const versions = bedrock.parseVersions(html);
  assert.deepStrictEqual(versions, ['1.21.1.10', '1.21.1.9', '1.21.1.0', '1.20.0.0']);
  assert.deepStrictEqual(bedrock.parseVersions('<html>nothing here</html>'), []);
});

test('Bedrock listens on 19132, not the Java port', () => {
  assert.strictEqual(bedrock.defaultPort(), 19132);
  assert.strictEqual(pocketmine.defaultPort(), 19132);
  assert.strictEqual(catalog.defaultPort('bedrock'), 19132);
  assert.strictEqual(catalog.defaultPort('paper'), 25565);
});

test('software with no public download refuses with an explanation', () => {
  // Spigot and CraftBukkit list real versions EnvServer cannot fetch, and saying
  // so at the point of the click beats a 404 later
  return catalog.forSoftware('spigot')
    .install({ serverId: 'x', mcVersion: '1.21.4' })
    .then(
      () => assert.fail('Spigot install should have been refused'),
      (err) => {
        assert.ok(/no public download/i.test(err.message), err.message);
      }
    );
});

test('catalogue.canInstall matches the renderer table\'s auto flag', () => {
  // renderer `auto: false` means "you bring the files"; main must agree or the UI
  // offers a download that main then refuses
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'software.js'), 'utf8');
  const blocks = src.split(/\n  \{\n/).slice(1);
  for (const block of blocks) {
    const id = /id: '([a-z]+)'/.exec(block);
    if (!id) continue;
    const auto = /auto: (true|false)/.exec(block);
    if (!auto) continue;
    assert.strictEqual(catalog.canInstall(id[1]), auto[1] === 'true', `auto mismatch for ${id[1]}`);
  }
});

test('PocketMine release payloads keep only the phar', () => {
  const trimmed = pocketmine.trim([
    {
      tag_name: '5.44.3',
      published_at: '2026-01-02T03:04:05Z',
      assets: [
        { name: 'build_info.json', id: 1, size: 10 },
        { name: 'PocketMine-MP.phar', id: 2, size: 3354057, browser_download_url: 'https://x/PocketMine-MP.phar', digest: 'sha256:abc' },
      ],
    },
    // a release with no phar is not installable and must not become a version
    { tag_name: '5.44.2', assets: [{ name: 'build_info.json', id: 3, size: 10 }] },
  ]);
  assert.strictEqual(trimmed.length, 1);
  assert.strictEqual(trimmed[0].version, '5.44.3');
  assert.strictEqual(trimmed[0].size, 3354057);
  assert.strictEqual(trimmed[0].sha256, 'sha256:abc');
});

test('PocketMine needs PHP 8.1, and says so when what is installed is too old', () => {
  assert.deepStrictEqual({ ...php.MIN }, { major: 8, minor: 1 });
  assert.strictEqual(php.compatible({ major: 8, minor: 1 }), true);
  assert.strictEqual(php.compatible({ major: 8, minor: 4 }), true);
  assert.strictEqual(php.compatible({ major: 9, minor: 0 }), true);
  assert.strictEqual(php.compatible({ major: 8, minor: 0 }), false);
  assert.strictEqual(php.compatible({ major: 7, minor: 4 }), false);
  assert.strictEqual(php.compatible(null), false);

  // "you have 7.4 and it will not work" is more useful than "no PHP"
  const old = php.explainMissing({ version: '7.4.33', major: 7, minor: 4 });
  assert.ok(/7\.4\.33/.test(old), old);
  assert.ok(/8\.1 or newer/.test(old), old);

  const none = php.explainMissing(null);
  assert.ok(/no PHP on this machine/i.test(none), none);
  // and it has to explain why EnvServer will not fix it itself
  assert.ok(/does not install PHP|not be downloaded|redistributable/i.test(none), none);
});

test('php.probe reads the version from the interpreter, not from a folder name', () => {
  // no PHP on the test machine, so this asserts the failure is a clean null
  return php.probe(path.join(os.tmpdir(), 'definitely-not-php.exe')).then((res) => {
    assert.strictEqual(res, null);
  });
});

test('php.candidates offers the explicit path first and dedupes', () => {
  const list = [...php.candidates('C:\\nope\\php.exe')];
  assert.strictEqual(list[0], path.resolve('C:\\nope\\php.exe'));
  assert.strictEqual(new Set(list).size, list.length, 'the same php.exe was offered twice');
});

test('the Bedrock ping is a well-formed RakNet unconnected ping', () => {
  const buf = ping.packetBedrockPing();
  assert.strictEqual(buf.length, 33, 'RakNet unconnected ping is 33 bytes');
  assert.strictEqual(buf[0], 0x01, 'packet id');
  // the offline message identifier, byte for byte - get this wrong and the
  // server silently ignores the ping, which looks exactly like "unreachable"
  assert.deepStrictEqual([...buf.subarray(9, 25)], [...ping.RAKNET_MAGIC]);
  assert.strictEqual(ping.RAKNET_MAGIC.length, 16);
  // the timestamp must advance, or some servers treat repeats as replays
  const later = ping.packetBedrockPing();
  assert.ok(later.readBigUInt64BE(1) >= buf.readBigUInt64BE(1));
});

test('statusFor picks the protocol the software actually speaks', async () => {
  // both fail fast against a closed port, but the failure must be clean rather
  // than a hang: a status sample that never settles stalls the whole monitor
  const java = await ping.statusFor('java', '127.0.0.1', 1, { timeout: 300 });
  assert.strictEqual(java.ok, false);
  const bedrock = await ping.statusFor('none', '127.0.0.1', 1, { timeout: 300 });
  assert.strictEqual(bedrock.ok, false);
  const php = await ping.statusFor('php', '127.0.0.1', 1, { timeout: 300 });
  assert.strictEqual(php.ok, false);
});

test('a Bedrock MOTD that is not JSON is still readable', () => {
  assert.strictEqual(ping.flattenMotd('plain text'), 'plain text');
  assert.strictEqual(ping.flattenMotd({ text: 'a', extra: [{ text: 'b' }] }), 'ab');
});

test('a server that has never started reports a missing properties file, not an empty one', () => {
  // these are different states and the Config view says different things about
  // each: "there is no file yet" versus "there is a file with nothing set in it"
  const missing = config.readProperties(path.join(os.tmpdir(), 'envserver-no-such-properties-file'));
  assert.strictEqual(missing.missing, true);
  assert.deepStrictEqual(missing.values, {});

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'envserver-props-')), 'server.properties');
  fs.writeFileSync(file, 'motd=hello\nmax-players=8\n', 'utf8');
  const present = config.readProperties(file);
  assert.strictEqual(present.missing, false);
  assert.strictEqual(present.values.motd, 'hello');
  assert.strictEqual(present.values['max-players'], '8');
});

test('Bedrock software is told why, rather than sent to Minecraft\'s EULA', () => {
  // its own data dir, so it does not depend on whichever test happens to have
  // called store.init() before it - and so it leaves no server behind
  const dir = tmp('store-bedrock');
  store.init(dir);
  store.write({ serversDir: dir, port: 25565 });
  paths.init(path.join(dir, 'data'));
  paths.setServersRoot(path.join(dir, 'servers'));

  const s = store.createServer({ name: 'NoJavaProps', mcVersion: '1.21.1.0', type: 'bedrock' });
  try {
    const res = config.seedDefaults(s.id, { port: 19132, software: 'bedrock' });
    assert.strictEqual(res.seeded, false, 'Bedrock must not get a Java server.properties');
    assert.strictEqual(res.skipped, 'non-java');
    assert.strictEqual(config.readProperties(paths.serverProperties(s.id)).missing, true);

    const php = config.seedDefaults(s.id, { port: 19132, software: 'pocketmine' });
    assert.strictEqual(php.seeded, false, 'PocketMine writes its own properties too');

    // and the EULA gate agrees: main answers "nothing to accept", not "accepted"
    assert.strictEqual(runtime.forSoftware('bedrock').eula, false);
    assert.strictEqual(runtime.forSoftware('pocketmine').eula, false);
  } finally {
    store.removeServer(s.id);
  }
});

test('php.listRuntimes reports nothing rather than throwing on a machine without PHP', async () => {
  const found = await php.listRuntimes({ phpPath: '' });
  assert.ok(Array.isArray(found));
  // every entry is a real, probed interpreter
  for (const r of found) {
    assert.ok(/\.exe$/i.test(r.exe), r.exe);
    assert.strictEqual(typeof r.ok, 'boolean');
  }
});

/* ================================ paper ================================== */

test('sortVersions puts the newest first, and a release above its own rc', () => {
  const sorted = paper.sortVersions(['1.21.4-rc3', '1.20.6', '1.21.4', '1.21.10', '26.3', '1.9.4']);
  assert.deepStrictEqual(sorted, ['26.3', '1.21.10', '1.21.4', '1.21.4-rc3', '1.20.6', '1.9.4']);
});

test('a Paper API failure reads like advice, not a stack trace', () => {
  const dns = paper.friendly(new Error('getaddrinfo ENOTFOUND fill.papermc.io'));
  assert.ok(/internet/i.test(dns), dns);
  const refused = paper.friendly(new Error('HTTP 404 Not Found'));
  assert.ok(/refused/i.test(refused), refused);
});

/* =============================== paths ================================== */

test('segment rejects anything that could escape or be mangled', () => {
  assert.strictEqual(paths.segment('survival-1'), 'survival-1');
  assert.throws(() => paths.segment(''), /invalid/);
  assert.throws(() => paths.segment('.'), /invalid/);
  assert.throws(() => paths.segment('..'), /invalid/);
  assert.throws(() => paths.segment('a/b'), /invalid/);
  assert.throws(() => paths.segment('a\\b'), /invalid/);
  assert.throws(() => paths.segment('a:b'), /invalid/);
  assert.throws(() => paths.segment('a' + String.fromCharCode(0) + 'b'), /invalid/, 'a NUL byte');
  assert.throws(() => paths.segment('a' + String.fromCharCode(1) + 'b'), /invalid/, 'a control byte');
  assert.throws(() => paths.segment('a?b'), /invalid/, 'a question mark is a wildcard on Windows');
  assert.throws(() => paths.segment('a*b'), /invalid/);
  assert.throws(() => paths.segment('a|b'), /invalid/);
  assert.throws(() => paths.segment('trailing.'), /invalid/, 'Windows silently trims a trailing dot');
  // a trailing space is trimmed rather than rejected, which is what makes the
  // on-disk name match the one that was recorded
  assert.strictEqual(paths.segment('trailing '), 'trailing');
  // a space in the middle is legal in a Windows filename and is kept
  assert.strictEqual(paths.segment('my server'), 'my server');
});

test('makeId produces a safe, unique-ish folder name', () => {
  const id = paths.makeId('My Server!! (2)');
  // the "(2)" is a legal path character, so it survives as part of the slug
  assert.ok(/^my-server-2-[a-z0-9]+$/.test(id), id);
  assert.notStrictEqual(paths.makeId('same'), paths.makeId('same'));
  assert.ok(paths.segment(id));
  assert.ok(paths.makeId('').startsWith('server-'));
});

test('dirSize adds up a tree', () => {
  const dir = tmp('size');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'a'), Buffer.alloc(100));
  fs.writeFileSync(path.join(dir, 'sub', 'b'), Buffer.alloc(250));
  assert.strictEqual(paths.dirSize(dir), 350);
});

/* =============================== store ================================== */

test('cleanServer re-validates everything that came off disk or over IPC', () => {
  const clean = store.cleanServer({
    id: 'ok-1',
    name: 'Survival',
    mcVersion: '1.21.4',
    port: 70000,
    memory: { min: 999999, max: 10 },
    extraArgs: 'a\nb',
    createdAt: 'nonsense',
  });
  assert.strictEqual(clean.port, 65535, 'a port above the range is clamped');
  assert.strictEqual(clean.memory.min, 32768);
  assert.strictEqual(clean.memory.max, 32768, 'max must not end up below min');
  assert.strictEqual(clean.extraArgs, 'a b', 'newlines are stripped from arguments');
  assert.ok(Number.isFinite(clean.createdAt));
  assert.strictEqual(store.cleanServer({ id: '' }), null, 'an empty id is not a server');
  assert.strictEqual(store.cleanServer({ id: '../evil' }), null);
});

test('memoryPair always returns a startable pair', () => {
  assert.deepStrictEqual(store.memoryPair({ min: 2048, max: 1024 }, { min: 512, max: 1024 }), { min: 2048, max: 2048 });
  assert.deepStrictEqual(store.memoryPair(undefined, { min: 512, max: 1024 }), { min: 512, max: 1024 });
  assert.deepStrictEqual(store.memoryPair({ min: 'x', max: null }, { min: 512, max: 1024 }), { min: 512, max: 1024 });
});

test('cleanSettings drops a duplicate id and an unknown active pointer', () => {
  const settings = store.cleanSettings({
    servers: [
      { id: 'dup-1', name: 'one' },
      { id: 'dup-1', name: 'two' },
      { id: 'keep-1', name: 'three' },
    ],
    activeServerId: 'gone-9',
    javaPerServer: { 'keep-1': 'C:/java', 'gone-9': 'C:/java', 'bad/id': 'C:/java' },
    window: { width: 10, height: 99999 },
  });
  assert.strictEqual(settings.servers.length, 2, 'a duplicate id would have two records fighting over one folder');
  assert.strictEqual(settings.servers[0].name, 'one', 'the first record wins');
  // an active pointer to a server that no longer exists falls back to the first
  assert.strictEqual(settings.activeServerId, 'dup-1');
  assert.deepStrictEqual(Object.keys(settings.javaPerServer), ['keep-1'], 'a pin for an unusable id is dropped');
  assert.strictEqual(settings.window.width, 900, 'the window is clamped to something usable');
  assert.strictEqual(settings.window.height, 10000);
});

test('the settings file round-trips and drops a bad pin', () => {
  const dir = tmp('store');
  store.init(dir);
  store.write({ serversDir: dir, port: 25565 });

  store.createServer({ name: 'Test Server', mcVersion: '1.21.4' });
  const [created] = store.listServers();

  // a pin is only meaningful for a server that exists
  store.setJavaPin(created.id, 'C:/jdk21');
  store.write({ javaPerServer: { ...store.read().javaPerServer, 'ghost-1': 'C:/jdk21' } });

  const read = store.read();
  assert.strictEqual(read.serversDir, dir);
  assert.strictEqual(read.javaPerServer[created.id], 'C:/jdk21');
  assert.strictEqual('ghost-1' in read.javaPerServer, false, 'a pin for a server that does not exist is dead state');
  assert.strictEqual(store.setJavaPin(created.id, '').ok, true);
  assert.strictEqual('srv-b' in store.read().javaPerServer, false, 'an empty pin means "automatic", not an empty path');

  const servers = store.listServers();
  assert.strictEqual(servers.length, 1);
  assert.ok(fs.existsSync(paths.serverDir(servers[0].id)), 'the folder is created up front');

  const res = store.removeServer(servers[0].id);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(store.listServers().length, 0);
});

/* ============================ eula and lists ============================ */

test('eula is read and written in the format vanilla expects', () => {
  const dir = tmp('eula');
  const file = path.join(dir, 'eula.txt');
  assert.strictEqual(config.readEula(file), false, 'a missing eula.txt means not accepted');
  config.writeEula(file, true);
  assert.ok(/#/.test(fs.readFileSync(file, 'utf8')), 'the comment header is kept');
  assert.strictEqual(config.readEula(file), true);
  config.writeEula(file, false);
  assert.strictEqual(config.readEula(file), false);
});

test('a corrupt player list is reported, not silently read as empty', () => {
  const dir = tmp('list');
  const file = path.join(dir, 'whitelist.json');
  fs.writeFileSync(file, 'not json at all');
  const res = config.readJsonList(file);
  assert.strictEqual(res.ok, false);
  assert.ok(/JSON/.test(res.error), res.error);

  fs.writeFileSync(file, JSON.stringify([{ uuid: 'x', name: 'Steve' }]));
  assert.deepStrictEqual(config.readJsonList(file).list, [{ uuid: 'x', name: 'Steve' }]);

  // the wrapped `{players: []}` shape some tools write is accepted too
  fs.writeFileSync(file, JSON.stringify({ players: [{ name: 'Alex' }] }));
  assert.strictEqual(config.readJsonList(file).list.length, 1);

  fs.writeFileSync(file, JSON.stringify({ nope: 1 }));
  assert.strictEqual(config.readJsonList(file).ok, false);
});

test('seedDefaults does not overwrite a tuned server.properties', () => {
  const dir = tmp('seed');
  const file = path.join(dir, 'server.properties');
  config.seedDefaults('x', { port: 25566 });
  // the helper is path-based, so drive it through a real id
  const id = 'seedtest-1';
  paths.init(path.join(dir, 'data'));
  paths.setServersRoot(path.join(dir, 'servers'));
  fs.mkdirSync(paths.serverDir(id), { recursive: true });

  assert.strictEqual(config.seedDefaults(id, { port: 25566 }).seeded, true);
  assert.strictEqual(config.readProperties(paths.serverProperties(id)).values['server-port'], '25566');

  fs.appendFileSync(paths.serverProperties(id), 'my-custom=keep-me\n');
  assert.strictEqual(config.seedDefaults(id, { port: 25565 }).seeded, false, 'an existing file must be left alone');
  assert.strictEqual(config.readProperties(paths.serverProperties(id)).values['my-custom'], 'keep-me');
});

test('tailLog returns the last lines and copes with no log at all', () => {
  const id = 'logtest-1';
  const dir = tmp('logs');
  paths.init(path.join(dir, 'data'));
  paths.setServersRoot(path.join(dir, 'servers'));
  fs.mkdirSync(paths.serverLogs(id), { recursive: true });

  assert.deepStrictEqual(config.tailLog(id), []);

  const many = Array.from({ length: 50 }, (_, i) => `line ${i}`);
  fs.writeFileSync(path.join(paths.serverLogs(id), 'latest.log'), `${many.join('\r\n')}\r\n`);
  const tail = config.tailLog(id, 10);
  assert.strictEqual(tail.length, 10);
  assert.strictEqual(tail[9], 'line 49');
});

/* ===================== regressions from the review ====================== */

/*
 * Each of these locks in a bug that was actually found and fixed during the
 * review pass. They are here because the original assertions did not exist when
 * the bug shipped, which is how it shipped.
 */

test('intIn keeps a missing value from collapsing to zero', () => {
  // `Number(null) === 0` and `Number('') === 0`, so a naive clamp turned an absent
  // "max-players" into 1 instead of leaving the default alone
  assert.strictEqual(store.intIn(null, 1, 100, 20), 20);
  assert.strictEqual(store.intIn(undefined, 1, 100, 20), 20);
  assert.strictEqual(store.intIn('', 1, 100, 20), 20);
  assert.strictEqual(store.intIn('nonsense', 1, 100, 20), 20);
  // a real 0 is still clamped into range rather than replaced by the fallback
  assert.strictEqual(store.intIn(0, 1, 100, 20), 1);
  assert.strictEqual(store.intIn(50, 1, 100, 20), 50);
  assert.strictEqual(store.intIn(500, 1, 100, 20), 100);
});

test('writing settings does not mutate the DEFAULTS object', () => {
  // DEFAULTS.memory is a shared object literal; a shallow merge into it would make
  // every later write inherit the previous server's heap size
  const dir = tmp('store-defaults');
  store.init(dir);
  const before = { ...DEFAULTS_MEMORY() };

  store.write({ memory: { min: 2048, max: 12288 } });
  assert.deepStrictEqual(DEFAULTS_MEMORY(), before, 'DEFAULTS.memory was mutated by write()');

  store.write({ port: 25570 });
  assert.deepStrictEqual(DEFAULTS_MEMORY(), before);
  assert.strictEqual(store.read().memory.max, 12288, 'the write itself must have stuck');
});

function DEFAULTS_MEMORY() {
  return store.DEFAULTS.memory;
}

test('buildArgs never emits -Xmx below -Xms', () => {
  // the reversed pair is what a settings file or a stale slider can produce
  for (const memory of [
    { min: 4096, max: 512 },
    { min: 8192, max: 1024 },
    { min: 1024, max: 512 },
  ]) {
    const args = server.buildArgs({ memory });
    const min = Number(/^-Xms(\d+)M$/.exec(args[0])[1]);
    const max = Number(/^-Xmx(\d+)M$/.exec(args[1])[1]);
    assert.ok(max >= min, `-Xmx ${max} below -Xms ${min} for ${JSON.stringify(memory)}`);
  }
});

test('a bare throwable in the log is classified as an error', () => {
  assert.strictEqual(server.classify('java.lang.NullPointerException'), 'err');
  assert.strictEqual(server.classify('com.mojang.BrandingController: dead'), 'info');
  // a word that merely contains "error" in prose must not turn the line red
  assert.strictEqual(server.classify('0 Errors in the last minute'), 'info');
});

test('resolveBuild passes an already-resolved build record straight through', () => {
  // the offline-safe branch; a build number needs the API, so it is covered by e2e
  const record = { build: 42, url: 'https://example.invalid/paper.jar', sha256: 'abc', size: 1 };
  return paper
    .resolveBuild('1.21.4', record)
    .then((got) => assert.strictEqual(got, record, 'a record with a url must not be re-fetched'));
});

/* ------------------------------- updates -------------------------------- */

test('release tags parse whether or not they carry a v, and to three places', () => {
  assert.deepStrictEqual(updater.parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, text: '1.2.3' });
  assert.deepStrictEqual(updater.parseVersion('v1.2.3'), { major: 1, minor: 2, patch: 3, text: '1.2.3' });
  // a repo that tags 1.2 still has to sort below 1.2.1, not above it
  assert.strictEqual(updater.parseVersion('v1.2').text, '1.2.0');
  assert.strictEqual(updater.parseVersion(' 2 ').text, '2.0.0');
  assert.strictEqual(updater.parseVersion('nightly'), null);
  assert.strictEqual(updater.parseVersion(''), null);
  assert.strictEqual(updater.parseVersion(null), null);
});

test('version comparison orders by major, then minor, then patch', () => {
  assert.ok(updater.compare('1.0.0', '1.0.1') < 0, '1.0.0 is older than 1.0.1');
  assert.ok(updater.compare('1.10.0', '1.9.0') > 0, 'minor is compared as a number, not a string');
  assert.ok(updater.compare('2.0.0', '1.99.99') > 0, 'major outranks minor');
  assert.strictEqual(updater.compare('v1.0', '1.0.0'), 0, 'a missing patch is zero');
  // an unparseable version must never be offered as an update or a rollback
  assert.ok(updater.compare('nightly', '1.0.0') > 0);
  assert.strictEqual(updater.compare('nightly', 'garbage'), 0);
});

test('the setup installer is preferred over the portable build', () => {
  // a portable exe unpacks itself somewhere temporary and leaves two copies of
  // the app behind, so it must never be the asset an update installs
  const setup = /-Setup\.exe$/i;
  assert.ok(setup.test('EnvServer-1.1.0-Setup.exe'));
  assert.ok(!setup.test('EnvServer-1.1.0-portable.exe'));
  assert.ok(!setup.test('EnvServer-1.1.0-Setup.exe.blockmap'));
});

test('the JVM heap is read from committed, not from total reserved', () => {
  // JDK 21+ output. `total reserved 1073741824K` is the heap's growth limit, not
  // -Xmx; only `committed` is what the flag set.
  const modern =
    '13424:\n' +
    'garbage-first heap   total reserved 1073741824K, committed 524288K, used 212672K [0x00000000e0000000, 0x0000000100000000)\n' +
    ' region size 1024K, 6 young (6144K), 4 survivors (4096K)\n';
  assert.deepStrictEqual(server.parseHeapInfo(modern), { usedMb: 208, maxMb: 512 });

  // JDK 8/11 output
  const old = '12345:\ngarbage-first heap   total 1048576K, used 262144K [0x...\n Metaspace       used 65536K\n';
  assert.deepStrictEqual(server.parseHeapInfo(old), { usedMb: 256, maxMb: 1024 });

  // a JRE with no jcmd, or a JVM that died mid-inspection
  assert.strictEqual(server.parseHeapInfo(''), null);
  assert.strictEqual(server.parseHeapInfo('Could not find any processes matching'), null);
  assert.strictEqual(server.parseHeapInfo(null), null);
});

test('zipDir honours a cancel signal', async () => {
  const src = tmp('zip-cancel');
  fs.writeFileSync(path.join(src, 'a.txt'), Buffer.alloc(200000, 3));
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => zip.zipDir(src, path.join(tmp('zip-cancel-out'), 'x.zip'), { signal: ac.signal }), /cancelled/);
});

test('extractAll can filter, and reports progress for the whole archive', async () => {
  const src = tmp('zip-filter');
  fs.writeFileSync(path.join(src, 'keep.txt'), 'keep');
  fs.writeFileSync(path.join(src, 'skip.txt'), 'skip');
  const archive = path.join(tmp('zip-filter-out'), 'x.zip');
  await zip.zipDir(src, archive);

  const dest = tmp('zip-filter-dest');
  const seen = [];
  await zip.extractAll(archive, dest, {
    onProgress: (done, total) => seen.push([done, total]),
    filter: (name) => name.endsWith('keep.txt'),
  });

  assert.deepStrictEqual(fs.readdirSync(dest), ['keep.txt']);
  assert.deepStrictEqual(seen[seen.length - 1], [2, 2], 'progress must cover every entry');
});

test('pinging something that is not a Minecraft server resolves with a reason', async () => {
  const net = require('net');
  // a plain TCP listener accepts the socket then says nothing usable
  const sockets = [];
  const srv = net.createServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => {});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();

  try {
    const res = await ping.status('127.0.0.1', port, { timeout: 1200 });
    assert.strictEqual(res.ok, false);
    assert.ok(res.reason, 'a failure must say why');
  } finally {
    // close() only fires once every accepted socket is gone, and a client that
    // times out leaves one hanging here
    for (const s of sockets) s.destroy();
    srv.close();
  }
});

test('an offline UUID entry matches what the server will compute', () => {
  // The whole point: on an online-mode=false server, vanilla derives the UUID from
  // MD5("OfflinePlayer:<name>") using the exact name the client connected with, so
  // a random or made-up UUID would never match the player.
  const name = 'Steve';
  const mine = config.offlineUuid(name);

  assert.strictEqual(mine, config.offlineUuid(name), 'must be deterministic');
  // case is significant, because the server hashes the name it was given - a
  // lowercase entry does not match a player connecting as "Steve"
  assert.notStrictEqual(mine, config.offlineUuid('steve'));
  // whitespace is significant to the hash, so the name has to be normalised once,
  // at the edge, and the UUID must be derived from the normalised name - otherwise a
  // pasted "Steve " produces an entry that never matches
  const checked = config.validatePlayerName('  Steve  ');
  assert.strictEqual(checked.ok, true);
  assert.strictEqual(checked.name, 'Steve');
  assert.strictEqual(config.offlineUuid(checked.name), mine);
});

/* ================================= run =================================== */

tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'envserver-test-'));
process.on('exit', () => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

run();