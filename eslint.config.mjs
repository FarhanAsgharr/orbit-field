/**
 * ESLint, flat config.
 *
 * One config for four very different environments in one repository: a Node
 * service, a React web console, a React Native app, and three isomorphic
 * packages. They cannot share a single `globals` set — `document` is a bug in
 * the backend and a necessity in the console — so the shared rules live in one
 * block and each surface adds only what it genuinely differs on.
 *
 * Type-aware linting (`projectService`) is deliberately on. Rules like
 * `no-floating-promises` are the ones that catch real defects in this codebase —
 * an un-awaited `void`-ed promise is exactly how the mobile sync failure hid
 * itself — and they cannot work without type information.
 *
 * Prettier is applied through `eslint-config-prettier`, which switches off
 * formatting rules rather than reporting formatting as lint errors. Formatting
 * is `npm run format`; lint is for defects.
 */

import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Generated, vendored, or not ours. Listed first so nothing below reaches
    // into them — type-aware linting on node_modules is minutes, not seconds.
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.expo/**',
      '**/android/**',
      '**/ios/**',
      '**/coverage/**',
      'apps/backend/prisma/migrations/**',
      'apps/mobile/.expo/**',
      'apps/mobile/expo-env.d.ts',
      'deployment/**',
      '**/*.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
    plugins: { 'simple-import-sort': simpleImportSort },
    rules: {
      'simple-import-sort/imports': 'warn',
      'simple-import-sort/exports': 'warn',

      // An unused variable is either a mistake or a leftover. The underscore
      // escape hatch is for the genuine cases: a discarded destructure, a
      // signature that must keep a parameter it does not read.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],

      // The rules that earn their keep here. A dropped promise in the sync
      // engine is silent in production and cost real debugging time to find.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],

      // `any` is sometimes the honest type at a boundary (a JSON payload, an
      // untyped native module), so it warns rather than blocks.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',

      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/unbound-method': 'off',

      /*
       * Off, and not casually.
       *
       * This rule is auto-fixable, so `lint:fix` silently deletes type
       * assertions it judges redundant — and that judgement is only as good as
       * the tsconfig ESLint happens to resolve. Running it here stripped
       * assertions from 23 files across the backend, mobile app and console in
       * one pass, including `as HTMLElement[]` casts that were load-bearing
       * under the console's own `lib` settings but looked unnecessary under the
       * lint config's. The console stopped typechecking; the rest compiled but
       * had been rewritten unreviewed.
       *
       * A rule that edits the type-safety of production code as a side effect
       * of formatting is not worth the tidiness. `tsc` already rejects an
       * assertion that is actually wrong.
       */
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',

      /*
       * Off: the unions it objects to are deliberate public API.
       *
       * `Permission | string` and `ErrorCode | string` exist so callers get
       * autocomplete for the known values while an unrecognised one — a
       * permission added by a newer server, an error code from a future
       * release — still typechecks instead of breaking the build of every
       * client. Collapsing them to `string` to satisfy the rule would delete
       * the autocomplete, which is the entire benefit.
       */
      '@typescript-eslint/no-redundant-type-constituents': 'off',

      /*
       * Off: `async` here is interface conformance, not an oversight.
       *
       * `SyncTransport.push`/`pull` and the Express handler signatures must
       * return a promise whether or not a particular implementation awaits
       * anything. Dropping `async` to satisfy the rule changes the declared
       * return type and breaks the contract; adding a pointless `await` to
       * satisfy it is worse.
       */
      '@typescript-eslint/require-await': 'off',

      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off',
    },
  },

  // --- backend: Node, no DOM -----------------------------------------------
  {
    files: ['apps/backend/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { project: ['./apps/backend/tsconfig.eslint.json'] },
    },
  },

  // --- console: React in a browser -----------------------------------------
  {
    files: ['apps/admin-dashboard/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        ecmaFeatures: { jsx: true },
        project: ['./apps/admin-dashboard/tsconfig.eslint.json'],
      },
    },
    plugins: { react, 'react-hooks': reactHooks },
    settings: { react: { version: 'detect' } },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // The new JSX transform: no `React` identifier needed in scope.
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
    },
  },

  // --- mobile: React Native, neither browser nor plain Node ----------------
  {
    files: ['apps/mobile/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node, __DEV__: 'readonly' },
      parserOptions: {
        ecmaFeatures: { jsx: true },
        project: ['./apps/mobile/tsconfig.eslint.json'],
      },
    },
    plugins: { react, 'react-hooks': reactHooks },
    settings: { react: { version: 'detect' } },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      // React Native has no <a>, and the rule fires on unrelated props.
      'react/no-unescaped-entities': 'off',
    },
  },

  // --- shared packages: must run in Node, Hermes and the browser -----------
  {
    files: ['packages/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
      parserOptions: { project: ['./packages/*/tsconfig.eslint.json'] },
    },
  },

  // --- scripts and build config: plain Node, outside every tsconfig --------
  //
  // No tsconfig covers these, so the type-aware parser cannot resolve them
  // ("was not found by the project service"). They still get the full set of
  // syntactic and correctness rules — only the rules that genuinely need a type
  // checker are switched off.
  {
    files: [
      'scripts/**/*.mjs',
      '**/*.config.{ts,mjs,js}',
      '*.mjs',
      'apps/*/*.config.{ts,mjs,js}',
      // Root-level vitest setup: no workspace tsconfig covers it either.
      'vitest.setup.*.ts',
    ],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: { ...globals.node },
      parserOptions: { projectService: false, project: false },
    },
    rules: {
      // Spread first: a bare `rules` key would replace the whole set that
      // `disableTypeChecked` provides, re-enabling every type-aware rule on
      // files that have no type information — which crashes ESLint outright
      // rather than reporting anything.
      ...tseslint.configs.disableTypeChecked.rules,
      // Metro and other build configs are CommonJS by contract — the tools that
      // load them do not accept ESM. `require` is the correct call there.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // --- tests: fixtures legitimately do odd things -------------------------
  {
    files: ['**/*.test.{ts,tsx}', '**/test/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  // Must stay last: switches off every rule Prettier owns.
  prettier,
);
