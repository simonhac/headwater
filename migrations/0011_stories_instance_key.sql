-- story_key gains the posting instance: "<channel>|<sha256(title)>|<created_at>".
--
-- Before this, the key was eternal while the merge lookup was windowed (72h). A headline that
-- recurred later found nothing to merge into, posted a fresh card, then collided on INSERT — and
-- `ON CONFLICT(story_key) DO UPDATE` repointed the row at the new message, cutting the old card
-- loose with nothing in D1 referencing it. That produced 16 of the 17 orphans swept on 2026-09-08.
--
-- Appending created_at makes each posting its own row, so both cards keep a row (and stay in the
-- orphan sweep's allow-list). Lookups now match on the "<channel>|<hash>" prefix.
--
-- Idempotent: only rewrites two-part keys (exactly one '|'). Channel ids and hex hashes never
-- contain '|', so the separator count is an unambiguous version marker.
UPDATE stories
   SET story_key = story_key || '|' || created_at
 WHERE length(story_key) - length(replace(story_key, '|', '')) = 1;
