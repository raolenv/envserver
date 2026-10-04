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

/**
 * Group fragments into one paragraph.
 *
 * `section()` used to wrap every one of its arguments in its own `<p>`, so a
 * sentence that had been written as pieces - "...the full text is in",
 * `<code>LICENSE</code>`, "in the source repository." - came out as three
 * paragraphs, the middle one of which was the single word LICENSE on a line of
 * its own. Wrapping the pieces in `para()` says where the sentence ends.
 *
 * @param {...(string|Node)} fragments
 * @returns {{para: Array<string|Node>}} not a node - `block()` turns it into one
 */
function para(...fragments) {
  return { para: fragments };
}

/**
 * One block of a section.
 *
 * A list is a block in its own right: `<ul>` inside `<p>` is not valid markup,
 * and a browser that reparses it closes the paragraph early and leaves the list
 * outside the section.
 *
 * @param {any} b
 * @returns {Node}
 */
function block(b) {
  if (b && Array.isArray(b.para)) return h('p.terms__p', ...b.para);
  if (b instanceof Node) return b;
  return h('p.terms__p', b);
}

function section(iconName, title, ...body) {
  return h(
    'div.terms__section',
    h('h3.terms__h', icon(iconName, { size: 17 }), title),
    ...body.map(block)
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
      para(
        'EnvServer is a local manager for Minecraft servers on Windows. It downloads an official server build, works out what that release needs to run, and starts it in a folder on this machine.'
      ),
      list(
        'It runs entirely on this computer. There is no account, no cloud, no telemetry and no subscription.',
        'It can set up nine kinds of server: PaperMC, Folia, Purpur, the official Mojang jar, Spigot, CraftBukkit or a jar you already have on Java; Mojang\'s Bedrock Dedicated Server; and PocketMine-MP.',
        'Every file it downloads comes from the project that publishes it: fill.papermc.io for Paper and its forks, Mojang\'s version API for the official jar, Mojang\'s own download service for the Bedrock zip, and the PocketMine-MP releases on GitHub. A Java runtime is downloaded from the Adoptium project, and only when one is missing.',
        'PHP is the exception. It is never bundled: EnvServer finds the PHP already installed on your machine and tells you what it found, because the Windows builds cannot be redistributed here under one licence.',
        'Spigot and CraftBukkit publish no public download API, so for those two you supply the jar yourself. Everything else is downloaded for you.'
      )
    ),

    section(
      'alert',
      'What it is not',
      list(
        'It is not a copy of Minecraft and it contains no Mojang assets. The app icon and every texture in this program are generated procedurally, and every interface icon is inline SVG authored here.',
        'It is not affiliated with, endorsed by, or connected to Mojang Studios or Microsoft. Minecraft is a trademark of Mojang AB.',
        'It does not bypass, crack, or provide unauthorised access to Minecraft. It runs only server software that its authors publish for free, under the Minecraft EULA.',
        'It is not a hosting service. Nothing is uploaded anywhere and no server is exposed to the internet by it - exposing one is your own decision, with your own firewall rules.'
      )
    ),

    section(
      'file',
      'Licence',
      para(
        h('span', 'Released under the MIT Licence. You may use, copy, modify and redistribute it, including commercially, provided the copyright notice and this permission notice are kept. The full text is in '),
        h('code', 'LICENSE'),
        ' in the source repository.'
      )
    ),

    section(
      'cpu',
      'Third-party components',
      list(
        'Paper, Folia and Purpur (PaperMC) - the Minecraft server software. Downloaded at run time and not part of this program.',
        'Eclipse Temurin (Adoptium) - the Java runtime, downloaded only when a matching version is missing.',
        'Bedrock Dedicated Server (Mojang) - the Bedrock server software, downloaded at run time and unpacked into the server folder.',
        'PocketMine-MP (pmmp) - a PHP Bedrock server. Its phar is downloaded at run time and is not part of this program.',
        'PHP - not included and not downloaded. You install it yourself if you want to run PocketMine-MP.',
        'Electron (MIT) and electron-builder (MIT) - the packaging toolchain, used at build time only.',
        'Minecraft itself remains the property of Mojang AB and is subject to the Minecraft EULA and Usage Guidelines.'
      )
    ),

    section(
      'alert',
      'Disclaimer',
      para(
        'This software is provided "as is", without warranty of any kind, express or implied. The authors are not liable for any damage arising from its use, including lost worlds, corrupted data, or an unavailable server.'
      ),
      para(
        'You are responsible for what you run. Back up your worlds - EnvServer can do it for you, but you should know where the archives are before you need them.'
      ),
      para(
        'Mojang\'s Minecraft EULA applies to the server software this program launches. You are responsible for complying with it.'
      )
    ),

    section(
      'shield',
      'Copyright and takedown',
      para(
        h('span', 'Copyright the authors of this project, published at ', h('a', { href: 'https://github.com/raolenv' }, OWNER), '.'),
        ' If you believe material in this repository infringes a copyright you own, open an issue on that repository with the work in question and your contact details, and it will be reviewed and acted on.'
      )
    ),

    h(
      'p.terms__meta',
      // from the running app, so it cannot drift the way a typed-in literal does
      `EnvServer ${state.appVersion || '?'} - not affiliated with Mojang Studios or Microsoft.`
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
        'div.row',
        { style: { alignItems: 'center', gap: '12px', flexWrap: 'wrap' } },
        h(
          'span.grow',
          locked
            ? 'Read this before using EnvServer. Nothing is downloaded and nothing is changed until you agree.'
            : 'The terms EnvServer is released under. Agreeing to them is recorded in this app\'s settings.'
        ),
        locked
          ? h('button.btn.btn--primary', { type: 'button', onClick: accept }, icon('check'), 'I understand and agree')
          : h(
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
    ),
    termsBody({ locked })
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