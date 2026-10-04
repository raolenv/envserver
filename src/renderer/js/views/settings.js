import { h, mount, loader, switchBox } from '../dom.js';
import { icon } from '../icons.js';
import { megabytesToText, plural } from '../fmt.js';
import {
  state,
  activeServer,
  saveSettings,
  refreshDetail,
  refreshJvmPlan,
  createServer,
  refreshServers,
  deleteServer,
  setPhpPath,
} from '../state.js';
import { addJava as downloadJava, suggestMemory, memoryBudget } from '../actions.js';
import { badge, iconBadge } from './dashboard.js';
import { SOFTWARE, runtimeNoun } from '../software.js';
import { toast } from '../ui/toast.js';
import { confirmBox } from '../ui/overlay.js';

/**
 * Settings — same visual language as the Config view.
 *
 * Full-width sections with headers, 2-column grids inside, and the same
 * panel/field/switch components. No narrow single-column constraint: the
 * window is wide, so the space should be used.
 */

/**
 * A titled panel.
 *
 * `key` adds a `panel--<key>` class, and exists so the README screenshot tool can
 * crop to one specific panel. Cropping to `.settings > .section:first-child`
 * instead catches the Java runtime list too, and since that list is often taller
 * than the window the crop is clamped to the whole viewport - which produced a
 * `memory.png` byte-identical to `settings.png`.
 */
function panel(title, iconName, body, key) {
  return h('div.panel', { className: key ? `panel panel--${key}` : 'panel' }, h('div.panel__head', h('div.panel__title', icon(iconName), title)), h('div.panel__body', body));
}

function field(label, control, hint) {
  return h('div.field', h('div.field__label', { text: label }), control, hint ? h('div.field__hint', { text: hint }) : null);
}

/* -------------------------------- memory -------------------------------- */

function memoryPanel() {
  const settings = state.settings;
  const record = activeServer();
  const total = settings.totalMemoryMb || 0;
  const current = record ? record.memory : settings.memory;
  const save = (patch) => (record ? window.env.servers.update(record.id, patch) : saveSettings({ memory: { ...current, ...patch } }));

  const suggested = suggestMemory(total);
  const budget = memoryBudget(current ? { memory: current } : null, total);
  const percent = budget.percent;
  const ceiling = Math.max(4096, total ? Math.floor(total * 0.9) : 16384);
  const label = h('div.slider__value', { text: `${current.max} MB` });

  const slider = h('input', {
    type: 'range', min: 512, max: ceiling, step: 256, value: current.max,
    onInput: (e) => { label.textContent = `${Number(e.target.value)} MB`; },
    onChange: async (e) => {
      const val = Number(e.target.value);
      const res = await save({ memory: { min: val, max: val } });
      if (res && res.ok === false) toast(res.error || 'could not save that', 'err');
      label.textContent = `${res?.memory?.max ?? val} MB`;
      await refreshDetail();
    },
  });

  return h('div.col', { style: { gap: '14px' } },
    h('div.faint', { style: { fontSize: '13px' }, text: record ? `Allocated to "${record.name}"` : 'Default for new servers' }),
    field('Maximum heap (-Xmx)', h('div.row', slider, label)),
    h('div.row.row--between',
      h('span.faint', { style: { fontSize: '13px' }, text: `max ${megabytesToText(current.max)}` }),
      h('span.faint', { style: { fontSize: '13px' }, text: total ? `${percent}% of ${megabytesToText(total)} installed` : 'system RAM unknown' })
    ),
    record ? null : h('button.btn.btn--sm', { type: 'button', onClick: () => { saveSettings({ memory: suggested }); toast(`Set to ${megabytesToText(suggested.min)} - ${megabytesToText(suggested.max)}`, 'ok'); } }, 'Suggest ' + megabytesToText(suggested.max)),
    h(
      `div.banner${budget.overBudget ? '.banner--err' : budget.tight ? '.banner--warn' : ''}`,
      icon('alert'),
      h(
        'span',
        budget.overBudget
          ? h('b', 'More than this machine has. ')
          : budget.tight
            ? h('b', 'Tight for this machine. ')
            : h('b', 'Fits this machine. '),
        total
          ? `Installed RAM is ${megabytesToText(total)}, so this leaves ${megabytesToText(Math.max(0, budget.headroomMb))} for Windows and everything else. `
          : 'Installed RAM could not be read, so no advice is offered. ',
        h('b', 'EnvServer sizes a new server from this machine automatically - about half of it - so this only needs setting by hand when you want something else.')
      )
    ),
    h('div.field__hint', { text: 'A small world with a handful of players is happy on 2 GB. More memory does not make it faster, it makes the garbage collector pause longer.' }),
    h(
      'div.field__hint',
      { style: { marginTop: '10px' } },
      h('b', { text: 'Why a 512 MB server shows 800 MB in Task Manager: ' }),
      '-Xmx is a ceiling on the JVM heap and nothing else. Metaspace, the code cache, one stack per thread and Paper\'s off-heap network buffers all sit outside it and are still counted against the process. The dashboard reads the heap itself where it can, and keeps the process total as a separate number.'
    )
  );
}

