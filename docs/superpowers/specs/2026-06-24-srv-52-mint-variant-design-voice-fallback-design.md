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
1.7B dependency (Base) for a different 1.7B dependency (VoiceDesign). The genuine
win is therefore **narrow**, which is consistent with the issue's
`moscow:could / low-cost` label:

- **Base17 absent or corrupt while VoiceDesign is present** → the fallback mints
  a working (lower-fidelity) variant. Note the standard installer
  (`install-qwen3.mjs:72`) *always* pulls 1.7B-Base and makes VoiceDesign the
  `--skip-design`-optional one, so this config is unusual (it's the *opposite* of
  the common lean install) — but it does occur for old/stripped/partial installs
  and corrupt-weight cases.
- **Base17 load-failed (VRAM OOM)** → the fallback's own VoiceDesign load is the
  same size and will *very likely also OOM*; the fallback then fails loudly. Net
  gain in that case is only "a clear logged failure instead of a generic 500" —
  see Known limitations.

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

1. When `/qwen/mint-variant` cannot use the 1.7B-Base (not installed/corrupt, or
   load fails) **and 1.7B-VoiceDesign is usable**, produce a **designed emotion
   variant** via `/qwen/design-voice` (`persona + EMOTION_INSTRUCT[emotion]`)
   instead of a missing variant. When VoiceDesign is *also* unavailable, fail
   **loudly and clearly** (never a generic 500, never silent).
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
   unavailable**, replacing the generic 500 for these two cases:
   - **Not installed** — when `_qwen_base17_weights_present()` is false, the
     route short-circuits *before* attempting a load and returns:
     `503 { "code": "base17-unavailable", "reason": "not-installed",
     "detail": "Qwen 1.7B-Base weights are not installed." }`
   - **Load failed** — `mint_variant` is wrapped so a load failure raised from
     `_ensure_base17_loaded()` is caught and surfaced as:
     `503 { "code": "base17-unavailable", "reason": "load-failed",
     "detail": "<exc message>" }`
     A new `Base17UnavailableError` exception (raised by `_ensure_base17_loaded`
     on failure, or detected via a sentinel) carries the reason so the route can
     map it cleanly. Any *other* exception keeps the existing generic 500.
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
   `designQwenVoiceForCharacter` and span the mint attempt, the optional retry,
   and the fallback — so the whole sequence holds a single GPU slot and the
   fallback never re-queues behind other work. Pure refactor — no behaviour change
   on the happy path.

2. **Typed error carrying status + code.** On a non-OK response,
   `postDesignAndCache` throws a `SidecarDesignError` exposing `.status` and the
   parsed body `.code` (in addition to the human message it already builds). Only
   the **mint** call site inspects it — `err.status === 503 && err.code ===
   "base17-unavailable"` → branch to retry/fallback, reading `body.reason`
   (`"not-installed" | "load-failed"`). The **fallback** call site does *not*
   catch it, so a VoiceDesign failure propagates as a normal loud error. The
   `SidecarDesignError` message must **not** match `SIDECAR_DOWN_RE`, so the bulk
   job's process-down ride-out loop never mistakes the base17 signal for a
   recycle.

3. **Control flow** (variant case only; `p.emotion` set):
   1. POST `/qwen/mint-variant` (anchored) via `postDesignAndCache`.
   2. `base17-unavailable / not-installed` → **fall back immediately** (no
      retry — the weights aren't there; retrying is pointless).
   3. `base17-unavailable / load-failed` → **retry the mint once**; if the
      retry also returns `base17-unavailable` (either reason) → fall back.
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
   "not-installed" | "load-failed" }`. Existing callers ignore the new optional
   fields unless they opt in (below).

5. **Server log** on fallback:
   `[qwen-voice] 1.7B-Base unavailable (reason=<not-installed|load-failed>) — minted <emotion> variant for <characterId> via design-voice fallback (lower fidelity).`

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

- **VoiceDesign also unavailable** — if 1.7B-VoiceDesign (or the 0.6B distil
  model) can't load either, the fallback `design-voice` call fails, surfacing as
  the existing loud per-character failure. srv-52 turns a *generic 500 on the
  mint* into *either a working fallback variant or a clear failure* — it never
  papers over a genuinely missing model.
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

- **VRAM-OOM is the weak case.** When the Base17 failure is a VRAM OOM (not a
  missing install), the fallback's own 1.7B-VoiceDesign load is the same size and
  will very likely OOM too. The sequence is then: mint OOM → one retry OOM →
  VoiceDesign OOM → loud failure. Net gain in that path is only "a clear,
  reasoned failure instead of a generic 500" — *not* a working variant. The
  genuine "variant still ships" win is concentrated in the **Base17
  absent/corrupt + VoiceDesign present** config. v1 does **not** add inter-retry
  VRAM-reclaim/backoff, nor does it pre-check VoiceDesign weights to skip a
  doomed fallback — both are deferred refinements.
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
- `/qwen/mint-variant` returns `503 { …, reason: "load-failed" }` when
  `_ensure_base17_loaded` raises.
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
  `fellBackToDesignVoice: true, fallbackReason: 'not-installed'`. **No retry**
  (mint-variant called exactly once).
- Stubbed `503 …/load-failed` → mint-variant called **twice** (one retry), then
  design-voice; `fallbackReason: 'load-failed'`.
- `load-failed` then a *successful* retry → anchored result, **no** fallback.
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
