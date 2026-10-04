import { h, mount, loader } from '../dom.js';
import { icon } from '../icons.js';
import { bytes, dateTime } from '../fmt.js';
import { state, activeServer, visibleVersions, refreshServerVersions, loadBuilds, setView, emit } from '../state.js';
import { installSoftware, jobForVersion, activeJobs, jarJobForServer } from '../jobs.js';
import { softwareById, softwareLabel } from '../software.js';
import { badge, iconBadge } from './dashboard.js';
import { toast } from '../ui/toast.js';

/**
 * The version catalogue for whatever the selected server runs.
 *
 * The list is fetched from whichever API that software publishes - fill.papermc.io
 * for Paper and Folia, api.purpurmc.org for Purpur, Mojang's manifest for Vanilla -
 * and it is cached on disk, so this works with no connection after the first
 * fetch. Installing is a background job: the row grows a progress bar and you can
 * go and do something else.
 */

let browseVersion = '';
/** which catalogue the view last asked for, so a re-render does not re-fetch */
let requestedKey = '';

function jobBar(mcVersion) {
  const job = jobForVersion(mcVersion);
  if (!job) return null;

  const pct = job.total > 0 ? Math.min(100, (job.received / job.total) * 100) : job.percent;
  return h(
    'div.vcard__job',
    h(
      'div.progress',
      { style: { height: '10px' } },
      h('div.progress__fill', { style: { width: `${pct}%` } })
    ),
    h(
      'div.row',
      { style: { marginTop: '7px', gap: '7px' } },
      loader('sm'),
      h('span', { style: { fontSize: '12.5px', color: 'var(--grey-3)' }, text: job.phase }),
      h('span.grow'),
      job.total > 0 ? h('span.faint', { style: { fontSize: '12px' }, text: `${bytes(job.received)} / ${bytes(job.total)}` }) : null
    )
  );
}

function versionRow(mcVersion, record) {
  const installedHere = state.servers.some((s) => s.mcVersion === mcVersion && s.jarInstalled);
  const isCurrent = record?.mcVersion === mcVersion;
  const open = browseVersion === mcVersion;
  const job = jobForVersion(mcVersion);
  const sw = softwareById(record?.type || 'paper');
  const label = sw.label.replace(/\s*\(.*\)$/, '');

  return h(
    `div.vcard${isCurrent ? '.is-installed' : ''}`,
    h('div.vcard__meta',
      h('div.vcard__name', { text: mcVersion }),
      h('div.vcard__sub', {
        text: isCurrent
          ? `the version on "${record.name}"`
          : installedHere
            ? 'installed on another server'
            : 'available to install',
      })),
    h(
      'div.vcard__right',
      installedHere && !isCurrent ? iconBadge('check', 'in use', 'ok') : null,
      isCurrent && record.jarInstalled ? iconBadge('check', 'installed', 'ok') : null,
      h(
        'button.btn.btn--sm.btn--ghost',
        {
          type: 'button',
          disabled: state.versions.loading,
          onClick: async () => {
            browseVersion = open ? '' : mcVersion;
            if (browseVersion) await loadBuilds(browseVersion);
            // already on the versions view: setView would no-op, so the open/close
            // has to repaint through the normal emit path
            emit('builds');
          },
        },
        icon('chevronRight'),
        open ? 'Hide builds' : 'Builds'
      ),
      record
        ? h(
            'button.btn.btn--sm.btn--primary',
            {
              type: 'button',
              disabled: Boolean(job) || !sw.auto,
              title: job ? 'already downloading' : !sw.auto ? `${label} is not downloaded for you - drop your own jar in` : `install into "${record.name}"`,
              onClick: () => installSoftware({ serverId: record.id, serverName: record.name, mcVersion, software: sw.id }),
            },
            icon('download'),
            job ? 'Downloading' : 'Install'
          )
        : null
    ),
    open ? buildsPanel(mcVersion, record) : null,
    jobBar(mcVersion)
  );
}

/* --------------------------------- builds ------------------------------- */

