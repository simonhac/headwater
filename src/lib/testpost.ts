/**
 * Post a synthetic card per brief, to wherever `/inspect/routing` says that brief goes.
 *
 * This exists because routing is only observable through traffic: a brief whose Meltwater search is
 * quiet (or not yet bound to the webhook) can't be verified at all, and the ones that are busy make
 * you wait for a delivery. It answers "did I tick the right boxes?" in one call.
 *
 * Deliberately does NOT touch `stories` or `seen_mentions`. A test card must not become a story row
 * — a later real article sharing its title would fold into the test card, and a seen row would make
 * a repeat test silently no-op. The cost is that test cards are invisible to the orphan sweep's
 * allow-list, so they read as orphans — clean them up with `cleanupTestPosts` (`?cleanup=1`), NOT
 * with `/admin/orphans`, which would delete real cards alongside them. See the caller in
 * `src/index.ts` (`POST /admin/test-post`).
 */
import type { Env } from "@/env";
import type { BriefRule } from "@/config/feed.config";
import { feedConfig } from "@/config/feed.config";
import type { NormalizedMention } from "@/lib/meltwater/types";
import { channelsFor, configuredChannels, loadRouting, type Routing } from "@/lib/routing";
import { buildPostPayload } from "@/lib/slack/format";
import { deleteSlack, postToSlack } from "@/lib/slack/post";

export interface TestPostTarget {
  brief: string;
  label: string;
  /** Channels this brief routes to. Empty when the brief is muted. */
  channels: string[];
  muted: boolean;
  /** `{channel, ts}` per successful post; empty on a dry run. */
  posted: { channel: string; ts: string }[];
  /** `{channel, error}` per Slack failure. */
  failed: { channel: string; error: string }[];
}

export interface TestPostResult {
  dryRun: boolean;
  /** Marker in every card's title, so the batch is findable and deletable in Slack. */
  tag: string;
  targets: TestPostTarget[];
}

/**
 * Marker every test card's title carries; cleanup deletes ONLY messages containing it, so the sweep
 * can never touch a real card the way a blanket delete-by-timestamp tool could.
 *
 * Deliberately emoji-free: `conversations.history` returns titles with emoji normalised back to
 * shortcodes (the 🧪 we post reads as `:test_tube:` on the way out), so a marker containing the
 * character would match on post and never on read.
 */
export const TEST_MARKER = "Headwater routing test";

/** The synthesized brief `resolveBrief` returns for unmatched mentions; routable as `default`. */
const UNMATCHED: BriefRule = { id: "default", label: feedConfig.defaultBriefLabel, keywords: [] };

/** A card that is obviously not journalism, so nobody mistakes it for a real mention. */
function testMention(brief: BriefRule, tag: string, now: number): NormalizedMention {
  return {
    url: null, // no link: a fake URL would render a broken favicon and invite a click
    outletUrl: null,
    title: `🧪 ${TEST_MARKER} — ${brief.label} — ${tag}`,
    sourceName: "Headwater",
    mediaType: "online_news",
    countryCode: "AU",
    reach: null,
    sentiment: null,
    publishedAt: new Date(now).toISOString(),
    snippet:
      `Test card for the "${brief.label}" brief. If you can see this, that brief is routed to this ` +
      `channel. Safe to delete — it is not stored, so it will never merge with a real story.`,
    author: null,
    briefName: brief.label,
    imageUrl: null,
    matchedKeywords: [],
    raw: { test: true, tag },
  };
}

/**
 * Fan a test card out exactly as a real mention of that brief would go. `briefId` limits it to one
 * brief; omit for all of them (config briefs plus the synthesized `default`).
 */
