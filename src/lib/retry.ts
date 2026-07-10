/**
 * Await `fn`, retrying on rejection with the given backoff delays (ms). Makes `backoffMs.length + 1`
 * attempts total (one immediate, then one per delay), throwing the last error if all fail. Used to
 * harden the archive-first ingestion write — the one true single-point-of-loss (see src/index.ts).
 */
export async function withRetry<T>(fn: () => Promise<T>, backoffMs: number[]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= backoffMs.length) throw e;
      await new Promise<void>((resolve) => setTimeout(resolve, backoffMs[attempt]!));
    }
  }
}
