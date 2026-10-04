import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { state, saveSettings, refreshDetail } from '../state.js';

/**
 * Terms, licence and disclaimer.
 *
 * This is the first screen, before any server can be touched, and it is also a
 * permanent view under "About" so the terms can be re-read later. Nothing is
 * written to disk and no request is made until "I understand" is pressed.
 *
 * There is no emoji anywhere in this app - the marks are inline SVG, which cannot
 * 404 and inherit the surrounding colour.
 */

const OWNER = 'github.com/raolenv';

function section(iconName, title, ...body) {
  return h(
    'div.terms__section',
    h('h3.terms__h', icon(iconName, { size: 17 }), title),
    ...body.map((b) => h('p.terms__p', b))
  );
}

function list(...items) {
  return h('ul.terms__list', ...items.map((i) => h('li', i)));
}

export function termsBody({ locked }) {
  return h(
    'div.terms',
    section(
      'shield',
      'Who wrote this',
      h('span', 'EnvServer was written and is maintained by ', h('a', { href: 'https://github.com/raolenv' }, OWNER), '. The source, the issue tracker and the licence all live there. Any copy that claims a different author is not this project.')
    ),

    section(
      'info',
      'What this software is',
      'EnvServer is a local manager for Paper Minecraft servers on Windows. It downloads an official Paper build, works out which Java runtime that release needs, and starts the server in a folder on this machine.',
      list(
        'It runs entirely on this computer. There is no account, no cloud, no telemetry and no subscription.',
        'Every file it downloads comes from papermc.io, the Adoptium project, or Mojang\'s public profile API.',
        'It is a convenience wrapper. Everything it does can be done by hand with a text editor and the Paper server jar.'
      )
    ),

    section(
      'alert',
      'What it is not',
      list(
        'It is not a copy of Minecraft and it contains no Mojang assets. The app icon and every texture in this program are generated procedurally, and every interface icon is inline SVG authored here.',
        'It is not affiliated with, endorsed by, or connected to Mojang Studios or Microsoft. Minecraft is a trademark of Mojang AB.',
        'It does not bypass, crack, or provide unauthorised access to Minecraft. It runs only the server software that Mojang publishes for free, under the Minecraft EULA.'
      )
    ),

    section(
      'file',
      'Licence',
      h('span', 'Released under the MIT Licence. You may use, copy, modify and redistribute it, including commercially, provided the copyright notice and this permission notice are kept. The full text is in '),
      h('code', 'LICENSE'),
      ' in the source repository.'
    ),

    section(
      'cpu',
      'Third-party components',
      list(
        'Paper (PaperMC) - the Minecraft server software. It is downloaded at run time and is not part of this program.',
        'Eclipse Temurin (Adoptium) - the Java runtime, downloaded only when a matching version is missing.',
        'Electron (MIT) and electron-builder (MIT) - the packaging toolchain, used at build time only.',
        'Minecraft itself remains the property of Mojang AB and is subject to the Minecraft EULA and Usage Guidelines.'
      )
    ),

    section(
      'alert',
      'Disclaimer',
      'This software is provided "as is", without warranty of any kind, express or implied. The authors are not liable for any damage arising from its use, including lost worlds, corrupted data, or an unavailable server.',
      'You are responsible for what you run. Back up your worlds - EnvServer can do it for you, but you should know where the archives are before you need them.',
      'Mojang\'s Minecraft EULA applies to the server software this program launches. You are responsible for complying with it.'
    ),

    section(
      'shield',
      'Copyright and takedown',
      h('span', 'Copyright the authors of this project, published at ', h('a', { href: 'https://github.com/raolenv' }, OWNER), '. '),
      `If you believe material in this repository infringes a copyright you own, open an issue on that repository with the work in question and your contact details, and it will be reviewed and acted on.`
    ),

    h(
      'p.terms__meta',
      'EnvServer 1.0.0 - not affiliated with Mojang Studios or Microsoft.'
    )
  );
}

export function renderAbout(host) {
  const locked = !state.settings.termsAccepted;

  const accept = async () => {
    await saveSettings({ termsAccepted: true });
    await refreshDetail();
    // leave the terms screen only after the choice is actually on disk
    const { setView } = await import('../state.js');
    setView('dashboard');
  };

  return mount(
    host,
    h(
      'div.banner',
      { class: locked ? 'banner--warn' : '' },
      icon(locked ? 'alert' : 'check'),
      h(
        'span',
        locked
          ? 'Read this before using EnvServer. Nothing is downloaded and nothing is changed until you agree.'
          : 'The terms EnvServer is released under. Agreeing to them is recorded in this app\'s settings.'
      )
    ),
    termsBody({ locked }),
    h(
      'div.terms__foot',
      locked
        ? h(
            'div.row',
            h('button.btn.btn--primary.btn--lg', { type: 'button', onClick: accept }, icon('check'), 'I understand and agree'),
            h('a', { href: 'https://github.com/raolenv' }, 'Read the source')
          )
        : h(
            'div.row',
            h('a', { href: 'https://github.com/raolenv' }, 'Source and licence'),
            h('span.grow'),
            h(
              'button.btn.btn--sm.btn--ghost',
              {
                type: 'button',
                onClick: async () => {
                  const { confirmBox } = await import('../ui/overlay.js');
                  const ok = await confirmBox({
                    title: 'Withdraw agreement',
                    message: 'EnvServer will stop working until you agree to the terms again. Your servers and worlds are not touched.',
                    confirmText: 'Withdraw',
                    danger: true,
                  });
                  if (ok) await saveSettings({ termsAccepted: false });
                },
              },
              icon('refresh'),
              'Withdraw agreement'
            )
          )
    )
  );
}

/** The head-bar buttons for this view. */
export function aboutActions() {
  if (state.settings.termsAccepted) {
    return [
      h(
        'a.btn.btn--sm.btn--ghost',
        { href: 'https://github.com/raolenv', target: '_blank', rel: 'noreferrer', onClick: (e) => { e.preventDefault(); window.env.shell.openExternal('https://github.com/raolenv'); } },
        'github.com/raolenv'
      ),
    ];
  }
  return [];
}