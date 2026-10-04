'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

// read rather than hard-coded: a stale User-Agent is how an API starts
// rate-limiting you for a version you stopped shipping two releases ago
let pkgVersion = '0.0.0';
try {
  pkgVersion = require('../../package.json').version || pkgVersion;
} catch {
  /* packaged without a readable package.json */
}
const USER_AGENT = `EnvServer/${pkgVersion}`;

class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} for ${url}${body ? ` - ${String(body).slice(0, 200)}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

/** Raised when a caller-supplied signal cancels the work. */
class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** fetch + JSON with retry/backoff. */
async function getJson(url, { timeout = 30000, retries = 3, signal, headers = null } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('timeout')), timeout);
    const onAbort = () => ac.abort(signal.reason);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    try {
      const res = await fetch(url, {
        signal: ac.signal,
        headers: { 'user-agent': USER_AGENT, ...(headers || {}) },
      });
      if (!res.ok) throw new HttpError(res.status, url, await res.text().catch(() => ''));
      return await res.json();
    } catch (err) {
      if (signal?.aborted) throw new CancelledError();
      lastErr = err;
      if (attempt < retries) await sleep(400 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
  throw lastErr;
}

/** SHA-256 of a file on disk, streamed so a 200 MB jar never lands in memory. */
function hashFile(file, algo = 'sha256') {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algo);
    fs.createReadStream(file)
      .on('data', (d) => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

/** How long a transfer may stall before we treat the socket as dead. */
const STALL_MS = 45_000;

/**
 * Download `url` to `dest`, optionally verifying a sha256.
 *
 * - resumes via a `<dest>.part` file + HTTP Range
 * - reports throttled progress
 * - retries on transient failure, keeping the partial file
 * - aborts on a stalled socket, not just on an explicit cancel
 *
 * @returns {Promise<{skipped:boolean, size:number, sha256:string|null}>}
 */
async function download(url, dest, opts = {}) {
  const {
    sha256 = null,
    expectedSize = null,
    onProgress = null,
    retries = 4,
    signal = null,
    force = false,
  } = opts;

  const throwIfCancelled = () => {
    if (signal?.aborted) throw new CancelledError();
  };

  if (!force && fs.existsSync(dest)) {
    if (!sha256) {
      const size = fs.statSync(dest).size;
      onProgress?.({ received: size, total: expectedSize ?? size, done: true });
      return { skipped: true, size, sha256: null };
    }
    const have = await hashFile(dest, 'sha256').catch(() => null);
    if (have === sha256) {
      const size = fs.statSync(dest).size;
      onProgress?.({ received: size, total: expectedSize ?? size, done: true });
      return { skipped: true, size, sha256: have };
    }
    // corrupt on disk - refetch from scratch
    await fsp.rm(dest, { force: true });
  }

  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    throwIfCancelled();
    let resumeFrom = 0;

    try {
      if (fs.existsSync(part)) resumeFrom = fs.statSync(part).size;
      if (resumeFrom && expectedSize && resumeFrom >= expectedSize) {
        // partial looks suspiciously complete - verify before trusting it
        const have = await hashFile(part, 'sha256').catch(() => null);
        if (!sha256 || have === sha256) {
          await fsp.rename(part, dest);
          onProgress?.({ received: resumeFrom, total: expectedSize, done: true });
          return { skipped: true, size: resumeFrom, sha256: have };
        }
        await fsp.rm(part, { force: true });
        resumeFrom = 0;
      }

      const headers = { 'user-agent': USER_AGENT };
      if (resumeFrom) headers.range = `bytes=${resumeFrom}-`;

      // one controller per attempt: caller cancellation + stall watchdog
      const ac = new AbortController();
      let stallTimer = null;
      const armStall = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => ac.abort(new Error('transfer stalled')), STALL_MS);
      };
      const onAbort = () => ac.abort(signal.reason);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      try {
        armStall();
        const res = await fetch(url, { headers, signal: ac.signal, redirect: 'follow' });

        if (!res.ok) {
          // a rejected Range means the remote file changed - start over
          if (res.status === 416 && resumeFrom) {
            await fsp.rm(part, { force: true });
            throw new HttpError(res.status, url, 'range not satisfiable');
          }
          throw new HttpError(res.status, url, await res.text().catch(() => ''));
        }

        // a server that ignores Range answers 200 with the whole body, so the
        // existing .part must be discarded rather than appended to
        if (resumeFrom && res.status !== 206) {
          await fsp.rm(part, { force: true });
          resumeFrom = 0;
        }

        if (!res.body) throw new Error('empty response body');

        const contentLength = Number(res.headers.get('content-length') || 0);
        const total = expectedSize || (contentLength ? resumeFrom + contentLength : 0);

        let received = resumeFrom;
        let lastTick = 0;
        let lastSpeedAt = Date.now();
        let lastSpeedBytes = received;
        const report = (immediate = false) => {
          const now = Date.now();
          if (!immediate && now - lastTick < 100) return;
          const span = Math.max(1, now - lastSpeedAt) / 1000;
          const speed = (received - lastSpeedBytes) / span;
          lastTick = now;
          lastSpeedAt = now;
          lastSpeedBytes = received;
          onProgress?.({ received, total, done: false, speed });
        };

        const out = fs.createWriteStream(part, { flags: resumeFrom ? 'a' : 'w' });
        const body = Readable.fromWeb(res.body);
        body.on('data', (chunk) => {
          received += chunk.length;
          armStall();
          report();
        });

        await pipeline(body, out);
        report(true);

        const got = await hashFile(part, 'sha256');
        if (sha256 && got !== sha256) {
          await fsp.rm(part, { force: true });
          throw new Error(`checksum mismatch for ${url}: expected ${sha256}, got ${got}`);
        }

        await fsp.rename(part, dest);
        onProgress?.({ received, total: total || received, done: true, speed: 0 });
        return { skipped: false, size: fs.statSync(dest).size, sha256: got };
      } finally {
        if (stallTimer) clearTimeout(stallTimer);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
    } catch (err) {
      throwIfCancelled();
      lastErr = err;
      if (attempt < retries) await sleep(500 * 2 ** attempt);
    }
  }
  throw lastErr;
}

/**
 * Run `tasks` with at most `limit` in flight.
 *
 * Cancellation is re-thrown rather than collected as a per-task failure,
 * otherwise an aborted operation would surface as "N downloads failed" instead
 * of "cancelled".
 */
async function pool(tasks, limit = 8, { onSettled, signal } = {}) {
  const results = new Array(tasks.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      if (signal?.aborted) throw new CancelledError();
      const i = cursor++;
      try {
        results[i] = { ok: true, value: await tasks[i](i) };
      } catch (err) {
        if (signal?.aborted) throw new CancelledError();
        results[i] = { ok: false, error: err };
        onSettled?.(i, err);
      }
    }
  });

  try {
    await Promise.all(workers);
  } catch (err) {
    if (err instanceof CancelledError || signal?.aborted) throw new CancelledError();
    throw err;
  }
  return results;
}

module.exports = {
  getJson,
  download,
  pool,
  hashFile,
  sleep,
  HttpError,
  CancelledError,
  USER_AGENT,
  STALL_MS,
};