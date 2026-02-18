CREATE TABLE IF NOT EXISTS link_views (
  token TEXT NOT NULL,
  viewed_at INTEGER NOT NULL,
  referer_domain TEXT,
  country TEXT
);

CREATE INDEX IF NOT EXISTS idx_link_views_token ON link_views(token);
CREATE INDEX IF NOT EXISTS idx_link_views_viewed_at ON link_views(viewed_at);
