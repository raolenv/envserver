'use strict';

/**
 * Static consistency checks that a syntax check cannot do:
 *
 *  1. every relative `import` in the renderer resolves to a real file
 *  2. every named import exists as an export in the target module
 *  3. every `window.env.<ns>.<fn>` the renderer calls is really exposed
 *  4. every channel preload invokes has a matching ipcMain handler
 *
 * These are the seams where a rename in one file silently breaks another. All are
 * invisible to `node --check`: the symptom is a blank screen or a silent
 * "Error invoking remote method" at runtime.
 *
 * Check 3 does not parse preload.js by hand - it *executes* preload.js against a
 * stub electron module and inspects the real object it exposed. A hand-rolled
 * parse of a nested object literal is exactly the kind of thing that reports
 * fifty false failures.
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const problems = [];

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'release', 'dist'].includes(entry.name)) continue;
      walk(full, out);
    } else if (entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(path.join(ROOT, 'src'));

/* =============== execute preload.js against a stub electron =============== */

/** @type {{exposed:object}} */
const loaded = { exposed: {} };

(function loadPreload() {
  const electronStub = {
    contextBridge: {
      exposeInMainWorld(name, api) {
        loaded.exposed = api;
      },
    },
    ipcRenderer: {
      // never called: preload's bridge methods are lazy, so the channel list has
      // to come from the source rather than from executing it
      invoke: () => Promise.resolve({ __stub: true }),
      send: () => {},
      on: () => {},
      removeListener: () => {},
    },
  };

  // preload.js does `require('electron')`; intercept just that specifier
  const original = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (request === 'electron') return electronStub;
    return original.call(this, request, parent, isMain);
  };

  try {
    const preload = path.join(ROOT, 'src', 'main', 'preload.js');
    delete require.cache[require.resolve(preload)];
    require(preload);
  } finally {
    Module._load = original;
  }
})();

if (!loaded.exposed || typeof loaded.exposed !== 'object') {
  console.error('graph: preload.js did not expose anything - cannot continue');
  process.exit(1);
}

/** `ns.fn` -> true, and the set of every exposed method path. */
const exposedPaths = new Set();
for (const [ns, api] of Object.entries(loaded.exposed)) {
  if (api && typeof api === 'object') {
    for (const fn of Object.keys(api)) exposedPaths.add(`${ns}.${fn}`);
  } else if (typeof api === 'function') {
    exposedPaths.add(ns);
  }
}

/* ======================= 1 + 2: renderer imports ========================= */

function cjsExports(file) {
  const src = fs.readFileSync(file, 'utf8');
  const names = new Set();
  const block = /module\.exports\s*=\s*\{([\s\S]*?)\n\};/.exec(src);
  if (block) {
    for (const line of block[1].split('\n')) {
      const m = /^\s*([A-Za-z_$][\w$]*)\s*(?:,|:|$)/.exec(line);
      if (m) names.add(m[1]);
    }
  }
  for (const m of src.matchAll(/module\.exports\.([A-Za-z_$][\w$]*)\s*=/g)) names.add(m[1]);
  const direct = /module\.exports\s*=\s*([A-Za-z_$][\w$]*)\s*;/.exec(src);
  if (direct) names.add(direct[1]);
  return names;
}

function esExports(file) {
  const src = fs.readFileSync(file, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim().split(/\s+as\s+/).pop().trim();
      if (t) names.add(t);
    }
  }
  if (/export\s+default/.test(src)) names.add('default');
  return names;
}

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const isRenderer = file.includes(`${path.sep}renderer${path.sep}`);

  if (isRenderer && /\brequire\s*\(/.test(src)) {
    problems.push(`${rel(file)}: uses require() - the renderer is contextIsolated and has no node`);
  }

  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
    const names = m[1]
      .split(',')
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    const spec = m[2];
    if (!spec.startsWith('.')) continue;

    const target = path.resolve(path.dirname(file), spec);
    if (!fs.existsSync(target)) {
      problems.push(`${rel(file)}: import '${spec}' does not exist`);
      continue;
    }

    const exported = isRenderer ? esExports(target) : cjsExports(target);
    for (const name of names) {
      if (!exported.has(name)) problems.push(`${rel(file)}: '${name}' is not exported by ${rel(target)}`);
    }
  }

  for (const m of src.matchAll(/import\(\s*'([^']+)'\s*\)/g)) {
    if (!m[1].startsWith('.')) continue;
    const target = path.resolve(path.dirname(file), m[1]);
    if (!fs.existsSync(target)) problems.push(`${rel(file)}: dynamic import '${m[1]}' does not exist`);
  }
}

/* ================= 3: renderer calls exist on window.env ================== */

let rendererCalls = 0;
for (const file of files) {
  if (!file.includes(`${path.sep}renderer${path.sep}`)) continue;
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/window\.env\.([A-Za-z_$][\w$]*)(?:\s*\.\s*([A-Za-z_$][\w$]*))?/g)) {
    const key = m[2] ? `${m[1]}.${m[2]}` : m[1];
    rendererCalls++;
    if (!exposedPaths.has(key)) problems.push(`${rel(file)}: window.env.${key} is not exposed by preload.js`);
  }
}

/* ================ 4: every invoked channel has a handler ================== */

const preloadSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'preload.js'), 'utf8');

// preload's bridge methods are lazy arrow functions, so executing it does not
// reveal which channels they reach; read them out of the source instead
const called = new Set();
for (const m of preloadSrc.matchAll(/ipcRenderer\.(?:invoke|send)\(\s*'([^']+)'/g)) called.add(m[1]);

const handled = new Set();
for (const name of ['ipc.js', 'main.js']) {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', name), 'utf8');
  for (const m of src.matchAll(/(?:handle|ipcMain\.(?:handle|on))\(\s*'([^']+)'/g)) handled.add(m[1]);
}

for (const c of called) {
  if (!handled.has(c)) problems.push(`preload invokes '${c}' but nothing handles it`);
}

/* ========== 5: dead code on both sides of the bridge ==================== */

// a handler nothing calls is dead surface area: it still has to be maintained
for (const c of handled) {
  if (c.startsWith('window:')) continue;
  if (!called.has(c)) problems.push(`handler '${c}' is registered but no preload method calls it`);
}

// a preload method the renderer never calls is a rename waiting to break
const usedPaths = new Set();
for (const file of files) {
  if (!file.includes(`${path.sep}renderer${path.sep}`)) continue;
  const src = fs.readFileSync(file, 'utf8');
  // `window.env.ns.fn` and the bare event hooks `window.env.onLog`; whitespace
  // around the dots is allowed because a chained call is often wrapped
  for (const m of src.matchAll(/window\.env\.([A-Za-z_$][\w$]*)(?:\s*\.\s*([A-Za-z_$][\w$]*))?/g)) {
    usedPaths.add(m[2] ? `${m[1]}.${m[2]}` : m[1]);
  }
}
for (const p of exposedPaths) {
  if (!usedPaths.has(p)) problems.push(`preload exposes window.env.${p} but the renderer never calls it`);
}

/* ================================ report ================================== */

if (!problems.length) {
  console.log(
    `graph: ok - ${files.length} files, ${rendererCalls} bridge calls, ` +
      `${exposedPaths.size} exposed methods, ${handled.size} channels`
  );
  process.exit(0);
}

console.log(`graph: ${problems.length} problem(s)\n`);
for (const p of problems) console.log(`  ${p}`);
process.exit(1);