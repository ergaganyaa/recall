/* eslint-disable @typescript-eslint/no-require-imports -- standalone CommonJS script, not part of the app */
/*
 * Builds CSS447_Project_Architecture.pdf from CSS447_Project_Architecture.md.
 * Not part of the application: run it manually when the report changes.
 *
 *   npm install --no-save mermaid@11.4.1 marked@15.0.4   (in a scratch folder, not in the app)
 *   NODE_PATH=<that folder>/node_modules node build-pdf.cjs
 *
 * Needs Google Chrome or Microsoft Edge (headless) for rendering the Mermaid diagrams and printing the PDF.
 * The ```mermaid blocks in the Markdown are rendered into the PDF; no diagram source appears in it.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { marked } = require("marked");

const dir = __dirname;
const md = fs.readFileSync(path.join(dir, "CSS447_Project_Architecture.md"), "utf8");
const mermaidJs = require.resolve("mermaid/dist/mermaid.min.js");
const out = process.env.BUILD_DIR || path.join(dir, ".build");
fs.mkdirSync(out, { recursive: true });

let html = marked
  .parse(md, { gfm: true })
  .replace(/<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g, (_m, code) => `<div class="figure"><pre class="mermaid">${code}</pre></div>`)
  .replace(
    /<p><img src="([^"]+)" alt="([^"]*)"><\/p>/g,
    (_m, src, alt) => `<div class="figure"><img src="file:///${path.join(dir, src).replace(/\\/g, "/")}" alt="${alt}"></div>`,
  );
// keep each figure and its caption on the same page: move the caption inside the figure block
html = html.replace(/<\/div>\s*<p class="caption">([\s\S]*?)<\/p>/g, '<p class="caption">$1</p></div>');

const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>CSS447 Project Architecture: Recall</title>
<style>
@page { size: A4; margin: 16mm 16mm 18mm 16mm;
  @bottom-center { content: "Recall: Project Architecture  |  Page " counter(page) " of " counter(pages); font: 8pt 'Segoe UI', Arial, sans-serif; color: #666; } }
* { box-sizing: border-box; }
body { font: 9.3pt/1.4 'Segoe UI', Calibri, Arial, sans-serif; color: #1c1f24; margin: 0; }
h1 { font-size: 19pt; margin: 0 0 4pt; color: #14304f; letter-spacing: -0.2pt; }
p:has(> strong:only-child) { break-after: avoid; }
h2 { font-size: 13pt; margin: 14pt 0 5pt; color: #14304f; border-bottom: 1px solid #c9d3df; padding-bottom: 2pt; break-after: avoid; }
p { margin: 0 0 5pt; } ul, ol { margin: 0 0 5pt; padding-left: 16pt; } li { margin-bottom: 1.5pt; }
code { font: 8.4pt Consolas, 'Courier New', monospace; background: #eef1f5; padding: 0 2pt; border-radius: 2px; }
a { color: #14558f; text-decoration: none; word-break: break-all; }
blockquote { margin: 6pt 0 8pt; padding: 5pt 9pt; background: #f1f5f9; border-left: 3px solid #4a6f95; color: #333; font-size: 8.8pt; }
blockquote p { margin: 0; }
table { border-collapse: collapse; width: 100%; margin: 4pt 0 8pt; font-size: 8.3pt; break-inside: auto; }
th, td { border: 1px solid #c9d3df; padding: 2.5pt 4pt; vertical-align: top; text-align: left; }
th { background: #e6edf5; color: #14304f; } tr { break-inside: avoid; }
.figure { margin: 6pt 0 2pt; text-align: center; break-inside: avoid; }
.figure svg, .figure img { max-width: 100%; max-height: 215mm; height: auto; }
.caption { font-size: 8.3pt; color: #555; text-align: center; font-style: italic; margin-bottom: 8pt; }
.pagebreak { break-after: page; }
hr { border: 0; border-top: 1px solid #c9d3df; }
</style></head><body>
${html}
<script src="file:///${mermaidJs.replace(/\\/g, "/")}"></script>
<script>
mermaid.initialize({ startOnLoad: false, theme: "neutral", securityLevel: "strict",
  fontFamily: "Segoe UI, Arial, sans-serif",
  flowchart: { useMaxWidth: true, htmlLabels: true, curve: "basis" },
  sequence: { useMaxWidth: true, mirrorActors: false, wrap: false, actorMargin: 30, messageMargin: 30, noteMargin: 6, width: 150 },
  er: { useMaxWidth: true } });
mermaid.run({ querySelector: "pre.mermaid" }).then(() => { document.title = "done"; document.body.setAttribute("data-ready", "1"); });
</script></body></html>`;

const htmlPath = path.join(out, "report.html");
fs.writeFileSync(htmlPath, page);

const chrome = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((p) => fs.existsSync(p));
if (!chrome) throw new Error("Chrome or Edge not found");

const pdf = path.join(dir, "CSS447_Project_Architecture.pdf");
execFileSync(
  chrome,
  [
    "--headless=new", "--disable-gpu", "--no-pdf-header-footer", "--allow-file-access-from-files",
    "--virtual-time-budget=20000", `--print-to-pdf=${pdf}`, "file:///" + htmlPath.replace(/\\/g, "/"),
  ],
  { stdio: "inherit" },
);
console.log("wrote", pdf);
