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
 * allow-list, so they read as orphans; delete them from Slack yourself, or leave them and pass
 * `dryRun` next time. See the caller in `src/index.ts` (`POST /admin/test-post`).
 */
import type { Env } from "@/env";
import type { BriefRule } from "@/config/feed.config";
import { feedConfig } from "@/config/feed.config";
import type { NormalizedMention } from "@/lib/meltwater/types";
import { channelsFor, loadRouting, type Routing } from "@/lib/routing";
import { buildPostPayload } from "@/lib/slack/format";
import { postToSlack } from "@/lib/slack/post";

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

/** The synthesized brief `resolveBrief` returns for unmatched mentions; routable as `default`. */
const UNMATCHED: BriefRule = { id: "default", label: feedConfig.defaultBriefLabel, keywords: [] };

/** A card that is obviously not journalism, so nobody mistakes it for a real mention. */
function testMention(brief: BriefRule, tag: string, now: number): NormalizedMention {
  return {
    url: null, // no link: a fake URL would render a broken favicon and invite a click
    outletUrl: null,
    title: `🧪 Headwater routing test — ${brief.label} — ${tag}`,
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
