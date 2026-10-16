/**
 * Runs `fn` over `items` with at most `limit` calls in flight, and returns the results in the ORIGINAL order.
 * After the first failure no new item is started; calls already running are allowed to finish and every
 * outcome is returned, so callers can clean up whatever succeeded.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R | undefined>[]> {
  const results: PromiseSettledResult<R | undefined>[] = items.map(() => ({ status: "fulfilled", value: undefined }));
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i], i) };
      } catch (reason) {
        failed = true;
        results[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}
