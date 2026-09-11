/**
 * Best-effort dead-man's-switch ping.
 *
 * Best-effort by design: a failed ping must never fail the tick, because the tick's real work has
 * already happened. A missed ping costs one interval of grace; a thrown exception would cost the
 * reconcile or the digest send.
 *
 * Bounded at 5s — a Worker cron tick has a limited budget and this is the last thing it does.
 *
 * ⚠ Callers must AWAIT this inside `ctx.waitUntil`. A Worker may be torn down the moment its
 * handler returns, which cancels an un-awaited fetch — the heartbeat then reads dead while the
 * Worker is perfectly healthy. (The Vercel equivalent bit liveone's collector heartbeat.)
 */
export async function pingHeartbeatUrl(url: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) console.warn(`[heartbeat] ping returned ${res.status}`);
  } catch (e) {
    console.warn(`[heartbeat] ping failed: ${String(e)}`);
  } finally {
    clearTimeout(timer);
  }
}
