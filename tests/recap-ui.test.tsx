import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/assistant", () => ({
  askAssistant: async () => ({ ok: false, error: "unused" }),
  clearChat: async () => ({ ok: true, data: undefined }),
  recapStory: async () => ({ ok: false, error: "unused" }),
}));

import { AssistantChat, SELECTION_SUGGESTIONS, type ChatSelection } from "@/components/assistant-chat";
import { RecapCard } from "@/components/recap-card";
import { MAX_QUOTE_CHARS, MAX_SELECTION_BLOCKS, selectionRange, tidyQuote } from "@/lib/selection";

const BOOK = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const read = (f: string) => readFileSync(path.resolve(import.meta.dirname, "..", f), "utf8");

describe("selectionRange (highlight -> paragraph numbers)", () => {
  it("orders the ends, keeps at most three paragraphs, and says when it clipped", () => {
    expect(selectionRange(4, 4)).toEqual({ from: 4, to: 4, clipped: false });
    expect(selectionRange(6, 4)).toEqual({ from: 4, to: 6, clipped: false }); // dragged upwards
    expect(selectionRange(2, 9)).toEqual({ from: 2, to: 2 + MAX_SELECTION_BLOCKS - 1, clipped: true });
    expect(selectionRange(9, 2)).toEqual({ from: 2, to: 4, clipped: true });
  });

  it("refuses a highlight outside the chapter text or with nonsense numbers", () => {
    expect(selectionRange(null, 3)).toBeNull();
    expect(selectionRange(3, null)).toBeNull();
    expect(selectionRange(-1, 3)).toBeNull();
    expect(selectionRange(1.5, 3)).toBeNull();
    expect(selectionRange(Number.NaN, 3)).toBeNull();
  });

  it("tidies and bounds the quote", () => {
    expect(tidyQuote("  one \n\n two\t three ")).toBe("one two three");
    expect(tidyQuote("x".repeat(2000)).length).toBe(MAX_QUOTE_CHARS);
  });
});

