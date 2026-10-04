import { h, mount, loader } from '../dom.js';
import { icon } from '../icons.js';
import { bytes, megabytesToText, duration, relative, dateTime, plural } from '../fmt.js';
import { state, activeServer, setView, refreshDetail, refreshServers, refreshVersions, emit } from '../state.js';
import { startServer, stopServer, acceptEula, installVersion, backupNow, suggestMemory, memoryReading, memoryBudget } from '../actions.js';
import { installSoftware, activeJobs } from '../jobs.js';
import { SOFTWARE, softwareById, softwareLabel, softwareSupports } from '../software.js';
import { toast } from '../ui/toast.js';

/** A status pill. */
export function badge(text, kind = '') {
  return h(`span.badge${kind ? `.badge--${kind}` : ''}`, { text });
}

export function iconBadge(iconName, text, kind = '') {
  return h(`span.badge${kind ? `.badge--${kind}` : ''}`, icon(iconName), h('span', { text }));
}

/** How a resolved JVM should be labelled. */
export function javaBadge(match) {
  if (match === 'exact') return iconBadge('check', 'exact java', 'ok');
  if (match === 'newer') return iconBadge('zap', 'newer java', 'warn');
  if (match === 'older') return iconBadge('alert', 'java too old', 'err');
  return iconBadge('alert', 'no java', 'err');
}

function stat(label, value, small, opts = {}) {
  return h(
    'div',
    { title: opts.title || '', style: opts.tone ? { color: `var(--${opts.tone})` } : null },
    h('div.stat__label', { text: label }),
    h('div.stat__value', { text: value }, small ? h('small', { text: ` ${small}` }) : null)
  );
}

/* ------------------------------ create form ----------------------------- */

/**
 * The "create a server" card.
 *
 * Three choices and a button: what to call it, what software it runs, which
 * Minecraft version. Memory is *not* a choice here - it is worked out from the
 * machine and stays adjustable per server in Settings, because a slider in a
 * form people open once and never come back to is just one more thing to get
 * wrong.
 *
 * The version list follows the software: Paper and Folia come from fill.papermc.io,
 * Purpur from its own API, Vanilla from Mojang's manifest. Software with no public
 * download API still lists the right Minecraft versions, because the version is
 * what decides the Java runtime - only the jar is left to the user.
 */
