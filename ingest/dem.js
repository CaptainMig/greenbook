#!/usr/bin/env node
/**
 * GreenBook DEM sampler — USGS 3DEP 1/3 arc-second GeoTIFF tiles (AWS Open Data).
 *
 * Bulk local sampling replaces per-point EPQS calls: we range-read only the
 * TIFF header + the 512×512 internal tiles that contain our sample points
 * (a few hundred KB per course instead of a 400 MB tile download, and zero
 * per-point API latency). EPQS remains the single-course fallback.
 *
 *   const { sampleElevationFt } = require("./dem");
 *   const ft = await sampleElevationFt(40.5989, -75.5378);
 *
 *   CLI: node ingest/dem.js --test "40.5989,-75.5378"
 *
 * Format notes (USGS_13_*.tif): classic little-endian TIFF, Float32, tiled,
 * DEFLATE (8) with floating-point predictor (3), GDA nodata -999999.
 * Public domain (U.S. Government work).
 */

const zlib = require("zlib");
const { request } = require("./net"); // proxy-aware — node fetch ignores HTTPS_PROXY

const S3 = "https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/13/TIFF/current";
const headerCache = new Map(); // tileName -> parsed header (or null if missing)
const blockCache = new Map();  // tileName/blockIdx -> Float32Array (LRU-bounded)
const MAX_BLOCKS = 256;        // ~1 MB per decoded 512×512 block — bounds multi-course runs

function tileName(lat, lon) {
  const n = Math.ceil(lat);
  const w = Math.ceil(-lon);
  return `n${String(n).padStart(2, "0")}w${String(w).padStart(3, "0")}`;
}
const tileUrl = (t) => `${S3}/${t}/USGS_13_${t}.tif`;

async function fetchRange(url, start, end) {
  const res = await request(url, { headers: { Range: `bytes=${start}-${end}` } });
  if (res.status === 404) return null;
  if (res.status !== 206 && res.status !== 200) throw new Error(`range fetch ${res.status} ${url}`);
  return res.buffer;
}

async function loadHeader(t) {
  if (headerCache.has(t)) return headerCache.get(t);
  const url = tileUrl(t);
  const head = await fetchRange(url, 0, 65535);
  if (!head) { headerCache.set(t, null); return null; }
  if (head.readUInt16LE(0) !== 0x4949 || head.readUInt16LE(2) !== 42)
    throw new Error(`${t}: not a classic little-endian TIFF`);
  const ifdOff = head.readUInt32LE(4);
  if (ifdOff + 2 > head.length) throw new Error(`${t}: IFD beyond header window`);
  const n = head.readUInt16LE(ifdOff);
  const tags = {};
  for (let i = 0; i < n; i++) {
    const off = ifdOff + 2 + i * 12;
    const id = head.readUInt16LE(off);
    const type = head.readUInt16LE(off + 2);
    const count = head.readUInt32LE(off + 4);
    tags[id] = { type, count, valOff: off + 8 };
  }
  const typeSize = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8 };
  async function tagValues(id) {
    const tg = tags[id];
    if (!tg) return null;
    const size = typeSize[tg.type] * tg.count;
    let buf;
    if (size <= 4) buf = head.subarray(tg.valOff, tg.valOff + size);
    else {
      const ptr = head.readUInt32LE(tg.valOff);
      buf = ptr + size <= head.length ? head.subarray(ptr, ptr + size) : await fetchRange(url, ptr, ptr + size - 1);
    }
    const out = [];
    for (let i = 0; i < tg.count; i++) {
      if (tg.type === 3) out.push(buf.readUInt16LE(i * 2));
      else if (tg.type === 4) out.push(buf.readUInt32LE(i * 4));
      else if (tg.type === 12) out.push(buf.readDoubleLE(i * 8));
      else if (tg.type === 11) out.push(buf.readFloatLE(i * 4));
      else out.push(buf[i]);
    }
    return out;
  }

  const [w, h, tw, th, comp, pred, scale, tie, offsets, counts, sfmt, bps] = await Promise.all([
    tagValues(256), tagValues(257), tagValues(322), tagValues(323),
    tagValues(259), tagValues(317), tagValues(33550), tagValues(33922),
    tagValues(324), tagValues(325), tagValues(339), tagValues(258),
  ]);
  if (!w || !tw || !offsets) throw new Error(`${t}: missing tiling tags`);
  if (comp[0] !== 8 && comp[0] !== 5) throw new Error(`${t}: unsupported compression ${comp[0]} (want DEFLATE=8 or LZW=5)`);
  if (bps[0] !== 32 || (sfmt && sfmt[0] !== 3)) throw new Error(`${t}: not Float32`);
  const hdr = {
    url, width: w[0], height: h[0], tileW: tw[0], tileH: th[0],
    compression: comp[0],
    predictor: pred ? pred[0] : 1,
    scaleX: scale[0], scaleY: scale[1],
    originX: tie[3], originY: tie[4],
    offsets, counts,
    tilesAcross: Math.ceil(w[0] / tw[0]),
  };
  headerCache.set(t, hdr);
  return hdr;
}

