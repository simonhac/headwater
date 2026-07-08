-- Cache of Meltwater broadcast station codes, so we resolve a radio/TV item's station at most once.
-- Keyed by the Meltwater document id; `code` is the numeric Station=<code> read from the transition
-- link's mediaView token (null if the fetch found none). The code→name lookup itself is the static
-- STATION_BY_CODE map, so adding a name there later fixes cached rows without a re-fetch.
CREATE TABLE IF NOT EXISTS broadcast_stations (
  doc_id       TEXT PRIMARY KEY,
  code         TEXT,
  resolved_at  INTEGER NOT NULL
);
