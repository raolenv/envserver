'use strict';

const { ipcMain, dialog, shell, BrowserWindow, app } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const store = require('./store');
const paths = require('./services/paths');
const paper = require('./services/paper');
const purpur = require('./services/purpur');
const vanilla = require('./services/vanilla');
const java = require('./services/java');
const server = require('./services/server');
const config = require('./services/config');
const mojang = require('./services/mojang');
const updater = require('./services/updater');

/**
 * The whole privileged surface.
 *
 * Every handler answers with a plain object and never rejects: a throw across an
 * IPC boundary surfaces in the renderer as "Error invoking remote method" with the
 * real message swallowed, which is the worst possible outcome for something like
 * "this server has no jar yet".
 */

/** @type {Electron.BrowserWindow|null} */
let win = null;

/* ------------------------------- plumbing ------------------------------- */

function emit(channel, payload) {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send(channel, payload);
  } catch {
    /* the window can close between the check and the send */
  }
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, payload) => {
    try {
      const result = await fn(payload || {});
      // a handler that forgets to answer must not look like a silent success
      return result === undefined ? { ok: true } : result;
    } catch (err) {
      console.error(`[ipc] ${channel}:`, err);
      return { ok: false, error: err?.message || String(err) };
    }
  });
}

/** Resolve a server id or fail with a message rather than a TypeError. */
function serverOrThrow(id) {
  return store.requireServer(paths.segment(id));
}

/**
 * Probed Java runtimes, cached briefly.
 *
 * Probing spawns `java -version` per candidate, which is far too slow to do on
 * every render; the cache only has to outlive one screenful of updates.
 */
let runtimeCache = null;
const RUNTIME_TTL = 60_000;

async function runtimes({ force = false } = {}) {
  if (!force && runtimeCache && Date.now() - runtimeCache.at < RUNTIME_TTL) return runtimeCache.list;
  const list = await java.listRuntimes({ javaPath: store.read().javaPath });
  runtimeCache = { at: Date.now(), list };
  return list;
}

/** Called after a JDK is installed or a pin changes, so the plan is not stale. */
function invalidateRuntimes() {
  runtimeCache = null;
}

/* --------------------------------- java --------------------------------- */

/**
 * Make sure a usable JVM exists for `requiredMajor`, downloading one if allowed.
 *
 * This is the piece that makes the app work on a machine with no Java at all:
 * the runtime comes from Eclipse Adoptium, is verified against the SHA-256
 * Adoptium publishes, and lands in the app's own data folder.
 */
async function ensureJava(requiredMajor, scopeId = '') {
  const settings = store.read();
  const list = await runtimes();

  if (java.pickFor(requiredMajor, list)) return { ok: true, downloaded: false, runtimes: list };
  if (!settings.autoInstallJava) {
    return {
      ok: false,
      runtimes: list,
      error: java.explainMissing(requiredMajor),
    };
  }

  const runtime = await java.ensureRuntime(requiredMajor, {
    onProgress: (p) => emit('evt:download', { scope: 'java', id: String(requiredMajor), major: requiredMajor, ...p }),
  });
  invalidateRuntimes();

  return { ok: true, downloaded: true, runtime, runtimes: await runtimes({ force: true }) };
}

/**
 * Background jobs.
 *
 * Each long operation gets an id from the renderer plus an AbortController here,
 * so progress can be routed back to exactly the job that asked for it and a
 * cancel can actually interrupt a download rather than just hiding the bar.
 */
const jobControllers = new Map();

/** A controller for `jobId`, or a controller for an anonymous job. */
function jobSignal(jobId) {
  if (!jobId) return { signal: undefined, release: () => {} };
  const controller = new AbortController();
  jobControllers.set(jobId, controller);
  notifyJobs();
  return {
    signal: controller.signal,
    release: () => {
      jobControllers.delete(jobId);
      notifyJobs();
    },
  };
}

function activeJobCount() {
  return jobControllers.size;
}

/* ------------------------------- registers ------------------------------- */

