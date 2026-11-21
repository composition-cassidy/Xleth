import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Match the app's JSX transform (vite.config.js uses @vitejs/plugin-react,
  // i.e. the automatic runtime). Without this, esbuild defaults to the classic
  // transform and any component that doesn't explicitly `import React` (most of
  // them) throws "React is not defined" when rendered in a test.
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    setupFiles: ['./src/test-setup.js'],
    // electron-main holds plain Node modules (no JSX, no DOM) that are worth
    // unit-testing on their own — the session log buffer and its report
    // formatting, for instance, have no renderer half to test them through.
    include: [
      'src/**/*.{test,spec}.{ts,tsx,js,jsx}',
      'electron-main/**/*.{test,spec}.{ts,js}',
    ],
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
