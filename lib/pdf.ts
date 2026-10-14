/* eslint-disable @typescript-eslint/no-explicit-any -- pdf.js is consumed through a small structural interface */
/**
 * PDF → structured volume (browser or Node). Reuses the ParsedVolume shape the EPUB
 * and text importers produce, so the preview/import pipeline is shared.
 *
 * What it does:
 *  - text pages: lines → paragraphs in reading order; running headers/page numbers removed;
 *  - illustrations on text pages: located from the page's operator list and cropped from a
 *    rendered copy of the page, placed between the paragraphs around them;
 *  - pages with no text but with pictures: the WHOLE page is rendered as one image
 *    (so the same artwork is never extracted twice);
 *  - scanned PDFs (no selectable text): detected and reported. OCR is NOT included.
 */
import { buildImageReport, foldedNotice, foldInlineIllustrationChapters } from "./chapter-merge";
import type { ParsedBlock, ParsedChapter, ParsedImage, ParsedVolume } from "./epub";
import { sniffImage } from "./image-sniff";
import {
  bodyHeightOf,
  buildLines,
  buildParagraphs,
  classifyHeading,
  findRunningLines,
  type Line,
  type Paragraph,
  type RawItem,
} from "./pdf-layout";

export type PdfErrorCode = "encrypted" | "corrupt" | "too_large" | "too_many_pages" | "unsupported" | "needs_ocr" | "cancelled";
export class PdfError extends Error {
  constructor(
    public code: PdfErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const PDF_MAX_BYTES = 150 * 1024 * 1024;
export const PDF_MAX_PAGES = 1500;

// ------------------------------------------------------------------ environment adapters
export type CanvasLike = { width: number; height: number; getContext(type: "2d"): any };
export type PdfCanvasAdapter = {
  create(width: number, height: number): CanvasLike;
  toBytes(canvas: CanvasLike, mime: "image/jpeg" | "image/png", quality?: number): Promise<Uint8Array>;
};
export type PdfJsLike = {
  getDocument(src: any): { promise: Promise<any>; destroy(): Promise<void> };
  OPS: Record<string, number>;
};

export type PdfOptions = {
  pdfjs: PdfJsLike;
  canvas: PdfCanvasAdapter;
  onProgress?: (done: number, total: number, label: string) => void;
  signal?: AbortSignal;
};

// ------------------------------------------------------------------ small helpers
type Matrix = [number, number, number, number, number, number];
/** Canvas-style multiplication: apply `b` first, then `a`. */
const mul = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];
const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
function throwIfCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new PdfError("cancelled", "The import was cancelled.");
}

/** Opens a PDF and turns pdf.js failures into plain-language errors. */
async function openPdf(bytes: Uint8Array, opts: PdfOptions) {
  if (bytes.byteLength > PDF_MAX_BYTES) {
    throw new PdfError("too_large", `This PDF is ${(bytes.byteLength / 1e6).toFixed(0)} MB; the limit is ${PDF_MAX_BYTES / 1e6} MB.`);
  }
  // pdf.js takes ownership of the buffer it is given, so hand it a copy.
  const task = opts.pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: true });
  let pdf: any;
  try {
    pdf = await task.promise;
  } catch (e: any) {
    const name = String(e?.name ?? "");
    if (name === "PasswordException") {
      throw new PdfError("encrypted", "This PDF is password-protected. Remove the password (open it, then print/save as a new PDF) and try again.");
    }
    if (name === "InvalidPDFException") throw new PdfError("corrupt", "This file is damaged or isn't a valid PDF.");
    if (name === "MissingPDFException") throw new PdfError("corrupt", "The PDF couldn't be found or read.");
    throw new PdfError("unsupported", `This PDF couldn't be opened (${e?.message ?? "unknown error"}).`);
  }
  if (pdf.numPages > PDF_MAX_PAGES) {
    await task.destroy();
    throw new PdfError("too_many_pages", `This PDF has ${pdf.numPages} pages; the limit is ${PDF_MAX_PAGES}. Split it into volumes first.`);
  }
  return { pdf, close: () => task.destroy() };
}

// ------------------------------------------------------------------ per-page analysis
export type ImagePlacement = { x0: number; y0: number; x1: number; y1: number; nativeW: number; nativeH: number };
export type PageScan = {
  index: number; // 0-based
  width: number;
  height: number;
  items: RawItem[];
  textChars: number;
  images: ImagePlacement[];
  /** Any picture-painting operator, including 1-bit scan masks (used for classification only). */
  hasPictureOps: boolean;
};

