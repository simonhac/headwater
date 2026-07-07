-- Syndication tracking: one row per distinct story (keyed by normalized title).
-- Lets us collapse the same wire story across many outlets into a single Slack
-- message, then chat.update it to list every outlet that carried it.
CREATE TABLE IF NOT EXISTS stories (
  story_key            TEXT PRIMARY KEY,   -- sha-256 of the normalized title
  slack_ts             TEXT NOT NULL,      -- ts of the posted message (for chat.update)
  channel              TEXT NOT NULL,
  brief_label          TEXT,
  primary_mention_json TEXT NOT NULL,      -- the mention we headlined (to rebuild blocks)
  outlets_json         TEXT NOT NULL,      -- [{name,url,reach}] of every outlet, primary first
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stories_updated_at ON stories (updated_at);
