/*
 * Bedrock-aware probe.
 *
 *   npx electron . --probe=tools/probe-runtime.js --user-data-dir=tmp/probe-bedrock
 *
 * What this exists to prove, which unit tests cannot:
 *
 *   1. A PocketMine or Bedrock server can be *created*, and the renderer never
 *      tells it to install Java. Every server on this machine may have no Java at
 *      all, and the dashboard must still describe both.
 *   2. `servers:detail` returns a `blockers` list with the right reasons - a
 *      missing phar, and PHP that is not installed. Both are the exact strings a
 *      user will read, so their wording is worth asserting rather than eyeballing.
 *   3. `server:dry-run` produces the right command line per runtime, including the
 *      fact that PocketMine's is a PHP one with `-d memory_limit` and Bedrock's is
 *      a bare exe.
 *   4. No `server.properties` is seeded for Bedrock or PocketMine. Seeding Java
 *      keys into a Bedrock server produces a Config tab full of settings the
 *      software ignores, and that is invisible until somebody edits one.
 *
 * The PocketMine start is NOT attempted: there is no PHP on the test machine, and
 * the point of this probe is that the app says so rather than crashing. That is
 * assertion 5 - `server:start` refuses with a message, not a crash.
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = [];
  const name = 'ProbeRuntime';

  /**
   * Get past the terms gate the way a person would.
   *
   * Without this every view except Terms refuses to render, so the probe would
   * measure an empty dashboard and report it as "no runtime badge shown" - a
   * false failure that looks exactly like the bug it is looking for.
   */
  const agreed = await (async () => {
    for (let i = 0; i < 20; i++) {
      const btn = [...document.querySelectorAll('button')].find((b) => /agree/i.test(b.textContent));
      if (btn) { btn.click(); await sleep(700); return 'agreed'; }
      if (!document.querySelector('.terms')) return 'terms not shown';
      await sleep(250);
    }
    return 'no agree button found';
  })();
  results.push({ check: 'terms', agreed });

  // leftovers from an earlier run would be found by the same name match
  for (const s of (await window.env.servers.list()).servers || []) {
    if (s.name === name) await window.env.servers.remove(s.id);
  }

  const created = await window.env.servers.create({ name, mcVersion: '5.44.3', memory: { min: 512, max: 1024 }, type: 'pocketmine' });
  const id = created?.server?.id;
  if (!id) return { error: 'create returned no id', created };

  /* ---------------------- 1 + 2: the runtime overview ---------------------- */

  const overview = await window.env.runtime.overview();
  results.push({
    check: 'runtime:overview',
    software: Object.keys(overview.software || {}).sort(),
    pocketmine: overview.software?.pocketmine,
    bedrock: overview.software?.bedrock,
    paper: overview.software?.paper,
    phpFound: (overview.php || []).length,
    phpMin: overview.phpMin,
    ports: overview.ports,
  });

  /* ---------------------- PocketMine: blockers ---------------------------- */

  await window.__envRefreshServers();
  await window.__envOpenServer(id);
  await sleep(1500);

  const detail = await window.env.servers.detail(id);
  results.push({
    check: 'pocketmine detail',
    javaNeeded: detail?.java?.needed,
    phpNeeded: detail?.php?.needed,
    phpResolved: detail?.php?.resolved || null,
    filesInstalled: detail?.files?.installed,
    blockers: (detail?.blockers || []).map((b) => `${b.ok ? 'ok' : 'blocked'}: ${b.text}`),
    runtimeKind: detail?.runtime?.kind,
  });

  /* ---------------------- what the renderer actually shows --------------- */

  const hero = document.querySelector('.hero__badges');
  const rendered = {
    check: 'pocketmine dashboard text',
    view: document.querySelector('.content__title')?.textContent || '(none)',
    heroBadges: [...(hero?.querySelectorAll('*') || [])].map((e) => e.textContent.trim()).filter(Boolean),
    // the whole point: a PocketMine server must never be told about Java
    saysJava: /Java/.test(hero?.textContent || ''),
    saysPhp: /PHP/.test(hero?.textContent || ''),
    banner: document.querySelector('.banner--warn')?.textContent.replace(/\s+/g, ' ').trim().slice(0, 400) || null,
    pluginsTab: [...document.querySelectorAll('.navitem')].map((b) => b.textContent.trim()),
    startDisabled: Boolean(document.querySelector('.runbtn')?.disabled),
    startTitle: document.querySelector('.runbtn')?.getAttribute('title') || '',
  };
  results.push(rendered);

  /* ---------------------- 3: the launch plan ----------------------------- */

  const dryPocketmine = await window.env.server.dryRun(id);
  results.push({
    check: 'dry-run pocketmine',
    runtimeKind: dryPocketmine?.runtimeKind,
    exe: dryPocketmine?.exe,
    argv: dryPocketmine?.argv,
    eula: dryPocketmine?.eula,
    requiredMajor: dryPocketmine?.requiredMajor,
  });

  /* ---------------------- 5: start refuses with advice ------------------- */

  // Every ipcMain handler answers with an object and never rejects, so a refusal
  // arrives as `{ ok: false, error }` rather than as a throw. Asserting on a
  // missing rejection here would pass while the guard silently did nothing.
  const startPocketmine = await window.env.server.start(id);
  results.push({
    check: 'start without PHP',
    ok: startPocketmine?.ok,
    refused: String(startPocketmine?.error || '').slice(0, 300),
    // it must name PHP specifically - "no server jar" would be the Java answer
    mentionsPhp: /PHP/.test(String(startPocketmine?.error || '')),
    mentionsJava: /Java/.test(String(startPocketmine?.error || '')),
  });

  /* ---------------------- Bedrock: port, files, no Java ------------------- */

  await window.env.servers.update(id, { type: 'bedrock', mcVersion: '1.21.1.0' });
  await window.__envRefreshServers();
  await window.__envOpenServer(id);
  await sleep(1200);

  const list = await window.env.servers.list();
  const stored = (list.servers || []).find((s) => s.id === id);
  results.push({ check: 'bedrock record', type: stored?.type, port: stored?.port, mcVersion: stored?.mcVersion });

  const bedrockDetail = await window.env.servers.detail(id);
  results.push({
    check: 'bedrock detail',
    runtimeKind: bedrockDetail?.runtime?.kind,
    javaNeeded: bedrockDetail?.java?.needed,
    javaExplain: bedrockDetail?.java?.explain,
    phpNeeded: bedrockDetail?.php?.needed,
    eula: bedrockDetail?.eula,
    blockers: (bedrockDetail?.blockers || []).map((b) => `${b.ok ? 'ok' : 'blocked'}: ${b.text}`),
  });

  const dryBedrock = await window.env.server.dryRun(id);
  results.push({
    check: 'dry-run bedrock',
    runtimeKind: dryBedrock?.runtimeKind,
    exe: dryBedrock?.exe,
    argv: dryBedrock?.argv,
    eula: dryBedrock?.eula,
    requiredMajor: dryBedrock?.requiredMajor,
  });

  const bedrockHero = document.querySelector('.hero__badges');
  results.push({
    check: 'bedrock dashboard text',
    heroBadges: [...(bedrockHero?.querySelectorAll('*') || [])].map((e) => e.textContent.trim()).filter(Boolean),
    saysJava: /Java/.test(bedrockHero?.textContent || ''),
    banner: document.querySelector('.banner--warn')?.textContent.replace(/\s+/g, ' ').trim().slice(0, 400) || null,
    startTitle: document.querySelector('.runbtn')?.getAttribute('title') || '',
  });

  // Bedrock's own start guard, for the same reason: the exe is not installed, so
  // it must refuse by name rather than reporting the Java reason
  const startBedrock = await window.env.server.start(id);
  results.push({
    check: 'start without bedrock files',
    ok: startBedrock?.ok,
    refused: String(startBedrock?.error || '').slice(0, 300),
    mentionsExe: /bedrock_server\.exe/.test(String(startBedrock?.error || '')),
  });

  /* ---------------------- 4: no Java properties were seeded -------------- */

  // a Bedrock server that never ran has no server.properties, because nothing
  // wrote one for it; `servers:detail` is where the Config view reads from
  const props = bedrockDetail?.properties;
  results.push({
    check: 'bedrock config',
    keys: Object.keys(props?.values || {}),
    order: props?.order?.length || 0,
    // empty on purpose: every Java key would be a setting Bedrock ignores
    javaKeysSeeded: Object.keys(props?.values || {}).filter((k) => ['gamemode', 'view-distance', 'spawn-protection'].includes(k)),
  });

  /* ---------------------- and back to Paper, for contrast ---------------- */

  await window.env.servers.update(id, { type: 'paper', mcVersion: '1.21.4' });
  await window.__envRefreshServers();
  await window.__envOpenServer(id);
  await sleep(1200);
  const paperDetail = await window.env.servers.detail(id);
  const paperProps = paperDetail?.properties;
  results.push({
    check: 'paper config',
    hasServerPort: 'server-port' in (paperProps?.values || {}),
    order: paperProps?.order?.length || 0,
    port: paperDetail?.port,
  });

  try {
    await window.env.servers.remove(id);
    results.push({ cleanup: 'removed' });
  } catch (err) {
    results.push({ cleanup: 'failed: ' + String(err?.message || err) });
  }

  return results;
})()