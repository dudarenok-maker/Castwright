---
status: active
shipped: null
owner: null
---

# 267 — fs-38 Wave 3a: voice-clone ingest, consent & recorder

> Status: active
> Key files: `server/src/tts/clone-ingest.ts`, `server/src/tts/clone-quality.ts`,
> `server/src/tts/wav.ts`, `server/src/workspace/clone-candidate.ts`,
> `server/src/workspace/voice-library.ts`, `server/src/routes/voice-library.ts`,
> `src/components/voices/voice-recorder.tsx`,
> `src/components/voices/clone-capture-panel.tsx`,
> `src/components/voices/voice-library-card.tsx`, `src/store/voice-library-slice.ts`,
> `openapi.yaml`
> URL surface: `#/voices` (My voices — 'Cloned' badge + Revoke action on an existing
> cloned entry); no wired wizard entry point yet (see "Not in 3a")
> OpenAPI ops: `POST /api/voice-library/clone-sample`, `POST /api/voice-library/{voiceUuid}/revoke`

Source spec: [`docs/superpowers/specs/2026-07-25-fs38-wave3-clone-pipeline-design.md`](../superpowers/specs/2026-07-25-fs38-wave3-clone-pipeline-design.md)
Umbrella doc: [`194-voice-cloning.md`](194-voice-cloning.md) · fs-38 · [#624](https://github.com/dudarenok-maker/Castwright/issues/624)

## Benefit / Rationale

- **User:** none directly yet — 3a is a **behind-the-flag engineering slice**
  (see spec §1.1's "3a honesty note"). Its payoff is entirely enabling: the
  next sub-wave (3b1) can ship the first user-visible clone without also
  having to build ingest/consent/recorder from scratch under review pressure.
- **Technical:** establishes the shared "capture → gate → normalize →
  transcribe" pipeline every future clone (Qwen 3b1, XTTS 3c) will read
  `master.wav` from, plus the write-time consent guard the whole wave's data
  model depends on (spec §4.3).
- **Architectural:** locks in the on-disk contract (`master.wav` retained
  alongside the manifest, spec §2.2) and the OpenAPI shapes
  (`VoiceMaster`, `CloneSampleCandidate`) that 3b1's `POST /clone` will
  extend rather than redesign.

## Architectural impact

- **New seams / extension points:**
  - `ingestCloneSample()` (`server/src/tts/clone-ingest.ts`) — the shared
    decode→gate→cap→WAV→transcribe pipeline; 3b1's `POST /clone` will build
    on the same `master.wav` output.
  - An **ephemeral candidate store** (`server/src/workspace/clone-candidate.ts`)
    under `<voiceLibraryDir>/_candidates/<id>/` — phase-1 output with **no
    consumer yet**; 3b1's `POST /clone` reads it and promotes `master.wav`
    into the real entry directory.
  - A **write-time consent guard** in `writeEntry()`
    (`server/src/workspace/voice-library.ts`) — throws `ConsentRequiredError`
    when `provenance==='cloned'` and consent is structurally absent/invalid.
    `revokedAt` is deliberately **orthogonal** (spec §4.3, decision C2) — a
    revoke write still passes.
  - A reusable `VoiceRecorder` component
    (`src/components/voices/voice-recorder.tsx`) — getUserMedia + MediaRecorder,
    with a `denied` phase that surfaces an Upload-tab fallback instead of a
    dead end.
- **Invariants preserved:**
  - Cross-book matcher exclusion for cloned-provenance voices — **already
    shipped in Wave 1** (`library-cast-scan.ts:81`, spec §4.4). No new
    matcher work in 3a.
  - The Qwen `.pt` cache location is unchanged (`voices/qwen/qwen-<uuid>.pt`)
    — `master.wav` is a **new sibling file** in the entry directory, not a
    relocation (spec §2.2).
  - Everything in 3a is gated by the pre-existing `voices.library.enabled`
    config key (`server/src/config/registry.ts:645`); flipping it off hides
    the routes and UI with no other behaviour change.
- **Migration story:** additive only — pre-Wave-3 entries have no `master`
  field and are unaffected; `sampleTranscript` stays in sync with
  `master.transcript` per spec §2.1.
- **Reversibility:** every route/component in this plan is inert unless
  `voices.library.enabled` is on AND (for the consent guard/revoke
  route/cloned-section UI) a 3b1 caller exists to reach them — see "Not in
  3a" below. Reverting the branch is a clean no-op for any existing entry.

## Invariants to preserve

1. **Consent-at-write guard validates structure only.** `writeEntry()`
   (`server/src/workspace/voice-library.ts`) throws when a `cloned` entry's
   `consent` is missing `personName`/`relationship`/`permittedUse`/
   `attestedAt`/`attestedBy`; `revokedAt` is never checked here (spec §4.3,
   C2) — the `/revoke` write must pass this same guard unchanged.
2. **Quality gate thresholds (`server/src/tts/clone-quality.ts`).** Fatal:
   duration < 4 s, or RMS ≤ −45 dBFS (silence). Warn (non-blocking): 4–8 s
   (short), or ≥0.5% of samples clipped (≥ −0.1 dBFS). Ingest caps at 60 s
   (`server/src/tts/clone-ingest.ts`'s `MAX_SECONDS`).
3. **`master.wav` is a real RIFF/WAVE file, written without a second ffmpeg
   spawn.** `encodePcmToWav()` (`server/src/tts/wav.ts`) writes a ~20-line
   Node header over PCM that `decodeAudioToPcm` already produced (spec §2.2).
4. **The sample route 403s on a revoked or consent-absent cloned voice.**
   `server/src/routes/voice-library.ts:370` — `provenance === 'cloned' &&
   (!entry.consent || entry.consent.revokedAt)` → 403, so a revoked person's
   card can no longer be played.
5. **The `/clone-sample` route is a literal path, not `/:voiceUuid`-shaped.**
   Registered as `POST /clone-sample` (`voice-library.ts:520`) ahead of any
   single-segment `:voiceUuid` route, so it cannot be shadowed regardless of
   Express route-registration order (spec §4.2).
6. **The recorder never dead-ends on a permission denial.** `VoiceRecorder`'s
   `denied` phase (`voice-recorder.tsx`) surfaces copy pointing at the
   Upload tab rather than leaving the user stuck.
7. **Everything here is gated by `voices.library.enabled`.** No route or UI
   surface in this plan is reachable with the flag off.

## Test plan

### Automated coverage

- Vitest server (`server/src/tts/clone-quality.test.ts`) — fatal on <4s and
  on silence; warns on 4–8s and on clipping; a clean 10s+ sample passes with
  no warnings.
- Vitest server (`server/src/tts/wav.test.ts`) — round-trips PCM through
  `encodePcmToWav()` into a valid, parseable RIFF/WAVE header.
- Vitest server (`server/src/tts/clone-ingest.test.ts`) — decode → gate → cap
  → WAV → candidate-store → transcript end-to-end; a too-short/silent input
  throws `CloneIngestError` (400).
- Vitest server (`server/src/tts/decode-audio-to-pcm.test.ts`) — a new
  webm/opus fixture (`server/src/tts/__fixtures__/recorder-sample.webm`)
  decodes cleanly, covering the MediaRecorder record-path acceptance gate
  (spec §4.1's webm/opus caveat).
- Vitest server (`server/src/workspace/clone-candidate.test.ts`) — write/read/
  remove round-trip for the ephemeral candidate store; path containment
  (`assertContained`) holds for a hostile `candidateId`.
- Vitest server (`server/src/workspace/voice-library.store.test.ts`) — the
  consent guard throws on a `cloned` entry with missing/invalid consent,
  passes on a structurally-complete one, is a no-op for non-cloned
  provenances, and **permits a revoke write** (`revokedAt` set, consent
  otherwise unchanged).
- Vitest server (`server/src/routes/voice-library.test.ts`) — `POST
  /clone-sample`: 202 + candidate/transcript on a good clip, 400 on a
  too-short/unusable one; `POST /:voiceUuid/revoke`: 200 + `revokedAt`
  stamped, 404 on an unknown uuid, 409 when the entry has no consent record
  to revoke; the sample route's new 403 on revoked/consent-absent cloned
  entries; all three gated behind `voices.library.enabled` (404 when off).
- Vitest unit (`src/components/voices/voice-recorder.test.tsx`) — granted
  (record → stop → blob), denied (falls into the `denied` phase with the
  Upload-tab fallback copy), and re-take flows.
- Vitest unit (`src/components/voices/clone-capture-panel.test.tsx`) — the
  consent form's required fields gate Advance; a completed sample + consent
  enables it.
- Vitest unit (`src/components/voices/voice-library-card.clone.test.tsx`,
  `voice-provenance-badge.test.tsx`) — a cloned entry renders the 'Cloned'
  badge + a Revoke action; clicking Revoke (after the confirm) dispatches
  `revokeVoice`.
- Vitest unit (`src/store/voice-library-slice.clone.test.ts`) — `cloneSample`/
  `revokeVoice` thunks call the right `api.*` functions and update state on
  success/failure.
- Vitest unit (`src/lib/api.voice-library.test.ts`) — `cloneVoiceSample`/
  `revokeVoiceLibraryEntry` real+mock pairs match the OpenAPI shapes.

No new Playwright e2e in 3a — see "Not in 3a" below.

### Manual acceptance walkthrough

Run against the real server (`voices.library.enabled` on) since 3a's ingest
pipeline depends on real ffmpeg decode + Whisper transcription — mock mode
only exercises the frontend thunks/components in isolation.

1. `POST /api/voice-library/clone-sample` with a clean ≥8s clip (multipart
   `audio` field). Expected: `202` with `{ candidateId, transcript,
   durationSeconds, sampleRate, qualityWarnings: [] }`.
2. Same route with a 2-second clip. Expected: `400` with an error naming the
   too-short duration.
3. Attempt to persist a `cloned`-provenance entry with no `consent` block
   (or one missing `attestedAt`) via `writeEntry()`. Expected:
   `ConsentRequiredError` thrown, entry never written.
4. `POST /api/voice-library/:voiceUuid/revoke` against an existing
   cloned entry with a valid consent record. Expected: `200`, and re-reading
   the entry shows `consent.revokedAt` set while the rest of `consent` is
   unchanged.
5. `POST /api/voice-library/:voiceUuid/sample` (existing audition route)
   against that now-revoked entry. Expected: `403`, "This cloned voice has
   no valid consent and cannot be played."
6. In a browser with mic permission denied, open the recorder component.
   Expected: the `denied` phase renders, pointing at the Upload tab instead
   of leaving a dead control.
7. Open `#/voices` → My voices, on a book with an existing cloned entry
   (seeded via fixture, since 3a itself cannot create one — see below).
   Expected: the card shows the 'Cloned' badge and a "Revoke" button;
   clicking it (after the confirm dialog) calls `POST …/revoke` and the
   card updates.

## Out of scope — "Not in 3a" (→ 3b1 / 3b2 / 3c)

Per spec §1.1's sub-wave table and its "3a honesty note": 3a persists **no
cloned entry at all**. Phase 1 (`POST /clone-sample`) yields only an
*ephemeral candidate* under `_candidates/<id>/`; §7 of the spec forbids a
half-formed entry, so the **first** cloned entry is written by 3b1's `POST
/clone`. Concretely, still missing after 3a:

- **No actual clone extraction on either engine.** `POST /qwen/clone-voice`
  (Qwen `create_voice_clone_prompt`) is 3b1; `POST /xtts/clone-voice`
  (`get_conditioning_latents` + low-level `inference`) is 3c.
- **No `POST /api/voice-library/clone` (phase 2).** The route that actually
  derives an engine artifact, previews it, runs ECAPA, and persists the
  first real entry — 3b1.
- **No wired wizard entry point.** The recorder + `clone-capture-panel.tsx`
  are phase-1 *building blocks*; there is no reachable "clone a voice"
  button/route in the product yet that assembles them into a flow a user
  can start end-to-end (that assembly, plus phase 2's progress/audition/save
  screen, is 3b1).
- **No GPU synth of any kind.** Nothing in 3a loads Qwen Base, VoiceDesign,
  or Coqui XTTS.
- **The consent-at-write guard, `/revoke` route, and cloned-section card
  states (Revoke button, 'Cloned' badge) have no reachable production
  caller until 3b1 ships the first entry that could exist to revoke or
  display.** They are tested directly (fixtures/unit tests) and are a
  correct, load-bearing part of the store contract the whole wave depends
  on — but nothing in the shipped product can reach them through normal use
  until 3b1 lands.
- **No resolver / never-silent-substitution work** (spec §5) — that's 3b2,
  and it doesn't apply yet since no cloned voice can be cast.
- **No stat-before-remove / artifact purge on revoke or delete** (spec §5.6)
  — there are no derived artifacts (`.pt`/latents) to purge yet, since
  nothing derives one until 3b1/3c.
- **Cross-book matcher exclusion is unaffected** — already shipped in Wave 1
  (spec §4.4); no work here.

## Ship notes

_(to fill on ship)_
