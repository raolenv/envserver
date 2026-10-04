'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The entire privileged surface exposed to the renderer.
 *
 * Nothing here takes an arbitrary path or URL for the renderer to act on: every
 * operation is a named action, and the main process resolves ids to paths itself.
 * That is what keeps a bug in the UI from turning into a bug in the filesystem.
 */

const on = (channel) => (cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('env', {
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
    /** a reload of the app's own page, which the main process has to own */
    reload: () => ipcRenderer.send('window:reload'),
    toggleFullScreen: () => ipcRenderer.send('window:toggle-fullscreen'),
    getState: () => ipcRenderer.invoke('window:get-state'),
    onState: on('window:state'),
    /** true once the window is hidden to the tray instead of closed */
    onHideToTray: on('window:hidden-to-tray'),
  },

  /**
   * Background jobs.
   *
   * Downloads run in the main process and are reported by id, so the renderer can
   * walk away, switch server or hide to the tray without cancelling anything.
   */
  jobs: {
    cancel: (jobId) => ipcRenderer.invoke('jobs:cancel', { jobId }),
  },

  settings: {
    read: () => ipcRenderer.invoke('settings:read'),
    write: (patch) => ipcRenderer.invoke('settings:write', patch || {}),
  },

  servers: {
    list: () => ipcRenderer.invoke('servers:list'),
    create: (opts) => ipcRenderer.invoke('servers:create', opts || {}),
    update: (id, patch) => ipcRenderer.invoke('servers:update', { id, patch: patch || {} }),
    remove: (id) => ipcRenderer.invoke('servers:remove', { id }),
    /** everything the dashboard shows about one server, in one round trip */
    detail: (id) => ipcRenderer.invoke('servers:detail', { id }),
    openFolder: (id) => ipcRenderer.invoke('servers:open-folder', { id }),
  },

  /**
   * Server software catalogues: what versions exist, and installing one.
   *
   * This replaces three namespaces - `paper`, `purpur`, `vanilla` - that the
   * renderer had to branch on, with one that takes a software id. Nine software
   * now cost one code path instead of one each, which is the only reason Bedrock
   * was affordable to add at all.
   *
   * `software` is the id from software.js: 'paper', 'folia', 'purpur', 'vanilla',
   * 'spigot', 'bukkit', 'custom', 'bedrock', 'pocketmine'.
   */
  catalog: {
    versions: (software, refresh) =>
      ipcRenderer.invoke('catalog:versions', { software: software || 'paper', refresh: Boolean(refresh) }),
    builds: (software, mcVersion, refresh) =>
      ipcRenderer.invoke('catalog:builds', { software: software || 'paper', mcVersion, refresh: Boolean(refresh) }),
    /** `opts.jobId` tags the progress events so several installs can run at once */
    install: (opts) => ipcRenderer.invoke('catalog:install', opts || {}),
    /** remove the server files; the world is always left alone */
    remove: (serverId) => ipcRenderer.invoke('catalog:remove', { serverId }),
  },

  /**
   * What runs each software, and whether this machine has it.
   *
   * `software` is a map of id -> { kind: 'java'|'php'|'none', label, eula, ... }
   * so a view can say "PHP 8.3" or "no JVM involved" without re-deriving it.
   */
  runtime: {
    overview: () => ipcRenderer.invoke('runtime:overview'),
    setPhpPath: (phpPath) => ipcRenderer.invoke('php:set-path', { phpPath }),
  },

  java: {
    /** the whole plan: installed runtimes plus what each server resolves to */
    plan: () => ipcRenderer.invoke('java:plan'),
    probe: (javaPath) => ipcRenderer.invoke('java:probe', { javaPath }),
    assign: (serverId, javaPath) => ipcRenderer.invoke('java:assign', { serverId, javaPath }),
    install: (major, opts) => ipcRenderer.invoke('java:install', { major, ...(opts || {}) }),
    removeRuntime: (major) => ipcRenderer.invoke('java:remove-runtime', { major }),
  },

  server: {
    start: (id) => ipcRenderer.invoke('server:start', { id }),
    stop: (id, force) => ipcRenderer.invoke('server:stop', { id, force: Boolean(force) }),
    send: (id, line) => ipcRenderer.invoke('server:send', { id, line }),
    history: (id) => ipcRenderer.invoke('server:history', { id }),
    /** the exact JVM command line, for the preview in Settings */
    dryRun: (id) => ipcRenderer.invoke('server:dry-run', { id }),

    backup: (id, opts) => ipcRenderer.invoke('server:backup', { id, ...(opts || {}) }),
    deleteBackup: (id, name) => ipcRenderer.invoke('server:delete-backup', { id, name }),
  },

  config: {
    write: (id, properties) => ipcRenderer.invoke('config:write', { id, properties: properties || {} }),
    setEula: (id, accepted) => ipcRenderer.invoke('config:set-eula', { id, accepted: Boolean(accepted) }),
    list: (id, which) => ipcRenderer.invoke('config:list', { id, which }),
    addPlayer: (id, which, name) => ipcRenderer.invoke('config:add-player', { id, which, name }),
    removePlayer: (id, which, value) => ipcRenderer.invoke('config:remove-player', { id, which, value }),
  },

  plugins: {
    /** a native file picker, then the jars are installed from it */
    pick: (id) => ipcRenderer.invoke('plugins:pick', { id }),
    remove: (id, fileName) => ipcRenderer.invoke('plugins:remove', { id, fileName }),
  },

  shell: {
    /** open one of a server's own folders: root, logs, world or plugins */
    openServerPath: (id, which) => ipcRenderer.invoke('shell:open-server-path', { id, which }),
    openExternal: (url) => ipcRenderer.invoke('shell:open-external', { url }),
    pickDirectory: () => ipcRenderer.invoke('dialog:pick-directory'),
    revealDataDir: () => ipcRenderer.invoke('paths:reveal'),
  },

  /**
   * Updating EnvServer, and going back to an older version.
   *
   * `install` runs the release installer and closes the app; it is a click on an
   * explicit button, never something the app does on its own.
   */
  updates: {
    report: (refresh) => ipcRenderer.invoke('update:report', { refresh: Boolean(refresh) }),
    install: (version) => ipcRenderer.invoke('update:install', { version }),
    openReleases: () => ipcRenderer.invoke('update:open-releases'),
  },

  onLog: on('evt:log'),
  onStatus: on('evt:status'),
  onExit: on('evt:exit'),
  onDownload: on('evt:download'),
  /**
   * A player list changed on disk.
   *
   * A ban typed in the server console rewrites `banned-players.json` behind the
   * app's back, and a UUID the app guessed offline gets corrected later. Both are
   * pushed so the Config view can repaint the rows instead of polling for them.
   */
  onPlayers: on('evt:players'),
  /** installer progress, so a 80 MB download in the update panel is not a spinner */
  onUpdateProgress: on('evt:update-progress'),
});