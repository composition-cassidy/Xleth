import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx,js,jsx}'],
    exclude: [
      '**/build/**',
      '**/build/_deps/**',
      '**/.claude/**',
      '**/worktrees/**',
      '**/*.spec.ts',
      '**/tests/baseline/**',
    ],
    globals: false,
  },
});