function createServerCardImpl() {
  const sw = softwareById(state.createType);
  const memory = suggestMemory(state.settings.totalMemoryMb);
  const versions = state.versions.list.slice();

  const nameInput = h('input.input', { placeholder: 'ENV#1', value: 'ENV#1', maxlength: 40, spellcheck: false });

  const versionSelect = h(
    'select.select',
    versions.length
      ? versions.map((v) => h('option', { value: v, text: v }))
      : [h('option', { value: '', text: state.versions.loading ? 'Loading versions...' : 'No versions loaded yet' })]
  );

  const softwareNote = h('div.field__hint', { text: sw.note });

  const typeSelect = h(
    'select.select',
    {
      onChange: (e) => {
        state.createType = e.target.value;
        refreshVersions(false);
      },
    },
    ...SOFTWARE.map((s) => h('option', { value: s.id, text: s.label, selected: s.id === sw.id }))
  );

  const submitText = sw.auto ? `Create and install ${sw.label.replace(/\s*\(.*\)$/, '')}` : 'Create server folder';

  const create = async () => {
    const name = nameInput.value.trim() || 'ENV#1';
    const mcVersion = versionSelect.value;
    if (!mcVersion) {
      toast('Wait for the version list, or refresh it first', 'err');
      return;
    }

    const { createServer } = await import('../state.js');
    const created = await createServer({ name, mcVersion, memory: { min: memory.min, max: memory.max }, type: sw.id });
    if (!created) return;

    state.homeCreating = false;
    refreshServers();

    if (!sw.auto) {
      // Spigot, CraftBukkit and custom jars cannot be fetched: open the folder
      // so the jar can be dropped straight in, and say so instead of failing later
      window.env.servers.openFolder(created.id);
      toast(`${name} created. Put your ${sw.label} jar in the folder that just opened.`, 'info');
      if (sw.home) window.env.shell.openExternal(sw.home);
      return;
    }

    toast(`${name} created - downloading ${sw.label} ${mcVersion}`, 'ok');
    // the install is a background job: no modal, and the user can go look at
    // something else while the 50 MB downloads
    installSoftware({ serverId: created.id, serverName: name, mcVersion, software: sw.id });
  };

  return h(
    'div.panel',
    h(
      'div.panel__head',
      h('div.panel__title', icon('plus'), 'Create a server'),
      state.servers.length
        ? h(
            'span.grow',
            h(
              'button.btn.btn--sm.btn--ghost',
              {
                type: 'button',
                title: 'Close this form',
                onClick: () => {
                  state.homeCreating = false;
                  emit('view');
                },
              },
              icon('close'),
              'Close'
            )
          )
        : null
    ),
    h(
      'div.panel__body',
      h(
        'div.grid.grid--2',
        h('div.field', h('div.field__label', { text: 'Name' }), nameInput),
        h('div.field', h('div.field__label', { text: 'Server software' }), typeSelect, softwareNote),
        h('div.field', h('div.field__label', { text: 'Minecraft version' }), versionSelect,
          h('div.field__hint', { text: versions.length ? `${versions.length} versions available for ${sw.label}` : 'No version list loaded yet.' })),
        h(
          'div.field',
          h('div.field__label', { text: 'Memory' }),
          h('div.row', h('strong', { style: { fontSize: '14px' }, text: `${megabytesToText(memory.min)} - ${megabytesToText(memory.max)}` })),
          h('div.field__hint', {
            text: `Set automatically from this machine's ${megabytesToText(state.settings.totalMemoryMb)}. Change it per server in Settings.`,
          })
        ),
        h(
          'div.field',
          { style: { alignSelf: 'end' } },
          h(
            'button.btn.btn--primary.btn--block',
            { type: 'button', onClick: create, disabled: !versions.length || state.versions.loading },
            submitText
          )
        )
      ),
      state.versions.error
        ? h('div.banner.banner--warn', icon('alert'), `${state.versions.error}. You can create a server anyway once it loads.`)
        : null
    )
  );
}

/* --------------------------------- hero --------------------------------- */

