# EnvServer

A Minecraft server manager for Windows. It runs the server locally, in a folder on
your own machine, from a single `.exe` - and it picks the right Java version for the
Minecraft version you chose, downloading it if you do not have it.

PaperMC, Folia, Purpur, Vanilla, Spigot, CraftBukkit, or any jar you already have.

![EnvServer dashboard](docs/screenshots/dashboard.png)

## What it does

- **Runs the server locally** - one folder per server, with the world, plugins, logs
  and config where you would expect them. Nothing is uploaded, no account to make.
- **Seven kinds of server software** - PaperMC, Folia, Purpur, Vanilla (Mojang),
  Spigot, CraftBukkit and Custom JAR. The version list is complete for each, and the
  UI adapts to what the software can actually do: a vanilla server has no Plugins tab
  because the official jar has no plugin loader.
- **Installs in the background** - a 50 MB jar or a 200 MB JDK never blocks the UI.
  The sidebar shows every job with real progress, you can browse other views while
  it downloads, and closing the window hides to the tray so the work continues.
- **Matches Java to the release** - see below. It downloads Eclipse Temurin if you do
  not have a suitable runtime.
- **Live console** - real stdout/stderr coloured by severity, plus a command box with
  one-click shortcuts for `list`, `say`, `tps`, `whitelist on` and the rest.
- **Server config** - `server.properties` edited with real controls, plus the EULA,
  the whitelist, the ops list and the ban list - all updating live.
- **Plugins** - add jars from Explorer, see what is there, remove them.
- **Backups** - zip the world on demand or on a timer while a server is up. A running
  server is `save-off`'d first so the archive is never half-written.
- **Updates, and going back** - the button next to the window controls checks GitHub
  for a newer release and offers to install it, or to reinstall an older version.
  Your servers and settings are never in the application folder, so neither can lose
  them.
- **Status** - player list, uptime, the actual JVM heap usage, and the server MOTD read
  from a genuine Server List Ping rather than guessed from the log.

## Screenshots

| | |
| --- | --- |
| ![Welcome](docs/screenshots/welcome.png) | ![New server](docs/screenshots/new-server.png) |
| The first-run screen. It asks where server folders should live, and nothing else. | Creating a server: a name, the software, and the full Minecraft version list for it. Memory is worked out from the machine, not guessed at. |
| ![Console](docs/screenshots/console.png) | ![Config](docs/screenshots/config.png) |
| The console is the real process output, coloured by severity, with a command box. | `server.properties`, the EULA, and the whitelist/ops/ban lists - which update while the server runs. |
| ![Versions](docs/screenshots/versions.png) | ![Settings](docs/screenshots/settings.png) |
| Every build of the server's own software, per Minecraft version. | Memory, Java runtimes, folders, backups and the per-server overrides. |

## About memory

**`-Xmx` is a ceiling on the JVM heap, and nothing else.** A server set to 512 MB
will still show 700-900 MB in Task Manager, and that is correct: metaspace, the code
cache, one stack per thread and Paper's off-heap network buffers all live outside the
heap and are counted against the process. Nothing is being ignored.

So EnvServer reads the heap itself. Where the runtime ships `jcmd` (any JDK, which is
what it downloads), the dashboard shows **heap used against the heap ceiling** and
keeps the process total as a separate number with an explanation. It never labels the
process total "max".

New servers are sized from the machine - about half the installed RAM on a clean step.
If you set a ceiling this machine cannot honour, the dashboard and Settings say so
instead of leaving the machine to thrash its pagefile.

## Updates, and going back

The button immediately left of the window controls opens a small panel that answers
two questions:

- **Is there a newer release?** It asks `api.github.com` for the releases, with a
  six-hour disk cache so it works offline and does not hammer GitHub. A dot appears on
  the button when there is one. Nothing is ever downloaded or installed without a
  click on it - an app that restarts its own UI uninvited is not a surprise worth
  shipping.

- **Can I go back?** Every launch records the version that ran, so the panel can offer
  to reinstall a build that used to work here - including ones no longer published.
  It downloads that release's own installer and runs it. There is no in-place patching
  and no self-repair: rewriting `app.asar` under a running Electron produces a program
  that only fails on the next launch.

**Your servers and settings cannot be lost by either.** They live in

