import { describe, expect, it } from "vitest";
import {
  contentKind,
  coverSrc,
  imageIdsIn,
  imageMarker,
  prepareChapter,
  stripImageMarkers,
  toBlocks,
} from "@/lib/chapter-content";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("image markers", () => {
  const content = `First paragraph.\n${imageMarker(A)}\nSecond paragraph.\n${imageMarker(B)}`;

  it("keeps text and images in their exact order", () => {
    expect(toBlocks(content).map((b) => (b.type === "image" ? `img:${b.id.slice(0, 2)}` : b.text))).toEqual([
      "First paragraph.",
      "img:11",
      "Second paragraph.",
      "img:22",
    ]);
    expect(imageIdsIn(content)).toEqual([A, B]);
  });

  it("strips markers so images can never be indexed or counted", () => {
    expect(stripImageMarkers(content)).toBe("First paragraph.\nSecond paragraph.");
    expect(stripImageMarkers(imageMarker(A))).toBe("");
  });

  it("only treats a whole line as a marker, not text that mentions one", () => {
    expect(toBlocks(`See [[image:${A}]] in the text`)).toEqual([{ type: "text", text: `See [[image:${A}]] in the text` }]);
    expect(toBlocks("[[image:not-a-uuid]]")[0].type).toBe("text");
  });
});

describe("prepareChapter", () => {
  it("chunks and counts only the marker-free text", () => {
    const r = prepareChapter(`Alpha beta gamma.\n${imageMarker(A)}\nDelta epsilon.`, [A]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.wordCount).toBe(5);
    expect(r.value.imageIds).toEqual([A]);
    expect(r.value.chunks.join("\n")).not.toMatch(/image|\[\[/);
    expect(r.value.content).toContain(imageMarker(A)); // still displayed in place
  });

  it("accepts an image-only chapter (a wordless page is real content)", () => {
    const r = prepareChapter(imageMarker(A), [A]);
    expect(r).toMatchObject({ ok: true, value: { wordCount: 0, chunks: [], imageIds: [A] } });
  });

  it("rejects a chapter with neither text nor images", () => {
    expect(prepareChapter("   \n  ", [])).toMatchObject({ ok: false });
  });

  it("rejects markers without uploads, uploads without markers, and duplicates", () => {
    expect(prepareChapter(`x\n${imageMarker(A)}`, [])).toMatchObject({ ok: false, error: expect.stringMatching(/not uploaded/) });
    expect(prepareChapter("x", [A])).toMatchObject({ ok: false, error: expect.stringMatching(/not placed/) });
    expect(prepareChapter(`x\n${imageMarker(A)}\n${imageMarker(A)}`, [A])).toMatchObject({ ok: false, error: expect.stringMatching(/twice/) });
  });

  it("is case-insensitive for ids", () => {
    expect(prepareChapter(`x\n${imageMarker(A.toUpperCase())}`, [A])).toMatchObject({ ok: true });
  });
});

describe("contentKind", () => {
  it("separates full text, illustration-only and metadata-only chapters", () => {
    expect(contentKind({ word_count: 10, image_count: 0 })).toBe("full_text");
    expect(contentKind({ word_count: 10, image_count: 2 })).toBe("full_text");
    expect(contentKind({ word_count: 0, image_count: 2 })).toBe("illustrations_only");
    expect(contentKind({ word_count: 0, image_count: 0 })).toBe("metadata_only");
  });
});

describe("coverSrc", () => {
  it("prefers an uploaded cover over a linked one", () => {
    expect(coverSrc({ id: "b", cover_image_id: "i", cover_url: "https://x/y.png" })).toBe("/library/b/image/i");
    expect(coverSrc({ id: "b", cover_image_id: null, cover_url: "https://x/y.png" })).toBe("https://x/y.png");
    expect(coverSrc({ id: "b", cover_image_id: null, cover_url: null })).toBeNull();
  });
});