async function scanPage(page: any, pdfjs: PdfJsLike, index: number): Promise<PageScan> {
  const vp = page.getViewport({ scale: 1 });
  const T = vp.transform as Matrix;
  const text = await page.getTextContent();
  const items: RawItem[] = [];
  let textChars = 0;
  for (const it of text.items as any[]) {
    if (typeof it.str !== "string") continue;
    const [x, y] = apply(T, it.transform[4], it.transform[5]);
    items.push({ str: it.str, x, y, width: Math.abs(it.width), height: Math.abs(it.height) || Math.abs(it.transform[3]) || 10 });
    textChars += it.str.replace(/\s/g, "").length;
  }

  const OPS = pdfjs.OPS;
  const ops = await page.getOperatorList();
  const images: ImagePlacement[] = [];
  let hasPictureOps = false;
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];

  const place = (nativeW: number, nativeH: number) => {
    const full = mul(T, ctm);
    const pts = [apply(full, 0, 0), apply(full, 1, 0), apply(full, 0, 1), apply(full, 1, 1)];
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    images.push({
      x0: Math.max(0, Math.min(...xs)),
      y0: Math.max(0, Math.min(...ys)),
      x1: Math.min(vp.width, Math.max(...xs)),
      y1: Math.min(vp.height, Math.max(...ys)),
      nativeW,
      nativeH,
    });
  };

  ops.fnArray.forEach((fn: number, i: number) => {
    const args = ops.argsArray[i];
    switch (fn) {
      case OPS.save:
        stack.push(ctm);
        break;
      case OPS.restore:
        ctm = stack.pop() ?? ctm;
        break;
      case OPS.transform:
        ctm = mul(ctm, args as Matrix);
        break;
      case OPS.paintFormXObjectBegin:
        stack.push(ctm);
        if (Array.isArray(args?.[0])) ctm = mul(ctm, args[0] as Matrix);
        break;
      case OPS.paintFormXObjectEnd:
        ctm = stack.pop() ?? ctm;
        break;
      case OPS.paintImageXObject:
        hasPictureOps = true;
        place(Number(args?.[1]) || 0, Number(args?.[2]) || 0);
        break;
      case OPS.paintInlineImageXObject:
        hasPictureOps = true;
        place(Number(args?.[0]?.width) || 0, Number(args?.[0]?.height) || 0);
        break;
      case OPS.paintImageMaskXObject:
        // 1-bit "stencil" pictures (typical for black line art) have a position like any other picture.
        hasPictureOps = true;
        place(Number(args?.[0]?.width) || 0, Number(args?.[0]?.height) || 0);
        break;
      default:
        if (
          fn === OPS.paintImageMaskXObjectGroup ||
          fn === OPS.paintImageMaskXObjectRepeat ||
          fn === OPS.paintImageXObjectRepeat ||
          fn === OPS.paintJpegXObject
        ) {
          hasPictureOps = true;
        }
    }
  });

  return { index, width: vp.width, height: vp.height, items, textChars, images, hasPictureOps };
}

// ------------------------------------------------------------------ rendering & measuring
async function renderPage(page: any, scale: number, adapter: PdfCanvasAdapter): Promise<CanvasLike> {
  const vp = page.getViewport({ scale });
  const canvas = adapter.create(Math.max(1, Math.ceil(vp.width)), Math.max(1, Math.ceil(vp.height)));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise;
  return canvas;
}

type Fingerprint = { blank: boolean; vec: number[] };

/**
 * Looks at a region at low resolution to answer two questions:
 *  - is it blank? (almost every pixel matches the background colour; a page with a single
 *    thin line or a small logo is NOT blank)
 *  - is it the same artwork as one already seen? (an 8×8 colour grid, compared by distance)
 */
function fingerprint(src: CanvasLike, adapter: PdfCanvasAdapter, sx: number, sy: number, sw: number, sh: number): Fingerprint {
  // 192px keeps thin black strokes (line art) visible after downsampling; 96px averaged them away.
  const N = 192;
  const t = adapter.create(N, N);
  const ctx = t.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, N, N);
  ctx.drawImage(src, sx, sy, Math.max(1, sw), Math.max(1, sh), 0, 0, N, N);
  const d = ctx.getImageData(0, 0, N, N).data as Uint8ClampedArray;

  const gray = new Array<number>(N * N);
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < N * N; i++) {
    const g = Math.round(0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]);
    gray[i] = g;
    hist[g]++;
  }
  const background = hist.indexOf(Math.max(...hist));
  const differing = gray.filter((g) => Math.abs(g - background) > 24).length / (N * N);

  // 8×8 grid of average RGB (each cell is 12×12 pixels).
  const vec: number[] = [];
  const cell = N / 8;
  for (let cy = 0; cy < 8; cy++) {
    for (let cx = 0; cx < 8; cx++) {
      const sum = [0, 0, 0];
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
          const p = ((cy * cell + y) * N + (cx * cell + x)) * 4;
          sum[0] += d[p];
          sum[1] += d[p + 1];
          sum[2] += d[p + 2];
        }
      }
      vec.push(sum[0] / (cell * cell), sum[1] / (cell * cell), sum[2] / (cell * cell));
    }
  }
  return { blank: differing < 0.0003, vec };
}

