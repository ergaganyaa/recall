"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

export type PickerChapter = { number: number; title: string };

export type PickerKeyAction = { type: "move"; index: number } | { type: "select"; index: number } | { type: "close" } | null;

/** Keyboard behaviour of the list, kept pure so it can be tested: arrows move, Enter picks, Escape closes. */
export function pickerKeyAction(key: string, active: number, count: number): PickerKeyAction {
  const clamp = (i: number) => Math.min(Math.max(i, 0), Math.max(count - 1, 0));
  switch (key) {
    case "Escape":
      return { type: "close" };
    case "ArrowDown":
      return { type: "move", index: clamp(active + 1) };
    case "ArrowUp":
      return { type: "move", index: clamp(active - 1) };
    case "Home":
      return { type: "move", index: 0 };
    case "End":
      return { type: "move", index: clamp(count - 1) };
    case "Enter":
      return count > 0 ? { type: "select", index: clamp(active) } : null;
    default:
      return null;
  }
}

/**
 * The chapter list itself. Presentational and theme-aware: every colour is a design token
 * (surface, foreground, muted, border, accent), so it follows the light/dark theme, unlike a
 * native <select> whose pop-up the browser paints with its own default (white) background.
 */
export function ChapterPickerPanel({
  chapters,
  current,
  onSelect,
  onClose,
  autoFocus = true,
}: {
  chapters: PickerChapter[];
  current: number;
  onSelect: (n: number) => void;
  onClose: () => void;
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () => (q ? chapters.filter((c) => `ch. ${c.number} ${c.number} ${c.title}`.toLowerCase().includes(q)) : chapters),
    [chapters, q],
  );
  const [active, setActive] = useState(() => Math.max(0, chapters.findIndex((c) => c.number === current)));
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();

  // Keep the highlighted row (initially the current chapter) in view.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active, visible]);

  function onKeyDown(e: React.KeyboardEvent) {
    const action = pickerKeyAction(e.key, active, visible.length);
    if (!action) return;
    e.preventDefault();
    if (action.type === "close") onClose();
    else if (action.type === "move") setActive(action.index);
    else {
      const c = visible[action.index];
      if (c) onSelect(c.number);
    }
  }

  return (
    <div
      role="dialog"
      aria-label="Jump to chapter"
      onKeyDown={onKeyDown}
      className="w-[min(32rem,calc(100vw-1.5rem))] overflow-hidden rounded-2xl border border-border bg-surface text-foreground shadow-xl"
    >
      <div className="border-b border-border p-2">
        <label htmlFor={`${listId}-q`} className="sr-only">
          Search chapters
        </label>
        <input
          id={`${listId}-q`}
          autoFocus={autoFocus}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          placeholder="Search chapters…"
          autoComplete="off"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-accent focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent"
        />
      </div>
      <ul ref={listRef} id={listId} role="listbox" aria-label="Chapters" className="max-h-[60vh] overflow-y-auto py-1">
        {visible.length === 0 && <li className="px-4 py-6 text-center text-sm text-muted">No chapters match “{query}”.</li>}
        {visible.map((c, i) => {
          const selected = c.number === current;
          const isActive = i === Math.min(active, Math.max(visible.length - 1, 0));
          return (
            <li key={c.number} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={selected}
                data-active={isActive}
                onMouseEnter={() => setActive(i)}
                onClick={() => onSelect(c.number)}
                className={`flex w-full items-baseline gap-3 px-4 py-2.5 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-accent ${
                  selected ? "bg-accent-soft font-semibold text-accent" : "text-foreground hover:bg-accent-soft"
                } ${isActive && !selected ? "bg-accent-soft/60" : ""}`}
              >
                <span className={`w-12 shrink-0 tabular-nums ${selected ? "text-accent" : "text-muted"}`}>Ch. {c.number}</span>
                <span className="min-w-0 flex-1 truncate">{c.title}</span>
                {selected && <span aria-hidden>✓</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Button that shows the current chapter and opens the list. */
export function ChapterPicker({
  chapters,
  current,
  onSelect,
  defaultOpen = false,
}: {
  chapters: PickerChapter[];
  current: number;
  onSelect: (n: number) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const trigger = useRef<HTMLButtonElement>(null);
  const label = chapters.find((c) => c.number === current);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  return (
    <div className="relative min-w-0">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full min-w-0 items-center gap-1 rounded-lg px-1 py-0.5 text-left text-sm font-medium text-foreground hover:bg-accent-soft focus-visible:outline-2 focus-visible:outline-accent"
      >
        <span className="truncate">
          {label ? `Ch. ${label.number} — ${label.title}` : "Jump to chapter"}
        </span>
        <svg viewBox="0 0 24 24" className={`size-4 shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <>
          {/* Click-away layer; the picker itself closes on Escape and after a choice. */}
          <button type="button" aria-label="Close chapter list" tabIndex={-1} onClick={close} className="fixed inset-0 z-30 cursor-default" />
          <div className="fixed inset-x-3 top-[3.75rem] z-40 flex justify-center sm:absolute sm:inset-x-auto sm:left-0 sm:top-full sm:mt-2 sm:block">
            <ChapterPickerPanel
              chapters={chapters}
              current={current}
              onClose={close}
              onSelect={(n) => {
                setOpen(false);
                onSelect(n);
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}
