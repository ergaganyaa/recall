/**
 * EPUB → structured volume (pure; runs in the browser, and in Node for tests).
 *
 * Chapter text and illustrations are kept as ONE ordered list of blocks per
 * chapter, so an image sits exactly where it appears in the book. Nothing is
 * fetched from the network and no text is invented: whatever is not in the file
 * is simply absent.
 */
import { strFromU8, unzipSync } from "fflate";
import { buildImageReport, foldedNotice, foldInlineIllustrationChapters, type ImageReport } from "./chapter-merge";
import { sniffImage, type ImageInfo } from "./image-sniff";

/** `page` (1-based) is set for PDF sources so chapters can be split at page boundaries. */
export type ParsedBlock =
  | { type: "text"; text: string; page?: number }
  | { type: "image"; ref: string; alt: string | null; page?: number };

export type ParsedChapter = {
  title: string;
  blocks: ParsedBlock[];
  wordCount: number;
  imageCount: number;
  /** True for content that came before the first table-of-contents entry (covers, colour plates). */
  frontMatter: boolean;
  /** PDF sources: the first/last page this chapter covers (1-based). */
  pageStart?: number;
  pageEnd?: number;
};

export type ParsedImage = ImageInfo & { ref: string; bytes: Uint8Array };

export type ParsedVolume = {
  title: string | null;
  author: string | null;
  language: string | null;
  seriesName: string | null;
  /** Decimal-safe volume number from the file's series metadata (e.g. 4.5), if present. */
  seriesIndex: number | null;
  coverRef: string | null;
  /** Other images that could serve as the volume cover (the user may pick one in the preview). */
  coverCandidates?: { ref: string; label: string }[];
  /** Pictures found vs kept, with the reason for each skipped one, so nothing is lost silently. */
  imageReport?: ImageReport;
  chapters: ParsedChapter[];
  images: Map<string, ParsedImage>;
  warnings: string[];
};

export class EpubError extends Error {}

const MAX_TOTAL_BYTES = 400 * 1024 * 1024; // zip-bomb guard (uncompressed)
const MAX_ENTRIES = 5000;

const SKIP_TAGS = new Set(["head", "script", "style", "title", "rt", "rp", "noscript", "template"]);
const BLOCK_TAGS = new Set([
  "p", "div", "section", "article", "aside", "blockquote", "li", "ul", "ol", "dl", "dt", "dd",
  "h1", "h2", "h3", "h4", "h5", "h6", "tr", "table", "pre", "figure", "figcaption", "header", "footer", "body", "br", "hr",
]);

type DOMParserCtor = new () => { parseFromString(s: string, type: string): Document };

