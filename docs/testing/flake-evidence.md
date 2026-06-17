# Flake evidence (Wave 0 baseline) — 2026-06-17

Measured on Windows 11, Node 24, Vitest 4, fast dev box (RTX 4070, 32 GB RAM).
All measurements via `node scripts/flake-repro.mjs --runs 3 [--cpu-load --io-load]`.
The real production flake is macOS-only CPU-contention on CI multi-core runners; this
local induced-load measurement is a discriminator, not a CI replay.

---

## analysis-pipelining.test.ts (Class A1)

No-load baseline (3 runs): 5090 ms, 5233 ms, 5093 ms — all exit=0.
Induced-load (3 runs): 195,680 ms exit=0 / **368,813 ms exit=1** / 196,383 ms exit=0.

The rolling-roster case (Case 2) hit the 180,000 ms per-test timeout (with retry=1
exhausted) on run 2 under induced load. The other 5 cases passed all 3 runs under
load. The whole file is a "drive-to-completion + real `saveAnalysisCache` write"
shape — all 6 share the contention root cause per the plan spec.

| Case | no-load ms (avg) | induced-load ms (obs.) | flakes on CI today? | quarantine in W1? |
|------|-----------------|------------------------|---------------------|-------------------|
| 1 interleaved | ~5090–5233 (whole file) | 195–197k (whole file) | unknown — local-only | yes (same shape) |
| 2 rolling roster | (see whole-file above) | **368,813 exit=1** (timeout) | yes — `it.skipIf(CI)` already applied; was the original quarantine target | yes (migrate) |
| 3 back-pressure | (see whole-file above) | passes within whole-file | unknown — local-only | yes (same shape) |
| 4 sequential | (see whole-file above) | passes within whole-file | unknown — local-only | yes (same shape) |
| 5 concurrent | (see whole-file above) | passes within whole-file | unknown — local-only | yes (same shape) |
| plan-118 | (see whole-file above) | passes within whole-file | unknown — local-only | yes (same shape) |

Decision rule: quarantine in Wave 1 any case whose induced-load runtime exceeds its
per-test budget OR has failed a CI/pre-push run. The rolling-roster case (Case 2)
confirmed via timeout under induced load. All other cases quarantined by shape
(drive-to-completion + real cache write; macOS-only contention cannot be reproduced
on the local Windows box per the plan spec).

---

## Slow files (Class A2) — Wave 3 scope

Measurements below are `--runs 3 --cpu-load --io-load` exit codes + ms, plus the
no-load baseline for context.

| File | no-load ms (avg 3 runs) | induced-load ms (3 runs) | induced-load exit codes | actually flakes? | rewrite in W3? |
|------|------------------------|--------------------------|------------------------|------------------|----------------|
| gemini.test.ts | ~17,470–19,228 | 40,107 / 48,074 / 49,915 | 0 / 0 / 0 | unknown — local-only | no (flat) |
| book-state.test.ts | ~3,173–3,327 | 8,267 / 8,391 / 10,525 | 0 / 0 / 0 | unknown — local-only | no (flat) |
| chapters-restructure.test.ts | ~3,248–3,454 | 8,663 / 14,127 / 9,045 | **1** / 0 / 0 | **yes — worker crash under load** | **yes** |
| generation.test.ts | ~6,463–6,810 | 22,779 / 21,318 / 8,837 | 0 / 0 / **1** | **yes — worker crash under load** | **yes** |
| generation-boundary-recycle.test.ts | ~2,594–2,680 | 7,131 / 6,238 / 7,863 | 0 / 0 / 0 | unknown — local-only | no (flat) |
| pdf-real.test.ts | ~1,394–1,468 | 3,314 / 3,518 / 3,704 | 0 / 0 / 0 | unknown — local-only | no (flat) |
| setup-readiness.route.test.ts | ~2,086–2,155 | 5,004 / 5,222 / 5,388 | 0 / 0 / 0 | unknown — local-only | no (flat) |
| kokoro-install.route.test.ts | ~1,386–1,479 | 3,708 / 3,990 / 4,008 | 0 / 0 / 0 | unknown — local-only | no (flat) |
| venv-bootstrap.route.test.ts | ~1,547–1,580 | 3,543 / 3,869 / 3,878 | 0 / 0 / 0 | unknown — local-only | no (flat) |

Notes on worker-crash failures:
- `chapters-restructure.test.ts` run 1: `[vitest-pool]: Worker forks emitted error. Caused by: Error: Worker exited unexpectedly` (confirmed across two separate 3-run sweeps, both flaked once).
- `generation.test.ts` run 3: same "Worker exited unexpectedly" crash. The `retry: 1` in `vitest.config.slow.ts` masks these on the gating path.
- Both files use `mkdtempSync` in `beforeAll` with parallel-fork pressure patterns (same class as the originally documented hot files). Under CPU starvation the worker OOM-kills.
- `gemini.test.ts` showed a ~2.4× slowdown under load (19 s → 49 s) but never failed — stays in slow tier, no rewrite needed.
- The `retry: 1` in `server/vitest.config.slow.ts:62` masks `chapters-restructure` and `generation` failures on the gating path today; they are documented flakers per the `test:server-slow` CI history annotation in CLAUDE.md ("5 hot files routed to `test:server-slow`").

