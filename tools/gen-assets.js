/**
 * EnvServer - asset generator
 *
 * Generates original 16x16 pixel block textures + an app icon, procedurally.
 * No Minecraft assets are used or downloaded - everything here is drawn from
 * noise functions so the app ships with zero third-party art.
 *
 *   node tools/gen-assets.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ------------------------------------------------------------------ *
 * PNG encoding (8-bit RGBA, no interlace)
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ *
 * Deterministic noise
 * ------------------------------------------------------------------ */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seamless fractal noise over a `size`-pixel tile. Returns f(x,y) in [0,1]. */
function fbm(seed, size, options) {
  const opts = options || {};
  const octaves = opts.octaves === undefined ? 3 : opts.octaves;
  const base = opts.base === undefined ? 2 : opts.base;
  const gain = opts.gain === undefined ? 0.5 : opts.gain;

  const layers = [];
  for (let o = 0; o < octaves; o++) {
    const n = base << o;
    const rng = mulberry32(seed + o * 7919);
    const g = new Float32Array(n * n);
    for (let i = 0; i < g.length; i++) g[i] = rng();
    layers.push({ n: n, g: g });
  }

  return (x, y) => {
    let sum = 0;
    let amp = 1;
    let tot = 0;
    for (let li = 0; li < layers.length; li++) {
      const L = layers[li];
      const fx = (x / size) * L.n;
      const fy = (y / size) * L.n;
      const xi = Math.floor(fx);
      const yi = Math.floor(fy);
      let tx = fx - xi;
      let ty = fy - yi;
      tx = tx * tx * (3 - 2 * tx);
      ty = ty * ty * (3 - 2 * ty);
      const i0 = ((xi % L.n) + L.n) % L.n;
      const i1 = (i0 + 1) % L.n;
      const j0 = ((yi % L.n) + L.n) % L.n;
      const j1 = (j0 + 1) % L.n;
      const a = L.g[j0 * L.n + i0];
      const b = L.g[j0 * L.n + i1];
      const c = L.g[j1 * L.n + i0];
      const d = L.g[j1 * L.n + i1];
      sum += amp * ((a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty);
      tot += amp;
      amp *= gain;
    }
    return sum / tot;
  };
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
const mix = (a, b, t) => a + (b - a) * t;

/* ------------------------------------------------------------------ *
 * Texture primitives
 * ------------------------------------------------------------------ */

const SIZE = 16;

function alloc(size) {
  return Buffer.alloc(size * size * 4, 255);
}

function put(px, x, y, r, g, b, a) {
  const i = (y * px.length / 4 + x) * 4;
  px[i] = clamp255(r);
  px[i + 1] = clamp255(g);
  px[i + 2] = clamp255(b);
  px[i + 3] = a === undefined ? 255 : a;
}

/**
 * Fill a tile with organic colour noise.
 */
function speckle(px, size, seed, base, variation, grain) {
  const n1 = fbm(seed, size);
  const rng = mulberry32(seed + 555);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = (n1(x, y) - 0.5) * variation + (rng() - 0.5) * grain;
      const s = 1 + v;
      put(px, x, y, base[0] * s, base[1] * s, base[2] * s);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Palette
 *
 * Only the icon needs these. There used to be a set of per-block textures
 * written into `assets/blocks/`, but nothing referenced them once the flat theme
 * replaced the isometric chrome, so the generator and the folder are both gone -
 * an asset nothing loads is just bytes shipped in the installer.
 * ------------------------------------------------------------------ */

const DIRT = [134, 96, 67];
const GRASS = [95, 159, 53];

/* ------------------------------------------------------------------ *
 * Icon: isometric grass block
 * ------------------------------------------------------------------ */

function pointInPoly(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    const xi = pts[i];
    const yi = pts[i + 1];
    const xj = pts[j];
    const yj = pts[j + 1];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function scalePoly(pts, k) {
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < pts.length; i += 2) {
    cx += pts[i];
    cy += pts[i + 1];
  }
  cx /= pts.length / 2;
  cy /= pts.length / 2;
  const out = [];
  for (let i = 0; i < pts.length; i += 2) {
    out.push(cx + (pts[i] - cx) * k, cy + (pts[i + 1] - cy) * k);
  }
  return out;
}

function blend(buf, size, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const i = (y * size + x) * 4;
  const na = a / 255;
  buf[i] = clamp255(mix(buf[i], r, na));
  buf[i + 1] = clamp255(mix(buf[i + 1], g, na));
  buf[i + 2] = clamp255(mix(buf[i + 2], b, na));
  buf[i + 3] = clamp255(mix(buf[i + 3], a, na));
}

function rasterise(buf, size, poly, shade) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < poly.length; i += 2) {
    if (poly[i] < minX) minX = poly[i];
    if (poly[i] > maxX) maxX = poly[i];
    if (poly[i + 1] < minY) minY = poly[i + 1];
    if (poly[i + 1] > maxY) maxY = poly[i + 1];
  }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(size - 1, Math.ceil(maxY));
  const x0 = Math.max(0, Math.floor(minX));
  const x1 = Math.min(size - 1, Math.ceil(maxX));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!pointInPoly(x + 0.5, y + 0.5, poly)) continue;
      const c = shade(x, y);
      blend(buf, size, x, y, c[0], c[1], c[2], c[3]);
    }
  }
}

function buildIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const pad = size * 0.06;
  const cx = size / 2;
  const halfW = (size - pad * 2) / 2;
  const halfH = halfW * 0.5;
  const sideH = size * 0.46;

  const topFace = [cx, pad, cx + halfW, pad + halfH, cx, pad + halfH * 2, cx - halfW, pad + halfH];
  const leftFace = [cx - halfW, pad + halfH, cx, pad + halfH * 2, cx, pad + halfH * 2 + sideH, cx - halfW, pad + halfH + sideH];
  const rightFace = [cx, pad + halfH * 2, cx + halfW, pad + halfH, cx + halfW, pad + halfH + sideH, cx, pad + halfH * 2 + sideH];

  const topTex = alloc(SIZE);
  speckle(topTex, SIZE, 22, GRASS, 0.16, 0.12);
  const dirtTex = alloc(SIZE);
  speckle(dirtTex, SIZE, 11, DIRT, 0.2, 0.1);

  const faces = [
    { poly: topFace, tex: topTex, tint: [1, 1, 1] },
    { poly: leftFace, tex: dirtTex, tint: [0.78, 0.78, 0.78] },
    { poly: rightFace, tex: dirtTex, tint: [0.6, 0.6, 0.6] },
  ];

  // outline: each face grown slightly, filled near-black
  for (let i = 0; i < faces.length; i++) {
    const grown = scalePoly(faces[i].poly, 1 + (size * 0.035) / halfW);
    rasterise(buf, size, grown, () => [17, 17, 20, 255]);
  }

  // faces: invert p = o + u*U + v*V to sample the 16x16 texture
  for (let fi = 0; fi < faces.length; fi++) {
    const f = faces[fi];
    const p = f.poly;
    const ox = p[0];
    const oy = p[1];
    const ux = (p[2] - p[0]) / SIZE;
    const uy = (p[3] - p[1]) / SIZE;
    const vx = (p[4] - p[0]) / SIZE;
    const vy = (p[5] - p[1]) / SIZE;
    const det = ux * vy - vx * uy;

    rasterise(buf, size, p, (x, y) => {
      const dx = x + 0.5 - ox;
      const dy = y + 0.5 - oy;
      const u = (dx * vy - vx * dy) / det;
      const v = (ux * dy - dx * uy) / det;
      let tx = Math.floor(u * SIZE);
      let ty = Math.floor(v * SIZE);
      if (tx < 0) tx = 0;
      if (tx > SIZE - 1) tx = SIZE - 1;
      if (ty < 0) ty = 0;
      if (ty > SIZE - 1) ty = SIZE - 1;
      const ti = (ty * SIZE + tx) * 4;
      return [
        f.tex[ti] * f.tint[0],
        f.tex[ti + 1] * f.tint[1],
        f.tex[ti + 2] * f.tint[2],
        255,
      ];
    });
  }
  return buf;
}

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

const root = path.join(__dirname, '..', 'src', 'renderer', 'assets');
fs.mkdirSync(root, { recursive: true });

let count = 0;

// 32 in the titlebar, 48 in the welcome box, 64 in the dashboard hero,
// 128 in the loaders, 256 as the window and tray icon
const ICON_SIZES = [32, 48, 64, 128, 256];
for (let i = 0; i < ICON_SIZES.length; i++) {
  const s = ICON_SIZES[i];
  fs.writeFileSync(path.join(root, 'icon-' + s + '.png'), encodePNG(s, s, buildIcon(s)));
  count++;
}
// no unsuffixed `icon.png`: nothing referenced it and it was byte-identical to
// icon-256.png, so it was 1.3 KB of the installer spent twice on one image

/**
 * Windows needs a real .ico for the executable and the taskbar.
 *
 * Since Vista an ICO entry may hold a PNG verbatim, so the already-encoded PNGs
 * are wrapped in a 6 + 16*n byte container instead of being re-encoded as BMP
 * (which is also what electron-builder's own converter ends up doing, just more
 * slowly).
 */
function encodeICO(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);

  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // 0 means 256
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); // palette size
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(entry);
  }

  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

const icoSizes = [16, 32, 48, 256];
fs.writeFileSync(
  path.join(root, 'icon.ico'),
  encodeICO(
    icoSizes.map((size) => ({ size, data: encodePNG(size, size, buildIcon(size)) }))
  )
);
count++;

console.log('gen-assets: wrote ' + count + ' files to src/renderer/assets');
