import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c;
  }

  let crc = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ (-1)) >>> 0;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);

  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);

  return Buffer.concat([len, typeAndData, crc]);
}

function create256x256Png() {
  const width = 256;
  const height = 256;

  // Raw image data with 1 filter byte (0) per row
  const rowSize = 1 + width * 4;
  const rawData = Buffer.alloc(height * rowSize);

  // Draw an emerald green POS icon (#059669 = rgb(5, 150, 105)) with slate background (#0f172a = rgb(15, 23, 42))
  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowSize;
    rawData[rowOffset] = 0; // Filter byte: None

    for (let x = 0; x < width; x++) {
      const pixelOffset = rowOffset + 1 + x * 4;

      // Rounded rect border / badge
      const cx = x - 128;
      const cy = y - 128;
      const distSq = cx * cx + cy * cy;

      // Outer circle / rounded container
      if (distSq < 118 * 118) {
        // Shopping bag / cash register shape in center
        const inBag = (x >= 70 && x <= 186 && y >= 90 && y <= 196);
        const inHandle = (distSq < 60 * 60 && y < 100 && y > 60 && Math.abs(cx) > 20);

        if (inBag || inHandle) {
          // White symbol (#ffffff)
          rawData[pixelOffset] = 255;
          rawData[pixelOffset + 1] = 255;
          rawData[pixelOffset + 2] = 255;
          rawData[pixelOffset + 3] = 255;
        } else {
          // Emerald Green gradient background (#10b981 to #059669)
          const grad = y / 256;
          rawData[pixelOffset] = Math.round(16 * (1 - grad) + 5 * grad);
          rawData[pixelOffset + 1] = Math.round(185 * (1 - grad) + 150 * grad);
          rawData[pixelOffset + 2] = Math.round(129 * (1 - grad) + 105 * grad);
          rawData[pixelOffset + 3] = 255;
        }
      } else {
        // Transparent border
        rawData[pixelOffset] = 0;
        rawData[pixelOffset + 1] = 0;
        rawData[pixelOffset + 2] = 0;
        rawData[pixelOffset + 3] = 0;
      }
    }
  }

  // PNG Signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // Bit depth: 8
  ihdrData[9] = 6; // Color type: RGBA (6)
  ihdrData[10] = 0; // Compression
  ihdrData[11] = 0; // Filter
  ihdrData[12] = 0; // Interlace
  const ihdrChunk = makeChunk('IHDR', ihdrData);

  // IDAT chunk (compressed pixel data)
  const compressed = zlib.deflateSync(rawData, { level: 9 });
  const idatChunk = makeChunk('IDAT', compressed);

  // IEND chunk
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function createIcoFromPng(pngBuffer) {
  // ICO Header: 6 bytes
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // Reserved
  header.writeUInt16LE(1, 2); // 1 = ICO
  header.writeUInt16LE(1, 4); // 1 image

  // Icon Directory Entry: 16 bytes
  const dirEntry = Buffer.alloc(16);
  dirEntry.writeUInt8(0, 0); // Width: 256 -> 0
  dirEntry.writeUInt8(0, 1); // Height: 256 -> 0
  dirEntry.writeUInt8(0, 2); // Color count: 0 (no palette)
  dirEntry.writeUInt8(0, 3); // Reserved
  dirEntry.writeUInt16LE(1, 4); // Color planes: 1
  dirEntry.writeUInt16LE(32, 6); // Bits per pixel: 32
  dirEntry.writeUInt32LE(pngBuffer.length, 8); // Image size in bytes
  dirEntry.writeUInt32LE(22, 12); // Offset = 6 + 16 = 22

  return Buffer.concat([header, dirEntry, pngBuffer]);
}

const pngBuf = create256x256Png();
const icoBuf = createIcoFromPng(pngBuf);

fs.writeFileSync('resources/icons/icon.png', pngBuf);
fs.writeFileSync('resources/icons/icon.ico', icoBuf);

console.log('Created 256x256 icon.png (' + pngBuf.length + ' bytes) and icon.ico (' + icoBuf.length + ' bytes)');
