import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Child processes + SSE streams need more headroom than the 5s default.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // The suite spawns stdio children and binds sockets: run files serially.
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
  },
});
