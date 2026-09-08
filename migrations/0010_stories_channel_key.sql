-- Multi-channel fanout: one Slack message per story PER CHANNEL, so `story_key` becomes
-- "<channel>|<sha256(normalized title)>" instead of the bare hash. The PK is unchanged; only the
-- key's shape is. Legacy rows all live in a single channel, so re-key them in place.
-- Idempotent: the guard skips rows that already carry a channel prefix, so re-running is a no-op.
UPDATE stories SET story_key = channel || '|' || story_key WHERE story_key NOT LIKE '%|%';
