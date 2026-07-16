-- Broadcast station codes awaiting a rendered name, drained SERIALLY by the StationRenderer DO.
-- One row per station code (deduped via the PK); a code is inserted only when its name is unknown
-- and its authorName looked like a presenter, and deleted once station_names gets a name for it — so
-- each station is rendered at most once, ever. Kept in D1 (not DO storage) so /inspect + admin can
-- see the backlog. The DO caps attempts and stops at the daily Browser Rendering budget.
CREATE TABLE IF NOT EXISTS render_queue (
  code            TEXT PRIMARY KEY,   -- Meltwater numeric broadcast code awaiting a name
  viewer_url      TEXT NOT NULL,      -- unwrapped transition/viewer URL for the drainer to render
  attempts        INTEGER NOT NULL DEFAULT 0,
  enqueued_at     INTEGER NOT NULL,   -- epoch ms first queued (FIFO drain order)
  last_attempt_at INTEGER             -- epoch ms of the last render attempt (null until first tried)
);