function buildsPanel(mcVersion, record) {
  const builds = state.builds;
  const meta = builds.meta;
  const sw = softwareById(record?.type || 'paper');
  const label = sw.label.replace(/\s*\(.*\)$/, '');

  return h(
    'div.vcard__builds',
    h(
      'div.panel',
      h(
        'div.panel__head',
        h('div.panel__title', icon('package'), `Builds for ${mcVersion}`),
        h(
          'div.row',
          meta?.javaMajor ? badge(`needs Java ${meta.javaMajor}`, 'info') : null,
          meta?.supportStatus === 'SUPPORTED' ? badge('supported', 'ok') : meta?.supportStatus === 'UNSUPPORTED' ? badge('unsupported', 'warn') : null,
          h('button.btn.btn--sm.btn--ghost', { type: 'button', disabled: builds.loading, onClick: () => loadBuilds(mcVersion, true) }, icon('refresh'), 'Refresh')
        )
      ),
      h(
        'div.panel__body',
        builds.loading ? h('div.empty', loader('lg'), 'Loading builds...') : null,
        builds.error ? h('div.banner.banner--err', icon('alert'), builds.error) : null,
        !builds.loading && !builds.error && !builds.list.length
          ? h('div.empty', h('b', { text: 'No downloadable builds' }), `${label} publishes exactly one server jar for this version, so there is nothing to choose from.`)
          : null,
        !builds.loading && builds.list.length
          ? h(
              'div.tablewrap',
              h('table.vtable',
              h('thead', h('tr', h('th', { text: 'Build' }), h('th', { text: 'Channel' }), h('th', { text: 'Published' }), h('th', { text: 'Size' }), h('th', { text: '' }))),
              h(
                'tbody',
                // the newest 25; 1.16.5 has 428 of them
                ...builds.list.slice(0, 25).map((b) =>
                  h(
                    'tr',
                    h('td', { text: `#${b.build}` }),
                    h('td', b.channel === 'STABLE' ? badge('stable', 'ok') : badge(b.channel.toLowerCase())),
                    h('td.num', { text: dateTime(b.time) }),
                    h('td.num', { text: bytes(b.size) }),
                    h(
                      'td',
                      h(
                        'button.btn.btn--sm',
                        { type: 'button', disabled: !record || !sw.auto, onClick: () => installSoftware({ serverId: record.id, serverName: record.name, mcVersion, build: b.build, software: sw.id }) },
                        'Install this'
                      )
                    )
                  )
                )
              )
              )
            )
          : null,
        meta?.recommendedFlags?.length
          ? h(
              'div',
              h('div.field__label', { style: { marginTop: '16px' }, text: `${label}'s recommended JVM flags` }),
              h('div.argline', { style: { marginTop: '7px' } }, ...meta.recommendedFlags.map((f) => h('span.argchip', { text: f })))
            )
          : null
      )
    )
  );
}

/* ------------------------------ installed jar --------------------------- */

function installedPanel() {
  const record = activeServer();
  if (!record) return null;

  const detail = state.detail;
  const job = jarJobForServer(record.id);
  const label = softwareLabel(record.type).replace(/\s*\(.*\)$/, '');

  if (!detail?.jar?.installed) {
    if (job) return h('div.banner.banner--ok', loader('sm'), `Downloading ${label} ${job.mcVersion} into "${record.name}" - you can keep using the app.`);
    return h('div.banner', icon('download'), h('span', h('b', { text: `"${record.name}" has no jar yet.` }), ' Pick a version below and hit Install.'));
  }

  return h(
    'div.panel',
    h('div.panel__head', h('div.panel__title', icon('package'), `Installed on "${record.name}"`)),
    h(
      'div.panel__body',
      h(
        'div.row.row--wrap',
        badge(`${label} ${record.mcVersion}`, 'info'),
        record.build ? badge(`build ${record.build}`) : null,
        badge(bytes(detail.jar.size)),
        detail.java.resolved
          ? badge(`Java ${detail.java.resolved.major}`, detail.java.resolved.match === 'exact' ? 'ok' : 'warn')
          : badge('Java will download on start', 'warn'),
        h('span.grow'),
        h(
          'button.btn.btn--sm.btn--danger',
          {
            type: 'button',
            disabled: Boolean(state.status?.running),
            title: state.status?.running ? 'Stop the server first' : 'The world and plugins are kept',
            onClick: async () => {
              const res = await window.env.paper.removeJar(record.id);
              if (!res?.ok) return toast(res?.error || 'could not remove the jar', 'err');
              toast(`${label} ${record.mcVersion} removed from ${record.name}`, 'info');
            },
          },
          icon('trash'),
          'Remove jar'
        )
      ),
      h('div.field__hint', { style: { marginTop: '10px' }, text: 'Installing a different version replaces the jar in place. The world is kept.' })
    )
  );
}

