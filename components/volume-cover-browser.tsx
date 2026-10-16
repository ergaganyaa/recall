"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { VolumeCard } from "@/lib/cover";
import { BookCover } from "./book-cover";

export type CoverCard = VolumeCard & { coverSrc: string | null };

const ACTION_LABEL: Record<VolumeCard["target"]["kind"], (chapter: number | null) => string> = {
  continue: (c) => `Continue reading · Ch. ${c}`,
  resume: (c) => `Continue this volume · Ch. ${c}`,
  start: () => "Start this volume",
  reread: () => "Read again",
  empty: () => "No chapters yet",
};

const num = (n: number) => (Number.isInteger(n) ? String(n) : String(+n.toFixed(2)));
const volumeLabel = (n: number) => `Vol. ${num(n)}`;

/**
 * The book page's cover. It shows the cover of the volume being read; click it and the covers open full screen,
 * where you swipe (or use the arrows / keys) through every volume.
 *
 * Looking at covers is only looking: nothing here writes anything, so it never marks a volume read or moves the
 * reading position. The button in the viewer is a plain link to a chapter; the reader applies its own progress and
 * spoiler rules when it opens.
 */
export function VolumeCoverBrowser({
  bookTitle,
  basePath,
  cards,
  initialIndex,
}: {
  bookTitle: string;
  basePath: string;
  cards: CoverCard[];
  initialIndex: number;
}) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const start = Math.min(Math.max(initialIndex, 0), Math.max(cards.length - 1, 0));
  const card = cards[start];
  if (!card) return null;

  return (
    <div className="mx-auto w-full max-w-[16rem] md:max-w-none" data-testid="volume-cover-browser">
      <button
        ref={opener}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label={`${bookTitle}, ${volumeLabel(card.number)}: open the volume covers`}
        data-testid="open-covers"
        className="group relative block w-full rounded-xl text-left focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent"
      >
        <BookCover key={card.id} title={`${bookTitle} ${volumeLabel(card.number)}`} coverUrl={card.coverSrc} className="w-full transition group-hover:shadow-xl" />
        {card.isCurrent && (
          <span data-testid="reading-now" className="absolute left-2 top-2 rounded-full bg-accent px-2.5 py-1 text-[0.7rem] font-semibold text-accent-foreground shadow">
            Reading now
          </span>
        )}
        {cards.length > 1 && (
          <span className="absolute bottom-2 right-2 rounded-full bg-foreground/80 px-2.5 py-1 text-[0.7rem] font-medium text-background shadow">
            {cards.length} volumes
          </span>
        )}
      </button>
      <p className="mt-2 text-center text-xs text-muted">
        {volumeLabel(card.number)}
        {card.title ? ` — ${card.title}` : ""}
        {cards.length > 1 && " · tap to browse covers"}
      </p>

      {open && (
        <VolumeCoverViewer
          bookTitle={bookTitle}
          basePath={basePath}
          cards={cards}
          initialIndex={start}
          onClose={() => {
            setOpen(false);
            opener.current?.focus();
          }}
        />
      )}
    </div>
  );
}

