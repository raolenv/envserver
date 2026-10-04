import { h, mount, loader, switchBox } from '../dom.js';
import { icon } from '../icons.js';
import { state, activeServer, refreshDetail } from '../state.js';
import { acceptEula } from '../actions.js';
import { badge, iconBadge } from './dashboard.js';
import { toast } from '../ui/toast.js';

/**
 * Server settings.
 *
 * `server.properties` is edited in place with a real control per well-known key,
 * and anything the app does not model is still editable further down. Only the
 * keys you touch are written, so the dozen settings vanilla or you put there
 * survive a round trip untouched.
 */

const FIELDS = [
  { key: 'motd', label: 'MOTD', type: 'text', hint: 'The line players see in the server list. &a colour codes work.' },
  { key: 'server-port', label: 'Port', type: 'number', min: 1, max: 65535, hint: 'Forward this in your router for players outside your network.' },
  { key: 'max-players', label: 'Max players', type: 'number', min: 0, max: 1000 },
  { key: 'gamemode', label: 'Default gamemode', type: 'select', options: ['survival', 'creative', 'adventure', 'spectator'] },
  { key: 'difficulty', label: 'Difficulty', type: 'select', options: ['peaceful', 'easy', 'normal', 'hard'] },
  { key: 'online-mode', label: 'Online mode', type: 'bool', hint: 'Off lets anyone join with any name. Leave it on unless you know you want otherwise.' },
  { key: 'white-list', label: 'Whitelist on start', type: 'bool' },
  { key: 'enforce-whitelist', label: 'Kick players not on the whitelist', type: 'bool' },
  { key: 'pvp', label: 'PvP', type: 'bool' },
  { key: 'allow-nether', label: 'Allow the Nether', type: 'bool' },
  { key: 'allow-flight', label: 'Allow flight', type: 'bool' },
  { key: 'hardcore', label: 'Hardcore', type: 'bool', hint: 'No undo for death. Cannot be turned off afterwards.' },
  { key: 'generate-structures', label: 'Generate structures', type: 'bool' },
  { key: 'enable-command-block', label: 'Enable command blocks', type: 'bool' },
  { key: 'level-name', label: 'World folder', type: 'text', hint: 'The subfolder that holds the world.' },
  { key: 'level-seed', label: 'World seed', type: 'text', hint: 'Only used when a world is generated for the first time.' },
  { key: 'view-distance', label: 'View distance', type: 'number', min: 2, max: 32, hint: 'Chunks loaded around each player. Higher costs more memory.' },
  { key: 'simulation-distance', label: 'Simulation distance', type: 'number', min: 2, max: 32 },
  { key: 'spawn-protection', label: 'Spawn protection', type: 'number', min: 0, max: 100, hint: 'Radius in blocks where only ops can build.' },
  { key: 'network-compression-threshold', label: 'Compression threshold', type: 'number', min: -1, max: 100000 },
  { key: 'entity-broadcast-range-percentage', label: 'Entity broadcast %', type: 'number', min: 10, max: 1000 },
  { key: 'function-permission-level', label: 'Function permission', type: 'number', min: 1, max: 4 },
  { key: 'op-permission-level', label: 'Op permission level', type: 'number', min: 0, max: 4 },
];

const LISTS = [
  { which: 'whitelist', label: 'Whitelist', iconName: 'shield', empty: 'Anyone can join right now.', reload: '/whitelist reload' },
  { which: 'ops', label: 'Operators', iconName: 'zap', empty: 'Nobody can run commands.', reload: 'restart, or read it back with a command' },
  { which: 'banned', label: 'Banned players', iconName: 'alert', empty: 'Nobody is banned.', reload: '/banlist reload' },
];

/* ------------------------------ property edits -------------------------- */

let saveTimer = null;
function queueSave(serverId, properties) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    const res = await window.env.config.write(serverId, properties);
    if (!res?.ok) toast(res?.error || 'could not save that setting', 'err');
    else if (res.port) {
      const record = activeServer();
      if (record && record.port !== res.port) await window.env.servers.update(serverId, { port: res.port });
    }
  }, 450);
}

