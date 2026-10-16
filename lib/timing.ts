import "server-only";

/**
 * Opt-in stage timing for diagnosing slowness: set RECALL_TIMING=1 and watch the `npm run dev` terminal.
 * Logs only a label and a duration. It never logs data, ids, tokens or text, and does nothing when the flag is off.
 */
const enabled = process.env.RECALL_TIMING === "1";

export async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (!enabled) return fn();
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    console.log(`[timing] ${label} ${(performance.now() - t0).toFixed(0)} ms`);
  }
}
