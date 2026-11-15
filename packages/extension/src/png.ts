/**
 * Rasterizes an export scene to a PNG. The encoder is plain Node zlib,
 * so the extension does not ship a native image library.
 */

import { deflateSync } from 'node:zlib';
import type { ExportScene, ExportSceneEdge } from '@codeflow/shared';

const SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_EDGE = 4096;

/** 5×7 glyphs. Each row is five bits, left to right. */
const GLYPHS = parseGlyphs(`
  00000,00000,00000,00000,00000,00000,00000
! 00100,00100,00100,00100,00100,00000,00100
" 01010,01010,01010,00000,00000,00000,00000
# 01010,11111,01010,01010,11111,01010,00000
' 00100,00100,01000,00000,00000,00000,00000
( 00010,00100,01000,01000,01000,00100,00010
) 01000,00100,00010,00010,00010,00100,01000
+ 00000,00100,00100,11111,00100,00100,00000
, 00000,00000,00000,00000,00100,00100,01000
- 00000,00000,00000,11111,00000,00000,00000
. 00000,00000,00000,00000,00000,01100,01100
/ 00001,00010,00010,00100,01000,01000,10000
0 01110,10001,10011,10101,11001,10001,01110
1 00100,01100,00100,00100,00100,00100,01110
2 01110,10001,00001,00010,00100,01000,11111
3 11111,00010,00100,00010,00001,10001,01110
4 00010,00110,01010,10010,11111,00010,00010
5 11111,10000,11110,00001,00001,10001,01110
6 00110,01000,10000,11110,10001,10001,01110
7 11111,00001,00010,00100,01000,01000,01000
8 01110,10001,10001,01110,10001,10001,01110
9 01110,10001,10001,01111,00001,00010,01100
: 00000,01100,01100,00000,01100,01100,00000
? 01110,10001,00001,00010,00100,00000,00100
A 01110,10001,10001,11111,10001,10001,10001
B 11110,10001,10001,11110,10001,10001,11110
C 01110,10001,10000,10000,10000,10001,01110
D 11110,10001,10001,10001,10001,10001,11110
E 11111,10000,10000,11110,10000,10000,11111
F 11111,10000,10000,11110,10000,10000,10000
G 01110,10001,10000,10111,10001,10001,01111
H 10001,10001,10001,11111,10001,10001,10001
I 01110,00100,00100,00100,00100,00100,01110
J 00111,00010,00010,00010,10010,10010,01100
K 10001,10010,10100,11000,10100,10010,10001
L 10000,10000,10000,10000,10000,10000,11111
M 10001,11011,10101,10101,10001,10001,10001
N 10001,11001,10101,10011,10001,10001,10001
O 01110,10001,10001,10001,10001,10001,01110
P 11110,10001,10001,11110,10000,10000,10000
Q 01110,10001,10001,10001,10101,10010,01101
R 11110,10001,10001,11110,10100,10010,10001
S 01111,10000,10000,01110,00001,00001,11110
T 11111,00100,00100,00100,00100,00100,00100
U 10001,10001,10001,10001,10001,10001,01110
V 10001,10001,10001,10001,10001,01010,00100
W 10001,10001,10001,10101,10101,10101,01010
X 10001,10001,01010,00100,01010,10001,10001
Y 10001,10001,01010,00100,00100,00100,00100
Z 11111,00001,00010,00100,01000,10000,11111
a 00000,00000,01110,00001,01111,10001,01111
b 10000,10000,11110,10001,10001,10001,11110
c 00000,00000,01110,10000,10000,10001,01110
d 00001,00001,01111,10001,10001,10001,01111
e 00000,00000,01110,10001,11111,10000,01110
f 00110,01001,01000,11100,01000,01000,01000
g 00000,00000,01111,10001,01111,00001,01110
h 10000,10000,11110,10001,10001,10001,10001
i 00100,00000,01100,00100,00100,00100,01110
j 00010,00000,00110,00010,00010,10010,01100
k 10000,10000,10010,10100,11000,10100,10010
l 01100,00100,00100,00100,00100,00100,01110
m 00000,00000,11010,10101,10101,10001,10001
n 00000,00000,11110,10001,10001,10001,10001
o 00000,00000,01110,10001,10001,10001,01110
p 00000,00000,11110,10001,11110,10000,10000
q 00000,00000,01111,10001,01111,00001,00001
r 00000,00000,10110,11001,10000,10000,10000
s 00000,00000,01111,10000,01110,00001,11110
t 01000,01000,11100,01000,01000,01001,00110
u 00000,00000,10001,10001,10001,10011,01101
v 00000,00000,10001,10001,10001,01010,00100
w 00000,00000,10001,10001,10101,10101,01010
x 00000,00000,10001,01010,00100,01010,10001
y 00000,00000,10001,10001,01111,00001,01110
z 00000,00000,11111,00010,00100,01000,11111
_ 00000,00000,00000,00000,00000,00000,11111
`);