// --------------------------------------------------------------------------- paths
function dirname(p: string) {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}
function safeDecode(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
/** Resolves `href` against the file that contains it, collapsing ./ and ../ inside the archive. */
export function resolvePath(baseFile: string, href: string): string {
  const clean = safeDecode(href.split("#")[0].split("?")[0]);
  const parts = (clean.startsWith("/") ? clean.slice(1) : `${dirname(baseFile)}/${clean}`).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}
const fragmentOf = (href: string) => safeDecode(href.split("#")[1] ?? "");

/** Lower-cased tag name without any namespace prefix (`dc:title` → `title`). */
const localTag = (el: Element) => el.tagName.split(":").pop()!.toLowerCase();

const norm = (s: string) => s.replace(/[\s ]+/g, " ").trim();
const wordsIn = (s: string) => (s.match(/\S+/g) ?? []).length;

// --------------------------------------------------------------------------- parse
export function parseEpub(
  bytes: Uint8Array,
  opts: { DOMParser?: DOMParserCtor } = {},
): ParsedVolume {
  const Parser = opts.DOMParser ?? (globalThis as { DOMParser?: DOMParserCtor }).DOMParser;
  if (!Parser) throw new EpubError("This environment can't parse EPUB files.");
  const dom = new Parser();
  const warnings: string[] = [];

  // ---- unzip (bounded)
  let total = 0;
  let entries = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        entries++;
        total += f.originalSize;
        if (entries > MAX_ENTRIES || total > MAX_TOTAL_BYTES) throw new EpubError("This EPUB is unusually large or has too many files.");
        return !f.name.endsWith("/");
      },
    });
  } catch (e) {
    if (e instanceof EpubError) throw e;
    throw new EpubError("This doesn't look like a valid EPUB file (it couldn't be opened as a zip archive).");
  }
  const text = (path: string) => (files[path] ? strFromU8(files[path]) : null);
  const xml = (path: string) => {
    const t = text(path);
    return t === null ? null : dom.parseFromString(t.replace(/^﻿/, ""), "text/xml");
  };

  // ---- container → OPF
  const container = xml("META-INF/container.xml");
  const opfPath = container?.querySelector("rootfile")?.getAttribute("full-path");
  if (!opfPath || !files[opfPath]) throw new EpubError("This EPUB has no readable package file (OPF).");
  const opf = xml(opfPath)!;
  if (!opf.querySelector("package, opf\\:package") && !opf.documentElement) throw new EpubError("Couldn't read the EPUB package file.");

  const q = (sel: string) => [...opf.querySelectorAll(sel)];
  const metaByName = (name: string) =>
    q("meta").find((m) => m.getAttribute("name") === name)?.getAttribute("content")?.trim() ?? null;
  const metaByProp = (prop: string) =>
    norm(q("meta").find((m) => m.getAttribute("property") === prop)?.textContent ?? "") || null;

  // Tag names may carry a namespace prefix (dc:title); match on local name.
  const byLocal = (local: string) =>
    [...opf.querySelectorAll("*")].filter((el) => localTag(el) === local);
  const metaText = (local: string) => norm(byLocal(local)[0]?.textContent ?? "") || null;

  const title = metaText("title");
  const author = metaText("creator");
  const language = metaText("language");
  const seriesName = metaByName("calibre:series") ?? metaByProp("belongs-to-collection");
  const rawIndex = metaByName("calibre:series_index") ?? metaByProp("group-position");
  const parsedIndex = rawIndex === null ? NaN : Number.parseFloat(rawIndex);
  const seriesIndex = Number.isFinite(parsedIndex) && parsedIndex > 0 ? parsedIndex : null;

  // ---- manifest & spine
  type Item = { id: string; path: string; type: string; props: string };
  const manifest = new Map<string, Item>();
  for (const el of q("manifest > item, item")) {
    const id = el.getAttribute("id");
    const href = el.getAttribute("href");
    if (!id || !href) continue;
    manifest.set(id, {
      id,
      path: resolvePath(opfPath, href),
      type: el.getAttribute("media-type") ?? "",
      props: el.getAttribute("properties") ?? "",
    });
  }
  const spineEl = opf.querySelector("spine");
  const spine = [...(spineEl?.querySelectorAll("itemref") ?? [])]
    .filter((r) => r.getAttribute("linear") !== "no")
    .map((r) => manifest.get(r.getAttribute("idref") ?? ""))
    .filter((i): i is Item => !!i && /x?html/i.test(i.type) && !!files[i.path]);
  if (spine.length === 0) throw new EpubError("This EPUB has no readable chapters.");

  // ---- cover
  const coverId = metaByName("cover");
  const coverItem =
    [...manifest.values()].find((i) => i.props.split(/\s+/).includes("cover-image")) ?? (coverId ? manifest.get(coverId) : undefined);

  // ---- images (decoded lazily, only those actually referenced)
  const images = new Map<string, ParsedImage>();
  // Every picture reference in the text is counted: kept, or skipped under a named reason.
  let found = 0;
  const skipped: Record<string, number> = {};
  const skip = (reason: string) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };
  const registerImage = (path: string): boolean => {
    if (images.has(path)) return true;
    const data = files[path];
    if (!data) {
      warnings.push(`An illustration (${path}) is referenced but missing from the file; it was skipped.`);
      skip("missing from the file");
      return false;
    }
    const info = sniffImage(data);
    if (!info) {
      warnings.push(`“${path.split("/").pop()}” isn't a supported image type (JPEG, PNG, WebP, GIF or AVIF); it was skipped.`);
      skip("unsupported image type");
      return false;
    }
    images.set(path, { ref: path, bytes: data, ...info });
    return true;
  };

  // ---- spine → one ordered block stream, remembering where each file/anchor starts
  const stream: ParsedBlock[] = [];
  const fileStart = new Map<string, number>();
  const anchor = new Map<string, number>();

  for (const item of spine) {
    fileStart.set(item.path, stream.length);
    const doc = dom.parseFromString(text(item.path)!.replace(/^﻿/, ""), "text/html");
    const body = doc.body ?? doc.documentElement;
    if (!body) continue;

    let buf = "";
    const flush = () => {
      const t = norm(buf);
      buf = "";
      if (t) stream.push({ type: "text", text: t });
    };
    const pushImage = (href: string | null, alt: string | null) => {
      if (!href) return;
      found++;
      if (/^(https?:)?\/\//i.test(href) || href.startsWith("data:")) {
        warnings.push("An illustration that is linked from the web (not embedded in the file) was skipped.");
        skip("linked from the web, not embedded");
        return;
      }
      flush();
      const path = resolvePath(item.path, href);
      if (registerImage(path)) stream.push({ type: "image", ref: path, alt: alt ? norm(alt) || null : null });
    };

    const walk = (node: Node) => {
      if (node.nodeType === 3) {
        buf += node.nodeValue ?? "";
        return;
      }
      if (node.nodeType !== 1) return;
      const el = node as Element;
      const tag = localTag(el);
      if (SKIP_TAGS.has(tag)) return;

      const id = el.getAttribute("id");
      if (id) {
        flush();
        if (!anchor.has(`${item.path}#${id}`)) anchor.set(`${item.path}#${id}`, stream.length);
      }

      if (tag === "img") {
        pushImage(el.getAttribute("src") ?? el.getAttribute("data-src"), el.getAttribute("alt"));
        return;
      }
      if (tag === "svg") {
        for (const im of el.getElementsByTagName("image")) {
          pushImage(im.getAttribute("xlink:href") ?? im.getAttribute("href"), null);
        }
        return;
      }
      // A picture set as an inline CSS background (<div style="background-image:url(...)">) is still a picture
      // at this spot in the text.
      const bg = (el.getAttribute("style") ?? "").match(/background(?:-image)?\s*:[^;]*url\(\s*['"]?([^'")]+)['"]?\s*\)/i);
      if (bg) pushImage(bg[1], null);
      const isBlock = BLOCK_TAGS.has(tag);
      if (isBlock) flush();
      for (const child of el.childNodes) walk(child);
      if (isBlock) flush();
    };
    walk(body);
    flush();
  }

  // ---- table of contents
  type Toc = { title: string; path: string; fragment: string; leaf: boolean };
  const toc: Toc[] = [];

  const navItem = [...manifest.values()].find((i) => i.props.split(/\s+/).includes("nav"));
  const ncxItem = spineEl?.getAttribute("toc") ? manifest.get(spineEl.getAttribute("toc")!) : [...manifest.values()].find((i) => /ncx/i.test(i.type));

  if (navItem && files[navItem.path]) {
    const doc = dom.parseFromString(text(navItem.path)!, "text/html");
    const nav =
      [...doc.querySelectorAll("nav")].find((n) => /(^|\s)toc(\s|$)/.test(n.getAttribute("epub:type") ?? n.getAttribute("type") ?? "")) ??
      doc.querySelector("nav");
    const walkList = (ol: Element) => {
      for (const li of ol.children) {
        if (li.tagName.toLowerCase() !== "li") continue;
        const a = [...li.children].find((c) => c.tagName.toLowerCase() === "a" || c.tagName.toLowerCase() === "span");
        const sub = [...li.children].find((c) => c.tagName.toLowerCase() === "ol");
        const href = a?.getAttribute("href");
        if (href) {
          toc.push({
            title: norm(a?.textContent ?? ""),
            path: resolvePath(navItem.path, href),
            fragment: fragmentOf(href),
            leaf: !sub,
          });
        }
        if (sub) walkList(sub);
      }
    };
    const root = nav?.querySelector("ol");
    if (root) walkList(root);
  }
  if (toc.length === 0 && ncxItem && files[ncxItem.path]) {
    const ncx = xml(ncxItem.path)!;
    const walkPoints = (parent: Element) => {
      for (const p of parent.children) {
        if (localTag(p) !== "navpoint") continue;
        const label = norm(p.querySelector("navLabel > text, text")?.textContent ?? "");
        const src = p.querySelector("content")?.getAttribute("src");
        const kids = [...p.children].filter((c) => localTag(c) === "navpoint");
        if (src) toc.push({ title: label, path: resolvePath(ncxItem.path, src), fragment: fragmentOf(src), leaf: kids.length === 0 });
        if (kids.length) walkPoints(p);
      }
    };
    const map = ncx.querySelector("navMap");
    if (map) walkPoints(map);
  }

  // ---- split the stream into chapters
  type Start = { title: string; index: number };
  const starts: Start[] = [];
  for (const t of toc.filter((e) => e.leaf)) {
    const index = t.fragment && anchor.has(`${t.path}#${t.fragment}`) ? anchor.get(`${t.path}#${t.fragment}`)! : fileStart.get(t.path);
    if (index === undefined) continue;
    starts.push({ title: t.title, index });
  }
  starts.sort((a, b) => a.index - b.index);
  const uniqueStarts = starts.filter((s, i) => i === 0 || s.index !== starts[i - 1].index);

  const chapters: ParsedChapter[] = [];
  const make = (title: string, blocks: ParsedBlock[], frontMatter: boolean): ParsedChapter => {
    let body = blocks;
    // The first line of a chapter usually repeats its heading; keep it only if it differs.
    if (body[0]?.type === "text" && norm(body[0].text).toLowerCase() === norm(title).toLowerCase()) body = body.slice(1);
    return {
      title: title || "Untitled",
      blocks: body,
      wordCount: body.reduce((n, b) => n + (b.type === "text" ? wordsIn(b.text) : 0), 0),
      imageCount: body.filter((b) => b.type === "image").length,
      frontMatter,
    };
  };

  if (uniqueStarts.length === 0) {
    warnings.push("This EPUB has no usable table of contents, so each file was treated as one chapter.");
    spine.forEach((item, i) => {
      const from = fileStart.get(item.path)!;
      const to = i + 1 < spine.length ? fileStart.get(spine[i + 1].path)! : stream.length;
      const blocks = stream.slice(from, to);
      const heading = blocks.find((b) => b.type === "text");
      if (blocks.length) chapters.push(make(heading?.type === "text" && heading.text.length <= 120 ? heading.text : `Section ${chapters.length + 1}`, blocks, false));
    });
  } else {
    const head = stream.slice(0, uniqueStarts[0].index);
    if (head.length) chapters.push(make("Front matter and illustrations", head, true));
    uniqueStarts.forEach((s, i) => {
      const end = i + 1 < uniqueStarts.length ? uniqueStarts[i + 1].index : stream.length;
      chapters.push(make(s.title, stream.slice(s.index, end), false));
    });
  }

  const empty = chapters.filter((c) => c.blocks.length === 0).length;
  if (empty) warnings.push(`${empty} table-of-contents entr${empty === 1 ? "y" : "ies"} had no content and ${empty === 1 ? "was" : "were"} left out.`);
  const nonEmpty = chapters.filter((c) => c.blocks.length > 0);
  if (nonEmpty.length === 0) throw new EpubError("No chapter content could be read from this EPUB.");

  // Illustration pages that the book lists like chapters belong INSIDE the chapter they fall in.
  const { chapters: kept, folded } = foldInlineIllustrationChapters(nonEmpty);
  if (folded) warnings.push(foldedNotice(folded));

  let coverRef: string | null = null;
  if (coverItem && files[coverItem.path] && registerImage(coverItem.path)) coverRef = coverItem.path;

  // Pictures that exist in the file but no page uses cannot be placed in the text; say so instead of dropping them silently.
  const usedPaths = new Set(kept.flatMap((c) => c.blocks.flatMap((b) => (b.type === "image" ? [b.ref] : []))));
  if (coverRef) usedPaths.add(coverRef);
  const unplaced = [...manifest.values()].filter(
    (i) => /^image\/(jpeg|png|gif|webp|avif)/i.test(i.type) && files[i.path] && !usedPaths.has(i.path) && !images.has(i.path),
  ).length;
  if (unplaced) {
    skip("in the file but not placed on any page");
    skipped["in the file but not placed on any page"] = unplaced;
    warnings.push(`${unplaced} picture(s) are stored in the EPUB but not placed on any page, so their position in the story is unknown; they were not imported.`);
  }

  return {
    title,
    author,
    language,
    seriesName,
    seriesIndex,
    coverRef,
    chapters: kept,
    images,
    warnings: [...new Set(warnings)],
    imageReport: buildImageReport(found, kept, skipped),
  };
}
