import migrationInit from '../migrations/0001_init.sql?raw';
import migrationAnalytics from '../migrations/0002_analytics.sql?raw';
import migrationJwks from '../migrations/0003_jwks.sql?raw';
import migrationSoftDelete from '../migrations/0004_soft_delete.sql?raw';
import migrationMagicLinkRateLimit from '../migrations/0005_magic_link_rate_limit.sql?raw';
import migrationRefreshFailures from '../migrations/0006_refresh_failures.sql?raw';

// workerd D1 exec() crashes on multi-statement SQL, so split and run each via prepare()
export async function setupDatabase(db) {
  const allSql = [migrationInit, migrationAnalytics, migrationJwks, migrationSoftDelete, migrationMagicLinkRateLimit, migrationRefreshFailures].join('\n');
  const statements = allSql.split(';').map(s => s.trim()).filter(Boolean);
  for (const statement of statements) {
    await db.prepare(statement).run();
  }
}
