-- Daily digest subscribers, managed from Slack via the `/digest` slash command (src/lib/slack/commands.ts).
-- Replaces the fixed DIGEST_TO env list: each row is one Slack user, the email from their Slack profile,
-- and the local time they want the digest (their Slack profile time zone + minutes after midnight, in
-- 15-minute steps). `last_sent_day` is the per-subscriber send-once marker (YYYY-MM-DD in `time_zone`),
-- written only after the mail API accepts the message (src/lib/digestSend.ts).
CREATE TABLE IF NOT EXISTS digest_subscribers (
  slack_user_id TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  time_zone     TEXT NOT NULL,                -- IANA zone from the Slack profile at (re)subscribe time
  send_minute   INTEGER NOT NULL DEFAULT 480, -- minutes after local midnight; multiple of 15 (480 = 08:00)
  last_sent_day TEXT,                         -- YYYY-MM-DD in time_zone; NULL = never sent
  created_at    INTEGER NOT NULL,             -- epoch ms
  updated_at    INTEGER NOT NULL              -- epoch ms
);