/** Mean absolute colour difference between two fingerprints (0 = identical). */
const artDistance = (a: number[], b: number[]) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;

// A picture is only treated as "the same" when it is drawn over the same place on the SAME page, or
// is a near-identical decoration repeated in a page margin. Colour fingerprints are far too coarse to
// decide that two pictures in the body are the same (mostly-white line art all looks alike).
const MARGIN_REPEAT_DISTANCE = 3;
const MIN_PICTURE_PT = 14;
const BACKGROUND_TEXT_MIN_CHARS = 300;

/** Share of the smaller rectangle covered by the overlap of two placements (1 = fully inside the other). */
function overlapRatio(a: ImagePlacement, b: ImagePlacement) {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (w <= 0 || h <= 0) return 0;
  const smaller = Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0));
  return smaller > 0 ? (w * h) / smaller : 0;
}

async function cropToImage(
  src: CanvasLike,
  adapter: PdfCanvasAdapter,
  r: { sx: number; sy: number; sw: number; sh: number },
  maxWidth: number,
  mime: "image/jpeg" | "image/png",
  quality = 0.88,
): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const k = Math.min(1, maxWidth / r.sw);
  const w = Math.max(1, Math.round(r.sw * k));
  const h = Math.max(1, Math.round(r.sh * k));
  const out = adapter.create(w, h);
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(src, r.sx, r.sy, r.sw, r.sh, 0, 0, w, h);
  return { bytes: await adapter.toBytes(out, mime, quality), width: w, height: h };
}

const MAX_RENDER_PIXELS = 18_000_000;

// ------------------------------------------------------------------ public: inspect
export type PdfInspection = {
  pageCount: number;
  textPages: number;
  picturePages: number; // no selectable text, but pictures
  blankPages: number; // nothing at all
  /** Mostly pages of pictures without selectable text: needs OCR to become searchable text. */
  scanned: boolean;
  title: string | null;
  author: string | null;
};

const TEXT_PAGE_MIN_CHARS = 25;

/** Cheap pass: classifies every page without rendering anything. */
export async function inspectPdf(bytes: Uint8Array, opts: PdfOptions): Promise<PdfInspection> {
  const { pdf, close } = await openPdf(bytes, opts);
  try {
    let textPages = 0;
    let picturePages = 0;
    let blankPages = 0;
    for (let i = 1; i <= pdf.numPages; i++) {
      throwIfCancelled(opts.signal);
      const page = await pdf.getPage(i);
      const s = await scanPage(page, opts.pdfjs, i - 1);
      if (s.textChars >= TEXT_PAGE_MIN_CHARS) textPages++;
      else if (s.hasPictureOps) picturePages++;
      else blankPages++;
      page.cleanup();
      if (i % 10 === 0) {
        opts.onProgress?.(i, pdf.numPages, "Checking pages…");
        await tick();
      }
    }
    const meta = await pdf.getMetadata().catch(() => null);
    const content = textPages + picturePages;
    return {
      pageCount: pdf.numPages,
      textPages,
      picturePages,
      blankPages,
      scanned: content > 0 && textPages / content < 0.2 && picturePages >= 3,
      title: cleanMeta(meta?.info?.Title),
      author: cleanMeta(meta?.info?.Author),
    };
  } finally {
    await close();
  }
}

const cleanMeta = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 300) : null);

// ------------------------------------------------------------------ public: parse
export type PdfParseOptions = PdfOptions & {
  /** "text" = normal import (fails with needs_ocr for scanned files); "pages-as-images" = render every page. */
  mode?: "text" | "pages-as-images";
};

export type PdfVolume = ParsedVolume & {
  pageCount: number;
  structure: "outline" | "headings" | "single";
  scanned: boolean;
  /** No OCR engine is bundled; scanned pages can only be imported as images. */
  ocrAvailable: false;
  /**
   * Picture accounting: found = kept + decorations + duplicates + backgrounds + blank,
   * so a picture is never lost without being counted under a reason.
   */
  imageStats: { found: number; kept: number; decorations: number; duplicates: number; backgrounds: number; blank: number };
};