function register() {
  /* ------------------------------ settings ------------------------------ */

  handle('settings:read', () => {
    const s = store.read();
    return {
      settings: {
        ...s,
        totalMemoryMb: server.totalMemoryMb(),
      },
      dataDir: paths.base(),
      serversDir: paths.serversRootDir(),
      runningIds: server.runningIds(),
    };
  });

  handle('settings:write', (patch) => {
    const before = store.read();
    const next = store.write(patch);
    // the servers root is applied outside the store, so a bad folder is caught there
    if ('serversDir' in patch) {
      try {
        paths.setServersRoot(next.serversDir);
      } catch (err) {
        return { ok: false, error: `that folder cannot be used: ${err.message}` };
      }
    }
    if (before.javaPath !== next.javaPath) invalidateRuntimes();
    return { ok: true, settings: next };
  });

  /* ------------------------------- servers ------------------------------ */

  handle('servers:list', async () => ({
    ok: true,
    // jar state travels with each record so the sidebar and the Versions list
    // can tell installed from available without a call per server
    servers: store.listServers().map((record) => ({
      ...record,
      jarInstalled: paper.installedInfo(record.id).installed,
      jarSize: paper.installedInfo(record.id).size,
    })),
    runningIds: server.runningIds(),
  }));

  handle('servers:create', (opts) => {
    const record = store.createServer(opts);
    config.seedDefaults(record.id, { port: record.port, motd: `${record.name} - an EnvServer server` });
    return { ok: true, server: record };
  });

  handle('servers:update', ({ id, patch }) => ({ ok: true, server: store.updateServer(paths.segment(id), patch) }));

  handle('servers:remove', async ({ id }) => {
    const sid = paths.segment(id);
    if (server.isRunning(sid)) {
      return { ok: false, error: 'stop the server before deleting it' };
    }
    const res = store.removeServer(sid);
    if (!res.ok) return res;
    // the folder is left on disk on purpose: it holds the world and the plugins,
    // and deleting someone's save because they removed a row from a list is not
    // a recoverable mistake
    return { ok: true, ...res, folder: paths.serverDir(sid) };
  });

  handle('servers:open-folder', ({ id }) => openManaged(paths.serverDir(paths.segment(id))));

  /**
   * Everything the dashboard needs about one server, in one round trip.
   *
   * Assembled here rather than in the renderer so the UI never has to stitch a
   * consistent picture together from six calls that can each arrive out of order.
   */
  handle('servers:detail', async ({ id }) => {
    const sid = paths.segment(id);
    const record = store.requireServer(sid);

    const props = config.readProperties(paths.serverProperties(sid));
    const settings = store.read();
    const requiredMajor = paper.requiredJava(record.mcVersion, record.type);
    const list = await runtimes();
    const resolution = record.mcVersion
      ? await java.resolveFor({
          requiredMajor,
          pinned: record.javaPath || settings.javaPerServer[sid] || '',
          javaPath: settings.javaPath,
          runtimes: list,
        })
      : null;

    const meta = record.mcVersion ? paper.cachedMeta(record.mcVersion, record.type) : null;
    const status = server.status(sid);

    return {
      ok: true,
      server: record,
      jar: paper.installedInfo(sid),
      eula: config.readEula(paths.serverEula(sid)),
      properties: props,
      port: Number(props.values['server-port']) || record.port,
      onlineMode: String(props.values['online-mode'] ?? 'true').toLowerCase() === 'true',
      java: {
        requiredMajor,
        recommended: meta?.recommendedFlags || [],
        supportStatus: meta?.supportStatus || 'UNKNOWN',
        supportEnd: meta?.supportEnd || '',
        resolved: resolution,
        explain: resolution
          ? resolution.match === 'newer' && resolution.risk
            ? java.explainMismatch(requiredMajor, resolution.major, record.mcVersion)
            : ''
          : java.explainMissing(requiredMajor, record.mcVersion),
      },
      disk: {
        total: paths.dirSize(paths.serverDir(sid)),
        world: paths.exists(paths.serverWorld(sid)) ? paths.dirSize(paths.serverWorld(sid)) : 0,
      },
      plugins: await config.listPlugins(sid),
      backups: server.listBackups(sid, { keep: settings.backupsKeep }),
      status,
      players: server.players(sid),
    };
  });

  /* -------------------------------- paper ------------------------------- */

  handle('paper:versions', async ({ refresh, project }) => {
    const res = await paper.listVersions({ refresh, project });
    return { ...res, ok: true };
  });

  handle('paper:builds', async ({ mcVersion, refresh, project }) => {
    const builds = await paper.listBuilds(mcVersion, { refresh, project });
    return { ok: true, builds, meta: paper.cachedMeta(mcVersion, project) };
  });

  handle('paper:install', async ({ serverId, mcVersion, build, jobId, project }) => {
    const sid = paths.segment(serverId);
    const record = store.requireServer(sid);
    const target = mcVersion || record.mcVersion;
    if (!target) throw new Error('pick a Minecraft version first');

    const proj = project || record.type || 'paper';
    // pull the metadata first so the UI can show what Java the release needs
    await paper.versionMeta(target, { project: proj }).catch(() => null);

    const chosen = build ? Number(build) : null;
    const job = jobSignal(jobId);

    try {
      const res = await paper.installJar({
        serverId: sid,
        mcVersion: target,
        build: chosen,
        project: proj,
        signal: job.signal,
        onProgress: (p) => emit('evt:download', { jobId, scope: 'paper', id: sid, mcVersion: target, ...p }),
      });

      const patch = { mcVersion: target };
      if (res.build) patch.build = res.build;
      if (proj) patch.type = proj;
      store.updateServer(sid, patch);

      if (!paths.exists(paths.serverProperties(sid))) {
        config.seedDefaults(sid, { port: record.port, motd: `${record.name} - an EnvServer server` });
      }

      if (project) patch.type = project;

      return { ok: true, ...res, server: store.getServer(sid), meta: paper.cachedMeta(target, project || record.type) };
    } catch (err) {
      // a cancelled download is not a failure worth a scary message
      if (err?.name === 'CancelledError' || /cancelled/i.test(err?.message || '')) {
        return { ok: false, cancelled: true, error: 'cancelled' };
      }
      throw err;
    } finally {
      job.release();
    }
  });

  /* --------------------------------- jobs ------------------------------- */

  handle('jobs:cancel', ({ jobId }) => {
    const controller = jobControllers.get(String(jobId || ''));
    if (!controller) return { ok: false, error: 'that job has already finished' };
    controller.abort(new Error('cancelled by the user'));
    return { ok: true };
  });

  handle('paper:remove-jar', async ({ id }) => {
    const sid = paths.segment(id);
    if (server.isRunning(sid)) return { ok: false, error: 'stop the server before removing its jar' };
    return paper.removeJar(sid);
  });

  /* ------------------------------- vanilla ------------------------------ */

  handle('vanilla:versions', async ({ refresh }) => {
    const res = await vanilla.listVersions({ refresh });
    return { ...res, ok: true };
  });

  handle('vanilla:install', async ({ serverId, mcVersion, jobId }) => {
    const sid = paths.segment(serverId);
    const record = store.requireServer(sid);
    const target = mcVersion || record.mcVersion;
    if (!target) throw new Error('pick a Minecraft version first');

    const job = jobSignal(jobId);

    try {
      const res = await vanilla.installJar({
        serverId: sid,
        mcVersion: target,
        signal: job.signal,
        onProgress: (p) => emit('evt:download', { jobId, scope: 'vanilla', id: sid, mcVersion: target, ...p }),
      });

      const patch = { mcVersion: target, type: 'vanilla' };
      store.updateServer(sid, patch);

      if (!paths.exists(paths.serverProperties(sid))) {
        config.seedDefaults(sid, { port: record.port, motd: `${record.name} - an EnvServer server` });
      }

      return { ok: true, ...res, server: store.getServer(sid) };
    } catch (err) {
      if (err?.name === 'CancelledError' || /cancelled/i.test(err?.message || '')) {
        return { ok: false, cancelled: true, error: 'cancelled' };
      }
      throw err;
    } finally {
      job.release();
    }
  });

  /* ------------------------------- purpur ------------------------------- */

  handle('purpur:versions', async ({ refresh }) => {
    const res = await purpur.listVersions({ refresh });
    return { ...res, ok: true };
  });

  handle('purpur:builds', async ({ mcVersion, refresh }) => {
    const builds = await purpur.listBuilds(mcVersion, { refresh });
    return {
      ok: true,
      builds,
      meta: {
        javaMajor: purpur.requiredJava(mcVersion),
        recommendedFlags: [],
        supportStatus: 'SUPPORTED',
        supportEnd: '',
        buildCount: builds.length,
      },
    };
  });

  handle('purpur:install', async ({ serverId, mcVersion, build, jobId }) => {
    const sid = paths.segment(serverId);
    const record = store.requireServer(sid);
    const target = mcVersion || record.mcVersion;
    if (!target) throw new Error('pick a Minecraft version first');

    const job = jobSignal(jobId);

    try {
      const res = await purpur.installJar({
        serverId: sid,
        mcVersion: target,
        build: build ? Number(build) : null,
        signal: job.signal,
        onProgress: (p) => emit('evt:download', { jobId, scope: 'purpur', id: sid, mcVersion: target, ...p }),
      });

      const patch = { mcVersion: target, type: 'purpur' };
      if (res.build) patch.build = res.build;
      store.updateServer(sid, patch);

      if (!paths.exists(paths.serverProperties(sid))) {
        config.seedDefaults(sid, { port: record.port, motd: `${record.name} - an EnvServer server` });
      }

      return { ok: true, ...res, server: store.getServer(sid) };
    } catch (err) {
      if (err?.name === 'CancelledError' || /cancelled/i.test(err?.message || '')) {
        return { ok: false, cancelled: true, error: 'cancelled' };
      }
      throw err;
    } finally {
      job.release();
    }
  });

  /* --------------------------------- java ------------------------------- */

  handle('java:probe', async ({ javaPath }) => {
    const info = await java.probe(
      /java\.exe$/i.test(String(javaPath || '')) ? javaPath : path.join(String(javaPath || ''), 'bin', 'java.exe')
    );
    if (!info?.ok) return { ok: false, error: 'that folder has no working Java in it' };
    return { ok: true, runtime: info };
  });

  handle('java:plan', async () => {
    const settings = store.read();
    const list = await runtimes({ force: true });

    const plan = [];
    for (const record of settings.servers) {
      const requiredMajor = paper.requiredJava(record.mcVersion, record.type);
      const resolution = record.mcVersion
        ? await java.resolveFor({
            requiredMajor,
            pinned: record.javaPath || settings.javaPerServer[record.id] || '',
            javaPath: settings.javaPath,
            runtimes: list,
          })
        : null;
      plan.push({
        serverId: record.id,
        name: record.name,
        mcVersion: record.mcVersion,
        requiredMajor,
        resolved: resolution,
        running: server.isRunning(record.id),
      });
    }

    const majors = [...new Set(list.map((r) => r.major))].sort((a, b) => b - a);
    return {
      ok: true,
      runtimes: list,
      bundled: java.bundledMajors(),
      plan,
      coverage: majors.map((m) => ({
        major: m,
        exact: plan.filter((p) => p.requiredMajor === m).length,
        covering: java.coverageFor(m),
      })),
      // feature versions some server needs and no installed runtime provides
      missing: [...new Set(plan.map((p) => p.requiredMajor).filter((m) => m && !java.pickFor(m, list)))].sort(
        (a, b) => a - b
      ),
      autoInstall: settings.autoInstallJava,
    };
  });

  handle('java:assign', ({ serverId, javaPath }) => {
    const sid = paths.segment(serverId);
    const res = store.setJavaPin(sid, javaPath);
    if (res.ok) {
      store.updateServer(sid, { javaPath: res.pinned });
      invalidateRuntimes();
    }
    return res;
  });

  handle('java:install', async ({ major }) => {
    const want = Number(major) || 0;
    if (!want) throw new Error('no Java version was named');
    const res = await ensureJava(want);
    return { ok: res.ok, downloaded: res.downloaded, runtime: res.runtime || null, error: res.error || '' };
  });

  handle('java:remove-runtime', ({ major }) => {
    invalidateRuntimes();
    return java.removeRuntime(Number(major));
  });

  /* -------------------------------- server ------------------------------ */

  handle('server:start', async ({ id }) => {
    const sid = paths.segment(id);
    const record = store.requireServer(sid);

    if (!record.mcVersion) throw new Error('pick a Minecraft version for this server first');
    if (!paths.exists(paths.serverJar(sid))) {
      throw new Error('this server has no Paper jar yet - install one from the Versions view');
    }
    if (!config.readEula(paths.serverEula(sid))) {
      throw new Error('accept the Minecraft EULA for this server first');
    }

    const settings = store.read();
    const requiredMajor = paper.requiredJava(record.mcVersion, record.type);
    const meta = paper.cachedMeta(record.mcVersion, record.type);

    const javaResult = await ensureJava(requiredMajor, sid);
    if (!javaResult.ok) throw new Error(javaResult.error);

    const status = await server.start(record, {
      requiredMajor,
      recommended: meta.recommendedFlags,
      useRecommendedFlags: settings.useRecommendedFlags,
      extraArgs: record.extraArgs || settings.extraArgs,
      javaPath: settings.javaPath,
      memory: record.memory,
      autoBackupHours: settings.autoBackupHours,
    });

    store.updateServer(sid, { lastStartedAt: Date.now() });
    return { ok: true, status, javaDownloaded: javaResult.downloaded, requiredMajor };
  });

  handle('server:stop', async ({ id, force }) => {
    const sid = paths.segment(id);
    if (!server.isRunning(sid)) return { ok: true, already: true };
    return server.stop(sid, { force });
  });

  handle('server:send', ({ id, line }) => server.send(paths.segment(id), line));

  handle('server:history', ({ id }) => ({ ok: true, lines: config.tailLog(paths.segment(id), 500) }));

  handle('server:dry-run', async ({ id }) => {
    const sid = paths.segment(id);
    const record = store.requireServer(sid);
    const requiredMajor = paper.requiredJava(record.mcVersion, record.type);
    const resolution = record.mcVersion
      ? await java.resolveFor({
          requiredMajor,
          pinned: record.javaPath || store.read().javaPerServer[sid] || '',
          javaPath: store.read().javaPath,
          runtimes: await runtimes(),
        })
      : null;
    const args = server.buildArgs({
      memory: record.memory,
      recommended: store.read().useRecommendedFlags ? paper.cachedMeta(record.mcVersion, record.type).recommendedFlags : [],
      extra: record.extraArgs || store.read().extraArgs,
      nogui: true,
    });
    return {
      ok: true,
      cwd: paths.serverDir(sid),
      jar: paths.exists(paths.serverJar(sid)),
      eula: config.readEula(paths.serverEula(sid)),
      requiredMajor,
      javaExe: resolution?.javaExe || '',
      match: resolution?.match || 'none',
      risk: Boolean(resolution?.risk),
      argv: [resolution?.javaExe || '<java>', ...args],
    };
  });

  /* ------------------------------- backups ------------------------------ */

  handle('server:backup', async ({ id }) => {
    const sid = paths.segment(id);
    const keep = store.read().backupsKeep;
    const res = await server.backup(sid, {
      keep,
      onProgress: (done, total) => emit('evt:download', { scope: 'backup', id: sid, done, total }),
    });
    return { ...res, backups: server.listBackups(sid, { keep }) };
  });

  handle('server:delete-backup', ({ id, name }) => server.deleteBackup(paths.segment(id), name));

  /* -------------------------------- config ------------------------------ */

  /**
   * Patch `server.properties`.
   *
   * Only the keys in the patch are touched. A wholesale rewrite would drop the
   * dozen settings this app does not model, and a server owner who added them by
   * hand would find them silently gone.
   */
  handle('config:write', ({ id, properties }) => {
    const sid = paths.segment(id);
    const current = config.readProperties(paths.serverProperties(sid));
    const order = [...current.order];
    const values = { ...current.values };

    for (const [key, raw] of Object.entries(properties || {})) {
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key)) continue;
      const value = String(raw ?? '')
        .replace(/[\r\n]+/g, ' ')
        .slice(0, 1000);
      if (!order.includes(key)) order.push(key);
      values[key] = value;
    }

    config.writeProperties(paths.serverProperties(sid), order, values);

    const record = store.getServer(sid);
    const port = Number(values['server-port']) || record?.port;
    if (record && port !== record.port) store.updateServer(sid, { port });

    return { ok: true, properties: { order, values }, port };
  });

  handle('config:set-eula', ({ id, accepted }) => {
    const sid = paths.segment(id);
    config.writeEula(paths.serverEula(sid), accepted);
    return { ok: true, eula: accepted };
  });

  handle('config:list', ({ id, which }) => {
    const file = playerFile(paths.segment(id), which);
    if (!file) throw new Error(`"${which}" is not a player list`);
    const res = config.readJsonList(file);
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, which, players: res.list.map(normaliseEntry).filter(Boolean) };
  });

  /**
   * Add a name to ops / whitelist / bans.
   *
   * The file is written *first* with the offline UUID and answered to straight
   * away. The real Mojang UUID is looked up afterwards, in the background, and
   * the entry is corrected in place when it arrives.
   *
   * Doing the lookup first is what made this feel broken: `api.mojang.com` is
   * reached over the network with retries, so on a slow or filtered connection
   * the click sat there for a minute and a half before anything appeared. The
   * offline UUID is not a guess - on `online-mode=false` it is exactly what the
   * server computes, and Paper fixes it up on the player's first join.
   */
  handle('config:add-player', async ({ id, which, name }) => {
    const sid = paths.segment(id);
    const file = playerFile(sid, which);
    if (!file) throw new Error(`"${which}" is not a player list`);

    const check = config.validatePlayerName(name);
    if (!check.ok) return check;

    const res = config.readJsonList(file);
    if (!res.ok) return { ok: false, error: res.error };

    const existing = res.list.map(normaliseEntry).filter(Boolean);
    if (existing.some((p) => p.name.toLowerCase() === check.name.toLowerCase())) {
      return { ok: false, error: `${check.name} is already on that list` };
    }

    const uuid = config.offlineUuid(check.name);
    const entry = { uuid, name: check.name, level: which === 'ops' ? 4 : 0, source: 'EnvServer', createdAt: new Date().toISOString() };
    config.writeJsonList(file, [...res.list, entry]);

    // does not block the click; failure just leaves the offline UUID in place
    resolveRealUuid(sid, which, check.name, uuid);

    return { ok: true, which, player: normaliseEntry(entry), resolved: false, players: existing.concat([normaliseEntry(entry)]) };
  });

  /**
   * Swap a guessed offline UUID for the real one, quietly.
   *
   * A short single attempt on purpose: this runs after the entry is already
   * usable, so there is nothing to wait for and a slow network must not queue up
   * a retry storm. The result is pushed to the renderer so the row updates.
   */
  async function resolveRealUuid(sid, which, name, offline) {
    let profile;
    try {
      profile = await mojang.profileFor(name);
    } catch {
      return;
    }
    if (!profile?.uuid || profile.uuid === offline) return;

    const file = playerFile(sid, which);
    if (!file) return;

    try {
      const current = config.readJsonList(file);
      if (!current.ok) return;
      let touched = false;
      const next = current.list.map((raw) => {
        const entry = normaliseEntry(raw);
        if (entry && entry.name.toLowerCase() === name.toLowerCase() && entry.uuid === offline) {
          touched = true;
          return { ...raw, uuid: profile.uuid };
        }
        return raw;
      });
      if (!touched) return;
      config.writeJsonList(file, next);
      emit('evt:players', { id: sid, which, name, uuid: profile.uuid });
    } catch (err) {
      console.warn('[config] could not store the real UUID for', name, err.message);
    }
  }

  handle('config:remove-player', ({ id, which, value }) => {
    const sid = paths.segment(id);
    const file = playerFile(sid, which);
    if (!file) throw new Error(`"${which}" is not a player list`);

    const res = config.readJsonList(file);
    if (!res.ok) return { ok: false, error: res.error };

    const needle = String(value || '').trim().toLowerCase();
    const kept = res.list.filter((raw) => {
      const entry = normaliseEntry(raw);
      if (!entry) return true; // keep anything unrecognisable rather than deleting it
      return !(entry.name.toLowerCase() === needle || entry.uuid.toLowerCase() === needle);
    });

    if (kept.length === res.list.length) return { ok: false, error: 'that player is not on the list' };

    config.writeJsonList(file, kept);
    return { ok: true, which, players: kept.map(normaliseEntry).filter(Boolean) };
  });

  /* -------------------------------- plugins ----------------------------- */

  handle('plugins:remove', async ({ id, fileName }) => config.removePlugin(paths.segment(id), fileName));

  /** Pick jars from Explorer and drop them straight into `plugins/`. */
  handle('plugins:pick', async ({ id }) => {
    if (!win || win.isDestroyed()) return { ok: false, error: 'no window' };
    const sid = paths.segment(id);

    const res = await dialog.showOpenDialog(win, {
      title: 'Add plugins',
      buttonLabel: 'Add to plugins/',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Plugin jars', extensions: ['jar'] }],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, cancelled: true };

    const added = [];
    const failed = [];
    for (const file of res.filePaths) {
      try {
        const buf = await fsp.readFile(file);
        const out = await config.installPlugin(sid, path.basename(file), buf.toString('base64'));
        if (out.ok) added.push(out);
        else failed.push({ file: path.basename(file), error: out.error });
      } catch (err) {
        failed.push({ file: path.basename(file), error: err.message });
      }
    }

    return { ok: failed.length === 0, added, failed, plugins: await config.listPlugins(sid) };
  });

  /* --------------------------------- shell ------------------------------ */

  /** Open one of a server's own subfolders (logs, world, plugins) in Explorer. */
  handle('shell:open-server-path', ({ id, which }) => {
    const sid = paths.segment(id);
    const sub = {
      root: paths.serverDir(sid),
      logs: paths.serverLogs(sid),
      world: paths.serverWorld(sid),
      plugins: paths.serverPlugins(sid),
    };
    const target = sub[which];
    if (!target) return { ok: false, error: `"${which}" is not a folder on a server` };
    return openManaged(target);
  });

  handle('shell:open-external', async ({ url }) => {
    // https only: a `file:` or custom-scheme URL here would be an arbitrary
    // handler launch triggered from renderer content
    if (!/^https:\/\//i.test(String(url || ''))) {
      return { ok: false, error: 'only https links can be opened' };
    }
    await shell.openExternal(url);
    return { ok: true };
  });

  handle('dialog:pick-directory', async () => {
    if (!win || win.isDestroyed()) return { ok: false, error: 'no window' };
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose where server folders live',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: paths.serversRootDir(),
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, cancelled: true };
    return { ok: true, dir: res.filePaths[0] };
  });

  handle('paths:reveal', () => openManaged(paths.base()));

  /* -------------------------------- updates ------------------------------- */

  handle('update:report', ({ refresh } = {}) => updater.report(app.getVersion(), { force: Boolean(refresh) }));

  handle('update:open-releases', async () => {
    await shell.openExternal(updater.releasesPage());
    return { ok: true };
  });

  /**
   * Install another version of EnvServer.
   *
   * The handler is intentionally not awaited to completion by anything: once the
   * installer process is running the app has to let go of its own files, so the
   * quit is scheduled by the updater and the renderer is told to stop drawing.
   */
  handle('update:install', ({ version } = {}) =>
    updater.install(version, {
      onProgress: (p) => emit('evt:update-progress', p),
      quit: () => quitForUpdate(),
    })
  );
}

