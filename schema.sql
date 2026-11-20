CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  addr       TEXT    NOT NULL,
  sender     TEXT,
  subject    TEXT,
  text       TEXT,
  html       TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_addr_created ON messages (addr, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages (created_at);
