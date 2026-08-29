ALTER TABLE visits ADD COLUMN session_id TEXT;
ALTER TABLE visits ADD COLUMN first_seen TEXT;
ALTER TABLE visits ADD COLUMN last_seen TEXT;
ALTER TABLE visits ADD COLUMN pageviews INTEGER NOT NULL DEFAULT 1;
ALTER TABLE visits ADD COLUMN pages TEXT;
CREATE UNIQUE INDEX visits_session_id_unique ON visits(session_id);
