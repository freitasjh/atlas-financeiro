import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'libs/shared-contracts/src'),
    },
  },
  test: {
    environment: 'node',
    include: ['apps/**/*.spec.ts', 'libs/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
