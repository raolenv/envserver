import { h, mount, loader, switchBox } from '../dom.js';
import { icon } from '../icons.js';
import { state, activeServer, refreshDetail } from '../state.js';
import { acceptEula } from '../actions.js';
import { badge, iconBadge } from './dashboard.js';
import { softwareById, softwareRuntime } from '../software.js';
import { toast } from '../ui/toast.js';

/**
 * Server settings.
 *
 * `server.properties` is edited in place with a real control per well-known key,
 * and anything the app does not model is still editable further down. Only the
 * keys you touch are written, so the dozen settings vanilla or you put there
 * survive a round trip untouched.
 *
 * The layout follows the software, because three runtimes do not share a config
 * file. Java servers get the full grid. PocketMine reads a `server.properties`
 * with a handful of unrelated keys, so it gets the raw key/value editor and
 * nothing that would be guessing. Mojang's Bedrock server has no EULA, no
 * `gamemode`, and no Java player-list format - so it gets told that rather than
 * being shown a grid of switches that quietly do nothing.
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
      h('div.field__hint', { style: { marginTop: '12px' }, text: `Saved to the JSON file. ${spec.reload}` })
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
  const rt = softwareRuntime(record.type);
  const sw = softwareById(record.type);
  /** There is no file yet, as opposed to a file with nothing in it. */
  const noFile = Boolean(detail.properties.missing);

  /**
   * Why there is no EULA box here.
   *
   * `detail.eula` comes back `true` for Bedrock and PocketMine because neither
   * writes an `eula.txt`, so rendering the normal panel would put a green
   * "Accepted. eula.txt has eula=true" banner over a file that does not exist.
   */
  const eulaPanel = rt !== 'java'
    ? h(
        'div.panel',
        h('div.panel__head', h('div.panel__title', icon('shield'), 'Terms')),
        h(
          'div.panel__body',
          h(
            'div.banner',
            icon('info'),
            h(
              'span',
              rt === 'none'
                ? h('span', h('b', { text: 'No EULA to accept. ' }), 'Mojang\'s Bedrock server has no eula.txt - you accept the Minecraft EULA when you download it from minecraft.net, and it is not re-checked on each start.')
                : h('span', h('b', { text: 'No EULA to accept. ' }), 'PocketMine-MP is not Mojang\'s software and has no EULA of its own. Its licence is on pmmp.io.')
            )
          ),
        h(
          'div.field__hint',
          { style: { marginTop: '12px' } },
          h(
            'a',
            {
              onClick: (e) => {
                e.preventDefault();
                window.env.shell.openExternal(rt === 'none' ? 'https://www.minecraft.net/en-us/download/server/bedrock' : 'https://pmmp.io');
              },
            },
            rt === 'none' ? 'minecraft.net' : 'pmmp.io'
          )
        )
      )
    )
    : h(
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

  /**
   * The Java `server.properties` grid.
   *
   * Rendered only for Java software. Every key in `FIELDS` is a Java key - and
   * writing `gamemode=survival` into a PocketMine or Bedrock server.properties
   * would put a switch in front of the user that the software ignores while the
   * key it does read (`auto-save`, `language`) sits in "Everything else".
   */
  const javaFields =
    rt === 'java'
      ? h(
          'div.section',
          noFile
            ? h('div.banner', icon('info'), h('span', h('b', { text: 'No server.properties yet. ' }), `${sw.label} writes its own on the first start. Everything below is saved to the file as you type, so the values here will be there when it does.`))
            : null,
          h(
            'div.grid.grid--2',
            h('div.panel', h('div.panel__head', h('div.panel__title', icon('sliders'), 'General')), h('div.panel__body', h('div.col', ...FIELDS.slice(0, 8).map((s) => control(record.id, s, values))))),
            h('div.panel', h('div.panel__head', h('div.panel__title', icon('cube'), 'World and gameplay')), h('div.panel__body', h('div.col', ...FIELDS.slice(8).map((s) => control(record.id, s, values)))))
          )
        )
      : null;

  /**
   * The player lists, which are Java-shaped too.
   *
   * EnvServer writes `{ uuid, name }` JSON. Mojang's Bedrock server keeps its
   * whitelist in a different shape and its operators in `permissions.json`, and
   * PocketMine uses plain `.txt` lists - so offering these would mean writing a
   * Java whitelist into a folder whose owner expects something else, and possibly
   * making the server fail to start. Saying so is the honest option; the folder
   * is one click away.
   */
  const javaLists =
    rt === 'java'
      ? h(
          'div.section',
          h('div.section__head', h('div.section__title', icon('users'), 'Players'), h('div.section__line')),
          h('div.grid.grid--2', ...LISTS.map((spec) => listPanel(record.id, spec)))
        )
      : h(
          'div.section',
          h('div.panel',
            h('div.panel__head', h('div.panel__title', icon('users'), 'Players')),
            h(
              'div.panel__body',
              h(
                'div.banner',
                icon('info'),
                h(
                  'span',
                  rt === 'none'
                    ? h('span', h('b', { text: 'EnvServer does not edit the Bedrock player lists. ' }), 'Mojang\'s server keeps its whitelist in whitelist.json and its operators in permissions.json, in a different format from the Java one. Open the folder and edit those directly, or use the whitelist and permission commands in the console.')
                    : h('span', h('b', { text: 'EnvServer does not edit PocketMine\'s player lists. ' }), 'PocketMine uses plain ops.txt, whitelist.txt and banned-players.txt rather than the Java JSON. Open the folder and edit those directly, or use the op and whitelist commands in the console.')
                )
              ),
              h('div.row', { style: { marginTop: '12px' } },
                h('button.btn.btn--sm', { type: 'button', onClick: () => window.env.servers.openFolder(record.id) }, icon('folder'), 'Open server folder'),
                h('a', { onClick: (e) => { e.preventDefault(); window.env.shell.openExternal(rt === 'none' ? 'https://www.minecraft.net/en-us/download/server/bedrock' : 'https://pmmp.io/wiki/'); } }, rt === 'none' ? 'Mojang\'s Bedrock server docs' : 'PocketMine-MP docs')
              )
            )
          )
        );

  // rebuilt on every render, so the loaders registered below are always the
  // current ones; `startListPoll` reads them fresh on each tick
  configLoaders.clear();

  const result = mount(
    host,
    h('div.section', eulaPanel),
    javaFields,
    javaLists,
    rt === 'java' ? h('div.section', extrasPanel(record.id, values)) : nonJavaExtras(record, values, noFile)
  );

  // always on, running or not: a ban typed in the console is the common case, and
  // the files are tiny enough that the cost is nothing
  startListPoll();

  return result;
}

