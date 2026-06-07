---
status: draft
shipped: null
owner: null
---

# Voice cloning — read a book in your own (or your family's) voice

> Status: draft — next big release ([`fs-38` · #624](https://github.com/dudarenok-maker/AudioBook-Generator/issues/624))
> Key files (anticipated): `server/tts-sidecar/` (XTTS clone + Qwen design-to-target), `server/src/tts/`, `src/store/cast-slice.ts`, `src/views/voices.tsx`, `src/components/voice-library-panel.tsx`, `openapi.yaml`
> URL surface: `#/voices` (cloned-voice section + capture flow), cast profile drawer
> OpenAPI ops: new — voice-sample capture/upload + clone-design endpoints (TBD)

Pays off the brand promise — _"even in your own voice"_ (`docs/project-narrative.md`,
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
3. **Clone + cast** — produce a reusable cloned voice (XTTS reference path first; Qwen
   design-to-target as the second engine) and assign it to a character exactly like a designed
   voice, held **consistent across the book and series** the way designed voices already are.
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

## Risk — consent & IP (must design in, not bolt on)

Cloning a real person (incl. a child) is consent-sensitive and increasingly regulated
(EU AI Act, US state voice-likeness laws). v1 requires an explicit, stored consent step and a
"personal use only" stance for copyrighted books. No public/community sharing of cloned voices
in v1.

## Delivery roadmap (waves)

1. **Data model + library split** — provenance dimension, consent record, `#/voices` cloned
   section (no engine work yet; designed voices unaffected).
2. **Sample capture** — record/upload + quality checks + consent gate.
3. **XTTS clone path** — reference-clip → reusable cloned voice → cast assignment + series
   consistency.
4. **Qwen design-to-target** — second engine for the same cloned-voice contract.
5. **Polish** — auditions, A/B vs a designed alternative, drift handling for cloned voices.

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
