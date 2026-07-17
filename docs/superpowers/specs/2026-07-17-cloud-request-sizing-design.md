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
| RC3 | `server/src/analyzer/gemini.ts:591` **and** `server/src/routes/failure-taxonomy.ts:113` (raw) + `:414` (message) | Daily-quota regex `/free[_-]?tier\|quotaValue":"\d{1,3}"/i` matches the *per-minute* error `...free_tier_input_token_count, limit: 16000` → classified `DailyQuotaExhaustedError` / `analyzer-daily-quota` (fatal, no retry) → chapter dropped instead of paced/retried. **Three sites**, not one. |
| RC4 | local Ollama path | Verbose stage-2 output overflows `num_ctx` → truncates → chapters drop. Confirmed in logs: `done_reason=length bytes=71681 model=qwen3.5:4b`, `bytes=60549 model=gemma4-e4b-8gb`. |

## Evidence (from `logs/server.{log,err.log}`, 16 July runs)

Hard data the design is calibrated to — not the issue's estimates:

- **The failing gemini stage-1 request was `userTurnLength: 46014` chars and
  exceeded the 16,000 input-token limit** ⇒ **≤ 2.88 chars/token** for this
  Russian text, consistent with the estimator's Cyrillic `2.5` (46014 / 2.5 ≈
  18,406 tokens > 16,000). The issue's "23,964 chars ≈ 12–16k tokens" (⇒ ~1.5)
  was a guess and is **contradicted** by this measurement. **Sizing therefore
  reuses the estimator's ratios**, not a denser fabricated constant.
- **Gemini stage-1 sent the whole 46k-char chapter as one request** — it never
  chunked (RC1). Local stage-1, by contrast, *did* chunk (sections 14k–24k
  chars, `"large chapter, section N/M …"`).
- **The real 429 envelope** carries
  `quotaId: "GenerateContentInputTokensPerModelPerMinute-FreeTier"`,
  `retryDelay: "49s"`, `quotaValue: "16000"` — the `PerMinute` marker is the
  reliable daily-vs-per-minute discriminator.
- **Local truncations are output overflow** (`done_reason=length`, ~54–71 KB
  output ≈ 24k+ tokens). Output scales with the stage-2 section size, so a
  smaller input section yields smaller output — the Fix 4 lever works.

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
measuring the body's script mix and applying the estimator's chars-per-token
ratio: `charBudget = maxInputTokens × charsPerToken(body)`.

**Reuse the existing estimator, don't invent a new ratio.** `estimateInputTokens`
(`gemini.ts:904`) already interpolates a divisor between Latin 4 / Cyrillic 2.5 /
CJK 1.2 by measuring each script's character fraction, and reconciles against
`usageMetadata.promptTokenCount`. The 16 July logs confirm it is accurate for
this workload (46,014-char Russian request > 16,000 tokens ⇒ ~2.5 chars/token).
So factor the char↔token conversion out of `estimateInputTokens` into a shared
helper (e.g. `charsPerTokenForText(text): number` — exporting/extracting the
`countCyrillic` / `countCjkChars` counters it already uses) and have both the
estimator and the chunk sizers call it. A Russian chapter then gets a ~30k-char
budget (splitting the 46k failing chapter into 2 chunks of ~23k chars ≈ 9k tokens
each — under the 12k cap), an English one ~48k — each ≤ `maxInputTokens` tokens.

**The safety margin is the cap, not a pessimistic ratio.** The cap (12000) sits
4,000 tokens under TPM (16000); that gap absorbs the system instruction + the
estimator's flat +1000 + any residual under-count. Sizing gets **no second
chance** for a per-minute cap — the adaptive re-split fires only on
`AnalyzerTruncatedError` (output truncation), **not** on an input-token 429 — so
the cap must be genuinely conservative. Erring small just means more (cheap,
RPM-generous, TPM-paced) calls.

The existing splitters (`splitBodyIntoChunks` → `splitParagraphIntoSentences`)
do the actual splitting.

- Stage-1 stops returning `Number.MAX_SAFE_INTEGER` for cloud; it chunks against
  the token-derived budget like local does. **Both** `stage1ChunkBudgetForEngine`
  *and* its caller `resolveStage1ChunkCharBudget` (which has its own
  `engine !== 'local' → MAX_SAFE_INTEGER` early return, `stage1-chunk.ts:62`)
  must change.
- Stage-2 stops returning the full configured budget unchanged for cloud; it
  takes the `min(configured, token-derived)`.

**Why chunking is load-bearing (not just an optimization):** after Fix 2 sets
Gemma's TPM to a finite 16000, an un-chunked 46k-char chapter estimates ~18k
tokens > TPM, and `GeminiRateLimiter.acquire()` (a `while(true)` loop,
`rate-limit.ts:169`) then spins on `computeTpmWait`'s 60000 ms soft-cap
**forever** — `MAX_TOTAL_MS` is only checked *between* attempts, never during an
`acquire()`. So without Fix 1, Fix 2 turns the drop into a **hang**. Fix 1 is
what keeps every request's estimate under TPM.

**Headroom note:** the cap is the *body* budget. `estimateInputTokens` adds the
system instruction + a flat +1,000 margin on top, so `maxInputTokensPerRequest`
(12000) stays below TPM (16000) by more than the scaffolding cost — 4k of
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

### Fix 3 — 429 classification (per-minute ≠ daily), all three sites

The daily-quota misclassification lives at **three** sites that all use the same
`/free[_-]?tier|quotaValue":"\d{1,3}"/i` regex; fixing only `gemini.ts` moves the
bug downstream (a per-minute 429 that exhausts `gemini.ts`'s 3 retries then
propagates raw to the route and is re-classified fatal there):

