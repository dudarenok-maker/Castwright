# Flaky-test register

Tests quarantined out of the gating suites into the non-gating lane
(`npm run test:quarantine`). A row here is a debt: the test does not gate
releases until it is rewritten deterministically and graduated back.
Empty register = done. See the rewrite playbook in
`docs/superpowers/specs/2026-06-17-flaky-test-release-hardening-design.md`.

| Test | File | Class | Symptom | Tracking issue | Quarantined |
|------|------|-------|---------|----------------|-------------|
| StartGenerationModal voice-model prompt + three-sink sync (all 6 cases) | `e2e/start-generation-tier-prompt.spec.ts` | cold-load race | `goToConfirm`/`goToStartGenModal` cold-load race exhausts Playwright retries under battery/cold-webServer load; the `Choose the voice model` heading never appears → gate red. Fails 1/6 in the full battery, 5/6 in isolation. | [#1178](https://github.com/dudarenok-maker/Castwright/issues/1178) | 2026-06-30 |
