import { h } from './dom.js';
import { icon } from './icons.js';
import { toast } from './ui/toast.js';
import { bytes, speed as fmtSpeed } from './fmt.js';
import { state, refreshDetail, refreshServers, refreshJvmPlan, emit, activeServer } from './state.js';
import { softwareById } from './software.js';

/**
 * Background jobs.
 *
 * The point of this module: a Paper jar is ~50 MB and a JDK is ~200 MB. Showing a
 * modal for that makes the app feel broken - you cannot look at anything else,
 * you cannot start another server, and closing the window throws the work away.
 *
 * So every long operation is a *job*:
 *
 *   - it is registered here before the IPC call, so the UI can draw it instantly;
 *   - progress arrives on one shared channel and is routed by `jobId`, so several
 *     jobs can run at once without stealing each other's bar;
 *   - finishing reports a toast, not a modal;
 *   - the job survives navigating between views and switching servers.
 *
 * The main process keeps running when the window is hidden to the tray, so these
 * survive that too.
 */

const jobs = new Map();
let seq = 0;

/** One shared listener; each job is matched by its own id. */
let wired = false;

function ensureWired() {
  if (wired) return;
  wired = true;

  window.env.onDownload((payload) => {
    if (!payload || !payload.jobId) return;
    const job = jobs.get(payload.jobId);
    if (!job) return;

    if (payload.phase) job.phase = payload.phase;
    if (typeof payload.percent === 'number') {
      job.percent = payload.percent;
      job.indeterminate = false;
    }
    if (typeof payload.received === 'number') job.received = payload.received;
    if (typeof payload.total === 'number' && payload.total > 0) job.total = payload.total;
    if (typeof payload.speed === 'number') job.speed = payload.speed;
    if (typeof payload.done === 'number') job.done = payload.done;
    if (typeof payload.total === 'number' && payload.done !== undefined) job.total = payload.total;

    emit('jobs');
  });
}

function create(spec) {
  ensureWired();
  const job = {
    id: `job-${++seq}`,
    kind: spec.kind,
    label: spec.label,
    sub: '',
    serverId: spec.serverId || '',
    mcVersion: spec.mcVersion || '',
    major: spec.major || 0,
    build: spec.build || 0,
    received: 0,
    total: 0,
    done: 0,
    percent: 0,
    speed: 0,
    phase: 'Starting',
    status: 'running',
    error: '',
    indeterminate: true,
    startedAt: Date.now(),
    ...spec.extra,
  };
  jobs.set(job.id, job);
  emit('jobs');
  return job;
}

export function jobList() {
  return [...jobs.values()].sort((a, b) => a.startedAt - b.startedAt);
}

export function activeJobs() {
  return jobList().filter((j) => j.status === 'running');
}

export function jobsForServer(serverId) {
  return jobList().filter((j) => j.serverId === serverId);
}

export function jobForVersion(mcVersion) {
  return jobList().find((j) => j.kind === 'jar' && j.mcVersion === mcVersion && j.status === 'running');
}

/** Any jar download in flight for one server, whatever the software. */
export function jarJobForServer(serverId) {
  return jobList().find((j) => j.kind === 'jar' && j.serverId === serverId && j.status === 'running');
}

function progressText(job) {
  if (job.total > 0 && job.received > 0) {
    const rate = job.speed > 0 ? ` at ${fmtSpeed(job.speed)}` : '';
    return `${bytes(job.received)} of ${bytes(job.total)}${rate}`;
  }
  if (job.kind === 'backup' && job.total > 0) {
    return `${job.done} of ${job.total} files`;
  }
  return job.phase;
}

function finish(job, ok, message) {
  job.status = ok ? 'done' : 'error';
  job.error = ok ? '' : message || 'failed';
  job.indeterminate = false;
  if (ok && job.total > 0) job.percent = 100;

  toast(message || `${job.label} finished`, ok ? 'ok' : 'err');
  emit('jobs');

  // keep a finished job on screen briefly so the user sees the result, then drop it
  setTimeout(() => {
    if (jobs.get(job.id) === job) jobs.delete(job.id);
    emit('jobs');
  }, ok ? 6000 : 12_000);
}

/* ------------------------------- install ------------------------------- */

/**
 * Download a server jar in the background, whichever software it is.
 *
 * No modal: the row in the Versions list and the sidebar both grow a progress bar
 * and a toast lands when it is done. Safe to call twice - a second install of the
 * same version joins the one already running instead of starting a duplicate.
 *
 * @param {{serverId:string, serverName?:string, mcVersion:string, build?:number|null, software?:string}} opts
 */
