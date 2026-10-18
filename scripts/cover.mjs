// Generates cover.png (800x534) for gladys-plugwise: plain Node, no dependency.
// Usage: node scripts/cover.mjs cover.png
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 800;
const H = 534;
const px = Buffer.alloc(W * H * 3);
const set = (x, y, [r, g, b], a = 1) => {
  x = Math.round(x);
  y = Math.round(y);
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = px[i] * (1 - a) + r * a;
  px[i + 1] = px[i + 1] * (1 - a) + g * a;
  px[i + 2] = px[i + 2] * (1 - a) + b * a;
};
// Background: diagonal gradient, deep blue to teal.
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const t = (x / W + y / H) / 2;
    set(x, y, [20 + 10 * t, 50 + 80 * t, 110 + 20 * t]);
  }
}
const white = [255, 255, 255];
const amber = [255, 200, 60];
const orange = [255, 130, 60];
const dark = [30, 45, 70];
const green = [80, 200, 140];
const disc = (cx, cy, r, color, alpha = 1) => {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y += 1) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x += 1) {
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const ring = (cx, cy, r, width, color, from = -Math.PI, to = Math.PI) => {
  for (let y = Math.floor(cy - r - width); y <= cy + r + width; y += 1) {
    for (let x = Math.floor(cx - r - width); x <= cx + r + width; x += 1) {
      const d = Math.hypot(x - cx, y - cy);
      const angle = Math.atan2(y - cy, x - cx);
      if (angle < from || angle > to) continue;
      const a = Math.max(0, Math.min(1, width / 2 - Math.abs(d - r) + 0.5));
      if (a > 0) set(x, y, color, a);
    }
  }
};
const roundRect = (x0, y0, x1, y1, r, color, alpha = 1) => {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const cx = Math.min(Math.max(x, x0 + r), x1 - r);
      const cy = Math.min(Math.max(y, y0 + r), y1 - r);
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const poly = (points, color, alpha = 1) => {
  const ys = points.map((p) => p[1]);
  const xs = points.map((p) => p[0]);
  for (let y = Math.floor(Math.min(...ys)); y <= Math.max(...ys); y += 1) {
    for (let x = Math.floor(Math.min(...xs)); x <= Math.max(...xs); x += 1) {
      let inside = false;
      for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
        const [xi, yi] = points[i];
        const [xj, yj] = points[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) set(x, y, color, alpha);
    }
  }
};

// Soft halos.
disc(270, 270, 230, white, 0.06);
disc(620, 300, 170, white, 0.05);
// The thermostat (an Anna): a round white body, its dial and the setpoint arc.
disc(270, 260, 165, white);
disc(270, 260, 130, dark);
ring(270, 260, 112, 14, [70, 90, 120], -Math.PI, Math.PI);
ring(270, 260, 112, 14, orange, -Math.PI * 0.95, -Math.PI * 0.15);
disc(270 + 112 * Math.cos(-Math.PI * 0.15), 260 + 112 * Math.sin(-Math.PI * 0.15), 12, white);
// A flame in the middle (the boiler).
poly(
  [
    [270, 195],
    [235, 270],
    [250, 305],
    [290, 305],
    [305, 270],
  ],
  orange,
);
disc(270, 285, 22, orange);
disc(270, 290, 11, amber);
// The smart meter (Smile P1): a box with its display and the lightning bolt.
roundRect(470, 70, 690, 250, 22, white);
roundRect(495, 95, 665, 150, 10, dark);
for (let i = 0; i < 5; i += 1) roundRect(507 + i * 31, 108, 530 + i * 31, 138, 4, amber);
poly(
  [
    [585, 160],
    [555, 215],
    [578, 215],
    [560, 245],
    [612, 195],
    [590, 195],
    [608, 160],
  ],
  amber,
);
// The plug: a rounded white square with its two holes and a green light.
roundRect(500, 300, 660, 460, 30, white);
disc(580, 380, 52, [225, 230, 238]);
disc(560, 380, 9, dark);
disc(600, 380, 9, dark);
disc(635, 325, 8, green);
// Local network waves (top left).
for (const r of [22, 38, 54]) ring(90, 90, r, 7, white, -Math.PI * 0.8, -Math.PI * 0.2);
disc(90, 90, 7, white);

// PNG encoding.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y += 1) {
  raw[y * (W * 3 + 1)] = 0;
  px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(process.argv[2] ?? 'cover.png', png);
console.log('cover', png.length, 'bytes');
