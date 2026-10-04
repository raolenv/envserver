import { h, mount, loader } from './dom.js';
import { icon } from './icons.js';
import { toast } from './ui/toast.js';
import { welcomeBox, failureBox } from './ui/overlay.js';
import { initUpdates, checkForUpdates } from './ui/updates.js';
import {
  state,
  subscribe,
  init,
  emit,
  setView,
  goHome,
  openServer,
  activeServer,
  SERVER_VIEWS,
  statusFor,
  refreshDetail,
  refreshVersions,
  refreshServerVersions,
  refreshJvmPlan,
  refreshServers,
} from './state.js';
import { renderJobs, activeJobs } from './jobs.js';
import { renderDashboard, dashboardActions } from './views/dashboard.js';
import { renderHome, homeActions } from './views/home.js';
import { renderVersions, versionsActions } from './views/versions.js';
import { softwareLabel, softwareSupports } from './software.js';
import { renderConsole, consoleActions, appendLine } from './views/console.js';
import { renderConfig, configActions, leaveConfig } from './views/config.js';
import { renderPlugins, pluginsActions } from './views/plugins.js';
import { renderSettings, settingsActions } from './views/settings.js';
import { renderAbout, aboutActions } from './views/about.js';
import { initDemo, renderDemo, stopDemo, demoPlayers } from './demo.js';

/* ------------------------------- view table ------------------------------ */

const NAV = [
  { id: 'home', label: 'Servers', icon: 'server', eyebrow: 'Servers', title: 'Your servers', sub: 'Pick one to manage it, or add a new one.' },
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard', eyebrow: 'Run', title: 'Dashboard', sub: 'Start your servers and see who is online.', server: true },
  { id: 'console', label: 'Console', icon: 'terminal', eyebrow: 'Output', title: 'Console', sub: 'Live server output, and the commands you can send.', server: true },
  { id: 'config', label: 'Config', icon: 'sliders', eyebrow: 'Settings', title: 'Server config', sub: 'server.properties, the whitelist, ops and bans.', server: true },
  { id: 'versions', label: 'Versions', icon: 'layers', eyebrow: 'Library', title: 'Server versions', sub: 'Every Minecraft version this software publishes a build for.', server: true },
  { id: 'plugins', label: 'Plugins', icon: 'puzzle', eyebrow: 'Content', title: 'Plugins', sub: 'What is in the plugins folder right now.', server: true, needs: 'plugins' },
  { id: 'settings', label: 'Settings', icon: 'gear', eyebrow: 'App', title: 'Settings', sub: 'Memory, Java, folders and backups.' },
  { id: 'about', label: 'Terms', icon: 'shield', eyebrow: 'App', title: 'Terms', sub: 'The terms EnvServer is released under.' },
];

const RENDERERS = {
  home: renderHome,
  dashboard: renderDashboard,
  console: renderConsole,
  config: renderConfig,
  versions: renderVersions,
  plugins: renderPlugins,
  settings: renderSettings,
  about: renderAbout,
};

const ACTIONS = {
  home: homeActions,
  dashboard: dashboardActions,
  console: consoleActions,
  config: configActions,
  versions: versionsActions,
  plugins: pluginsActions,
  settings: settingsActions,
  about: aboutActions,
};

/** Teardown per view, run when another view takes over the body. */
const VIEW_LEAVE = {
  config: leaveConfig,
};

/* -------------------------------- sidebar ------------------------------- */

