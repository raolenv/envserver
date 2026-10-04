import { h, mount, loader } from '../dom.js';
import { icon } from '../icons.js';
import { bytes, megabytesToText, duration, relative, plural } from '../fmt.js';
import { state, emit, openServer, setView, refreshDetail, statusFor } from '../state.js';
import { startServer, stopServer, acceptEula, suggestMemory } from '../actions.js';
import { installPaper, activeJobs } from '../jobs.js';
import { badge, iconBadge, javaBadge, createServerCard } from './dashboard.js';
import { softwareLabel } from '../software.js';
import { toast } from '../ui/toast.js';

/**
 * The server list: the page the app opens on.
 *
 * Every server is one full-width row stacked under the last, the way a panel
 * lists instances. The row as a whole opens that server; the controls on the
 * right act on it without navigating, so starting two servers in a row takes two
 * clicks and no page changes.
 *
 * Status comes from `state.statuses`, which is fed by the same `evt:status`
 * stream as the dashboard - so a server started from here shows as online here
 * without having to be selected first.
 */

/** State of one row: running, starting, or stopped. */
function rowState(id) {
  const st = statusFor(id);
  if (!st?.running) return { running: false, starting: false, ready: false, st: null };
  const ready = st.phase === 'running';
  return { running: true, starting: !ready, ready, st };
}

function statusPill(running, starting, ready) {
  const cls = ready ? '.statuspill--on' : starting ? '.statuspill--start' : '';
  const text = ready ? 'Online' : starting ? 'Starting' : 'Stopped';
  return h(`div.statuspill${cls}`, h('span.dot'), h('span', { text }));
}

/**
 * The action button on a row.
 *
 * Start stays disabled for the two things that genuinely cannot start - no jar,
 * no EULA - and each says which one it is rather than being a dead button.
 */
function rowAction(server, r) {
  if (r.running) {
    return h(
      'button.btn.btn--sm.btn--danger.srow__act',
      {
        type: 'button',
        title: 'Stop the server',
        onClick: (e) => {
          e.stopPropagation();
          stopServer(server.id);
        },
      },
      icon('stop'),
      r.ready ? 'Stop' : 'Stopping'
    );
  }

  const hasJar = Boolean(server.jarInstalled);
  const blocked = !hasJar;
  return h(
    'button.btn.btn--sm.btn--primary.srow__act',
    {
      type: 'button',
      disabled: blocked,
      title: !hasJar ? 'Install a version first' : 'Start the server',
      onClick: (e) => {
        e.stopPropagation();
        startServer(server.id);
      },
    },
    icon('play'),
    'Start'
  );
}

/** Badges that describe a server without needing its live status. */
function rowBadges(server, r) {
  const out = [];
  if (server.mcVersion) out.push(iconBadge('cube', `${softwareLabel(server.type)} ${server.mcVersion}`, 'info'));
  else out.push(badge('no version', 'warn'));

  if (server.build) out.push(badge(`build ${server.build}`));
  out.push(iconBadge('hardDrive', `port ${server.port}`));
  out.push(badge(megabytesToText(server.memory.max)));
  if (!server.jarInstalled) out.push(iconBadge('download', 'no jar', 'warn'));

  return h('div.srow__badges', ...out.filter(Boolean));
}

/** The right-hand figures: live when it runs, historical when it does not. */
function rowNumbers(server, r) {
  if (r.ready) {
    return h(
      'div.srow__nums',
      num('players', String(r.st.playerCount ?? 0), r.st.maxPlayers ? `/ ${r.st.maxPlayers}` : ''),
      num('uptime', duration(r.st.uptime || 0)),
      num('ram', megabytesToText(r.st.ramMb || 0))
    );
  }
  if (r.starting) {
    return h(
      'div.srow__nums',
      num('phase', r.st.phase || 'starting'),
      num('ram', megabytesToText((r.st.memory?.max) || server.memory.max), 'max')
    );
  }
  return h(
    'div.srow__nums',
    num('players', '-'),
    num('last seen', server.lastStartedAt ? relative(server.lastStartedAt) : 'never'),
    num('memory', megabytesToText(server.memory.max), 'max')
  );
}

function num(label, value, small) {
  return h(
    'div.srow__num',
    h('div.stat__label', { text: label }),
    h('div.stat__value', { text: value }, small ? h('small', { text: ` ${small}` }) : null)
  );
}

/* --------------------------------- row ---------------------------------- */

function serverRow(server) {
  const r = rowState(server.id);
  const jobs = activeJobs().filter((j) => j.serverId === server.id);

  const row = h(
    'div.srow',
    {
      role: 'button',
      tabindex: '0',
      'aria-label': `Open ${server.name}`,
      onClick: () => openServer(server.id),
      // Enter and Space: a div with role=button gets no keyboard handling for free
      onKeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openServer(server.id);
        }
      },
    },
    h(
      'div.srow__id',
      h(`span.srow__dot${r.ready ? '.srow__dot--on' : r.starting ? '.srow__dot--busy' : ''}`),
      h(
        'div.srow__names',
        h('div.srow__name', { text: server.name }),
        h('div.srow__folder', { text: server.id })
      )
    ),
    h('div.srow__mid', rowBadges(server, r), rowNumbers(server, r)),
    h('div.srow__right', statusPill(r.running, r.starting, r.ready), rowAction(server, r), icon('chevronRight', { class: 'srow__go' })),
    jobs.length ? jobStrip(jobs) : null
  );

  return row;
}

/** A download in flight for this server, drawn inside its own row. */
function jobStrip(jobs) {
  const job = jobs[0];
  const pct = job.total > 0 ? Math.min(100, (job.received / job.total) * 100) : job.percent;
  return h(
    'div.srow__job',
    h('div.progress', { style: { height: '8px' } }, h('div.progress__fill', { style: { width: `${pct}%` } })),
    h('span.srow__jobtext', { text: `${job.label} - ${job.phase}` })
  );
}

/* -------------------------------- header -------------------------------- */

function listHead() {
  const total = state.servers.length;
  const running = state.servers.filter((s) => rowState(s.id).running).length;

  return h(
    'div.srowhead',
    h('div.content__sub', {
      text: total
        ? `${plural(total, 'server', 'servers')} - ${running} online. Click one to manage it.`
        : 'Create one below and EnvServer installs Paper for you.',
    })
  );
}

/* -------------------------------- empty --------------------------------- */

function emptyState() {
  return h(
    'div.panel',
    h('div.panel__body',
      h('div.empty', icon('server'), h('b', { text: 'No servers yet' }), 'Every server lives in its own folder with its own world, plugins and logs.')
    )
  );
}

/* -------------------------------- render -------------------------------- */

export function renderHome(host) {
  if (!state.servers.length) {
    return mount(host, listHead(), h('div.section', createServerCard()));
  }

  return mount(
    host,
    listHead(),
    h(
      'div.slist',
      ...state.servers.map((s) => serverRow(s))
    ),
    state.homeCreating ? h('div.section', { style: { marginTop: '22px' } }, createServerCard()) : null,
    h(
      'div.field__hint',
      { style: { marginTop: '20px' } },
      'Each server is a separate folder. Removing one from this list never deletes its world.'
    )
  );
}

/** The head-bar buttons for this view. */
export function homeActions() {
  if (!state.servers.length) return [];
  return [
    h(
      'button.btn.btn--sm.btn--ghost',
      { type: 'button', onClick: () => { state.homeCreating = !state.homeCreating; emit('view'); } },
      icon('plus'),
      state.homeCreating ? 'Cancel' : 'New server'
    ),
  ];
}
