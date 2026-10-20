import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock("@/app/actions/reading", () => ({
  saveProgress: async () => ({ ok: true, data: undefined }),
  markChapterRead: async () => ({ ok: true, data: { lastRead: 0, skippedAhead: false } }),
  addBookmark: async () => ({ ok: false, error: "unused" }),
  recordReadingCheckpoint: async () => ({ ok: true, data: { applied: false } }),
  confirmReadingPosition: async () => ({ ok: true, data: { applied: false } }),
}));
vi.mock("@/app/actions/assistant", () => ({
  askAssistant: async () => ({ ok: false, error: "unused" }),
  clearChat: async () => ({ ok: true, data: undefined }),
  recapStory: async () => ({ ok: false, error: "unused" }),
}));

import { ChapterImage } from "@/components/chapter-image";
import { ChapterPickerPanel, pickerKeyAction } from "@/components/chapter-picker";
import { Reader } from "@/components/reader";
import { imageMarker } from "@/lib/chapter-content";

const BOOK = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
// The book's readable address: its name plus the first 8 characters of its id.
const BASE = "/library/the-sample-novel";
const IMG = (n: number) => `0000000${n}-0000-4000-8000-000000000000`;
const MISSING = "99999999-9999-4999-8999-999999999999";

const chapters = [1, 2, 3, 4, 5].map((n) => ({ number: n, title: `Title of chapter ${n}` }));
const content = [
  "Paragraph one.",
  "Paragraph two.",
  imageMarker(IMG(1)),
  "Paragraph three.",
  imageMarker(IMG(2)),
  "Paragraph four.",
  imageMarker(MISSING), // a marker whose picture row is gone
  "Paragraph five.",
].join("\n");
const images = {
  [IMG(1)]: { id: IMG(1), width: 900, height: 600, alt: "first picture" },
  [IMG(2)]: { id: IMG(2), width: 600, height: 900, alt: null },
};

const render = (over: Partial<Parameters<typeof Reader>[0]> = {}) =>
  renderToStaticMarkup(
    <Reader
      bookId={BOOK}
      bookTitle="The Sample Novel"
      bookSlug="the-sample-novel"
      chapter={{ number: 3, title: "Title of chapter 3", content, rev: 1 }}
      chapters={chapters}
      images={images}
      initialPct={0.4}
      bookSourceUrl={null}
      lastRead={2}
      partialBlock={-1}
      resumeBlock={null}
      resumeChapter={3}
      focusBlock={null}
      visit={false}
      volumeLabel="Vol. 1"
      chat={{ initialMessages: [], configured: true, modelLabel: "test-model" }}
      {...over}
    />,
  );

describe("reader: back to the book page", () => {
  const html = render();
  const back = html.match(/<a[^>]*data-testid="back-to-book"[^>]*>[\s\S]*?<\/a>/)![0];

  it("5. is a visible, labelled link to the CURRENT book's page", () => {
    expect(back).toContain(`href="${BASE}"`);
    expect(back).toContain("Back to book"); // desktop label
    expect(back).toMatch(/>Book</); // short mobile label
    expect(back).toContain("The Sample Novel"); // accessible name names the book
    expect(back).toMatch(/aria-label="Back to the book page: The Sample Novel"/);
  });

  it("is the first control in the header, in a fixed position", () => {
    const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
    expect(header.indexOf('data-testid="back-to-book"')).toBeLessThan(header.indexOf("Ch. 3"));
    expect(header.indexOf('data-testid="back-to-book"')).toBeLessThan(header.indexOf('aria-label="Add bookmark"'));
  });

  it("is not an arrow and not the previous-chapter control", () => {
    expect(back).not.toContain("←");
    expect(back).not.toContain("Previous");
    expect(html).toContain(`href="${BASE}/read/2"`); // the real previous-chapter link
    expect(html).toMatch(/Previous/);
    expect(back).not.toContain("/read/");
  });

  it("keeps the other reading controls: bookmark, settings, next chapter", () => {
    expect(html).toContain('aria-label="Add bookmark"');
    expect(html).toContain('aria-label="Reader settings"');
    expect(html).toContain("Next chapter");
  });
});

