CREATE TABLE session_replay_pages (
  page_instance_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  page TEXT NOT NULL,
  site_version TEXT NOT NULL,
  viewport_width INTEGER NOT NULL,
  viewport_height INTEGER NOT NULL,
  document_height INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  last_seen TEXT NOT NULL
);

CREATE INDEX session_replay_pages_session_idx
  ON session_replay_pages(session_id, started_at);

CREATE TABLE session_replay_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_instance_id TEXT NOT NULL,
  event_index INTEGER NOT NULL,
  at_ms INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (page_instance_id, event_index)
);

CREATE INDEX session_replay_events_page_idx
  ON session_replay_events(page_instance_id, event_index);
