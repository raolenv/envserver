import { h, mount } from '../dom.js';
import { icon } from '../icons.js';

/**
 * Modal dialogs: confirmations and the first-run welcome.
 *
 * Progress deliberately does NOT live here. Every long operation runs as a
 * background job with its own progress in the sidebar (see `jobs.js`), so the
 * window stays usable while a 50 MB jar or a 200 MB JDK downloads.
 */

const OVERLAY = () => document.getElementById('overlay');

export function closeOverlay() {
  const el = OVERLAY();
  el.hidden = true;
  mount(el);
}

export function overlayOpen() {
  return !OVERLAY().hidden;
}

/**
 * A yes/no question.
 *
 * @returns {Promise<boolean>}
 */
export function confirmBox({
  title,
  message,
  detail = '',
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  danger = false,
  iconName = danger ? 'alert' : 'info',
}) {
  return new Promise((resolve) => {
    const el = OVERLAY();
    el.hidden = false;

    const done = (answer) => {
      closeOverlay();
      resolve(answer);
    };

    mount(
      el,
      h(
        'div.overlay__box',
        h('div.row', { style: { gap: '12px', marginBottom: '10px' } },
          h('span', { style: { color: danger ? 'var(--red)' : 'var(--green-hi)' } }, icon(iconName, { size: 22 })),
          h('h2.overlay__title', { style: { margin: 0 }, text: title })),
        h('p.overlay__status', { style: { marginBottom: detail ? '10px' : '0' }, text: message }),
        detail ? h('p.field__hint', { style: { marginBottom: '4px' }, text: detail }) : null,
        h(
          'div.overlay__foot',
          h('button.btn', { type: 'button', onClick: () => done(false) }, cancelText),
          h(`button.btn.${danger ? 'btn--danger' : 'btn--primary'}`, { type: 'button', onClick: () => done(true) }, confirmText)
        )
      )
    );
  });
}

/**
 * The first-run welcome.
 *
 * Deliberately short: pick a folder or take the default, and that is the whole
 * setup. Java, Paper and the EULA are handled by the app when it is needed, not
 * as steps the user has to walk through up front.
 *
 * @returns {Promise<{serverDir: 'pick'|null}>}
 */
export function welcomeBox() {
  return new Promise((resolve) => {
    const el = OVERLAY();
    el.hidden = false;

    const finish = (patch) => {
      closeOverlay();
      resolve(patch);
    };

    mount(
      el,
      h(
        'div.welcome__card',
        h('img.welcome__logo', { src: 'assets/icon-256.png', alt: '' }),
        h('h1.welcome__title', { text: 'Run a Minecraft server, locally' }),
        h('p.welcome__sub', {
          text:
            'EnvServer installs Paper, picks the Java version that release needs, and runs the server ' +
            'on this machine. Nothing is uploaded and there is no account to make.',
        }),
        h(
          'div.welcome__points',
          point('layers', 'Any Paper version', 'Every build from papermc.io, per Minecraft version.'),
          point('cpu', 'Java sorted out for you', 'The right runtime is found or downloaded automatically.'),
          point('terminal', 'Live console', 'Real output, plus a command box while it runs.'),
          point('shield', 'Backups included', 'Zip the world on demand or on a timer.')
        ),
        h(
          'div.overlay__foot',
          { style: { marginTop: '4px' } },
          h('button.btn', { type: 'button', onClick: () => finish({ serverDir: null }) }, 'Use the default location'),
          h('button.btn.btn--primary', { type: 'button', onClick: () => finish({ serverDir: 'pick' }) }, 'Choose where servers live')
        ),
        h('div.welcome__note', {
          text:
            'You are responsible for what you run here. EnvServer is not affiliated with Mojang or Microsoft. ' +
            'Minecraft is a trademark of Mojang AB.',
        })
      )
    );
  });
}

function point(iconName, title, body) {
  return h(
    'div.welcome__point',
    icon(iconName, { size: 20 }),
    h('div', h('b', { text: title }), body)
  );
}

/**
 * The startup-failure screen, now closable so it cannot trap the user.
 *
 * @returns {Promise<'retry'|'closed'>}
 */
export function failureBox(message) {
  return new Promise((resolve) => {
    const el = OVERLAY();
    el.hidden = false;

    const done = (how) => {
      closeOverlay();
      resolve(how);
    };

    mount(
      el,
      h(
        'div.overlay__box',
        h('div.row', { style: { gap: '12px', marginBottom: '10px' } },
          h('span', { style: { color: 'var(--red)' } }, icon('alert', { size: 22 })),
          h('h2.overlay__title', { style: { margin: 0 }, text: 'EnvServer could not start' })),
        h('p.overlay__status.is-error', { text: message }),
        h(
          'div.overlay__foot',
          h('button.btn', { type: 'button', onClick: () => done('closed') }, 'Close'),
          h('button.btn.btn--primary', { type: 'button', onClick: () => done('retry') }, 'Restart EnvServer')
        )
      )
    );
  });
}