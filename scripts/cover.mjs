// -----------------------------------------------------------------------------
// Generates cover.png (800×534, the store size): a dark-to-teal gradient, a
// monitor with three load bars, and a bridge arc between the monitor and a
// house. Plain Node (zlib), no dependency. Run: npm run cover
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const WIDTH = 800;
const HEIGHT = 534;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.min(1, Math.max(0, t))));
const smooth = (edge, distance) => Math.min(1, Math.max(0, edge - distance + 0.5));

const DARK = [12, 20, 34];
const TEAL = [14, 96, 112];
const WHITE = [236, 244, 248];
const SCREEN = [18, 34, 52];
const BARS = [
  [70, 210, 140],
  [255, 184, 64],
  [90, 170, 255],
];

/** Distance from a point to a rounded rectangle (negative inside). */
function roundedBox(x, y, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(x - cx) - halfW + radius;
  const qy = Math.abs(y - cy) - halfH + radius;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** Distance from a point to a segment. */
function segment(x, y, x0, y0, x1, y1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const t = Math.min(1, Math.max(0, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy));
}

function pixel(x, y) {
  let color = mix(DARK, TEAL, (x / WIDTH) * 0.6 + (y / HEIGHT) * 0.4);
  // The monitor: frame, screen, stand.
  const frame = roundedBox(x, y, 270, 240, 170, 110, 14);
  color = mix(color, WHITE, smooth(0, frame + 1));
  color = mix(color, SCREEN, smooth(0, roundedBox(x, y, 270, 240, 156, 96, 8) + 1));
  color = mix(color, WHITE, smooth(0, roundedBox(x, y, 270, 372, 22, 22, 3) + 1));
  color = mix(color, WHITE, smooth(0, roundedBox(x, y, 270, 398, 80, 8, 6) + 1));
  // Three load bars on the screen.
  const fills = [0.72, 0.45, 0.9];
  for (const [i, fill] of fills.entries()) {
    const cy = 190 + i * 50;
    const track = roundedBox(x, y, 270, cy, 120, 12, 12);
    color = mix(color, [40, 60, 84], smooth(0, track + 1));
    const right = 150 + 240 * fill;
    if (x <= right) color = mix(color, BARS[i], smooth(0, track + 1));
  }
  // The bridge: an arc from the monitor to the house.
  const arc = Math.abs(Math.hypot(x - 520, y - 330) - 120);
  if (y < 330 && x > 420) color = mix(color, WHITE, smooth(4, arc) * 0.9);
  for (let px = 430; px <= 610; px += 30) {
    const top = 330 - Math.sqrt(Math.max(0, 120 * 120 - (px - 520) ** 2));
    color = mix(color, WHITE, smooth(2, segment(x, y, px, top, px, 330)) * 0.8);
  }
  color = mix(color, WHITE, smooth(3, segment(x, y, 400, 330, 640, 330)));
  // The house.
  const house = roundedBox(x, y, 690, 300, 56, 44, 4);
  color = mix(color, WHITE, smooth(0, house + 1));
  // The roof: a triangle above the walls.
  if (y >= 196 && y <= 262) {
    const inside = (y - 196) * (70 / 66) - Math.abs(x - 690);
    color = mix(color, WHITE, smooth(0, -inside));
  }
  color = mix(color, TEAL, smooth(0, roundedBox(x, y, 690, 318, 14, 26, 3) + 1));
  return color;
}

const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
for (let y = 0; y < HEIGHT; y += 1) {
  const row = y * (WIDTH * 3 + 1);
  raw[row] = 0;
  for (let x = 0; x < WIDTH; x += 1) {
    const [r, g, b] = pixel(x, y);
    raw.set([r, g, b], row + 1 + x * 3);
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(HEIGHT, 4);
header[8] = 8; // bit depth
header[9] = 2; // RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../cover.png', import.meta.url), png);
console.log(`cover.png: ${WIDTH}×${HEIGHT}, ${png.length} bytes`);