function renderSidebar() {
  const sidebar = document.getElementById('sidebar');
  const running = Boolean(state.status?.running);
  const busy = activeJobs().length;

  const inServer = SERVER_VIEWS.has(state.view) && Boolean(state.activeId);
  const record = activeServer();

  const nav = h(
    'div.sidebar__nav',
    NAV.filter((item) => (!item.server || inServer) && (!item.needs || softwareSupports(record?.type, item.needs))).map((item) => {
      const classes = [state.view === item.id ? 'is-active' : ''].filter(Boolean);

      let count = null;
      if (item.id === 'dashboard') {
        if (running) count = h('span.navitem__count.navitem__count--live', { text: String(state.status.playerCount ?? 0) });
        else if (busy) count = h('span.navitem__count.navitem__count--busy', { text: String(busy) });
      }

      return h(
        `button.navitem${classes.length ? `.${classes.join('.')}` : ''}`,
        { type: 'button', onClick: () => setView(item.id) },
        icon(item.icon),
        h('span', { text: item.label }),
        count
      );
    })
  );

  const picker = state.servers.length
    ? h(
        'div.serverpick',
        ...state.servers.map((s) => {
          const sStatus = statusFor(s.id);
          const sRunning = Boolean(sStatus?.running);
          const dot = sRunning
            ? '.serverpick__dot--on'
            : activeJobs().some((j) => j.serverId === s.id)
              ? '.serverpick__dot--busy'
              : '';
          return h(
            `button.serverpick__item${s.id === state.activeId ? '.is-active' : ''}`,
            {
              type: 'button',
              title: `${s.name}${s.mcVersion ? ` - ${softwareLabel(s.type)} ${s.mcVersion}` : ''}`,
              onClick: async () => {
                if (s.id === state.activeId) return;
                const { selectServer } = await import('./state.js');
                await selectServer(s.id);
              },
            },
            h(`span.serverpick__dot${dot}`),
            h('span.truncate.grow', { text: s.name })
          );
        })
      )
    : null;

  mount(sidebar, 
    h(
      'div.sidebar__brand',
      h('img', { src: 'assets/icon-48.png', alt: '' }),
      h(
        'div.sidebar__brand-text',
        h('div.sidebar__brand-name', { text: 'EnvServer' }),
        // from the store, not a literal. It was pinned at v1.0.0 through three releases,
        // so every screenshot of the sidebar - the one image every reader sees
        // first - claimed a version that no longer existed
        h('div.sidebar__brand-ver', { text: `v${state.appVersion || '?'}` })
      )
    ),
    inServer && record
      ? h(
          'button.serverpick__item.is-active',
          { type: 'button', style: { marginTop: '16px' }, onClick: goHome },
          h('span', { style: { display: 'inline-flex', transform: 'rotate(180deg)' } }, icon('chevronRight')),
          h('span.truncate.grow', { text: record.name })
        )
      : null,
    h('div.sidebar__section', { text: 'Menu' }),
    nav,
    h(
      'div.sidebar__foot',
      h('div.sidebar__section', { text: state.servers.length ? 'Your servers' : 'No servers yet' }),
      renderJobs(),
      picker,
      h(
        'button.serverpick__new',
        {
          type: 'button',
          onClick: () => {
            state.homeCreating = true;
            setView('home');
            emit('state');
          },
        },
        icon('plus'),
        h('span', { text: 'New server' })
      )
    )
  );
}

/* -------------------------------- content ------------------------------- */

function renderHead() {
  const meta = NAV.find((n) => n.id === state.view) || NAV[0];
  const head = document.getElementById('content-head');
  const actions = (ACTIONS[meta.id] || (() => []))();

  mount(head, 
    h(
      'div.content__titles',
      h('div.content__eyebrow', { text: meta.eyebrow }),
      h('h1.content__title', { text: meta.title }),
      h('div.content__sub', { text: meta.sub })
    ),
    actions.length ? h('div.content__head-actions', actions) : null
  );
}

/** Which view the body currently holds, so leaving one can clean up after itself. */
let paintedView = '';

/**
 * Bounce off a view the selected server cannot use.
 *
 * Switching from a Paper server to a vanilla one while the Plugins tab is open
 * would otherwise leave the app on a page its own nav bar no longer offers.
 * Returns true when it moved the app somewhere else, so callers can repaint the
 * head as well - it was drawn for the view we just left.
 */
function guardView() {
  // The terms are a condition of use, not a preference: until they are accepted
  // the app only shows that screen, and the terms themselves stay reachable
  // afterwards so nobody has to take the app's word for what they agreed to.
  if (!state.settings.termsAccepted && state.view !== 'about') {
    state.view = 'about';
    return true;
  }

  const blocked = NAV.find((item) => item.id === state.view && item.needs && !softwareSupports(activeServer()?.type, item.needs));
  if (!blocked) return false;

  state.view = 'dashboard';
  toast(`${softwareLabel(activeServer()?.type)} has no ${blocked.label.toLowerCase()} - showing the dashboard instead`, 'info');
  return true;
}

