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
(`server/tts-sidecar/scripts/install-qwen3.mjs:72`) *always* pulls 1.7B-Base and makes VoiceDesign the
`--skip-design`-optional one, so "Base17 absent, VoiceDesign present" is the
*opposite* of the common lean install — but it does occur for old/stripped/
partial installs and corrupt-weight cases. **OOM is deliberately excluded**: a
fallback there would just OOM VoiceDesign too, so srv-52 leaves it as the
existing loud per-character failure rather than burning a second 1.7B load.

#### Telling "corrupt" from "OOM"

Both are exceptions raised from loading the Base17 model, so the sidecar must
classify them. **The substring test is the load-bearing one.** A real CUDA OOM
in this codebase surfaces as a **plain `RuntimeError("CUDA out of memory: …")`**
— *not* a `torch.cuda.OutOfMemoryError` — because the OOM is typically raised by
the `inner.to(device)` move in `_load_qwen_model` (verified against
`server/tts-sidecar/tests/test_qwen_load_reclaim.py:36` and the reclaim path at
`main.py:1427-1430`, which re-raises the original exception bare). So the OOM
gate is, in order:

```python
msg = str(exc).lower()
is_oom = (
    ("out of memory" in msg)                                  # PRIMARY — the real shape
    or isinstance(exc, getattr(torch.cuda, "OutOfMemoryError", ()))  # belt-and-suspenders
)
```

`is_oom` → **NOT a fallback trigger** (re-raise → generic 500). **Any other**
load exception (missing/partial blob, deserialization / format error, qwen_tts
load-API drift) → **corrupt** → `503 base17-unavailable/corrupt` → fall back.
Leading with the exception *type* would miss the dominant real OOM and
mis-classify it as corrupt → fire the fallback → **the cardinal sin srv-52
forbids.** The substring check must be first.

**OOM is treated as recoverable, not poisoning.** `/synthesize` treats a CUDA
OOM as process-poison (`_CUDA_POISON_RE`, `main.py:219-225` → supervised
self-exit code 42); the mint/design routes deliberately do **not** (their
`except Exception → 500`). srv-52 keeps that: a *load*-OOM is left as the loud
500 with no self-exit, justified because `_load_qwen_model` already runs
`_reclaim_host_and_vram()` before re-raising (`main.py:1429`), so the partial
allocation is reclaimed rather than wedging the context. (If on-box testing
later shows a load-OOM *does* wedge CUDA, poisoning the mint route is a
follow-up — out of scope for v1.)

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

