---
status: active
shipped: null
owner: null
---

# 267 — fs-38 Wave 3: voice-clone pipeline (3a ingest/consent/recorder + 3b1 first Qwen clone)

> Status: active
> Key files: `server/src/tts/clone-ingest.ts`, `server/src/tts/clone-quality.ts`,
> `server/src/tts/wav.ts`, `server/src/tts/derive-engine-artifact.ts`,
> `server/src/tts/clone-fidelity.ts`, `server/src/workspace/clone-candidate.ts`,
> `server/src/workspace/voice-library.ts`, `server/src/routes/voice-library.ts`,
> `server/src/tts/synthesise-chapter.ts` (`applyQwenFallback` cloned-exemption,
> `UnresolvableClonedVoiceError`), `server/tts-sidecar/main.py`
> (`POST /qwen/clone-voice`), `src/components/voices/voice-recorder.tsx`,
> `src/components/voices/clone-capture-panel.tsx`,
> `src/modals/clone-voice-wizard.tsx`,
> `src/components/voices/my-voices-section.tsx` (Clone-a-voice CTA),
> `src/components/voices/voice-library-card.tsx`, `src/store/voice-library-slice.ts`,
> `openapi.yaml`
> URL surface: `#/voices` (My voices — a "Clone a voice" CTA opens the two-phase
> wizard: capture/consent → name + Save → audition + advisory fidelity warning →
> the new entry lands in My voices with the 'Cloned' badge + Revoke action, and
> is assignable to any character once its engine artifact is `ready`)
> OpenAPI ops: `POST /api/voice-library/clone-sample`,
> `POST /api/voice-library/clone`, `POST /api/voice-library/{voiceUuid}/revoke`

