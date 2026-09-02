ALTER TABLE visits ADD COLUMN device_type TEXT;

CREATE TABLE session_page_metrics (
  session_id TEXT NOT NULL,
  page TEXT NOT NULL,
  active_seconds REAL NOT NULL DEFAULT 0,
  max_scroll_depth INTEGER NOT NULL DEFAULT 0,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  PRIMARY KEY (session_id, page)
);

CREATE INDEX session_page_metrics_session_idx
  ON session_page_metrics(session_id);

CREATE TABLE session_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  action TEXT NOT NULL,
  page TEXT NOT NULL,
  target TEXT NOT NULL,
  first_clicked TEXT NOT NULL,
  last_clicked TEXT NOT NULL,
  click_count INTEGER NOT NULL DEFAULT 1,
  UNIQUE (session_id, action, page, target)
);

CREATE INDEX session_actions_session_idx
  ON session_actions(session_id);