/* -------------------------------- helpers ------------------------------- */

const PLAYER_FILES = {
  ops: (id) => paths.serverOps(id),
  whitelist: (id) => paths.serverWhitelist(id),
  banned: (id) => paths.serverBanned(id),
  bannedIps: (id) => paths.serverBannedIps(id),
};

function playerFile(serverId, which) {
  const pick = PLAYER_FILES[which];
  return typeof pick === 'function' ? pick(serverId) : null;
}

/**
 * Vanilla's player entries are `{uuid, name}`; ops carry extra fields and some
 * servers add their own. Anything with a usable name or uuid is kept, so editing
 * a list never quietly deletes an entry it did not understand.
 */
function normaliseEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || '').slice(0, 64);
  const uuid = String(raw.uuid || '').slice(0, 64);
  if (!name && !uuid) return null;
  return {
    name,
    uuid,
    level: Number(raw.level) || 0,
    source: String(raw.source || ''),
    addedAt: raw.addedAt || raw.createdAt || '',
  };
}

/**
 * Open a folder in Explorer, but only inside a directory this app manages.
 *
 * The renderer sends a path string, so without this check a compromised or buggy
 * UI could ask Explorer to open anything on the disk.
 */
async function openManaged(p) {
  const raw = String(p || '');
  if (!raw) return { ok: false, error: 'no path given' };

  const want = path.resolve(raw).toLowerCase();
  const roots = [paths.serversRootDir(), paths.runtimeDir(), paths.backupsRootDir(), paths.base()]
    .filter(Boolean)
    .map((r) => path.resolve(r).toLowerCase());

  const allowed = roots.some((root) => want === root || want.startsWith(root + path.sep));
  if (!allowed) return { ok: false, error: 'that folder is outside the ones EnvServer manages' };

  const target = paths.exists(raw) ? raw : path.dirname(raw);
  const err = await shell.openPath(target);
  if (err) return { ok: false, error: err };
  return { ok: true };
}

