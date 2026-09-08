/**
 * List the channels the bot is a member of — the picker behind `/inspect/routing`.
 *
 * Uses `users.conversations`, NOT `conversations.list`. The latter enumerates every conversation in
 * the workspace and leaves you to filter on `is_member` client-side; on a workspace this size it
 * returns a couple of channels per page (the `limit` is an upper bound on a scan, not a page size)
 * and needs hundreds of round-trips to reach the handful we care about. `users.conversations`
 * returns only the authed token's own memberships — one small page, no scanning.
 *
 * Requires the `channels:read` (public) and `groups:read` (private) OAuth scopes, which the app did
 * NOT need before routing existed. Adding them means "Reinstall to workspace" in the Slack app
 * config; until that happens the call fails with `missing_scope`, which we surface as a typed error
 * so the page can say so instead of rendering an empty table.
 */
import type { Env } from "@/env";
import { slackApiGet } from "./post";

export interface SlackChannel {
  id: string;
  name: string;
  isPrivate: boolean;
}

export interface ChannelList {
  channels: SlackChannel[];
  /** Slack's error code when the listing failed (`missing_scope`, `no_slack_token`, …). */
  error?: string;
  /** Conversations Slack returned in total, before dropping any that were unusable (no id/name).
   * Keeps an empty picker diagnosable in place rather than costing a deploy cycle to investigate. */
  scanned: number;
  /** Cursor pages walked. */
  pages: number;
  /** True when the walk stopped at MAX_PAGES with a cursor still outstanding (workspace too big). */
  truncated: boolean;
}

/** `users.conversations` returns LIMITED conversation objects — notably no `is_member` (membership
 * is implied by the result set) and no `num_members`. Don't filter on fields it doesn't send. */
interface UserConversations {
  channels?: { id?: string; name?: string; is_private?: boolean }[];
  response_metadata?: { next_cursor?: string };
}

/** Slack recommends ≤200 per page. A bot in >2000 channels isn't a case worth paging further for. */
const PAGE_SIZE = "200";
const MAX_PAGES = 10;

export async function listBotChannels(env: Env): Promise<ChannelList> {
  if (!env.SLACK_BOT_TOKEN) return { channels: [], error: "no_slack_token", scanned: 0, pages: 0, truncated: false };

  const out: SlackChannel[] = [];
  let scanned = 0;
  let pages = 0;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    pages++;
    // GET with query params — these read methods ignore a JSON body and silently fall back to their
    // defaults (public channels, first 100, no cursor), which looks like success. See slackApiGet.
    const res = await slackApiGet<UserConversations>(env.SLACK_BOT_TOKEN, "users.conversations", {
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    if (!res.ok) return { channels: out, error: res.error ?? "unknown", scanned, pages, truncated: false };
    for (const c of res.data?.channels ?? []) {
      scanned++;
      // Every row here is already a channel the bot belongs to, so there is nothing to filter on
      // beyond the fields we need to render and post.
      if (!c.id || !c.name) continue;
      out.push({ id: c.id, name: c.name, isPrivate: !!c.is_private });
    }
    cursor = res.data?.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }

  out.sort((a, b) => a.name.localeCompare(b.name));
  return { channels: out, scanned, pages, truncated: !!cursor };
}
