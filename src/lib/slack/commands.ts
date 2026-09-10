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
 *   /digest who [plain]        the whole roster as a Block Kit table — deliberately absent from
 *                              USAGE below: not secret, just not worth advertising
 *
 * The email address comes from the Slack profile only (`users.info` → `profile.email`, scope
 * `users:read.email`), so nobody can point the digest at an address they don't own. The zone comes
 * from the same call (`user.tz`, scope `users:read`). Replies are ephemeral mrkdwn strings.
 */

const FALLBACK_TZ = "Australia/Melbourne";
const EMAIL_ISH = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;

export const USAGE = "Usage: `/digest subscribe [time]` · `/digest unsubscribe` · `/digest status`";

const MINUTES_PER_DAY = 24 * 60;

/** What a subcommand answers with: mrkdwn `text`, plus optional blocks that supersede it. */
export interface CommandReply {
  text: string;
  blocks?: Block[];
}

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

/* ── `/digest who`: the roster, as a Block Kit table ──────────────────────────────────────────
 *
 * Two things shape this rendering:
 *  - **No Slack API call.** The route has a 3s budget (see src/index.ts), so names come from
 *    `rich_text` → `user` cells, which each client resolves to a mention when it draws the table.
 *  - **Masked addresses.** `/admin/digest-subscribers` stays the one place full addresses surface.
 *
 * Every reply also carries plain `text`: Slack uses it for notifications and for clients that can't
 * render the block, so a table that fails to draw degrades to a readable list. `who plain` asks for
 * that rendering on its own.
 */

const MASK = "•••";
const WHO_HEADERS = ["Who", "Time", "Zone", "Email"];
const PAUSED_ROSTER_NOTE =
  "Digest sending is currently paused server-side — these subscriptions are saved, but nothing is going out.";

/** `simon@holmesacourt.com` → `s•••@holmesacourt.com`. Enough to recognise, not enough to mail. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return MASK;
  const local = email.slice(0, at);
  const domain = email.slice(at);
  return local.length < 2 ? `${MASK}${domain}` : `${local[0]}${MASK}${domain}`;
}

/** `Australia/Melbourne` → `Melbourne`; `America/New_York` → `New York`. */
export function shortZone(tz: string): string {
  const last = tz.split("/").pop();
  return last ? last.replace(/_/g, " ") : tz;
}

/** Roster order: earliest local send time first, then oldest subscription. */
export function sortSubscribers(subs: Subscriber[]): Subscriber[] {
  return [...subs].sort((a, b) => a.send_minute - b.send_minute || a.created_at - b.created_at);
}

/** Minimal shapes for the blocks we emit — hand-rolled, as with SlackAttachment in ./format.ts. */
export type TableCell =
  | { type: "raw_text"; text: string }
  | { type: "rich_text"; elements: [{ type: "rich_text_section"; elements: [{ type: "user"; user_id: string }] }] };

export type Block =
  | { type: "table"; column_settings?: { align?: "left" | "center" | "right"; is_wrapped?: boolean }[]; rows: TableCell[][] }
  | { type: "section"; text: { type: "mrkdwn"; text: string } }
  | { type: "context"; elements: { type: "mrkdwn"; text: string }[] };

function whoRow(sub: Subscriber): TableCell[] {
  return [
    { type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "user", user_id: sub.slack_user_id }] }] },
    { type: "raw_text", text: formatLocalTime(sub.send_minute) },
    { type: "raw_text", text: shortZone(sub.time_zone) },
    { type: "raw_text", text: maskEmail(sub.email) },
  ];
}

function whoLine(sub: Subscriber): string {
  return `• <@${sub.slack_user_id}> — *${formatLocalTime(sub.send_minute)}* · ${shortZone(sub.time_zone)} · ${maskEmail(sub.email)}`;
}

/** The `/digest who` reply. `plain` skips the table and returns the fallback text on its own. */
export function buildWhoReply(subs: Subscriber[], opts: { paused: boolean; plain?: boolean }): CommandReply {
  const pausedLine = opts.paused ? `_(${PAUSED_ROSTER_NOTE})_` : "";
  if (subs.length === 0) {
    return { text: ["Nobody is subscribed to the daily digest yet.", pausedLine].filter(Boolean).join("\n") };
  }

  const ordered = sortSubscribers(subs);
  const heading = `*${ordered.length} subscriber${ordered.length === 1 ? "" : "s"}* to the daily digest`;
  const text = [heading, ...ordered.map(whoLine), pausedLine].filter(Boolean).join("\n");
  if (opts.plain) return { text };

  const blocks: Block[] = [
    { type: "section", text: { type: "mrkdwn", text: heading } },
    {
      type: "table",
      column_settings: [{}, { align: "right" }, {}, {}],
      rows: [WHO_HEADERS.map((h): TableCell => ({ type: "raw_text", text: h })), ...ordered.map(whoRow)],
    },
  ];
  if (opts.paused) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: PAUSED_ROSTER_NOTE }] });
  return { text, blocks };
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
): Promise<CommandReply> {
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
      case "who":
      case "list": {
        const plain = /^(plain|text)$/i.test(rest[0] ?? "");
        return buildWhoReply(await store.all(), { paused: env.DIGEST_ENABLED !== "true", plain });
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
