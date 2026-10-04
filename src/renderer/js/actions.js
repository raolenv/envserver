import { toast } from './ui/toast.js';
import { confirmBox } from './ui/overlay.js';
import { state, refreshDetail, refreshServers, refreshJvmPlan, emit } from './state.js';
import { installPaper, backupWorld, downloadJava } from './jobs.js';
import { megabytesToText } from './fmt.js';

/**
 * The short list of things a click can start.
 *
 * Downloads are NOT here any more - they are background jobs (see `jobs.js`), so
 * this module is only the immediate, foreground operations: starting, stopping,
 * accepting the EULA, adding plugins, and the confirmations around them.
 */

/* --------------------------------- start -------------------------------- */

/**
 * Start a server.
 *
 * The one flow that still shows a modal: the JVM may have to be downloaded first
 * (200 MB), and the user needs to see why nothing is happening. Once the process
 * is up the console takes over and the modal closes.
 */
export async function startServer(serverId) {
  const record = state.servers.find((s) => s.id === serverId);
  if (!record) return false;

  const required = state.detail?.java?.requiredMajor || 0;
  const willDownloadJava = Boolean(required) && !state.detail?.java?.resolved;

  const ok = await confirmBox({
    title: 'Start the server',
    message: willDownloadJava
      ? `This release needs Java ${required}, which is not installed yet. EnvServer will download it from Adoptium first - that is around 200 MB.`
      : 'The server will start in its own folder and keep running in the background.',
    detail: willDownloadJava ? 'You can keep using the app while it downloads.' : '',
    confirmText: willDownloadJava ? 'Download and start' : 'Start',
    iconName: willDownloadJava ? 'download' : 'play',
  });
  if (!ok) return false;

  window.env.server
    .start(serverId)
    .then(async (res) => {
      if (!res?.ok) {
        toast(res?.error || 'the server did not start', 'err');
        return;
      }
      toast(`${record.name} started`, 'ok');
      await refreshDetail();
      await refreshJvmPlan({ silent: true });
      emit('jvm');
    })
    .catch((err) => toast(err?.message || String(err), 'err'));

  return true;
}

/* --------------------------------- stop --------------------------------- */

export async function stopServer(serverId, { force = false } = {}) {
  if (!force) {
    const ok = await confirmBox({
      title: 'Stop the server',
      message: 'The world is saved and the JVM shuts down cleanly.',
      confirmText: 'Stop',
      iconName: 'stop',
    });
    if (!ok) return false;
  }

  const res = await window.env.server.stop(serverId, force);
  if (!res?.ok) return toast(res?.error || 'could not stop the server', 'err');
  toast(force ? 'Server force-stopped' : 'Stopping the server', 'info');
  return true;
}

/* --------------------------------- eula --------------------------------- */

/**
 * Accept the Minecraft EULA.
 *
 * This one stays a real confirmation: the EULA is a legal agreement and EnvServer
 * is not going to tick it on the user's behalf. It is a single click, in place,
 * with the text right there - not a wizard step before anything else works.
 */
export async function acceptEula(serverId) {
  const ok = await confirmBox({
    title: 'Accept the Minecraft EULA',
    message:
      'Running a Minecraft server means using Mojang\'s server software, which is covered by the ' +
      'Minecraft EULA. EnvServer writes eula=true to the server\'s eula.txt when you accept.',
    detail: 'https://aka.ms/MinecraftEULA',
    confirmText: 'I accept',
    iconName: 'shield',
  });
  if (!ok) return false;

  const res = await window.env.config.setEula(serverId, true);
  if (!res?.ok) return toast(res?.error || 'could not record that', 'err');
  toast('EULA accepted', 'ok');
  await refreshDetail();
  return true;
}

/* -------------------------------- plugins ------------------------------- */

/** Pick jars from Explorer and drop them into `plugins/`. */
export async function addPlugins(serverId) {
  const res = await window.env.plugins.pick(serverId);
  if (res?.cancelled) return false;
  if (!res?.ok && res?.failed?.length) toast(`${res.failed.length} plugin(s) could not be added`, 'err');
  else if (res?.ok) toast(`${res.added?.length || 0} plugin(s) added`, 'ok');
  await refreshDetail();
  return true;
}

export async function removePlugin(serverId, fileName) {
  const res = await window.env.plugins.remove(serverId, fileName);
  if (!res?.ok) return toast(res?.error || 'could not remove that plugin', 'err');
  toast(`${fileName} removed - restart the server to unload it`, 'info');
  await refreshDetail();
  return true;
}

