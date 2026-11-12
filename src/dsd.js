// PCM -> DSD (DSF file) encoder. Runs as its own process so the heavy loop
// never blocks the web server:
//
//   node dsd.js <ffmpeg> <input> <output.dsf> <64|128>
//
// ffmpeg decodes and resamples the input to 1/8 of the DSD rate, this script
// interpolates the rest of the way and runs a 5th-order sigma-delta modulator
// per channel, then writes a standard stereo DSF file (1-bit, LSB first).
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const [ffmpeg, input, output, mult, gain] = process.argv.slice(2);
if (!ffmpeg || !input || !output) process.exit(2);
// Optional loudness correction in dB, worked out by the pipeline (a plain number).
const gainDb = Number.isFinite(Number(gain)) && gain !== undefined && gain !== '' ? Number(gain) : 0;

const DSD_RATE = 44100 * (mult === '128' ? 128 : 64);
const UP = 8; // interpolation done here
const PCM_RATE = DSD_RATE / UP;
const BLOCK = 4096; // DSF block size per channel
const GAIN = 0.5; // 0 dBFS PCM = 50% modulation, the SACD reference level
const LIMIT = 0.6; // modulator input ceiling
const ORDER = 5;
const HINF = 1.5; // peak noise-transfer gain (Lee criterion)

// ---- noise transfer function: zeros at DC, Butterworth high-pass poles

function denominator(order, fc) {
  const w = Math.tan(Math.PI * fc);
  let poly = [[1, 0]];
  for (let k = 0; k < order; k++) {
    const th = (Math.PI * (2 * k + order + 1)) / (2 * order);
    const sr = w * Math.cos(th); // s = w / p, with |p| = 1
    const si = -w * Math.sin(th);
    const dr = 1 - sr;
    const di = -si;
    const den = dr * dr + di * di;
    const zr = ((1 + sr) * dr + si * di) / den; // z = (1 + s) / (1 - s)
    const zi = (si * dr - (1 + sr) * di) / den;
    const next = Array.from({ length: poly.length + 1 }, () => [0, 0]);
    for (let i = 0; i < poly.length; i++) {
      next[i][0] += poly[i][0];
      next[i][1] += poly[i][1];
      next[i + 1][0] -= poly[i][0] * zr - poly[i][1] * zi;
      next[i + 1][1] -= poly[i][0] * zi + poly[i][1] * zr;
    }
    poly = next;
  }
  return poly.map((c) => c[0]);
}

function design(order, hinf) {
  const gainAtNyquist = (fc) => {
    const a = denominator(order, fc);
    let sum = 0;
    for (let k = 0; k <= order; k++) sum += a[k] * (k % 2 ? -1 : 1);
    return 2 ** order / Math.abs(sum);
  };
  let lo = 1e-4;
  let hi = 0.45;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (gainAtNyquist(mid) < hinf) lo = mid;
    else hi = mid;
  }
  const a = denominator(order, lo);
  const b = [1];
  for (let k = 1; k <= order; k++) b[k] = (-b[k - 1] * (order - k + 1)) / k; // (1 - z^-1)^order
  return { a, c: b.map((v, k) => v - a[k]) };
}

const { a, c } = design(ORDER, HINF);
const [, a1, a2, a3, a4, a5] = a;
const [, c1, c2, c3, c4, c5] = c;

// ---- output file

const fd = fs.openSync(output, 'w');
const HEADER = 28 + 52 + 12;
fs.writeSync(fd, Buffer.alloc(HEADER));
const blockL = Buffer.alloc(BLOCK);
const blockR = Buffer.alloc(BLOCK);
let pos = 0;
let bit = 0;
let curL = 0;
let curR = 0;
let samples = 0;
let dataBytes = 0;

function flush() {
  fs.writeSync(fd, blockL);
  fs.writeSync(fd, blockR);
  dataBytes += 2 * BLOCK;
  pos = 0;
}

// ---- modulator state (error-feedback form), one set per channel

const L = new Float64Array(10); // e1..e5, s1..s5
const R = new Float64Array(10);
let prevL = 0;
let prevR = 0;