/* --------------------------------- events ------------------------------- */

function bind(window) {
  win = window;
}

function startEvents() {
  server.bus.on('log', (payload) => emit('evt:log', payload));
  server.bus.on('status', (payload) => emit('evt:status', payload));
  server.bus.on('exit', (payload) => {
    invalidateRuntimes();
    emit('evt:exit', payload);
  });
}

/** Notified whenever a job starts or ends, so the tray menu can stay truthful. */
const jobListeners = new Set();
function onJobChange(fn) {
  jobListeners.add(fn);
}

function notifyJobs() {
  for (const fn of jobListeners) {
    try {
      fn();
    } catch {
      /* a broken listener must not break the job */
    }
  }
}

/** Stop every server before the window disappears. */
async function shutdown() {
  const settings = store.read();
  if (!settings.stopOnExit) return;
  await server.stopAll({ force: false });
}

/**
 * Close the app so an installer can replace it.
 *
 * Deliberately not the same path as clicking X: hide-to-tray must not win here.
 * The installer is already waiting to write over the files this process is
 * holding open, so an app that survives its own update makes the install fail
 * with a locked file and leaves two half-copies of EnvServer behind.
 */
function quitForUpdate() {
  void (async () => {
    try {
      // respect the same rule as a normal close, so "stop servers when I quit"
      // still means it during an update
      if (store.read().stopOnExit) await server.stopAll({ force: false });
    } catch {
      /* a server that will not stop must not block the update */
    }
    try {
      if (win && !win.isDestroyed()) win.destroy();
    } catch {
      /* already gone */
    }
    app.exit(0);
  })();
}

module.exports = {
  register,
  bind,
  startEvents,
  shutdown,
  quitForUpdate,
  invalidateRuntimes,
  ensureJava,
  runtimes,
  serverOrThrow,
  activeJobCount,
  onJobChange,
};