import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { bytes, relative } from '../fmt.js';
import { toast } from './toast.js';

/**
 * The updates panel, under the button next to the window controls.
 *
 * Two jobs, and the second one is the reason it exists:
 *
 *   1. say whether a newer EnvServer exists, and install it on request
 *   2. offer to go back to a version that used to run here
 *
 * "Go back" re-runs an older release's own installer from GitHub. There is no
 * in-place patching and no self-repair: rewriting `app.asar` under a running
 * Electron produces a program that only fails on the next launch. Re-running
 * the release installer is the same operation the user would do by hand, and it
 * is the one that is known to work.
 *
 * Servers and settings are never in the install folder - they live under
 * `%APPDATA%\envserver\data` - so switching version cannot take a world with it.
 * The panel shows that folder rather than just asserting it.
 */

/** @type {HTMLElement|null} */
let host = null;
let open = false;
let busy = null;
let report = null;
/** progress of the installer download currently in flight */
let progress = null;
let offProgress = null;

/* --------------------------------- state --------------------------------- */

/** True once we know there is something newer, so the titlebar shows a dot. */
export function hasUpdate() {
  return Boolean(report?.updateAvailable);
}

/** Ask GitHub once per session, without blocking anything that renders. */
export function checkForUpdates({ refresh = false } = {}) {
  if (busy) return Promise.resolve(report);
  busy = window.env.updates
    .report(refresh)
    .then((res) => {
      report = res && res.ok !== false ? res : null;
      if (open) paint();
      markTitlebar();
      return report;
    })
    .catch(() => {
      report = null;
      if (open) paint();
      return null;
    })
    .finally(() => {
      busy = null;
    });
  return busy;
}

function markTitlebar() {
  const btn = document.getElementById('btn-updates');
  if (!btn) return;
  const dot = btn.querySelector('.wc-btn__dot');
  if (dot) dot.hidden = !hasUpdate();
  btn.title = hasUpdate() ? `EnvServer ${report.latest.version} is available` : 'Updates and previous versions';
}

/* --------------------------------- paint --------------------------------- */

function versionRow(entry, { current }) {
  const local = entry.source === 'local';
  return h(
    'div.updates__row',
    h('span.updates__rowver', { text: `v${entry.version}` }),
    h(
      'span.updates__rowmeta',
      local
        ? 'ran on this machine'
        : entry.published
          ? `published ${relative(entry.published)}`
          : 'published on GitHub'
    ),
    local && !entry.asset
      ? h(
          'button.btn.btn--sm.btn--ghost',
          {
            type: 'button',
            title: 'Not published on GitHub any more, so it cannot be reinstalled from here',
            onClick: () => window.env.updates.openReleases(),
          },
          'Get it'
        )
      : h(
          'button.btn.btn--sm' + (current ? '' : '.btn--primary'),
          {
            type: 'button',
            disabled: Boolean(progress),
            onClick: () => install(entry.version, current ? 'Go back to' : 'Install'),
          },
          current ? 'Go back' : 'Install'
        )
  );
}

function hero() {
  if (progress) {
    const pct = progress.total ? Math.min(100, Math.round((progress.received / progress.total) * 100)) : 0;
    return h(
      'div.updates__hero',
      icon('download'),
      h(
        'div.updates__herotext',
        h('div.updates__herotitle', { text: `Downloading ${progress.label || 'the installer'}` }),
        h('div.updates__herosub', { text: progress.total ? `${bytes(progress.received)} of ${bytes(progress.total)} - ${pct}%` : bytes(progress.received) }),
        h('div.updates__bar', h('div.updates__barfill', { style: { width: `${progress.total ? pct : 8}%` } }))
      )
    );
  }

  if (!report) {
    return h(
      'div.updates__hero',
      icon('refresh'),
      h('div.updates__herotext', h('div.updates__herotitle', { text: 'Checking for updates...' }), h('div.updates__herosub', { text: 'asking github.com/raolenv/envserver' }))
    );
  }

  if (report.updateAvailable && report.latest) {
    return h(
      'div.updates__hero',
      icon('download'),
      h(
        'div.updates__herotext',
        h('div.updates__herotitle', { text: `EnvServer ${report.latest.version} is out` }),
        h('div.updates__herosub', { text: `you have ${report.current} - ${bytes(report.latest.asset?.size || 0)} download` })
      ),
      h(
        'button.btn.btn--sm.btn--primary',
        { type: 'button', onClick: () => install(report.latest.version, 'Update to') },
        'Update'
      )
    );
  }

  return h(
    'div.updates__hero',
    icon('check'),
    h(
      'div.updates__herotext',
      h('div.updates__herotitle', { text: report.online ? `EnvServer ${report.current} is the latest` : 'EnvServer is up to date' }),
      h('div.updates__herosub', {
        text: report.online ? 'nothing to install' : `could not reach github - showing what is known (${report.error || 'offline'})`,
      })
    ),
    h('button.btn.btn--sm.btn--ghost', { type: 'button', onClick: () => checkForUpdates({ refresh: true }) }, icon('refresh'), 'Recheck')
  );
}

