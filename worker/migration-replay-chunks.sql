CREATE TABLE session_replay_chunks (
  page_instance_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  events_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (page_instance_id, chunk_index)
);

CREATE INDEX session_replay_chunks_page_idx
  ON session_replay_chunks(page_instance_id, chunk_index);