function renderBody() {
  const body = document.getElementById('content-body');

  if (guardView()) {
    VIEW_LEAVE[paintedView]?.();
    paintedView = state.view;
    renderHead();
  }

  // the config view keeps a timer alive for its realtime player lists; leaving it
  // has to stop that, or it repaints detached nodes every tick forever
  if (paintedView && paintedView !== state.view) VIEW_LEAVE[paintedView]?.();
  paintedView = state.view;

  body.classList.toggle('content__body--console', state.view === 'console');

  // A throw in one view must not take the app down: without this the rejection
  // bubbles into the boot promise and the fallback screen covers the window.
  try {
    (RENDERERS[state.view] || renderDashboard)(body);
  } catch (err) {
    console.error('[view] ' + state.view, err);
    mount(
      body,
      h(
        'div.panel',
        h('div.panel__head', h('div.panel__title', icon('alert'), `${state.view} failed to load`)),
        h(
          'div.panel__body',
          h('div.banner.banner--err', icon('alert'), String(err?.message || err)),
          h('div.row', h('button.btn', { type: 'button', onClick: () => renderBody() }, 'Try again'))
        )
      )
    );
  }
}

function renderAll() {
  renderSidebar();
  renderHead();
  renderBody();
}

/* ------------------------------- rendering ------------------------------ */

subscribe((reason) => {
  if (!state.ready) return;

  switch (reason) {
    case 'log':
      return; // appended in place, see below
    case 'status':
      // the only two things that move while a server runs
      renderSidebar();
      if (state.view === 'dashboard' || state.view === 'home') renderBody();
      return;
    case 'jobs':
      renderSidebar();
      if (state.view === 'versions' || state.view === 'dashboard') renderBody();
      return;
    case 'servers':
      renderSidebar();
      renderHead();
      if (state.view === 'dashboard' || state.view === 'settings') renderBody();
      return;
    case 'logs':
      if (state.view === 'console') renderBody();
      return;
    default:
      renderAll();
  }
});

/* ------------------------------ event bridge ---------------------------- */

/**
 * Live console lines, appended in place.
 *
 * `evt:log` fires many times a second on a busy server, so it must not go through
 * the normal render path: rebuilding the view would reset the scroll position and
 * destroy whatever the user was typing into the command box.
 */
window.env.onLog((entry) => {
  if (!entry || entry.serverId !== state.activeId) return;
  state.logs.push(entry);
  const max = state.settings.consoleLines || 2000;
  if (state.logs.length > max) state.logs.splice(0, state.logs.length - max);
  if (state.view === 'console') appendLine(entry);
});

window.env.onStatus((payload) => {
  if (!payload) return;
  const prev = state.statuses[payload.serverId] || null;
  state.statuses[payload.serverId] = payload.running ? payload : null;
  if (!state.statuses[payload.serverId]) delete state.statuses[payload.serverId];
  if (payload.serverId === state.activeId) state.status = payload.running ? payload : null;
  // The monitor fires this every few seconds with fresh uptime, which would
  // rebuild every row each time. Only re-render when something a person can
  // actually see moved - running/phase, player count, motd, jvm, reachability.
  const meaningful =
    !prev !== !payload.running ||
    (prev && prev.phase) !== (payload.running ? payload.phase : undefined) ||
    (prev?.playerCount ?? null) !== (payload.running ? payload.playerCount : null) ||
    (prev?.motd ?? null) !== (payload.running ? payload.motd : null) ||
    (prev?.ramMb ?? null) !== (payload.running ? payload.ramMb : null) ||
    (prev?.heapUsedMb ?? null) !== (payload.running ? payload.heapUsedMb : null) ||
    (prev?.reachable ?? null) !== (payload.running ? payload.reachable : null);
  if (meaningful) emit('status');
});

