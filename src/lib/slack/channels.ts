/**
 * List the channels the bot is a member of — the picker behind `/inspect/routing`.
 *
 * Requires the `channels:read` (public) and `groups:read` (private) OAuth scopes, which the app did
 * NOT need before routing existed. Adding them means "Reinstall to workspace" in the Slack app
 * config; until that happens `conversations.list` fails with `missing_scope`, which we surface as a
 * typed error so the page can say so instead of rendering an empty table.
 */
import type { Env } from "@/env";
import { slackApi } from "./post";

export interface SlackChannel {
  id: string;
  name: string;
  isPrivate: boolean;
}

export interface ChannelList {
  channels: SlackChannel[];
  /** Slack's error code when the listing failed (`missing_scope`, `no_slack_token`, …). */
  error?: string;
}

interface ConversationsList {
  channels?: { id?: string; name?: string; is_private?: boolean; is_member?: boolean; is_archived?: boolean }[];
  response_metadata?: { next_cursor?: string };
}

/** Cap the cursor walk: 10 × 1000 is far more channels than any workspace the bot joins. */
const MAX_PAGES = 10;

export async function listBotChannels(env: Env): Promise<ChannelList> {
  if (!env.SLACK_BOT_TOKEN) return { channels: [], error: "no_slack_token" };

  const out: SlackChannel[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await slackApi<ConversationsList>(env.SLACK_BOT_TOKEN, "conversations.list", {
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    if (!res.ok) return { channels: out, error: res.error ?? "unknown" };
    for (const c of res.data?.channels ?? []) {
      // `is_member` is the whole point: the bot can only post where it's been invited, so offering
      // any other channel in the picker would just produce `not_in_channel` at post time.
      if (!c.is_member || !c.id || !c.name) continue;
      out.push({ id: c.id, name: c.name, isPrivate: !!c.is_private });
    }
    cursor = res.data?.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }

  out.sort((a, b) => a.name.localeCompare(b.name));
  return { channels: out };
}
