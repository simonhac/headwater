import type { Env } from "@/env";
import { slackApiGet } from "@/lib/slack/post";
import { SubscriberStore, type Subscriber } from "@/lib/store/subscribers";
import { DEFAULT_SEND_MINUTE, SLOT_MINUTES, zonedDay, zonedMinuteOfDay } from "@/lib/digestSend";

/**
 * The `/digest` slash command: subscribe / unsubscribe / status for the daily digest email.
 *
 *   /digest subscribe [time]   subscribe (or change the time) — time in the user's Slack profile zone
 *   /digest unsubscribe
 *   /digest status             (also the default for bare `/digest` or anything unrecognised)
 *
 * The email address comes from the Slack profile only (`users.info` → `profile.email`, scope
 * `users:read.email`), so nobody can point the digest at an address they don't own. The zone comes
 * from the same call (`user.tz`, scope `users:read`). Replies are ephemeral mrkdwn strings.
 */

const FALLBACK_TZ = "Australia/Melbourne";
const EMAIL_ISH = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;

export const USAGE = "Usage: `/digest subscribe [time]` · `/digest unsubscribe` · `/digest status`";

const MINUTES_PER_DAY = 24 * 60;

/**
 * Parse a local time such as `7`, `7:30`, `7.30`, `7am`, `7:30pm`, `19:15` into minutes after
 * midnight, rounded to the nearest 15 (`rounded` says whether that changed it). Null if unparseable.
 */
export function parseLocalTime(raw: string): { minute: number; rounded: boolean } | null {
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/i.exec(raw.trim());
  if (!m) return null;
  let hour = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ampm = m[3]?.toLowerCase();
  if (min > 59) return null;
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    if (hour === 12) hour = 0;
    if (ampm === "pm") hour += 12;
  } else if (hour > 23) {
    return null;
  }
  const exact = hour * 60 + min;
  const minute = (Math.round(exact / SLOT_MINUTES) * SLOT_MINUTES) % MINUTES_PER_DAY;
  return { minute, rounded: minute !== exact };
}

/** `450` → `7:30am`; `0` → `12:00am`; `780` → `1:00pm`. */
export function formatLocalTime(minute: number): string {
  const h24 = Math.floor(minute / 60) % 24;
  const m = minute % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, "0")}${h24 < 12 ? "am" : "pm"}`;
}

/** When the next digest will go out, in words, for the status / subscribe replies. */
export function nextSendLabel(sub: Pick<Subscriber, "time_zone" | "send_minute" | "last_sent_day">, nowMs: number): string {
  const today = zonedDay(nowMs, sub.time_zone);
  const minute = zonedMinuteOfDay(nowMs, sub.time_zone);
  const at = formatLocalTime(sub.send_minute);
  if (sub.last_sent_day === today) return `tomorrow at ${at}`;
  if (minute >= sub.send_minute) return `within the next ${SLOT_MINUTES} minutes`;
  return `today at ${at}`;
}

interface SlackUser {
  tz?: string;
  profile?: { email?: string };
}

async function lookupUser(env: Env, userId: string): Promise<{ email: string; tz: string; tzNote?: string } | { error: string }> {
  if (!env.SLACK_BOT_TOKEN) return { error: "The bot has no Slack token configured." };
  const r = await slackApiGet<{ user?: SlackUser }>(env.SLACK_BOT_TOKEN, "users.info", { user: userId });
  if (!r.ok) {
    return {
      error:
        r.error === "missing_scope"
          ? "I can't read your profile — the Slack app needs the `users:read` and `users:read.email` scopes (and a reinstall)."
          : `Slack wouldn't tell me who you are (\`${r.error ?? "unknown"}\`).`,
    };
  }
  const email = r.data?.user?.profile?.email;
  if (!email || !EMAIL_ISH.test(email)) {
    return {
      error:
        "I can't see an email address on your Slack profile — the app needs the `users:read.email` scope (and a reinstall).",
    };
  }
  const tz = r.data?.user?.tz;
  if (!tz) return { email, tz: FALLBACK_TZ, tzNote: `Your Slack profile has no time zone, so I've assumed ${FALLBACK_TZ}.` };
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
  } catch {
    return { email, tz: FALLBACK_TZ, tzNote: `I don't recognise your Slack time zone "${tz}", so I've assumed ${FALLBACK_TZ}.` };
  }
  return { email, tz };
}