function hero(record, detail, status) {
  const running = Boolean(status?.running);
  const ready = running && status.phase === 'running';
  const starting = running && !ready;
  const hasJar = detail.jar.installed;
  const eulaOk = detail.eula;

  const badges = [
    detail.server.mcVersion ? iconBadge('cube', `${softwareLabel(detail.server.type)} ${detail.server.mcVersion}`, 'info') : badge('no version yet', 'warn'),
    detail.server.build ? badge(`build ${detail.server.build}`) : null,
    detail.java.requiredMajor ? javaBadge(detail.java.resolved?.match) : null,
    detail.java.requiredMajor ? badge(`Java ${detail.java.resolved?.major || detail.java.requiredMajor}`) : null,
    iconBadge('hardDrive', `port ${detail.port}`),
    detail.onlineMode ? iconBadge('shield', 'online mode') : iconBadge('alert', 'offline mode', 'warn'),
    eulaOk ? null : iconBadge('alert', 'EULA pending', 'err'),
    detail.java.supportStatus === 'SUPPORTED' ? iconBadge('check', 'still supported', 'ok') : null,
    detail.java.supportStatus === 'UNSUPPORTED' ? iconBadge('info', 'no longer supported', 'warn') : null,
  ].filter(Boolean);

  const statusClass = ready ? '.statuspill--on' : starting ? '.statuspill--start' : '';
  const statusText = ready ? 'Online' : starting ? status.phase : 'Stopped';

  // the honest memory number: heap used against the heap ceiling, with the
  // process total kept separate rather than dressed up as the ceiling
  const mem = memoryReading({
    running,
    xmx: record.memory?.max,
    ramMb: status?.ramMb,
    heapUsedMb: status?.heapUsedMb,
    heapMaxMb: status?.heapMaxMb,
  });

  const actions = [];
  if (running) {
    actions.push(h('button.btn.btn--lg.runbtn.runbtn--stop', { type: 'button', onClick: () => stopServer(record.id) }, icon('stop'), 'Stop the server'));
    actions.push(h('button.btn.btn--ghost', { type: 'button', onClick: () => setView('console') }, icon('terminal'), 'Console'));
    if (!ready) {
      actions.push(
        h('button.btn.btn--danger', { type: 'button', title: 'Kill the JVM without saving', onClick: () => stopServer(record.id, { force: true }) }, 'Force stop')
      );
    }
  } else {
    const blocked = !hasJar || !eulaOk;
    actions.push(
      h(
        `button.btn.btn--lg.btn--primary.runbtn`,
        {
          type: 'button',
          disabled: blocked,
          title: !hasJar ? `Install a ${softwareLabel(record.type)} jar first` : !eulaOk ? 'Accept the EULA first' : '',
          onClick: () => startServer(record.id),
        },
        icon('play'),
        'Start the server'
      )
    );
    if (!eulaOk) actions.push(h('button.btn.btn--light', { type: 'button', onClick: () => acceptEula(record.id) }, icon('shield'), 'Accept the EULA'));
    if (!hasJar) actions.push(h('button.btn.btn--light', { type: 'button', onClick: () => setView('versions') }, icon('download'), `Install ${softwareLabel(record.type)}`));
  }

  return h(
    `div.hero${running ? '.hero--up' : ''}`,
    h(
      'div.hero__top',
      h('img.hero__cube', { src: 'assets/icon-64.png', alt: '' }),
      h('div.hero__meta', h('div.hero__name', { text: record.name }), h('div.hero__badges', ...badges)),
      h(`div.statuspill${statusClass}`, h('span.dot'), h('span', { text: statusText }))
    ),
    h(
      'div.hero__stats',
      stat('players', ready ? String(status?.playerCount ?? 0) : '-', status?.maxPlayers ? `/ ${status.maxPlayers}` : ''),
      stat('uptime', running ? duration(status?.uptime) : 'stopped'),
      stat('memory', mem.value, mem.small, { title: mem.title, tone: mem.tone }),
      stat('world', bytes(detail.disk.world || 0)),
      stat('disk', bytes(detail.disk.total || 0))
    ),
    h('div.hero__bar', ...actions)
  );
}

/* ------------------------------- quick card ----------------------------- */

function quickCard(record, detail, status) {
  const java = detail.java;

  return h(
    'div.panel',
    h('div.panel__head', h('div.panel__title', icon('info'), 'At a glance')),
    h(
      'div.quick__body',
      h('div', h('div.stat__label', { text: 'MOTD shown to players' }), h('div.motd', { text: detail.properties.values.motd || '(empty)' })),

      h(
        'div',
        h('div.kv', h('span.kv__k', { text: 'Java runtime' }), java.resolved ? javaBadge(java.resolved.match) : iconBadge('download', 'will be downloaded', 'warn')),
        java.resolved
          ? h('div', { style: { fontFamily: 'var(--mono)', fontSize: '11px', color: 'var(--grey-5)', wordBreak: 'break-all', marginTop: '3px' }, text: java.resolved.javaExe })
          : h('div.field__hint', { text: java.explain || `This release needs Java ${java.requiredMajor}.` })
      ),

      h(
        'div',
        // a vanilla server has no plugin loader, so counting jars in plugins/
        // would be a number that can never change and means nothing
        softwareSupports(record.type, 'plugins')
          ? h('div.kv', h('span.kv__k', { text: 'Plugins' }), h('span.kv__v', { text: String(detail.plugins.length) }))
          : h('div.kv', h('span.kv__k', { text: 'Plugins' }), h('span.kv__v.faint', { text: 'not supported' })),
        h('div.kv', h('span.kv__k', { text: 'Backups' }), h('span.kv__v', { text: String(detail.backups.length) })),
        h('div.kv', h('span.kv__k', { text: 'Last started' }), h('span.kv__v', { text: record.lastStartedAt ? relative(record.lastStartedAt) : 'never' }))
      ),

      h(
        'div.row.row--wrap',
        h('button.btn.btn--sm', { type: 'button', onClick: () => backupNow(record.id) }, icon('save'), 'Back up world'),
        h('button.btn.btn--sm', { type: 'button', onClick: () => window.env.servers.openFolder(record.id) }, icon('folder'), 'Open folder')
      )
    )
  );
}