1. `server/src/analyzer/gemini.ts:591` — decides retry vs `DailyQuotaExhaustedError`.
2. `server/src/routes/failure-taxonomy.ts:113` — `match(raw, ctx)` → `analyzer-daily-quota` (`fatal: true`).
3. `server/src/routes/failure-taxonomy.ts:414` — `statusToFailureCode(status, message)` → `analyzer-daily-quota`.

**Discriminate on the real marker.** The captured 429 envelope carries
`quotaId: "GenerateContentInputTokensPerModelPerMinute-FreeTier"` — the
`PerMinute` / `PerDay` suffix is the reliable signal, and the genuine-daily
fixture is `generate_requests_per_model_per_day_free_tier`
(`failure-taxonomy.test.ts:341`, which contains `per_day`). So each site matches
daily on `/per[_-]?day|PerDay/i` (keeping the `quotaValue":"\d{1,3}"` small-value
heuristic for Flash RPD=20) and **drops the `free[_-]?tier` alternative** — that
substring appears in *both* the daily and per-minute metric names, which is the
entire bug. A per-minute `input_token_count` 429 then falls through to
`gemini.ts`'s `retryDelay`/backoff path (`gemini.ts:596-608`) and, if it ever
reaches the route, to `analyzer-rate-limit` (non-fatal) rather than
`analyzer-daily-quota`.

Each site sees a *different* input (typed error / raw string / parsed envelope
message), so the three fixes aren't copy-paste — each gets its own regression
test built from the real envelope above. The limiter's proactive RPD guard
(`rate-limit.ts:174`) stays the primary daily gate; these regexes are only the
backstop for a Google 429 that beats our bookkeeping.

**Note — a latent per-minute false-positive stays:** the `quotaValue":"\d{1,3}"`
heuristic also matches an *RPM* 429's small `quotaValue` (e.g. `"15"`). Not
triggered by this issue (the input-token limit `16000` is 5 digits), and RPM is
gated proactively by the limiter, so we leave it — but it is noted, not fixed.

### Fix 4 — Local stage-2 output overflow (knob + on-box calibration)

Now trace-backed (Evidence section): `done_reason=length` truncations with
~54–71 KB of **output** on `qwen3.5:4b` / `gemma4-e4b-8gb` (the issue's
"Qwen-9b"). This is a **stage-2** problem — stage-2 re-emits per-sentence JSON,
so output scales with the section size, and a large Cyrillic section's output
(~24k+ tokens) plus its input overflows `num_ctx` (32768). Local **stage-1**
already chunks correctly (14k–24k-char sections in the logs), and its roster
output is tiny — so stage-1 is not the culprit, though we expose its knob too for
symmetry.

The lever is valid *because* output ∝ input for stage-2: a smaller input section
yields smaller output. The local budget reserves 30% of `num_ctx` for input
(`stage2 = numCtx × 2 × 0.3`, `stage1 = numCtx × 0.7 × 2`); for these ~20k-char
sections that reservation is marginally too high. Rather than guess a shipped
default blind, **expose the input-reservation fraction as config knobs**:

- `analyzer.stage2.localInputFraction` (default **0.3**, current behavior)
- `analyzer.stage1.localInputFraction` (default **0.7**, current behavior)

`stage{1,2}ChunkBudgetForEngine` read the fraction instead of the hardcoded
constant. Shipped defaults are unchanged (no regression for existing local
models); the user **calibrates the value on the box** against the real truncation
trace above. Deliberate, acknowledged limitation: the mechanism ships now, the
tuned number is set after on-box measurement. (The adaptive re-split *does* fire
on these `AnalyzerTruncatedError`s — the knob reduces how often it must, and how
deep it recurses before the section fits.)

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
- **`gemini`** — regression test built from the real per-minute envelope
  (`quotaId: …PerMinute-FreeTier`, `retryDelay: 49s`): it **retries** (asserts it
  is not a `DailyQuotaExhaustedError`); update the existing daily-quota test
  (`gemini.test.ts:494`, currently a generic `free_tier` message) to a genuinely
  `PerDay` message and keep it throwing `DailyQuotaExhaustedError`.
- **`failure-taxonomy`** — regression tests for *both* the raw-string path
  (`:113`) and the message path (`:414`): a per-minute envelope → `analyzer-rate-limit`
  (non-fatal), a `per_day` envelope → `analyzer-daily-quota` (the existing
  `failure-taxonomy.test.ts:341` daily fixture stays green).
- **Regression plan** — update `docs/features/archive/06-analyzer-gemini.md`
  (its limits table cites the Gemma TPM as Unlimited).

## Acceptance

- A free-tier cloud Gemma analysis of a large book **completes** (throttled/slow)
  instead of dropping every chapter on the first 429, and never **hangs**.
- No request's total input tokens exceed **TPM** (16000); each chunk's *body* is
  sized to `maxInputTokensPerRequest` (12000), leaving headroom for scaffolding.
  (The cap bounds the body, not the whole request — the two differ by the system
  prompt + margin.)
- A per-minute 429 is classified retryable at all three sites; only a `PerDay`
  quota is fatal.
- Paid-tier keys raise the cap (`maxInputTokensPerRequest`) and TPM
  (`GEMINI_TPM_GEMMA_4_31B_IT=0`) via config and run at full speed.
- Local `localInputFraction` knobs exist for Qwen-9b on-box calibration; shipped
  defaults preserve current local behavior.