export function installSoftware({ serverId, serverName = '', mcVersion, build = null, software = 'paper' }) {
  const sw = softwareById(software);
  const label = sw.label;

  const existing = activeJobs().find(
    (j) => j.kind === 'jar' && j.serverId === serverId && j.mcVersion === mcVersion && j.software === sw.id
  );
  if (existing) {
    toast(`${label} ${mcVersion} is already downloading`, 'info');
    return existing;
  }

  const job = create({
    kind: 'jar',
    label: `${label} ${mcVersion}`,
    serverId,
    mcVersion,
    build,
    extra: { serverName, software: sw.id, project: sw.project || sw.source },
  });
  job.software = sw.id;
  job.sub = serverName ? `Installing into ${serverName}` : `Installing into ${mcVersion}`;

  // one call for every software. main picks the catalogue: a jar for Paper and
  // vanilla, a zip unpacked into the server folder for Bedrock, a phar for
  // PocketMine. `software` is sent explicitly because the job may have been
  // started from the create form, before the record exists to read a type from.
  const call = window.env.catalog.install({
    serverId,
    software: sw.id,
    mcVersion,
    build,
    jobId: job.id,
  });

  call
    .then(async (res) => {
      if (!res?.ok) {
        finish(job, false, res?.cancelled ? `${label} download cancelled` : res?.error || 'the download failed');
        return;
      }
      job.sub = `${bytes(res.size || 0)} installed`;
      finish(job, true, `${label} ${mcVersion} installed${serverName ? ` into ${serverName}` : ''}`);
      await refreshServers();
      await refreshDetail();
      emit('versions');
    })
    .catch((err) => finish(job, false, err?.message || String(err)));

  return job;
}

/** Back-compat alias: every jar used to be Paper. */
export const installPaper = (opts) => installSoftware({ ...opts, software: opts.software || opts.project || 'paper' });

/** @deprecated use installSoftware with `software`. */
export const installVanilla = (opts) => installSoftware({ ...opts, software: 'vanilla' });

/* ------------------------------- backups ------------------------------ */

/** Zip the world in the background. Safe while the server is up. */
export function backupWorld(serverId, serverName = '') {
  const existing = activeJobs().find((j) => j.kind === 'backup' && j.serverId === serverId);
  if (existing) return existing;

  const job = create({ kind: 'backup', label: 'World backup', serverId, extra: { serverName } });
  job.sub = 'Preparing';

  window.env.server
    .backup(serverId, { jobId: job.id })
    .then(async (res) => {
      if (!res?.ok) {
        finish(job, false, res?.error || 'the backup failed');
        return;
      }
      job.sub = bytes(res.size || 0);
      const skipped = res.errors?.length || 0;
      finish(job, true, `Backup written: ${res.name} (${bytes(res.size || 0)})${skipped ? ` - ${skipped} locked file(s) skipped` : ''}`);
      await refreshDetail();
    })
    .catch((err) => finish(job, false, err?.message || String(err)));

  return job;
}

/* --------------------------------- java -------------------------------- */

/** Download a JDK in the background. */
export function downloadJava(major) {
  const existing = activeJobs().find((j) => j.kind === 'java' && j.major === Number(major));
  if (existing) return existing;

  const job = create({ kind: 'java', label: `Java ${major}`, major: Number(major) });
  job.sub = 'Looking up Eclipse Temurin';

  window.env.java
    .install(Number(major), { jobId: job.id })
    .then(async (res) => {
      if (!res?.ok) {
        finish(job, false, res?.error || `Java ${major} could not be downloaded`);
        return;
      }
      job.sub = 'Ready';
      finish(job, true, `Java ${major} is installed`);
      await refreshJvmPlan({ silent: true });
      emit('jvm');
      await refreshDetail();
    })
    .catch((err) => finish(job, false, err?.message || String(err)));

  return job;
}

/* -------------------------------- cancel ------------------------------- */

/**
 * Ask the main process to abort a job.
 *
 * The progress bar freezes where it is and the job is marked cancelled locally,
 * rather than waiting for the abort to travel: the download loop checks the
 * signal between chunks, so the call returns quickly either way.
 */
export function cancelJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = 'error';
  job.error = 'cancelled';
  job.indeterminate = false;
  window.env.jobs.cancel(jobId).catch(() => {});
  toast(`${job.label} cancelled`, 'info');
  setTimeout(() => {
    if (jobs.get(jobId) === job) jobs.delete(jobId);
    emit('jobs');
  }, 3000);
}

/* --------------------------------- view -------------------------------- */

/** The sidebar panel: every job, newest last, with a cancel button. */
export function renderJobs() {
  const list = jobList();
  if (!list.length) return null;

  return h(
    'div.jobs',
    ...list.map((job) => {
      const pct = job.total > 0 && job.received > 0 && job.kind !== 'backup'
        ? Math.min(100, (job.received / job.total) * 100)
        : job.percent;

      const bar = h(
        `div.progress${job.indeterminate && job.status === 'running' ? '.progress--indeterminate' : ''}`,
        h('div.progress__fill', { style: { width: `${job.status === 'running' ? pct : 100}%` } })
      );

      return h(
        `div.job.job--${job.status}`,
        h(
          'div.loader.loader--sm',
          h('img.loader__cube', { src: 'assets/icon-128.png', alt: '' })
        ),
        h(
          'div.job__meta',
          h('div.job__label', { text: job.label }),
          h('div.job__sub', { text: job.status === 'error' ? job.error : job.status === 'done' ? job.sub : progressText(job) }),
          bar
        ),
        job.status === 'running'
          ? h(
              'button.job__cancel',
              { type: 'button', title: `Cancel ${job.label}`, onClick: () => cancelJob(job.id) },
              icon('close')
            )
          : h('div.job__cancel', icon(job.status === 'done' ? 'check' : 'alert'))
      );
    })
  );
}

/** True when the active server has anything going on, for the sidebar dot. */
export function activeServerIsBusy(serverId) {
  return activeJobs().some((j) => j.serverId === serverId);
}

export { activeServer };