/* --------------------------------- java --------------------------------- */

function javaPanel() {
  const plan = state.jvm;
  const settings = state.settings;
  const majors = [...new Set(plan.runtimes.map((r) => r.major))].sort((a, b) => b - a);
  const missing = plan.missing || [];

  const overrideInput = h('input.input', { value: settings.javaPath || '', placeholder: 'empty = match each server automatically', spellcheck: false });

  const runtimeList = majors.length
    ? h('div.javaruntimes', ...majors.map((m) => {
        const runtime = plan.runtimes.find((r) => r.major === m);
        const bundled = (plan.bundled || []).includes(m);
        return h('div.javaruntime',
          h('span.javaruntime__major', { text: `Java ${m}` }),
          h('span.javaruntime__path', { title: runtime.javaExe, text: runtime.javaExe }),
          h('div.row', { style: { gap: '8px' } },
            bundled ? badge('downloaded here', 'info') : null,
            h('button.btn.btn--sm', {
              type: 'button', disabled: !activeServer(),
              title: activeServer() ? `Pin Java ${m} to "${activeServer().name}"` : 'Select a server in the sidebar first',
              onClick: async () => { const rec = activeServer(); await window.env.java.assign(rec.id, runtime.javaExe); toast(`${rec.name} pinned to Java ${m}`, 'ok'); await refreshJvmPlan(); await refreshDetail(); },
            }, 'Pin'),
            bundled ? h('button.btn.btn--sm.btn--ghost', { type: 'button', onClick: async () => {
              const ok = await confirmBox({ title: `Delete Java ${m}`, message: 'The extracted runtime folder is removed. The downloaded archive is kept, so it can be re-extracted later.', confirmText: 'Delete', danger: true });
              if (!ok) return; await window.env.java.removeRuntime(m); await refreshJvmPlan();
            } }, icon('trash')) : null
          )
        );
      }))
    : h('div.empty', { style: { padding: '26px' } }, icon('download'), h('b', { text: 'No Java runtime on this machine' }),
        settings.autoInstallJava === false ? 'Turn auto-download on, or point at a JDK you already have.' : 'That is fine - EnvServer downloads the right one automatically the first time a server needs it.');

  const missingRow = missing.length
    ? h('div.banner.banner--warn', icon('alert'), h('div',
        h('b', { text: `Java ${missing.join(' and ')} is not installed` }), ' - needed by ',
        plural(state.jvm.plan.filter((p) => missing.includes(p.requiredMajor)).length, 'server'), '. ',
        settings.autoInstallJava === false ? 'Auto-download is off, so those servers cannot start yet.' : 'It downloads automatically when you start one, or you can do it now:',
        settings.autoInstallJava === false ? null : h('div.row.row--wrap', { style: { marginTop: '10px' } },
          ...missing.map((m) => h('button.btn.btn--sm.btn--primary', { type: 'button', onClick: () => downloadJava(m) }, icon('download'), `Download Java ${m}`)))
        )
      )
    : null;

  return h('div.col', { style: { gap: '14px' } },
    h('div.switch-row', { style: { paddingTop: 0 } },
      h('div.switch-row__text',
        h('div.switch-row__title', { text: 'Download Java automatically when one is missing' }),
        h('div.switch-row__desc', { text: "Takes Eclipse Temurin from adoptium.net and installs it into this app's own folder." })),
      switchBox(settings.autoInstallJava !== false, (next) => { saveSettings({ autoInstallJava: next }); toast(next ? 'EnvServer will download a missing Java for you' : 'EnvServer will only use Java that is already installed', 'info'); })
    ),
    missingRow,
    field('Global override',
      h('div.pathbox', overrideInput,
        h('button.btn.btn--sm', { type: 'button', onClick: async () => {
          const p = overrideInput.value.trim();
          if (p) { const probe = await window.env.java.probe(p); if (!probe?.ok) return toast(probe?.error || 'no working Java in that folder', 'err'); }
          saveSettings({ javaPath: p }); await refreshJvmPlan(); await refreshDetail();
        } }, 'Use'),
        h('button.btn.btn--sm.btn--ghost', { type: 'button', onClick: async () => {
          const res = await window.env.shell.pickDirectory(); if (!res?.ok || res.cancelled) return;
          overrideInput.value = res.dir; saveSettings({ javaPath: res.dir }); await refreshJvmPlan();
        } }, 'Browse')
      ),
      'A JDK folder or a java.exe. Overrides automatic matching for every server with no pin of its own.'
    ),
    h('div.divider'),
    h('div.field__label', { text: 'Installed runtimes' }),
    runtimeList,
    plan.runtimes.length ? h('div.field__hint', { text: `${plural(plan.runtimes.length, 'runtime')} found. Each was probed with java -version rather than read off its folder name.` }) : null
  );
}

