'use strict';

const net = require('net');
const dgram = require('dgram');

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

/**
 * RakNet unconnected ping, for Bedrock.
 *
 * The Java Server List Ping above is TCP and speaks the Java protocol; Bedrock
 * runs on RakNet over **UDP** and answers a completely different packet. Sending
 * the Java ping at a Bedrock server therefore gets nothing back, ever - which
 * would leave every Bedrock server permanently showing "unreachable" on the
 * dashboard and a player count of zero no matter how many people are playing.
 *
 * RakNet's unconnected ping has been unchanged since 2012:
 *
 *   out   0x01 | time:u64 | MAGIC:16 | clientGuid:u64
 *   back  0x1c | time:u64 | MAGIC:16 | infoLen:u16 | info | motdLen:u16 | motd
 *
 * `info` is a NUL-separated list: edition, line1, line2, protocol, version,
 * player count, max players, server GUID. The MOTD after it is JSON.
 *
 * @param {string} host
 * @param {number} port UDP port, 19132 by default
 * @param {object} [o]
 * @param {number} [o.timeout]
 * @returns {Promise<{ok:boolean, online:number, max:number, motd:string, version:string, players:string[], reason?:string}>}
 */
function bedrockStatus(host, port, o = {}) {
  const { timeout = TIMEOUT_MS } = o;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        /* already gone */
      }
      resolve(payload);
    };

    const socket = dgram.createSocket('udp4');
    socket.on('error', (err) =>
      finish({ ok: false, online: 0, max: 0, motd: '', version: '', players: [], reason: err.message })
    );
    socket.on('message', (buf) => {
      try {
        // a pong is 0x1c; anything else is a stray datagram from another game
        if (buf[0] !== 0x1c) return;
        if (buf.length < 35) return;

        const infoLen = buf.readUInt16BE(33);
        if (buf.length < 35 + infoLen) return;
        const info = buf.toString('utf8', 35, 35 + infoLen);

        const motdStart = 35 + infoLen;
        const motdLen = buf.length >= motdStart + 2 ? buf.readUInt16BE(motdStart) : 0;
        const motdJson = buf.toString('utf8', motdStart + 2, motdStart + 2 + motdLen);

        // edition, MOTD line 1, MOTD line 2, protocol, version, online, max, guid
        const fields = info.split('\0');
        const [, line1 = '', , protocol = '', version = '', online = '', max = ''] = fields;
        const motd = flattenMotd(safeJson(motdJson)) || line1;

        finish({
          ok: true,
          online: Number(online) || 0,
          max: Number(max) || 0,
          motd: String(motd).slice(0, 400),
          version: version ? `${version} (protocol ${protocol})` : '',
          players: [],
        });
      } catch (err) {
        finish({ ok: false, online: 0, max: 0, motd: '', version: '', players: [], reason: err.message });
      }
    });

    const pingPacket = packetBedrockPing();
    socket.send(pingPacket, 0, pingPacket.length, Number(port) || 0, host, (err) => {
      if (err) finish({ ok: false, online: 0, max: 0, motd: '', version: '', players: [], reason: err.message });
    });

    const timer = setTimeout(
      () => finish({ ok: false, online: 0, max: 0, motd: '', version: '', players: [], reason: 'timed out' }),
      timeout
    );
    if (timer.unref) timer.unref();
    // cleared by whichever finishes first; cleared unconditionally on close too
    socket.on('close', () => clearTimeout(timer));
  });
}

/** A Bedrock MOTD is JSON, but a server can and does send a bare string. */
function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * The 33-byte unconnected ping.
 *
 * The timestamp is real rather than a constant because some servers drop a ping
 * whose time field does not advance between requests, and a constant would make
 * every sample look like a replay.
 */
function packetBedrockPing() {
  const buf = Buffer.alloc(33);
  buf[0] = 0x01;
  buf.writeBigUInt64BE(BigInt(Date.now()), 1);
  RAKNET_MAGIC.copy(buf, 9);
  // the client GUID only has to be stable within one session
  buf.writeBigUInt64BE(0x0000cafe00000000n, 25);
  return buf;
}

/**
 * The RakNet offline message identifier.
 *
 * `00ffff00fefefefefdfdfdfd12345678`, byte for byte, as every RakNet
 * implementation since the original uses. Verified against Bedrock servers
 * rather than taken on faith.
 */
const RAKNET_MAGIC = Buffer.from([0x00, 0xff, 0xff, 0x00, 0xfe, 0xfe, 0xfe, 0xfe, 0xfd, 0xfd, 0xfd, 0xfd, 0x12, 0x34, 0x56, 0x78]);

/**
 * Ask whichever protocol the software actually speaks.
 *
 * The kind comes from `runtime.js` rather than from the port number, because a
 * user can put a Bedrock server on any UDP port they like.
 */
function statusFor(kind, host, port, o = {}) {
  return kind === 'java' ? status(host, port, o) : bedrockStatus(host, port, o);
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

module.exports = {
  status,
  bedrockStatus,
  statusFor,
  isPortOpen,
  writeVarint,
  readVarint,
  packet,
  writeString,
  flattenMotd,
  packetBedrockPing,
  RAKNET_MAGIC,
  TIMEOUT_MS,
};