---
status: active
shipped: null
owner: null
---

# Voice cloning — read a book in your own (or your family's) voice

> Status: active — Wave 1 shipped; Wave 3a (ingest/consent/recorder, behind-flag)
> delivered; Waves 3b1/3b2/3c + polish outstanding ([`fs-38` · #624](https://github.com/dudarenok-maker/AudioBook-Generator/issues/624))
> Key files (anticipated): `server/tts-sidecar/` (Qwen clone extraction + XTTS clone), `server/src/tts/`, `src/store/cast-slice.ts`, `src/views/voices.tsx`, `src/components/voice-library-panel.tsx`, `openapi.yaml`
> URL surface: `#/voices` (cloned-voice section + capture flow), cast profile drawer
> OpenAPI ops: `POST /api/voice-library/clone-sample`, `POST /api/voice-library/{voiceUuid}/revoke` (3a, shipped); `POST /api/voice-library/clone` (3b1, TBD)
> Wave 3 umbrella spec: [`docs/superpowers/specs/2026-07-25-fs38-wave3-clone-pipeline-design.md`](../superpowers/specs/2026-07-25-fs38-wave3-clone-pipeline-design.md)

## Wave 1 shipped (2026-07-24)

Wave 1 (which alone delivers the folded-in **fs-12**) shipped a first-class, book-independent
**voice library** ("My voices") at `#/voices`, restructured into three sections **My voices |
In use | Catalogue**. It adds standalone **designed-voice authoring**: create a Qwen voice from
a persona with a live audition, **redesign-with-compare** (A/B old-vs-new, keep or discard),
**promote** a character's designed voice into the library (new uuid + byte-copy of the `.pt`),
and **assign** a library voice to any character — reusable across books and series. A
`provenance` dimension (`designed`/`cloned`/`imported`) lands now (cloned/imported are inert
until Wave 3), and the cross-book voice matcher already **excludes cloned-provenance voices** so
a person's voice is never offered back into a stranger's book. Everything is **local-only**;
deleting a library voice gives a usage report and does full multi-location erasure (manifest +
`.pt` + cached samples). **NOT in Wave 1** (later waves): clone-from-a-real-sample,
consent/attestation, audio ingest, in-app recording, Catalogue rebuild. Plan:
[`docs/superpowers/plans/2026-07-04-fs38-wave1-voice-library-store.md`](../superpowers/plans/2026-07-04-fs38-wave1-voice-library-store.md).

## Wave 3a delivered (ingest, consent, recorder — behind-flag)

Wave 3a activated the ingest side of the scaffolding Wave 1 left inert: real ffmpeg
decode (upload **or** an in-app `VoiceRecorder`) → a pure quality gate (fatal <4s/silence,
warn short/clipping) → 60s cap → a Node-written `master.wav` → Whisper transcript, behind
`POST /api/voice-library/clone-sample` (an ephemeral candidate, no entry yet). A write-time
consent-structure guard on `writeEntry()` and `POST /:uuid/revoke` (stamps `consent.revokedAt`,
orthogonal to the structure guard) round out the store contract; the existing sample-audition
route now 403s a revoked/consent-absent cloned voice. On the frontend: a 'Cloned' provenance
badge and a Revoke action render in My voices, and the recorder + a capture/consent panel exist
as phase-1 wizard building blocks (mic-permission-denied falls back to Upload, never a dead
end). **Per spec §1.1's honesty note, this is a behind-the-flag engineering slice, not a
user-visible feature on its own** — the consent guard, `/revoke` route, and cloned-section UI
states have no reachable production caller until **3b1** writes the first real cloned entry
via `POST /clone`. Regression plan: [267](267-fs38-wave3-voice-clone.md).

Pays off the brand promise — _"even in your own voice"_ (`brand/project-narrative.md`,
[#622](https://github.com/dudarenok-maker/AudioBook-Generator/issues/622)). A parent reads a
bedtime story in their own voice while away; a kid hears themselves as the hero.

## Benefit / Rationale

- **User:** clone a real person's voice from a short sample and cast it like any other voice —
  the most personal, gift-able, viral thing the product can do.
- **Technical:** the engines are mostly here — XTTS already clones zero-shot from a reference
  clip, Qwen can design toward a target — so the work is the _experience_ and the data model,
  not net-new ML.
- **Architectural:** introduces a new voice **provenance class** (cloned-from-a-person) that
  must be modelled, consented, and isolated from designed/fictional voices throughout the
  library and reuse machinery.

## v1 definition of done

1. **Capture** a clean voice sample in-app (record or upload), with quality guidance (length,
   noise, clipping) and a re-take loop.
2. **Consent on the record** — an explicit, stored consent step naming the person and the
   permitted use; cloning is blocked without it. (See risk below.)
3. **Clone + cast** — produce a reusable cloned voice (**Qwen leads** — reference-clip
   clone via Base `create_voice_clone_prompt`, **not** the 1.7B "design-to-target" — since
   it's the default engine and a refactor of already-proven code; XTTS reference-clip clone
   follows as the second engine, see _Implementation notes_ and the Wave 3 spec's §1.2
   wave-ordering note) and assign it to a character exactly like a designed voice, held
   **consistent across the book and series** the way designed voices already are.
4. **Library separation** — cloned voices live in their own section of `#/voices`, never
   intermingled with designed voices, with provenance + consent surfaced and **reuse gated** so
   a person's voice is never offered back to an unrelated book/stranger.
5. **Local-only** — samples, embeddings, and renders never leave the machine; export is
   explicit.

## Architectural impact

- **New seams:** a `provenance: 'cloned' | 'designed' | 'catalogue' | 'matched'` (or similar)
  dimension on the voice record; a consent record persisted per cloned voice; a sample-capture
  surface; sidecar clone endpoints layered beside the existing `design_voice` / XTTS paths.
- **Invariants preserved:** per-engine override map on the character
  (`overrideTtsVoices`, plan 108) — a cloned voice is just another engine-keyed assignment;
  cross-book reuse/link machinery (plans 126/183/192) — cloned voices must be **excluded** from
  the cross-book "offer it back" matcher unless same-owner/same-consent; never-cross-language
  (plan 162).
- **Migration:** additive — existing voices default to their current provenance
  (designed/catalogue/matched); no break to `cast.json` / library shape, lazy-tag on read.
- **Reversibility:** the cloned section + capture flow are gated behind a flag; disabling it
  hides capture and leaves designed voices untouched.

## Implementation notes — Qwen clone pipeline (verified against code 2026-06-13)

Scoped against the running sidecar; corrects the "Qwen design-to-target" framing above.

- **Qwen cloning is a pure Base-0.6B operation — the 1.7B VoiceDesign is bypassed.** The clone
  embedding (`VoiceClonePromptItem`) is created *and* consumed only on Base: real clip +
  transcript → `Base.create_voice_clone_prompt(ref_audio, ref_text)` → `.pt` →
  `Base.generate_voice_clone(text, voice_clone_prompt=…)` per sentence. This is the **same
  back-half already used by `design_voice`** (`server/tts-sidecar/main.py:1436` create +
  `:1474/:1553/:1632` synth) — voice *design* merely manufactures the reference audio with the
  1.7B (`generate_voice_design`) first. For cloning, the audio **source** swaps to a real
  recording; everything downstream is unchanged and already proven (the sidecar log shows
  hundreds of successful `generate_voice_clone` calls). The Qwen clone work is therefore an
  **ingest path only**, not net-new ML — drop the "design-to-target" framing.
- **You cannot clone on the 1.7B and synth on the 0.6B.** Clone embeddings are
  model-specific — that is *why* `design_voice` routes the 1.7B's **audio** (not an embedding)
  through `Base.create_voice_clone_prompt`. Cloning never needs the 1.7B loaded, so cloned-voice
  generation has the **same VRAM profile** as a designed voice (small resident Base only).
- **The `.pt` is Base-version-specific → persist the raw clip.** The sibling `.json` manifest
  records `baseModel`; swapping/upgrading the Base model orphans every `.pt`. Keep the **raw
  reference clip** as the durable source-of-truth so `.pt`s can be re-derived after a Base
  change — the `.pt` is a regenerable **cache**, the clip is the **master**. (`design_voice`
  currently *discards* its reference audio after distillation; the clone path must **not** — the
  clip is also the consent/provenance artifact the risk section requires.)
- **Whisper ASR supplies `ref_text`.** `create_voice_clone_prompt` needs the transcript of the
  reference clip; the in-stack Whisper ASR (srv-31) can auto-transcribe the captured sample, so
  the user need not type what they said.
- **Net storage per cloned voice:** raw clip (master) + `.pt` (Base-derived cache, regenerable)
  + `.json` manifest (consent/provenance/`baseModel`) + optional preview MP3 — the designed-voice
  layout plus the **retained clip**.

## Risk — consent & IP (must design in, not bolt on)

Cloning a real person (incl. a child) is consent-sensitive and increasingly regulated
(EU AI Act, US state voice-likeness laws). v1 requires an explicit, stored consent step and a
"personal use only" stance for copyrighted books. No public/community sharing of cloned voices
in v1.

## Delivery roadmap (waves)

1. **Data model + library split** — provenance dimension, consent record, `#/voices` cloned
   section (no engine work yet; designed voices unaffected). **Shipped** (Wave 1, 2026-07-24).
2. **Sample capture** — record/upload + quality checks + consent gate. **Delivered as Wave
   3a** (see below) — folded into the Wave 3 umbrella spec's sub-wave decomposition rather
   than shipping as its own standalone wave.
3. **The clone pipeline itself**, split into four independently-reviewable sub-waves per
   [`docs/superpowers/specs/2026-07-25-fs38-wave3-clone-pipeline-design.md`](../superpowers/specs/2026-07-25-fs38-wave3-clone-pipeline-design.md)
   §1.1 (supersedes this doc's earlier "XTTS then Qwen" ordering — **Qwen leads**, it's the
   default engine and a refactor of already-proven `design_voice` code):
   - **3a — Ingest, consent, recorder.** **Delivered** (behind `voices.library.enabled`,
     no reachable production caller until 3b1 — see plan
     [267](267-fs38-wave3-voice-clone.md)).
   - **3b1 — Qwen clone (happy path).** `POST /qwen/clone-voice` extraction, `POST
     /api/voice-library/clone`, wizard phase 2, cast assignment, ECAPA fidelity, and the
     `applyQwenFallback` cloned-voice exemption (closing the first silent-substitution
     hole). **First user-visible clone.**
   - **3b2 — Resolver + lifecycle.** The three-state (Healthy/Repairable/Broken) resolver
     as an async per-chapter pre-pass, orphan self-heal, revocation-at-render.
   - **3c — XTTS clone.** `POST /xtts/clone-voice`, the latents-backed Coqui synth branch,
     designed-voice XTTS-eligibility.
4. **Polish** — auditions, A/B vs a designed alternative, drift handling for cloned voices.

## Test plan / acceptance

- Unit: provenance tagging + reuse-exclusion (a cloned voice is never returned by the
  cross-book matcher); consent gate blocks clone without a stored record.
- Sidecar: clone-from-sample produces a stable embedding reused across chapters (mirrors the
  Qwen design golden/length checks).
- E2E: capture → consent → clone → cast → the cloned voice appears only in the cloned section.
- Live-GPU acceptance: a real sample renders a chapter recognisably in that voice, consistent
  across chapters.

## Ship notes

_(to fill on ship)_
