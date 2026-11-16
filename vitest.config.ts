import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Child processes + SSE streams need more headroom than the 5s default.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // The suite spawns stdio children and binds sockets; keep files isolated and serial.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