export function sceneToPng(scene: ExportScene, scale: number): Buffer {
  const factor = Math.min(4, Math.max(1, Math.round(scale)));
  let width = Math.max(1, Math.round(scene.width * factor));
  let height = Math.max(1, Math.round(scene.height * factor));
  let drawScale = factor;
  if (width > MAX_EDGE || height > MAX_EDGE) {
    const fit = Math.min(MAX_EDGE / width, MAX_EDGE / height);
    drawScale = factor * fit;
    width = Math.max(1, Math.round(scene.width * drawScale));
    height = Math.max(1, Math.round(scene.height * drawScale));
  }
  const pixels = new Uint8Array(width * height * 3);
  fillRect(pixels, width, height, 0, 0, width, height, parseColor(scene.background));
  for (const group of scene.groups) {
    strokeRect(
      pixels,
      width,
      height,
      scaleBox(group, drawScale),
      parseColor(group.stroke),
      Math.max(1, Math.round(drawScale)),
    );
    drawText(
      pixels,
      width,
      height,
      group.label,
      group.x * drawScale + 6,
      group.y * drawScale + 4,
      drawScale,
      parseColor(group.color),
    );
  }
  for (const edge of scene.edges) {
    drawEdge(pixels, width, height, edge, drawScale);
  }
  for (const node of scene.nodes) {
    const box = scaleBox(node, drawScale);
    fillRect(pixels, width, height, box.x, box.y, box.width, box.height, parseColor(node.fill));
    strokeRect(
      pixels,
      width,
      height,
      box,
      parseColor(node.stroke),
      Math.max(1, Math.round(drawScale)),
    );
    drawText(
      pixels,
      width,
      height,
      node.title,
      box.x + 4 * drawScale,
      box.y + 6 * drawScale,
      drawScale,
      parseColor(node.color),
    );
    if (node.subtitle) {
      drawText(
        pixels,
        width,
        height,
        node.subtitle,
        box.x + 4 * drawScale,
        box.y + 18 * drawScale,
        drawScale,
        parseColor(node.color),
      );
    }
  }
  return encodePng(width, height, pixels);
}

export function readPngSize(bytes: Uint8Array): {
  readonly width: number;
  readonly height: number;
} {
  if (bytes.length < 24 || !SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    throw new Error('Not a PNG.');
  }
  const width = readUint32(bytes, 16);
  const height = readUint32(bytes, 20);
  return { width, height };
}

function drawEdge(
  pixels: Uint8Array,
  width: number,
  height: number,
  edge: ExportSceneEdge,
  scale: number,
): void {
  const color = parseColor(edge.color);
  const x1 = Math.round(edge.x1 * scale);
  const y1 = Math.round(edge.y1 * scale);
  const x2 = Math.round(edge.x2 * scale);
  const y2 = Math.round(edge.y2 * scale);
  const dash = Math.max(3, Math.round(4 * scale));
  let index = 0;
  for (const point of linePoints(x1, y1, x2, y2)) {
    if (!edge.dashed || Math.floor(index / dash) % 2 === 0) {
      setPixel(pixels, width, height, point.x, point.y, color);
    }
    index += 1;
  }
  const head = Math.max(2, Math.round(3 * scale));
  fillRect(pixels, width, height, x2 - head, y2 - head / 2, head, head, color);
  if (edge.label) {
    drawText(
      pixels,
      width,
      height,
      edge.label,
      (x1 + x2) / 2,
      (y1 + y2) / 2 - 8 * scale,
      scale,
      color,
    );
  }
}