window.env.onExit((payload) => {
  if (!payload) return;
  delete state.statuses[payload.serverId];
  if (payload.serverId === state.activeId) {
    state.status = null;
    toast(
      payload.clean
        ? `Server stopped after ${Math.round(payload.uptime / 1000)}s`
        : `Server exited unexpectedly (${payload.signal ? `signal ${payload.signal}` : `code ${payload.code}`})`,
      payload.clean ? 'info' : 'err'
    );
    refreshDetail();
  }
  renderSidebar();
  if (state.view === 'home') renderBody();
});

/* -------------------------------- chrome -------------------------------- */

function wireTitlebar() {
  document.querySelectorAll('[data-wc]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.wc;
      if (action === 'minimize') window.env.window.minimize();
      else if (action === 'maximize') window.env.window.toggleMaximize();
      else if (action === 'fullscreen') window.env.window.toggleFullScreen();
      else window.env.window.close();
    });
  });

  // The main process owns the window state; the renderer only reflects it.
  window.__wcState = null;

  const applyState = (st) => {
    const maximized = Boolean(st && st.maximized);
    const fullScreen = Boolean(st && st.fullScreen);
    window.__wcState = { maximized, fullScreen };

    const maxBtn = document.querySelector('[data-wc="maximize"]');
    if (maxBtn) maxBtn.title = maximized ? 'Restore' : 'Maximize';

    const fsBtn = document.querySelector('[data-wc="fullscreen"]');
    if (fsBtn) {
      fsBtn.classList.toggle('is-active', fullScreen);
      fsBtn.title = fullScreen ? 'Leave full screen' : 'Full screen (F11)';
    }
  };

  window.env.window.onState(applyState);
  window.env.window.getState().then(applyState).catch(() => {});
  window.env.window.onHideToTray(() => toast('Still running in the tray', 'info'));

  document.getElementById('titlebar')?.addEventListener('dblclick', (e) => {
    if (e.target.closest('.titlebar__controls')) return;
    window.env.window.toggleMaximize();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'F5') {
      e.preventDefault();
      window.env.window.reload();
    }
    // F11 for real full screen: the main process owns it, because the renderer
    // cannot call setFullScreen and `location`-style tricks do not work here
    if (e.key === 'F11') {
      e.preventDefault();
      window.env.window.toggleFullScreen();
    }
  });
}

/* --------------------------------- boot --------------------------------- */

wireTitlebar();
initUpdates();

init()
  .then(async () => {
    renderAll();

    // set before the welcome screen: the shell is up behind it, and anything
    // watching for boot should not have to dismiss a modal to learn we started
    window.__envReady = true;

    if (!state.onboarded) {
      const choice = await welcomeBox();
      if (choice?.serverDir === 'pick') {
        const picked = await window.env.shell.pickDirectory();
        if (picked?.ok) await window.env.settings.write({ serversDir: picked.dir });
      }
      await window.env.settings.write({ onboarded: true });
      state.onboarded = true;
    }

    renderAll();

    // after the first paint: both touch the network or spawn processes, and
    // neither is needed to draw the window
    refreshVersions(false);
    // the Versions view follows the selected server's software, and shares the
    // same cached lists, so this is normally already warm
    refreshServerVersions(state.servers.find((s) => s.id === state.activeId)?.type || 'paper');
    // one quiet check so the dot next to the window buttons is already correct
    // by the time anybody looks for it; the panel reuses the same result
    checkForUpdates().catch(() => {});
    refreshJvmPlan({ silent: true }).then(() => {
      if (state.jvm.missing.length && state.servers.length) {
        toast(`Java ${state.jvm.missing.join(' and ')} will be downloaded when a server needs it`, 'info');
      }
    });
  })
  .catch(async (err) => {
    console.error(err);
    window.__envReady = true;
    window.__envError = err.message;

    const how = await failureBox(err.message);
    if (how === 'retry') window.env.window.reload();
  });

/** A hand-edited settings file, or a server deleted on disk, should show up. */
window.addEventListener('focus', () => {
  if (!state.ready) return;
  refreshServers();
  refreshDetail();
});

export { loader };