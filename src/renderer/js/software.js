/**
 * Server software.
 *
 * One table, so the create form, the Versions view and the background jobs can
 * never disagree about what "Folia" means or which API answers for it.
 *
 *   `source`  which catalogue the Minecraft version list comes from. Identical
 *             to the software id for the ones with a real API; Spigot,
 *             CraftBukkit and Custom JAR read Paper's *list* because that is
 *             still the right set of Minecraft versions to record, but never
 *             download from it.
 *   `auto`    true when EnvServer downloads the files itself; false when they
 *             have to be supplied by hand (Spigot and CraftBukkit publish no
 *             public download API, so the versions listed are still the right
 *             ones to record - only the files are the user's problem)
 *   `project` the fill.papermc.io project id, when the software uses it
 *   `runtime` what actually runs it: 'java', 'php' or 'none'. Mirrored by
 *             src/main/services/runtime.js - the test asserts both tables cover
 *             the same ids, because a runtime with no entry here would be
 *             software nobody can create and an entry here with no runtime would
 *             be software that cannot start.
 *   `port`    the port it listens on. 25565 for Java, 19132 for Bedrock, and
 *             getting this wrong means the server runs and nobody can join.
 *   `entry`   the file inside the server folder that actually runs. Mirrors
 *             `runtime.entry` in main; the test asserts the two agree, because
 *             the UI says this name when it talks about installing and removing.
 *   `caps`    what the software can actually do. The UI hides the parts of
 *             itself a server cannot use: the official Mojang jar has no plugin
 *             loader, so offering a Plugins tab for it would be a dead end.
 */

