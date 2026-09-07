import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/support/global-setup.ts'],
    environment: 'node',
    globals: false,
    // Integration suites also spawn MCP processes; bound parallel files so
    // coverage runs do not oversubscribe developer machines and CI runners.
    maxWorkers: 4,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      thresholds: {
        statements: 74,
        branches: 65,
        functions: 70,
        lines: 75,
      },
    },
  },
});
