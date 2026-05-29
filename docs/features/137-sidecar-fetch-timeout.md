---
status: active
shipped: null
owner: null
---

# Sidecar synth fetch has no timeout headroom (300 s undici cap)

The server's HTTP request to the TTS sidecar must not abort a legitimately long
synth. A synth can run for minutes (a wide Qwen batch >5 min); the only valid
cancellation is the caller's `AbortSignal`, never a wall-clock timeout.

## Why

Live testing of plan [136](136-qwen-token-budget-batching.md) at
`QWEN_BATCH_SIZE=64` exposed a **latent server bug** (not a packer problem). On
2026-05-29 a 217-line chapter showed **473 synthesized items across 9 batches
(~2.2× re-synthesis)**, repeated identical `text_len` values, and finally
**"Synthesis failed — Local TTS sidecar not running"** in the UI — while the
sidecar was provably healthy and still computing. The UX was completely
detached from the backend.

**Root cause:** `server/src/tts/sidecar.ts` `post()` used Node's global
`fetch()` with no timeout override, inheriting undici's default **300 s
`headersTimeout`**. The sidecar is non-streaming — it holds the connection open
computing the whole batch before sending response headers. At cap 32, batches
finished in ~130–200 s (< 300 s, fine). At cap 64, batches took **400–454 s
(> 300 s)** → undici aborted the fetch → threw `"fetch failed"` → `post()`
wrapped it as a **`transient: true`** "sidecar not reachable" → the
`withTtsRetry` wrapper **re-synthesized the same batch** (another ~450 s, timed
out again) → loop → retries exhausted → `describeSynthesisError` matched
`/sidecar not reachable|fetch failed/` → **fatal "sidecar not running"** +
chapter `Failed`. The re-synthesis loop produced the 473-items / 217-lines
mismatch and the duplicate `text_len`s — NOT the packer, NOT restarts.

It's undici's internal timeout, not a caller `AbortSignal`: an `AbortSignal`
abort surfaces as `AbortError`, which `post()` re-throws *separately* and would
NOT be classified as "sidecar not running". The "fetch failed" path is the
undici `headersTimeout`.

## What changed

`server/src/tts/sidecar.ts`:
- Import undici's **own** `fetch` + `Agent` (not Node's global fetch + a
  dispatcher) so the dispatcher and the fetch belong to the same undici
  instance — avoids the global-fetch/dispatcher version-mismatch gotcha.
- Module-level `SIDECAR_DISPATCHER = new Agent({ headersTimeout: 0,
  bodyTimeout: 0, connectTimeout: 10_000 })`. `0` disables the wall-clock
  timeouts (synth can take minutes); `connectTimeout` stays short so a
  genuinely-down sidecar still fails fast.
- `post()` calls `undiciFetch(url, { …, signal, dispatcher: SIDECAR_DISPATCHER })`,
  cast back to the global `Response` type (at runtime Node's global `Response`
  *is* undici's `Response`; only the duplicated TS decls differ, on `formData()`
  which we never call). The existing `catch` is unchanged: `AbortError` still
  propagates; a real connection failure still becomes the transient "not
  reachable" — only the spurious *timeout* path goes away.

`undici` added as an explicit `server` dependency (was resolvable transitively;
pinned so the import is guaranteed).

## Invariants to preserve

- **Long synths complete.** A slow-but-alive sidecar (response after minutes) is
  NOT aborted by the server. (Test: FIX case — provider resolves against a
  delayed-header server that trips a short-timeout control.)
- **Genuine sidecar-down still fails fast + transient.** A connection refusal /
  closed port still yields the `transient` "not reachable" error the retry
  wrapper absorbs. (Tests: classification suite + closed-port path.)
- **Caller cancellation still works.** An `AbortSignal` abort yields
  `AbortError`, propagated unchanged (never misclassified as "not running").
  (Test: Abort case.)
- **Scope.** Only the synth POSTs (`/synthesize`, `/synthesize-batch`) route
  through `post()` / the no-timeout dispatcher. The health proxy and other short
  calls stay on global fetch.

## Test plan

`server/src/tts/sidecar.test.ts` (10) — classification contract; switched from
`vi.stubGlobal('fetch')` to `vi.mock('undici')` so it intercepts the provider's
undici fetch (the real `Agent` is preserved so `SIDECAR_DISPATCHER` constructs).

`server/src/tts/sidecar-timeout.test.ts` (3, real `node:http` server) —
CONTROL (a short `headersTimeout` aborts a slow-header response, proving the
failure mode), FIX (the provider with `SIDECAR_DISPATCHER` tolerates the same
slow response), and AbortSignal (cancellation still honoured). Run in the main
`npm run test:server` battery.

## Verification

1. `npm run test:server` — the 13 sidecar tests green.
2. `npm run verify` — full battery.
3. **Live (the real proof):** with this fix, set `QWEN_BATCH_SIZE=64` again and
   regenerate the 217-line CH 10. Batches >300 s now **complete** (no "sidecar
   not running"); the chapter finishes; **segment count == sentence count** (no
   retry-duplication). This is also what makes the plan-136 cap-32-vs-64 A/B
   measurable on a chapter that actually finishes.

## Relationship to plan 136

136's practical batch-width cap was implicitly bounded by this 300 s fetch
limit (per-batch gen time had to stay under it). 137 removes that bound, so
larger caps become viable — though the plan-136 measurements still showed wide
caps are a wash-to-worse on dialogue-dense chapters (padding waste), so the
follow-up lever there remains short-line coalescing, not width.

## Ship notes

_Pending: shipped date + commit SHA on merge._