function step(st, u) {
  const s =
    c1 * st[0] + c2 * st[1] + c3 * st[2] + c4 * st[3] + c5 * st[4] -
    a1 * st[5] - a2 * st[6] - a3 * st[7] - a4 * st[8] - a5 * st[9];
  const y = u + s;
  const v = y >= 0 ? 1 : -1;
  if (y > 12 || y < -12) {
    st.fill(0); // overload: reset rather than oscillate
    return v > 0 ? 1 : 0;
  }
  st[4] = st[3]; st[3] = st[2]; st[2] = st[1]; st[1] = st[0]; st[0] = v - y;
  st[9] = st[8]; st[8] = st[7]; st[7] = st[6]; st[6] = st[5]; st[5] = s;
  return v > 0 ? 1 : 0;
}

const clamp = (x) => (x > LIMIT ? LIMIT : x < -LIMIT ? -LIMIT : x);

function consume(buf, frames) {
  for (let f = 0; f < frames; f++) {
    const l = clamp(buf.readFloatLE(f * 8) * GAIN);
    const r = clamp(buf.readFloatLE(f * 8 + 4) * GAIN);
    const dl = (l - prevL) / UP;
    const dr = (r - prevR) / UP;
    for (let i = 1; i <= UP; i++) {
      curL |= step(L, prevL + dl * i) << bit;
      curR |= step(R, prevR + dr * i) << bit;
      if (++bit === 8) {
        blockL[pos] = curL;
        blockR[pos] = curR;
        curL = 0;
        curR = 0;
        bit = 0;
        if (++pos === BLOCK) flush();
      }
    }
    prevL = l;
    prevR = r;
  }
  samples += frames * UP;
}

function finish() {
  if (pos > 0 || bit > 0) {
    if (bit > 0) {
      blockL[pos] = curL;
      blockR[pos] = curR;
      pos++;
    }
    blockL.fill(0x69, pos); // DSD silence pattern
    blockR.fill(0x69, pos);
    flush();
  }
  const head = Buffer.alloc(HEADER);
  let o = 0;
  o += head.write('DSD ', o, 'latin1');
  o = head.writeBigUInt64LE(28n, o);
  o = head.writeBigUInt64LE(BigInt(HEADER + dataBytes), o); // total file size
  o = head.writeBigUInt64LE(0n, o); // no metadata yet
  o += head.write('fmt ', o, 'latin1');
  o = head.writeBigUInt64LE(52n, o);
  o = head.writeUInt32LE(1, o); // format version
  o = head.writeUInt32LE(0, o); // DSD raw
  o = head.writeUInt32LE(2, o); // channel type: stereo
  o = head.writeUInt32LE(2, o); // channels
  o = head.writeUInt32LE(DSD_RATE, o);
  o = head.writeUInt32LE(1, o); // 1 bit per sample, LSB first
  o = head.writeBigUInt64LE(BigInt(samples), o); // samples per channel
  o = head.writeUInt32LE(BLOCK, o);
  o = head.writeUInt32LE(0, o); // reserved
  o += head.write('data', o, 'latin1');
  head.writeBigUInt64LE(BigInt(12 + dataBytes), o);
  fs.writeSync(fd, head, 0, HEADER, 0);
  fs.closeSync(fd);
}

// ---- decode and resample with ffmpeg (argument array, no shell)

const ff = spawn(
  ffmpeg,
  ['-nostdin', '-v', 'error', '-i', input, '-vn', ...(gainDb ? ['-af', `volume=${gainDb.toFixed(2)}dB`] : []), '-ac', '2', '-ar', String(PCM_RATE), '-f', 'f32le', '-'],
  { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] },
);

let carry = Buffer.alloc(0);
ff.stdout.on('data', (chunk) => {
  const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
  const frames = Math.floor(buf.length / 8);
  consume(buf, frames);
  carry = Buffer.from(buf.subarray(frames * 8));
});
ff.on('error', () => process.exit(1));
ff.on('close', (code) => {
  if (code !== 0 || samples === 0) {
    fs.closeSync(fd);
    process.exit(1);
  }
  finish();
  process.exit(0);
});
