'use strict';

// Flat config (ESLint 9.x). The package ships three distinct module shapes —
// see STANDARDS.md / this ticket (PKG-82) for why each gets its own block:
//   - src/*.js            CommonJS, Node >= 20, 'use strict' at file tops.
//   - src/__tests__/*.ts  TypeScript, run through vitest (no globals: true —
//                         every test file imports describe/it/expect itself).
//   - scripts/*.mjs       ESM utility scripts (release smoke test, etc).
// This file itself is CommonJS (package.json has no "type": "module").

const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const globals = require('globals');

module.exports = tseslint.config(
  {
    // `.worktree/**` is a NESTED CHECKOUT, not source of this working tree: it
    // holds another branch's copy of the repo (the standard place a feature
    // branch is developed). Linting it is wrong twice over — it reports on code
    // that is not what you are editing, and its files do not match the
    // path-scoped blocks below, which are resolved against the LINT ROOT. A
    // worktree copy of `scripts/verify-pack.mjs` lands at
    // `.worktree/<slug>/scripts/verify-pack.mjs`, which `scripts/**/*.mjs` does
    // not match, so it fell through to a config with no Node globals and every
    // `console`/`process` became `no-undef`. That failed `lint`, and `verify`
    // starts with `lint` — so anyone with a worktree open, which is the normal
    // way work happens here, could not run the battery at all (PKG-118).
    ignores: ['node_modules/**', 'coverage/**', '*.tgz', '.worktree/**'],
  },

  // Baseline recommended rules for everything JS-ish.
  js.configs.recommended,

  // All *.js — CommonJS (package.json has no "type": "module", so this is
  // every plain .js file: src/*.js runtime code plus root-level CJS config
  // like release-kit.config.js and this file itself).
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
  },

  // scripts/*.mjs — ESM utility scripts (verify-pack, etc).
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
  },

  // TypeScript: test suite + the type-consumer contract script.
  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Every test file imports the CJS source with
      // `require('../x.js') as <hand-written interface>` (createRequire, since
      // there is no build step) and then casts fake execFileSync recorders to
      // loose shapes. That's the established, repo-wide convention for typing
      // an untyped CJS boundary in tests, not sloppiness in one file — with
      // the rule on (verified by temporarily re-enabling it) it fires 84
      // times across every single test file, all at that same boundary.
      // Disabling here rather than chasing 84 call sites we're not allowed
      // to edit (src/__tests__ is owned by another agent on this ticket).
      '@typescript-eslint/no-explicit-any': 'off',
      // Same boundary, same reasoning: `Function` is used as the loose type
      // for casting `require()`'d CJS functions (e.g. `{ run: Function }`)
      // in the same lines the `any` casts above appear on.
      '@typescript-eslint/no-unsafe-function-type': 'off',
      // Keep unused-vars on (real dead-code signal), but recognize the
      // idiomatic `const { omit, ...rest } = obj` destructure-to-drop-a-key
      // pattern (used in deploy-kit.test.ts) as intentional rather than
      // flagging the omitted key as unused.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
);
