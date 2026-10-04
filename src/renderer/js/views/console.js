import { h, mount, loader } from '../dom.js';
import { icon } from '../icons.js';
import { clock } from '../fmt.js';
import { state, activeServer, setView, sendCommand, clearLogs, refreshDetail } from '../state.js';
import { startServer, stopServer, backupNow } from '../actions.js';
import { toast } from '../ui/toast.js';

/**
 * The live console.
 *
 * This view does NOT re-render on log lines: `evt:log` fires many times a second
 * on a busy server, and rebuilding the view would reset the scroll position and
 * destroy the command box the user is typing in. `appendLine` adds one node.
 */

const MAX_NODES = 4000;

let termEl = null;
let autoscroll = true;

/** One console row. Exported so app.js can add it without a re-render. */
export function lineNode(entry) {
  const level = entry.level === 'cmd' ? 'cmd' : entry.level || 'info';
  return h(
    `div.term__line.term__line--${level}`,
    h('span.term__time', { text: entry.history ? '' : clock(entry.at) }),
    h('span', { text: entry.line })
  );
}

/** Append one entry to the live console, if it is on screen. */
export function appendLine(entry) {
  if (!termEl || !termEl.isConnected) return;
  const empty = termEl.querySelector('.term__empty');
  if (empty) empty.remove();

  while (termEl.childElementCount > MAX_NODES) termEl.removeChild(termEl.firstElementChild);

  termEl.appendChild(lineNode(entry));
  if (autoscroll) termEl.scrollTop = termEl.scrollHeight;
}

function buildTerm(running) {
  const term = h('div.term', {
    onScroll: (e) => {
      const el = e.target;
      autoscroll = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    },
  });

  if (state.logs.length) {
    for (const entry of state.logs) term.appendChild(lineNode(entry));
  } else if (running) {
    term.appendChild(h('div.term__empty', 'Waiting for the first line of output...'));
  } else {
    term.appendChild(h('div.term__empty', 'Nothing yet. Start the server and its output appears here live.'));
  }

  // scroll after layout, so the height is known
  requestAnimationFrame(() => {
    if (autoscroll) term.scrollTop = term.scrollHeight;
  });
  return term;
}

/**
 * Tail the server's own log file.
 *
 * This is what makes the console useful when the server was started outside the
 * app - by hand, from a script, or by a previous run that has since been closed.
 * `logs/latest.log` is the only record of what happened, so the view reads it
 * instead of showing an empty screen and pretending nothing ran.
 */
async function tailFile(record) {
  const res = await window.env.server.history(record.id, 600);
  if (!res?.ok) return;

  const lines = res.lines || [];
  if (!lines.length) return;

  // only append what is not already on screen, so a poll never duplicates a line
  const known = state.logs.length;
  const fresh = lines.slice(known);
  if (!fresh.length) return;

  for (const line of fresh) {
    state.logs.push({ line, level: 'info', at: Date.now(), history: true });
  }
  const max = state.settings.consoleLines || 2000;
  if (state.logs.length > max) state.logs.splice(0, state.logs.length - max);

  if (termEl && termEl.isConnected) {
    const empty = termEl.querySelector('.term__empty');
    if (empty) empty.remove();
    while (termEl.childElementCount > MAX_NODES) termEl.removeChild(termEl.firstElementChild);
    for (const entry of state.logs.slice(-fresh.length)) termEl.appendChild(lineNode(entry));
    if (autoscroll) termEl.scrollTop = termEl.scrollHeight;
  }
}

/* -------------------------------- commands ------------------------------ */

const SHORTCUTS = [
  ['list', 'Who is connected right now'],
  ['say', 'Broadcast, e.g. say Hello everyone'],
  ['tell', 'Message one player, e.g. tell Steve hi'],
  ['tps', 'Ticks per second'],
  ['seed', 'Show the world seed'],
  ['difficulty', 'Show the current difficulty'],
  ['gamemode', 'Show or change a gamemode'],
  ['time set day', 'Set it to daytime'],
  ['weather clear', 'Clear the weather'],
  ['save-all flush', 'Force a save'],
  ['whitelist on', 'Turn the whitelist on'],
  ['whitelist off', 'Turn the whitelist off'],
  ['reload', 'Reload config and plugins, not the world'],
  ['stop', 'Shut the server down'],
];

