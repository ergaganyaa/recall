"use client";

import { useCallback, useEffect, useRef } from "react";
import { pickAnchor, scrollBoundary, scrollDeltaToRestore, type BlockRect } from "@/lib/reading-tracker";

/** Height of the sticky reader header (h-14 + progress bar): blocks under it are not "on screen". */
export const HEADER_OFFSET = 58;
/** A paragraph must be this far above the top edge before it counts as read. */
export const SAFETY_MARGIN = 24;

function measure(): BlockRect[] {
  return [...document.querySelectorAll<HTMLElement>("[data-block]")].map((el) => {
    const r = el.getBoundingClientRect();
    return { index: Number(el.dataset.block), top: r.top, bottom: r.bottom };
  });
}

/**
 * DOM side of the reading boundary. The rule lives in lib/reading-tracker.ts (pure, tested): everything above
 * the top edge of the reading area is read, the first visible paragraph and everything after it is not.
 *
 * This hook measures the paragraphs (elements with data-block), reports the boundary whenever it changes
 * (after `release()` has been called once the saved scroll position is restored), and offers the layout-safety
 * tools: anchors (keep the reader on the same paragraph when the layout changes) and jumps.
 */
export function useScrollBoundary(opts: {
  enabled: boolean;
  /** the boundary the server currently holds */
  initialBoundary: number;
  /** called (debounced) when the boundary changes */
  onChange: (boundary: number) => void;
}) {
  const { enabled, initialBoundary, onChange } = opts;
  const released = useRef(false);
  const reported = useRef(initialBoundary);
  const enabledRef = useRef(enabled);
  const onChangeRef = useRef(onChange);
  const topBlock = useRef<number | null>(null);
  const anchor = useRef<{ index: number; offset: number } | null>(null);
  const userMovedSinceJump = useRef(true);
  const programmaticUntil = useRef(0);

  useEffect(() => {
    enabledRef.current = enabled;
    onChangeRef.current = onChange;
  });

  const current = useCallback(() => scrollBoundary(measure(), HEADER_OFFSET, SAFETY_MARGIN), []);

  useEffect(() => {
    let raf = 0;
    let timer = 0;
    const settle = () => {
      timer = 0;
      if (!enabledRef.current || !released.current) return;
      const b = current();
      if (b === reported.current) return;
      reported.current = b;
      onChangeRef.current(b);
    };
    const report = () => {
      raf = 0;
      topBlock.current = pickAnchor(measure(), HEADER_OFFSET)?.index ?? null;
      if (!timer) timer = window.setTimeout(settle, 250);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(report);
    };
    const onScroll = () => {
      if (performance.now() > programmaticUntil.current) userMovedSinceJump.current = true;
      schedule();
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", schedule);
    // Pictures finishing loading change the layout (and so what is above the edge).
    document.addEventListener("load", schedule, true);
    schedule();
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("load", schedule, true);
      if (raf) cancelAnimationFrame(raf);
      if (timer) window.clearTimeout(timer);
    };
  }, [current]);

  /** Call once the saved scroll position has been restored: from then on the boundary follows the scroll. */
  const release = useCallback(() => {
    released.current = true;
    window.dispatchEvent(new Event("resize")); // measure once more now
  }, []);

  /** The boundary right now, marked as reported (used just before a question is sent). */
  const reportNow = useCallback(() => {
    const b = current();
    reported.current = b;
    return b;
  }, [current]);

  /** The server confirmed a different value than we computed: remember it so we do not resend. */
  const setReported = useCallback((b: number) => {
    reported.current = b;
  }, []);

  const suspend = useCallback((ms: number) => {
    programmaticUntil.current = performance.now() + ms;
  }, []);

  /** Remember which paragraph is at the top of the screen, before a layout change. */
  const captureAnchor = useCallback(() => {
    anchor.current = pickAnchor(measure(), HEADER_OFFSET);
    suspend(1500);
  }, [suspend]);

  /** After the layout changed, scroll so that same paragraph is back where it was. */
  const restoreAnchor = useCallback(() => {
    const a = anchor.current;
    anchor.current = null;
    if (!a) return;
    const el = document.querySelector<HTMLElement>(`[data-block="${a.index}"]`);
    if (!el) return;
    const delta = scrollDeltaToRestore(a, el.getBoundingClientRect().top, HEADER_OFFSET);
    if (Math.abs(delta) > 0.5) window.scrollBy(0, delta);
  }, []);

  /** Scroll a paragraph to just under the header. */
  const scrollToBlock = useCallback(
    (index: number, smooth = false) => {
      const el = document.querySelector<HTMLElement>(`[data-block="${index}"]`);
      if (!el) return false;
      suspend(smooth ? 1800 : 1200);
      const y = el.getBoundingClientRect().top + window.scrollY - HEADER_OFFSET - 16;
      window.scrollTo({ top: Math.max(0, y), behavior: smooth ? "smooth" : "auto" });
      userMovedSinceJump.current = false;
      return true;
    },
    [suspend],
  );

  return {
    release,
    current,
    reportNow,
    setReported,
    suspend,
    captureAnchor,
    restoreAnchor,
    scrollToBlock,
    /** paragraph at the top of the screen, for the resume position */
    getTopBlock: () => topBlock.current,
    /** false right after a citation jump until the reader scrolls by themselves */
    hasUserMovedSinceJump: () => userMovedSinceJump.current,
  };
}
