import "server-only";
import * as cheerio from "cheerio";

export type ImportedMetadata = {
  title: string | null;
  author: string | null;
  description: string | null;
  cover_url: string | null;
  source_url: string;
};

export type ImportOutcome =
  | { ok: true; metadata: ImportedMetadata; notes: string[] }
  | { ok: false; error: string; fallbackTitle: string | null; source_url: string | null };

const ALLOWED_HOSTS = new Set(["ranobelib.me", "www.ranobelib.me"]);
const USER_AGENT = "RecallBot/0.1 (personal reading tracker; metadata only)";
const MAX_BYTES = 1_500_000;
const MAX_REDIRECTS = 3;

/** Strict URL validation: https, allowlisted host, no credentials/port. Prevents SSRF. */
export function parseNovelUrl(input: string): URL | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) return null;
  if (url.username || url.password || url.port) return null;
  return url;
}

/** Ranobelib paths look like /ru/book/123--some-slug ; derive a readable title hint. */
export function titleHintFromUrl(url: URL): string | null {
  const m = url.pathname.match(/\/book\/(?:\d+--)?([^/?#]+)/);
  if (!m) return null;
  const words = decodeURIComponent(m[1]).replace(/[-_]+/g, " ").trim();
  if (!words) return null;
  return words.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

/**
 * Best-effort, metadata-only import. Only the public book page is requested
 * (never chapter pages, which robots.txt disallows). The site is a
 * client-rendered app, so the page may carry no book data: in that case we
 * report failure and the caller falls back to manual entry.
 */
export async function importFromRanobelib(rawUrl: string): Promise<ImportOutcome> {
  const url = parseNovelUrl(rawUrl);
  if (!url) {
    return {
      ok: false,
      error: "Please paste a link that starts with https://ranobelib.me/",
      fallbackTitle: null,
      source_url: null,
    };
  }
  const hint = titleHintFromUrl(url);
  const fail = (error: string): ImportOutcome => ({
    ok: false,
    error,
    fallbackTitle: hint,
    source_url: url.toString(),
  });

  if (/\/chapter|\/read\b/i.test(url.pathname)) {
    return fail("That looks like a chapter link. Paste the link to the novel's main page instead.");
  }

  let html: string;
  try {
    html = await fetchHtml(url);
  } catch (e) {
    return fail(
      e instanceof Error ? e.message : "Couldn't reach Ranobelib. You can add the novel manually.",
    );
  }

  const $ = cheerio.load(html);
  const meta = (p: string) =>
    $(`meta[property="${p}"]`).attr("content")?.trim() ||
    $(`meta[name="${p}"]`).attr("content")?.trim() ||
    null;

  let title = meta("og:title");
  let description = meta("og:description");
  let cover = meta("og:image");
  let author: string | null = null;

  // JSON-LD (Book / CreativeWork) when the site provides it.
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data: unknown = JSON.parse($(el).text());
      for (const node of Array.isArray(data) ? data : [data]) {
        if (!node || typeof node !== "object") continue;
        const n = node as Record<string, unknown>;
        const a = n.author as { name?: unknown } | string | undefined;
        title ||= typeof n.name === "string" ? n.name : null;
        description ||= typeof n.description === "string" ? n.description : null;
        cover ||= typeof n.image === "string" ? n.image : null;
        author ||= typeof a === "string" ? a : typeof a?.name === "string" ? a.name : null;
      }
    } catch {
      // ignore malformed JSON-LD
    }
  });

  title = title ? cleanTitle(title) : null;
  const generic = !title || /читать ранобэ и новеллы|ranobelib\s*$/i.test(title) || title === "RanobeLIB";
  if (generic) {
    return fail(
      "Ranobelib didn't expose this novel's details to automated requests (the site loads them in the browser). Fill in the details below — chapter text can be added by paste or upload.",
    );
  }

  const notes = [
    "Imported metadata only. Chapter text is not downloaded: Ranobelib's robots.txt disallows chapter pages.",
  ];
  const safeCover = cover ? absoluteHttps(cover, url) : null;
  if (cover && !safeCover) notes.push("Cover image was ignored (not a valid https URL).");

  return {
    ok: true,
    metadata: {
      title,
      author,
      description: description ? description.slice(0, 4000) : null,
      cover_url: safeCover,
      source_url: url.toString(),
    },
    notes,
  };
}

function cleanTitle(t: string) {
  return t
    .replace(/\s*[|–—-]\s*RanobeLIB.*$/i, "")
    .replace(/^Читать\s+/i, "")
    .replace(/\s+онлайн.*$/i, "")
    .trim()
    .slice(0, 300);
}

function absoluteHttps(value: string, base: URL): string | null {
  try {
    const u = new URL(value, base);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** GET with manual redirect handling (each hop re-validated), timeout and size cap. */
async function fetchHtml(start: URL): Promise<string> {
  let current = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(current, {
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
      headers: { "user-agent": USER_AGENT, accept: "text/html" },
    });

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      const next = loc ? parseNovelUrl(new URL(loc, current).toString()) : null;
      if (!next) throw new Error("Ranobelib redirected somewhere we can't follow safely.");
      current = next;
      continue;
    }
    if (res.status === 403 || res.status === 429) {
      throw new Error("Ranobelib refused the automated request. You can add the novel manually.");
    }
    if (!res.ok) throw new Error(`Ranobelib responded with status ${res.status}.`);
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("text/html")) throw new Error("Unexpected response type from Ranobelib.");

    return await readCapped(res);
  }
  throw new Error("Too many redirects.");
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
