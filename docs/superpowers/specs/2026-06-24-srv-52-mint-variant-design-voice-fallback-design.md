---
status: active
issue: 1091
backlog-id: srv-52
area: srv
---

# srv-52 — Mint-variant fallback to design-voice when the 1.7B-Base is unavailable

## Problem

Emotion variants are minted by an **anchored** workflow (fs-55): the sidecar's
`/qwen/mint-variant` decodes the base voice's `ref_code` through the
**Qwen 1.7B-Base** model, re-derives an ICL prompt that preserves the base
speaker's timbre, applies an emotion clause via instruct-synth, then distils the
result into a **0.6B clone prompt** saved as the variant's `.pt`
(`server/tts-sidecar/main.py`, `QwenEngine.mint_variant`).

That workflow hard-requires the 1.7B-Base to be installed and loadable. When it
isn't — weights not downloaded, corrupt, or a load failure (e.g. VRAM OOM on an
8 GB card) — `mint_variant` raises and `/qwen/mint-variant` returns a generic
**500**. The server's `designQwenVoiceForCharacter` surfaces that as a
per-character failure: the variant `.pt` is never written and the variant is not
minted.

### Correcting the issue's stated motivation

Issue #1091 frames the cost as an *"orphaned `.pt` → silent Kokoro fallback on
the next render (the #1057/#1063 class)."* **Code review (2026-06-24) shows that
is not the actual failure mode.** When `mint-variant` throws, the bulk loop
records `job.failures` and **never** reaches `persistEmotionVariant`
(`cast-design.ts:378` is success-only); the single-design route's persist is
likewise after a successful `await` (`qwen-voice.ts:547`+). So **no orphan slot
is written.** At render, a character with no variant for emotion X resolves to
its **neutral base `.pt`** (which exists) — the emotional line simply renders in
the base voice. The true "before" behaviour is *"emotion variants don't ship —
emotional lines lose their emotion,"* **not** a silent wrong-engine Kokoro
fall-through. That is still a degradation worth fixing (the issue's own Benefit
line — "emotion variants still ship instead of breaking" — is the accurate
framing), and the regression test pins this real behaviour, not the orphan story.

### What the fallback actually buys (and its narrow scope)

The fallback routes the variant through `/qwen/design-voice`. **`design_voice`
runs on the 1.7B-*VoiceDesign* model** (`_ensure_design_loaded` →
`self._design.generate_voice_design`), a ~3.4 GB model of comparable size to the
1.7B-Base. So the fallback **does not drop to a 0.6B-only path** — it swaps one
1.7B dependency (Base) for a different 1.7B dependency (VoiceDesign). Whether the
swap helps depends entirely on *why* Base17 was unavailable, which is why srv-52
fires the fallback for only **two** of the three failure causes:

| Base17 failure cause | Will VoiceDesign also fail? | srv-52 behaviour |
|---|---|---|
| **Not installed** (weights absent) | No — VoiceDesign is a separate model with its own weights | **Fall back** |
| **Corrupt** (weights present but won't load: bad/partial download, format error) | No — VoiceDesign weights are independent and likely intact | **Fall back** |
| **OOM** (transient VRAM exhaustion) | **Yes** — VoiceDesign is the same size and would OOM identically | **Do NOT fall back** — fail loudly, no churn |

The genuine win is therefore **narrow** (consistent with the issue's
`moscow:could / low-cost` label): a variant still ships when Base17 is
absent/corrupt but VoiceDesign is fine. Note the standard installer
(`install-qwen3.mjs:72`) *always* pulls 1.7B-Base and makes VoiceDesign the
`--skip-design`-optional one, so "Base17 absent, VoiceDesign present" is the
*opposite* of the common lean install — but it does occur for old/stripped/
partial installs and corrupt-weight cases. **OOM is deliberately excluded**: a
fallback there would just OOM VoiceDesign too, so srv-52 leaves it as the
existing loud per-character failure rather than burning a second 1.7B load.

#### Telling "corrupt" from "OOM"

Both are exceptions raised from loading the Base17 model, so the sidecar must
classify them. A VRAM exhaustion raises a detectable, specific exception
(`torch.cuda.OutOfMemoryError`, or an `"out of memory"` substring for older/CPU
paths); **any other** load exception (missing/partial blob, deserialization /
format error, etc.) is treated as **corrupt**. This is the one heuristic in the
design — if a future failure mode is misclassified, the safe direction is
"corrupt → fall back" (you get a lower-fidelity variant) rather than
"OOM → fall back" (you get a second OOM); the classifier biases toward calling an
ambiguous error *corrupt* only if it is clearly not an OOM.

### What IS safe: the `.pt` file format

Both `mint_variant` and `design_voice` end at the **same** call —
`self._base.create_voice_clone_prompt(...)` on the **0.6B-Base** — and
`torch.save` a 0.6B clone prompt. The render hot path (`generate_voice_clone`)
is **0.6B-only**; the 1.7B models are transient-during-design and never consumed
at render time. So there is **one** `.pt` format, fit for the 0.6B render model,
and a fallback-minted variant is a **format-identical, render-compatible** 0.6B
`.pt` — no orphaning risk at the file level, no second format. Only *fidelity*
differs: the anchored mint preserves the base speaker's actual timbre via
`ref_code` and applies the fs-55 per-emotion gain/temperature tuning in its
instruct-synth; the fallback re-describes the persona from words via plain
`generate_voice_design` (so it gets neither the timbre anchor nor the emotion
gain/temp calibration). That fidelity gap is the explicit, logged trade srv-52
makes.

## Goals

1. When the 1.7B-Base is **not installed or corrupt** (a deterministic problem
   the separate VoiceDesign model won't share), produce a **designed emotion
   variant** via `/qwen/design-voice` (`persona + EMOTION_INSTRUCT[emotion]`)
   instead of a missing variant. A transient **OOM** is *not* a fallback trigger
   — VoiceDesign would OOM too — and stays the existing loud failure. There is
   **no retry**.
2. The fallback is **never silent**: a server log line, a per-character note on
   the bulk Design progress stream, and a durable provenance marker in the
   variant's `.json`.
3. When the 1.7B-Base **is** available, behaviour is byte-for-byte unchanged
   (anchored mint).
4. The fallback applies to **every** caller of `designQwenVoiceForCharacter`
   (the bulk "Emotion variants" job and the single-design/REST `design-voice`
   route — two call sites) via the shared routing function.

## Non-goals

- No new user-facing UI control. The fallback is automatic; the only UI delta
  is the existing Design panel's per-character "via fallback" note.
- No *new* re-mint/upgrade tooling. None is needed: `scripts/remint-anchored-variants.mjs`
  already selects every variant whose `mintMethod !== 'anchored-icl-instruct'`,
  so a fallback variant stamped `mintMethod: "design-voice-fallback"` is
  **automatically eligible** for `remint-anchored-variants.mjs --apply` once the
  1.7B-Base is back. srv-52 just has to use a `__`-suffixed id and a
  non-`anchored-icl-instruct` marker — both of which it already does.
- No inter-retry VRAM-reclaim plumbing (see Known limitations).
- No change to the 0.6B / VoiceDesign / ASR lifecycles.

## Architecture — sidecar decides, server reacts

The sidecar is the only component that truly knows whether the 1.7B-Base is
installed and whether a load **succeeds**. The decision is therefore
**error-driven**: the server attempts the anchored mint and reacts to a
distinct, machine-readable error. This avoids the TOCTOU a health-pre-check
would introduce (health reports "ready", then the load OOMs anyway). A `/health`
capability flag rides along for observability/UI but is **not** on the decision
path.

The fallback logic lives **inside `designQwenVoiceForCharacter`**
(`server/src/routes/qwen-voice.ts`) so every caller (the bulk job + the
single-design/REST route) inherits it identically.

## Detailed design

### Sidecar (`server/tts-sidecar/main.py`)

1. **`_qwen_base17_weights_present() -> bool`** — new module-level helper
   mirroring `_qwen_weights_present()` (line ~3428) but resolving the
   `QwenEngine.BASE17_MODEL` snapshot dir. Same "at least one real weight blob,
   not just metadata" rule, same `OSError`-safe walk.

2. **`/health` gains `qwen_base17_weights_present`** — computed each poll
   (cheap, side-effect-free) alongside the existing `qwen_base17_loaded`.

3. **`/qwen/mint-variant` returns a distinct error when the 1.7B-Base is
   not-installed or corrupt**, replacing the generic 500. Three load-related
   outcomes, classified at the route:
   - **Not installed** — when `_qwen_base17_weights_present()` is false, the
     route short-circuits *before* attempting a load and returns:
     `503 { "code": "base17-unavailable", "reason": "not-installed",
     "detail": "Qwen 1.7B-Base weights are not installed." }`
   - **Corrupt** — a load is attempted and raises a **non-OOM** exception
     (missing/partial blob, deserialization/format error). Surfaced as:
     `503 { "code": "base17-unavailable", "reason": "corrupt",
     "detail": "<exc message>" }`
   - **OOM** — a load is attempted and raises a CUDA OOM
     (`torch.cuda.OutOfMemoryError`, or an `"out of memory"` message substring).
     This is **NOT** a fallback trigger — it keeps the **existing generic 500**
     (a fallback would just OOM VoiceDesign too). The route does not dress it up;
     `mint_variant`'s existing `except Exception → 500` handles it unchanged.

   Implementation: wrap the Base17 load so the route can classify. The cleanest
   seam is to catch the exception around `mint_variant`'s load and re-raise a
   typed `Base17CorruptError` for the non-OOM case (OOM falls through to the
   generic handler). `_ensure_base17_loaded()` is **also** called by the 1.7B
   synth/batch paths — the classification must be **localized to the mint route**
   (catch at the `qwen_mint_variant` handler / a mint-only wrapper), so those
   other callers keep their current behaviour.
   - The existing `VoiceNotDesignedError → 409` (base `.pt` missing) is
     **unchanged** and unrelated to the fallback — a missing base is a real
     error, not a 1.7B-availability problem.

4. **`/qwen/design-voice` accepts optional provenance fields** so a
   fallback-minted variant is honestly stamped. Body may carry:
   - `mintMethod: "design-voice-fallback"`
   - `fallbackFor: { "baseVoiceId": "<id>", "emotion": "<emotion>" }`
   When present, `design_voice` merges them into the manifest `.json` it already
   writes (alongside the existing `voiceId`/`baseModel`/`designModel`). Absent →
   the manifest is written exactly as today (no regression to base design).

### Server (`server/src/routes/qwen-voice.ts`)

1. **Extract `postDesignAndCache(target, body, ...)`** — refactor the existing
   inline "POST to sidecar `target` → handle non-OK → read PCM → encode MP3 →
   write cache → return `{ voiceId, url }`" block (lines ~347–430) into an inner
   helper that takes the resolved `target` URL and the JSON body. Both the
   anchored mint and the fallback design-voice call reuse it verbatim (same
   liveness timer **scoped per call**, abort handling, MP3 cache write). The GPU
   semaphore + `withDesignLock`/`withGpuLoad` are acquired **once** in the outer
   `designQwenVoiceForCharacter` and span the mint attempt and the fallback — so
   the two-call sequence holds a single GPU slot and the fallback never re-queues
   behind other work. Pure refactor — no behaviour change on the happy path.

2. **Typed error carrying status + code.** On a non-OK response,
   `postDesignAndCache` throws a `SidecarDesignError` exposing `.status` and the
   parsed body `.code`/`.reason` (in addition to the human message it already
   builds). Only the **mint** call site inspects it — `err.status === 503 &&
   err.code === "base17-unavailable"` with `reason ∈ {"not-installed",
   "corrupt"}` → fall back. An OOM never reaches this branch (it's a generic 500,
   `code` absent), so it propagates as a loud error. The **fallback** call site
   does *not* catch it, so a VoiceDesign failure also propagates loudly. The
   `SidecarDesignError` message must **not** match `SIDECAR_DOWN_RE`, so the bulk
   job's process-down ride-out loop never mistakes the base17 signal for a
   recycle.

3. **Control flow** (variant case only; `p.emotion` set) — **no retry**:
   1. POST `/qwen/mint-variant` (anchored) via `postDesignAndCache`.
   2. `503 base17-unavailable` with `reason ∈ {not-installed, corrupt}` →
      **fall back** (single attempt; the cause is deterministic, retrying the
      mint can't help).
   3. Any other error (incl. an OOM-driven generic 500, or `SIDECAR_DOWN_RE`
      handled by the bulk job's ride-out) → propagate unchanged. **No fallback.**
   4. **Fallback** — POST `/qwen/design-voice` via `postDesignAndCache` with:
      - `voiceId`: the variant id `${baseVoiceId}__${emotion}` (same id the
        anchored mint would have written, so the cast slot resolves correctly).
      - `instruct`: `` `${p.persona} ${EMOTION_INSTRUCT[p.emotion]}` `` —
        `p.persona` is already a required field on `DesignQwenVoiceParams` and is
        populated for variants (the bulk job guarantees a base persona exists).
      - `voiceUuid`, `language`, `calibrationText`: as the base design path.
      - `mintMethod: "design-voice-fallback"`,
        `fallbackFor: { baseVoiceId, emotion }`.
   - The base-design case (`p.emotion` unset) is untouched.

4. **Return shape.** `designQwenVoiceForCharacter` resolves
   `{ voiceId, url, fellBackToDesignVoice?: boolean, fallbackReason?:
   "not-installed" | "corrupt" }`. Existing callers ignore the new optional
   fields unless they opt in (below).

5. **Server log** on fallback:
   `[qwen-voice] 1.7B-Base unavailable (reason=<not-installed|corrupt>) — minted <emotion> variant for <characterId> via design-voice fallback (lower fidelity).`

### Bulk Design progress stream (`server/src/routes/cast-design.ts`)

- The bulk variant loop already broadcasts
  `{ type: 'variant_designed', characterId, emotion, voiceId }` on success
  (line ~380). Extend it with `viaFallback: boolean` (and `fallbackReason`)
  read from the `designQwenVoiceForCharacter` return value.
- Client: the Design panel renders "minted via fallback (lower fidelity)" for
  any character whose `variant_designed` carried `viaFallback: true`. (Frontend
  surface is small — a per-row note in the existing live panel, no new modal.)

### Health forwarding (`server/src/routes/sidecar-health.ts`)

- Forward the new sidecar field as `qwenBase17WeightsPresent?: boolean` on
  `SidecarHealthBody` / `SidecarHealthResult` (default `false` for an older
  sidecar). Observability only; not consumed by the decision path.

## Edge cases

- **OOM during the Base17 load** — not a fallback trigger (see the design table).
  It stays the existing loud per-character failure; srv-52 never burns a second
  1.7B load that would OOM identically.
- **VoiceDesign also unavailable on the fallback** — if 1.7B-VoiceDesign (or the
  0.6B distil model) can't load when the fallback runs, the `design-voice` call
  fails and surfaces as the existing loud per-character failure. srv-52 never
  papers over a genuinely missing model.
- **Corrupt-vs-OOM misclassification** — the sole heuristic. If a real OOM were
  mis-tagged "corrupt", the fallback would attempt VoiceDesign and OOM (one wasted
  load, then loud failure — no worse than no fallback). If corrupt weights were
  mis-tagged "OOM", the user loses the fallback and gets a loud failure (no
  variant). Both degrade to "loud failure", never to a silent/wrong result.
- **Cancel mid-fallback** — the fallback reuses `postDesignAndCache`, which
  honours `p.signal`; a cancel during the fallback aborts it exactly as it would
  abort the anchored mint.
- **Preview (A/B compare)** — `p.preview` flows into the variant id via
  `previewVoiceIdFor` before the fallback composes its body, so a preview
  fallback stages under the `-preview` sibling id like the anchored path.
- **Single-design + REST callers** — they receive `fellBackToDesignVoice` but
  have no progress stream; the server log + persisted marker are their honesty
  surface. (Single-design variants are rare; the #1089 relay note is out of
  scope for v1 — see Known limitations.)

## Known limitations (v1)

- **OOM is intentionally out of scope.** A VRAM-OOM Base17 load does **not**
  fall back (VoiceDesign would OOM identically); it stays the existing loud
  failure with no retry and no churn. The "variant still ships" win is therefore
  confined to the **Base17 absent/corrupt + VoiceDesign present** config. v1 does
  not pre-check VoiceDesign weights to *prove* the fallback will succeed before
  attempting it — a deterministic absent/corrupt Base17 makes a VoiceDesign
  success likely, and a failed fallback is still a clean loud error.
- **Lower-fidelity output.** A fallback variant lacks both the base-speaker
  timbre anchor and the fs-55 per-emotion gain/temperature tuning (which live in
  the mint's instruct-synth, not in `generate_voice_design`). It stays
  lower-fidelity until re-minted. No *new* upgrade tooling is needed —
  `remint-anchored-variants.mjs --apply` already targets it via the
  `mintMethod: "design-voice-fallback"` marker (see Non-goals).
- **Single-design progress note.** The per-character SSE note lands only on the
  bulk job; single-design/REST callers get the log + marker, not a live UI note.

## Testing

Per-harness paired coverage (CLAUDE.md testing discipline):

### Sidecar pytest (`server/tts-sidecar/tests/test_qwen3.py`)

- `_qwen_base17_weights_present()` true/false against a stub snapshot dir.
- `/qwen/mint-variant` returns `503 { code: "base17-unavailable",
  reason: "not-installed" }` when base17 weights absent (no load attempted).
- `/qwen/mint-variant` returns `503 { …, reason: "corrupt" }` when the Base17
  load raises a **non-OOM** exception (stub `_ensure_base17_loaded` to raise a
  generic/format error).
- `/qwen/mint-variant` returns the **generic 500** (no `base17-unavailable`
  code) when the load raises a CUDA OOM (stub a `torch.cuda.OutOfMemoryError` /
  `"out of memory"` exception) — the OOM-not-a-fallback guard.
- `/qwen/mint-variant` still returns `409` on a missing base `.pt`
  (`VoiceNotDesignedError`) — regression guard that the fallback signal didn't
  swallow the unrelated error.
- `/health` includes `qwen_base17_weights_present`.
- `/qwen/design-voice` merges `mintMethod` + `fallbackFor` into the manifest
  when present; manifest unchanged when absent.

### Server vitest (`server/src/routes/qwen-voice.test.ts`)

- Stubbed `503 base17-unavailable/not-installed` → `designQwenVoiceForCharacter`
  POSTs `/qwen/design-voice` with `instruct === \`${persona} ${EMOTION_INSTRUCT[emotion]}\``
  and `voiceId === \`${baseVoiceId}__${emotion}\``, returns
  `fellBackToDesignVoice: true, fallbackReason: 'not-installed'`.
  mint-variant called **exactly once** (no retry anywhere).
- Stubbed `503 …/corrupt` → same fallback, `fallbackReason: 'corrupt'`.
- Stubbed **generic 500** (OOM) → the error **propagates**, design-voice is
  **never** called, `fellBackToDesignVoice` falsy — the OOM-no-fallback guard.
- 1.7B available (mint-variant 200) → anchored path, design-voice **never**
  called, `fellBackToDesignVoice` falsy — the no-regression guard.
- The `base17-unavailable` classification does **not** match `SIDECAR_DOWN_RE`.

### Server vitest (`server/src/routes/cast-design.test.ts`)

- Bulk variant run where `designQwenVoiceForCharacter` reports a fallback emits
  `variant_designed { viaFallback: true, fallbackReason }`.

### E2E

- No new Playwright spec required (no new view/flow seam). The Design panel note
  is covered by a frontend unit test on the slice that consumes
  `variant_designed.viaFallback`.

## Acceptance (from issue #1091)

- [x] A variant request with the 1.7B-Base absent/unloadable produces a designed
  variant via `/qwen/design-voice` (persona + emotion clause), not an orphaned
  `.pt`.
- [x] The fallback is logged (visible reason), never a silent Kokoro fallback.
- [x] When the 1.7B-Base is available, behaviour is unchanged (anchored mint).
- [x] Paired test: fallback fires on a simulated 1.7B-unavailable; anchored path
  on available.

## Ship notes

_(filled at ship)_
