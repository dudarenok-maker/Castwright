# Design: size analyzer requests to the model's token limits (#1682)

_Date: 2026-07-17 · Issue: [#1682](https://github.com/dudarenok-maker/Castwright/issues/1682) · Status: approved_

## Problem

The analyzer sends cloud (Gemini/Gemma) requests whose input exceeds the
free-tier's per-minute input-token allowance, so they 429 on the first call and
every chapter is dropped. Observed on `gemma-4-31b-it` / `gemma-4-26b-a4b-it`
with a free-tier key:

```
❌ Chapter 1/9 cast FAILED — Gemini gemma-4-31b-it daily quota exhausted
   Quota exceeded for metric: generate_content_free_tier_input_token_count, limit: 16000
```

A single stage-1 Russian chapter is ~23,964 chars ≈ 12–16k tokens — at/over the
free tier's **16,000 input-tokens/minute** ceiling. Three interacting root
causes, plus a fourth (local, weaker-evidence) symptom the user asked to include.

## Root causes

| # | Where | Bug |
|---|---|---|
| RC1 | `server/src/analyzer/stage1-chunk.ts:56`, `stage2-chunk.ts:63` | Cloud path never sizes chunks to an input-token cap (returns `MAX_SAFE_INTEGER` / the full configured budget). A whole ~24k-char Russian chapter → ~12–16k tokens in one request. |
| RC2 | `server/src/analyzer/rate-limit.ts:41-42` + `server/src/config/registry.ts:867` | Gemma's built-in TPM is `Infinity` (registry default `0` = unlimited). Google now enforces **16k input-tokens/min** on the free tier, so the limiter never paces Gemma. |
| RC3 | `server/src/analyzer/gemini.ts:591` | Daily-quota regex `/free[_-]?tier\|quotaValue":"\d{1,3}"/i` matches the *per-minute* error `...free_tier_input_token_count, limit: 16000` → thrown as `DailyQuotaExhaustedError` (no retry) → chapter dropped instead of paced/retried. |
| RC4 | local Ollama path | Verbose Qwen-9b output overflows `num_ctx` → truncates → drops chapters. Weaker evidence: no concrete trace, only the symptom. |

## Non-goals

- The output-heavy pass (`analyzer.gemini.outputHeavyChunkChars`, 32000 — script
  review / emotion / instruct) is not in the observed failure and has its own
  force-split. Left untouched.
- No new rate-limiter mechanics; the existing TPM sliding window already paces —
  it only needs a real (finite) cap and a guarantee no single request exceeds it.
- Tier is modeled by config, not by auto-detection of the key's plan.

## Design

### Fix 1 — Cloud per-request chunk sizing

Add a per-request input-token cap knob `analyzer.gemini.maxInputTokensPerRequest`
(default **12000** — sits under the 16k TPM with ~4k headroom for the system
prompt + the estimator's flat margin).

`stage1ChunkBudgetForEngine` / `stage2ChunkBudgetForEngine` gain a cloud branch
that converts that token cap into a **char budget for the specific body**, by
measuring the body's script mix (Cyrillic / CJK fraction — reusing the same
counters `estimateInputTokens` uses, `gemini.ts:904`) and applying a
**conservative, pessimistic** chars-per-token ratio:

`charBudget = maxInputTokens × sizingRatio(body)`.

**Why not reuse the estimator's own ratio (Latin 4 / Cyrillic 2.5 / CJK 1.2):**
the estimator optimizes for *average* accuracy and is reconciled post-hoc against
`usageMetadata.promptTokenCount`, so it can afford to run slightly optimistic.
The observed failing chapter — 23,964 chars ≈ 12–16k tokens → **~1.5 chars/token**
for Russian — is *denser* than the estimator's 2.5, i.e. the estimator
under-counts dense scripts by ~30–40%. Sizing gets **no second chance**: a chunk
sized too large 429s on every attempt (there is no smaller-retry for a
per-minute cap the way there is for output truncation). So sizing uses its own
pessimistic constants — roughly **Latin 3.5 / Cyrillic 1.5 / CJK 1.0**
chars-per-token — derived from the worst-case observed density, not the reconciled
average. A Russian chapter then gets a ~18k-char budget, an English one ~42k —
each targeting ≈ `maxInputTokens` *real* tokens with margin under TPM. Erring
small just means more (cheap, RPM-generous) calls.

The existing splitters (`splitBodyIntoChunks` → `splitParagraphIntoSentences`)
do the actual splitting; the adaptive re-split in `runStage{1,2}ChapterChunked`
stays as the backstop for a residual overflow.

- Stage-1 stops returning `Number.MAX_SAFE_INTEGER` for cloud; it chunks against
  the token-derived budget like local does.
- Stage-2 stops returning the full configured budget unchanged for cloud; it
  takes the `min(configured, token-derived)`.

**Headroom note:** the cap is the *body* budget. `estimateInputTokens` adds the
system instruction + a flat +1,000 margin on top, so `maxInputTokensPerRequest`
(12000) must stay below TPM (16000) by more than the scaffolding cost — 4k of
headroom covers it. Documented in the knob's help text.

### Fix 2 — Rate-limit TPM pacing (Gemma free tier)

Change Gemma's built-in TPM `Infinity → 16000` in `BUILTIN_LIMITS`
(`rate-limit.ts`) and the `rate.tpm.gemma` registry default `0 → 16000`, updating
the help text: "free-tier input-tokens/min; set 0 for paid/unlimited." Paid keys
override via the existing `GEMINI_TPM_GEMMA_4_31B_IT` env (or set 0). No new
limiter code — the TPM window already paces; it just needs a finite cap. Fix 1
guarantees no single request exceeds the cap, so the limiter can actually satisfy
it (an over-cap single request would otherwise stall on `computeTpmWait`'s 60s
soft cap and fail).

`gemma-4-26b-a4b-it` gets the same TPM correction (it shares the free-tier 16k).

### Fix 3 — 429 classification (per-minute ≠ daily)

Narrow the daily-quota matcher in `gemini.ts` so it only fires on genuinely
**daily** markers (`per[_-]?day` / `requests?_per_day` / `PerDay`; keep the
`quotaValue":"\d{1,3}"` small-value heuristic that catches Flash's RPD=20). Drop
the broad `free[_-]?tier` alternative — "free_tier" appears in *both* the daily
and the per-minute metric names, which is the entire bug. The per-minute
`input_token_count` 429 then falls through to the existing `retryDelay`/backoff
retry path (`gemini.ts:596-608`). The limiter's own proactive RPD guard
(`rate-limit.ts:174`) stays the primary daily gate; this regex is only the
backstop for a Google 429 that beats our bookkeeping.

### Fix 4 — Local Qwen-9b overflow (knob + on-box calibration)

No concrete Qwen-9b trace is available — only the symptom. The local budget
already reserves ~70% of `num_ctx` for output
(`stage2 = numCtx × 2 × 0.3`, `stage1 = numCtx × 0.7 × 2`); a thinking-heavy
model blows past even that. Rather than guess a shipped default blind, **expose
the input-reservation fraction as config knobs**:

- `analyzer.stage2.localInputFraction` (default **0.3**, current behavior)
- `analyzer.stage1.localInputFraction` (default **0.7**, current behavior)

`stage{1,2}ChunkBudgetForEngine` read the fraction instead of the hardcoded
constant. Shipped defaults are unchanged (no regression for existing local
models); the user **calibrates the Qwen-9b value on the box** against a real
truncation trace. This is a deliberate, acknowledged limitation — the mechanism
ships now, the tuned number is set after on-box measurement.

## Config knobs

| Key | Default | Change | Purpose |
|---|---|---|---|
| `analyzer.gemini.maxInputTokensPerRequest` | 12000 | new | Cloud per-request input-token cap. |
| `rate.tpm.gemma` | 0 → **16000** | changed default | Free-tier input-tokens/min reality. |
| `analyzer.stage2.localInputFraction` | 0.3 | new | Local input reservation (Qwen tuning). |
| `analyzer.stage1.localInputFraction` | 0.7 | new | Local input reservation (Qwen tuning). |

All go through `server/src/config/registry.ts` with a `config:sync` in the same
commit. `BUILTIN_LIMITS` for `gemma-4-31b-it` / `gemma-4-26b-a4b-it` change from
`Infinity` to `16000` in the same change.

## Testing

- **`stage1-chunk` / `stage2-chunk`** — cloud body now splits to ≤ cap tokens; a
  Cyrillic body gets a tighter char budget than an equal-length Latin body
  (script-aware); `localInputFraction` knob lowers the local budget.
- **`rate-limit`** — Gemma with TPM=16000 paces a second request instead of
  firing it back-to-back; a request sized under the cap acquires; the over-cap
  stall path is no longer reachable given Fix 1.
- **`gemini`** — regression test: a per-minute `input_token_count` 429 **retries**
  (asserts it is not a `DailyQuotaExhaustedError`); update the existing
  daily-quota test (`gemini.test.ts:494`, currently a generic `free_tier`
  message) to use a genuinely-daily (`PerDay`) message; keep a daily test that
  still throws `DailyQuotaExhaustedError`.
- **Regression plan** — update `docs/features/archive/06-analyzer-gemini.md`
  (its limits table cites the Gemma TPM as Unlimited).

## Acceptance

- A free-tier cloud Gemma analysis of a large book **completes** (throttled/slow)
  instead of dropping every chapter on the first 429.
- No request exceeds the configured per-request token cap.
- Paid-tier keys raise the cap (`maxInputTokensPerRequest`) and TPM
  (`GEMINI_TPM_GEMMA_4_31B_IT=0`) via config and run at full speed.
- Local `localInputFraction` knobs exist for Qwen-9b on-box calibration; shipped
  defaults preserve current local behavior.
