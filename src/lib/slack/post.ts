import type { Env } from "@/env";
import type { SlackPostPayload, SlackAttachment } from "./format";

export interface SlackResult {
  ok: boolean;
  ts?: string;
  error?: string;
}

/** How many times to honour a 429 before giving up (Slack's Retry-After is usually 1s for chat.*). */
const MAX_RATELIMIT_RETRIES = 8;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * POST to a Slack Web API method, honouring rate limits. On HTTP 429 Slack returns a
 * `Retry-After` header (seconds); we wait exactly that long and retry the same call rather than
 * pre-pacing — this keeps normal (low-volume) posting instant while letting a bursty replay
 * self-throttle to Slack's ~1 msg/sec/channel limit. See docs.slack.dev/apis/web-api/rate-limits.
 */
async function slackCall(token: string, method: string, payload: unknown): Promise<SlackResult> {
  for (let attempt = 0; attempt <= MAX_RATELIMIT_RETRIES; attempt++) {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    if (res.status === 429) {
      if (attempt >= MAX_RATELIMIT_RETRIES) return { ok: false, error: "ratelimited" };
      const retryAfter = Number(res.headers.get("retry-after")) || 1; // seconds; default 1 if absent
      await sleep(retryAfter * 1000);
      continue;
    }

    const data = (await res.json().catch(() => null)) as { ok?: boolean; ts?: string; error?: string } | null;
    if (!data) return { ok: false, error: `http_${res.status}` };
    // Belt-and-braces: some ratelimited responses surface as ok:false/error:"ratelimited".
    if (data.error === "ratelimited" && attempt < MAX_RATELIMIT_RETRIES) {
      const retryAfter = Number(res.headers.get("retry-after")) || 1;
      await sleep(retryAfter * 1000);
      continue;
    }
    return { ok: !!data.ok, ts: data.ts, error: data.error };
  }
  return { ok: false, error: "ratelimited" };
}

/** Post one message via chat.postMessage. unfurl_* are already false in the payload. */
export async function postToSlack(env: Env, payload: SlackPostPayload): Promise<SlackResult> {
  if (!env.SLACK_BOT_TOKEN) return { ok: false, error: "no_slack_token" };
  return slackCall(env.SLACK_BOT_TOKEN, "chat.postMessage", payload);
}

/** Delete a message (used by the admin replay to clear old cards before a clean backfill). */
export async function deleteSlack(env: Env, channel: string, ts: string): Promise<SlackResult> {
  if (!env.SLACK_BOT_TOKEN) return { ok: false, error: "no_slack_token" };
  return slackCall(env.SLACK_BOT_TOKEN, "chat.delete", { channel, ts });
}

/** Update an existing message (used to append syndicated outlets to a posted story). */
export async function updateSlack(
  env: Env,
  payload: { channel: string; ts: string; attachments: SlackAttachment[] },
): Promise<SlackResult> {
  if (!env.SLACK_BOT_TOKEN) return { ok: false, error: "no_slack_token" };
  return slackCall(env.SLACK_BOT_TOKEN, "chat.update", payload);
}
