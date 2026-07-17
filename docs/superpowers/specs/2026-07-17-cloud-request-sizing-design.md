# Design: size analyzer requests to the model's token limits (#1682)

_Date: 2026-07-17 · Issue: [#1682](https://github.com/dudarenok-maker/Castwright/issues/1682) · Status: approved (revised twice from adversarial review + run logs)_

## Problem

The analyzer sends cloud (Gemini/Gemma) requests whose input exceeds the
free-tier's per-minute input-token allowance, so they 429 and chapters are
dropped. Observed on `gemma-4-31b-it` with a free-tier key:

```
* Quota exceeded for metric: generate_content_free_tier_input_token_count, limit: 16000, model: gemma-4-31b
  quotaId: "GenerateContentInputTokensPerModelPerMinute-FreeTier"   retryDelay: "49s"
```

The free tier enforces **16,000 input-tokens/minute**. The failing request was
**46,014 chars** (`userTurnLength`, `logs/server.err.log:1260`) and its
`userTurnHead` is **`task: script-review`** (`:1263`) — a cast roster (~14k
chars) plus a ~32k-char sentence chunk. **All 22 gemini failures in the log are
`task: script-review`; none are stage-1 or stage-2** — so the observed failure is
an *output-heavy* pass, which the first draft of this spec wrongly scoped out.

## Root causes

| # | Where | Bug |
|---|---|---|
| RC1 | `stage1-chunk.ts:56/62` (`MAX_SAFE_INTEGER`), `stage2-chunk.ts:63` (full budget), **`chapter-chunker.ts:101-103`** (`outputHeavyChunkChars`=32000, fixed) | No cloud pass sizes its request to an input-token cap. Stage-1 never chunks; stage-2 keeps the full char budget; the **output-heavy passes** (script-review / annotate-emotion / instruct) use a fixed 32k-char budget with no token awareness *and* prepend the full cast roster — the actually-observed 46k-char / >16k-token 429. |
| RC2 | `rate-limit.ts:41-42` + `registry.ts:867` | Gemma's built-in TPM is `Infinity` (registry default `0` = unlimited). Google now enforces 16k input-tokens/min free-tier, so the limiter never paces Gemma. |
| RC3 | `gemini.ts:591` **and** `routes/failure-taxonomy.ts:113` (raw) + `:414` (message) | Daily-quota regex `/free[_-]?tier\|quotaValue":"\d{1,3}"/i` matches the *per-minute* metric `...free_tier_input_token_count` → classified fatal daily-quota (no retry) → chapter dropped. **Three sites.** |
| RC4 | local Ollama stage-2 | Verbose stage-2 output overflows `num_ctx` → truncates. Confirmed: `done_reason=length bytes=71681 model=qwen3.5:4b`, `bytes=60549 model=gemma4-e4b-8gb`. |
| RC5 | `rate-limit.ts:169` `acquire()` | If a single request's estimate exceeds the TPM cap, `acquire()`'s `while(true)` loop spins on `computeTpmWait`'s 60000 ms soft-cap **forever** (`MAX_TOTAL_MS` is checked between attempts, never during `acquire()`). Latent today (Gemma TPM=∞); **activated by Fix 2** into a hang unless guarded. |

## Evidence (`logs/server.{log,err.log}`, verified)

- **The failing request is `task: script-review`**, `userTurnLength: 46014`,
  `quotaId: …PerModelPerMinute-FreeTier`, `retryDelay: 49s`
  (`server.err.log:1259-1263`). 22/22 gemini failures are script-review.
- **Density is bounded, not measured.** `46014 chars > 16000 tokens` gives only
  an **upper bound of ≤ 2.88 chars/token** — consistent with the estimator's 2.5
  *and* with the issue's 1.5 (46014/1.5 ≈ 30.7k, also > 16k). The 429 returns no
  `usageMetadata.promptTokenCount`, so **no ratio is confirmed**. The design must
  be robust to this uncertainty, not calibrated to a specific ratio.
- **Local truncations are stage-2 output overflow** (`done_reason=length`,
  ~54–71 KB output). Output scales with section size, so a smaller input section
  yields smaller output — the Fix 4 lever is valid. `server.log:1223-1226` shows
  `phase=1` (stage-2) coverage collapse on qwen, consistent.
- Local stage-1 already chunks fine (sections 14k–24k chars in the logs).

## Non-goals

- **Auto-detecting** the key's plan/tier — tier is modeled by config.
- Changing the output-heavy passes' *output*-cap logic (`outputHeavyChunkChars`
  still bounds per-sentence output); we only add an *input*-cap min() on top.
- The Whisper/ASR and TTS paths — unrelated.

## Design

### Fix 1 — Token-cap sizing for every cloud pass

