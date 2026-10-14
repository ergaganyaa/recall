import path from "node:path";
import { pathToFileURL } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { CanvasLike, PdfCanvasAdapter, PdfJsLike } from "@/lib/pdf";

/** Node implementation of the canvas adapter used by lib/pdf.ts (the browser uses a real canvas). */
export const nodeCanvas: PdfCanvasAdapter = {
  create: (w, h) => createCanvas(w, h) as unknown as CanvasLike,
  toBytes: async (c, mime, quality = 0.9) => {
    const cv = c as unknown as { toBuffer(m: string, q?: number): Buffer };
    return new Uint8Array(
      mime === "image/png" ? cv.toBuffer("image/png") : cv.toBuffer("image/jpeg", Math.round(quality * 100)),
    );
  },
};

let pdfjsPromise: Promise<PdfJsLike> | null = null;
export function loadPdfJsForTests(): Promise<PdfJsLike> {
  pdfjsPromise ??= (async () => {
    const mod = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfJsLike & {
      GlobalWorkerOptions: { workerSrc: string };
    };
    mod.GlobalWorkerOptions.workerSrc = pathToFileURL(
      path.resolve("node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"),
    ).href;
    return mod;
  })();
  return pdfjsPromise;
}

/** A decodable picture with enough structure not to count as blank. `variant` makes distinct artwork. */
export function artPng(w = 300, h = 200, variant = 0): Uint8Array {
  const c = createCanvas(w, h);
  const g = c.getContext("2d");
  const colors = ["#c0392b", "#2980b9", "#27ae60", "#8e44ad", "#d35400", "#16a085"];
  g.fillStyle = colors[variant % colors.length];
  g.fillRect(0, 0, w, h);
  g.fillStyle = "#ffffff";
  g.fillRect(w * 0.1, h * 0.15, w * 0.3, h * 0.5);
  g.fillStyle = "#111111";
  g.beginPath();
  g.arc(w * 0.7, h * 0.5, Math.min(w, h) * 0.25, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = colors[(variant + 3) % colors.length];
  g.fillRect(w * 0.5 + variant * 3, h * 0.05, w * 0.4, h * 0.1);
  return new Uint8Array(c.toBuffer("image/png"));
}

export type PageSpec = {
  size?: [number, number];
  /** Text lines. y is measured from the BOTTOM of the page, as in PDF. */
  lines?: { text: string; x?: number; y: number; size?: number; bold?: boolean }[];
  images?: { png: Uint8Array; x: number; y: number; width: number; height: number }[];
};

export async function makePdf(pages: PageSpec[], info?: { title?: string; author?: string }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  if (info?.title) doc.setTitle(info.title);
  if (info?.author) doc.setAuthor(info.author);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const spec of pages) {
    const page = doc.addPage(spec.size ?? [400, 600]);
    for (const im of spec.images ?? []) {
      const img = await doc.embedPng(im.png);
      page.drawImage(img, { x: im.x, y: im.y, width: im.width, height: im.height });
    }
    for (const l of spec.lines ?? []) {
      page.drawText(l.text, { x: l.x ?? 50, y: l.y, size: l.size ?? 12, font: l.bold ? bold : font });
    }
  }
  return new Uint8Array(await doc.save());
}

/** Lines of body text starting near the top of the page. */
export function bodyLines(texts: string[], startY = 480, step = 16, size = 12) {
  return texts.map((text, i) => ({ text, y: startY - i * step, size }));
}

/** Black line art on white (typical interior light-novel art): thin strokes on a mostly white page. */
export function lineArt(w: number, h: number, variant: number): Uint8Array {
  const c = createCanvas(w, h);
  const g = c.getContext("2d");
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, w, h);
  g.strokeStyle = "#000000";
  g.lineWidth = Math.max(1, w / 300);
  for (let i = 0; i < 6; i++) {
    g.beginPath();
    g.moveTo((((variant * 37 + i * 53) % 90) / 100) * w, (((variant * 17 + i * 29) % 90) / 100) * h);
    g.lineTo((((variant * 71 + i * 41) % 95) / 100) * w, (((variant * 23 + i * 67) % 95) / 100) * h);
    g.stroke();
  }
  g.beginPath();
  g.arc(w * (0.3 + 0.1 * variant), h * 0.5, Math.min(w, h) * 0.12, 0, 7);
  g.stroke();
  return new Uint8Array(c.toBuffer("image/png"));
}