3. **`mint_variant` raises distinct, typed errors so the route can classify**,
   replacing the generic 500 for the not-installed / corrupt cases. The checks
   live **inside `mint_variant`** (not as a route pre-check) in this strict
   order, so the existing base-first contract is preserved:

   1. **Base `.pt` missing** → existing `VoiceNotDesignedError` (`main.py:1982`)
      → route maps to **409**. *Unchanged, and FIRST* — a character with no
      designed base is always a 409 regardless of Base17 state, so a
      missing-base + missing-Base17 character does **not** wrongly fall back
      (H4). The fallback never papers over "base not designed."
   2. **Base17 not installed** — immediately after the base check, if
      `_qwen_base17_weights_present()` is false, raise
      `Base17UnavailableError("not-installed")` *before* attempting any load →
      route maps to `503 { code:"base17-unavailable", reason:"not-installed" }`.
   3. **Base17 load fails** — wrap **only** the Base17 load
      (`_ensure_base17_loaded()`, called at `main.py:2006` and re-checked at
      `2008` — both inside the wrap, nothing else) in a try/except:
      - OOM (per the substring gate above) → **re-raise unchanged** → generic
        500. NOT a fallback trigger.
      - any other exception → raise `Base17UnavailableError("corrupt", cause)`
        → route maps to `503 { …, reason:"corrupt", detail:"<exc message>" }`.

   **The wrap is the narrow seam (H3): it brackets the load call only.** Decode
   (`speech_tokenizer.decode`, `main.py:2011`), `_icl_instruct_synth`, the 0.6B
   distil, and the audition are **outside** it, so a bug there (qwen_tts API
   drift, malformed `ref_code`, distil failure) still surfaces as a generic 500
   — never mis-tagged "corrupt" and never wrongly falling back. `Base17UnavailableError`
   is raised only from these two points, so the 1.7B synth/batch callers of
   `_ensure_base17_loaded()` are unaffected (they don't catch it → existing 500).

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
   helper that takes the resolved `target` URL and the JSON body. The GPU
   semaphore + `withDesignLock`/`withGpuLoad` are acquired **once** in the outer
   `designQwenVoiceForCharacter` and span both the mint attempt and the fallback,
   so the two-call sequence holds a single GPU slot and the fallback never
   re-queues behind other work. **But the abort/liveness plumbing is per-call
   (H5):** `postDesignAndCache` creates its own `AbortController`, `startedAt`,
   and liveness `setInterval` on each invocation, and re-wires the external
   `p.signal` → `controller.abort()` listener for *that* call (the current
   single-controller wiring at `qwen-voice.ts:318-346,437` must be duplicated
   into the helper). So a cancel during the fallback aborts the fallback's own
   controller, and each call gets a fresh liveness timer + ceiling. This is the
   one part of the refactor that is **not** verbatim reuse — the spec calls it
   out so it isn't missed.

2. **Typed `SidecarDesignError` carrying status + code.** Today the non-OK
   branch (`qwen-voice.ts:394-406`) throws a plain `Error` with only a message.
   The refactor replaces it with a `SidecarDesignError` that parses the response
   JSON and exposes `.status`, `.code`, and `.reason` (alongside the human
   message it still builds). The **mint** call site branches on
   `err.status === 503 && err.code === "base17-unavailable"` with
   `reason ∈ {"not-installed","corrupt"}` — **on the structured fields, never the
   message** (M6). An OOM is a generic 500 with no `code`, so it never matches.
   The **fallback** call site does not catch it → a VoiceDesign failure
   propagates loudly. Because the branch is on `.status`/`.code`, an arbitrary
   `<exc message>` in the corrupt `detail` can't be mistaken for a recycle even
   if it happened to contain a `SIDECAR_DOWN_RE` word; nonetheless the
   `SidecarDesignError.message` for the base17 case is a fixed string that does
   **not** match `SIDECAR_DOWN_RE`.

3. **Control flow** (variant case only; `p.emotion` set) — **no retry**:
   1. POST `/qwen/mint-variant` (anchored) via `postDesignAndCache`.
   2. `503 base17-unavailable` with `reason ∈ {not-installed, corrupt}` →
      **resolve persona (below), then fall back** (single attempt; the cause is
      deterministic, retrying the mint can't help).
   3. Any other error (an OOM-driven generic 500, a `SIDECAR_DOWN_RE` error the
      bulk job rides out, a 409 missing-base) → propagate unchanged. **No
      fallback.**
   4. **Fallback** — POST `/qwen/design-voice` via `postDesignAndCache` with:
      - `voiceId`: the variant id `${baseVoiceId}__${emotion}` (same id the
        anchored mint would have written, so the cast slot resolves correctly).
      - `instruct`: `` `${resolvedPersona} ${EMOTION_INSTRUCT[p.emotion]}` ``
        (persona resolution below).
      - `voiceUuid`, `language`, `calibrationText`: as the base design path.
      - `mintMethod: "design-voice-fallback"`,
        `fallbackFor: { baseVoiceId, emotion }`.
   - The base-design case (`p.emotion` unset) is untouched.

4. **Persona resolution before the fallback (C1).** `p.persona` is a typed field
   but is **not guaranteed non-empty for a variant**: the anchored mint never
   uses persona, and the bulk loop passes `character.voiceStyle` which reads
   blank for reused/origin characters (the very gap the `designed-persona`
   endpoint exists to paper over, `qwen-voice.ts:227-267`). A bare
   `` ` ${EMOTION_INSTRUCT[emotion]}` `` would design a **personaless garbage
   voice** that `design-voice` would happily accept (its only guard is
   non-empty-after-trim). So resolve with precedence:
   1. `p.persona.trim()` if non-empty.
   2. else read the base voice's designed persona from its sidecar `.json` —
      `readJson(qwenVoiceSidecarPath(baseVoiceName)).instruct`, using the same
      storage-key resolution as the `designed-persona` endpoint
      (`character.overrideTtsVoices?.qwen?.name ?? qwenStorageKey(...)`).
   3. else **decline the fallback** — throw a clear error
      (`"1.7B-Base unavailable and no persona on disk to fall back with — design the base voice's persona first."`).
      A loud, actionable failure beats a silent garbage variant.

5. **Return shape.** `designQwenVoiceForCharacter` resolves
   `{ voiceId, url, fellBackToDesignVoice?: boolean, fallbackReason?:
   "not-installed" | "corrupt" }` — a widening of the current
   `{ voiceId, url }`. All consumers (single route `qwen-voice.ts:547`, bulk
   `cast-design.ts:356`) keep compiling; only those that opt in read the new
   fields. The single-design route's `res.json` is **not** required to forward
   `fellBackToDesignVoice` (no client consumer; its honesty surface is the log +
   persisted marker) — leaving it off keeps the change minimal, but it may be
   added cheaply if a UI note is wanted later.

6. **Server log** on fallback:
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
- **Instruct length cap** — `/qwen/design-voice` caps `instruct` at
  `_max_text_length()` (default 8000, `main.py:3998-4003`); the anchored mint's
  `emotionInstruct` has **no** such cap. So the fallback newly subjects
  `persona + EMOTION_INSTRUCT[emotion]` to the cap. Personas are a sentence or
  two and the longest emotion clause is ~180 chars, so exceeding 8000 is
  implausible — but it is a *new* 400 surface the anchored path didn't have.
  Acceptable for v1; noted, not guarded.
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
  code) when the load raises a CUDA OOM — **test the real shape: a plain
  `RuntimeError("CUDA out of memory: …")`** (the dominant case, per
  `test_qwen_load_reclaim.py:36`), *and* a `torch.cuda.OutOfMemoryError` if the
  fake `torch.cuda` defines one. The `fake_qwen_runtime` fixture
  (`test_qwen3.py:132-182`) currently has no `OutOfMemoryError` on its fake
  `torch.cuda` — the test must add it (or rely on the substring path).
- `/qwen/mint-variant` raises the **corrupt** classification only for a *load*
  failure: a stubbed failure in the post-load decode / instruct-synth / 0.6B
  phase still yields the generic 500 (H3 guard — a non-load bug is never
  mis-tagged corrupt).
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
- **Empty persona (C1):** a `503 …/not-installed` where `p.persona` is `''` and
  the base voice's sidecar `.json` has no `instruct` → the fallback is
  **declined** (throws the actionable error; design-voice **not** called with a
  bare emotion clause). And: `p.persona` empty but the base `.json` *has* an
  `instruct` → fallback uses that recovered persona.
- The mint call site branches on `err.status`/`err.code`, **not** the message —
  assert a `503 base17-unavailable` whose `detail` contains a `SIDECAR_DOWN_RE`
  word still classifies as a fallback (M6), and that the base17 path never trips
  the bulk job's ride-out.

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
