"use client";

import type { CanvasLike, PdfCanvasAdapter, PdfJsLike } from "./pdf";

/**
 * Loads pdf.js in the browser (on demand, so the import page stays light until a PDF is chosen).
 * The worker file is copied to /public by scripts/copy-pdf-worker.mjs so its version always
 * matches the installed library.
 */
export async function loadPdfJs(): Promise<PdfJsLike> {
  const mod = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfJsLike & {
    GlobalWorkerOptions: { workerSrc: string };
  };
  mod.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  return mod;
}

export const browserCanvas: PdfCanvasAdapter = {
  create(width, height) {
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    return c as unknown as CanvasLike;
  },
  toBytes(canvas, mime, quality = 0.9) {
    return new Promise((resolve, reject) => {
      (canvas as unknown as HTMLCanvasElement).toBlob(
        async (blob) => (blob ? resolve(new Uint8Array(await blob.arrayBuffer())) : reject(new Error("Couldn't encode the image."))),
        mime,
        quality,
      );
    });
  },
};

/** Shrinks any browser-decodable picture to a cover-sized JPEG (used for a cover the user uploads). */
export async function makeCoverThumbnail(
  file: Blob,
  maxWidth = 900,
): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  try {
    const k = Math.min(1, maxWidth / bitmap.width);
    const w = Math.max(1, Math.round(bitmap.width * k));
    const h = Math.max(1, Math.round(bitmap.height * k));
    const canvas = browserCanvas.create(w, h);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    return { bytes: await browserCanvas.toBytes(canvas, "image/jpeg", 0.88), width: w, height: h };
  } finally {
    bitmap.close();
  }
}
