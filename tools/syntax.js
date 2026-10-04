'use strict';

/**
 * Syntax check that actually works for this codebase.
 *
 * `node --check foo.js` parses a `.js` file in **CommonJS** goal, so an ES module
 * with an unbalanced bracket is reported as fine and exits 0. That is not a
 * theoretical gap: it hid a real syntax error in `ui/overlay.js` for an entire
 * review pass, and the only thing that caught it was booting the app.
 *
 * So: renderer files (real ES modules) are checked through a `.mjs` copy, and
 * main-process files (real CommonJS) are checked as-is - plus the reverse check,
 * so a stray `export` in a CommonJS file or a stray `require` in an ES module
 * is reported too.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', '.git', 'release', 'dist', 'tmp']);

/**
 * Files that are not modules at all.
 *
 * `tools/probe.js` is a snippet of renderer code that the main process pastes
 * into the page; it has no imports and no exports on purpose.
 */
const NOT_A_MODULE = new Set([
  'tools/probe.js',
  'tools/probe-view.js',
  'tools/probe-config.js',
  'tools/probe-software.js',
  'tools/probe-memory.js',
  'tools/probe-updates.js',
]);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

function checkSyntax(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    return null;
  } catch (err) {
    return String(err.stderr || err.message)
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.includes('at checkSyntax'))
      .slice(0, 4)
      .join('\n          ');
  }
}

const files = [
  ...walk(path.join(ROOT, 'src')),
  ...walk(path.join(ROOT, 'tools')),
];

const problems = [];
let esm = 0;
let cjs = 0;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'envserver-syntax-'));

try {
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const isRenderer = file.includes(`${path.sep}renderer${path.sep}`);

    // decide the goal from the code, not from the directory
    const looksEsm = /^\s*(export\s+(default\s+)?|import\s|export\s*\{)/m.test(src);
    const looksCjs = /(^|[^.\w])require\s*\(/.test(src);

    if (looksEsm || isRenderer) {
      esm++;
      // the whole point: a .mjs copy forces the ESM parser
      const tmp = path.join(scratch, `${path.basename(file, path.extname(file))}-${Math.random().toString(36).slice(2)}.mjs`);
      fs.writeFileSync(tmp, src);
      const err = checkSyntax(tmp);
      if (err) problems.push(`${rel(file)}: ${err}`);

      if (looksCjs) {
        problems.push(`${rel(file)}: mixes ES module syntax with require() - a bundler-free ES module cannot require`);
      }
    } else if (looksCjs) {
      cjs++;
      const err = checkSyntax(file);
      if (err) problems.push(`${rel(file)}: ${err}`);
    } else if (NOT_A_MODULE.has(rel(file))) {
      /* a pasted-in snippet, not a module */
    } else {
      problems.push(`${rel(file)}: no module syntax found - expected ES module exports or CommonJS require`);
    }
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

if (!problems.length) {
  console.log(`syntax: ok - ${files.length} files (${esm} esm, ${cjs} cjs)`);
  process.exit(0);
}

console.log(`syntax: ${problems.length} problem(s)\n`);
for (const p of problems) console.log(`  ${p}`);
process.exit(1);