/* ------------------------------ players list ---------------------------- */

function playersPanel(status) {
  const players = status?.players || [];
  return h(
    'div.section',
    h('div.section__head', h('div.section__title', icon('users'), 'Online now'), h('div.section__line')),
    players.length
      ? h(
          'div.playerlist',
          ...players.map((p) =>
            h('div.playerrow', h('span.truncate', { text: p.name }), h('span.playerrow__since', { text: duration(Date.now() - (p.since || Date.now())) }))
          )
        )
      : h('div.panel', h('div.panel__body', h('div.empty', icon('users'), h('b', { text: 'Nobody online' }), 'Names appear here the moment somebody joins.')))
  );
}

/* -------------------------------- backups ------------------------------- */

function backupsPanel(detail) {
  const list = detail.backups;
  return h(
    'div.section',
    h(
      'div.section__head',
      h('div.section__title', icon('save'), 'World backups'),
      h('div.section__line'),
      h('button.btn.btn--sm', { type: 'button', onClick: () => backupNow(detail.server.id) }, icon('plus'), 'New backup')
    ),
    list.length
      ? h(
          'table.vtable',
          h('thead', h('tr', h('th', { text: 'Archive' }), h('th', { text: 'Size' }), h('th', { text: 'Taken' }), h('th', { text: '' }))),
          h(
            'tbody',
            ...list.map((b) =>
              h(
                'tr',
                h('td', h('span.truncate', { title: b.name, text: b.name })),
                h('td.num', { text: bytes(b.size) }),
                h('td.num', { text: dateTime(b.modified) }),
                h(
                  'td',
                  h(
                    'button.btn.btn--sm.btn--ghost',
                    {
                      type: 'button',
                      onClick: async () => {
                        const res = await window.env.server.deleteBackup(detail.server.id, b.name);
                        if (!res?.ok) return toast(res?.error || 'could not delete that backup', 'err');
                        await refreshDetail();
                      },
                    },
                    icon('trash'),
                    'Delete'
                  )
                )
              )
            )
          )
        )
      : h(
          'div.panel',
          h(
            'div.panel__body',
            h('div.empty', icon('save'), h('b', { text: 'No backups yet' }), 'A backup zips the whole world folder. Take one before a big edit.'),
            state.settings.autoBackupHours
              ? h('div.field__hint', { style: { textAlign: 'center' }, text: `Automatic backups run every ${plural(state.settings.autoBackupHours, 'hour')} while a server is up.` })
              : null
          )
        )
  );
}

/* ------------------------------ not ready ------------------------------- */

function notReady(detail) {
  const items = [];
  if (!detail.jar.installed) items.push('No Paper jar is installed yet.');
  if (!detail.eula) items.push('The Minecraft EULA has not been accepted.');
  if (detail.java.requiredMajor && !detail.java.resolved) {
    // this is not a blocker: the runtime is downloaded automatically on start
    items.push(`Java ${detail.java.requiredMajor} is not installed - EnvServer will download it when you start the server.`);
  }
  if (!items.length) return null;

  return h('div.banner.banner--warn', icon('info'), h('div', h('b', { text: 'Before this server can start' }), h('ul', ...items.map((t) => h('li', { text: t })))));
}

/* --------------------------------- render ------------------------------- */

