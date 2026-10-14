/**
 * Identifies an image from its bytes (never from its filename or declared type)
 * and reads its pixel size so the reader can reserve the right aspect ratio
 * before the image loads. Pure; works in the browser and in Node.
 */

export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"] as const;
export type ImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

export const EXTENSION_FOR: Record<ImageType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

export type ImageInfo = { mime: ImageType; width: number | null; height: number | null };

const ascii = (b: Uint8Array, start: number, len: number) =>
  String.fromCharCode(...b.subarray(start, start + len));
const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u32be = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u24le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);

export function sniffImage(b: Uint8Array): ImageInfo | null {
  if (b.length < 12) return null;

  // PNG
  if (b[0] === 0x89 && ascii(b, 1, 3) === "PNG") {
    return { mime: "image/png", width: u32be(b, 16) || null, height: u32be(b, 20) || null };
  }
  // GIF
  if (ascii(b, 0, 4) === "GIF8") {
    return { mime: "image/gif", width: u16le(b, 6) || null, height: u16le(b, 8) || null };
  }
  // JPEG: walk markers until a start-of-frame segment
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) {
        o++;
        continue;
      }
      const marker = b[o + 1];
      if (marker === 0xff) {
        o++;
        continue;
      }
      if ((marker >= 0xc0 && marker <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { mime: "image/jpeg", height: u16be(b, o + 5) || null, width: u16be(b, o + 7) || null };
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        o += 2;
        continue;
      }
      o += 2 + u16be(b, o + 2);
    }
    return { mime: "image/jpeg", width: null, height: null };
  }
  // WebP (RIFF....WEBP)
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    const kind = ascii(b, 12, 4);
    if (kind === "VP8X" && b.length >= 30) {
      return { mime: "image/webp", width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
    }
    if (kind === "VP8 " && b.length >= 30) {
      return { mime: "image/webp", width: u16le(b, 26) & 0x3fff || null, height: u16le(b, 28) & 0x3fff || null };
    }
    if (kind === "VP8L" && b.length >= 25) {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { mime: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return { mime: "image/webp", width: null, height: null };
  }
  // AVIF (ISO BMFF "ftyp" with an avif brand)
  if (ascii(b, 4, 4) === "ftyp" && /avif|avis/.test(ascii(b, 8, 12))) {
    return { mime: "image/avif", width: null, height: null };
  }
  return null;
}
