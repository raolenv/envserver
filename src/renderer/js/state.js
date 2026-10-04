/**
 * Application state.
 *
 * One mutable object plus a subscriber list. Views rebuild wholesale, which is
 * plenty fast at this size and keeps state plumbing out of the DOM layer.
 *
 * Render discipline (the rules that keep this from flickering or losing input):
 *
 *  - never call `saveSettings()` from inside a render function - emitting during
 *    a render re-enters the render;
 *  - the console view does not re-render for log lines, it appends them, because
 *    a re-render would kill the scroll position and the text field the user is
 *    typing a command into;
 *  - RAM sliders write silently on `input` (label only) and emit on `change`.
 */

import { toast } from './ui/toast.js';
import { softwareById, softwareSource, softwarePort } from './software.js';

const listeners = new Set();

/**
 * Views that only mean anything with a server selected.
 *
 * `settings` is deliberately absent: it configures the app, not a server, so it
 * stays reachable from the server list with nothing picked.
 */
export const SERVER_VIEWS = new Set(['dashboard', 'console', 'config', 'versions', 'plugins']);

export const state = {
  ready: false,
  onboarded: false,
  view: 'home',

  settings: {
    serversDir: '',
    javaPath: '',
    memory: { min: 1024, max: 4096 },
    port: 25565,
    extraArgs: '',
    useRecommendedFlags: true,
    autoInstallJava: true,
    autoBackupHours: 0,
    backupsKeep: 10,
    stopOnExit: true,
    consoleLines: 2000,
    totalMemoryMb: 0,
  },

  dataDir: '',
  serversRoot: '',
  /** the running app's own version, from the main process - never a literal */
  appVersion: '',

  /** @type {Array<object>} */
  servers: [],
  activeId: '',

  /** everything the main process assembled for the active server */
  detail: null,

  /** live process state from `evt:status` for the active server */
  status: null,

  /**
   * Status of every server that has reported, keyed by server id.
   *
   * `state.status` alone only ever holds the selected server, so the server list
   * had no way to show which rows were actually online. The map is fed by the
   * same `evt:status` stream and each id is dropped again on exit.
   */
  statuses: {},

  /** console lines for the active server, newest last */
  logs: [],
  logLoaded: false,

  /**
   * The version catalogue.
   *
   * `list`/`loading`/`error` belong to the create form and follow `createType`;
   * `byType` keeps one cached list per API so flipping the software dropdown back
   * and forth is instant and costs no requests.
   */
  versions: { list: [], loading: false, error: null, source: '', byType: {} },
  /** what the Versions view shows, following the active server's software */
  serverVersions: { key: '', list: [], loading: false, error: null, source: '', canInstall: true, port: 25565 },
  /** builds of the version being browsed in the Versions view */
  builds: { mcVersion: '', key: '', list: [], loading: false, error: null, meta: null },

  /** JVM plan from the main process */
  jvm: { loaded: false, loading: false, error: null, runtimes: [], plan: [], coverage: [], missing: [], autoInstall: true },

  /**
   * What runs each software, and what this machine has.
   *
   * `software` is id -> { kind, label, ... } so a view can say "PHP 8.3" or
   * "no JVM involved" without re-deriving it, and `php` is the detected list so
   * Settings can show where PocketMine's runtime came from.
   */
  runtime: { loaded: false, software: {}, java: [], php: [], phpMin: '8.1', ports: {} },

  versionQuery: '',
  javaFilter: 'all',
  /** a server whose jar install is in flight, so the buttons can disable */
  busy: false,
  /** toggles the create-server card on the home page */
  homeCreating: false,
  /** the server type picked in the create form */
  createType: 'paper',
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(reason = 'change') {
  for (const fn of listeners) fn(reason);
}

/* --------------------------------- boot --------------------------------- */

export async function init() {
  const data = await window.env.settings.read();

  state.settings = { ...state.settings, ...(data.settings || {}) };
  state.dataDir = data.dataDir || '';
  state.serversRoot = data.serversDir || '';
  state.appVersion = data.appVersion || '';
  state.onboarded = Boolean(data.settings?.onboarded);

  const list = await window.env.servers.list();
  state.servers = list.servers || [];
  state.activeId = pickActive(state.servers, data.settings?.activeServerId);

  // seed the per-server status map so online servers don't show as stopped
  // until the next monitor tick; the map is keyed by serverId, same as the
  // `evt:status` events that fill it in later.
  state.statuses = {};
  for (const id of list.runningIds || []) {
    state.statuses[id] = { serverId: id, running: true, phase: 'running' };
  }

  // what runs each software, and whether this machine has a runtime for it.
  // Deliberately not awaited into the boot path: it probes every java.exe and
  // php.exe on the machine, which takes a moment, and the first paint must not
  // wait for it. Views read `state.runtime` and re-render when it lands.
  loadRuntimeOverview();

  state.ready = true;
  // exposed for the smoke test: after a reload the renderer has to come back with
  // the server it just created, and this is the only way to see that from outside
  window.__envServers = state.servers.length;
  window.__envActive = state.activeId;
  // the layout and behaviour probes drive the main process directly, then need
  // the renderer to believe it; without this they read a stale `state.servers`
  // and quietly report the wrong thing
  window.__envRefreshServers = refreshServers;
  window.__envOpenServer = openServer;
  // screenshot runs have to land on a named view before the capture, and clicking
  // the nav by label text is not reliable: the label carries a count when one is
  // running, and a software without the capability has no tab to click at all
  window.__envSetView = setView;
  // the whole store, for probes. A dynamic `import()` is a parse error in the
  // inline script `executeJavaScript` runs probes in, and guessing at the DOM
  // instead of reading the state is how a probe ends up reporting the absence of
  // the very thing it was written to look for
  window.__envState = state;
  emit('init');

  if (state.activeId) await selectServer(state.activeId, { silent: true });
  if (window.__envForceCreate) state.homeCreating = true;
}

/**
 * Ask main what runs each software and whether this machine has it.
 *
 * Cheap enough to call on demand and cheap enough to call at boot, but it probes
 * every `java.exe` and `php.exe` it can find, so failures are swallowed: a view
 * that wanted this information falls back to the software table, which already
 * knows the runtime *kind*, and nobody is left with an error banner about a
 * runtime they were not going to use.
 */
export async function loadRuntimeOverview() {
  try {
    const res = await window.env.runtime.overview();
    if (!res?.ok) return state.runtime;
    state.runtime = {
      loaded: true,
      software: res.software || {},
      java: res.java || [],
      php: res.php || [],
      phpMin: res.phpMin || '8.1',
      ports: res.ports || {},
    };
    emit('runtime');
  } catch {
    /* the software table is the fallback; see above */
  }
  return state.runtime;
}

/**
 * Point EnvServer at a specific php.exe, or pass '' to auto-detect again.
 *
 * A pin is stored rather than probed on every start so a machine with two PHP
 * installs behaves the same way twice in a row.
 */
export async function setPhpPath(phpPath) {
  const res = await window.env.runtime.setPhpPath(phpPath || '');
  if (!res?.ok) return res;
  state.settings = { ...state.settings, phpPath: res.runtime?.exe || '' };
  await loadRuntimeOverview();
  emit('settings');
  return res;
}

/** Keep the active pointer on a server that still exists. */
function pickActive(servers, preferred) {
  if (servers.some((s) => s.id === preferred)) return preferred;
  return servers[0]?.id || '';
}

export function activeServer() {
  return state.servers.find((s) => s.id === state.activeId) || null;
}

export function isRunning(serverId) {
  return Boolean(state.status?.running && state.status.serverId === serverId);
}

/**
 * Live status for any server, not just the selected one.
 *
 * The server list reads this for every row, so a stopped server has to return
 * `null` rather than the last server that happened to report.
 */
export function statusFor(serverId) {
  const s = state.statuses[serverId];
  return s && s.serverId === serverId ? s : null;
}

/* ------------------------------- servers -------------------------------- */

export async function selectServer(id, { silent = false } = {}) {
  if (!state.servers.some((s) => s.id === id)) return;
  state.activeId = id;
  state.logs = [];
  state.logLoaded = false;

  await window.env.settings.write({ activeServerId: id });

  // the detail load is not optional: `activeId` alone renders "Loading server..."
  // forever, because nothing else ever fetches it for the newly active server
  await refreshDetail();

  if (state.view === 'console') await loadHistory();

  if (!silent) emit('server');
}

export async function refreshDetail() {
  if (!state.activeId) {
    state.detail = null;
    return;
  }
  const res = await window.env.servers.detail(state.activeId);
  if (!res?.ok) {
    state.detail = null;
    emit('detail');
    return;
  }
  state.detail = res;

  // fold the new record back into the list so the sidebar shows fresh names
  state.servers = state.servers.map((s) => (s.id === res.server.id ? res.server : s));

  // the live status event only arrives every few seconds, so the page has to
  // reflect what the main process knows right now
  if (res.status) {
    state.status = res.status.running ? res.status : null;
    const sid = res.server?.id || state.activeId;
    if (res.status.running) state.statuses[sid] = res.status;
    else delete state.statuses[sid];
  }
  emit('detail');
}

export async function refreshServers() {
  const res = await window.env.servers.list();
  state.servers = res.servers || [];
  state.activeId = pickActive(state.servers, state.activeId);
  emit('servers');
}

export async function createServer(opts) {
  const res = await window.env.servers.create(opts);
  if (!res?.ok) {
    toast(res?.error || 'Could not create that server', 'err');
    return null;
  }
  state.servers = [...state.servers, res.server];
  await selectServer(res.server.id);
  emit('servers');
  return res.server;
}

export async function deleteServer(id) {
  const res = await window.env.servers.remove(id);
  if (!res?.ok) {
    toast(res?.error || 'Could not remove that server', 'err');
    return false;
  }
  state.servers = state.servers.filter((s) => s.id !== id);
  state.activeId = pickActive(state.servers, state.activeId);
  if (state.activeId) await refreshDetail();
  emit('servers');
  return true;
}

/* ------------------------------- settings ------------------------------- */

export function saveSettings(patch, { silent = false } = {}) {
  state.settings = { ...state.settings, ...patch };

  const written = window.env.settings
    .write(patch)
    .then((res) => {
      // the servers root is applied in the main process; a bad folder is rejected there
      if (res && res.ok === false) toast(res?.error || 'Could not save that setting', 'err');
      return res;
    })
    .catch((err) => {
      toast(err.message || 'Could not save settings', 'err');
      return { ok: false, error: err.message };
    });

  if (!silent) emit('settings');
  return written;
}

/* --------------------------------- views -------------------------------- */

/**
 * Move between views.
 *
 * A server view with no server selected would render an empty shell, so those
 * fall back to the list instead of leaving the user on a dead page.
 */
export function setView(view) {
  if (SERVER_VIEWS.has(view) && !state.activeId) view = 'home';
  if (state.view === view) return;
  state.view = view;
  if (view === 'console' && !state.logLoaded) loadHistory();
  emit('view');
}

/** The server list - the page the app opens on. */
export function goHome() {
  setView('home');
}

/**
 * Open one server's page.
 *
 * Selecting and navigating happen together: from the list they are the same
 * gesture, and splitting them made every row do two renders with the wrong view
 * in between.
 */
export async function openServer(id, view = 'dashboard') {
  if (!state.servers.some((s) => s.id === id)) return;
  state.activeId = id;
  state.logs = [];
  state.logLoaded = false;

  await window.env.settings.write({ activeServerId: id });
  await refreshDetail();
  setView(SERVER_VIEWS.has(view) ? view : 'dashboard');
  if (state.view === 'console') await loadHistory();
}

/* ---------------------------- server versions --------------------------- */

/**
 * Fetch a Minecraft version list, once per catalogue.
 *
 * Every software that shares an API shares one request and one cache entry:
 * Spigot and CraftBukkit list the same Minecraft versions Paper does, and the
 * disk cache behind them already survives being offline.
 *
 * The *software id* is what gets sent - main resolves which API answers for it,
 * and knows that Spigot's versions are real but not downloadable - while the
 * `source` is what gets cached, so those three share one entry.
 *
 * @param {string} softwareId e.g. 'paper', 'vanilla', 'bedrock', 'pocketmine'
 */
async function fetchVersions(softwareId, refresh = false) {
  const key = softwareSource(softwareId);
  const hit = state.versions.byType[key];
  if (hit?.list?.length && !refresh) return hit;

  const res = await window.env.catalog.versions(softwareId, refresh);

  const entry = {
    list: res?.versions || [],
    error: res?.error || null,
    source: res?.source || '',
    // Spigot and CraftBukkit list real versions EnvServer cannot download, so
    // the Versions view has to say which of the two it is
    canInstall: res?.canInstall !== false,
    port: res?.port || softwarePort(softwareId),
  };
  state.versions.byType[key] = entry;
  return entry;
}

/** The create form's version list, following the software picked in the form. */
export async function refreshVersions(refresh = false) {
  const key = softwareSource(state.createType);

  state.versions.loading = true;
  emit('versions');

  const entry = await fetchVersions(state.createType, refresh);

  state.versions.loading = false;
  state.versions.list = entry.list;
  state.versions.source = entry.source;
  state.versions.error = entry.error;
  emit('versions');

  return !entry.error;
}

/**
 * The Versions view's list, following the *active server's* software.
 *
 * Separate from the create form's list on purpose: the form is about what you are
 * about to make, this is about what an existing server runs.
 */
export async function refreshServerVersions(type, refresh = false) {
  const key = softwareSource(type);
  if (state.serverVersions.key === key && state.serverVersions.list.length && !refresh) return true;

  state.serverVersions = { ...state.serverVersions, key, loading: true };
  emit('versions');

  const entry = await fetchVersions(type, refresh);

  state.serverVersions = {
    key,
    loading: false,
    list: entry.list,
    error: entry.error,
    source: entry.source,
    canInstall: entry.canInstall,
    port: entry.port,
  };
  emit('versions');

  return !entry.error;
}

/** Builds for one Minecraft version, plus its Java requirement. */
export async function loadBuilds(mcVersion, refresh = false) {
  if (!mcVersion) return;
  const sw = softwareById(activeServer()?.type || 'paper');
  if (state.builds.mcVersion === mcVersion && state.builds.key === sw.source && !refresh) return;

  state.builds = { mcVersion, key: sw.source, list: [], loading: true, error: null, meta: state.builds.meta };
  emit('builds');

  // one call for every software. Mojang's Java jar, Mojang's Bedrock zip and
  // PocketMine's phar each publish exactly one archive per version, so their
  // "build list" is a single entry that the Versions view renders as "latest".
  const res = await window.env.catalog.builds(sw.id, mcVersion, refresh);

  state.builds.loading = false;
  if (res?.ok) {
    state.builds.list = res.builds || [];
    state.builds.meta = res.meta || null;
    state.builds.error = null;
  } else {
    state.builds.error = res?.error || 'Could not load the build list for that version';
  }
  emit('builds');
}

export function visibleVersions() {
  const q = state.versionQuery.trim().toLowerCase();
  const list = state.serverVersions.list;
  if (!q) return list;
  return list.filter((v) => v.toLowerCase().includes(q));
}

/** Which of the listed versions already have a jar on disk. */
export function installedMcVersions() {
  const set = new Set();
  for (const server of state.servers) {
    if (server.mcVersion && server.jarInstalled) set.add(server.mcVersion);
  }
  return set;
}

/* ---------------------------- jvm matching ------------------------------ */

/**
 * Ask the main process which JVM each server would use.
 *
 * Probing `java -version` spawns a process per candidate, so this is not part of
 * `init()` and calls are serialised rather than skipped - a second request still
 * gets a fresh answer instead of the in-flight one.
 */
let jvmScan = Promise.resolve(false);

async function scanPlan(opts = {}) {
  state.jvm.loading = true;
  const res = await window.env.java.plan().catch((err) => ({ ok: false, error: err.message }));

  state.jvm.loading = false;
  state.jvm.loaded = true;

  if (!res?.ok) {
    state.jvm.error = res?.error || 'could not scan for Java runtimes';
    if (!opts.silent) toast(state.jvm.error, 'err');
    return false;
  }

  state.jvm.error = null;
  state.jvm.runtimes = res.runtimes || [];
  state.jvm.plan = res.plan || [];
  state.jvm.coverage = res.coverage || [];
  state.jvm.missing = res.missing || [];
  state.jvm.autoInstall = res.autoInstall !== false;
  if (!opts.silent) emit('jvm');
  return true;
}

export function refreshJvmPlan(opts = {}) {
  jvmScan = jvmScan.then(
    () => scanPlan(opts),
    () => scanPlan(opts)
  );
  return jvmScan;
}

/** The plan row for one server, or null if it is not in the plan. */
export function planFor(serverId) {
  return state.jvm.plan.find((p) => p.serverId === serverId) || null;
}

/**
 * Pin a server to a JVM, or pass an empty path to hand it back to auto-matching.
 *
 * Deliberately does not emit: the Settings panel re-renders only its own body so
 * the dropdown the user just touched is not destroyed mid-interaction.
 */
export async function assignJava(serverId, javaPath) {
  const res = await window.env.java.assign(serverId, javaPath);
  if (!res?.ok) return toast(res?.error || 'Could not save that assignment', 'err');
  await refreshServers();
  await refreshPlanQuiet();
  await refreshDetail();
  return true;
}

async function refreshPlanQuiet() {
  await scanPlan({ silent: true });
  emit('jvm');
}

/* -------------------------------- console ------------------------------- */

/** Keep the retained lines bounded so a long uptime cannot grow without limit. */
function trimLogs() {
  const max = state.settings.consoleLines || 2000;
  if (state.logs.length > max) state.logs = state.logs.slice(-max);
}

export function appendLog(entry) {
  state.logs.push(entry);
  trimLogs();
}

export async function loadHistory() {
  if (!state.activeId) return;
  const res = await window.env.server.history(state.activeId);
  if (res?.ok) {
    state.logs = (res.lines || []).map((line) => ({ line, level: 'info', at: Date.now(), history: true }));
    trimLogs();
    state.logLoaded = true;
  }
  emit('logs');
}

export function clearLogs() {
  state.logs = [];
  emit('logs');
}

export async function sendCommand(line) {
  if (!state.activeId) return { ok: false, error: 'no server selected' };
  const res = await window.env.server.send(state.activeId, line);
  if (!res?.ok) toast(res?.error || 'Could not send that command', 'err');
  return res;
}

/* ------------------------------- selectors ------------------------------ */

export function javaRuntimesFor(major) {
  return state.jvm.runtimes.filter((r) => r.major === Number(major));
}