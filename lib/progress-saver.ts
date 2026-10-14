/**
 * Debounced saving of the reading position, with a guaranteed flush.
 *
 * Scrolling updates the position many times a second; it is saved after a short pause. But the
 * last position must also be saved when the reader LEAVES (back to the book page, another chapter,
 * the tab being hidden, the component unmounting), otherwise up to a second of reading is lost.
 * `flush()` writes immediately and only if something changed, so calling it from every exit path is safe.
 */
export type ProgressSaver = {
  /** Record the latest position (0–1) and schedule a save. */
  update(pct: number): void;
  /** Save now if there is an unsaved position. Safe to call repeatedly. */
  flush(): void;
  /** Latest position seen, saved or not. */
  readonly latest: number;
  /** True while a position is waiting to be saved. */
  readonly pending: boolean;
};

export function createProgressSaver(opts: {
  save: (pct: number) => void;
  delayMs?: number;
  initial?: number;
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (id: unknown) => void };
}): ProgressSaver {
  const delay = opts.delayMs ?? 1200;
  const timers = opts.timers ?? {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  };
  let latest = opts.initial ?? 0;
  let dirty = false;
  let timer: unknown;

  const flush = () => {
    if (timer !== undefined) timers.clear(timer);
    timer = undefined;
    if (!dirty) return;
    dirty = false;
    opts.save(latest);
  };

  return {
    update(pct) {
      latest = Math.min(1, Math.max(0, pct));
      dirty = true;
      if (timer !== undefined) timers.clear(timer);
      timer = timers.set(flush, delay);
    },
    flush,
    get latest() {
      return latest;
    },
    get pending() {
      return dirty;
    },
  };
}