/* -------------------------------- memory -------------------------------- */

/** RAM a new server should get: about half the machine, on a clean step. */
export function suggestMemory(totalMemoryMb) {
  const total = Number(totalMemoryMb) || 0;
  if (!total) return { min: 1024, max: 4096 };
  const step = total > 16384 ? 1024 : 512;
  const max = Math.max(1024, Math.min(total - 1024, Math.round((total * 0.5) / step) * step));
  return { min: Math.min(1024, max), max };
}

/**
 * What Windows itself needs before the heap is even considered.
 *
 * A Minecraft server is not the only thing on the machine. The shell, the file
 * cache, the JVM's own off-heap buffers and a dozen background programs all need
 * room, and a heap that leaves under 2 GB for them does not fail loudly - it
 * fails as the machine stuttering, the pagefile thrashing and the server being
 * killed by the OOM killer nobody configured.
 */
const HEADROOM_MB = 2048;

/**
 * Is this server's ceiling something this machine can actually honour?
 *
 * The load does adapt to the specs when EnvServer picks the number: a new server
 * gets about half of the installed RAM on a clean step. What it cannot do is stop
 * somebody setting 32 GB on a 8 GB box, so this is the check that turns that into
 * a warning instead of a mystery.
 *
 * @returns {{percent:number, headroomMb:number, overBudget:boolean, tight:boolean}}
 */
export function memoryBudget(record, totalMemoryMb) {
  const total = Number(totalMemoryMb) || 0;
  const max = Number(record?.memory?.max) || 0;
  const percent = total ? Math.round((max / total) * 100) : 0;
  const headroomMb = total - max;
  const overBudget = Boolean(total && (max > total || headroomMb < HEADROOM_MB));
  return {
    percent,
    headroomMb,
    overBudget,
    tight: Boolean(total && !overBudget && headroomMb < HEADROOM_MB * 2),
  };
}

/**
 * The one line that explains a memory reading.
 *
 * `-Xmx` is a ceiling on the JVM heap and nothing else. A running server also
 * spends memory on metaspace, the code cache, one stack per thread, and the
 * direct (off-heap) buffers Paper's Netty layer allocates - all of which Task
 * Manager and `tasklist` count and no `-X` flag covers. So a 512 MB server
 * showing 800 MB in a process total is the JVM working normally, not a setting
 * that was ignored.
 *
 * When the heap itself can be read (the runtime ships `jcmd`) it is shown as the
 * number that can actually be compared against the ceiling, and the process
 * total is kept as a separate fact instead of being labelled "max".
 */
export function memoryReading({ running, xmx, ramMb, heapUsedMb, heapMaxMb }) {
  const maxMb = Number(heapMaxMb) > 0 ? Number(heapMaxMb) : Number(xmx) || 0;

  if (!running) {
    return {
      value: maxMb ? `${megabytesToText(maxMb)}` : '-',
      small: 'max',
      tone: '',
      title: `-Xmx${maxMb}M is the heap ceiling for this server. It applies to the next start.`,
    };
  }

  const processMb = Number(ramMb) || 0;
  const usedMb = Number(heapUsedMb);

  if (usedMb > 0 && maxMb > 0) {
    const over = usedMb > maxMb;
    return {
      value: `${megabytesToText(usedMb)}`,
      small: `/ ${megabytesToText(maxMb)} heap`,
      tone: over ? 'err' : '',
      title:
        `Heap in use: ${usedMb} MB of the ${maxMb} MB ceiling (-Xmx${maxMb}M).\n\n` +
        `The whole process is ${processMb} MB. The rest is metaspace, the code cache, ` +
        `thread stacks and Netty's off-heap network buffers - none of which -Xmx covers, ` +
        `so the process total is always the larger number.`,
    };
  }

  // no jcmd, so the heap is genuinely unknown here; say that rather than
  // presenting the process total as if it were the heap
  return {
    value: processMb ? `${megabytesToText(processMb)}` : '-',
    small: 'process',
    tone: '',
    title:
      `The whole process is using ${processMb} MB, with a ${maxMb} MB heap ceiling (-Xmx${maxMb}M).\n\n` +
      `Heap in use is not readable on this Java runtime, so only the process total can be shown. ` +
      `The process total is always larger than the heap: metaspace, thread stacks and Netty's ` +
      `off-heap buffers sit outside it.`,
  };
}

/* ------------------------------ thin wrappers --------------------------- */

export const installVersion = installPaper;
export const backupNow = backupWorld;
export const addJava = downloadJava;

export { toast };