Add a per-request input-token cap knob `analyzer.gemini.maxInputTokensPerRequest`
(default **12000** — under the 16k TPM with headroom for scaffolding). Introduce a
shared helper that converts the cap into a char budget for a given text using the
**existing** script-aware ratio (extract the char↔token conversion out of
`estimateInputTokens`, `gemini.ts:904`, into `charsPerTokenForText(text)`, reusing
its `countCyrillic`/`countCjkChars` counters). `charBudget = maxInputTokens ×
charsPerTokenForText(body)`.

Apply it at **all three** cloud sizing seams:

1. **Stage-1** — `stage1ChunkBudgetForEngine` *and* `resolveStage1ChunkCharBudget`
   (`stage1-chunk.ts:56,62`) stop returning `MAX_SAFE_INTEGER` for cloud; they
   chunk against the token-derived budget.
2. **Stage-2** — `stage2ChunkBudgetForEngine` (`:63`) takes
   `min(configured, token-derived)` for cloud.
3. **Output-heavy** — `chapterChunkBudget('gemini')` (`chapter-chunker.ts:103`)
   returns `min(outputHeavyChunkChars, token-derived)`. **Critically, the request
   also carries the cast roster + context sentences**, which are fixed per-call
   overhead — so the *core* budget must be `token-derived − roster − context −
   system` (subtract the measured roster/context length), not the raw cap. That
   overhead is what turned a 32k core into the 46k failing request. The roster
   length is known at call-build time; the plan wires it into the budget.

**The safety margin is the cap + Fix 5, not a precise ratio.** Because density is
only bounded (≤2.88), we do not trust an exact chars/token. The cap (12000) sits
4k under TPM to absorb the estimator's error + scaffolding; Fix 5 catches any
residual so a mis-size fails loudly instead of hanging. Erring small just means
more (cheap, RPM-generous, TPM-paced) calls. Sizing has no re-split fallback for a
per-minute 429 — the adaptive re-split fires only on `AnalyzerTruncatedError`
(output truncation), **not** on an input 429 — which is exactly why Fix 5 exists.

### Fix 2 — Rate-limit TPM pacing (Gemma free tier)

Gemma built-in TPM `Infinity → 16000` in `BUILTIN_LIMITS` (both `gemma-4-31b-it`
and `gemma-4-26b-a4b-it`); `rate.tpm.gemma` registry default `0 → 16000` (help:
"free-tier input-tokens/min; 0 = paid/unlimited"). **Add a registry TPM knob for
`gemma-4-26b-a4b-it`** (`rate.tpm.gemma26` → `GEMINI_TPM_GEMMA_4_26B_A4B_IT`) so a
paid 26b user can lift it via config, not only env. This is **only safe once Fix 1
sizes every pass and Fix 5 guards the loop** — otherwise it converts today's 429
drops into hangs (RC5).

**Preserve the `0 = unlimited` sentinel explicitly.** Today `0`/unset resolves to
unlimited *only because* `BUILTIN_LIMITS.tpm` is `Infinity` and `readEnvNumber`
maps `0 → undefined → builtin` (`rate-limit.ts:51-67`). Once the builtin is a
finite 16000, `0` would resolve to 16000 and silently break "unlimited" for paid
users. So `resolveLimits`/`readEnvNumber` must treat an explicit `0` (and
`"unlimited"`) as `Infinity` directly, independent of the builtin — the sentinel
becomes real, not an accident of the fallback.

### Fix 3 — 429 classification (per-minute ≠ daily), all three sites

Fix all three sites (`gemini.ts:591`, `failure-taxonomy.ts:113` raw, `:414`
message). **Discriminate on the `per_day` marker in `error.message`** — the
genuine-daily fixture (`failure-taxonomy.test.ts:341`,
`generate_requests_per_model_per_day_free_tier`) has **no `quotaId`**, so the
surviving daily signal is the snake-case `per_day` metric substring, *not* the
camelCase `PerDay` quotaId. Match daily on `/per[_-]?day/i` (keep the
`quotaValue":"\d{1,3}"` heuristic for Flash RPD=20) and **drop the
`free[_-]?tier` alternative** — that substring is in both daily and per-minute
metric names, which is the bug. The per-minute `input_token_count` message
contains neither `per_day` nor `minute`, so it correctly falls through to
retry / `analyzer-rate-limit`.

Each site sees a different input (typed error / raw string / parsed message), so
each gets its own regression test from the real envelopes. Known-latent, left
unfixed (noted, not introduced): the `\d{1,3}` heuristic also matches an RPM
429's small `quotaValue` — not triggered here (16000 is 5 digits) and RPM is
gated proactively.

### Fix 4 — Local stage-2 output overflow (knob + on-box calibration)