function paint() {
  if (!host) return;
  if (!open) {
    host.hidden = true;
    mount(host);
    return;
  }
  host.hidden = false;

  const previous = report?.previous || [];

  mount(
    host,
    h(
      'div.updates__head',
      h('div.updates__title', icon('download'), 'Updates', report?.current ? h('span.updates__ver', { text: `v${report.current}` }) : null),
      h('button.btn.btn--sm.btn--icon.btn--ghost', { type: 'button', title: 'Close', onClick: () => toggle(false) }, icon('close'))
    ),
    h(
      'div.updates__body',
      hero(),

      previous.length
        ? h(
            'div',
            h('div.updates__section', { text: `Earlier versions${previous.length === 1 ? '' : 's'}` }),
            h(
              'div.updates__list',
              previous.map((entry) => versionRow(entry, { current: false }))
            )
          )
        : null,

      // the answer, in the place somebody would look for it
      h(
        'div.updates__note',
        icon('shield'),
        h(
          'div',
          h('b', 'Your servers and settings survive every update and every rollback.'),
          ' They live outside the application folder, in',
          report?.dataDir ? h('div.updates__path', { text: report.dataDir }) : null,
          h('div', { style: { marginTop: '5px' } }, 'Only the app itself is replaced.')
        )
      ),

      h(
        'div.row',
        h('button.btn.btn--sm.btn--ghost', { type: 'button', onClick: () => window.env.updates.openReleases() }, icon('external'), 'All releases'),
        h('button.btn.btn--sm.btn--ghost', { type: 'button', onClick: () => window.env.shell.revealDataDir() }, icon('folder'), 'Data folder')
      )
    )
  );
}

/* -------------------------------- actions -------------------------------- */

async function install(version, verb = 'Install') {
  if (progress) return;

  // A running server keeps writing into the data folder, which is fine - the
  // installer never touches it - but the app itself has to close, so say so
  // before the window disappears rather than after.
  progress = { received: 0, total: 0, label: `EnvServer ${version}` };
  paint();

  offProgress?.();
  offProgress = window.env.onUpdateProgress((p) => {
    if (!progress) return;
    progress = { ...progress, ...p };
    paint();
  });

  const res = await window.env.updates.install(version).catch((err) => ({ ok: false, error: err?.message || String(err) }));

  offProgress?.();
  offProgress = null;

  if (!res?.ok) {
    progress = null;
    paint();
    toast(res?.error || 'That version could not be installed', 'err');
    return;
  }

  // The main process exits on its own once the installer is running; until then
  // say what is happening, because the window is about to vanish.
  progress = { received: progress.total || 1, total: progress.total || 1, label: `EnvServer ${version}` };
  paint();
  toast(`${verb} ${version} - EnvServer will close and the installer will take over`, 'info');
}

function toggle(force) {
  open = force === undefined ? !open : Boolean(force);
  document.getElementById('btn-updates')?.classList.toggle('is-open', open);
  paint();
  if (open) {
    if (!report) checkForUpdates();
    else paint();
  }
}

/* --------------------------------- wiring -------------------------------- */

export function initUpdates() {
  host = document.getElementById('updates');
  if (!host) return;

  document.getElementById('btn-updates')?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggle();
  });

  // a click anywhere else closes it, but not a click inside it
  document.addEventListener('click', (e) => {
    if (!open) return;
    if (e.target.closest('#updates') || e.target.closest('#btn-updates')) return;
    toggle(false);
  });

  document.addEventListener('keydown', (e) => {
    if (open && e.key === 'Escape') toggle(false);
  });

  markTitlebar();
}

export { toggle as toggleUpdates };