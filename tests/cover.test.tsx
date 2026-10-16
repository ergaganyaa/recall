import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { VolumeCoverBrowser, VolumeCoverViewer } from "@/components/volume-cover-browser";
import { defaultVolumeCoverId, readingVolumeIndex, resolveCover, volumeCards, type CoverBook, type CoverVolume } from "@/lib/cover";
import { ALICE, BOB, bootDb } from "./helpers/db";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));

const book: CoverBook = { id: "b1", cover_image_id: null, cover_url: null };
const AT = "2026-01-01T00:00:00Z";
// Three volumes of two chapters each: chapters 1-2 in vol 1, 3-4 in vol 2, 5-6 in vol 3.
const vol = (n: number, cover: string | null, over: Partial<CoverVolume> = {}): CoverVolume & { title: string | null; arc: string | null } => ({
  title: null,
  arc: null,
  id: `v${n}`,
  number: n,
  arc_order: 1,
  imported_at: AT,
  cover_image_id: cover,
  ...over,
});
const volumes = [vol(1, "c1"), vol(2, "c2"), vol(3, "c3")];
const chapters = [1, 2, 3, 4, 5, 6].map((n) => ({ number: n, volume_id: `v${Math.ceil(n / 2)}` }));
const at = (currentChapter: number | null) => ({ chapters, currentChapter });
const cover = (place?: ReturnType<typeof at>, vols: CoverVolume[] = volumes, b: CoverBook = book) => resolveCover(b, vols, place);
const url = (id: string) => `/library/b1/image/${id}`;

describe("default cover follows the reading position", () => {
  it("1. a reader in volume 3 sees volume 3's cover", () => {
    expect(cover(at(5))).toEqual({ src: url("c3"), source: "volume" });
    expect(cover(at(6))).toEqual({ src: url("c3"), source: "volume" });
  });

  it("2. another reader of the same volumes, who is in volume 1, sees volume 1's cover", () => {
    expect(cover(at(2)).src).toBe(url("c1"));
    expect(cover(at(5)).src).toBe(url("c3")); // and the first reader is unaffected
  });

  it("3. with no progress the first volume (in reading order) is used, even if it was imported last", () => {
    expect(cover(undefined).src).toBe(url("c1"));
    expect(cover(at(null)).src).toBe(url("c1"));
    const importedLastFirstInOrder = [vol(1, "c1", { imported_at: "2026-09-01T00:00:00Z" }), vol(2, "c2", { imported_at: "2026-01-01T00:00:00Z" })];
    expect(cover(undefined, importedLastFirstInOrder).src).toBe(url("c1"));
  });

  it("is not the most recently imported volume and not the highest number", () => {
    const newest = [vol(1, "c1", { imported_at: "2026-01-01T00:00:00Z" }), vol(2, "c2", { imported_at: "2026-06-01T00:00:00Z" })];
    const place = { chapters: chapters.slice(0, 4), currentChapter: 1 };
    expect(resolveCover(book, newest, place).src).toBe(url("c1"));
  });

  it("uses reading order (arc, then number): a side volume 4.5 sits between 4 and 5", () => {
    const vs = [vol(5, "c5"), vol(4.5, "c45"), vol(4, "c4")];
    const ch = [
      { number: 1, volume_id: "v4" },
      { number: 2, volume_id: "v4.5" },
      { number: 3, volume_id: "v5" },
    ];
    expect(resolveCover(book, vs, { chapters: ch, currentChapter: 2 }).src).toBe(url("c45"));
    expect(readingVolumeIndex([{ id: "v4" }, { id: "v4.5" }, { id: "v5" }], { chapters: ch, currentChapter: 3 })).toBe(2);
  });

  it("7. moving to another volume changes the default cover", () => {
    const before = cover(at(2)).src;
    const after = cover(at(3)).src; // the reader opened a chapter of volume 2
    expect([before, after]).toEqual([url("c1"), url("c2")]);
  });
});