Trace-backed output overflow on `qwen3.5:4b` / `gemma4-e4b-8gb`. Expose the
input-reservation fraction as knobs so the section (and thus its output) can be
shrunk without a code change:

- `analyzer.stage2.localInputFraction` (default **0.3**, current behavior)
- `analyzer.stage1.localInputFraction` (default **0.7**, current behavior)

`stage{1,2}ChunkBudgetForEngine` read the fraction instead of the hardcoded
constant. Shipped defaults unchanged; the user **calibrates on the box** against
the trace. The adaptive re-split already fires on these `AnalyzerTruncatedError`s;
the knob reduces how often/deep it must recurse. (Caveat: script-review-*local*
also delegates to `resolveStage1ChunkCharBudget('local')`, so some local
truncations may be script-review rather than stage-2 — the same num_ctx-derived
budget covers both.)

### Fix 5 — `acquire()` fail-fast guard (no more hang)

In `GeminiRateLimiter.acquire()`, before the wait loop, if `estimatedTokens`
exceeds the model's TPM cap (a request that can *never* fit), **throw a clear
error immediately** instead of spinning on the 60s soft-cap forever. Fail-fast
turns a mis-size / denser-than-expected book / misconfigured cap into a visible,
classifiable failure (`analyzer-rate-limit` or a dedicated "request too large for
tier — lower maxInputTokensPerRequest" message) rather than a silent hang. With
correct Fix 1 sizing this never fires; it is the backstop that makes Fix 2 safe.

## Config knobs

| Key | Default | Change | Purpose |
|---|---|---|---|
| `analyzer.gemini.maxInputTokensPerRequest` | 12000 | new | Cloud per-request input-token cap (all passes). |
| `rate.tpm.gemma` | 0 → **16000** | changed default | Free-tier input-tokens/min (31b). |
| `rate.tpm.gemma26` | 16000 | new | Free-tier TPM knob for `gemma-4-26b-a4b-it`. |
| `analyzer.stage2.localInputFraction` | 0.3 | new | Local input reservation (Qwen tuning). |
| `analyzer.stage1.localInputFraction` | 0.7 | new | Local input reservation (Qwen tuning). |

`BUILTIN_LIMITS` for both Gemma models change `Infinity → 16000`. All new registry
keys ship with a `config:sync` in the same commit. Fix 5 has no knob (behavioral).
`outputHeavyChunkChars` (32000) is unchanged but now min()'d with the token cap.

## Testing

- **`stage1-chunk` / `stage2-chunk`** — cloud body splits to ≤ cap tokens;
  Cyrillic body gets a tighter char budget than an equal-length Latin body;
  `localInputFraction` knob lowers the local budget.
- **`chapter-chunker`** — `chapterChunkBudget('gemini')` returns the token-capped
  min; a large-roster call sizes the core smaller so total input stays ≤ cap
  (regression for the 46k-char script-review case).
- **`rate-limit`** — Gemma TPM=16000 paces a second request; **an over-cap single
  request fails fast (Fix 5) rather than looping** (assert it throws promptly, not
  after N×60s); both Gemma models correctable via their env/registry knobs.
- **`gemini`** — real per-minute envelope (`…PerMinute`, `retryDelay 49s`) →
  retries (not `DailyQuotaExhaustedError`); the daily test switches to a `per_day`
  message and still throws.
- **`failure-taxonomy`** — both the raw path (`:113`) and message path (`:414`):
  per-minute → `analyzer-rate-limit`; `per_day` → `analyzer-daily-quota` (existing
  `:341` fixture stays green).
- **Regression plan** — update `docs/features/archive/06-analyzer-gemini.md`
  (limits table cites Gemma TPM as Unlimited).

## Acceptance

- A free-tier cloud analysis of a large book (incl. its script-review pass)
  **completes** throttled/slow, and **never hangs**.
- No cloud request's estimate exceeds TPM; every pass (stage-1/2 + output-heavy)
  sizes its *core* to `maxInputTokensPerRequest` after subtracting fixed per-call
  overhead (roster/context/system).
- An over-cap request fails fast with a clear message (Fix 5), never spins.
- A per-minute 429 is retryable at all three sites; only `per_day` is fatal.
- Paid-tier keys raise the cap and TPM (both Gemma models) via config/env and run
  at full speed.
- Local `localInputFraction` knobs exist for on-box Qwen calibration; shipped
  defaults preserve current local behavior.

## Known tradeoff (surfaced, not hidden)

With TPM=16000 and each request ~12–14k tokens, the free tier admits roughly **one
analyzer request per minute** (two 12k reservations can't co-exist in a 16k
window). A 9-chapter book with multiple passes is an **~tens-of-minutes** floor on
free-tier Gemma — correct behavior (the alternative is dropped chapters), but slow.
Paid keys (higher TPM) remove the floor. The UI already surfaces throttle waits.
