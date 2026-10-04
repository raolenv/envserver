import { h } from './dom.js';
import { icon } from './icons.js';
import { state, saveSettings, refreshDetail } from './state.js';
import { toast } from './ui/toast.js';

/**
 * Demo mode.
 *
 * A real player list needs a real player, which needs a second human at a
 * keyboard. Demo mode exists so the dashboard, the player panel and the console can
 * all be evaluated without one.
 *
 * It is labelled everywhere it appears. Invented names that look like real players
 * would be a lie about the server's state, so the panel says DEMO in the corner and
 * every row is tagged.
 */

const NAMES = ['Raol', 'Steve', 'Alex', 'Notch', 'jeb_', 'Grian', 'Mumbo', 'Iskall'];

let timer = null;
let cursor = 0;

function pickName() {
  const name = NAMES[cursor % NAMES.length];
  cursor++;
  return name;
}

function current() {
  return state.demo.players.slice();
}

function render() {
  const host = document.getElementById('demo-panel');
  if (!host) return;

  const players = current();
  const running = Boolean(state.status?.running);

  mount(
    host,
    h(
      'div.panel',
      h('div.panel__head', h('div.panel__title', icon('users'), 'Players'), h('span.badge.badge--warn', { text: 'demo' })),
      h(
        'div.panel__body',
        h(
          'div.switch-row',
          { style: { paddingTop: 0 } },
          h('div.switch-row__text',
            h('div.switch-row__title', { text: 'Simulate players joining and leaving' }),
            h('div.switch-row__desc', { text: 'Feeds the dashboard and the console with invented players, so the UI can be checked without a second person. Nothing is written to the server.' })),
          switchBox(state.demo.on, (next) => setDemo(next))
        ),
        players.length
          ? h(
              'div.playerlist',
              { style: { marginTop: '14px' } },
              ...players.map((p) =>
                h(
                  'div.playerrow.playerrow--demo',
                  h('span.truncate', { text: p.name }),
                  h('span.playerrow__tag', { text: 'demo' }),
                  h('span.playerrow__since', { text: p.since })
                )
              )
            )
          : h('div.empty', { style: { padding: '20px', marginTop: '14px' }, text: state.demo.on ? 'Waiting for the first simulated player...' : 'Demo mode is off. Turn it on to see the player panel work.' }),
        running ? h('div.field__hint', { style: { marginTop: '12px' }, text: 'Real players are tracked from the server log and are never mixed with these.' }) : null
      )
    )
  );
}

function switchBox(checked, onToggle) {
  const el = h('button.switch', {
    type: 'button',
    role: 'switch',
    'aria-checked': checked ? 'true' : 'false',
    title: 'Demo players',
    onClick: () => {
      const next = el.getAttribute('aria-checked') !== 'true';
      el.setAttribute('aria-checked', next ? 'true' : 'false');
      onToggle(next);
    },
  });
  return el;
}

function setDemo(on) {
  state.demo.on = on;
  saveSettings({ demoPlayers: on });

  if (on) {
    toast('Demo mode on - invented players only', 'info');
    // seed one immediately so the panel is not empty for the first interval
    state.demo.players = [{ name: pickName(), since: 'now' }];
    timer = setInterval(tick, 4000);
  } else {
    toast('Demo mode off', 'info');
    state.demo.players = [];
    if (timer) clearInterval(timer);
    timer = null;
  }
  render();
  refreshDetail();
}

/** One join or one leave, whichever keeps the list interesting. */
function tick() {
  const players = state.demo.players;
  const online = players.length;

  if (online === 0 || (online < 4 && Math.random() < 0.6)) {
    const name = pickName();
    if (!players.some((p) => p.name === name)) {
      players.push({ name, since: 'now' });
      pushLog(`${name} joined the game`);
    }
  } else {
    const idx = Math.floor(Math.random() * players.length);
    const [gone] = players.splice(idx, 1);
    pushLog(`${gone.name} left the game`);
  }

  for (const p of players) p.since = 'now';
  render();
  refreshDetail();
}

/**
 * Mirror a simulated player into the console.
 *
 * The console is the thing a person actually watches, so a demo player that never
 * appears there would make the demo look broken.
 */
function pushLog(line) {
  state.logs.push({ line, level: 'info', at: Date.now(), history: true });
  const max = state.settings.consoleLines || 2000;
  if (state.logs.length > max) state.logs.splice(0, state.logs.length - max);
  window.dispatchEvent(new CustomEvent('env:demo-log'));
}

/** Called by app.js when the view changes, so the panel follows the active server. */
export function renderDemo() {
  render();
}

export function initDemo() {
  const on = state.settings.demoPlayers === true;
  state.demo = { on, players: [] };
  if (on) {
    state.demo.players = [{ name: pickName(), since: 'now' }];
    timer = setInterval(tick, 4000);
  }
  return state.demo;
}

export function stopDemo() {
  if (timer) clearInterval(timer);
  timer = null;
}

export { current as demoPlayers };