import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    include: ['test/**/*.test.js'],
    fileParallelism: false, // workerd exhausts ephemeral ports on macOS otherwise
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        singleWorker: true,
      },
    },
  },
});