Source spec: [`docs/superpowers/specs/2026-07-25-fs38-wave3-clone-pipeline-design.md`](../superpowers/specs/2026-07-25-fs38-wave3-clone-pipeline-design.md)
Umbrella doc: [`194-voice-cloning.md`](194-voice-cloning.md) · fs-38 · [#624](https://github.com/dudarenok-maker/Castwright/issues/624)

## Benefit / Rationale

- **User (3a):** none directly — 3a was a **behind-the-flag engineering
  slice** (see spec §1.1's "3a honesty note"). Its payoff was entirely
  enabling: it let 3b1 ship the first user-visible clone without also having
  to build ingest/consent/recorder from scratch under review pressure.
- **User (3b1):** the first payoff of the _"even in your own voice"_ brand
  promise — bring a short sample (recorded or uploaded), attest consent, and
  Castwright distils a reusable voice you can cast on any character, with an
  audible fidelity check before you commit to it.
- **Technical:** establishes the shared "capture → gate → normalize →
  transcribe" pipeline every clone (Qwen 3b1, XTTS 3c) reads `master.wav`
  from, plus the write-time consent guard the whole wave's data model depends
  on (spec §4.3). 3b1 adds the derive→audition→persist orchestration
  (`POST /voice-library/clone`) on top without redesigning that contract.
- **Architectural:** locks in the on-disk contract (`master.wav` retained
  alongside the manifest, spec §2.2) and the OpenAPI shapes
  (`VoiceMaster`, `CloneSampleCandidate`) that 3b1's `POST /clone` extends
  rather than redesigns, and closes the **first** never-silent-substitution
  hole (spec §5) for the Qwen engine — a cloned voice now fails loud instead
  of being silently swapped when Qwen is unavailable.

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
  - **(3b1)** `deriveEngineArtifact(voiceUuid, 'qwen', input, opts)`
    (`server/src/tts/derive-engine-artifact.ts`) — the Node client for the
    sidecar's `POST /qwen/clone-voice`, reusing `withCapacityRetry` +
    `NoCapacityError` and throwing `SidecarDesignError` with the upstream
    status/code/reason preserved; the engine seam (`'qwen'` only for now)
    leaves a clean slot for 3c's XTTS variant.
  - **(3b1)** `assessCloneFidelity(masterPcm, previewPcm, sampleRate, opts)`
    (`server/src/tts/clone-fidelity.ts`) — an advisory ECAPA cosine check
    (module const `CLONE_FIDELITY_MIN`) that annotates the persisted entry
    with a warning rather than blocking the save.
  - **(3b1)** `POST /api/voice-library/clone`
    (`server/src/routes/voice-library.ts`) — the phase-2 orchestrator:
    reads the ephemeral candidate → `deriveEngineArtifact` → `assessCloneFidelity`
    → `writeEntry` (LAST step). First route that actually promotes a
    `_candidates/<id>/` output into a real, persisted cloned entry.
  - **(3b1)** `applyQwenFallback` cloned-voice exemption + new
    `UnresolvableClonedVoiceError` (`server/src/tts/synthesise-chapter.ts`) —
    a character cast to a cloned voice on the Qwen route never silently
    falls back to another voice when Qwen is unavailable; it throws instead.
  - **(3b1)** an assign-readiness gate on `POST /:voiceUuid/assign`
    (`server/src/routes/voice-library.ts`) — 409s assigning a cloned entry
    whose `engines.qwen.status !== 'ready'`, closing the "assign a
    never-derived cloned voice" hole a stale/demo entry could otherwise hit.
- **Invariants preserved:**
  - Cross-book matcher exclusion for cloned-provenance voices — **already
    shipped in Wave 1** (`library-cast-scan.ts:81`, spec §4.4). No new
    matcher work in 3a or 3b1.
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
  `voices.library.enabled` is on. With 3b1 landed, the consent guard/revoke
  route/cloned-section UI now have a real production caller (the wizard's
  `POST /clone`); reverting the whole Wave-3-to-date branch is still a clean
  no-op for any pre-existing, non-cloned entry.

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

### 3b1 invariants

8. **A cloned entry is never persisted half-formed.** `POST
   /api/voice-library/clone` (`server/src/routes/voice-library.ts`) runs
   `deriveEngineArtifact` → `assessCloneFidelity` → `writeEntry` (which
   internally re-runs `assertConsentForClone`) strictly in that order, and
   `writeEntry` is called **only as the last step** — if derive or the
   fidelity check throws, nothing is ever written to disk (spec §7).
9. **A cloned voice is never silently substituted.** `applyQwenFallback`
   (`server/src/tts/synthesise-chapter.ts`) throws
   `UnresolvableClonedVoiceError` when a character's Qwen slot is
   `provenance==='cloned'` and Qwen is unavailable, instead of falling back
   to another voice — closing the **first** never-silent-substitution hole
   (spec §5) for the Qwen engine. All other fallback paths are unchanged.
10. **A cloned voice can't be assigned before its engine artifact is ready.**
    `POST /:voiceUuid/assign` 409s when `entry.provenance==='cloned' &&
    entry.engines?.qwen?.status !== 'ready'` — the wizard only ever creates
    ready entries, so this guards a stale/never-derived cloned entry (or a
    seeded fixture) rather than anything the golden path produces.
11. **`SidecarDesignError` status is preserved across the sidecar-transport
    module boundary by duck-typing the error shape, not `instanceof`.** The
    `POST /clone` route's catch checks `sde?.name === 'SidecarDesignError' &&
    typeof sde.status === 'number'` rather than `instanceof
    SidecarDesignError`, so a genuine cross-module error (e.g. surfaced
    through a mocked `deriveEngineArtifact`/`assessCloneFidelity` in tests)
    still branches to the right 503/502/500 instead of falling through to a
    generic 500 (regression class of #1801).
12. **The transcript the clone was distilled against is the one persisted.**
    `POST /clone` accepts an optional `transcript` (`CloneVoiceRequest`,
    capped at 2000 chars) and prefers it over the candidate's Whisper text as
    the derive's `refText` when non-blank, writing that same value to
    **`master.transcript`** as well as `sampleTranscript`. Persisting to
    `master.transcript` is load-bearing, not cosmetic: the 3b2 repair path
    re-derives from `entry.master.transcript` (`readMasterPcmDefault`,
    `server/src/tts/synthesise-chapter.ts`), so a correction stored only in
    `sampleTranscript` would be silently reverted to the Whisper text by the
    next repair. `master.transcriptSource` is decided server-side by comparing
    against the candidate's stored text — never from a client-supplied flag —
    so the persisted text and its recorded source can't disagree. Blank input
    falls back to the stored transcript (Whisper can legitimately return an
    empty transcript for a non-speech clip); over-length is a 400, never a
    truncation. The UI deliberately carries **no textarea `maxLength`** — a
    browser-side cap would silently drop the tail of a long paste and persist
    half a correction as `transcriptSource: 'user'` — and instead blocks
    Continue with a visible reason while the field is still on screen and
    editable, since the panel unmounts after Continue and a server 400 would
    leave nowhere to fix it. The 2000-char cap is enforced in characters only,
    chosen so the base64 `X-Ref-Text` header stays bounded in BYTES for
    multi-byte scripts (worst case 3 bytes per UTF-16 unit → ≤6000 bytes →
    ≤8000 base64); a separate byte check would be unreachable at that cap, and
    a test derives the arithmetic from the constant so raising it without
    redoing the sums fails (#1836). **`mockCloneVoice` enforces the same cap**,
    so mock/e2e mode is never more permissive than the real server on the one
    rejection the wizard can surface. The number lives in four places — the
    route's `MAX_CLONE_TRANSCRIPT_CHARS`, the frontend's
    (`src/lib/clone-transcript-limit.ts`, its own module so a `vi.mock` of
    `lib/api` can't blank the panel's guard), `openapi.yaml`'s `maxLength`, and
    the types generated from it — with a test on each side of the wire pinning
    its copy against the contract.

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

No new Playwright e2e in 3a — added in 3b1 (below).

### 3b1 automated coverage

- Pytest sidecar (`server/tts-sidecar/tests/test_qwen_clone_voice.py`) —
  `POST /qwen/clone-voice` clip-distil happy path + error shapes.
- Vitest server (`server/src/tts/derive-engine-artifact.test.ts`) — a
  successful derive; `SidecarDesignError` with the upstream 503/status/code
  preserved; an unsupported engine (e.g. `'xtts'`) rejects with
  `SidecarDesignError` too.
- Vitest server (`server/src/tts/clone-fidelity.test.ts`) — a high-cosine
  pair returns no warning; a low-cosine pair returns a warning string below
  `CLONE_FIDELITY_MIN`.
- Vitest server (`server/src/routes/voice-library.clone.test.ts`) — `POST
  /clone`: 200 + `VoiceLibraryEntry` (with `sampleMeta.qualityChecks
  .cloneCosine`/`cloneFidelityWarning`) on a good candidate; 400 (no
  `candidateId`), 404 (unknown candidate), 409 (single-flight), 422 (bad
  consent), and 503/502/500 branched off a real `SidecarDesignError`
  instance from a mocked `deriveEngineArtifact` (not a plain object —
  proving the duck-type check actually works across the module boundary).
- Vitest server (`server/src/routes/voice-library.test.ts`) — the
  assign-readiness gate: 409 on a cloned entry with
  `engines.qwen.status !== 'ready'`, 200 on a ready one against a real
  seeded book/character.
- Vitest server (`server/src/routes/voice-library.test.ts`) — Invariant 12
  (#1836): an edited `transcript` is what reaches `deriveEngineArtifact`'s
  `refText` and lands in `sampleTranscript` + `master.transcript` with
  `transcriptSource: 'user'`; an unedited one stays `'whisper'`; a blank or
  non-string one falls back to the stored text; an over-length one 400s
  before any GPU work with the candidate left intact. Two guard tests derive
  from the exported `MAX_CLONE_TRANSCRIPT_CHARS`: one pins the byte arithmetic
  that justifies having no separate byte check, the other pins the constant
  against `openapi.yaml`'s `maxLength`. Both fail if the cap is raised alone.
- Vitest frontend (`src/components/voices/clone-capture-panel.test.tsx`) — the
  transcript textarea carries no `maxlength` attribute, and an over-cap value
  disables Continue with an on-screen reason instead of truncating or letting
  the user reach an unrecoverable server 400.
- Vitest frontend (`src/components/voices/clone-capture-panel.test.tsx`,
  `src/modals/clone-voice-wizard.test.tsx`) — the panel forwards the *edited*
  transcript via `onReady`, and the wizard forwards it on into the
  `cloneVoice` body. Both links of the panel → wizard → API chain are pinned
  separately, because #1836 was precisely a dropped hop in that chain.
- Vitest frontend (`src/lib/api.clone-voice.test.ts`) — `mockCloneVoice`
  mirrors the real precedence (supplied wins, blank/absent falls back,
  matching text stays `'whisper'`), so mock/e2e mode can't keep reproducing
  the bug the real route fixed. It also mirrors the route's **rejection**:
  over-cap throws and appends no entry, at-cap is accepted. A fourth test pins
  `MAX_CLONE_TRANSCRIPT_CHARS` against `openapi.yaml`'s `maxLength` — the
  frontend-side twin of the server's pin, so the cap can't drift on one side
  of the wire alone. All three were mutation-checked: raising the constant to
  6000 fails the pin, and deleting the mock's guard fails the rejection test.
- Playwright (`e2e/voice-library.spec.ts`, step 6) — the clone wizard's
  transcript field in a real browser: the ingested Whisper text lands in the
  box, an over-cap value disables Continue with the reason rendered on screen
  *and leaves the full text intact* for trimming, and a corrected value
  re-enables it. jsdom can't attest that the message renders beside the field
  the user has to fix. The assertion that the corrected text reaches the wire
  stays in Vitest — no view renders `sampleTranscript`, so there is nothing
  for the browser to observe without adding UI purely for the test.
- Vitest server (`server/src/tts/synthesise-chapter-cloned-exemption.test.ts`)
  — `applyQwenFallback` raises `UnresolvableClonedVoiceError` for a cloned
  Qwen-routed character when Qwen is unavailable, and leaves every other
  fallback path (designed voice, non-cloned override) unchanged.
- Vitest unit (`src/lib/api.ts` clone pair) — `realCloneVoice`/`mockCloneVoice`
  match the OpenAPI `CloneVoiceBody`/`VoiceLibraryEntry` shapes.
- Vitest unit (`src/store/voice-library-slice.clone.test.ts`) — `cloneVoice`
  thunk flips `clonePending` and appends the returned entry on success;
  resets `clonePending` on failure.
- Vitest unit (`src/modals/clone-voice-wizard.test.tsx`) — phase-1→phase-2
  flow, Save dispatches `cloneVoice`, the completion state shows the
  audition player and (when present) the advisory fidelity warning.
- Vitest unit (`src/components/voices/my-voices-section.clone.test.tsx`) —
  the "Clone a voice" CTA opens `CloneVoiceWizard`.
- Playwright e2e (`e2e/voice-library.spec.ts`) — extends the existing
  golden-path spec with a clone segment: CTA → upload + consent → name +
  Save → a ready cloned card appears in My voices (count 7→8) → assign it to
  a character via the profile-drawer My-voices picker → sample plays.

> **Known coverage gap (M4), owed on-box.** The capacity-admission-ON branch
> of `/qwen/clone-voice` (the sidecar's `if _capacity_admission_enabled(): …`
> path) is not exercised by the pytest suite above — admission defaults off
> in the test env. This mirrors the same, already-accepted gap on
> `/qwen/design-voice`; not a blocker for 3b1's automated pass/fail bar.

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
8. **(3b1)** Open My voices → "Clone a voice". Record or upload a clean
   ≥8s sample, fill in consent (person name / relationship / permitted use),
   attest, Continue, name the voice, Save. Expected: a progress state, then
   a completion screen with an audition player (and a fidelity warning if
   the ECAPA cosine is low); the new entry appears in My voices with the
   'Cloned' badge and is immediately assignable to a character.
9. **(3b1)** With Qwen unavailable (sidecar down / model unreachable),
   attempt to generate a chapter with a character cast to a cloned voice.
   Expected: the chapter fails loud (surfaces an error naming the cloned
   voice) rather than silently rendering in a substitute voice.

> **Owed — on-box live-GPU acceptance (spec §8), not yet run.** Steps 8/9
> above are describable from the automated suite's mocked seams but have not
> been walked on real hardware: (a) a real recorded/uploaded sample renders
> recognisably and consistently in the cloned voice across multiple lines,
> and the ECAPA cosine reads sane (not clamped to a mock constant); (b) the
> assign-readiness gate and the `applyQwenFallback` exemption behave the
> same against a live sidecar as they do against the vitest mocks. Track
> alongside the existing `/qwen/design-voice` on-box acceptance debt.

## Delivered in 3b1

Per spec §1.1's sub-wave table: 3a persisted **no cloned entry at all** —
phase 1 (`POST /clone-sample`) yielded only an *ephemeral candidate* under
`_candidates/<id>/`, and §7 of the spec forbids a half-formed entry. 3b1
closes that gap and ships the **first user-visible clone** on the default
Qwen engine:

- **Actual clone extraction on the Qwen engine.** `POST /qwen/clone-voice`
  (sidecar `server/tts-sidecar/main.py`, Qwen `create_voice_clone_prompt`)
  distils a reusable Qwen artifact from the ingested `master.wav`. (XTTS's
  `POST /xtts/clone-voice` remains 3c.)
- **`POST /api/voice-library/clone` (phase 2).** The orchestrator that
  actually derives the engine artifact, runs the advisory ECAPA fidelity
  check, and persists the **first real cloned entry** — `deriveEngineArtifact`
  → `assessCloneFidelity` → `writeEntry` (last step; see Invariant 8).
- **A wired wizard entry point.** `CloneVoiceWizard` (`src/modals/clone-voice-wizard.tsx`)
  assembles the phase-1 building blocks (recorder + `clone-capture-panel.tsx`)
  into an end-to-end flow, launched from a new "Clone a voice" CTA in My
  voices (`src/components/voices/my-voices-section.tsx`); phase 2 adds a
  name field, Save, and a completion screen with an audition player + the
  advisory fidelity warning.
- **The consent-at-write guard, `/revoke` route, and cloned-section card
  states now have a real production caller.** The wizard's `POST /clone`
  is the first path that writes a `provenance:'cloned'` entry, so the guard,
  Revoke, and the 'Cloned' badge are reachable through normal product use,
  not just fixtures.
- **The first never-silent-substitution hole is closed for Qwen** —
  `applyQwenFallback`'s cloned-voice exemption (Invariant 9). The **general**
  resolver / lifecycle work (spec §5) is still 3b2's; 3b1 only covers this
  one fallback path, not a resolver abstraction.
- **An assign-readiness gate** prevents casting a cloned voice before its
  engine artifact exists (Invariant 10).

## Out of scope — "Not in 3a / 3b1" (→ 3b2 / 3c)

Still missing after 3b1:

- **No clone extraction on XTTS.** `POST /xtts/clone-voice`
  (`get_conditioning_latents` + low-level `inference`) is 3c.
- **No resolver / lifecycle abstraction** (spec §5, beyond the single
  `applyQwenFallback` exemption 3b1 ships) — that's 3b2.
- **No stat-before-remove / artifact purge on revoke or delete** (spec §5.6)
  — 3b1 derives a `.pt` artifact but doesn't yet purge it on revoke/delete;
  that lands with 3b2's lifecycle work.
- **§2.3 designed-voice clip-persist was DEFERRED to 3b2** — recording a
  clip alongside a *designed* (non-cloned) voice's persona is out of scope
  for both 3a and 3b1.
- **Cross-book matcher exclusion is unaffected** — already shipped in Wave 1
  (spec §4.4); no work here.

## Ship notes

_(to fill when the whole Wave-3 arc — 3a through 3c — ships; 3b1 itself
shipped via its own PR, Refs #624.)_