describe("the chat with a selected passage", () => {
  const selection: ChatSelection = { chapter: 3, from: 2, to: 4, rev: 1, quote: "the brass key opened the vault under the great clock", clipped: true };
  const render = (sel: ChatSelection | null) =>
    renderToStaticMarkup(
      <AssistantChat
        variant="panel"
        bookId={BOOK}
        initialMessages={[]}
        boundary={2}
        configured
        modelLabel="test-model"
        context={{ book: "The Sample Novel", volume: "Vol. 1", chapter: 3, chapterTitle: "The Tower", readTo: "chapters 1–2 and the text above your current position" }}
        currentChapter={3}
        selection={sel}
        onClearSelection={() => {}}
      />,
    );

  it("shows the selected passage, the suggested questions and a way to remove it", () => {
    const html = render(selection);
    expect(html).toContain('data-testid="selection-chip"');
    expect(html).toContain("About this passage:");
    expect(html).toContain("the brass key opened the vault");
    for (const q of SELECTION_SUGGESTIONS) expect(html).toContain(q.replace(/'/g, "&#x27;"));
    expect(html).toContain('data-testid="selection-clear"');
    expect(html).toContain("first three paragraphs");
    expect(html).toContain("apart from the passage you selected (for this question only)");
  });

  it("shows nothing about a passage when none is selected", () => {
    const html = render(null);
    expect(html).not.toContain("selection-chip");
    expect(html).toContain("Nothing later is ever sent");
    expect(html).not.toContain("apart from the passage");
  });

  it("the chat keeps its recap button next to the existing controls", () => {
    const html = render(null);
    expect(html).toContain('data-testid="recap-button"');
    expect(html).toContain("Remind me what happened");
    expect(html).toContain('data-testid="assistant-chat"');
  });

  it("sends only numbers and a quote with the question, never passage text of its own", () => {
    const source = read("components/assistant-chat.tsx");
    expect(source).toContain("selection ? { chapter: selection.chapter, from: selection.from, to: selection.to, rev: selection.rev, quote: selection.quote }");
  });
});

describe("the recap card on the book page", () => {
  const card = (props: { configured: boolean; started: boolean }) => renderToStaticMarkup(<RecapCard bookId={BOOK} {...props} />);

  it("offers the recap when the book has been started and the assistant is set up", () => {
    const html = card({ configured: true, started: true });
    expect(html).toContain("Remind me what happened");
    expect(html).not.toContain("disabled=\"\"");
    expect(html).not.toContain('data-testid="recap-result"'); // nothing is generated until the reader asks
  });

  it("explains itself when it cannot run: not started, or no API key", () => {
    expect(card({ configured: true, started: false })).toContain("disabled=\"\"");
    const noKey = card({ configured: false, started: true });
    expect(noKey).toContain("needs a free Gemini API key");
  });

  it("sends only the book id (the server decides what has been read) and does not block the page", () => {
    const source = read("components/recap-card.tsx");
    expect(source).toContain("recapStory(bookId)");
    expect(source).toContain("useTransition");
    expect(source).not.toMatch(/current_chapter|last_read|boundary:/);
  });
});

describe("the reader's ask-about-this-passage button", () => {
  const source = read("components/reader.tsx");

  it("listens to the selection, only inside the chapter text, and offers one clear action", () => {
    expect(source).toContain('document.addEventListener("selectionchange"');
    expect(source).toContain('[data-testid="chapter-body"]');
    expect(source).toContain('data-testid="ask-about-passage"');
    expect(source).toContain("Ask AI about this passage");
    expect(source).toContain("onMouseDown={(e) => e.preventDefault()}"); // pressing it keeps the highlight
  });

  it("opening the chat from a selection keeps the reader on the same paragraph", () => {
    expect(source).toMatch(/function askAboutPicked\(\) \{[\s\S]*?if \(!chatOpen\) captureAnchor\(\)/);
  });

  it("passes the revision with the numbers, so the server can reject a stale selection", () => {
    expect(source).toContain("rev: chapter.rev");
  });

  it("the chat is passed the selection and clears it when asked", () => {
    expect(source).toContain("selection={askSelection}");
    expect(source).toContain("onClearSelection={() => setAskSelection(null)}");
  });
});

describe("the server never takes text or a position from the browser", () => {
  const action = read("app/actions/assistant.ts");
  it("recapStory has no parameter besides the book id", () => {
    expect(action).toMatch(/export async function recapStory\(bookId: string\)/);
  });
  it("the selection is re-read by the database and the quote only filters the server's own text", () => {
    expect(action).toContain('supabase.rpc("selection_context"');
    expect(action).toContain("squash(text).includes(squash(s.quote))");
  });
});

describe("the ask button survives a phone clearing the highlight (regression)", () => {
  // On phones the browser clears the text highlight when you tap anything, before the tap's click is delivered. The
  // button used to disappear with the highlight, so tapping it did nothing. Reproduced in headless Chrome with a
  // touch tap that clears the selection on touchstart; fixed by reacting on press and by keeping the last highlight for a moment.
  const source = read("components/reader.tsx");

  it("reacts on press, not only on click", () => {
    expect(source).toMatch(/onPointerDown=\{\(e\) => \{\s*e\.preventDefault\(\);\s*askAboutPicked\(\);/);
    expect(source).toContain("onClick={askAboutPicked}"); // keyboard users
  });

  it("keeps the last highlight for a few seconds after it clears instead of dropping it at once", () => {
    expect(source).toContain("scheduleForget");
    expect(source).toContain("window.setTimeout(() => setPicked(null), 3000)");
    expect(source).not.toMatch(/sel\.isCollapsed \|\| sel\.rangeCount === 0\) return setPicked\(null\)/);
  });

  it("puts the cursor in the question box on wide screens only", () => {
    const chat = read("components/assistant-chat.tsx");
    expect(chat).toContain('window.matchMedia("(min-width: 1024px)").matches');
    expect(chat).toContain("focus({ preventScroll: true })");
  });
});