export function renderDashboard(host) {
  const record = activeServer();

  if (!record) {
    return mount(
      host,
      h('div.section', createServerCard()),
      h(
        'div.section',
        h('div.section__head', h('div.section__title', icon('layers'), 'What EnvServer does'), h('div.section__line')),
        h(
          'div.grid.grid--2',
          feature('download', 'Installs Paper', 'Every build papermc.io publishes, per Minecraft version.'),
          feature('cpu', 'Sorts out Java', 'Finds the right runtime, or downloads Eclipse Temurin.'),
          feature('terminal', 'Live console', 'Real output plus a command box while it runs.'),
          feature('shield', 'Backups', 'Zip the world on demand or on a timer.')
        )
      )
    );
  }

  const detail = state.detail;
  if (!detail || detail.server.id !== record.id) {
    return mount(host, h('div.empty', loader('lg'), 'Loading your servers...'));
  }

  const status = state.status?.serverId === record.id ? state.status : null;

  return mount(
    host,
    notReady(detail),
    memoryBudgetBanner(record),
    h('div.dash', hero(record, detail, status), quickCard(record, detail, status)),
    playersPanel(status),
    backupsPanel(detail)
  );
}

function feature(iconName, title, body) {
  return h(
    'div.panel',
    h('div.panel__body', h('div.row.row--top', { style: { gap: '13px' } }, h('span', { style: { color: 'var(--green-2)' } }, icon(iconName, { size: 24 })), h('div', h('b', { style: { fontSize: '15px' } }, title), h('div.faint', { style: { fontSize: '13px', marginTop: '3px' }, text: body }))))
  );
}

/**
 * Say so when the heap ceiling is more than this machine can honour.
 *
 * EnvServer picks a sensible number when it creates a server - about half the
 * installed RAM - so this only fires on a setting somebody changed by hand. It
 * matters because the failure mode is bad: Windows does not refuse to start a
 * 32 GB heap on an 8 GB machine, it starts it and then thrashes the pagefile
 * until something, usually the server, gets killed.
 */
function memoryBudgetBanner(record) {
  const total = state.settings.totalMemoryMb || 0;
  const budget = memoryBudget(record, total);
  if (!budget.overBudget && !budget.tight) return null;

  const suggested = suggestMemory(total);
  return h(
    'div',
    { style: { marginBottom: '14px' } },
    h(
      `div.banner.${budget.overBudget ? 'banner--err' : 'banner--warn'}`,
      icon('alert'),
      h(
        'span',
        budget.overBudget
          ? h('b', `This server wants ${megabytesToText(record.memory.max)} on a machine with ${megabytesToText(total)}.`)
          : h('b', `${megabytesToText(record.memory.max)} leaves ${megabytesToText(Math.max(0, budget.headroomMb))} for Windows.`),
        budget.overBudget
          ? ' That is more than this machine has. The server will not fail on startup - it will crawl, and the pagefile will take over.'
          : ' Windows needs about 2 GB to stay responsive.',
        ' ',
        h(
          'button.btn.btn--sm',
          {
            type: 'button',
            title: 'Set this server to what this machine can carry',
            onClick: async () => {
              await window.env.servers.update(record.id, { memory: { min: suggested.min, max: suggested.max } });
              toast(`Set to ${megabytesToText(suggested.min)} - ${megabytesToText(suggested.max)}`, 'ok');
              await refreshDetail();
            },
          },
          `Use ${megabytesToText(suggested.max)}`
        )
      )
    )
  );
}

/** The head-bar buttons for this view. */
export function dashboardActions() {
  const record = activeServer();
  if (!record) return [];

  const running = Boolean(state.status?.serverId === record.id && state.status.running);
  return [
    h('button.btn.btn--sm.btn--ghost', { type: 'button', onClick: () => setView('versions') }, icon('layers'), 'Versions'),
    running
      ? h('button.btn.btn--sm.btn--danger', { type: 'button', onClick: () => stopServer(record.id) }, icon('stop'), 'Stop')
      : h('button.btn.btn--sm.btn--primary', { type: 'button', onClick: () => startServer(record.id) }, icon('play'), 'Start'),
  ];
}

export { installVersion };
export { createServerCardImpl as createServerCard };