type PageImageRef = { ref: string; y: number; x: number };
type PageBuild = { scan: PageScan; images: PageImageRef[]; wholePage: string | null; blank: boolean };

export async function parsePdf(bytes: Uint8Array, opts: PdfParseOptions): Promise<PdfVolume> {
  const mode = opts.mode ?? "text";
  const adapter = opts.canvas;
  const { pdf, close } = await openPdf(bytes, opts);
  const warnings: string[] = [];
  const images = new Map<string, ParsedImage>();
  const marginSeen: number[][] = []; // fingerprints of pictures already seen in a page margin (running decorations)

  try {
    const total = pdf.numPages;

    // ---- pass 1: scan every page
    const scans: PageScan[] = [];
    for (let i = 1; i <= total; i++) {
      throwIfCancelled(opts.signal);
      const page = await pdf.getPage(i);
      scans.push(await scanPage(page, opts.pdfjs, i - 1));
      page.cleanup();
      if (i % 5 === 0 || i === total) {
        opts.onProgress?.(i, total, `Reading page ${i} of ${total}`);
        await tick();
      }
    }

    const isTextPage = (s: PageScan) => s.textChars >= TEXT_PAGE_MIN_CHARS;
    const textPages = scans.filter(isTextPage).length;
    const picturePages = scans.filter((s) => !isTextPage(s) && s.hasPictureOps).length;
    const content = textPages + picturePages;
    const scanned = content > 0 && textPages / content < 0.2 && picturePages >= 3;

    if (mode === "text" && scanned) {
      throw new PdfError(
        "needs_ocr",
        "This PDF is made of scanned page pictures with no selectable text. Recall has no built-in OCR, so it can't read the words. You can import the pages as images instead (readable, but not searchable), or run OCR first (for example with OCRmyPDF) and import the result.",
      );
    }
    if (mode === "text" && content === 0) {
      throw new PdfError("unsupported", "This PDF has no readable text or pictures (every page is blank).");
    }

    // ---- running headers / page numbers
    const lineSets: Line[][] = scans.map((s) => buildLines(s.items));
    const running = findRunningLines(scans.map((s, i) => ({ lines: lineSets[i], height: s.height })));

    // ---- pass 2: rasterise what needs it (pages-as-images, picture pages, illustrations)
    const builds: PageBuild[] = [];
    const coverPool: { ref: string; label: string; page: number }[] = [];
    // Picture accounting: every picture found is either kept or counted under the reason it was skipped.
    const stats = { found: 0, decorations: 0, duplicates: 0, backgrounds: 0, blank: 0 };

    for (const scan of scans) {
      throwIfCancelled(opts.signal);
      const n = scan.index + 1;
      const build: PageBuild = { scan, images: [], wholePage: null, blank: false };
      const wantsWholePage = mode === "pages-as-images" || (!isTextPage(scan) && scan.hasPictureOps) || (!isTextPage(scan) && n <= 6 && scan.images.length > 0);
      const area = scan.width * scan.height;

      const textPage = isTextPage(scan);
      const countStats = mode === "text" && textPage; // picture-only pages are counted as whole pages below
      const placed = scan.images.filter((im) => im.x1 - im.x0 > 0 && im.y1 - im.y0 > 0);
      if (countStats) stats.found += placed.length;

      const candidates: ImagePlacement[] = [];
      for (const im of placed) {
        const w = im.x1 - im.x0;
        const h = im.y1 - im.y0;
        // Bullets, rules and tiny ornaments are not illustrations. A spot illustration of a few percent of the page is.
        if (w < MIN_PICTURE_PT || h < MIN_PICTURE_PT || (w * h) / area < 0.003 || Math.max(w / h, h / w) > 25) {
          if (countStats) stats.decorations++;
          continue;
        }
        // The same picture painted twice over the same place (e.g. a picture plus its mask) is one picture.
        if (candidates.some((c) => overlapRatio(c, im) > 0.8)) {
          if (countStats) stats.duplicates++;
          continue;
        }
        candidates.push(im);
      }

      // A page-sized picture behind a FULL page of text is a scan's background layer (the text is the content).
      // A page-sized picture with only a caption or a few words is an illustration and is kept.
      const dominant = candidates.find((im) => ((im.x1 - im.x0) * (im.y1 - im.y0)) / area >= 0.8);
      const isBackground = !!dominant && countStats && scan.textChars >= BACKGROUND_TEXT_MIN_CHARS;
      if (isBackground) stats.backgrounds += candidates.length;
      const crops = countStats && !isBackground ? candidates : [];

      const needsRaster = wantsWholePage || crops.length > 0 || n <= 6;
      if (!needsRaster) {
        builds.push(build);
        continue;
      }

      const page = await pdf.getPage(n);
      try {
        // Pick a render scale: whole pages ≤ 1800px on the long side; crops near native resolution.
        let scale = Math.min(1800 / Math.max(scan.width, scan.height), 3);
        if (crops.length) {
          const want = Math.max(
            ...crops.map((c) => Math.min(Math.max(c.nativeW, 1) / Math.max(c.x1 - c.x0, 1), 4)),
            1.5,
          );
          scale = Math.max(scale, Math.min(want, 4));
        }
        scale = Math.min(scale, Math.sqrt(MAX_RENDER_PIXELS / area));
        const raster = await renderPage(page, scale, adapter);
        const k = raster.width / scan.width;

        const whole = fingerprint(raster, adapter, 0, 0, raster.width, raster.height);
        // Text pages are mostly white by nature: judge "blank" by pixels only for pages without text.
        const pageBlank = whole.blank && !isTextPage(scan);
        if (wantsWholePage) {
          stats.found++; // the page itself is the picture
          if (pageBlank) {
            build.blank = true;
            stats.blank++;
          } else if (mode === "pages-as-images" || !isTextPage(scan)) {
            // Whole pages are never de-duplicated: each page is a distinct part of the book.
            const key = `page-${n}`;
            const enc = await cropToImage(raster, adapter, { sx: 0, sy: 0, sw: raster.width, sh: raster.height }, 1800, "image/jpeg", 0.85);
            images.set(key, { ref: key, bytes: enc.bytes, mime: "image/jpeg", width: enc.width, height: enc.height });
            build.wholePage = key;
          }
        }

        for (const [ci, c] of crops.entries()) {
          const sx = Math.max(0, Math.round(c.x0 * k));
          const sy = Math.max(0, Math.round(c.y0 * k));
          const sw = Math.min(raster.width - sx, Math.round((c.x1 - c.x0) * k));
          const sh = Math.min(raster.height - sy, Math.round((c.y1 - c.y0) * k));
          if (sw < 8 || sh < 8) {
            stats.decorations++;
            continue;
          }
          const fp = fingerprint(raster, adapter, sx, sy, sw, sh);
          if (fp.blank) {
            stats.blank++;
            continue;
          }
          // A graphic repeated in the top/bottom margin of many pages (a running logo) is decoration, not story.
          const centreY = (c.y0 + c.y1) / 2;
          if (centreY < scan.height * 0.08 || centreY > scan.height * 0.92) {
            if (marginSeen.some((v) => artDistance(v, fp.vec) < MARGIN_REPEAT_DISTANCE)) {
              stats.decorations++;
              continue;
            }
            marginSeen.push(fp.vec);
          }
          const png = sw * sh < 300_000;
          const enc = await cropToImage(raster, adapter, { sx, sy, sw, sh }, 2200, png ? "image/png" : "image/jpeg", 0.9);
          const ref = `img-p${n}-${ci + 1}`;
          images.set(ref, { ref, bytes: enc.bytes, mime: png ? "image/png" : "image/jpeg", width: enc.width, height: enc.height });
          build.images.push({ ref, y: c.y0, x: c.x0 });
        }

        // Cover candidates come from the first few pages.
        if (n <= 6 && !pageBlank) {
          const textHeavy = scan.textChars > 80;
          // How much of the page the pictures cover: a small logo on an otherwise empty page is not a cover.
          const pictureFrac = Math.min(1, scan.images.reduce((s, im) => s + (im.x1 - im.x0) * (im.y1 - im.y0), 0) / area);
          const big = candidates
            .map((c) => ({ c, frac: ((c.x1 - c.x0) * (c.y1 - c.y0)) / area }))
            .sort((a, b) => b.frac - a.frac)[0];
          let source: { sx: number; sy: number; sw: number; sh: number } | null = null;
          let label = "";
          if (big && big.frac >= 0.25 && !textHeavy) {
            const c = big.c;
            source = {
              sx: Math.max(0, Math.round(c.x0 * k)),
              sy: Math.max(0, Math.round(c.y0 * k)),
              sw: Math.min(raster.width, Math.round((c.x1 - c.x0) * k)),
              sh: Math.min(raster.height, Math.round((c.y1 - c.y0) * k)),
            };
            label = `Illustration on page ${n}`;
          } else if (!isTextPage(scan) && scan.hasPictureOps && (scan.images.length === 0 || pictureFrac >= 0.25)) {
            // Picture-only page whose artwork we couldn't isolate (e.g. 1-bit scan masks): use the page itself.
            source = { sx: 0, sy: 0, sw: raster.width, sh: raster.height };
            label = `Page ${n}`;
          }
          if (source && source.sw > 8 && source.sh > 8 && !fingerprint(raster, adapter, source.sx, source.sy, source.sw, source.sh).blank) {
            const enc = await cropToImage(raster, adapter, source, 900, "image/jpeg", 0.85);
            const ref = `cover-p${n}`;
            images.set(ref, { ref, bytes: enc.bytes, mime: "image/jpeg", width: enc.width, height: enc.height });
            coverPool.push({ ref, label, page: n });
          } else if (isTextPage(scan)) {
            // A rendered view of the page, used only if nothing better turns up.
            const enc = await cropToImage(raster, adapter, { sx: 0, sy: 0, sw: raster.width, sh: raster.height }, 900, "image/jpeg", 0.85);
            const ref = `cover-page-${n}`;
            images.set(ref, { ref, bytes: enc.bytes, mime: "image/jpeg", width: enc.width, height: enc.height });
            coverPool.push({ ref, label: `Page ${n} (rendered)`, page: n + 1000 });
          }
        }
      } finally {
        page.cleanup();
      }
      builds.push(build);
      if (n % 3 === 0 || n === total) {
        opts.onProgress?.(n, total, `Processing page ${n} of ${total}`);
        await tick();
      }
    }

    // Pages with no text and no pictures at all never needed rendering; still tell the user they were left out.
    const emptyPages = scans.filter((s) => !isTextPage(s) && !s.hasPictureOps).length;
    if (emptyPages) warnings.push(`${emptyPages} empty page(s) with no text and no pictures were skipped.`);
    if (stats.blank) warnings.push(`${stats.blank} blank picture(s) or page(s) were skipped.`);
    if (stats.backgrounds) warnings.push(`${stats.backgrounds} full-page background picture(s) behind a full page of selectable text were skipped (the text was kept).`);
    if (stats.duplicates) warnings.push(`${stats.duplicates} picture(s) drawn twice in the same place were imported once.`);
    if (stats.decorations) warnings.push(`${stats.decorations} tiny picture(s) (bullets, rules, ornaments or repeated margin graphics) were treated as decoration and skipped.`);

    // ---- build the ordered block stream
    const bodyHeight = bodyHeightOf(lineSets.flat().filter((_, i) => i % 1 === 0)) || 10;
    const blocks: ParsedBlock[] = [];
    const headings: { blockIndex: number; title: string; kind: "pattern" | "large-font"; page: number }[] = [];

    for (const b of builds) {
      const n = b.scan.index + 1;
      if (mode === "pages-as-images") {
        if (b.wholePage) blocks.push({ type: "image", ref: b.wholePage, alt: `Page ${n}`, page: n });
        continue;
      }
      if (b.wholePage) {
        blocks.push({ type: "image", ref: b.wholePage, alt: `Page ${n}`, page: n });
        continue;
      }
      if (b.blank) continue;

      const kept = lineSets[b.scan.index].filter((_, i) => !running[b.scan.index].has(i));
      const imgYs = b.images.map((im) => im.y);
      const paras = buildParagraphs(kept, bodyHeight, { breaks: imgYs });

      type Item = { y: number; x: number; para?: Paragraph; img?: PageImageRef };
      const seq: Item[] = [
        ...paras.map((p) => ({ y: p.y, x: p.x, para: p })),
        ...b.images.map((im) => ({ y: im.y, x: im.x, img: im })),
      ].sort((a, c) => a.y - c.y || a.x - c.x);

      let first = true;
      for (const it of seq) {
        if (it.img) {
          blocks.push({ type: "image", ref: it.img.ref, alt: null, page: n });
          continue;
        }
        const p = it.para!;
        const kind = classifyHeading(p, { bodyHeight, firstOnPage: first });
        first = false;
        if (kind) {
          headings.push({ blockIndex: blocks.length, title: p.text.replace(/\s+/g, " ").trim(), kind, page: n });
        }
        blocks.push({ type: "text", text: p.text, page: n });
      }
    }

    mergeAcrossPages(blocks, headings);

    // ---- chapters
    const outline = mode === "text" ? await readOutline(pdf, total) : await readOutline(pdf, total);
    const built = buildChapters(blocks, headings, outline, total);

    // Illustration pages that the bookmarks list like chapters ("Illustration 3") belong inside the chapter they fall in.
    const foldedPages = foldInlineIllustrationChapters(built.chapters);
    built.chapters = foldedPages.chapters;
    if (foldedPages.folded) warnings.push(foldedNotice(foldedPages.folded));
    if (built.dropped.length) {
      warnings.push(
        `${built.dropped.length} detected heading${built.dropped.length === 1 ? " has" : "s have"} no text or pictures under ${built.dropped.length === 1 ? "it" : "them"} and ${built.dropped.length === 1 ? "was" : "were"} left out: ${built.dropped.slice(0, 5).join("; ")}${built.dropped.length > 5 ? "…" : ""}.`,
      );
    }

    if (built.chapters.length === 0 || built.chapters.every((c) => c.blocks.length === 0)) {
      throw new PdfError("unsupported", "No readable content could be extracted from this PDF.");
    }
    if (mode === "text" && textPages > 0 && builds.some((b) => !isTextPage(b.scan) && b.scan.hasPictureOps && !b.wholePage && !b.blank)) {
      warnings.push("Some picture-only pages matched an earlier one and were not repeated.");
    }
    if (built.structure === "single") {
      warnings.push("No chapter headings or bookmarks were found, so the PDF is one chapter. Use “Split at page” below to divide it.");
    }

    // ---- cover candidates (independent copies, thumbnail-sized)
    const ordered = [...coverPool].sort((a, b) => a.page - b.page);
    const preferred = ordered.filter((c) => c.page < 1000);
    const pool = (preferred.length ? preferred : ordered).slice(0, 4);
    const meta = await pdf.getMetadata().catch(() => null);

    return {
      title: cleanMeta(meta?.info?.Title),
      author: cleanMeta(meta?.info?.Author),
      language: typeof meta?.info?.Language === "string" ? meta.info.Language.slice(0, 20) : null,
      seriesName: null,
      seriesIndex: null,
      coverRef: pool[0]?.ref ?? null,
      coverCandidates: pool.map(({ ref, label }) => ({ ref, label })),
      chapters: built.chapters,
      images: pruneImages(images, built.chapters, pool.map((p) => p.ref)),
      warnings,
      pageCount: total,
      structure: built.structure,
      scanned,
      ocrAvailable: false,
      imageStats: {
        ...stats,
        kept: built.chapters.reduce((n, c) => n + c.blocks.filter((b) => b.type === "image").length, 0),
      },
      imageReport: buildImageReport(stats.found, built.chapters, {
        "tiny decoration (bullet, rule, ornament, repeated margin graphic)": stats.decorations,
        "drawn twice in the same place": stats.duplicates,
        "background layer behind a full page of text": stats.backgrounds,
        "blank": stats.blank,
      }),
    };
  } finally {
    await close();
  }
}

