'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const { Readable, Writable } = require('stream');
const { pipeline } = require('stream/promises');

/**
 * ZIP reader and writer, with no dependency.
 *
 * Node ships no zip support, and a Temurin JDK archive is ~25 000 entries, so:
 *
 * - reading goes through the central directory and inflates one entry at a time
 *   with `zlib.createInflateRaw`, so a whole archive never has to fit in memory;
 * - writing streams too, using data descriptors (general purpose bit 3) so the
 *   CRC and sizes do not have to be known before the bytes are written.
 *
 * Both directions reject any entry name that would escape the target directory.
 */

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;
const DD_SIG = 0x08074b50;
const ZIP64_EOCD_LOC_SIG = 0x07064b50;

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32Update(prev, buf) {
  let c = (prev ^ -1) >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

function findEOCD(buf) {
  const maxBack = Math.min(buf.length, 0xffff + 22);
  for (let i = buf.length - 22; i >= buf.length - maxBack; i--) {
    if (i < 0) break;
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('not a zip file (no end-of-central-directory record)');
}

/**
 * Zip64 extended information, parsed only for the fields the 32-bit header
 * marked as 0xFFFFFFFF.
 *
 * A 200 MB JDK archive does not need this, but a future Temurin build could, and
 * silently reading a multi-gigabyte entry as 0 bytes is a nasty failure.
 */
function applyZip64(entry, extra, buf, extraStart) {
  let p = extraStart;
  const end = extraStart + extra.length;
  while (p + 4 <= end) {
    const id = buf.readUInt16LE(p);
    const size = buf.readUInt16LE(p + 2);
    let q = p + 4;
    if (id === 0x0001) {
      if (entry.compressedSize === 0xffffffff && q + 8 <= end) {
        entry.compressedSize = Number(buf.readBigUInt64LE(q));
        q += 8;
      }
      if (entry.size === 0xffffffff && q + 8 <= end) {
        entry.size = Number(buf.readBigUInt64LE(q));
        q += 8;
      }
      if (entry.offset === 0xffffffff && q + 8 <= end) {
        entry.offset = Number(buf.readBigUInt64LE(q));
        q += 8;
      }
    }
    p += 4 + size;
  }
}

/** Locate and read the central directory of `zipPath`. */
function readDirectory(zipPath) {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;
    if (fileSize < 22) throw new Error('not a zip file (too small)');

    // the EOCD is within the last 64 KB, plus room for a zip64 locator
    const tailLen = Math.min(fileSize, 0xffff + 22 + 64);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, fileSize - tailLen);

    const eocd = findEOCD(tail);
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);

    // zip64: the 32-bit fields saturate and the real values live in the zip64 EOCD
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const locAt = eocd - 20;
      if (locAt >= 0 && tail.readUInt32LE(locAt) === ZIP64_EOCD_LOC_SIG) {
        const z64 = Number(tail.readBigUInt64LE(locAt + 8));
        if (z64 >= 0 && z64 + 56 <= fileSize) {
          const head = Buffer.alloc(56);
          fs.readSync(fd, head, 0, 56, z64);
          if (head.readUInt32LE(0) === 0x06064b50) {
            count = Number(head.readBigUInt64LE(32));
            cdSize = Number(head.readBigUInt64LE(40));
            cdOffset = Number(head.readBigUInt64LE(48));
          }
        }
      }
    }

    if (!count || !cdSize) return [];
    const cdBuf = Buffer.alloc(cdSize);
    fs.readSync(fd, cdBuf, 0, cdSize, cdOffset);
    return readCentralDirectory(cdBuf);
  } finally {
    fs.closeSync(fd);
  }
}