/** The full-screen viewer: swipe, arrows, number chips and the keyboard move between volumes. Esc or the backdrop closes it. */
export function VolumeCoverViewer({
  bookTitle,
  basePath,
  cards,
  initialIndex,
  onClose,
}: {
  bookTitle: string;
  basePath: string;
  cards: CoverCard[];
  initialIndex: number;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(Math.min(Math.max(initialIndex, 0), Math.max(cards.length - 1, 0)));
  const [drag, setDrag] = useState<number | null>(null); // finger offset in px while swiping
  const panel = useRef<HTMLDivElement>(null);
  const chips = useRef<HTMLDivElement>(null);
  const from = useRef<number | null>(null);
  const card = cards[index];
  const go = (to: number) => setIndex(Math.min(cards.length - 1, Math.max(0, to)));

  // Modal behaviour: focus inside, background does not scroll, Esc closes, Tab stays in the dialog.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.querySelector<HTMLElement>('[data-autofocus="true"]')?.focus();
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // Keep the selected number chip in view in a long list.
  useEffect(() => {
    chips.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [index]);

  if (!card) return null;
  const { target } = card;

  const circle =
    "grid size-11 shrink-0 place-items-center rounded-full border border-border bg-surface text-xl text-foreground transition hover:border-accent hover:text-accent disabled:opacity-40 disabled:hover:border-border disabled:hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent";

  // The previous and next covers sit beside the current one, so they slide in under your finger. Only these three
  // are ever rendered, however many volumes there are.
  const visible = [index - 1, index, index + 1].filter((i) => i >= 0 && i < cards.length);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${bookTitle}: volume covers`}
      data-testid="cover-viewer"
      className="fixed inset-0 z-50 flex flex-col bg-background/95 text-foreground backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
        else if (e.key === "ArrowLeft") go(index - 1);
        else if (e.key === "ArrowRight") go(index + 1);
        else if (e.key === "Tab") {
          const f = [...(panel.current?.querySelectorAll<HTMLElement>("a[href], button:not([disabled])") ?? [])];
          if (f.length === 0) return;
          const first = f[0];
          const last = f[f.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            last.focus();
            e.preventDefault();
          } else if (!e.shiftKey && document.activeElement === last) {
            first.focus();
            e.preventDefault();
          }
          return;
        } else return;
        e.preventDefault();
      }}
    >
      <div ref={panel} className="mx-auto flex h-full w-full max-w-md flex-col px-4 pb-4 pt-3">
        <div className="flex items-center justify-between">
          <p className="min-w-0 truncate text-sm text-muted">{bookTitle}</p>
          <button type="button" data-autofocus="true" onClick={onClose} aria-label="Close" data-testid="close-covers" className={circle}>
            ✕
          </button>
        </div>

        <div
          className="relative my-2 min-h-0 flex-1 touch-pan-y select-none overflow-hidden"
          onPointerDown={(e) => {
            from.current = e.clientX;
            setDrag(0);
          }}
          onPointerMove={(e) => {
            if (from.current !== null) setDrag(e.clientX - from.current);
          }}
          onPointerUp={(e) => {
            const start = from.current;
            from.current = null;
            setDrag(null);
            if (start === null) return;
            const dx = e.clientX - start;
            if (Math.abs(dx) > 56) go(index + (dx < 0 ? 1 : -1)); // a swipe; a plain tap does nothing
          }}
          onPointerCancel={() => {
            from.current = null;
            setDrag(null);
          }}
        >
          {visible.map((i) => (
            <div
              key={cards[i].id}
              aria-hidden={i !== index}
              className={`absolute inset-0 grid place-items-center ${drag === null ? "transition-transform duration-300 ease-out" : ""}`}
              style={{ transform: `translateX(calc(${(i - index) * 100}% + ${drag ?? 0}px))` }}
            >
              <BookCover
                title={`${bookTitle} ${volumeLabel(cards[i].number)}`}
                coverUrl={cards[i].coverSrc}
                className="w-[min(84vw,calc(62vh*2/3),24rem)]"
              />
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between gap-2" aria-live="polite">
          <button type="button" className={circle} onClick={() => go(index - 1)} disabled={index === 0} aria-label="Previous volume">
            ‹
          </button>
          <div className="min-w-0 text-center">
            <p className="truncate font-semibold" data-testid="volume-name">
              {volumeLabel(card.number)}
              {card.title ? ` — ${card.title}` : ""}
            </p>
            {card.arc && <p className="truncate text-xs text-muted">{card.arc}</p>}
            <p className="text-xs text-muted">
              {index + 1} of {cards.length}
              {card.isCurrent && (
                <span data-testid="viewer-reading-now" className="ml-2 rounded-full bg-accent px-2 py-0.5 text-[0.65rem] font-semibold text-accent-foreground">
                  Reading now
                </span>
              )}
            </p>
          </div>
          <button type="button" className={circle} onClick={() => go(index + 1)} disabled={index === cards.length - 1} aria-label="Next volume">
            ›
          </button>
        </div>

        <p className="mt-2 text-center text-xs text-muted">
          {card.chapterCount ? `${card.finishedCount} of ${card.chapterCount} chapters finished` : "No chapters in this volume yet"}
        </p>

        {target.chapter !== null ? (
          <Link
            href={`${basePath}/read/${target.chapter}`}
            data-testid="volume-action"
            className="mt-3 block rounded-full bg-accent px-4 py-2.5 text-center text-sm font-medium text-accent-foreground hover:opacity-90 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent"
          >
            {ACTION_LABEL[target.kind](target.chapter)}
          </Link>
        ) : (
          <p data-testid="volume-action" className="mt-3 rounded-full border border-dashed border-border px-4 py-2.5 text-center text-sm text-muted">
            {ACTION_LABEL.empty(null)}
          </p>
        )}
        <p className="mt-2 text-center text-[0.7rem] text-muted">Browsing covers doesn&apos;t change your reading progress.</p>

        {cards.length > 1 && (
          <div ref={chips} role="tablist" aria-label="Choose a volume" className="mt-3 flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:thin]">
            {cards.map((c, i) => (
              <button
                key={c.id}
                type="button"
                role="tab"
                aria-selected={i === index}
                aria-label={`${volumeLabel(c.number)}${c.isCurrent ? " (reading now)" : ""}`}
                onClick={() => go(i)}
                className={`relative grid h-9 min-w-9 shrink-0 place-items-center rounded-full border px-2 text-xs font-medium transition focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent ${
                  i === index ? "border-accent bg-accent-soft text-accent" : "border-border text-muted hover:text-foreground"
                }`}
              >
                {num(c.number)}
                {c.isCurrent && <span aria-hidden className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-accent" />}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
