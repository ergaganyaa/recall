import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { inspectPdf, parsePdf, type PdfJsLike, type PdfOptions } from "@/lib/pdf";
import { bodyLines, loadPdfJsForTests, makePdf, nodeCanvas } from "./helpers/pdf-fixture";

/**
 * Opt-in (RECALL_BENCH=1): CPU time of the PDF stages for a 200-page text PDF, in Node (no network, no browser).
 * Shows how many full passes over the document the import makes. Not a browser timing.
 */
const log = (line: string) => appendFileSync(process.env.RECALL_BENCH_LOG ?? join(tmpdir(), "recall-bench.log"), `${line}\n`);
let pdfjs: PdfJsLike;
const opts = (): PdfOptions => ({ pdfjs, canvas: nodeCanvas });
beforeAll(async () => {
  pdfjs = await loadPdfJsForTests();
});

describe.skipIf(!process.env.RECALL_BENCH)("pdf import CPU stages (200 pages)", () => {
  it("inspect vs parse", async () => {
    const pages = Array.from({ length: 200 }, (_, p) => ({
      lines: [
        ...(p % 20 === 0 ? [{ text: `Chapter ${p / 20 + 1}`, y: 520, size: 26, bold: true }] : []),
        ...bodyLines(Array.from({ length: 28 }, (_, i) => `Original sample sentence ${i} on page ${p + 1}, long enough to fill a line of text.`), 470),
      ],
    }));
    const bytes = await makePdf(pages, { title: "Bench" });
    const t0 = performance.now();
    await inspectPdf(bytes, opts());
    const inspectMs = performance.now() - t0;
    const t1 = performance.now();
    const v = await parsePdf(bytes, opts());
    const parseMs = performance.now() - t1;
    log(`BENCH pdf 200 pages (${(bytes.length / 1024).toFixed(0)} KB): inspectPdf ${inspectMs.toFixed(0)} ms, parsePdf ${parseMs.toFixed(0)} ms, chapters ${v.chapters.length}`);
    expect(v.chapters.length).toBeGreaterThan(1);
  }, 300_000);
});