/* --------------------------------- php ---------------------------------- */

/**
 * PHP, for PocketMine-MP.
 *
 * A separate panel rather than a row in the Java list, because it behaves the
 * opposite way: Java can be downloaded on demand, PHP cannot. Every Windows PHP
 * build is somebody's own build under their own licence, so EnvServer finds an
 * existing one and refuses to start PocketMine without it instead of quietly
 * fetching a runtime it has no right to redistribute.
 *
 * It only appears when something needs it. On a machine with no PocketMine
 * server, a PHP section is a question nobody asked.
 */
function phpPanel() {
  const rt = state.runtime;
  const settings = state.settings;
  const min = rt.phpMin || '8.1';

  const needsPhp = SOFTWARE.some((s) => s.runtime === 'php') && state.servers.some((s) => s.type === 'pocketmine');
  if (!needsPhp) return null;

  const found = rt.php || [];
  const usable = found.filter((p) => p.ok);

  const overrideInput = h('input.input', {
    value: settings.phpPath || '',
    placeholder: 'empty = find a PHP automatically',
    spellcheck: false,
  });

  const list = found.length
    ? h(
        'div.javaruntimes',
        ...found.map((p) =>
          h(
            'div.javaruntime',
            h('span.javaruntime__major', { text: `PHP ${p.version}` }),
            h('span.javaruntime__path', { title: p.exe, text: p.exe }),
            p.ok ? badge('usable', 'ok') : badge(`too old, needs ${min}`, 'warn')
          )
        )
      )
    : h(
        'div.empty',
        { style: { padding: '26px' } },
        icon('alert'),
        h('b', { text: `No PHP on this machine` }),
        `PocketMine-MP needs PHP ${min} or newer. php.org/downloads has official Windows builds.`
      );

  return h(
    'div.col',
    { style: { gap: '14px' } },
    h('div.banner.banner--warn', icon('info'), h('div',
      h('b', { text: 'EnvServer does not install PHP for you' }),
      ' - PHP for Windows is not one redistributable binary. Each build comes from the PHP project or a third party, under that publisher\'s licence, so shipping one inside this app is not ours to do. Install PHP and point EnvServer at it below.'
    )),
    field(
      'PHP override',
      h(
        'div.pathbox',
        overrideInput,
        h('button.btn.btn--sm', {
          type: 'button',
          onClick: async () => {
            const p = overrideInput.value.trim();
            const res = await setPhpPath(p);
            if (!res?.ok) return toast(res?.error || 'no working php.exe in that folder', 'err');
            // clearing the override does not return a runtime, so there is no
            // `res.runtime` to read - say what happened rather than printing
            // "PHP undefined"
            toast(res.runtime ? `PocketMine-MP will run on ${res.runtime.version}` : 'EnvServer will find a PHP automatically again', 'ok');
          },
        }, 'Use'),
        h('button.btn.btn--sm.btn--ghost', {
          type: 'button',
          onClick: async () => {
            const res = await window.env.shell.pickDirectory();
            if (!res?.ok || res.cancelled) return;
            overrideInput.value = res.dir;
            const done = await setPhpPath(res.dir);
            if (!done?.ok) return toast(done?.error || 'no working php.exe in that folder', 'err');
          },
        }, 'Browse')
      ),
      `A PHP folder or a php.exe. Overrides automatic detection for every PocketMine server.`
    ),
    h('div.divider'),
    h('div.field__label', { text: 'Installed PHP' }),
    list,
    usable.length
      ? h('div.field__hint', { text: `${plural(usable.length, 'runtime')} usable. Each was probed by running php -r "echo PHP_MAJOR_VERSION", not read off a folder name.` })
      : found.length
        ? h('div.field__hint', { text: `Nothing here is new enough. PocketMine-MP needs PHP ${min} or newer.` })
        : null
  );
}

