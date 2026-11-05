import { externalError } from './windows-reader.mjs';

/** Bound decoded size before any client/provider receives compressed pixels. */
export function verifyExternalImage(bytes, name) {
  let width = 0;
  let height = 0;
  if (/\.png$/i.test(name) && bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && bytes.toString('ascii', 12, 16) === 'IHDR') {
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
    for (let at = 8; at + 12 <= bytes.length;) {
      const size = bytes.readUInt32BE(at);
      if (bytes.toString('ascii', at + 4, at + 8) === 'acTL' || size > bytes.length - at - 12) throw externalError();
      at += size + 12;
    }
  } else if (/\.jpe?g$/i.test(name) && bytes[0] === 255 && bytes[1] === 216) {
    for (let at = 2; at + 4 < bytes.length;) {
      if (bytes[at++] !== 255) break;
      while (bytes[at] === 255) at++;
      const marker = bytes[at++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (at + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(at);
      if (length < 2 || at + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
        height = bytes.readUInt16BE(at + 3); width = bytes.readUInt16BE(at + 5); break;
      }
      at += length;
    }
  } else if (/\.webp$/i.test(name) && bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const kind = bytes.toString('ascii', 12, 16);
    if (kind === 'VP8X' && !(bytes[20] & 2)) {
      width = bytes.readUIntLE(24, 3) + 1; height = bytes.readUIntLE(27, 3) + 1;
    } else if (kind === 'VP8 ' && bytes.toString('hex', 23, 26) === '9d012a') {
      width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff;
    } else if (kind === 'VP8L' && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21);
      width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
    }
  }
  if (!width || !height || width > 8192 || height > 8192 || width * height > 16000000) throw externalError();
  return { width, height };
}