function control(serverId, spec, values) {
  const current = values[spec.key];

  if (spec.type === 'bool') {
    return h(
      'div.switch-row',
      h('div.switch-row__text', h('div.switch-row__title', { text: spec.label }), spec.hint ? h('div.switch-row__desc', { text: spec.hint }) : null),
      switchBox(current === 'true', (next) => queueSave(serverId, { [spec.key]: String(next) }), spec.label)
    );
  }

  if (spec.type === 'select') {
    const select = h(
      'select.select',
      { onChange: (e) => queueSave(serverId, { [spec.key]: e.target.value }) },
      ...spec.options.map((o) => h('option', { value: o, text: o, selected: current === o }))
    );
    // a value this release no longer accepts must stay visible, not be reset
    if (current && !spec.options.includes(current)) {
      select.prepend(h('option', { value: current, text: `${current} (unknown)`, selected: true }));
    }
    return h('div.field', h('div.field__label', { text: spec.label }), select, spec.hint ? h('div.field__hint', { text: spec.hint }) : null);
  }

  const input = h('input.input', {
    type: spec.type === 'number' ? 'number' : 'text',
    value: current ?? '',
    min: spec.min,
    max: spec.max,
    spellcheck: false,
    onInput: (e) => queueSave(serverId, { [spec.key]: e.target.value }),
  });

  return h('div.field', h('div.field__label', { text: spec.label }), input, spec.hint ? h('div.field__hint', { text: spec.hint }) : null);
}

/* ------------------------------ player lists ---------------------------- */

/**
 * Re-read the player lists while this view is open.
 *
 * A ban, pardon, op or deop issued from the server console rewrites the JSON
 * files directly, so nothing in the app sees it happen and the lists sit stale
 * until the view is reopened. Polling is the honest fix: the files are a few
 * hundred bytes, the interval is short, and the loop stops the moment the view
 * is left. The main process also pushes `evt:players` when it rewrites one of
 * these files itself, which is what makes an *offline* UUID turn into the real
 * one without waiting for the next tick.
 */
let listPoll = null;
let listUnsubscribe = null;
const configLoaders = new Map();

function stopListPoll() {
  if (listPoll) {
    clearInterval(listPoll);
    listPoll = null;
  }
  if (listUnsubscribe) {
    listUnsubscribe();
    listUnsubscribe = null;
  }
  configLoaders.clear();
}

/**
 * Called when the view is left.
 *
 * Without this the interval outlived the DOM it was repainting into: every tick
 * rebuilt three lists that were no longer on screen, forever.
 */
export function leaveConfig() {
  stopListPoll();
}

/** One loader per list, keyed `serverId:which`, so ticks never pile up. */
function registerLoader(key, load) {
  configLoaders.set(key, load);
}

function tickLists() {
  for (const load of configLoaders.values()) load();
}

function startListPoll() {
  stopListPoll();
  listPoll = setInterval(tickLists, 1500);
  listUnsubscribe = window.env.onPlayers(() => tickLists());
}

function listPanel(serverId, spec) {
  const listBox = h('div.col', { style: { gap: '6px' } });
  const input = h('input.input.input--sm', { placeholder: 'Player name', maxlength: 16, spellcheck: false, autocomplete: 'off' });
  const addBtn = h('button.btn.btn--sm', { type: 'button' }, icon('plus'), 'Add');

  // guards against the poll and a click reading the same file at the same time
  let inFlight = false;

  const load = async () => {
    const res = await window.env.config.list(serverId, spec.which);
    if (!res?.ok) return mount(listBox, h('div.banner.banner--err', icon('alert'), res?.error || 'that list could not be read'));
    const players = res.players || [];
    if (!players.length) return mount(listBox, h('div.empty', { style: { padding: '22px' }, text: spec.empty }));

    return mount(
      listBox,
      ...players.map((p) =>
        h(
          'div.checkline',
          h('div.checkline__name', h('span', { text: p.name }), h('div.checkline__uuid', { text: p.uuid || 'uuid fills in on first join' })),
          p.level ? badge(`level ${p.level}`) : null,
          h(
            'button.btn.btn--sm.btn--ghost',
            {
              type: 'button',
              onClick: async () => {
                const res2 = await window.env.config.removePlayer(serverId, spec.which, p.name);
                if (!res2?.ok) return toast(res2?.error || 'could not remove that player', 'err');
                toast(`${p.name} removed from ${spec.label.toLowerCase()}`, 'info');
                await load();
              },
            },
            icon('trash'),
            'Remove'
          )
        )
      )
    );
  };

  registerLoader(`${serverId}:${spec.which}`, load);

  const add = async () => {
    const name = input.value.trim();
    if (!name) {
      input.focus();
      return toast('Type a player name first', 'err');
    }
    if (inFlight) return;
    inFlight = true;
    addBtn.disabled = true;

    try {
      const res = await window.env.config.addPlayer(serverId, spec.which, name);
      if (!res?.ok) return toast(res?.error || 'could not add that player', 'err');
      input.value = '';
      input.focus();
      toast(`${res.player.name} added to ${spec.label.toLowerCase()}`, 'ok');
      // repaint straight away rather than waiting for the next poll tick
      await load();
    } catch (err) {
      toast(err?.message || 'could not add that player', 'err');
    } finally {
      inFlight = false;
      addBtn.disabled = false;
    }
  };

  addBtn.addEventListener('click', add);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      add();
    }
  });

  load();

  return h(
    'div.panel',
    h('div.panel__head', h('div.panel__title', icon(spec.iconName), spec.label)),
    h(
      'div.panel__body',
      h('div.row', { style: { marginBottom: '12px' } }, input, addBtn),
      listBox,
      h('div.field__hint', { style: { marginTop: '12px' }, text: `This list updates itself while the view is open. Changes are written to the JSON file; ${spec.reload} for the running server to apply them.` })
    )
  );
}

