// Copies pdf.js's worker next to the app so the browser loads exactly the version that is installed.
// Runs on install, before dev and before build. Safe to run repeatedly; does nothing if pdfjs-dist is absent.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const from = resolve(root, "node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs");
const to = resolve(root, "public/pdf.worker.min.mjs");

if (!existsSync(from)) {
  console.warn("[recall] pdfjs-dist not installed yet; skipping the PDF worker copy.");
} else {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  console.log("[recall] PDF worker copied to public/pdf.worker.min.mjs");
}
