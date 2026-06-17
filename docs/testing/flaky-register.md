# Flaky-test register

Tests quarantined out of the gating suites into the non-gating lane
(`npm run test:quarantine`). A row here is a debt: the test does not gate
releases until it is rewritten deterministically and graduated back.
Empty register = done. See the rewrite playbook in
`docs/superpowers/specs/2026-06-17-flaky-test-release-hardening-design.md`.

| Test | File | Class | Symptom | Tracking issue | Quarantined |
|------|------|-------|---------|----------------|-------------|
| Phase 1 chapter K rolling-roster snapshot | `server/src/routes/analysis-pipelining.test.ts` | `runMainAnalyzerJob — rolling roster snapshot` | CPU+I/O contention timeout (blew 180s budget under load; also 363s locally under contention) | #878 | 2026-06-17 |