/* ------------------------------- per server ----------------------------- */

function serverJavaPanel() {
  const plan = state.jvm.plan;
  const settings = state.settings;
  if (!plan.length) return h('div.empty', h('b', { text: 'No servers yet' }));

  return h('div.jvmlist', ...plan.map((row) => {
    const pinned = (settings.javaPerServer || {})[row.serverId] || '';
    const resolved = row.resolved;
    return h('div.jvmlist__row',
      h('span.jvmlist__id.truncate', { title: row.name, text: row.name }),
      h('span.jvmlist__need', { text: row.mcVersion ? `needs Java ${row.requiredMajor}` : 'no version' }),
      resolved ? badge(`Java ${resolved.major}`, resolved.match === 'exact' ? 'ok' : 'warn') : badge('unresolved', 'err'),
      resolved && resolved.match === 'newer' && resolved.risk ? badge('risky', 'warn') : null,
      h('span.grow.truncate', { style: { fontSize: '11px', color: 'var(--grey-5)' }, title: resolved?.javaExe || '', text: resolved?.javaExe || '' }),
      h('select.select.select--sm', {
        onChange: async (e) => { await window.env.java.assign(row.serverId, e.target.value); toast(e.target.value ? 'Pinned to that runtime' : 'Back to automatic matching', 'info'); await refreshJvmPlan(); await refreshDetail(); },
      }, h('option', { value: '', text: 'Auto', selected: !pinned }),
        ...state.jvm.runtimes.map((r) => h('option', { value: r.javaExe, text: `Java ${r.major}`, selected: r.javaExe === pinned })))
    );
  }));
}

/* ------------------------------- behaviour ------------------------------ */

