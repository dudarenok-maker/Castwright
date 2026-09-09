# Manual Acceptance Tests

These scripts are human-read manual acceptance aids for testing Castwright features that require real hardware, real book state, or live server interaction. They are **not** part of the automated Playwright test suite — `npm run test:e2e` correctly skips these files because they do not match the test naming pattern (`*.spec.ts` or `*.test.mjs`).

**Important:** Most checks in these scripts are `console.log`d booleans, often wrapped in `.catch(() => false)`. A successful exit code (0) does **not** mean every check passed — read the printed output to verify all assertions succeeded. If a script exits 0 but prints "FAIL: …" lines, the test failed; if it prints only "✓ PASS" lines, it succeeded.