/* --------------------------------- render ------------------------------- */

export function renderConfig(host) {
  const record = activeServer();
  if (!record) {
    return mount(host, h('div.empty', icon('sliders'), h('b', { text: 'No server selected' }), 'Pick one from the list at the bottom of the sidebar.'));
  }

  const detail = state.detail;
  if (!detail || detail.server.id !== record.id) {
    return mount(host, h('div.empty', loader('lg'), 'Loading...'));
  }

  const values = detail.properties.values || {};

  const eulaPanel = h(
    'div.panel',
    h('div.panel__head', h('div.panel__title', icon('shield'), 'Minecraft EULA')),
    h(
      'div.panel__body',
      detail.eula
        ? h('div.banner.banner--ok', icon('check'), 'Accepted. eula.txt has eula=true, so the server will start.')
        : h(
            'div.banner.banner--warn',
            icon('info'),
            h(
              'span',
              'The server will not start until this is accepted. Running a Minecraft server means using Mojang\'s software, covered by the ',
              h('a', { onClick: (e) => { e.preventDefault(); window.env.shell.openExternal('https://aka.ms/MinecraftEULA'); } }, 'Minecraft EULA'),
              '.'
            )
          ),
      detail.eula
        ? h('div.row', iconBadge('check', 'accepted', 'ok'), h('span.grow'), h('button.btn.btn--sm.btn--ghost', { type: 'button', onClick: () => window.env.servers.openFolder(record.id) }, icon('folder'), 'Open server folder'))
        : h('button.btn.btn--primary.btn--block', { type: 'button', onClick: () => acceptEula(record.id) }, icon('check'), 'I accept - write eula=true')
    )
  );

  // rebuilt on every render, so the loaders registered below are always the
  // current ones; `startListPoll` reads them fresh on each tick
  configLoaders.clear();

  const result = mount(
    host,
    h('div.section', eulaPanel),
    h(
      'div.section',
      h('div.grid.grid--2',
        h('div.panel', h('div.panel__head', h('div.panel__title', icon('sliders'), 'General')), h('div.panel__body', h('div.col', ...FIELDS.slice(0, 8).map((s) => control(record.id, s, values))))),
        h('div.panel', h('div.panel__head', h('div.panel__title', icon('cube'), 'World and gameplay')), h('div.panel__body', h('div.col', ...FIELDS.slice(8).map((s) => control(record.id, s, values))))))
    ),
    h(
      'div.section',
      h('div.section__head', h('div.section__title', icon('users'), 'Players'), h('div.section__line')),
      h('div.grid.grid--2', ...LISTS.map((spec) => listPanel(record.id, spec)))
    ),
    h('div.section', extrasPanel(record.id, values))
  );

  // always on, running or not: a ban typed in the console is the common case, and
  // the files are tiny enough that the cost is nothing
  startListPoll();

  return result;
}

function extrasPanel(serverId, values) {
  const known = new Set(FIELDS.map((f) => f.key));
  const extras = Object.keys(values).filter((k) => !known.has(k) && k !== 'server-ip');

  return h(
    'div.panel',
    h('div.panel__head', h('div.panel__title', icon('file'), 'Everything else')),
    h(
      'div.panel__body',
      extras.length
        ? h(
            'div.tablewrap',
            h('table.vtable',
            h('thead', h('tr', h('th', { text: 'Key' }), h('th', { text: 'Value' }))),
            h(
              'tbody',
              ...extras.map((k) =>
                h('tr', h('td', { text: k }), h('td', h('input.input.input--sm', { value: values[k], spellcheck: false, onInput: (e) => queueSave(serverId, { [k]: e.target.value }) })))
              )
            )
            )
          )
        : h('div.empty', { style: { padding: '26px' }, text: 'No other keys are set in server.properties.' }),
      h('div.field__hint', { style: { marginTop: '12px' }, text: 'Kept exactly as the server wrote them. Editing is safe; there is no delete button on purpose.' })
    )
  );
}

/** The head-bar buttons for this view. */
export function configActions() {
  const record = activeServer();
  if (!record) return [];
  return [
    h('button.btn.btn--sm.btn--ghost', { type: 'button', onClick: () => refreshDetail() }, icon('refresh'), 'Reload'),
    h('button.btn.btn--sm.btn--ghost', { type: 'button', onClick: () => window.env.servers.openFolder(record.id) }, icon('folder'), 'Open folder'),
  ];
}