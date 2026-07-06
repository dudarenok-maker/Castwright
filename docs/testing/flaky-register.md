# Flaky-test register

Tests quarantined out of the gating suites into the non-gating lane
(`npm run test:quarantine`). A row here is a debt: the test does not gate
releases until it is rewritten deterministically and graduated back.
Empty register = done. See the rewrite playbook in
`docs/superpowers/specs/2026-06-17-flaky-test-release-hardening-design.md`.

| Test | File | Class | Symptom | Tracking issue | Quarantined |
|------|------|-------|---------|----------------|-------------|
| `engages on the one in-flight chapter and releases once it completes`, `stays engaged while a second chapter is still in flight, releases only after both drain` | `server/src/routes/generation.test.ts` | Windows tmpdir/fs contention (pre-existing file-level hot-file class, see `vitest.config.slow.ts`'s file comment) | Test times out waiting for a mocked `synthesiseChapter` call that never arrives — the POST never reaches the route's synth call at all under real system load. Verified NOT a defect in these tests or the sleep-prevention feature they cover: a throwaway, completely unrelated single-request test (no relation to prevent-sleep) reproduced an identical indefinite hang under the same load, regardless of position in the file (including as the very first describe block). Both pass reliably and deterministically in isolation under normal load. | #399 (side-11) | 2026-07-06 |

<!-- 2026-07-06: NOT empty — see the row above, added alongside the side-11 investigation's 1.7B prompt-cache fix + the generation.ts sleep-prevention wake-lock hook. -->
_~~Empty — no tests are currently quarantined.~~_

<!-- Graduated 2026-06-30: `e2e/start-generation-tier-prompt.spec.ts` (#1178). The
"cold-load race" was three spec-local defects masked by implicit timing — the
"Approve cast" click firing before the cast slice hydrated (no modal), the case-D
guard premise broken by the fixture's pre-designed Eliza, and cases A/B driving a
brittle cast-design UI — plus a shared `goToAnalysing` lazy-chunk wait. Replaced
with explicit ready signals (`waitForQwenCastHydrated` / `waitForRouteReady`) and
store-seeded preconditions. See the commit for the full root-cause writeup. -->