function behaviourPanel() {
  const settings = state.settings;
  const argvInput = h('textarea.textarea', { value: settings.extraArgs || '', placeholder: '-XX:+UseStringDeduplication', spellcheck: false });
  argvInput.addEventListener('change', async () => { await saveSettings({ extraArgs: argvInput.value.trim() }); toast('JVM arguments saved', 'ok'); });

  const option = (value, text, selected) => h('option', { value: String(value), text, selected });

  return h('div.col', { style: { gap: '14px' } },
    h('div.switch-row', { style: { paddingTop: 0 } },
      h('div.switch-row__text',
        h('div.switch-row__title', { text: "Use Paper's recommended JVM flags" }),
        h('div.switch-row__desc', { text: 'The G1 garbage collector tuning Paper publishes for the release. Usually right.' })),
      switchBox(settings.useRecommendedFlags !== false, (next) => saveSettings({ useRecommendedFlags: next }))
    ),
    h('div.switch-row',
      h('div.switch-row__text',
        h('div.switch-row__title', { text: 'Keep running in the tray when the window is closed' }),
        h('div.switch-row__desc', { text: 'Downloads and servers keep going with the window hidden. Turn this off to quit instead.' })),
      switchBox(settings.trayOnClose !== false, (next) => saveSettings({ trayOnClose: next }))
    ),
    field('Extra JVM arguments', argvInput, 'Appended after the recommended flags and before -jar.'),
    field('Automatic world backups',
      h('select.select', { onChange: (e) => { const hours = Number(e.target.value) || 0; saveSettings({ autoBackupHours: hours }); toast(hours ? `A world backup every ${plural(hours, 'hour')} while a server is up` : 'Automatic backups off', 'ok'); } },
        ...[0, 1, 3, 6, 12, 24].map((n) => option(n, n ? `every ${n} ${n === 1 ? 'hour' : 'hours'}` : 'off', Number(settings.autoBackupHours) === n))),
      'A running server is saved first, then the world is zipped.'
    ),
    field('Backups kept per server',
      h('select.select', { onChange: (e) => saveSettings({ backupsKeep: Number(e.target.value) || 10 }) },
        ...[3, 5, 10, 20, 50].map((n) => option(n, `keep ${n}`, Number(settings.backupsKeep) === n)))
    ),
    field('Console history kept in memory',
      h('select.select', { onChange: (e) => saveSettings({ consoleLines: Number(e.target.value) || 2000 }) },
        ...[500, 1000, 2000, 5000, 10000].map((n) => option(n, `${n} lines`, Number(settings.consoleLines) === n)))
    )
  );
}

/* ------------------------------- command preview ------------------------ */

function commandPanel() {
  const record = activeServer();
  const box = h('div.preview', { text: record ? 'working out the command line...' : 'Select a server to see its command line.' });

  const load = async () => {
    if (!record) return;
    const res = await window.env.server.dryRun(record.id);
    if (!res?.ok) { box.textContent = res?.error || 'could not work out the command line'; return; }
    const notes = [];
    // each note is named in the software's own terms; "no jar installed" on a
    // Bedrock server would describe a file that does not exist
    const noun = runtimeNoun(record.type);
    if (!res.jar) notes.push(`(no ${noun} installed yet - start will refuse)`);
    if (!res.eula) notes.push('(the EULA has not been accepted yet - start will refuse)');
    if (res.runtimeMissing) {
      notes.push(
        res.runtimeKind === 'php'
          ? `(php.exe is a placeholder: no usable PHP was found - set one in the PHP panel above)`
          : `(java.exe is a placeholder: no usable JVM was found yet - one downloads on start)`
      );
    }
    if (res.risk) notes.push('(this JVM is newer than the release targets and may not work)');
    box.textContent = [`cwd: ${res.cwd}`, res.argv.join(' '), ...notes].join('\n');
  };

  load();

  return h('div', box, h('div.field__hint', { style: { marginTop: '10px' }, text: record ? 'Exactly what gets spawned. Copy it to run the same server from a plain terminal.' : 'Pick a server from the sidebar.' }));
}