/**
 * The raw key/value editor, for software that reads a `server.properties` but
 * whose keys EnvServer does not model.
 *
 * PocketMine's file is genuinely a `server.properties` - `motd`,
 * `server-port`, `max-players`, `auto-save`, `language`, `settings-language`,
 * `enable-ansi-escape` - so editing the raw keys is correct, not a guess. Bedrock
 * writes its own file with its own key set, which is shown read-only rather than
 * offered for editing, because an empty grid of invented keys is worse than none.
 */
function nonJavaExtras(record, values, noFile) {
  const rt = softwareRuntime(record.type);
  const file = 'server.properties';

  if (rt === 'none') {
    return h(
      'div.section',
      h('div.panel',
        h('div.panel__head', h('div.panel__title', icon('file'), 'server.properties')),
        h(
          'div.panel__body',
          h(
            'div.banner',
            icon('info'),
            h('span', h('b', { text: 'Mojang\'s Bedrock server has its own configuration. ' }), `It writes its own ${file} the first time it starts, with its own key set - level-name, tick-distance, player-movement-score-threshold and the rest, none of which are the Java keys. EnvServer does not model them here rather than offer switches that do nothing. Open the folder after the first start to read or edit it.`)
          ),
          Object.keys(values).length
            ? h('div.tablewrap', { style: { marginTop: '12px' } }, h('table.vtable', h('thead', h('tr', h('th', { text: 'Key' }), h('th', { text: 'Value' }))), h('tbody', ...Object.keys(values).map((k) => h('tr', h('td', { text: k }), h('td', { text: String(values[k]) }))))))
            : null,
          h('div.row', { style: { marginTop: '12px' } }, h('button.btn.btn--sm', { type: 'button', onClick: () => window.env.servers.openFolder(record.id) }, icon('folder'), 'Open server folder'))
        )
      )
    );
  }

  return h(
    'div.section',
    h('div.panel',
      h('div.panel__head', h('div.panel__title', icon('file'), `${file} keys`)),
      h(
        'div.panel__body',
        noFile
          ? h('div.banner', icon('info'), h('span', h('b', { text: 'No server.properties yet. ' }), 'PocketMine-MP writes its own on the first start. Anything you type here is written to the file as you go.'))
          : null,
        Object.keys(values).length
          ? h('div.tablewrap', { style: { marginTop: '12px' } }, h('table.vtable', h('thead', h('tr', h('th', { text: 'Key' }), h('th', { text: 'Value' }))), h('tbody', ...Object.keys(values).map((k) => h('tr', h('td', { text: k }), h('td', h('input.input.input--sm', { value: values[k], spellcheck: false, onInput: (e) => queueSave(record.id, { [k]: e.target.value }) })))))))
          : h('div.empty', { style: { padding: '22px' }, text: 'No keys yet.' }),
        h('div.field__hint', { style: { marginTop: '12px' }, text: 'Written to the file as you type. Common keys: motd, server-port, max-players, auto-save, language.' })
      )
    )
  );
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
      h('div.field__hint', { style: { marginTop: '12px' }, text: 'Exactly as the server wrote them. Editing is safe.' })
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