import { h, mount, loader } from '../dom.js';
import { icon } from '../icons.js';
import { bytes, relative } from '../fmt.js';
import { state, activeServer, setView } from '../state.js';
import { addPlugins, removePlugin } from '../actions.js';
import { softwareById, softwareLabel, softwareSupports } from '../software.js';
import { badge } from './dashboard.js';
import { toast } from '../ui/toast.js';

/**
 * The `plugins/` folder.
 *
 * EnvServer does not parse plugin jars: a plugin is any `.jar` in that folder and
 * the server decides what it does with it. So this view stays thin - add a jar,
 * see what is there, remove one, restart so it loads.
 *
 * The nav bar does not offer this tab for software with no plugin loader, but the
 * page still has to behave if it is reached some other way - by a bookmarked
 * view id, or a server whose software was changed underneath it - so it explains
 * itself instead of offering a button that cannot work.
 */
export function renderPlugins(host) {
  const record = activeServer();
  if (!record) {
    return mount(host, h('div.empty', icon('puzzle'), h('b', { text: 'No server selected' }), 'Pick one from the list at the bottom of the sidebar.'));
  }

  if (!softwareSupports(record.type, 'plugins')) {
    const sw = softwareById(record.type);
    return mount(
      host,
      h(
        'div.panel',
        h('div.panel__head', h('div.panel__title', icon('puzzle'), 'Plugins')),
        h(
          'div.panel__body',
          h(
            'div.banner.banner--warn',
            icon('alert'),
            h('span', h('b', { text: `${sw.label} cannot load plugins.` }), ' The official Mojang jar has no plugin loader, so anything dropped in ', h('code', { text: 'plugins/' }), ' is simply ignored.')
          ),
          h('div.field__hint', { style: { marginTop: '14px' } }, 'Create the server on Paper, Folia, Purpur, Spigot or CraftBukkit if you want plugins. Everything else on this server - the config, the whitelist, the console, backups - works exactly the same.'),
          h(
            'div.row',
            { style: { marginTop: '18px' } },
            h('button.btn.btn--primary', { type: 'button', onClick: () => setView('versions') }, icon('layers'), 'See the other software'),
            h('button.btn.btn--ghost', { type: 'button', onClick: () => setView('dashboard') }, icon('dashboard'), 'Back to the dashboard')
          )
        )
      )
    );
  }

  const detail = state.detail;
  if (!detail || detail.server.id !== record.id) {
    return mount(host, h('div.empty', loader('lg'), 'Loading...'));
  }

  const plugins = detail.plugins || [];
  const running = Boolean(state.status?.serverId === record.id && state.status.running);

  return mount(
    host,
    h(
      'div.banner',
      icon('info'),
      running
        ? 'The server is running. A plugin added now is not loaded until it restarts, and a removed one stays loaded until it does.'
        : 'The server is stopped. Adding and removing jars is safe right now - the next start picks them up.'
    ),
    h(
      'div.row.row--wrap',
      { style: { marginBottom: '18px' } },
      h('button.btn.btn--primary', { type: 'button', onClick: () => addPlugins(record.id) }, icon('upload'), 'Add plugin jars'),
      h('button.btn.btn--ghost', { type: 'button', onClick: () => window.env.shell.openServerPath(record.id, 'plugins') }, icon('folder'), 'Open plugins folder'),
      h('span.grow'),
      plugins.length ? badge(`${plugins.length} installed`, 'ok') : null
    ),
    plugins.length
      ? h(
          'table.vtable',
          h('thead', h('tr', h('th', { text: 'Plugin' }), h('th', { text: 'File' }), h('th', { text: 'Size' }), h('th', { text: 'Added' }), h('th', { text: '' }))),
          h(
            'tbody',
            ...plugins.map((p) =>
              h(
                'tr',
                h('td', { text: p.name }),
                h('td', h('span.faint', { style: { fontFamily: 'var(--mono)', fontSize: '12px' }, title: p.file, text: p.file })),
                h('td.num', { text: bytes(p.size) }),
                h('td.num', { text: relative(p.modified) }),
                h(
                  'td',
                  h(
                    'button.btn.btn--sm.btn--ghost',
                    {
                      type: 'button',
                      title: running ? 'Removing the file does not unload a running plugin - restart the server too' : '',
                      onClick: async () => {
                        if (await removePlugin(record.id, p.file)) toast(`${p.file} removed`, 'info');
                      },
                    },
                    icon('trash'),
                    'Remove'
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
            h(
              'div.empty',
              icon('puzzle'),
              h('b', { text: 'No plugins installed' }),
              'Plugins are ordinary .jar files that go in the server folder. Add one above, or drop jars straight into ',
              h('code', { style: { color: 'var(--green-2)' }, text: 'plugins/' }),
              '.'
            )
          )
        ),
    h(
      'div.field__hint',
      { style: { marginTop: '18px' } },
      'Jar names are what the server shows in the console. A plugin usually downloads its own configuration into ',
      h('b', { text: 'plugins/<name>/' }),
      ' the first time it starts; those files are not listed here.'
    )
  );
}

/** The head-bar buttons for this view. */
export function pluginsActions() {
  const record = activeServer();
  if (!record) return [];
  // no "Add plugin" for software that has nowhere to put one
  if (!softwareSupports(record.type, 'plugins')) {
    return [h('button.btn.btn--sm.btn--ghost', { type: 'button', onClick: () => setView('dashboard') }, icon('dashboard'), 'Dashboard')];
  }
  return [
    h('button.btn.btn--sm.btn--ghost', { type: 'button', onClick: () => setView('dashboard') }, icon('dashboard'), 'Dashboard'),
    h('button.btn.btn--sm', { type: 'button', onClick: () => addPlugins(record.id) }, icon('upload'), 'Add plugin'),
  ];
}