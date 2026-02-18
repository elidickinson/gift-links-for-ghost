#!/bin/sh
# Clear Ghost's brute-force rate limiting table (brute-knex stores in SQLite)
docker exec ghostgift-ghost sqlite3 /var/lib/ghost/content/data/ghost.db "DELETE FROM brute;"
