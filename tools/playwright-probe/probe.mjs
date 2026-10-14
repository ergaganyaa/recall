// Standalone investigation. NOT imported by the Recall app.
//
// Question: what does a normal, unmodified browser see on a catalog page that
// robots.txt allows? Rules this script follows:
//   - checks robots.txt first and refuses to load a disallowed path
//   - ONE navigation, stock Chromium settings (no UA/fingerprint changes, no
//     stealth, no proxies, no CAPTCHA handling)
//   - never opens chapter links; it only records their hrefs and titles
//   - on any block/challenge it records the limitation and exits (no retries)
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const TARGET = process.argv[2];
if (!TARGET) {
  console.error("usage: node probe.mjs <catalog-page-url>");
  process.exit(2);
}
const url = new URL(TARGET);
if (url.protocol !== "https:" || !/(^|\.)ranobelib\.me$/.test(url.hostname)) {
  console.error("Refusing: only https://ranobelib.me pages are supported by this probe.");
  process.exit(2);
}

const report = { target: TARGET, startedAt: new Date().toISOString(), steps: [] };
const note = (step, data) => report.steps.push({ step, ...data });
const finish = (code, verdict) => {
  report.verdict = verdict;
  mkdirSync(new URL("./out/", import.meta.url), { recursive: true });
  writeFileSync(new URL("./out/report.json", import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ verdict, steps: report.steps.length }, null, 2));
  console.log("Full report: out/report.json");
  process.exit(code);
};

// ---- 1. robots.txt -------------------------------------------------------
function robotsAllows(robotsTxt, pathAndQuery) {
  const groups = [];
  let cur = null;
  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === "user-agent") {
      if (!cur || cur.rules.length) groups.push((cur = { agents: [], rules: [] }));
      cur.agents.push(m[2].toLowerCase());
    } else if (cur && (key === "disallow" || key === "allow")) {
      cur.rules.push({ allow: key === "allow", pattern: m[2] });
    }
  }
  const group = groups.find((g) => g.agents.includes("*"));
  if (!group) return { allowed: true, matched: null };
  const toRegex = (p) =>
    new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
  let best = null;
  for (const r of group.rules) {
    if (!r.pattern) continue;
    if (toRegex(r.pattern).test(pathAndQuery) && (!best || r.pattern.length > best.pattern.length)) best = r;
  }
  return best ? { allowed: best.allow, matched: best.pattern } : { allowed: true, matched: null };
}

const robotsRes = await fetch(new URL("/robots.txt", url), {
  headers: { "user-agent": "RecallProbe/0.1 (personal research)" },
});
const robotsTxt = await robotsRes.text();
const verdictRobots = robotsAllows(robotsTxt, url.pathname + url.search);
note("robots.txt", { status: robotsRes.status, ...verdictRobots });
if (!verdictRobots.allowed) finish(1, `BLOCKED by robots.txt rule "${verdictRobots.matched}". Not loading the page.`);

// ---- 2. one navigation in a stock browser --------------------------------
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const requests = [];
page.on("response", (r) => {
  const u = new URL(r.url());
  if (["document", "xhr", "fetch"].includes(r.request().resourceType())) {
    requests.push({ type: r.request().resourceType(), host: u.host, path: u.pathname, status: r.status() });
  }
});

let response;
try {
  response = await page.goto(TARGET, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
} catch (e) {
  note("navigation", { error: String(e).slice(0, 300) });
  await browser.close();
  finish(1, "Navigation failed; recorded and stopped (no retry).");
}

const status = response?.status() ?? 0;
const html = await page.content();
const title = await page.title();
note("navigation", { status, finalUrl: page.url(), title, htmlBytes: html.length });

const challenge =
  [403, 429, 503].includes(status) ||
  /ddos-guard|just a moment|captcha|cf-chl|access denied|checking your browser/i.test(title + html.slice(0, 20000));
if (challenge) {
  note("blocked", { requests: requests.slice(0, 15) });
  await browser.close();
  finish(1, "BLOCKED/CHALLENGED by the site's protection. Recorded; not retrying or working around it.");
}

// ---- 3. what the rendered DOM exposes (read-only, nothing is clicked) -----
const dom = await page.evaluate(() => {
  const text = (el) => (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120);
  const anchors = [...document.querySelectorAll("a[href]")];
  const chapterLinks = anchors.filter((a) => /\/read\/|\/chapter/i.test(a.getAttribute("href") || ""));
  const headings = [...document.querySelectorAll("h1,h2,h3,h4")].map(text).filter(Boolean).slice(0, 25);
  const volumeish = [...document.querySelectorAll("*")]
    .filter((el) => el.children.length === 0 && /^(том|volume|vol\.?)\s*\d+(\.\d+)?/i.test(text(el)))
    .map(text);
  return {
    ogTitle: document.querySelector('meta[property="og:title"]')?.content ?? null,
    ogImage: document.querySelector('meta[property="og:image"]')?.content ?? null,
    h1: document.querySelector("h1")?.textContent?.trim() ?? null,
    headings,
    imageCount: document.images.length,
    chapterLinkCount: chapterLinks.length,
    chapterLinkSamples: chapterLinks.slice(0, 6).map((a) => ({ href: a.getAttribute("href"), title: text(a) })),
    volumeLabelCount: volumeish.length,
    volumeLabelSamples: [...new Set(volumeish)].slice(0, 12),
  };
});
note("dom", dom);
note("network", { requests: requests.slice(0, 40) });

await browser.close();
const exposed = dom.chapterLinkCount > 0;
finish(
  0,
  exposed
    ? `Rendered DOM exposes ${dom.chapterLinkCount} chapter links and ${dom.volumeLabelCount} volume labels (catalog metadata only; chapter pages were NOT opened).`
    : "Page loaded without a block, but no chapter list was found in the DOM (see report).",
);
