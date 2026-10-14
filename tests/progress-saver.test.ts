import { describe, expect, it, vi } from "vitest";
import { createProgressSaver } from "@/lib/progress-saver";

/** Controllable timers, so the debounce is tested without real waiting. */
function fakeTimers() {
  let next = 1;
  const pending = new Map<number, () => void>();
  return {
    timers: {
      set: (fn: () => void) => {
        pending.set(next, fn);
        return next++;
      },
      clear: (id: unknown) => void pending.delete(id as number),
    },
    pendingCount: () => pending.size,
    fireAll: () => {
      const fns = [...pending.values()];
      pending.clear();
      fns.forEach((f) => f());
    },
  };
}

describe("createProgressSaver", () => {
  it("saves once after a pause, using only the latest position (debounced)", () => {
    const t = fakeTimers();
    const save = vi.fn();
    const s = createProgressSaver({ save, timers: t.timers });
    s.update(0.1);
    s.update(0.2);
    s.update(0.35);
    expect(save).not.toHaveBeenCalled();
    expect(t.pendingCount()).toBe(1);
    t.fireAll();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(0.35);
  });

  it("flush() saves immediately when leaving (back to the book page) so the place is not lost", () => {
    const t = fakeTimers();
    const save = vi.fn();
    const s = createProgressSaver({ save, timers: t.timers });
    s.update(0.62);
    expect(s.pending).toBe(true);
    s.flush(); // what the back-to-book link, a chapter jump, tab-hide and unmount all call
    expect(save).toHaveBeenCalledExactlyOnceWith(0.62);
    expect(s.pending).toBe(false);
    expect(t.pendingCount()).toBe(0); // the timer was cancelled, no second save
  });

  it("flush() is safe to call from every exit path: nothing unsaved means no save", () => {
    const save = vi.fn();
    const s = createProgressSaver({ save, timers: fakeTimers().timers });
    s.flush();
    s.flush();
    expect(save).not.toHaveBeenCalled();
    s.update(0.4);
    s.flush();
    s.flush();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("clamps the position to 0–1 and remembers the latest value for bookmarks", () => {
    const save = vi.fn();
    const s = createProgressSaver({ save, timers: fakeTimers().timers, initial: 0.5 });
    expect(s.latest).toBe(0.5);
    s.update(7);
    expect(s.latest).toBe(1);
    s.update(-3);
    expect(s.latest).toBe(0);
    s.flush();
    expect(save).toHaveBeenCalledWith(0);
  });

  it("does not save the unchanged initial position just because it flushed", () => {
    const save = vi.fn();
    createProgressSaver({ save, timers: fakeTimers().timers, initial: 0.8 }).flush();
    expect(save).not.toHaveBeenCalled();
  });
});
