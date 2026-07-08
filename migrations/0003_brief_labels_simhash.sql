-- One card per story across briefs, plus broadcast near-duplicate merging.
--   brief_labels_json: every Organisation Brief that matched this story (primary first),
--                      so the card can show "also matched `MPs`".
--   simhash / media_type: 64-bit SimHash of the transcript + its medium, used to fold the
--                      same radio/TV segment across stations (different program title, drifting ASR).
ALTER TABLE stories ADD COLUMN brief_labels_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE stories ADD COLUMN simhash TEXT;      -- decimal string of a 64-bit fingerprint, null when N/A
ALTER TABLE stories ADD COLUMN media_type TEXT;   -- gates near-dup matching to broadcast media

CREATE INDEX IF NOT EXISTS idx_stories_simhash ON stories (updated_at) WHERE simhash IS NOT NULL;