```
%APPDATA%\envserver\data\
  servers\      one folder per server: world, plugins, logs, config
  runtime\      JDKs EnvServer downloaded
  backups\
  cache\
```

which is outside the install folder, and the panel shows you that path rather than
just asserting it. Updating replaces `EnvServer.exe` and `resources\app.asar`; it does
not touch the data folder. Only the app itself is ever replaced.

Versions follow `major.minor.patch`, and the tag on the release is the source of truth
for what is available.

## Java matching per Minecraft version

A Paper jar is compiled to a specific class-file version, so the JVM has to be the
one that release targets:

| Minecraft      | Java |
| -------------- | ---- |
| 1.13 - 1.16.5  | 8    |
| 1.17 - 1.17.1  | 16   |
| 1.18 - 1.20.4  | 17   |
| 1.20.5+        | 21   |
| 26.x and newer | 25   |

EnvServer asks the Paper API for the real number (`java.version.minimum`) and only
falls back to the table when the API cannot be reached. Two things follow:

- **Every candidate is probed with `java -version`.** A folder called `jdk-17` can
  contain Java 11, so the folder name is never trusted.
- **Selection order** is the exact feature version first, then the *smallest* runtime
  above it, then nothing. An older JVM cannot load the class files at all, so
  EnvServer refuses with a specific message instead of starting a JVM that is going
  to die.

Resolution is **pin -> global override -> automatic**, and the per-server panel says
out loud which runtime won and whether it is an exact or a forward-compatible match.
If nothing suitable is installed it is **downloaded automatically on start** - you
never have to go looking for a JDK.

## Run it

```bash
npm install
npm run assets     # generate the icon and icon.ico (already committed)
npm start          # launch
npm start -- --dev # launch with devtools
```

## Verify it

```bash
npm test           # syntax + module/bridge graph + 58 unit tests, no network
npm run smoke      # boots the real app, renders every view, hit-tests the chrome
npm run e2e        # downloads a JDK and a real server jar, starts it, pings it
npm run shot       # screenshot the running app to shot.png
```

The three layers exist because each catches a different class of bug:

| Command        | Catches                                                                 |
| -------------- | ----------------------------------------------------------------------- |
| `npm test`     | logic. Java matching, the zip reader/writer, property parsing, varint framing, log classification, settings validation, and every import/export/bridge seam. |
| `npm run smoke`| the app itself. Every view rendered in a real Electron window, every nav item clicked, the console painted, nothing invisible covering the UI, zero renderer errors. |
| `npm run e2e`  | integration. A real JVM, a real world, a real status ping.               |

`npm run e2e` needs the network and about 300 MB of disk:

```bash
npm run e2e -- 1.16.5      # the Java 8 branch
npm run e2e -- 1.21.4      # the Java 21 branch
npm run e2e -- 26.3        # the Java 25 branch
```

### A note on `node --check`

`node --check file.js` parses a `.js` file in **CommonJS** goal, so an ES module
with an unbalanced bracket passes and exits `0`. That is not theoretical: it hid a
real syntax error in `ui/overlay.js` through an entire review pass, and only booting
the app caught it. `tools/syntax.js` works around it by checking renderer files
through a `.mjs` copy, and `npm test` runs it first.

## Build a Windows .exe

```bash
npm run dist       # NSIS installer + portable exe, output in release/
```

## Layout

