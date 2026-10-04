/**
 * Server software.
 *
 * One table, so the create form, the Versions view and the background jobs can
 * never disagree about what "Folia" means or which API answers for it.
 *
 *   `source`  which catalogue the Minecraft version list comes from
 *             paper | folia | purpur | vanilla
 *   `auto`    true when EnvServer downloads the jar itself; false when the
 *             jar has to be supplied by hand (Spigot and CraftBukkit publish
 *             no public download API, so the versions listed are still the
 *             right ones to record - only the jar is the user's problem)
 *   `project` the fill.papermc.io project id, when the software uses it
 *   `caps`    what the software can actually do. The UI hides the parts of
 *             itself a server cannot use: the official Mojang jar has no plugin
 *             loader, so offering a Plugins tab for it would be a dead end.
 */

/** @type {Array<{id:string,label:string,source:string,auto:boolean,project?:string,caps:string[],note:string,home?:string}>} */
export const SOFTWARE = [
  {
    id: 'paper',
    label: 'PaperMC',
    source: 'paper',
    project: 'paper',
    auto: true,
    caps: ['plugins'],
    note: 'The most popular fork. Best plugin support, best performance.',
  },
  {
    id: 'folia',
    label: 'Folia',
    source: 'folia',
    project: 'folia',
    auto: true,
    caps: ['plugins'],
    note: 'Paper rebuilt with region threading, for hundreds of players at once. Fewer plugins work on it.',
  },
  {
    id: 'purpur',
    label: 'Purpur',
    source: 'purpur',
    auto: true,
    caps: ['plugins'],
    note: 'A Paper fork with extra configuration and more versions of some features. Plugins work exactly as they do on Paper.',
  },
  {
    id: 'vanilla',
    label: 'Vanilla (Mojang)',
    source: 'vanilla',
    auto: true,
    // no plugin loader in the official jar - the tab is hidden, not disabled
    caps: [],
    note: 'The official Mojang server. No plugins, no mods - exactly what Mojang ships.',
  },
  {
    id: 'spigot',
    label: 'Spigot',
    source: 'paper',
    auto: false,
    caps: ['plugins'],
    note: 'Spigot has no public download API, so you bring your own Spigot.jar. The version is still recorded so the right Java is chosen.',
    home: 'https://www.spigotmc.org/downloads/',
  },
  {
    id: 'bukkit',
    label: 'CraftBukkit',
    source: 'paper',
    auto: false,
    caps: ['plugins'],
    note: 'CraftBukkit has no public download API either - drop your own CraftBukkit.jar into the server folder.',
    home: 'https://bukkit.org/downloads/craftbukkit/',
  },
  {
    id: 'custom',
    label: 'Custom JAR',
    source: 'paper',
    auto: false,
    caps: ['plugins'],
    note: 'Any server jar you already have: a plugin, a modpack launcher, a fork nobody has heard of.',
  },
];

const BY_ID = new Map(SOFTWARE.map((s) => [s.id, s]));

/** Look up a software entry; unknown ids fall back to Paper rather than crashing. */
export function softwareById(id) {
  return BY_ID.get(String(id || '').toLowerCase()) || BY_ID.get('paper');
}

/** The name to show in the UI. */
export function softwareLabel(id) {
  return softwareById(id).label;
}

/** `true` when EnvServer downloads the jar for this software. */
export function softwareIsAutomatic(id) {
  return Boolean(softwareById(id).auto);
}

/** The catalogue key for a software id. */
export function softwareSource(id) {
  return softwareById(id).source;
}

/**
 * Whether a piece of software can do something at all.
 *
 * The one that matters today is `plugins`: the official Mojang jar has no plugin
 * loader, so a vanilla server gets no Plugins tab at all rather than a tab that
 * could only ever say "this will not work".
 */
export function softwareSupports(id, capability) {
  return softwareById(id).caps.includes(capability);
}