function pausedNote(env: Env): string {
  return env.DIGEST_ENABLED === "true" ? "" : "\n_(Digest sending is currently paused server-side; your subscription is saved.)_";
}

function statusText(sub: Subscriber | null, env: Env, nowMs: number): string {
  if (!sub) return `You're not subscribed to the daily digest.\n${USAGE}`;
  const last = sub.last_sent_day ? ` Last sent: ${sub.last_sent_day}.` : " Nothing sent yet.";
  return (
    `You're subscribed as *${sub.email}*, daily at *${formatLocalTime(sub.send_minute)}* (${sub.time_zone}).` +
    `${last} Next: ${nextSendLabel(sub, nowMs)}.` +
    pausedNote(env) +
    `\n${USAGE}`
  );
}

/** Handle one `/digest …` invocation. Returns the ephemeral reply text. Never throws. */
export async function handleDigestCommand(
  env: Env,
  p: { userId: string; text: string; nowMs: number },
): Promise<{ text: string }> {
  const { userId, nowMs } = p;
  const [verb = "", ...rest] = p.text.trim().split(/\s+/).filter(Boolean);
  const store = new SubscriberStore(env.DB);

  try {
    switch (verb.toLowerCase()) {
      case "subscribe":
      case "sub":
      case "time": {
        const arg = rest.join("");
        let minute = DEFAULT_SEND_MINUTE;
        let rounded = false;
        if (arg) {
          const parsed = parseLocalTime(arg);
          if (!parsed) return { text: `I couldn't read "${arg}" as a time. Try \`7:30\`, \`7am\` or \`19:15\`.\n${USAGE}` };
          minute = parsed.minute;
          rounded = parsed.rounded;
        }
        const who = await lookupUser(env, userId);
        if ("error" in who) return { text: who.error };

        // If today's chosen time has already passed, mark today done so the catch-up rule in
        // decideSubscriberSend doesn't fire a digest the moment someone subscribes.
        const today = zonedDay(nowMs, who.tz);
        const passed = zonedMinuteOfDay(nowMs, who.tz) >= minute;
        const existing = await store.get(userId);
        const sub = {
          slack_user_id: userId,
          email: who.email,
          time_zone: who.tz,
          send_minute: minute,
          last_sent_day: passed ? today : null,
        };
        await store.upsert(sub, nowMs);

        const notes = [
          rounded ? `(rounded to the nearest ${SLOT_MINUTES} minutes)` : "",
          who.tzNote ?? "",
        ].filter(Boolean);
        return {
          text:
            `${existing ? "Updated" : "Subscribed"}: the daily digest goes to *${who.email}* at *${formatLocalTime(minute)}* ` +
            `(${who.tz})${notes.length ? " " + notes.join(" ") : ""}. First one: ${nextSendLabel(sub, nowMs)}.` +
            pausedNote(env),
        };
      }
      case "unsubscribe":
      case "unsub":
      case "stop": {
        const removed = await store.remove(userId);
        return { text: removed ? "Unsubscribed — you won't receive the daily digest any more." : "You weren't subscribed." };
      }
      default:
        return { text: statusText(await store.get(userId), env, nowMs) };
    }
  } catch (e) {
    console.error(`[digest-cmd] user=${userId} verb=${verb} failed: ${String(e)}`);
    return { text: "Sorry — something went wrong on my side. Please try again in a moment." };
  }
}
