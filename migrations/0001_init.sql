-- Every inbound Meltwater webhook POST is logged here (raw + parsed + what we decided).
-- Powers the /inspect page and lets us learn the payload schema from real traffic.
CREATE TABLE IF NOT EXISTS webhook_events (
  id           TEXT PRIMARY KEY,       -- ULID-ish: received_at + random, sortable
  received_at  INTEGER NOT NULL,       -- epoch ms
  source       TEXT,                   -- best-effort source_name once parsed
  raw_json     TEXT NOT NULL,          -- exact body Meltwater sent
  parsed_json  TEXT,                   -- NormalizedMention[] as JSON (null until parser runs)
  decision     TEXT NOT NULL,          -- 'logged' | 'posted' | 'dropped' | 'error'
  reason       TEXT,                   -- e.g. filter drop reason, or error detail
  posted       INTEGER NOT NULL DEFAULT 0,
  slack_ts     TEXT,                   -- Slack message ts if posted
  error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_webhook_events_received_at ON webhook_events (received_at DESC);

-- Dedupe / idempotency: one row per mention we've already handled.
CREATE TABLE IF NOT EXISTS seen_mentions (
  id             TEXT PRIMARY KEY,     -- sha-256 of the canonical mention url
  url            TEXT NOT NULL,
  first_seen_at  INTEGER NOT NULL      -- epoch ms
);
CREATE INDEX IF NOT EXISTS idx_seen_mentions_first_seen_at ON seen_mentions (first_seen_at);
