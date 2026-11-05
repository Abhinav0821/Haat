import { createHash } from "node:crypto";
import sharp from "sharp";

/**
 * Difference hash (dHash): resize to 9×8 greyscale and compare neighbouring
 * pixels. Survives re-compression, resizing and small edits, so a photo lifted
 * from another listing is still recognised. 64 bits → 16 hex chars.
 */
export async function dHash(image: Uint8Array): Promise<string> {
  const { data } = await sharp(image).rotate().greyscale().resize(9, 8, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  let hex = "";
  for (let nibble = 0; nibble < 16; nibble++) {
    let v = 0;
    for (let b = 0; b < 4; b++) {
      const i = nibble * 4 + b; // bit index 0..63
      const y = Math.floor(i / 8);
      const x = i % 8;
      v = (v << 1) | (data[y * 9 + x] > data[y * 9 + x + 1] ? 1 : 0);
    }
    hex += v.toString(16);
  }
  return hex;
}

const POPCOUNT = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

/** Number of differing bits between two 16-hex-char hashes. */
export function hamming(a: string, b: string): number {
  let n = 0;
  for (let i = 0; i < 16; i++) n += POPCOUNT[parseInt(a[i], 16) ^ parseInt(b[i], 16)];
  return n;
}

/** ≤ 10 of 64 bits differing ≈ the same photo. */
export const SAME_PHOTO_MAX_DISTANCE = 10;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
