import type { Env } from "@/env";
import type { SlackPostPayload } from "./format";

export interface SlackResult {
  ok: boolean;
  ts?: string;
  error?: string;
}

/** Post one message via chat.postMessage. unfurl_* are already false in the payload. */
export async function postToSlack(env: Env, payload: SlackPostPayload): Promise<SlackResult> {
  if (!env.SLACK_BOT_TOKEN) return { ok: false, error: "no_slack_token" };

  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });

  const data = (await res.json().catch(() => null)) as { ok?: boolean; ts?: string; error?: string } | null;
  if (!data) return { ok: false, error: `http_${res.status}` };
  return { ok: !!data.ok, ts: data.ts, error: data.error };
}

/** Update an existing message (used to append syndicated outlets to a posted story). */
export async function updateSlack(
  env: Env,
  payload: { channel: string; ts: string; text: string; blocks: unknown[] },
): Promise<SlackResult> {
  if (!env.SLACK_BOT_TOKEN) return { ok: false, error: "no_slack_token" };

  const res = await fetch("https://slack.com/api/chat.update", {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });

  const data = (await res.json().catch(() => null)) as { ok?: boolean; ts?: string; error?: string } | null;
  if (!data) return { ok: false, error: `http_${res.status}` };
  return { ok: !!data.ok, ts: data.ts, error: data.error };
}
