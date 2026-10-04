/*
 * Memory reading probe.
 *
 *   npx electron . --probe=tools/probe-memory.js
 *
 * The complaint this exists for: a server set to 512 MB showed 800+ MB "of 512
 * max". Checks that the heap is read from the JVM when it can be, that the
 * process total is never labelled as the ceiling, and that a ceiling larger than
 * the machine produces a warning instead of silence.
 */
(async () => {
  const { memoryReading, memoryBudget, suggestMemory } = await import('./js/actions.js');
  const { state } = await import('./js/state.js');

  const out = { readings: [], budget: [], suggest: [] };

  // the exact case from the complaint
  out.readings.push({
    case: '512 MB ceiling, 812 MB process, heap unreadable',
    ...memoryReading({ running: true, xmx: 512, ramMb: 812, heapUsedMb: null, heapMaxMb: null }),
  });
  out.readings.push({
    case: '512 MB ceiling, 812 MB process, heap 240/512',
    ...memoryReading({ running: true, xmx: 512, ramMb: 812, heapUsedMb: 240, heapMaxMb: 512 }),
  });
  out.readings.push({
    case: 'stopped',
    ...memoryReading({ running: false, xmx: 512, ramMb: 0 }),
  });
  out.readings.push({
    case: 'heap over its own ceiling (should flag)',
    ...memoryReading({ running: true, xmx: 512, ramMb: 900, heapUsedMb: 530, heapMaxMb: 512 }),
  });

  for (const [max, total] of [[512, 8192], [4096, 8192], [6144, 8192], [8192, 8192], [32768, 8192]]) {
    out.budget.push({ max, total, ...memoryBudget({ memory: { max } }, total) });
  }

  for (const total of [0, 4096, 8192, 16384, 32768, 65536]) {
    out.suggest.push({ total, ...suggestMemory(total) });
  }

  // what the dashboard is actually drawing right now
  out.live = {
    totalMemoryMb: state.settings.totalMemoryMb,
    active: state.servers.find((s) => s.id === state.activeId) || null,
    status: state.status,
  };

  return out;
})()