CREATE TABLE session_page_scroll_profiles (
  session_id TEXT NOT NULL,
  page TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, page)
);

CREATE INDEX session_page_scroll_profiles_session_idx
  ON session_page_scroll_profiles(session_id);