describe("reader: progress is saved when leaving", () => {
  const source = readFileSync(path.resolve(import.meta.dirname, "../components/reader.tsx"), "utf8");

  it("6. the back-to-book link and the chapter picker both flush the reading position before navigating", () => {
    const link = source.match(/<Link\s[^>]*?data-testid="back-to-book"[\s\S]*?>/)![0];
    expect(link).toContain("onClick={flushProgress}");
    expect(source).toMatch(/onSelect=\{\(n\) => \{\s*flushProgress\(\);/);
  });

  it("the position is also flushed on tab hide, page hide and when the reader unmounts", () => {
    expect(source).toContain('document.addEventListener("visibilitychange", onHide)');
    expect(source).toContain('window.addEventListener("pagehide", onHide)');
    // the effect's cleanup (runs when leaving the chapter/page) must itself flush, right after unsubscribing
    expect(source).toMatch(/removeEventListener\("pagehide", onHide\);\s*s\.flush\(\);/);
  });
});

describe("reader: chapter selector", () => {
  const html = render();

  it("is not a native <select> (whose pop-up the browser paints white)", () => {
    expect(html).not.toContain("<select");
    expect(html).not.toContain("<option");
  });

  it("shows the current chapter and is a labelled button that opens a dialog", () => {
    expect(html).toMatch(/aria-haspopup="dialog"/);
    expect(html).toContain("Ch. 3 — Title of chapter 3");
  });
});

describe("chapter picker panel: themed for light and dark", () => {
  const panel = renderToStaticMarkup(<ChapterPickerPanel chapters={chapters} current={3} onSelect={() => {}} onClose={() => {}} autoFocus={false} />);

  it("7. uses theme tokens for surface, text, border, hover and selected states", () => {
    expect(panel).toContain("bg-surface");
    expect(panel).toContain("text-foreground");
    expect(panel).toContain("border-border");
    expect(panel).toContain("hover:bg-accent-soft");
    expect(panel).toContain("text-muted");
    expect(panel).toContain("focus-visible:outline-accent");
  });

  it("marks exactly the current chapter as selected, with the accent style and a check", () => {
    expect(panel.match(/aria-selected="true"/g)).toHaveLength(1);
    const selected = panel.match(/<button[^>]*aria-selected="true"[^>]*>[\s\S]*?<\/button>/)![0];
    expect(selected).toContain("Ch. 3");
    expect(selected).toContain("bg-accent-soft");
    expect(selected).toContain("text-accent");
    expect(selected).toContain("✓");
  });

  it("lists every chapter as an option inside a labelled listbox", () => {
    expect(panel).toContain('role="listbox"');
    expect(panel.match(/role="option"/g)).toHaveLength(5);
  });

  it("is constrained to the screen so it stays usable on small devices", () => {
    expect(panel).toContain("w-[min(32rem,calc(100vw-1.5rem))]");
    expect(panel).toContain("max-h-[60vh]");
    expect(panel).toContain("overflow-y-auto");
  });
});

describe("no hard-coded colours in the reader UI (everything follows the theme)", () => {
  const files = ["reader.tsx", "chapter-picker.tsx", "chapter-image.tsx"].map((f) => [f, readFileSync(path.resolve(import.meta.dirname, "../components", f), "utf8")]);
  it.each(files)("%s only uses design tokens", (_name, source) => {
    expect(source).not.toMatch(/\b(?:bg|text|border|ring|outline|fill|stroke)-(?:white|black|gray|grey|slate|zinc|neutral|stone|red|blue|green|yellow|amber)(?:-\d{2,3})?\b/);
    expect(source).not.toMatch(/(?:className|style)=[^\n]*#[0-9a-fA-F]{3,8}\b/);
  });
});

describe("keyboard focus is visible", () => {
  // In Tailwind 4, "outline-none" sets the outline STYLE to none, so a "focus-visible:outline-2" on the same
  // element only changes width/colour and the ring never appears. A visible ring needs outline-solid.
  const files = ["reader.tsx", "chapter-picker.tsx", "chapter-image.tsx"].map((f) => [f, readFileSync(path.resolve(import.meta.dirname, "../components", f), "utf8")]);
  it.each(files)("%s never combines outline-none with a focus-visible ring that cannot show", (_name, source) => {
    for (const m of source.matchAll(/className=(?:"([^"]*)"|{`([^`]*)`})/g)) {
      const classes = m[1] ?? m[2];
      if (/(^|s)outline-none(s|$)/.test(classes) && /focus-visible:outline-d/.test(classes)) {
        expect(classes, "outline-none hides the focus ring").toMatch(/focus-visible:outline-solid/);
      }
    }
  });
  it("the picker's rows and search box use an explicitly solid focus ring", () => {
    const panelHtml = renderToStaticMarkup(<ChapterPickerPanel chapters={chapters} current={3} onSelect={() => {}} onClose={() => {}} autoFocus={false} />);
    expect(panelHtml.match(/focus-visible:outline-solid/g)!.length).toBeGreaterThanOrEqual(6);
    expect(panelHtml).not.toMatch(/(^|s)outline-none(s|")/);
  });
});

describe("picker keyboard behaviour", () => {
  it("moves with the arrows, clamps at both ends, jumps with Home/End", () => {
    expect(pickerKeyAction("ArrowDown", 0, 5)).toEqual({ type: "move", index: 1 });
    expect(pickerKeyAction("ArrowDown", 4, 5)).toEqual({ type: "move", index: 4 });
    expect(pickerKeyAction("ArrowUp", 0, 5)).toEqual({ type: "move", index: 0 });
    expect(pickerKeyAction("Home", 3, 5)).toEqual({ type: "move", index: 0 });
    expect(pickerKeyAction("End", 1, 5)).toEqual({ type: "move", index: 4 });
  });
  it("selects with Enter, closes with Escape, ignores other keys and empty lists", () => {
    expect(pickerKeyAction("Enter", 2, 5)).toEqual({ type: "select", index: 2 });
    expect(pickerKeyAction("Enter", 0, 0)).toBeNull();
    expect(pickerKeyAction("Escape", 2, 5)).toEqual({ type: "close" });
    expect(pickerKeyAction("a", 2, 5)).toBeNull();
    expect(pickerKeyAction("ArrowLeft", 2, 5)).toBeNull(); // left/right stay chapter navigation
  });
});

describe("reader: illustrations inline", () => {
  const html = render();
  const body = html.slice(html.indexOf("<article"));

  it("1. renders text and pictures in the original order", () => {
    const order = [...body.matchAll(/Paragraph (one|two|three|four|five)\.|<img[^>]*src="([^"]+)"|This illustration is missing/g)].map((m) => m[1] ?? m[2] ?? "missing");
    expect(order).toEqual([
      "one",
      "two",
      `/library/${BOOK}/image/${IMG(1)}`,
      "three",
      `/library/${BOOK}/image/${IMG(2)}`,
      "four",
      "missing",
      "five",
    ]);
  });

  it("keeps each picture's proportions: intrinsic size + aspect ratio, never cropped or stretched", () => {
    const first = body.match(/<img[^>]*first picture[^>]*>/)![0];
    expect(first).toContain('width="900"');
    expect(first).toContain('height="600"');
    expect(first).toContain("aspect-ratio:900 / 600");
    expect(first).toContain("object-contain");
    expect(first).toContain("max-w-full");
    expect(first).toContain("h-auto");
    expect(first).not.toContain("object-cover");
  });

  it("4. never drops a picture silently: a missing one is a visible placeholder", () => {
    expect(body).toContain("This illustration is missing from your library.");
    expect(body).toContain("Re-import this volume to restore it.");
  });

  it("a picture that fails to load gets a retry placeholder (component contract)", () => {
    const missing = renderToStaticMarkup(<ChapterImage src={null} alt="x" width={100} height={50} />);
    expect(missing).toContain("missing from your library");
    const ok = renderToStaticMarkup(<ChapterImage src="/a.png" alt="x" width={100} height={50} />);
    expect(ok).toContain('src="/a.png"');
    expect(ok).toContain('loading="lazy"');
  });
});

describe("reader: in-reader chat and reading position", () => {
  it("every paragraph and picture carries its stable block number, in order", () => {
    const html = render();
    expect([...html.matchAll(/data-block="(\d+)"/g)].map((m) => Number(m[1]))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("the chat shell is a closed, labelled panel that shows book, volume and chapter context", () => {
    const html = render();
    expect(html).toContain('data-testid="open-chat"');
    expect(html).toMatch(/aria-expanded="false"[^>]*aria-controls="reader-chat"|aria-controls="reader-chat"[^>]*aria-expanded="false"/);
    expect(html).toMatch(/<aside[^>]*id="reader-chat"[^>]*aria-hidden="true"/);
    expect(html).toContain("Vol. 1 · Ch. 3 — Title of chapter 3");
    expect(html).toContain("chapters 1–2");
    expect(html).toContain("Nothing later is ever sent");
  });

  it("panel is a bottom sheet on phones and a side panel on wide screens, themed with tokens", () => {
    const aside = render().match(/<aside[^>]*>/)![0];
    expect(aside).toContain("bottom-0");
    expect(aside).toContain("lg:w-[24rem]");
    expect(aside).toContain("bg-surface");
  });

  it("a citation visit explains itself, links back, and tracks nothing", () => {
    const html = render({ visit: true, resumeChapter: 5, focusBlock: 2 });
    expect(html).toContain('data-testid="visit-banner"');
    expect(html).toContain(`href="${BASE}/read/5"`);
    expect(render()).not.toContain('data-testid="visit-banner"');
  });

  it("the boundary follows the scroll position: nothing finishes a chapter automatically, and a question is refused if the position cannot be saved", () => {
    const source = readFileSync(path.resolve(import.meta.dirname, "../components/reader.tsx"), "utf8");
    expect(source).not.toContain("0.97"); // the old 'scrolled 97% = finished' rule is gone
    expect(source).not.toContain("lastBlock) void finishChapter");
    expect(source).toContain("if (visit || finished.current) return;");
    expect(source).toContain("const settle = window.setTimeout(release"); // only after the saved scroll position is restored
    expect(source).toContain("Your question was not sent.");
  });
});

describe("reader: performance-related behaviour", () => {
  it("illustration URLs carry the file type so the route can skip a database lookup", () => {
    const html = render({ images: { [IMG(1)]: { id: IMG(1), width: 900, height: 600, alt: "first picture", ext: "jpg" } } });
    expect(html).toContain(`src="/library/${BOOK}/image/${IMG(1)}?e=jpg"`);
    expect(render()).toContain(`src="/library/${BOOK}/image/${IMG(1)}"`); // no hint: unchanged URL
  });

  it("scrolling does not re-render the chapter: the progress bar is written straight to the DOM", () => {
    const source = readFileSync(path.resolve(import.meta.dirname, "../components/reader.tsx"), "utf8");
    expect(source).not.toContain("setPct");
    expect(source).toContain("barRef.current.style.width");
  });

  it("Next chapter shows feedback at once, cannot be double-clicked, and re-enables on a failed save", () => {
    const source = readFileSync(path.resolve(import.meta.dirname, "../components/reader.tsx"), "utf8");
    expect(source).toContain("disabled={navigating}");
    expect(source).toContain('"Opening…"');
    expect(source).toContain("setNavigating(false)");
    expect(source).toContain("if (boundary >= chapter.number) return;"); // re-reading a finished chapter waits for no network call
  });
});

describe("reader: pictures near the reading position load first", () => {
  it("the first two pictures from where you resume are eager and high priority; earlier ones stay lazy", () => {
    const html = render({ initialPct: 0.4 }); // block 3 of 8: the picture at block 4 is next, the one at block 2 is behind
    const img = (n: number) => html.match(new RegExp(`<img[^>]*image/${IMG(n)}[^>]*>`))![0];
    expect(img(2)).toContain('fetchPriority="high"');
    expect(img(2)).toContain('loading="eager"');
    expect(img(1)).toContain('loading="lazy"');
    expect(img(1)).not.toContain("fetchPriority");
  });

  it("the chapter body is memoised, so unrelated state changes do not rebuild hundreds of paragraphs", () => {
    const source = readFileSync(path.resolve(import.meta.dirname, "../components/reader.tsx"), "utf8");
    expect(source).toMatch(/const body = useMemo\(/);
    expect(source).toContain("{body}");
  });
});
