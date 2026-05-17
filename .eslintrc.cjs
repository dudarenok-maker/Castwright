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
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'warn',
    /* These two jsx-a11y rules flag real a11y debt (click-handlers on
       static elements without keyboard support). We have pre-existing
       violations across listen / manuscript / upload / voices. Downgrade
       to warn so the gate doesn't block on inherited debt; the axe-core
       harness covers the rendered-DOM side. Track cleanups as their own
       follow-up PRs rather than bundling here. */
    'jsx-a11y/click-events-have-key-events': 'warn',
    'jsx-a11y/no-static-element-interactions': 'warn',
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