/** @returns {Array<{name:string, offset:number, compressedSize:number, size:number, method:number, crc:number}>} */
function readCentralDirectory(cdBuf) {
  const entries = [];
  let ptr = 0;
  while (ptr + 46 <= cdBuf.length && cdBuf.readUInt32LE(ptr) === CD_SIG) {
    const method = cdBuf.readUInt16LE(ptr + 10);
    const crc = cdBuf.readUInt32LE(ptr + 16);
    let compressedSize = cdBuf.readUInt32LE(ptr + 20);
    let size = cdBuf.readUInt32LE(ptr + 24);
    const nameLen = cdBuf.readUInt16LE(ptr + 28);
    const extraLen = cdBuf.readUInt16LE(ptr + 30);
    const commentLen = cdBuf.readUInt16LE(ptr + 32);
    let offset = cdBuf.readUInt32LE(ptr + 42);
    const name = cdBuf.toString('utf8', ptr + 46, ptr + 46 + nameLen);

    const entry = { name, offset, compressedSize, size, method, crc };
    applyZip64(entry, extraLen, cdBuf, ptr + 46 + nameLen);
    entries.push(entry);

    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Turn an archive entry name into a safe absolute path under `destDir`. */
function safeJoin(destDir, rawName) {
  // zip always uses forward slashes, but a hand-crafted archive can use either
  const name = String(rawName || '').replace(/\\/g, '/');
  if (!name || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return null;
  const parts = name.split('/').filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..')) return null;
  if (!parts.length) return null;
  const root = path.resolve(destDir);
  const dest = path.resolve(root, ...parts);
  // belt and braces: even with the checks above, confirm we stayed inside
  if (dest !== root && !dest.startsWith(root + path.sep)) return null;
  return dest;
}

/** Entry names in an archive - used by tests and diagnostics. */
function list(zipPath) {
  return readDirectory(zipPath).map((e) => e.name);
}

/**
 * Extract an archive into `destDir`, keeping the directory structure.
 *
 * @param {string} zipPath
 * @param {string} destDir
 * @param {object} [o]
 * @param {(name:string)=>boolean} [o.filter] keep only these entries
 * @param {(done:number, total:number)=>void} [o.onProgress]
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<{files:number, bytes:number}>}
 */
async function extractAll(zipPath, destDir, o = {}) {
  const { filter = null, onProgress = null, signal = null } = o;
  const entries = readDirectory(zipPath);
  const total = entries.length;
  let written = 0;
  let bytes = 0;
  let done = 0;

  for (const entry of entries) {
    if (signal?.aborted) throw new Error('cancelled');
    done++;
    onProgress?.(done, total);

    // directory entries carry a trailing slash and have no data
    if (entry.name.replace(/\\/g, '/').endsWith('/')) continue;
    if (filter && !filter(entry.name)) continue;

    const dest = safeJoin(destDir, entry.name);
    if (!dest) continue; // never let a crafted archive escape destDir

    // the local header repeats the name/extra lengths, which may differ from the
    // central directory's, so the data offset has to be read from there
    const fd = fs.openSync(zipPath, 'r');
    let source;
    try {
      const lfh = Buffer.alloc(30);
      fs.readSync(fd, lfh, 0, 30, entry.offset);
      if (lfh.readUInt32LE(0) !== LFH_SIG) throw new Error(`corrupt local header for ${entry.name}`);
      const dataStart = entry.offset + 30 + lfh.readUInt16LE(26) + lfh.readUInt16LE(28);

      source = fs.createReadStream(zipPath, {
        start: dataStart,
        end: dataStart + entry.compressedSize - 1,
        fd,
        autoClose: false,
      });
      await fsp.mkdir(path.dirname(dest), { recursive: true });

      if (entry.method === 0) {
        await pipeline(source, fs.createWriteStream(dest));
      } else if (entry.method === 8) {
        await pipeline(source, zlib.createInflateRaw(), fs.createWriteStream(dest));
      } else {
        throw new Error(`unsupported zip compression method ${entry.method}`);
      }
    } finally {
      fs.closeSync(fd);
    }

    written++;
    bytes += entry.size;
  }

  return { files: written, bytes };
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

/** Depth-first file list, relative names in posix form, sorted for determinism. */
async function walkFiles(root, prefix = '') {
  let entries;
  try {
    entries = await fsp.readdir(path.join(root, prefix), { withFileTypes: true });
  } catch {
    return [];
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const out = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(root, rel)));
    } else if (entry.isFile()) {
      out.push(rel);
    }
    // symlinks and everything else are skipped on purpose: a world folder does
    // not contain any, and following one could copy data from outside the tree
  }
  return out;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const time = ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((date.getSeconds() / 2) & 31);
  const day = (((year - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31);
  return { time, date: day };
}

/**
 * Zip a directory tree to `outFile`.
 *
 * Streams, so the CRC and sizes are patched into the central directory after
 * each file rather than being buffered up front.
 *
 * @returns {Promise<{files:number, bytes:number}>}
 */
async function zipDir(srcDir, outFile, o = {}) {
  const { onProgress = null, signal = null, now = new Date() } = o;

  const names = await walkFiles(srcDir);
  const total = names.length;
  let offset = 0;
  let bytes = 0;
  const errors = [];

  await fsp.mkdir(path.dirname(outFile), { recursive: true });
  const out = fs.createWriteStream(outFile);

  // The offset is tracked by hand because a Writable never reports its position.
  const write = (buf) => {
    offset += buf.length;
    out.write(buf);
  };

  const entries = [];

  try {
    let done = 0;
    for (const name of names) {
      if (signal?.aborted) throw new Error('cancelled');
      done++;
      onProgress?.(done, total);

      const src = path.join(srcDir, ...name.split('/'));
      const nameBuf = Buffer.from(name, 'utf8');
      const { time, date } = dosDateTime(now);
      const localOffset = offset;

      // local header: bit 3 (data descriptor) means crc/sizes may be zero here
      const lfh = Buffer.alloc(30);
      lfh.writeUInt32LE(LFH_SIG, 0);
      lfh.writeUInt16LE(20, 4); // version needed
      lfh.writeUInt16LE(0x0008, 6); // flags
      lfh.writeUInt16LE(8, 8); // method: deflate
      lfh.writeUInt16LE(time, 10);
      lfh.writeUInt16LE(date, 12);
      lfh.writeUInt16LE(nameBuf.length, 26);
      lfh.writeUInt16LE(0, 28); // extra length
      write(lfh);
      write(nameBuf);

      let compressed = 0;
      let crc = 0;
      let size = 0;

      // A fresh sink per file: `pipeline` ends its destination, and the central
      // directory still has to be appended to `out` after the last one. Routing
      // the deflated bytes through a private sink keeps `out` open.
      const forward = new Writable({
        write(chunk, _enc, cb) {
          offset += chunk.length;
          out.write(chunk, cb);
        },
      });

      // Buffer the file first so a locked/unreadable region file (e.g. held by the
      // running server on Windows) is skipped *before* writing any descriptor,
      // instead of corrupting the archive mid-stream.
      let srcBuf;
      try {
        srcBuf = await fsp.readFile(src);
      } catch (err) {
        errors.push(`${name}: ${err.message}`);
        continue;
      }
      crc = crc32Update(0, srcBuf);
      size = srcBuf.length;

      const deflate = zlib.createDeflateRaw({ level: 6 });
      deflate.on('data', (chunk) => {
        compressed += chunk.length;
      });

      await pipeline(Readable.from(srcBuf), deflate, forward);

      const dd = Buffer.alloc(16);
      dd.writeUInt32LE(DD_SIG, 0);
      dd.writeUInt32LE(crc >>> 0, 4);
      dd.writeUInt32LE(compressed, 8);
      dd.writeUInt32LE(size, 12);
      write(dd);

      entries.push({ nameBuf, crc: crc >>> 0, compressed, size, localOffset, time, date });
      bytes += size;
    }

    const cdOffset = offset;
    for (const e of entries) {
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(CD_SIG, 0);
      cd.writeUInt16LE(20, 4); // version made by
      cd.writeUInt16LE(20, 6); // version needed
      cd.writeUInt16LE(0x0008, 8);
      cd.writeUInt16LE(8, 10); // method: deflate
      cd.writeUInt16LE(e.time, 12);
      cd.writeUInt16LE(e.date, 14);
      cd.writeUInt32LE(e.crc, 16);
      cd.writeUInt32LE(e.compressed, 20);
      cd.writeUInt32LE(e.size, 24);
      cd.writeUInt16LE(e.nameBuf.length, 28);
      cd.writeUInt32LE(e.localOffset, 42);
      write(cd);
      write(e.nameBuf);
    }
    const cdSize = offset - cdOffset;

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    write(eocd);

    return { files: entries.length, bytes, errors };
  } finally {
    await new Promise((resolve) => out.end(resolve));
  }
}

module.exports = {
  extractAll,
  list,
  readDirectory,
  readCentralDirectory,
  safeJoin,
  walkFiles,
  zipDir,
  crc32Update,
};