/* TIFF-variant LZW: MSB-first codes, 9-bit start, clear=256, EOI=257, early change */
function lzwDecode(input, expectedSize) {
  const out = Buffer.alloc(expectedSize);
  let outPos = 0, bitPos = 0;
  const totalBits = input.length * 8;
  const getCode = (bits) => {
    let code = 0;
    for (let i = 0; i < bits; i++) {
      code = (code << 1) | ((input[bitPos >> 3] >> (7 - (bitPos & 7))) & 1);
      bitPos++;
    }
    return code;
  };
  let dict, dictSize, bits, oldCode;
  const reset = () => {
    dict = new Array(4096);
    for (let i = 0; i < 256; i++) dict[i] = Buffer.from([i]);
    dictSize = 258; bits = 9; oldCode = null;
  };
  reset();
  while (bitPos + bits <= totalBits && outPos < expectedSize) {
    const code = getCode(bits);
    if (code === 256) { reset(); continue; }
    if (code === 257) break;
    let entry;
    if (code < dictSize && dict[code]) entry = dict[code];
    else if (code === dictSize && oldCode !== null)
      entry = Buffer.concat([dict[oldCode], dict[oldCode].subarray(0, 1)]);
    else throw new Error("LZW: bad code");
    entry.copy(out, outPos); outPos += entry.length;
    if (oldCode !== null) dict[dictSize++] = Buffer.concat([dict[oldCode], entry.subarray(0, 1)]);
    if (dictSize === 511) bits = 10; else if (dictSize === 1023) bits = 11; else if (dictSize === 2047) bits = 12;
    oldCode = code;
  }
  return out;
}

function decodeTile(buf, hdr) {
  const expected = hdr.tileW * hdr.tileH * 4;
  let raw = hdr.compression === 5 ? lzwDecode(buf, expected) : zlib.inflateSync(buf);
  const { tileW, tileH, predictor } = hdr;
  const rowBytes = tileW * 4;
  const out = new Float32Array(tileW * tileH);
  if (predictor === 3) {
    // floating-point predictor: per row, undo byte differencing, then
    // reassemble each float from its four big-endian byte planes
    for (let r = 0; r < tileH; r++) {
      const row = raw.subarray(r * rowBytes, (r + 1) * rowBytes);
      for (let i = 1; i < rowBytes; i++) row[i] = (row[i] + row[i - 1]) & 0xff;
      for (let i = 0; i < tileW; i++) {
        const b0 = row[i], b1 = row[tileW + i], b2 = row[2 * tileW + i], b3 = row[3 * tileW + i];
        const bits = (b0 << 24) | (b1 << 16) | (b2 << 8) | b3;
        const dv = new DataView(new ArrayBuffer(4));
        dv.setUint32(0, bits >>> 0);
        out[r * tileW + i] = dv.getFloat32(0);
      }
    }
  } else if (predictor === 1) {
    for (let i = 0; i < out.length; i++) out[i] = raw.readFloatLE(i * 4);
  } else throw new Error(`predictor ${predictor} unsupported`);
  return out;
}

async function getBlock(t, hdr, blockIdx) {
  const key = `${t}/${blockIdx}`;
  if (blockCache.has(key)) {
    const v = blockCache.get(key);
    blockCache.delete(key); blockCache.set(key, v); // refresh LRU recency
    return v;
  }
  const off = hdr.offsets[blockIdx], cnt = hdr.counts[blockIdx];
  if (!cnt) return null;
  const buf = await fetchRange(hdr.url, off, off + cnt - 1);
  const data = decodeTile(buf, hdr);
  blockCache.set(key, data);
  while (blockCache.size > MAX_BLOCKS) blockCache.delete(blockCache.keys().next().value);
  return data;
}

async function pixelAt(t, hdr, px, py) {
  if (px < 0 || py < 0 || px >= hdr.width || py >= hdr.height) return null;
  const bx = Math.floor(px / hdr.tileW), by = Math.floor(py / hdr.tileH);
  const block = await getBlock(t, hdr, by * hdr.tilesAcross + bx);
  if (!block) return null;
  const v = block[(py - by * hdr.tileH) * hdr.tileW + (px - bx * hdr.tileW)];
  return v < -9000 ? null : v; // GDAL nodata -999999
}

/** Elevation in feet at lat/lon via bilinear interpolation, or null. */
async function sampleElevationFt(lat, lon) {
  const t = tileName(lat, lon);
  const hdr = await loadHeader(t);
  if (!hdr) return null; // tile absent (e.g. outside 3DEP staging)
  const fx = (lon - hdr.originX) / hdr.scaleX - 0.5;
  const fy = (hdr.originY - lat) / hdr.scaleY - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const dx = fx - x0, dy = fy - y0;
  const [v00, v10, v01, v11] = await Promise.all([
    pixelAt(t, hdr, x0, y0), pixelAt(t, hdr, x0 + 1, y0),
    pixelAt(t, hdr, x0, y0 + 1), pixelAt(t, hdr, x0 + 1, y0 + 1),
  ]);
  if ([v00, v10, v01, v11].some((v) => v === null)) {
    const v = v00 ?? v10 ?? v01 ?? v11;
    return v === null ? null : +(v * 3.28084).toFixed(1);
  }
  const m = v00 * (1 - dx) * (1 - dy) + v10 * dx * (1 - dy) + v01 * (1 - dx) * dy + v11 * dx * dy;
  return +(m * 3.28084).toFixed(1);
}

function cacheStats() {
  return { headers: headerCache.size, blocks: blockCache.size };
}

module.exports = { sampleElevationFt, tileName, cacheStats };

if (require.main === module) {
  const arg = process.argv.find((a, i) => process.argv[i - 1] === "--test");
  if (!arg) { console.error('usage: node dem.js --test "lat,lon[;lat,lon…]"'); process.exit(1); }
  (async () => {
    for (const pair of arg.split(";")) {
      const [lat, lon] = pair.split(",").map(Number);
      const t0 = Date.now();
      const ft = await sampleElevationFt(lat, lon);
      console.log(`${lat},${lon} → ${ft} ft  (${Date.now() - t0} ms, tile ${tileName(lat, lon)})`);
    }
    console.log("cache:", cacheStats());
  })().catch((e) => { console.error(e); process.exit(1); });
}