export async function sendTestPosts(
  env: Env,
  opts: { dryRun: boolean; briefId?: string; now?: number; routing?: Routing },
): Promise<TestPostResult> {
  const now = opts.now ?? Date.now();
  const routing = opts.routing ?? (await loadRouting(env.DB));
  const tag = new Date(now).toISOString().replace(/\.\d+Z$/, "Z");

  const all = [...feedConfig.briefs, UNMATCHED];
  const briefs = opts.briefId ? all.filter((b) => b.id === opts.briefId) : all;

  const targets: TestPostTarget[] = [];
  for (const brief of briefs) {
    const channels = channelsFor(brief.id, routing, env);
    const target: TestPostTarget = {
      brief: brief.id,
      label: brief.label,
      channels,
      muted: channels.length === 0,
      posted: [],
      failed: [],
    };
    if (!opts.dryRun) {
      for (const channel of channels) {
        const r = await postToSlack(env, buildPostPayload(testMention(brief, tag, now), brief, channel, now));
        if (r.ok && r.ts) target.posted.push({ channel, ts: r.ts });
        else target.failed.push({ channel, error: r.error ?? "unknown" });
      }
    }
    targets.push(target);
  }

  return { dryRun: opts.dryRun, tag, targets };
}

export interface TestCleanupResult {
  dryRun: boolean;
  /** Restricted to this tag when given; otherwise every test card found. */
  tag?: string;
  channels: string[];
  scanned: number;
  matched: number;
  deleted: number;
  failed: number;
  note?: string;
  samples: { channel: string; ts: string; title: string }[];
}

interface HistoryMessage {
  ts?: string;
  bot_id?: string;
  app_id?: string;
  subtype?: string;
  attachments?: { title?: string }[];
}

/**
 * Delete the cards `sendTestPosts` created. Matches on the title marker rather than on timestamps,
 * so it can only ever remove test cards — unlike `sweepOrphans`, which deletes every card without a
 * backing story row and would take real ones with it (test cards are orphans by design, since they
 * deliberately write no story row).
 *
 * `tag` narrows it to a single run; omit to clear every test card in the configured channels.
 */
export async function cleanupTestPosts(
  env: Env,
  opts: { dryRun: boolean; tag?: string },
): Promise<TestCleanupResult> {
  const routing = await loadRouting(env.DB);
  const channels = configuredChannels(routing, env);
  const res: TestCleanupResult = {
    dryRun: opts.dryRun,
    tag: opts.tag,
    channels,
    scanned: 0,
    matched: 0,
    deleted: 0,
    failed: 0,
    samples: [],
  };
  if (!env.SLACK_BOT_TOKEN || !channels.length) {
    res.note = "no_token_or_channel";
    return res;
  }

  for (const channel of channels) {
    let cursor: string | undefined;
    // Test cards are recent by nature; 5 pages of 200 is plenty and bounds the subrequest count.
    for (let page = 0; page < 5; page++) {
      const params = new URLSearchParams({ channel, limit: "200" });
      if (cursor) params.set("cursor", cursor);
      const r = await fetch("https://slack.com/api/conversations.history?" + params.toString(), {
        headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
      });
      const data = (await r.json().catch(() => null)) as
        | { ok?: boolean; error?: string; messages?: HistoryMessage[]; response_metadata?: { next_cursor?: string } }
        | null;
      if (!data?.ok) {
        res.note ??= `history:${data?.error ?? "unknown"}`;
        break;
      }
      for (const m of data.messages ?? []) {
        const isBotCard = !!(m.bot_id || m.app_id || m.subtype === "bot_message") && (m.attachments?.length ?? 0) > 0;
        if (!isBotCard || !m.ts) continue;
        res.scanned++;
        const title = m.attachments?.[0]?.title ?? "";
        if (!title.includes(TEST_MARKER)) continue;
        if (opts.tag && !title.includes(opts.tag)) continue;
        res.matched++;
        if (res.samples.length < 50) res.samples.push({ channel, ts: m.ts, title });
        if (opts.dryRun) continue;
        const del = await deleteSlack(env, channel, m.ts);
        if (del.ok || del.error === "message_not_found") res.deleted++;
        else res.failed++;
      }
      cursor = data.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
  }
  return res;
}