describe("4. fallbacks when the reading volume has no cover", () => {
  it("prefers the preceding volume, then the following ones, nearest first", () => {
    const noMiddle = [vol(1, "c1"), vol(2, null), vol(3, "c3")];
    expect(cover(at(3), noMiddle).src).toBe(url("c1")); // tie: the earlier (preceding) volume wins
    const noCurrentOrBefore = [vol(1, null), vol(2, null), vol(3, "c3")];
    expect(cover(at(1), noCurrentOrBefore).src).toBe(url("c3"));
    const farBefore = [vol(1, "c1"), vol(2, null), vol(3, null), vol(4, "c4")];
    const ch = [1, 2, 3, 4].map((n) => ({ number: n, volume_id: `v${n}` }));
    expect(resolveCover(book, farBefore, { chapters: ch, currentChapter: 3 }).src).toBe(url("c4")); // 4 is nearer than 1
  });

  it("ignores volumes whose import never finished", () => {
    const vs = [vol(1, "c1"), vol(2, "c2", { imported_at: null })];
    expect(defaultVolumeCoverId(vs, at(3))).toBe("c1");
  });

  it("no volume cover at all: a linked image, then the placeholder", () => {
    const none = [vol(1, null), vol(2, null)];
    expect(cover(at(1), none, { ...book, cover_url: "https://x/y.png" })).toEqual({ src: "https://x/y.png", source: "linked" });
    expect(cover(at(1), none)).toEqual({ src: null, source: "none" });
    expect(cover(at(1), [])).toEqual({ src: null, source: "none" });
  });

  it("a linked cover URL no longer beats the volume cover (the volume you are reading comes first)", () => {
    expect(cover(at(3), volumes, { ...book, cover_url: "https://x/y.png" }).source).toBe("volume");
  });
});

describe("8. a manually pinned cover keeps precedence", () => {
  it("wins over every volume cover and any position", () => {
    const manual = { ...book, cover_image_id: "manual-1" };
    for (const place of [undefined, at(1), at(5)]) expect(cover(place, volumes, manual)).toEqual({ src: url("manual-1"), source: "manual" });
  });
});

describe("9. empty books, deleted volumes and invalid progress", () => {
  it("a book with no volumes or chapters gives no cards and no cover", () => {
    expect(volumeCards({ volumes: [], chapters: [], currentChapter: null, lastRead: 0 })).toEqual({ cards: [], currentIndex: 0 });
    expect(cover({ chapters: [], currentChapter: 1 }, [])).toEqual({ src: null, source: "none" });
  });

  it("progress that points at a chapter that no longer exists falls back to the nearest earlier chapter's volume", () => {
    expect(cover({ chapters, currentChapter: 99 }).src).toBe(url("c3")); // beyond the end: the last chapter's volume
    expect(cover({ chapters, currentChapter: 0 }).src).toBe(url("c1")); // before the start
    expect(cover({ chapters: [], currentChapter: 4 }).src).toBe(url("c1")); // no chapters at all
  });

  it("chapters of a deleted volume (no volume) use the nearest earlier chapter that has one", () => {
    const orphaned = chapters.map((c) => (c.volume_id === "v2" ? { ...c, volume_id: null } : c));
    expect(resolveCover(book, [volumes[0], volumes[2]], { chapters: orphaned, currentChapter: 4 }).src).toBe(url("c1"));
  });
});

describe("volume cards and the Continue / Open action", () => {
  const cardsFor = (currentChapter: number | null, lastRead: number) => volumeCards({ volumes, chapters, currentChapter, lastRead });

  it("6. the volume being read continues at the saved chapter; others get the right chapter", () => {
    const { cards, currentIndex } = cardsFor(4, 3); // finished 1-3, now in chapter 4 (volume 2)
    expect(currentIndex).toBe(1);
    expect(cards.map((c) => c.isCurrent)).toEqual([false, true, false]);
    expect(cards[0].target).toEqual({ chapter: 1, kind: "reread" }); // fully finished
    expect(cards[1].target).toEqual({ chapter: 4, kind: "continue" }); // saved position
    expect(cards[2].target).toEqual({ chapter: 5, kind: "start" }); // not started
    expect(cards.map((c) => c.finishedCount)).toEqual([2, 1, 0]);
  });

  it("a partly finished volume that is not the current one resumes at its first unfinished chapter", () => {
    const { cards } = cardsFor(5, 3); // reading volume 3; volume 2 has chapter 3 finished, 4 not
    expect(cards[1].target).toEqual({ chapter: 4, kind: "resume" });
    expect(cards[2].isCurrent).toBe(true);
  });

  it("with no progress nothing is marked as being read and every volume starts at its first chapter", () => {
    const { cards } = cardsFor(1, 0);
    expect(cards.map((c) => c.isCurrent)).toEqual([false, false, false]);
    expect(cards.map((c) => c.target.chapter)).toEqual([1, 3, 5]);
  });

  it("a volume without chapters has no target, and a cover with an unfinished import is not shown", () => {
    const { cards } = volumeCards({ volumes: [vol(1, "c1"), vol(2, "c2", { imported_at: null })], chapters: [{ number: 1, volume_id: "v1" }], currentChapter: 1, lastRead: 0 });
    expect(cards[1].target).toEqual({ chapter: null, kind: "empty" });
    expect(cards[1].coverImageId).toBeNull();
  });

  it("is pure: it never mutates its input", () => {
    const vs = JSON.stringify(volumes);
    const cs = JSON.stringify(chapters);
    cardsFor(4, 3);
    expect([JSON.stringify(volumes), JSON.stringify(chapters)]).toEqual([vs, cs]);
  });
});