/* ------------------------------- folders -------------------------------- */

function folderPanel() {
  const settings = state.settings;
  const input = h('input.input', { value: settings.serversDir || '', placeholder: state.serversRoot || 'inside the app data folder', spellcheck: false });
  const active = h('span.kv__v', { text: state.serversRoot || 'app data folder' });

  const apply = async (dir) => {
    input.value = dir;
    const res = await saveSettings({ serversDir: dir });
    if (res && res.ok === false) return toast(res.error || 'could not use that folder', 'err');
    active.textContent = dir || 'app data folder';
    toast('Server folder saved', 'ok');
  };

  return h('div.col', { style: { gap: '14px' } },
    field('Server folders',
      h('div.pathbox', input,
        h('button.btn.btn--sm', { type: 'button', onClick: () => apply(input.value.trim()) }, 'Save'),
        h('button.btn.btn--sm.btn--ghost', { type: 'button', onClick: async () => { const res = await window.env.shell.pickDirectory(); if (!res?.ok || res.cancelled) return; await apply(res.dir); } }, 'Browse'),
        h('button.btn.btn--sm.btn--ghost', { type: 'button', onClick: () => apply('') }, 'Reset')
      )
    ),
    h('div.kv', h('span.kv__k', { text: 'In use' }), active),
    h('div.kv', h('span.kv__k', { text: 'App data' }), h('span.kv__v', { text: state.dataDir || '-' })),
    h('div.row.row--wrap',
      h('button.btn.btn--sm.btn--ghost', { type: 'button', onClick: () => window.env.shell.revealDataDir() }, icon('folder'), 'Open app data'),
      activeServer() ? h('button.btn.btn--sm.btn--ghost', { type: 'button', onClick: () => window.env.servers.openFolder(activeServer().id) }, icon('folder'), 'Open server folder') : null),
    h('div.field__hint', { text: 'Point this at another drive before creating a big world. Worlds and plugins are plain files, so moving one means copying its folder.' })
  );
}

/* -------------------------------- servers ------------------------------- */

function serversPanel() {
  return h('div.col', { style: { gap: '8px' } },
    state.servers.length
      ? h('div.col', { style: { gap: '7px' } }, ...state.servers.map((s) =>
          h('div.checkline',
            h('div.checkline__name', h('span', { text: s.name }), h('div.checkline__uuid', { text: s.mcVersion ? `${s.mcVersion} - port ${s.port} - ${megabytesToText(s.memory.max)}` : 'no Minecraft version set' })),
            s.jarInstalled ? iconBadge('check', 'jar', 'ok') : badge('no jar', 'warn'),
            h('button.btn.btn--sm.btn--ghost', { type: 'button', onClick: () => window.env.servers.openFolder(s.id) }, icon('folder'), 'Folder'),
            h('button.btn.btn--sm.btn--ghost', { type: 'button', onClick: async () => {
              const ok = await confirmBox({ title: 'Remove this server', message: `"${s.name}" is removed from this list. Its folder - world, plugins, logs - is left on disk, so nothing is lost.`, confirmText: 'Remove', danger: true });
              if (!ok) return;
              const ok2 = await deleteServer(s.id);
              if (!ok2) return;
            } }, icon('trash')))
        ))
      : h('div.empty', { style: { padding: '22px' }, text: 'No servers yet. Create one from the dashboard.' }),
    h('button.btn.btn--sm', { type: 'button', disabled: !state.versions.list.length, onClick: async () => {
      await createServer({ name: `ENV#${state.servers.length + 1}`, mcVersion: state.versions.list[0] || '', memory: suggestMemory(state.settings.totalMemoryMb) });
    } }, icon('plus'), 'Add another server'),
    h('div.field__hint', { text: 'Removing a server from this list never deletes its folder.' })
  );
}