/** @type {Array<{id:string,label:string,entry:string,source:string,auto:boolean,runtime:string,port:number,project?:string,caps:string[],note:string,home?:string}>} */
export const SOFTWARE = [
  {
    id: 'paper',
    label: 'PaperMC',
    entry: 'paper.jar',
    source: 'paper',
    project: 'paper',
    auto: true,
    runtime: 'java',
    port: 25565,
    caps: ['plugins'],
    note: 'The most popular fork. Best plugin support, best performance.',
  },
  {
    id: 'folia',
    label: 'Folia',
    entry: 'paper.jar',
    source: 'folia',
    project: 'folia',
    auto: true,
    runtime: 'java',
    port: 25565,
    caps: ['plugins'],
    note: 'Paper rebuilt with region threading, for hundreds of players at once. Fewer plugins work on it.',
  },
  {
    id: 'purpur',
    label: 'Purpur',
    entry: 'paper.jar',
    source: 'purpur',
    auto: true,
    runtime: 'java',
    port: 25565,
    caps: ['plugins'],
    note: 'A Paper fork with extra configuration and more versions of some features. Plugins work exactly as they do on Paper.',
  },
  {
    id: 'vanilla',
    label: 'Vanilla (Mojang)',
    entry: 'paper.jar',
    source: 'vanilla',
    auto: true,
    runtime: 'java',
    port: 25565,
    // no plugin loader in the official jar - the tab is hidden, not disabled
    caps: [],
    note: 'The official Mojang server. No plugins, no mods - exactly what Mojang ships.',
  },
  {
    id: 'spigot',
    label: 'Spigot',
    entry: 'paper.jar',
    source: 'paper',
    auto: false,
    runtime: 'java',
    port: 25565,
    caps: ['plugins'],
    note: 'Spigot has no public download API, so you bring your own Spigot.jar. The version is still recorded so the right Java is chosen.',
    home: 'https://www.spigotmc.org/downloads/',
  },
  {
    id: 'bukkit',
    label: 'CraftBukkit',
    entry: 'paper.jar',
    source: 'paper',
    auto: false,
    runtime: 'java',
    port: 25565,
    caps: ['plugins'],
    note: 'CraftBukkit has no public download API either - drop your own CraftBukkit.jar into the server folder.',
    home: 'https://bukkit.org/downloads/craftbukkit/',
  },
  {
    id: 'custom',
    label: 'Custom JAR',
    entry: 'paper.jar',
    source: 'paper',
    auto: false,
    runtime: 'java',
    port: 25565,
    caps: ['plugins'],
    note: 'Any server jar you already have: a plugin, a modpack launcher, a fork nobody has heard of.',
  },

  /* ------------------------------- Bedrock ------------------------------- */

  {
    id: 'bedrock',
    label: 'Bedrock Dedicated Server',
    entry: 'bedrock_server.exe',
    source: 'bedrock',
    auto: true,
    // a native binary, not a JVM: EnvServer downloads Mojang's zip and runs
    // bedrock_server.exe directly, so there is no Java step at all
    runtime: 'none',
    port: 19132,
    // Mojang's server has no plugin loader and no mod loader
    caps: [],
    note: "Mojang's own Bedrock server, downloaded and unpacked for you. No Java involved - it is a native Windows program. Needs Windows 10 or newer.",
    home: 'https://www.minecraft.net/en-us/download/server/bedrock',
  },
  {
    id: 'pocketmine',
    label: 'PocketMine-MP',
    entry: 'PocketMine-MP.phar',
    source: 'pocketmine',
    auto: true,
    // PocketMine is PHP, so this needs PHP 8.1+ on the machine rather than a
    // JDK. EnvServer finds it and tells you what it found; it will not install
    // PHP for you, because the Windows builds are not redistributable under one
    // licence.
    runtime: 'php',
    port: 19132,
    // PocketMine plugins are .phar files with a different API, so the Java
    // plugin manager would be a dead end rather than a near miss
    caps: [],
    note: 'The most active Bedrock server software. Written in PHP, so it needs PHP 8.1 or newer installed - EnvServer finds it, or tells you how to point at it.',
    home: 'https://pmmp.io',
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

/** `true` when EnvServer downloads the files for this software. */
export function softwareIsAutomatic(id) {
  return Boolean(softwareById(id).auto);
}

/** The catalogue key for a software id. */
export function softwareSource(id) {
  return softwareById(id).source;
}

/** What runs it: 'java' | 'php' | 'none'. The renderer's copy of runtime.js. */
export function softwareRuntime(id) {
  return softwareById(id).runtime;
}

/**
 * The file inside the server folder that this software runs.
 *
 * The renderer's copy of `runtime.entry`, kept in step by a unit test that
 * asserts the two tables agree on every id - so "Remove jar" on a Bedrock server
 * can say `bedrock_server.exe` without the renderer importing main.
 */
export function runtimeEntry(id) {
  return softwareById(id).entry || 'paper.jar';
}

/**
 * How to refer to that file in a sentence.
 *
 * "jar" for Java software, "phar" for PocketMine, and for Mojang's Bedrock
 * server the honest answer is "server files": it is not one file, it is a
 * directory of native binaries unpacked from a zip.
 */
export function runtimeNoun(id) {
  const rt = softwareRuntime(id);
  if (rt === 'none') return 'server files';
  if (rt === 'php') return 'phar';
  return 'jar';
}

/** `true` when this software needs a JVM. A Bedrock server must never be told to install one. */
export function softwareNeedsJava(id) {
  return softwareRuntime(id) === 'java';
}

/**
 * The port this software listens on.
 *
 * 19132 for Bedrock, not 25565. This is the single most consequential difference
 * between Java and Bedrock servers and it is invisible until somebody tries to
 * join and cannot.
 */
export function softwarePort(id) {
  return softwareById(id).port || 25565;
}

/** `true` for the Bedrock software, used to group them in the create form. */
export function softwareIsBedrock(id) {
  return softwareRuntime(id) !== 'java';
}

/**
 * Whether a piece of software can do something at all.
 *
 * `plugins` is the one that matters today: the official Mojang jar has no plugin
 * loader, Mojang's Bedrock server has no plugin system at all, and PocketMine's
 * plugins are a different format entirely, so all three get no Plugins tab
 * rather than a tab that could only ever say "this will not work".
 */
export function softwareSupports(id, capability) {
  return softwareById(id).caps.includes(capability);
}