/** Keeps only images that a chapter uses or that may become the cover. */
function pruneImages(all: Map<string, ParsedImage>, chapters: ParsedChapter[], coverRefs: string[]) {
  const used = new Set(coverRefs);
  chapters.forEach((c) => c.blocks.forEach((b) => b.type === "image" && used.add(b.ref)));
  return new Map([...all].filter(([ref]) => used.has(ref)));
}

// ------------------------------------------------------------------ cross-page paragraphs
const SENTENCE_END = /[.!?…。！？」』"”’)\]:;]\s*$/;
function mergeAcrossPages(
  blocks: ParsedBlock[],
  headings: { blockIndex: number }[],
) {
  const headingAt = new Set(headings.map((h) => h.blockIndex));
  for (let i = blocks.length - 2; i >= 0; i--) {
    const a = blocks[i];
    const b = blocks[i + 1];
    if (a.type !== "text" || b.type !== "text" || a.page === undefined || b.page === undefined) continue;
    if (b.page !== a.page + 1 || headingAt.has(i) || headingAt.has(i + 1)) continue;
    if (SENTENCE_END.test(a.text)) continue;
    if (!/^[a-zа-яё]/.test(b.text)) continue; // continuation starts lowercase
    a.text = /-$/.test(a.text) ? a.text.slice(0, -1) + b.text : `${a.text} ${b.text}`;
    blocks.splice(i + 1, 1);
    for (const h of headings as { blockIndex: number }[]) if (h.blockIndex > i + 1) h.blockIndex--;
    headingAt.clear();
    headings.forEach((h) => headingAt.add(h.blockIndex));
  }
}

// ------------------------------------------------------------------ chapters
type OutlineEntry = { title: string; page: number }; // page: 1-based

async function readOutline(pdf: any, total: number): Promise<OutlineEntry[]> {
  let raw: any[] | null = null;
  try {
    raw = await pdf.getOutline();
  } catch {
    return [];
  }
  if (!raw || raw.length === 0) return [];

  const flat: { title: string; dest: any }[] = [];
  const walk = (items: any[]) => {
    for (const it of items) {
      if (it.items?.length) walk(it.items);
      else if (it.dest) flat.push({ title: String(it.title ?? "").trim(), dest: it.dest });
    }
  };
  walk(raw);

  const out: OutlineEntry[] = [];
  for (const f of flat.slice(0, 2000)) {
    try {
      const dest = typeof f.dest === "string" ? await pdf.getDestination(f.dest) : f.dest;
      const ref = Array.isArray(dest) ? dest[0] : null;
      const idx = typeof ref === "number" ? ref : ref ? await pdf.getPageIndex(ref) : -1;
      if (idx >= 0 && idx < total && f.title) out.push({ title: f.title.slice(0, 300), page: idx + 1 });
    } catch {
      // a broken bookmark is simply ignored
    }
  }
  return out.sort((a, b) => a.page - b.page);
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function buildChapters(
  blocks: ParsedBlock[],
  headings: { blockIndex: number; title: string; page: number; kind: "pattern" | "large-font" }[],
  outline: OutlineEntry[],
  total: number,
): { chapters: ParsedChapter[]; structure: "outline" | "headings" | "single"; dropped: string[] } {
  type Start = { index: number; title: string; dropHeadingBlock: boolean };
  let starts: Start[] = [];
  let structure: "outline" | "headings" | "single" = "single";

  const firstBlockOfPage = (page: number) => blocks.findIndex((b) => (b.page ?? 0) >= page);

  if (outline.length >= 2) {
    structure = "outline";
    for (const o of outline) {
      // Start at the heading paragraph when the page has it, otherwise at the top of the page.
      const h = headings.find((x) => x.page === o.page && (norm(x.title) === norm(o.title) || norm(o.title).includes(norm(x.title)) || norm(x.title).includes(norm(o.title))));
      const asText = h ? undefined : blocks.findIndex((b) => b.type === "text" && b.page === o.page && norm(b.text) === norm(o.title));
      const index = h ? h.blockIndex : asText !== undefined && asText >= 0 ? asText : firstBlockOfPage(o.page);
      if (index >= 0) starts.push({ index, title: o.title, dropHeadingBlock: !!h || (asText !== undefined && asText >= 0) });
    }
  } else if (headings.length >= 2 || (headings.length === 1 && (headings[0].kind === "pattern" || headings[0].blockIndex > 0))) {
    // A lone large-font title is too weak a signal at the very start; a "Chapter N" style line is not.
    structure = "headings";
    starts = headings.map((h) => ({ index: h.blockIndex, title: h.title.slice(0, 300), dropHeadingBlock: true }));
  }

  starts = starts
    .sort((a, b) => a.index - b.index)
    .filter((s, i, arr) => i === 0 || s.index !== arr[i - 1].index);

  const make = (title: string, slice: ParsedBlock[], frontMatter: boolean): ParsedChapter => {
    const pages = slice.map((b) => b.page).filter((p): p is number => p !== undefined);
    return {
      title: title || "Untitled",
      blocks: slice,
      wordCount: slice.reduce((n, b) => n + (b.type === "text" ? (b.text.match(/\S+/g)?.length ?? 0) : 0), 0),
      imageCount: slice.filter((b) => b.type === "image").length,
      frontMatter,
      pageStart: pages.length ? Math.min(...pages) : undefined,
      pageEnd: pages.length ? Math.max(...pages) : undefined,
    };
  };

  if (starts.length === 0) {
    return { chapters: blocks.length ? [make("Full text", blocks, false)] : [], structure: "single", dropped: [] };
  }

  const chapters: ParsedChapter[] = [];
  if (starts[0].index > 0) chapters.push(make("Front matter and illustrations", blocks.slice(0, starts[0].index), true));
  starts.forEach((s, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].index : blocks.length;
    const slice = blocks.slice(s.index, end);
    if (s.dropHeadingBlock && slice[0]?.type === "text" && norm(slice[0].text) === norm(s.title)) slice.shift();
    chapters.push(make(s.title, slice, false));
  });
  void total;
  // A heading with nothing under it (e.g. two headings in a row) is not silently discarded: its title is reported.
  return {
    chapters: chapters.filter((c) => c.blocks.length > 0),
    structure,
    dropped: chapters.filter((c) => c.blocks.length === 0).map((c) => c.title),
  };
}

export { sniffImage };
