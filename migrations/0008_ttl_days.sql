CREATE TABLE gift_links_new (
  token TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  email TEXT NOT NULL,
  gifter_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expired_at INTEGER DEFAULT NULL,
  max_views INTEGER NOT NULL DEFAULT 0,
  ttl_days INTEGER NOT NULL DEFAULT 14
);
INSERT INTO gift_links_new SELECT token, url, email, gifter_name, created_at, expired_at, COALESCE(max_views, 0), 14 FROM gift_links;
DROP TABLE gift_links;
ALTER TABLE gift_links_new RENAME TO gift_links;
