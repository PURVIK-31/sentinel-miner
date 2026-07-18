import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** Resolves a workspace package to its TypeScript source entry point. */
const pkg = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    /**
     * Point workspace imports at source rather than the built `dist`.
     *
     * Without this, `npm test` would require a full `tsc --build` first, and
     * coverage would be attributed to compiled output instead of the files
     * under `src` that the 95% threshold is meant to police.
     */
    alias: {
      '@sentinel/shared': pkg('shared'),
      '@sentinel/dsl': pkg('dsl'),
      '@sentinel/engine': pkg('engine'),
      '@sentinel/normalizer': pkg('normalizer'),
      '@sentinel/providers': pkg('providers'),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'evaluation/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts', '**/*.d.ts'],
      // The charter mandates 95%+. CI fails below this.
      thresholds: {
        lines: 95,
        functions: 95,
        branches: 95,
        statements: 95,
      },
    },
  },
});