```
src/
  main/
    main.js          window lifecycle, tray, dev flags, the smoke test
    preload.js       contextBridge (contextIsolation on, nodeIntegration off)
    ipc.js           the entire privileged surface + the background job registry
    store.js         settings + the server registry, re-validated on every load
    services/
      paths.js       on-disk layout, and path-segment rejection
      net.js         fetch + JSON, resumable download with SHA-256
      paper.js       the v3 Paper API at fill.papermc.io, with a disk cache
      purpur.js      the Purpur API at api.purpurmc.org
      vanilla.js     piston-meta.mojang.com
      updater.js     GitHub releases: check, install, and which versions ran here
      java.js        runtime discovery, per-version matching, Temurin download
      server.js      the JVM process: command line, spawn, console, monitor
      config.js      server.properties, eula, ops/whitelist/bans, plugins
      ping.js        the Minecraft Server List Ping protocol
      mojang.js      public profile lookup, for real whitelist UUIDs
      zip.js         zip reader + writer with no dependency
  renderer/
    index.html
    styles/          base.css (tokens, chrome) ui.css (kit) views.css (layouts)
                    theme.css (the skin; loaded last, overrides the other three)
                    updates.css (the popover under the titlebar button)
    js/
      app.js         bootstrap, router, sidebar, event bridge
      state.js       one store, subscribe/emit
      software.js    the software table: what exists, and what each can do
      jobs.js        background downloads: progress, cancel, tray awareness
      actions.js     the foreground flows (start, stop, EULA, plugins, memory)
      icons.js       inline SVG icon set
      dom.js         hyperscript helper (h) + the loader
      fmt.js         bytes / dates / durations
      ui/            toast, overlay, confirm, welcome, updates panel
      views/         dashboard, console, config, versions, plugins, settings, about
    assets/          generated: icon-32/48/64/128/256.png, icon.ico
docs/
  screenshots/    the images used above, produced by `npm run docs`
tools/
  syntax.js    ESM-aware syntax check
  graph.js     imports, exports and the preload <-> ipc contract
  test.js      unit tests
  e2e.js       end-to-end against a real server
  gen-assets.js  procedural icon generator
  shots.js     capture the README screenshots into docs/screenshots
  probe*.js    layout/behaviour probes, run with `electron . --probe=tools/probe.js`
```

## Architecture notes

**Everything talks to IPC, never to the DOM.** The renderer only knows about
`window.env` (see `preload.js`). That is the seam where every Paper, Adoptium and
Mojang call lives, and the reason the UI can be tested without any of it.

**`tools/graph.js` checks the seams a syntax check cannot.** It executes
`preload.js` against a stub electron to get the real exposed surface, then verifies
that every renderer call exists, every exposed method is called by *something*, and
every channel has a handler in both directions. Renaming a bridge method is
otherwise a silent runtime failure.

**Downloads are jobs, not modals.** `jobs.js` registers a job before the IPC call,
routes `evt:download` by `jobId`, and reports the result as a toast. That is what
makes 200 MB of JDK survivable: you can switch servers, browse versions, or close
the window to the tray while it downloads.

**Render discipline.** The store emits one change event and views rebuild wholesale,
except where a view has live input or a live stream:

- RAM sliders update only their label on `input` and persist on `change`.
  Re-rendering mid-drag would yank the slider out from under the cursor.
- The console does **not** re-render for log lines. `evt:log` fires many times a
  second, and a rebuild would reset the scroll position and destroy the command box.
- `server.properties` inputs never re-render, which is why they save on a 450 ms
  debounce instead of on every keystroke.
- The Config panel writes only the keys it was given, so the dozen settings this app
  does not model survive a round trip untouched.

Never call `saveSettings()` from inside a render function - emitting during render
re-enters the render.

**A throwing view must not take the app down.** `renderBody()` catches and shows the
message with a retry, and the boot-failure screen is closable. The old version
installed a full-window overlay that could not be dismissed.

**No dependency is pulled in for zip.** A Temurin JDK archive is ~25 000 entries, so
`zip.js` streams: it inflates one entry at a time when reading, and uses data
descriptors when writing so the CRC and sizes need not be known in advance. Every
entry name is checked so a crafted archive cannot escape the target directory.

## Deliberately not included

- **No bundled Mojang assets.** The app icon and every UI icon are generated or
  authored here. Shipping Mojang's textures, sounds or fonts inside a
  redistributable `.exe` is not something this project will do.
- **No Fabric or NeoForge loader support.** Those need their own profile endpoints
  and library resolution.
- **No world or player editing.** Worlds are the server's own files; opening them in
  an editor while a server runs corrupts them. Backups and a folder button, yes.
- **No router configuration.** Opening a port on a router is a browser action, not a
  file one.
- **Removing a server never deletes its folder.** A world is not recoverable if it is
  deleted because a row was removed from a list.

## Legal

Not affiliated with Mojang or Microsoft. Minecraft is a trademark of Mojang AB.
Paper is built by the PaperMC project. Java runtimes are Eclipse Temurin from the
Adoptium project. No Mojang assets are redistributed by this project.