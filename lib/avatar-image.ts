/** Turns a chosen picture into a small square avatar, in the browser, before anything is uploaded. */
export const AVATAR_SIZE = 256;
export const AVATAR_MAX_INPUT_BYTES = 10 * 1024 * 1024;
const ACCEPTED = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"];

export class AvatarError extends Error {}

export function checkAvatarFile(file: { type: string; size: number }) {
  if (!ACCEPTED.includes(file.type)) throw new AvatarError("Choose a JPEG, PNG, WebP, GIF or AVIF picture.");
  if (file.size > AVATAR_MAX_INPUT_BYTES) throw new AvatarError(`That picture is over ${AVATAR_MAX_INPUT_BYTES / 1024 / 1024} MB.`);
}

/** Centre-crops to a square and scales to 256x256 (WebP when the browser can, else JPEG). */
export async function makeAvatar(file: File): Promise<{ blob: Blob; ext: "webp" | "jpg" }> {
  checkAvatarFile(file);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new AvatarError("That picture couldn't be read.");
  }
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = AVATAR_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new AvatarError("Your browser can't prepare pictures.");
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  bitmap.close();
  const toBlob = (type: string, q: number) => new Promise<Blob | null>((res) => canvas.toBlob(res, type, q));
  const webp = await toBlob("image/webp", 0.85);
  if (webp && webp.type === "image/webp") return { blob: webp, ext: "webp" };
  const jpg = await toBlob("image/jpeg", 0.88);
  if (!jpg) throw new AvatarError("That picture couldn't be prepared.");
  return { blob: jpg, ext: "jpg" };
}
