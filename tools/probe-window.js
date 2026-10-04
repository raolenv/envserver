/*
 * Window/taskbar recovery probe.
 *
 *   npx electron . --probe=tools/probe-window.js
 *
 * The complaint this exists for: clicking the EnvServer icon in the Windows
 * taskbar did not bring the app back, and the app looked like it had closed
 * itself. Two separate things caused that, and both are checked here:
 *
 *   1. `setSkipTaskbar(isMinimized())` removed the taskbar button entirely, so
 *      once minimized there was nothing left to click.
 *   2. closing the window called `hide()`, and Windows will not restore a hidden
 *      window from the taskbar - so the button was there and did nothing.
 *
 * The renderer cannot see the taskbar itself, so this drives the same window:*
 * IPC the chrome buttons use and asserts the window is always in a state a
 * taskbar click can recover: visible, and either not minimized or minimized.
 * A window that is hidden is the failure, and that is what these assertions
 * exist to catch if it ever comes back.
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const w = window.env.window;
  const out = { states: [], assertions: [] };

  const snap = async (label) => {
    const s = await w.getState();
    out.states.push({ label, ...s });
    return s;
  };

  await snap('start');

  // Windows reports a minimized window as isVisible() === false, because it is
  // not on screen - yet its taskbar button still restores it. So wait for the
  // state to settle rather than sampling once, and assert on `reachable`.
  const settle = async (label, tries = 12) => {
    let last = null;
    for (let i = 0; i < tries; i++) {
      await sleep(250);
      last = await snap(`${label} (poll ${i + 1})`);
      if (last.reachable !== null) return last;
    }
    return last;
  };

  // 1. minimizing must leave the button there to click
  w.minimize();
  const minimized = await settle('after minimize');

  // 2. the close button is the one the user complained about, and it is the one
  //    that used to leave a window nothing could reach
  w.close();
  const afterClose = await settle('after close');

  const assert = (name, pass, detail) => out.assertions.push({ name, pass, detail });

  assert(
    'minimizing leaves the window reachable from the taskbar',
    minimized.reachable === true,
    `visible=${minimized.visible} minimized=${minimized.minimized} reachable=${minimized.reachable}`
  );
  assert(
    'the close button leaves the window reachable from the taskbar',
    afterClose.reachable === true,
    `visible=${afterClose.visible} minimized=${afterClose.minimized} reachable=${afterClose.reachable}`
  );
  assert(
    'the close button minimizes rather than hides',
    afterClose.minimized === true,
    'a hidden window keeps a taskbar button that does nothing, which is what made EnvServer look like it closed itself'
  );

  // leave the app in a usable state for anything that runs after this probe
  window.env.window.toggleMaximize();
  await sleep(600);

  out.ok = out.assertions.every((a) => a.pass);
  out.failed = out.assertions.filter((a) => !a.pass).map((a) => a.name);
  return out;
})()