/* --------------------------------- render ------------------------------- */

export function renderVersions(host) {
  const record = activeServer();
  const sw = softwareById(record?.type || 'paper');
  const label = sw.label.replace(/\s*\(.*\)$/, '');

  // the catalogue follows the selected server's software, but only refetched when
  // that software actually changes - `refreshServerVersions` no-ops on a cache hit
  if (requestedKey !== sw.source) {
    requestedKey = sw.source;
    refreshServerVersions(record?.type || 'paper');
  }

  const search = h('input.input', {
    placeholder: 'Filter versions, for example 1.21',
    value: state.versionQuery,
    onInput: (e) => {
      // straight into state, read on the next render: typing must never re-render
      // the input the caret is in
      state.versionQuery = e.target.value;
      renderList();
    },
  });

  const listBox = h('div.grid');

  const renderList = () => {
    const filtered = visibleVersions();
    if (!filtered.length) {
      return mount(
        listBox,
        h(
          'div.panel',
          h(
            'div.panel__body',
            h(
              'div.empty',
              state.serverVersions.loading ? loader('lg') : icon('search'),
              h('b', { text: state.serverVersions.loading ? 'Loading versions' : 'Nothing matches' }),
              state.serverVersions.loading ? `Fetching the list for ${label}.` : state.serverVersions.error || 'Try a shorter filter.'
            )
          )
        )
      );
    }
    return mount(listBox, ...filtered.slice(0, 140).map((v) => versionRow(v, record)));
  };

  renderList();

  const toolbar = h(
    'div.filters',
    search,
    h(
      'button.btn.btn--sm',
      { type: 'button', disabled: state.serverVersions.loading, onClick: async () => {
        const ok = await refreshServerVersions(record?.type || 'paper', true);
        toast(ok ? 'Version list refreshed' : 'Could not refresh the list', ok ? 'ok' : 'err');
      } },
      icon('refresh'),
      'Refresh'
    ),
    badge(`${label} versions`, 'info'),
    h('span.faint', { style: { fontSize: '13px' }, text: `${state.serverVersions.list.length} available` }),
    state.serverVersions.source === 'stale-cache' ? badge('offline copy', 'warn') : null,
    h('span.grow'),
    record
      ? h('span.faint', { style: { fontSize: '13px' }, text: `installing into "${record.name}"` })
      : badge('no server selected', 'warn')
  );

  return mount(
    host,
    installedPanel(),
    toolbar,
    listBox,
    sw.auto
      ? h(
          'div.field__hint',
          { style: { marginTop: '18px' } },
          `${label} builds come straight from `,
          h('a', { onClick: (e) => { e.preventDefault(); window.env.shell.openExternal(sw.home || 'https://papermc.io/downloads'); } }, sw.home || 'papermc.io'),
          '.'
        )
      : h(
          'div.banner.banner--warn',
          { style: { marginTop: '18px' } },
          icon('alert'),
          `${sw.label} publishes no public download API. Put your own jar in the server folder - `,
          h('a', { onClick: (e) => { e.preventDefault(); if (record?.id) window.env.servers.openFolder(record.id); } }, 'open the folder'),
          '.'
        )
  );
}

/** The head-bar buttons for this view. */
export function versionsActions() {
  const record = activeServer();
  return record ? [h('button.btn.btn--sm.btn--ghost', { type: 'button', onClick: () => setView('dashboard') }, icon('dashboard'), 'Dashboard')] : [];
}