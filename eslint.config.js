// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '**/*.tsbuildinfo'],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Root-level tooling configs are not part of any package's tsconfig,
          // so the project service needs them listed explicitly to type-check them.
          allowDefaultProject: ['*.config.ts', '*.config.js'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The engine must never reach for `any`; determinism depends on knowing the shapes.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      // Structured logging only (Pino). See docs/Architecture.md.
      'no-console': 'error',
      // Prototype-pollution defence: never walk into inherited keys.
      'no-prototype-builtins': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // Determinism-critical packages: key order in JSON.stringify is insertion-ordered,
    // so it can silently produce two different hashes for the same logical object.
    files: ['packages/proof/**/*.ts', 'packages/engine/**/*.ts', 'packages/normalizer/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='JSON'][callee.property.name='stringify']",
          message:
            'Never serialize with JSON.stringify here — use canonicalize() from @sentinel/proof (fast-json-stable-stringify) so hashes stay reproducible.',
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
