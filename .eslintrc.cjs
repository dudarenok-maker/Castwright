/* ESLint config for the audiobook-generator monorepo (legacy
   .eslintrc.cjs because we're pinned on ESLint 8.57). Frontend
   (React + TS), server (Node + TS), e2e (Playwright), scripts (Node)
   all live in one repo and share the validator harness — the
   overrides below carve out per-area rule sets without forcing
   per-package configs.

   Companion: `.prettierrc` handles formatting; `eslint-config-prettier`
   below disables every formatting-related ESLint rule so the two
   tools don't fight. Companion plan: `docs/features/46-lint-format-a11y.md`. */
module.exports = {
  root: true,
  env: {
    browser: true,
    es2022: true,
    node: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  settings: {
    react: { version: 'detect' },
  },
  plugins: ['@typescript-eslint', 'react', 'react-hooks', 'jsx-a11y'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
    'plugin:jsx-a11y/recommended',
    'prettier',
  ],
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
       this plan-46 baseline PR. Each is off rather than warn because the
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
    /* Server / lib patterns: legitimate while(true) loops, intentional
       \x00-range regex in text-normalize, empty catch blocks that
       swallow expected failures. Each is documented at the call site;
       the rule is noise here. */
    'no-constant-condition': 'off',
    'no-control-regex': 'off',
    'no-empty': 'off',
    'no-inner-declarations': 'off',
  },
  ignorePatterns: [
    'dist/',
    'node_modules/',
    'server/dist/',
    'server/tts-sidecar/.venv/',
    'server/handoff/',
    'playwright-report/',
    'test-results/',
    'e2e/**/__snapshots__/',
    'audiobook-workspace/',
    'src/lib/api-types.ts',
  ],
  overrides: [
    {
      files: ['*.test.ts', '*.test.tsx', '**/test/**/*.ts', '**/test/**/*.tsx', '**/tests/**/*.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-non-null-assertion': 'off',
        /* MP3 fixtures occasionally embed NBSP / zero-width-joiner. */
        'no-irregular-whitespace': 'off',
      },
    },
    {
      files: ['e2e/**/*.ts'],
      env: { node: true },
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
      },
    },
    {
      files: ['server/**/*.ts'],
      env: { node: true, browser: false },
      rules: {
        'react/jsx-key': 'off',
        'jsx-a11y/anchor-is-valid': 'off',
      },
    },
    {
      files: ['scripts/**/*.mjs', 'scripts/**/*.cjs', 'scripts/**/*.js'],
      env: { node: true },
      parser: 'espree',
      rules: {
        '@typescript-eslint/no-var-requires': 'off',
      },
    },
    {
      files: ['*.cjs', '*.config.js', '*.config.cjs', '*.config.ts'],
      env: { node: true },
      rules: {
        '@typescript-eslint/no-var-requires': 'off',
      },
    },
  ],
};
