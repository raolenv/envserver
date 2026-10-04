'use strict';

const net = require('net');

/**
 * Minecraft Server List Ping (status), used to show the real player count and
 * MOTD without scraping the console log.
 *
 * Two packets, both handshake-then-request:
 *   1. handshake: packet id 0x00, protocol version, host, port, next state 1
 *   2. status request: packet id 0x00
 * and the server answers with a length-prefixed JSON document.
 */

const TIMEOUT_MS = 4000;
const PROTOCOL_VERSION = 767; // 1.21.x - servers ignore it, but a sane value helps

/** Minecraft varint: 7 bits per byte, little endian, high bit = continuation. */
function writeVarint(value) {
  let v = value | 0;
  const out = [];
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v) byte |= 0x80;
    out.push(byte);
  } while (v);
  return Buffer.from(out);
}

function readVarint(buf, offset) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) throw new Error('varint runs past the end of the packet');
    const byte = buf[pos++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) throw new Error('varint is too long');
  }
  return { value: result >>> 0, size: pos - offset };
}

/** Length-prefixed frame: varint total length, then varint packet id, then body. */
function packet(id, ...parts) {
  const body = Buffer.concat([writeVarint(id), ...parts]);
  return Buffer.concat([writeVarint(body.length), body]);
}

function writeString(str) {
  const buf = Buffer.from(String(str ?? ''), 'utf8');
  return Buffer.concat([writeVarint(buf.length), buf]);
}

/**
 * Flatten a chat component into plain text.
 *
 * A MOTD is anything the server owner put in `motd=`, which the vanilla protocol
 * allows to be a bare string, a `{text:...}` object, or a nested
 * `{extra:[...]}` composition - so all three have to be handled.
 */
function flattenMotd(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (Array.isArray(node)) return node.map(flattenMotd).join('');
  if (typeof node !== 'object') return '';

  let out = typeof node.text === 'string' ? node.text : '';
  if (Array.isArray(node.extra)) out += node.extra.map(flattenMotd).join('');
  if (node.translate && !out) out = node.translate;
  return out;
}

/**
 * Ask a server for its status.
 *
 * @param {string} host
 * @param {number} port
 * @param {object} [o]
 * @param {number} [o.timeout]
 * @returns {Promise<{ok:boolean, online:number, max:number, motd:string, version:string, protocol:number,
 *                    players:string[], reason?:string}>}
 */
function status(host, port, o = {}) {
  const { timeout = TIMEOUT_MS } = o;

  return new Promise((resolve) => {
    let settled = false;
    let buffer = Buffer.alloc(0);

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
      resolve(payload);
    };

    const socket = net.connect({ host, port: Number(port) || 0 });
    socket.setTimeout(timeout);

    socket.on('connect', () => {
      const handshake = packet(
        0x00,
        writeVarint(PROTOCOL_VERSION),
        writeString(host),
        (() => {
          const p = Buffer.alloc(2);
          p.writeUInt16BE(Number(port) || 0, 0);
          return p;
        })(),
        writeVarint(1)
      );
      socket.write(handshake);
      socket.write(packet(0x00));
    });

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        const { value: length, size: lenSize } = readVarint(buffer, 0);
        if (buffer.length < lenSize + length) return; // wait for the rest

        const body = buffer.subarray(lenSize, lenSize + length);
        const { value: id, size: idSize } = readVarint(body, 0);
        if (id !== 0x00) {
          return finish({ ok: false, online: 0, max: 0, motd: '', version: '', protocol: 0, players: [], reason: 'not a status response' });
        }

        const { value: jsonLen, size: jsonLenSize } = readVarint(body, idSize);
        const json = body.toString('utf8', idSize + jsonLenSize, idSize + jsonLenSize + jsonLen);
        const parsed = JSON.parse(json);

        const sample = Array.isArray(parsed?.players?.sample) ? parsed.players.sample : [];
        finish({
          ok: true,
          online: Number(parsed?.players?.online) || 0,
          max: Number(parsed?.players?.max) || 0,
          motd: flattenMotd(parsed?.description).slice(0, 400),
          version: String(parsed?.version?.name || ''),
          protocol: Number(parsed?.version?.protocol) || 0,
          players: sample.map((p) => String(p?.name || '')).filter(Boolean),
        });
      } catch (err) {
        finish({ ok: false, online: 0, max: 0, motd: '', version: '', protocol: 0, players: [], reason: err.message });
      }
    });

    socket.on('timeout', () =>
      finish({ ok: false, online: 0, max: 0, motd: '', version: '', protocol: 0, players: [], reason: 'timed out' })
    );
    socket.on('error', (err) =>
      finish({ ok: false, online: 0, max: 0, motd: '', version: '', protocol: 0, players: [], reason: err.message })
    );
  });
}

/** Just "is anything listening on this port". */
function isPortOpen(host, port, timeout = 1200) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
      resolve(v);
    };
    const socket = net.connect({ host, port: Number(port) || 0 });
    socket.setTimeout(timeout);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

module.exports = { status, isPortOpen, writeVarint, readVarint, packet, writeString, flattenMotd, TIMEOUT_MS };