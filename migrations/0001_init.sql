CREATE TABLE IF NOT EXISTS sessions (
  origin TEXT PRIMARY KEY,
  cookies TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gift_links (
  token TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  email TEXT NOT NULL,
  gifter_name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
