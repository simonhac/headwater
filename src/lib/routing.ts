/**
 * Brief → Slack channel routing. Many-to-many: one brief fans out to N channels, and a channel can
 * carry many briefs.
 *
 * Routing lives in D1 (`ops_state` key `routing`), NOT in `feed.config.ts`, for two reasons: it's
 * edited from `/inspect/routing` without a redeploy, and channel ids are treated like
 * `SLACK_DEFAULT_CHANNEL` (a secret) so they never land in this public repo.
 *
 * A brief with no entry falls back to `SLACK_DEFAULT_CHANNEL`, so an empty `routing` reproduces the
 * pre-fanout behaviour exactly. A brief whose entry is present but empty is explicitly MUTED — see
 * `Routing.briefs`.
 */
import type { Env } from "@/env";
import { OpsState } from "@/lib/store/opsState";

export const ROUTING_KEY = "routing";

export interface Routing {
  v: 1;
  /**
   * briefId → channel ids. The unmatched/synthesized brief is routable under the id `default`.
   *
   * The absent-vs-empty distinction is load-bearing:
   *   - key ABSENT  ⇒ never configured ⇒ posts to `SLACK_DEFAULT_CHANNEL`.
   *   - key present, EMPTY array ⇒ explicitly muted ⇒ posts nowhere.
   * That's what lets a never-saved routing reproduce the pre-fanout behaviour while still letting
   * the admin page switch a brief off by unticking every box.
   */
  briefs: Record<string, string[]>;
  /** Epoch ms of the last save (0 when never saved). */
  updatedAt: number;
}

export function emptyRouting(): Routing {
  return { v: 1, briefs: {}, updatedAt: 0 };
}

/** Drop blanks and duplicates while preserving order. */
function clean(ids: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of ids) {
    const id = typeof raw === "string" ? raw.trim() : "";
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Read the saved routing. Never throws: a missing or corrupt value degrades to "route everything
 * to the default channel", which is the safe direction (we'd rather over-post to the known channel
 * than silently stop posting). */
export async function loadRouting(db: D1Database): Promise<Routing> {
  const raw = await new OpsState(db).get(ROUTING_KEY);
  if (!raw) return emptyRouting();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return emptyRouting();
    const o = parsed as { briefs?: unknown; updatedAt?: unknown };
    const briefs: Record<string, string[]> = {};
    if (o.briefs && typeof o.briefs === "object") {
      for (const [id, chans] of Object.entries(o.briefs as Record<string, unknown>)) {
        if (Array.isArray(chans)) briefs[id] = clean(chans as string[]);
      }
    }
    return { v: 1, briefs, updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : 0 };
  } catch {
    return emptyRouting();
  }
}

export async function saveRouting(db: D1Database, routing: Routing, now: number): Promise<void> {
  const next: Routing = { v: 1, briefs: routing.briefs, updatedAt: now };
  await new OpsState(db).set(ROUTING_KEY, JSON.stringify(next), now);
}

/**
 * The channels a brief posts to. An unconfigured brief falls back to the default channel; a brief
 * configured with an empty list is muted and returns no channels at all (the caller must record
 * that as a drop, not post it somewhere "safe" — silently reinstating the default would make the
 * admin page's unticked row a lie).
 */
export function channelsFor(briefId: string, routing: Routing, env: Env): string[] {
  const routed = routing.briefs[briefId];
  if (routed === undefined) return clean([env.SLACK_DEFAULT_CHANNEL ?? ""]);
  return clean(routed);
}

/** True when the brief has been explicitly configured to post nowhere. */
export function isMuted(briefId: string, routing: Routing): boolean {
  const routed = routing.briefs[briefId];
  return routed !== undefined && clean(routed).length === 0;
}

/** Every channel the Worker may have posted into — default first, then every routed channel.
 * Backs the orphan sweep and the replay purge, which must scan/clean each of them. */
export function configuredChannels(routing: Routing, env: Env): string[] {
  return clean([env.SLACK_DEFAULT_CHANNEL ?? "", ...Object.values(routing.briefs).flat()]);
}

/**
 * Build a Routing from a parsed `/inspect/routing` form body. Checkboxes are named `r.<briefId>`
 * with the channel id as the value, so Hono's `parseBody({ all: true })` yields a string for a
 * single tick and an array for several. Unknown brief ids and channel ids not in the live Slack
 * list are dropped, so a stale open tab can't write junk (or a channel the bot has since left).
 *
 * Every rendered brief gets an entry, INCLUDING an empty one — the form shows every brief, so a
 * row with no ticks is a deliberate "post nowhere", not an omission. (Contrast a brief absent from
 * the map entirely, which means "never configured" and still falls back to the default channel.)
 * `updatedAt` is stamped by `saveRouting`.
 */
export function parseRoutingForm(
  body: Record<string, unknown>,
  briefIds: readonly string[],
  allowedChannelIds: readonly string[],
): Routing {
  const briefs: Record<string, string[]> = {};
  for (const id of briefIds) {
    const raw = body[`r.${id}`];
    const values = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    const chans = clean(values.filter((v): v is string => typeof v === "string")).filter((c) =>
      allowedChannelIds.includes(c),
    );
    briefs[id] = chans;
  }
  return { v: 1, briefs, updatedAt: 0 };
}