/* --------------------------------- render ------------------------------- */

export function renderSettings(host) {
  const settings = state.settings;

  return mount(
    host,
    h('div.settings',
      h('div.section',
        h('div.section__head', h('div.section__title', icon('cpu'), 'Memory'), h('div.section__line')),
        h('div.grid.grid--2',
          panel('Memory', 'cpu', memoryPanel(), 'memory'),
          panel('Java runtime', 'cpu', javaPanel(), 'java')
        )
      ),
      h('div.section',
        h('div.section__head', h('div.section__title', icon('layers'), 'Per server'), h('div.section__line')),
        h('div.grid.grid--2',
          panel('Java per server', 'layers', serverJavaPanel()),
          panel('Runtime behaviour', 'gear', behaviourPanel())
        )
      ),
      h('div.section',
        h('div.section__head', h('div.section__title', icon('folder'), 'Folders'), h('div.section__line')),
        h('div.grid.grid--2',
          panel('Folders', 'folder', folderPanel()),
          panel('Command preview', 'terminal', commandPanel())
        )
      ),
      h('div.section',
        h('div.section__head', h('div.section__title', icon('server'), 'Servers'), h('div.section__line')),
        h('div.grid.grid--2',
          panel('Servers', 'server', serversPanel()),
          panel('This machine', 'info',
            h('div',
              h('div.kv', h('span.kv__k', { text: 'Installed RAM' }), h('span.kv__v', { text: megabytesToText(settings.totalMemoryMb) })),
              h('div.kv', h('span.kv__k', { text: 'Java runtimes found' }), h('span.kv__v', { text: String(state.jvm.runtimes.length) })),
              // PHP only appears when a PocketMine server exists, so this row is
              // conditional rather than showing "0" on a machine that never asked
              state.servers.some((s) => s.type === 'pocketmine')
                ? h('div.kv', h('span.kv__k', { text: 'PHP runtimes found' }), h('span.kv__v', { text: String((state.runtime.php || []).length) }))
                : null,
              h('div.kv', h('span.kv__k', { text: 'Downloaded here' }), h('span.kv__v', { text: (state.jvm.bundled || []).join(', ') || 'none' })),
              h('div.kv', h('span.kv__k', { text: 'Servers' }), h('span.kv__v', { text: String(state.servers.length) })),
              h('div.kv', h('span.kv__k', { text: 'EnvServer' }), h('span.kv__v', { text: state.appVersion || 'unknown' }))
            ),
            state.jvm.loading ? badge('scanning', 'warn') : null
          )
        )
      ),
      // only rendered when a PocketMine server exists - see phpPanel()
      state.servers.some((s) => s.type === 'pocketmine')
        ? h('div.section',
            h('div.section__head', h('div.section__title', icon('cpu'), 'PHP runtime'), h('div.section__line')),
            h('div.grid.grid--2', panel('PHP for PocketMine-MP', 'cpu', phpPanel()))
          )
        : null,
      h('div.row', { style: { marginTop: '18px' } },
        h('button.btn', { type: 'button', onClick: async () => { await refreshJvmPlan(); await refreshDetail(); toast('Rescanned', 'ok'); } }, icon('refresh'), 'Rescan Java runtimes')),
      h('div.field__hint', { style: { marginTop: '18px' } },
        'EnvServer is not affiliated with Mojang or Microsoft. Minecraft is a trademark of Mojang AB. Paper builds come from papermc.io; Java runtimes from the Eclipse Adoptium project.')
    )
  );
}

/** The head-bar buttons for this view. */
export function settingsActions() {
  return [
    h('button.btn.btn--sm', { type: 'button', onClick: async () => { await refreshJvmPlan(); await refreshDetail(); toast('Rescanned Java runtimes', 'ok'); } }, icon('refresh'), 'Rescan Java'),
  ];
}

export { loader };