Decision rule: rewrite in Wave 3 ONLY files that actually flake. `chapters-restructure`
and `generation` both failed under induced load; both are W3 targets.

---

## Wave 3 file list (the anchor Wave 3 greps for)

W3-REWRITE: chapters-restructure.test.ts, generation.test.ts

---

## E2E audit (Wave 4) — 2026-06-17

Grep surface: `grep -rnE "waitForTimeout|localhost:[0-9]{4}|127\.0\.0\.1:[0-9]{4}" e2e/`

All hits, dispositions, and actions:

| File | Line | Hit | Disposition | Action |
|------|------|-----|-------------|--------|
| `e2e/analysing-progress.spec.ts` | 46 | `waitForTimeout(250)` | KEEP — deliberate poll interval inside a counting loop (8 × 250 ms = 2 s sample window). No observable DOM state corresponds to "250 ms has elapsed" here; this IS the sampling clock. | none |
| `e2e/concurrent-multi-book.spec.ts` | 61 | `waitForTimeout(500)` | KEEP — negative assertion: verifying BroadcastChannel does NOT fan out a route change. Comment explains the rationale. There is no state to wait for (the point is absence of change); a hard settle is the only correct tool. | none |
| `e2e/marketing/capture.spec.ts` | 104 | `waitForTimeout(400)` | KEEP — CSS theme re-render settle after `emulateMedia`. A screenshot spec; no observable DOM signal maps to "CSS custom-property cascade applied." Justified settle per the comment. | none |
| `e2e/model-manager-models.spec.ts` | 172, 190 | `localhost:11434` | KEEP — this is a URL value inside a **mocked API response body**, not a port the test process connects to. It represents Ollama's own reported URL in a `page.route` stub. Not a flake risk. | none |
| `e2e/helpers.ts` | 123 | `localhost:8080` | KEEP — appears in a **JSDoc comment** explaining why Account specs stub API probes. Comment-only, no port connection. | none |
| `e2e/queue-modal.spec.ts` | 238, 245 | `waitForTimeout(800)` | FIX — waits 800 ms then asserts `queueLen() === 0` (negative assertion). After URL navigation is already confirmed by `toHaveURL`, a hard 800 ms settle is flake-prone on slow CI. Replaced with `expect.poll(queueLen, { timeout: 2_000 }).toBe(0)` — passes instantly when 0 (the happy path), catches a delayed enqueue within 2 s (the regression detection path). | **fixed** |
| `e2e/responsive/visual.spec.ts` | 104, 112, 118, 125, 137, 144, 158, 213, 248, 255, 261, 268, 277, 284, 297 | `waitForTimeout(200–300)` | KEEP — all precede `toHaveScreenshot`. The playwright config has `animations: 'disabled'` which freezes CSS at final state but does NOT suppress the React initial-mount opacity 0→1 frame (this is a JS paint, not a CSS transition). The comment at line 101–103 of visual.spec.ts explains this exactly. No observable DOM signal maps to "React second paint committed." Justified settle for visual baseline specs. | none |
| `e2e/responsive/baseline.spec.ts` | 41, 53 | `waitForTimeout(300)` | KEEP — both follow a state-based hydration gate (`toBeVisible`/`toBeEnabled`). The settle covers CSS layout micro-adjustments after hydration before the `expectNoHorizontalScroll` JS measurement. Same justification as visual.spec.ts post-hydration settles. | none |
| `e2e/responsive/coverage.spec.ts` | 49, 62, 74, 88, 100, 130, 138, 148, 157, 167, 217, 227, 233, 249, 275, 289 | `waitForTimeout(200–300)` | KEEP — all follow a state-based hydration gate (`toBeVisible`/`waitFor`). Same post-hydration settle justification as baseline.spec.ts. | none |
| `e2e/responsive/coverage.spec.ts` | 107, 113, 119 | `waitForTimeout(500)` | FIX — three tests with NO preceding hydration gate. `goto` immediately followed by a bare timeout is a race: if Vite is slow the page may not have rendered at all. Added specific `toBeVisible` hydration signals: generation → `getByText(/^CH 01$/)`, voices → `getByRole('heading', { name: /Every voice you've ever generated/i })`, changelog → `getByRole('heading', { name: /Everything that's happened/i })`. The timeouts were removed (the visibility assertion itself is the gate). | **fixed** |

**Summary:** 2 genuine flake risks fixed. 15+ `waitForTimeout` instances retained as justified (polling clocks, negative assertions, post-hydration CSS settles for screenshot specs). 2 port-literal hits are mock-body data or comments — not connection ports. Global teardown is correct and sufficient for Windows browser-proc cleanup; no gap found.