async function runCommand(text) {
  const record = activeServer();
  if (!record) return;
  if (!state.status?.running) {
    toast('The server is not running', 'err');
    return;
  }
  const res = await sendCommand(text);
  if (!res?.ok) toast(res?.error || 'that command could not be sent', 'err');
}

/* --------------------------------- render ------------------------------- */

export function renderConsole(host) {
  const record = activeServer();
  if (!record) {
    termEl = null;
    return mount(host, h('div.empty', icon('terminal'), h('b', { text: 'No server selected' }), 'Pick one from the list at the bottom of the sidebar.'));
  }

  const running = Boolean(state.status?.serverId === record.id && state.status.running);

  const input = h('input.input', {
    placeholder: running ? 'Type a command, then press Enter' : 'Start the server to send commands',
    disabled: !running,
    spellcheck: false,
    autocomplete: 'off',
  });

  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    await runCommand(text);
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      send();
    }
  });

  termEl = buildTerm(running);

  /*
   * When the app does not own the process, the live stream has nothing to say, so
   * the view falls back to the server's own log file. Polled rather than watched:
   * a file watcher on a path the server rewrites on every restart is more trouble
   * than it is worth, and 1.5s is well inside what a person can read.
   */
  let poller = null;
  if (!running) {
    tailFile(record);
    poller = setInterval(() => tailFile(record), 1500);
  }

  const pane = h(
    'div.console-pane',
    termEl,
    h(
      'div.termbar',
      input,
      h('button.btn.btn--sm.btn--primary', { type: 'button', disabled: !running, onClick: send }, icon('play'), 'Send'),
      h(
        'button.btn.btn--sm.btn--ghost',
        {
          type: 'button',
          title: 'Clear this view. logs/latest.log on disk is untouched.',
          onClick: () => {
            clearLogs();
            if (termEl) mount(termEl, h('div.term__empty', 'Cleared. Output from now on appears here.'));
          },
        },
        icon('close'),
        'Clear'
      ),
      h(
        'button.btn.btn--sm.btn--ghost',
        { type: 'button', title: 'Open the logs folder', onClick: () => window.env.shell.openServerPath(record.id, 'logs') },
        icon('folder'),
        'Logs'
      )
    )
  );

  const side = h(
    'div.console-side',
    h(
      'div.panel',
      h('div.panel__head', h('div.panel__title', icon('terminal'), 'Commands')),
      h(
        'div.panel__body',
        h('div.field__hint', { style: { marginBottom: '10px' } }, 'Click one to fill the box. Most take arguments.'),
        ...SHORTCUTS.map(([cmd, desc]) =>
          h(
            'div.cmdrow',
            h(
              'button.cmdrow__cmd',
              {
                type: 'button',
                title: `${desc}\n\nClick to fill in the command.`,
                onClick: () => {
                  input.value = `/${cmd}`;
                  input.focus();
                  input.setSelectionRange(input.value.length, input.value.length);
                },
              },
              `/${cmd}`
            ),
            h('span.faint.truncate', { style: { fontSize: '12px' }, text: desc })
          )
        )
      )
    )
  );

  const root = mount(host, pane, side);

  // the poller must not outlive the view: it would keep reading a log for a server
  // the user is no longer looking at
  const teardown = () => {
    if (poller) clearInterval(poller);
    poller = null;
  };
  window.addEventListener('env:view-changed', teardown, { once: true });

  return root;
}

/** The head-bar buttons for this view. */
export function consoleActions() {
  const record = activeServer();
  if (!record) return [];

  const running = Boolean(state.status?.serverId === record.id && state.status.running);
  return [
    running
      ? h('button.btn.btn--sm.btn--danger', { type: 'button', onClick: () => stopServer(record.id) }, icon('stop'), 'Stop')
      : h(
          'button.btn.btn--sm.btn--primary',
          {
            type: 'button',
            onClick: async () => {
              await startServer(record.id);
              await refreshDetail();
            },
          },
          icon('play'),
          'Start'
        ),
    h('button.btn.btn--sm.btn--ghost', { type: 'button', onClick: () => backupNow(record.id) }, icon('save'), 'Back up'),
    h('button.btn.btn--sm.btn--ghost', { type: 'button', onClick: () => setView('dashboard') }, icon('dashboard'), 'Dashboard'),
  ];
}

export { loader };