describe("the book page cover and its full-screen viewer", () => {
  const cardsOf = (n: number) => {
    const vs = Array.from({ length: n }, (_, i) => vol(i + 1, i === 1 ? null : `c${i + 1}`));
    const cs = vs.flatMap((v, i) => [{ number: i * 2 + 1, volume_id: v.id }, { number: i * 2 + 2, volume_id: v.id }]);
    const { cards, currentIndex } = volumeCards({ volumes: vs, chapters: cs, currentChapter: 3, lastRead: 2 });
    return { cards: cards.map((c) => ({ ...c, coverSrc: c.coverImageId ? `/library/b1/image/${c.coverImageId}` : null })), currentIndex };
  };
  const source = readFileSync(path.resolve(import.meta.dirname, "../components/volume-cover-browser.tsx"), "utf8");
  const page = (n: number) => {
    const { cards, currentIndex } = cardsOf(n);
    return renderToStaticMarkup(<VolumeCoverBrowser bookTitle="The Sample Novel" basePath="/library/the-sample-novel" cards={cards} initialIndex={currentIndex} />);
  };
  const viewer = (n: number, index?: number) => {
    const { cards, currentIndex } = cardsOf(n);
    return renderToStaticMarkup(
      <VolumeCoverViewer bookTitle="The Sample Novel" basePath="/library/the-sample-novel" cards={cards} initialIndex={index ?? currentIndex} onClose={() => {}} />,
    );
  };

  it("the book page shows ONE cover, the volume being read, as a button that opens the covers", () => {
    const html = page(4);
    expect(html).toMatch(/<button[^>]*data-testid="open-covers"[^>]*aria-haspopup="dialog"|<button[^>]*aria-haspopup="dialog"[^>]*data-testid="open-covers"/);
    expect(html).toContain("The Sample Novel Vol. 2"); // volume 2 is being read (and has no cover: placeholder)
    expect(html).toContain('data-testid="reading-now"');
    expect(html).toContain("tap to browse covers");
    expect(html).toContain("4 volumes");
    expect(html.match(/<img/g) ?? []).toHaveLength(0); // volume 2 has no cover image in this fixture
    expect(html).not.toContain('role="dialog"'); // closed until you click
    expect(html).not.toContain('aria-label="Next volume"'); // no arrows on the page itself
  });

  it("a single-volume book has nothing to browse, so no hint or count is shown", () => {
    const html = page(1);
    expect(html).not.toContain("tap to browse covers");
    expect(html).not.toContain("1 volumes");
  });

  it("the viewer is a modal dialog with a close button, opening on the volume being read", () => {
    const html = viewer(4);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('data-testid="close-covers"');
    expect(html).toContain("Vol. 2");
    expect(html).toContain("2 of 4");
    expect(html).toContain('data-testid="viewer-reading-now"');
    expect(html).toMatch(/href="\/library\/the-sample-novel\/read\/3"[^>]*>Continue reading · Ch\. 3</);
  });

  it("only the selected cover and its two neighbours are ever rendered, however many volumes there are", () => {
    const html = viewer(40, 10);
    expect(html.match(/<img/g)).toHaveLength(3);
    expect(html.match(/role="tab"/g)).toHaveLength(40); // text chips, no images
    expect(viewer(40, 0).match(/<img/g)).toHaveLength(1); // volume 1 only: it has no previous, and volume 2 (its neighbour) has no cover in this fixture
  });

  it("a volume without a cover shows the generated placeholder, not a broken image", () => {
    const html = viewer(4, 1); // volume 2 has no cover; its neighbours do
    expect(html).toContain("The Sample Novel Vol. 2");
    expect(html.match(/<img/g)).toHaveLength(2);
  });

  it("is touch friendly and themed: swipe area, 44px buttons, labelled controls, design tokens only", () => {
    const html = viewer(4);
    expect(html).toContain("touch-pan-y");
    expect(html).toContain("size-11");
    expect(html).toContain('aria-label="Next volume"');
    expect(html).toContain('aria-label="Previous volume"');
    expect(html).toContain("bg-background");
    expect(source).not.toMatch(/(?:bg|text|border|ring|outline)-(?:white|black|gray|slate|zinc|neutral|red|blue|green)(?:-d{2,3})?/);
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  it("supports swipe, Esc, arrow keys, focus handling and scroll lock", () => {
    expect(source).toContain("onPointerUp");
    expect(source).toContain('e.key === "Escape"');
    expect(source).toContain('e.key === "ArrowLeft"');
    expect(source).toContain('e.key === "ArrowRight"');
    expect(source).toContain("document.body.style.overflow");
    expect(source).toContain("opener.current?.focus()"); // focus returns to the cover when closed
  });

  it("5. browsing only browses: no server action, no request, and the action is a plain link", () => {
    expect(source).not.toMatch(/@\/app\/actions|saveProgress|markChapterRead|fetch\(|<form|router\./);
    const html = viewer(4);
    expect(html).toMatch(/<a [^>]*data-testid="volume-action"/);
    expect(html).toContain("Browsing covers doesn&#x27;t change your reading progress.");
  });

  it("an empty volume shows a message instead of a link", () => {
    const { cards } = volumeCards({ volumes: [vol(1, "c1")], chapters: [], currentChapter: null, lastRead: 0 });
    const html = renderToStaticMarkup(<VolumeCoverViewer bookTitle="B" basePath="/library/b" cards={cards.map((c) => ({ ...c, coverSrc: null }))} initialIndex={0} onClose={() => {}} />);
    expect(html).toContain("No chapters yet");
    expect(html).not.toContain('href="/library/b/read/');
  });
});

describe("cover behaviour against the real schema (per-user progress, deletions)", () => {
  let t: Awaited<ReturnType<typeof bootDb>>;
  beforeAll(async () => {
    t = await bootDb();
  });
  afterAll(async () => {
    await t.db.close();
  });

  /** Mimics a successful import: a volume (one chapter), a cover image row, then the finalising update. */
  async function importVolume(bookId: string, number: number, opts: { cover?: boolean; finish?: boolean } = {}) {
    const rows = await t.addVolume(bookId, { number, chapters: [`Ch of vol ${number}`] });
    const volumeId = rows[0].volume_id;
    let coverId: string | null = null;
    if (opts.cover !== false) {
      const img = await t.db.query<{ id: string }>("insert into book_images (book_id, storage_path, mime_type) values ($1, $2, 'image/jpeg') returning id", [bookId, `u/${bookId}/cover-${number}.jpg`]);
      coverId = img.rows[0].id;
    }
    if (opts.finish !== false) await t.db.query("update volumes set cover_image_id = $2, imported_at = now() where id = $1", [volumeId, coverId]);
    return { volumeId, coverId, chapter: rows[0].chapter_number };
  }

  /** What the library query computes: the signed-in user's own rows (row level security), then resolveCover. */
  const shown = async (bookId: string) => {
    const b = (await t.db.query<{ id: string; cover_image_id: string | null; cover_url: string | null }>("select id, cover_image_id, cover_url from books where id = $1", [bookId])).rows[0];
    const v = (await t.db.query<{ id: string; number: string; arc_order: number; imported_at: Date | null; cover_image_id: string | null }>("select id, number, arc_order, imported_at, cover_image_id from volumes where book_id = $1", [bookId])).rows;
    const c = (await t.db.query<{ number: number; volume_id: string | null }>("select number, volume_id from chapters where book_id = $1", [bookId])).rows;
    const p = (await t.db.query<{ current_chapter: number }>("select current_chapter from reading_progress where book_id = $1", [bookId])).rows[0];
    return resolveCover(b, v.map((r) => ({ ...r, number: Number(r.number), imported_at: r.imported_at ? new Date(r.imported_at).toISOString() : null })), {
      chapters: c,
      currentChapter: p ? p.current_chapter : null,
    });
  };
  const readAt = (bookId: string, chapter: number) => t.db.query("update reading_progress set current_chapter = $2 where book_id = $1", [bookId, chapter]);

  it("1+2+7. each account's cover follows its OWN position, and updates when that position moves", async () => {
    // Books are private to an account, so two readers each hold their own copy with their own progress row.
    await t.as(ALICE);
    const a = await t.newBook("Shared Series");
    const a1 = await importVolume(a, 1);
    await importVolume(a, 2);
    const a3 = await importVolume(a, 3);
    await readAt(a, a3.chapter);
    expect((await shown(a)).src).toContain(a3.coverId!);

    await t.as(BOB);
    const b = await t.newBook("Shared Series");
    const b1 = await importVolume(b, 1);
    await importVolume(b, 2);
    await importVolume(b, 3);
    await readAt(b, b1.chapter);
    expect((await shown(b)).src).toContain(b1.coverId!);

    // Bob cannot see or move Alice's progress, and Alice's cover is unchanged by Bob reading.
    expect((await t.db.query("select * from reading_progress where book_id = $1", [a])).rows).toEqual([]);
    await t.as(ALICE);
    expect((await shown(a)).src).toContain(a3.coverId!);
    await readAt(a, a1.chapter); // Alice moves back to volume 1
    expect((await shown(a)).src).toContain(a1.coverId!);
  });

  it("3. a reader with no progress row sees the first volume's cover", async () => {
    await t.as(ALICE);
    const bk = await t.newBook();
    const v1 = await importVolume(bk, 1);
    await importVolume(bk, 2);
    await t.db.query("delete from reading_progress where book_id = $1", [bk]);
    expect((await shown(bk)).src).toContain(v1.coverId!);
  });

  it("9. deleting a volume falls back gracefully, and the removed cover row is gone", async () => {
    await t.as(ALICE);
    const bk = await t.newBook();
    const v1 = await importVolume(bk, 1);
    const v2 = await importVolume(bk, 2);
    await readAt(bk, v2.chapter);
    expect((await shown(bk)).src).toContain(v2.coverId!);
    await t.db.query("select delete_volume($1)", [v2.volumeId]);
    expect((await t.db.query("select 1 from book_images where id = $1", [v2.coverId])).rows).toEqual([]);
    expect((await shown(bk)).src).toContain(v1.coverId!); // progress now points past the end: nearest earlier volume
    await t.db.query("select delete_volume($1)", [v1.volumeId]);
    expect(await shown(bk)).toEqual({ src: null, source: "none" });
  });

  it("8. a manually pinned cover is preserved through imports, progress changes and deletions", async () => {
    await t.as(ALICE);
    const bk = await t.newBook();
    const manual = (await t.db.query<{ id: string }>("insert into book_images (book_id, storage_path, mime_type) values ($1, 'x/manual.jpg', 'image/jpeg') returning id", [bk])).rows[0].id;
    await t.db.query("update books set cover_image_id = $2 where id = $1", [bk, manual]);
    const v1 = await importVolume(bk, 1);
    await readAt(bk, v1.chapter);
    expect((await shown(bk)).source).toBe("manual");
    await t.db.query("select delete_volume($1)", [v1.volumeId]);
    expect((await shown(bk)).source).toBe("manual");
    const v2 = await importVolume(bk, 2);
    await t.db.query("update books set cover_image_id = null where id = $1", [bk]);
    await readAt(bk, v2.chapter);
    expect((await shown(bk)).src).toContain(v2.coverId!); // back to the automatic cover
  });

  it("4. a volume whose import did not finish never becomes the cover", async () => {
    await t.as(ALICE);
    const bk = await t.newBook();
    const good = await importVolume(bk, 1);
    const unfinished = await importVolume(bk, 2, { finish: false });
    await readAt(bk, unfinished.chapter);
    expect((await shown(bk)).src).toContain(good.coverId!);
  });

  it("5. choosing/browsing covers writes nothing: progress is exactly as it was", async () => {
    await t.as(ALICE);
    const bk = await t.newBook();
    await importVolume(bk, 1);
    const v2 = await importVolume(bk, 2);
    await readAt(bk, v2.chapter);
    const before = (await t.db.query("select * from reading_progress where book_id = $1", [bk])).rows;
    const { cards } = volumeCards({
      volumes: (await t.db.query<{ id: string; number: string; arc_order: number; title: string | null; arc: string | null; imported_at: Date | null; cover_image_id: string | null }>("select id, number, arc_order, title, arc, imported_at, cover_image_id from volumes where book_id = $1", [bk])).rows.map((r) => ({ ...r, number: Number(r.number), imported_at: r.imported_at ? r.imported_at.toISOString() : null })),
      chapters: (await t.db.query<{ number: number; volume_id: string | null }>("select number, volume_id from chapters where book_id = $1", [bk])).rows,
      currentChapter: v2.chapter,
      lastRead: 0,
    });
    expect(cards).toHaveLength(2);
    expect((await t.db.query("select * from reading_progress where book_id = $1", [bk])).rows).toEqual(before);
  });

  it("another user cannot read or alter these covers", async () => {
    await t.as(ALICE);
    const bk = await t.newBook();
    const v = await importVolume(bk, 1);
    await t.as(BOB);
    expect((await t.db.query("select * from volumes where book_id = $1", [bk])).rows).toEqual([]);
    expect((await t.db.query("select * from book_images where id = $1", [v.coverId])).rows).toEqual([]);
  });
});
