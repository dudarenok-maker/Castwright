---
status: active
shipped: null
owner: null
---

# 173 — Structured failure taxonomy + plain-language remediation (fs-19)

> Status: active — automated coverage green; live multi-failure acceptance owed.
> Key files: `server/src/routes/failure-taxonomy.ts`, `server/src/routes/generation-error.ts`, `server/src/routes/generation.ts`, `src/store/generation-stream-runner.ts`, `src/views/generation.tsx`, `src/lib/types.ts`
> URL surface: `#/books/<id>/generate` (error rows + toasts)
> OpenAPI ops: none new — adds a `FailureCode` enum + two optional chapter / tick fields

## Benefit / Rationale

- **User:** a failed chapter shows a jargon-free message + a "what to do next" line (restart the sidecar, free VRAM, wait out the rate-limit) instead of a raw stack/`fetch failed` string. Self-service recovery; fewer "it just failed" dead-ends.
- **Technical:** one ordered signature table is the single place recurring failure modes are recognised — replaces the ad-hoc regexes that had drifted into `describeSynthesisError`.
- **Architectural:** the `chapter_failed` SSE tick + persisted `state.json` chapter now carry a stable machine `code`, so downstream surfaces (the fe-29 help panel) can key on it rather than re-parse English.

## Architectural impact

- **New module** `failure-taxonomy.ts`: `FailureCode` union, `FailureSignature` (ordered, first-match-wins), `classifyFailure(err, engine?) → { code, userMessage, remediation, fatal, raw? }`.
- `describeSynthesisError` now **delegates** to `classifyFailure` and still returns `{ errorReason, fatal }` (with `errorReason === userMessage`) so every existing caller is untouched; it additionally exposes `code` + `remediation`.
- `generation.ts` catch block persists `generationErrorCode` + `generationRemediation` on the failed chapter and includes them on the `chapter_failed` broadcast; the success path clears them.
- **Invariants preserved:** the incident-tuned regexes (timeout, 429/quota, XTTS index-out-of-range, CUDA device-side assert) are ported **verbatim** — see plan 154's narrow-quota fix, which this must not regress. Unknown errors fall back to the trimmed raw string + a generic remediation, `fatal:false`.
- **Reversibility:** the two new fields are optional and additive; reverting the module leaves the legacy `{errorReason,fatal}` contract intact.

## Invariants to preserve

1. `FAILURE_SIGNATURES` is **ordered**; the timeout / non-fatal classifications are matched before the broad quota match (plan 154 regression — `rate` must not match inside "degenerate").
2. `describeSynthesisError` keeps returning `{ errorReason, fatal }`; `errorReason === classifyFailure(...).userMessage`.
3. Unknown errors never throw and never mark `fatal:true`.
4. Engine-gating: a local-engine failure is never blamed on Gemini.
5. Analysis-side signatures are `source: 'analysis'` — the generation scan never
   sees them and its match ORDER is byte-identical to the pre-split table.
6. `failure-remediations.ts` imports nothing (the frontend bundles it directly).

## Test plan

- **Automated:** `server/src/routes/failure-taxonomy.test.ts` feeds real captured strings (XTTS tensor error, CUDA device-side assert, a 429 quota body, `ECONNREFUSED`, `ENOSPC`, the synth-timeout message, an unknown string) and asserts exact `code`, a jargon-free `userMessage`, a non-empty `remediation`, and the legacy `fatal`. `generation-error.test.ts` stays green (asserts `errorReason === userMessage`). A `generation-stream-runner` test asserts a `chapter_failed` tick carrying `remediation` surfaces it on the chapter row + toast.
- **Manual:** force a known failure (stop the sidecar mid-run → `sidecar-unreachable`; oversubscribe VRAM → `vram-spill`) and confirm the Generate view shows the friendly message + a "What to do:" line, and the toast matches.

## Ship notes

Shipped on `feat/server-generation-quality` (integration round 2026-06-03), commit `affa489`. Closes #469. Automated server + frontend coverage green via `npm run verify`. **Owed:** live acceptance across ≥2 distinct real failure modes. Analysis-path classification shipped in the fe-29/fs-19 completion round
(spec `docs/superpowers/specs/2026-06-12-help-troubleshooting-fs19-completion-design.md`):
the run-level describeError() unified into `classifyAnalysisFailure` (old codes
truncated/daily_quota/rate_limit/unavailable/internal/invalid_key/bad_request →
FailureCode), per-chapter cast failures + the stage-2 coverage-suspect path now
persist `failedChapterErrors` records, and the analysing view renders
message + remediation live and after reload.
