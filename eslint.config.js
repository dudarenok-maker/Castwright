/* ESLint flat config for the audiobook-generator monorepo (ESLint 9 —
   migrated from the legacy `.eslintrc.cjs` in plan 104). Frontend
   (React + TS), server (Node + TS), e2e (Playwright), scripts (Node)
   all live in one repo and share the validator harness — the per-area
   `{ files, rules }` objects below carve out per-area rule sets without
   forcing per-package configs.

   ESLint target is 9, NOT 10: `eslint-plugin-react@7.37.5` peers
   `eslint: …^9.7` and `eslint-plugin-jsx-a11y@6.10.2` peers `eslint: …^9`
   — neither declares ESLint-10 support yet, so 9 is the ceiling. Revisit
   when both plugins ship an ESLint-10 peer range. See
   `docs/features/archive/104-eslint-flat-config.md`.

   Companion: `.prettierrc` handles formatting; `eslint-config-prettier`
   (last in the array) disables every formatting-related ESLint rule so
   the two tools don't fight. Companion plan:
   `docs/features/archive/46-lint-format-a11y.md`. */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  /* ignorePatterns → a standalone global-ignores object. A flat-config
     object that contains ONLY `ignores` applies the patterns globally
     (plan-46 invariants #3/#4: `src/lib/api-types.ts` is generated and
     `audiobook-workspace/` is user runtime data — both stay un-linted). */
  {
    ignores: [
      'dist/',
      'node_modules/',
      // Claude Code harness dir: settings JSON (not linted) + transient agent
      // worktrees that carry their own built `dist/` output. Without this, lint
      // walks into `.claude/worktrees/<agent>/server/dist/` and floods errors.
      '.claude/',
      'server/dist/',
      'server/tts-sidecar/.venv/',
      'server/handoff/',
      'playwright-report/',
      'test-results/',
      'e2e/**/__snapshots__/',
      'audiobook-workspace/',
      'src/lib/api-types.ts',
      // Ad-hoc, local-only repro/bisect scripts (e.g. server/repro-attribution.mts).
      // Throwaway debugging probes — git-ignored and not held to the lint bar.
      'server/repro-*.mts',
    ],
  },

  /* eslint:recommended → js.configs.recommended. */
  js.configs.recommended,

  /* plugin:@typescript-eslint/recommended → tseslint.configs.recommended.
     The TS parser is applied ONLY to TS files (the ts/tsx/mts/cts glob)
     below; the scripts globs keep ESLint's default (espree) parser
     (replaces the old `parser: 'espree'` scripts override). */
  ...tseslint.configs.recommended,

  /* plugin:react/recommended (flat) + settings.react.version=detect. */
  react.configs.flat.recommended,

  /* plugin:jsx-a11y/recommended (flat). */
  jsxA11y.flatConfigs.recommended,

  /* Base language options + globals. `env: { browser, es2022, node }` →
     languageOptions.globals via the `globals` package. parserOptions →
     languageOptions.parserOptions (ecmaVersion/sourceType/jsx). */
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2021,
      },
    },
    settings: {
      react: { version: 'detect' },
    },
    /* react-hooks v7 bundles the React Compiler ruleset in its
       `recommended`/`recommended-latest` flat configs (~15 new rules);
       enabling those wholesale would inject brand-new lint noise, which
       the plan-46 ratchet forbids. To preserve the EXACT v4 rule surface
       the old config had (`plugin:react-hooks/recommended` → rules-of-hooks
       + exhaustive-deps), register the plugin and set only those two rules
       explicitly. rules-of-hooks stays `off` (relaxation carried verbatim
       from the old config; see the rules block below). */
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      /* Apostrophes / quotes in JSX content are valid in modern React (React
         escapes them at render). Escaping them produces noisier source; most
         React projects disable this rule outright. */
      'react/no-unescaped-entities': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      /* The following rules flag inherited patterns we are not changing in
         this plan-46 baseline. Each is off rather than warn because the
         lint script runs with --max-warnings 0; future PRs that clean up
         the underlying code should re-promote these to error.

         jsx-a11y (interactive-elements family): the four views (library,
         upload, confirm, listen) have keyboard-equivalent affordances
         — every "card" with onClick uses role+tabIndex+onKeyDown. The
         rule mis-fires on the article role="button" pattern. Axe-core
         covers the rendered-DOM side. Re-promote when a per-component
         a11y audit retires the static interactions. */
      'jsx-a11y/click-events-have-key-events': 'off',
      'jsx-a11y/no-static-element-interactions': 'off',
      'jsx-a11y/no-noninteractive-element-interactions': 'off',
      'jsx-a11y/no-noninteractive-element-to-interactive-role': 'off',
      /* The MiniPlayer's <audio> element is a chapter preview, not a
         captioned media surface — there is no caption track to ship.
         Re-enable if/when generated audio surfaces SRT-like sidecars. */
      'jsx-a11y/media-has-caption': 'off',
      /* react-hooks/rules-of-hooks fires on pre-existing
         early-return-then-hook patterns in layout.tsx, character-regenerate.tsx,
         and confirm-metadata.tsx. Each is a real but inherited rules-violation
         that needs its own surgical fix (move hooks above the early
         return). Out of scope for the baseline; tracked as a follow-up. */
      'react-hooks/rules-of-hooks': 'off',
      /* exhaustive-deps was warn in the old v4 `plugin:react-hooks/recommended`
         set; carried verbatim. (Set explicitly because v7's bundled config
         layers on the Compiler rules we deliberately do not adopt here.) */
      'react-hooks/exhaustive-deps': 'warn',
      /* Server / lib patterns: legitimate while(true) loops, intentional
         \x00-range regex in text-normalize, empty catch blocks that
         swallow expected failures. Each is documented at the call site;
         the rule is noise here. */
      'no-constant-condition': 'off',
      'no-control-regex': 'off',
      'no-empty': 'off',
      'no-inner-declarations': 'off',
    },
  },

  /* parser/parserOptions: apply the TS parser ONLY to TS files so the
     scripts globs keep the default (espree) parser (replaces the old
     `parser: 'espree'` scripts override). */
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
  },

  /* overrides[0] — test files. */
  {
    files: [
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/test/**/*.ts',
      '**/test/**/*.tsx',
      '**/tests/**/*.ts',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      /* MP3 fixtures occasionally embed NBSP / zero-width-joiner. */
      'no-irregular-whitespace': 'off',
    },
  },

  /* overrides[1] — e2e (Playwright, Node env). */
  {
    files: ['e2e/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  /* overrides[2] — server (Node env, no browser). */
  {
    files: ['server/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'react/jsx-key': 'off',
      'jsx-a11y/anchor-is-valid': 'off',
    },
  },

  /* overrides[3] — scripts (Node, default espree parser via the TS-only
     parser scoping above). The old config relaxed
     `@typescript-eslint/no-var-requires` here; in typescript-eslint v8
     that rule was merged into `@typescript-eslint/no-require-imports`,
     and `tseslint.configs.recommended` applies its rules globally (no
     `files` restriction), so the relaxation must be carried forward under
     the new rule name to keep CommonJS scripts (e.g. preflight-ffmpeg.cjs)
     lint-clean. This is the SAME relaxation, not a new one. */
  {
    files: [
      'scripts/**/*.mjs',
      'scripts/**/*.cjs',
      'scripts/**/*.js',
      'pinokio.js',
      'pinokio/**/*.js',
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  /* overrides[4] — config files (Node). Same note as scripts re:
     no-var-requires → no-require-imports rename in typescript-eslint v8. */
  {
    files: ['*.cjs', '*.config.js', '*.config.cjs', '*.config.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  /* eslint-config-prettier MUST be last so it wins the rule cascade and
     disables every formatting rule the configs above turned on. */
  eslintConfigPrettier,
);
