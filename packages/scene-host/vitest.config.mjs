import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  server: { fs: { allow: [repoRoot] } },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
