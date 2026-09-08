/**
 * List the channels the bot is a member of — the picker behind `/inspect/routing`.
 *
 * Requires the `channels:read` (public) and `groups:read` (private) OAuth scopes, which the app did
 * NOT need before routing existed. Adding them means "Reinstall to workspace" in the Slack app
 * config; until that happens `conversations.list` fails with `missing_scope`, which we surface as a
 * typed error so the page can say so instead of rendering an empty table.
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
  /** Conversations Slack returned in total, BEFORE the `is_member` filter. Distinguishes "Slack
   * returned nothing" from "returned plenty, the bot is in none of them" — the two look identical
   * on the page otherwise, and they have completely different causes. */
  scanned: number;
  /** Cursor pages walked. */
  pages: number;
  /** True when the walk stopped at MAX_PAGES with a cursor still outstanding (workspace too big). */
  truncated: boolean;
}

interface ConversationsList {
  channels?: { id?: string; name?: string; is_private?: boolean; is_member?: boolean; is_archived?: boolean }[];
  response_metadata?: { next_cursor?: string };
}

/** Slack recommends ≤200 results per conversations.list page; 20 pages covers 4000 channels. */
const PAGE_SIZE = "200";
const MAX_PAGES = 20;

export async function listBotChannels(env: Env): Promise<ChannelList> {
  if (!env.SLACK_BOT_TOKEN) return { channels: [], error: "no_slack_token", scanned: 0, pages: 0, truncated: false };

  const out: SlackChannel[] = [];
  let scanned = 0;
  let pages = 0;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    pages++;
    // GET with query params — conversations.list ignores a JSON body and silently falls back to
    // its defaults (public channels, first 100, no cursor). See slackApiGet.
    const res = await slackApiGet<ConversationsList>(env.SLACK_BOT_TOKEN, "conversations.list", {
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    if (!res.ok) return { channels: out, error: res.error ?? "unknown", scanned, pages, truncated: false };
    for (const c of res.data?.channels ?? []) {
      scanned++;
      // `is_member` is the whole point: the bot can only post where it's been invited, so offering
      // any other channel in the picker would just produce `not_in_channel` at post time.
      if (!c.is_member || !c.id || !c.name) continue;
      out.push({ id: c.id, name: c.name, isPrivate: !!c.is_private });
    }
    cursor = res.data?.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }

  out.sort((a, b) => a.name.localeCompare(b.name));
  return { channels: out, scanned, pages, truncated: !!cursor };
}
