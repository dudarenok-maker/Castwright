# Flaky-test register

Tests quarantined out of the gating suites into the non-gating lane
(`npm run test:quarantine`). A row here is a debt: the test does not gate
releases until it is rewritten deterministically and graduated back.
Empty register = done. See the rewrite playbook in
`docs/superpowers/specs/2026-06-17-flaky-test-release-hardening-design.md`.

| Test | File | Class | Symptom | Tracking issue | Quarantined |
|------|------|-------|---------|----------------|-------------|
| Phase 1 chapter K rolling-roster snapshot | `server/src/routes/analysis-pipelining.test.ts` | `runMainAnalyzerJob — rolling roster snapshot` | CPU+I/O contention timeout (blew 180s budget under load; also 363s locally under contention) | #878 | 2026-06-17 |
| pipelined Phase 0/1 interleaved execution | `server/src/routes/analysis-pipelining.test.ts` | `runMainAnalyzerJob — pipelined Phase 0/1 interleaved execution` | CPU+I/O contention timeout — drive-to-completion + real CACHE_DIR write | #878 | 2026-06-17 |
| back-pressure under stall | `server/src/routes/analysis-pipelining.test.ts` | `runMainAnalyzerJob — back-pressure under stall` | CPU+I/O contention timeout — drive-to-completion + real CACHE_DIR write | #878 | 2026-06-17 |
| non-pipelined mode collapses to sequential | `server/src/routes/analysis-pipelining.test.ts` | `runMainAnalyzerJob — non-pipelined mode collapses to sequential` | CPU+I/O contention timeout — drive-to-completion + real CACHE_DIR write | #878 | 2026-06-17 |
| concurrent pool interleaving in production | `server/src/routes/analysis-pipelining.test.ts` | `runMainAnalyzerJob — concurrent pool interleaving in production` | CPU+I/O contention timeout — drive-to-completion + real CACHE_DIR write | #878 | 2026-06-17 |
| Phase 1 resolves via selectAnalyzerForPhase with per-request model | `server/src/routes/analysis-pipelining.test.ts` | `runMainAnalyzerJob — Phase 1 resolves via selectAnalyzerForPhase even with a per-request model` | CPU+I/O contention timeout — drive-to-completion + real CACHE_DIR write | #878 | 2026-06-17 |