function drawText(
  pixels: Uint8Array,
  width: number,
  height: number,
  text: string,
  x: number,
  y: number,
  scale: number,
  color: Rgb,
): void {
  const step = Math.max(1, Math.round(scale));
  let cursor = Math.round(x);
  const top = Math.round(y);
  for (const character of text) {
    const rows = GLYPHS.get(character) ?? GLYPHS.get(character.toUpperCase());
    if (!rows) {
      cursor += 4 * step;
      continue;
    }
    rows.forEach((bits, row) => {
      for (let column = 0; column < 5; column += 1) {
        if ((bits & (1 << (4 - column))) === 0) {
          continue;
        }
        fillRect(
          pixels,
          width,
          height,
          cursor + column * step,
          top + row * step,
          step,
          step,
          color,
        );
      }
    });
    cursor += 6 * step;
  }
}

function linePoints(x1: number, y1: number, x2: number, y2: number): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  let x = x1;
  let y = y1;
  const dx = Math.abs(x2 - x1);
  const dy = Math.abs(y2 - y1);
  const sx = x1 < x2 ? 1 : -1;
  const sy = y1 < y2 ? 1 : -1;
  let error = dx - dy;
  for (let guard = 0; guard < 100_000; guard += 1) {
    points.push({ x, y });
    if (x === x2 && y === y2) {
      break;
    }
    const doubled = 2 * error;
    if (doubled > -dy) {
      error -= dy;
      x += sx;
    }
    if (doubled < dx) {
      error += dx;
      y += sy;
    }
  }
  return points;
}

function fillRect(
  pixels: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  rectWidth: number,
  rectHeight: number,
  color: Rgb,
): void {
  const left = Math.max(0, Math.floor(x));
  const top = Math.max(0, Math.floor(y));
  const right = Math.min(width, Math.ceil(x + rectWidth));
  const bottom = Math.min(height, Math.ceil(y + rectHeight));
  for (let row = top; row < bottom; row += 1) {
    for (let column = left; column < right; column += 1) {
      setPixel(pixels, width, height, column, row, color);
    }
  }
}

function strokeRect(
  pixels: Uint8Array,
  width: number,
  height: number,
  box: { x: number; y: number; width: number; height: number },
  color: Rgb,
  weight: number,
): void {
  fillRect(pixels, width, height, box.x, box.y, box.width, weight, color);
  fillRect(pixels, width, height, box.x, box.y + box.height - weight, box.width, weight, color);
  fillRect(pixels, width, height, box.x, box.y, weight, box.height, color);
  fillRect(pixels, width, height, box.x + box.width - weight, box.y, weight, box.height, color);
}

function setPixel(
  pixels: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  color: Rgb,
): void {
  const column = Math.round(x);
  const row = Math.round(y);
  if (column < 0 || row < 0 || column >= width || row >= height) {
    return;
  }
  const offset = (row * width + column) * 3;
  pixels[offset] = color.r;
  pixels[offset + 1] = color.g;
  pixels[offset + 2] = color.b;
}

function encodePng(width: number, height: number, pixels: Uint8Array): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const start = row * (stride + 1);
    raw[start] = 0;
    pixels.subarray(row * stride, (row + 1) * stride).forEach((byte, index) => {
      raw[start + 1 + index] = byte;
    });
  }
  const compressed = deflateSync(raw);
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

function parseColor(value: string): Rgb {
  const match = /^#([0-9a-fA-F]{6})$/.exec(value);
  if (!match?.[1]) {
    return { r: 30, g: 30, b: 30 };
  }
  return {
    r: Number.parseInt(match[1].slice(0, 2), 16),
    g: Number.parseInt(match[1].slice(2, 4), 16),
    b: Number.parseInt(match[1].slice(4, 6), 16),
  };
}

function scaleBox(
  box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  scale: number,
): { x: number; y: number; width: number; height: number } {
  return {
    x: box.x * scale,
    y: box.y * scale,
    width: box.width * scale,
    height: box.height * scale,
  };
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function parseGlyphs(source: string): Map<string, number[]> {
  const glyphs = new Map<string, number[]>([[' ', [0, 0, 0, 0, 0, 0, 0]]]);
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    const separator = line.indexOf(' ');
    if (separator !== 1) {
      continue;
    }
    const character = line.slice(0, separator);
    const rows = line.slice(separator + 1).split(',');
    if (rows.length !== 7) {
      continue;
    }
    glyphs.set(
      character,
      rows.map((row) => Number.parseInt(row, 2)),
    );
  }
  return glyphs;
}
