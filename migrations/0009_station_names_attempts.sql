-- Preserve how many render attempts a code took, even after it resolves and its render_queue row is
-- deleted. NULL for seeded rows and for names taken render-free from a station-like authorName; set to
-- the successful attempt number by the StationRenderer DO. Surfaced on the /stations status page.
ALTER TABLE station_names ADD COLUMN attempts INTEGER;
