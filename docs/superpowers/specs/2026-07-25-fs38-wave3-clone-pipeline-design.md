# fs-38 Wave 3 — voice clone pipeline (design)

> Status: design — awaiting approval → `writing-plans`
> Feature: fs-38 voice cloning · issue [#624](https://github.com/dudarenok-maker/Castwright/issues/624) · master doc [`docs/features/194-voice-cloning.md`](../../features/194-voice-cloning.md)
> Builds on: fs-38 Wave 1 (voice library store), merged `3d8e10f4` — this design references the **post-Wave-1** `main` seams by name.
> Supersedes the wave-ordering in doc 194 §"Delivery roadmap" (see _Scope_ below).

## 1. Summary & scope

Wave 1 shipped the book-independent voice library and **scaffolded** the cloning
data model — `provenance: 'cloned'`, `VoiceConsentRecord`, `VoiceSourceAttestation`,
`sampleTranscript`/`sampleMeta`, and a per-engine `VoiceLibraryEngineStatus`
lifecycle (`ready` | `deriving` | `stale` | `failed`) — all currently inert.
Wave 3 **activates** that scaffolding into a working clone pipeline.

A user brings a voice sample (record **or** upload), attests consent, and gets a
reusable **cloned** voice they can cast exactly like a designed one — rendered
consistently across a book and series, on **both** the Qwen and XTTS engines,
and **never silently substituted** for a different voice.

**In scope (this wave):**

- ffmpeg-based **audio ingest** (upload + in-app recording) with a quality gate
  and Whisper auto-transcription.
- **Consent/attestation gate** — hard-required, server-enforced, revocable.
- **Qwen clone** — extract the already-proven `create_voice_clone_prompt`
  back-half into a `POST /qwen/clone-voice` endpoint (refactor, not new ML).
- **XTTS clone** — **net-new** `get_conditioning_latents` extraction +
  low-level `inference` synthesis path (Coqui has zero clone plumbing today).
- **Two-phase clone wizard** (capture+consent → clone+preview) + a reusable
  in-app **recorder** component.
- **Retained `master.wav` for ALL library voices** (designed + cloned) as the
  single regenerable source; `.pt`/latents become pure derived caches.
- The **three-state resolver** enforcing never-silent-substitution.
- ECAPA **fidelity scoring** (warn-not-block).
- Cross-book reuse **exclusion** for cloned voices.

**Out of scope (later waves / doc 194 wave 5):** A/B compare of a clone vs. a
designed alternative in the wizard; drift-handling auditions for cloned voices;
any public/community sharing of cloned voices; the doc-194 "same-owner/same-consent"
cross-book relaxation.

### Scope note — wave ordering

Doc 194's roadmap sequences XTTS (wave 3) before Qwen (wave 4) and splits capture
(wave 2) from clone. This design deliberately **collapses doc-194 waves 2–4 into one
delivery** (the user opted into "both engines this wave" + "record and upload"),
and **inverts the engine emphasis**: Qwen clone is a refactor of proven code and is
the product's **default** generation engine, so it leads; XTTS is greenfield ML and
carries the heavier risk/test weight. The plan phases the work internally
(ingest+consent → Qwen → XTTS → recorder) so it stays reviewable.

## 2. Data model

All shapes below **extend the Wave-1 `VoiceLibraryEntry`**
(`server/src/workspace/voice-library.ts`); changes are additive and land
**OpenAPI-first** (`openapi.yaml` → `npm run openapi:types`).

### 2.1 Manifest (`voice.json`) additions

- `provenance: 'cloned'` — activated. Consent is **hard-required** for this value
  (see 2.3); the store refuses to write a `cloned` entry without a valid,
  non-revoked `consent`.
- `master?: VoiceMaster` — **new**, present for every voice that retains a source
  clip (all newly-created designed + cloned voices; absent on pre-Wave-3 entries):

  ```ts
  interface VoiceMaster {
    clipFile: string;              // 'master.wav', relative to the entry dir
    sampleRate: number;
    durationSeconds: number;
    transcript: string;            // ref_text for clone-prompt derivation
    transcriptSource: 'whisper' | 'user';
    captureMethod: 'upload' | 'record';
  }
  ```

  `sampleTranscript` (Wave-1) is kept in sync with `master.transcript` for
  backward compatibility; `master` is the authoritative copy going forward.

- `consent?: VoiceConsentRecord` — Wave-1 shape, **unchanged**, now populated for
  cloned voices:

  ```ts
  interface VoiceConsentRecord {
    personName: string;
    relationship: 'self' | 'family-with-permission' | 'guardian-of-minor';
    permittedUse: 'personal';     // fixed — doc-194 "personal use only" v1 stance
    attestedAt: string;
    attestedBy: string;
    revokedAt?: string;           // set → voice enters Broken (see §5)
  }
  ```

  The UI's three relationship choices map onto this shipped enum verbatim
  (self / my family, with permission / guardian of a minor). **No enum change.**

- `engines.{qwen,xtts}?: VoiceLibraryEngineStatus` — Wave-1 shape, **unchanged**,
  now the resolver's state source (§5). `status` ∈ `ready | deriving | stale | failed`;
  `baseModel` (Qwen) / `coquiVersion` (XTTS) stamp the model the artifact was
  derived against, for orphan detection.

### 2.2 On-disk layout (per voice, under the Wave-1 entry dir)

```
<WORKSPACE_ROOT>/voice-library/<voiceUuid>/
  voice.json          ← VoiceLibraryEntry manifest (Wave-1 store, atomic write)
  master.wav          ← retained normalized source clip     [NEW — the master]
  qwen.pt             ← derived Qwen clone prompt            (regenerable cache)
  xtts-latents.pt     ← derived XTTS conditioning latents    (regenerable cache)
  preview.mp3         ← last audition
```

`master.wav` is **never auto-deleted**; `qwen.pt` / `xtts-latents.pt` are freely
deletable and rebuildable from it. Storage-key scope stays `qwen-<voiceUuid>`
(Wave-1 convention), consistent across design/clone/sample/purge.

### 2.3 Designed voices also retain `master.wav` (deliberate change)

Today the Qwen design path **discards** its reference audio after distilling the
`.pt`. Wave 3 changes it to **retain** that synthetic reference clip as
`master.wav`. Rationale:

- **Deterministic orphan-repair for all voices.** Re-deriving from the retained
  clip returns a **byte-identical** voice; re-running the 1.7B VoiceDesign from
  the persona reloads a 4–5 GB model and **drifts** (non-deterministic output).
  The clip is the only exact-repair path.
- **Designed voices gain XTTS-eligibility for free** via the same clip→latents
  derive.
- **One derive path, zero special-casing** — "every library voice has a
  `master.wav`."

The asymmetry that remains is only at the provenance/consent layer: a designed
`master.wav` is synthetic and carries **no consent**; a cloned `master.wav` is
real audio and consent is **hard-required**.

## 3. Sidecar (`server/tts-sidecar/main.py`)

A shared contract: **"derive an engine artifact from a master clip"** —
`(master-clip PCM + ref_text) → persisted artifact + stamped derivation source`.

### 3.1 Qwen — `POST /qwen/clone-voice` (extraction, not new ML)

`create_voice_clone_prompt(ref_audio, ref_text)` already runs inline inside
`design_voice` (`main.py:~3759`). **Factor the shared distillation into one
helper**, called by both `design_voice` and the new endpoint (the exact pattern
of the Wave-1 `runVoiceDesign`/`postDesignAndCacheAudition` extraction).

- Input: master-clip PCM + `ref_text` + `voice_uuid`; output: writes `<uuid>.pt`,
  returns the stamped `baseModel`.
- **Does NOT load the 1.7B VoiceDesign** — clone is Base-0.6B-only; a cloned
  voice has the same resident VRAM profile as a designed one.
- **Invariant:** `design_voice` behaviour is byte-for-byte unchanged after the
  extraction (existing sidecar `test_*` + `server/src/routes/qwen-voice.test.ts`
  stay green — the regression guard).

### 3.2 XTTS — `POST /xtts/clone-voice` (net-new — the real ML work)

Coqui today uses only baked speaker names via the high-level `tts()` API — no
`get_conditioning_latents`, no `speaker_wav`. New work:

1. Load XTTS (auto-evicts the analyzer Ollama, as any Coqui `/load`), call
   `get_conditioning_latents(master_clip) → (gpt_cond_latent, speaker_embedding)`,
   persist both to `xtts-latents.pt`.
2. **New synthesis branch:** teach the Coqui synth path the **low-level**
   `tts_model.inference(text, lang, gpt_cond_latent, speaker_embedding)` call for
   latents-backed voices, alongside the existing baked-speaker path. This branch
   is the load-bearing net-new code and gets the heaviest new pytest coverage.

### 3.3 ref_text — Whisper auto-transcribe

`create_voice_clone_prompt` needs the clip transcript. The in-stack Whisper
`/transcribe` (srv-31) auto-fills it; the user may edit before committing.
`transcriptSource` records `whisper` vs `user`.

### 3.4 Fidelity — ECAPA, warn-not-block

After the phase-2 preview renders, embed the master clip and the rendered preview
via the existing `POST /embed` (192-d ECAPA) and cosine-score them
(`server/src/tts/embed-client.ts` + `render-integrity/score.ts::cosineToCentroid`
already exist). Below a threshold → a **non-blocking** wizard warning. Never gates
the save. (A `speaker_distance` Base-0.6B path also exists as a fallback scorer.)

## 4. Server (`server/src/`)

### 4.1 Ingest pipeline

Both capture paths converge:

1. Multipart upload (multer `memoryStorage`, the `routes/cover.ts` pattern) **or**
   a recorded-blob POST → `decodeAudioToPcm` (`tts/mp3.ts`, real ffmpeg) →
   normalize to the clone sample-rate + mono → write `master.wav`.
2. **Quality gate:** duration bounds, clip/peak detection, silence/noise floor.
   **Cloning-fatal** input (too short, all-silence) **blocks phase 1**; soft
   issues become non-blocking `qualityChecks` warnings surfaced on the wizard.
3. Whisper `/transcribe` → editable `ref_text`.

### 4.2 Routes (new `voice-library` sub-routes, gated by `voices.library.enabled`)

- `POST /api/voice-library/clone-sample` **(phase 1)** — audio in → ingest →
  ephemeral **candidate** `{ candidateId, transcript, durationSeconds, sampleRate,
  qualityChecks, clipPreviewUrl }`. No entry, no consent yet.
- `POST /api/voice-library/clone` **(phase 2)** — `{ candidateId, name, consent,
  targetEngine }` → **consent hard-validated first** (invalid → 4xx, no entry) →
  derive the active engine artifact from `master.wav` (Qwen default) → render
  preview → ECAPA score → persist the manifest entry (`provenance:'cloned'`,
  `consent`, `master`, `engines.<active> = {status:'ready', baseModel/coquiVersion}`).
  Returns entry + preview + advisory fidelity.
- `POST /api/voice-library/:uuid/revoke` — stamps `consent.revokedAt`; voice
  hidden + rendering enters Broken (§5).
- **Internal `deriveEngineArtifact(uuid, engine)`** — not a public route: when a
  cloned/library voice is resolved for engine X and `engines.X` is absent, `stale`,
  or its stamped `baseModel`/`coquiVersion` ≠ current, set `status:'deriving'`,
  call the sidecar clone endpoint, then stamp `status:'ready'`. One function; serves
  engine-switch **and** orphan self-heal.

Clone routes reuse the Wave-1 `SidecarDesignError` (which already carries
`status`/`code`/`reason`), so sidecar 503/502/500 semantics are **preserved
end-to-end from the start** — this design absorbs follow-up **#1801** rather than
inheriting the signal-loss.

### 4.3 Resolution — `pickVoiceForEngine` + render pipeline

See §5. The resolver reads `engines.<engine>.status` + `master` presence + consent
state and returns one of three outcomes.

### 4.4 Cross-book reuse exclusion

The matcher (`server/src/routes/voice-match.ts`) excludes `provenance:'cloned'`
outright in v1 — a person's voice is never offered back to an unrelated book.

## 5. Never-silent-substitution — the three-state resolver

The invariant this feature exists to protect. Threaded through `pickVoiceForEngine`
(`server/src/tts/voice-mapping.ts`) and the render pipeline, driven by the Wave-1
`VoiceLibraryEngineStatus` lifecycle:

| State | Condition | Behaviour |
|---|---|---|
| **Healthy** | `engines.<e>.status==='ready'`, `baseModel`/`coquiVersion` current, consent valid/non-revoked | render normally |
| **Repairable** | `master.wav` present, but artifact absent / `status==='stale'` / stamped model stale | **transparently derive** (`deriving`), surfaced as a "preparing voice…" step, then render — **never substitute** |
| **Broken** | `master.wav` missing/deleted **or** consent revoked **or** derive `failed` | raise typed `UnresolvableClonedVoiceError` — **do not substitute** |

**Broken** hard-blocks **only the affected characters** (the render continues for
every other character) with a **named** error
(`Cloned voice "X" unavailable: master sample missing / consent revoked`) and a
repair (re-upload the sample) / reassign (pick another voice) prompt. This is the
deliberate opposite of the documented silent Qwen→Kokoro fallback.

**Derive/repair is stat-before-remove:** a re-derive writes the new artifact to a
temp path, **stats/verifies it, then swaps** — the working artifact is never
removed before its replacement is verified. This absorbs follow-up **#1804**.

**Revocation bites in-flight renders:** stamping `revokedAt` moves the voice to
Broken; an in-flight render hard-blocks that voice's characters rather than
silently continuing, and the voice disappears from new-assignment surfaces.

## 6. Frontend (`src/`)

### 6.1 Two-phase clone wizard (new modal, following Wave-1 create/redesign patterns)

**Phase 1 — Capture & consent.** Segmented `[ Record | Upload ]`:

- *Record:* `getUserMedia → MediaRecorder`, live level/clip meter, running timer
  with min/max guidance, re-take loop, explicit mic-permission UX (request →
  granted / denied-with-recovery-hint; LAN HTTPS satisfies secure-context).
- *Upload:* drop an audio file.
- Both → `POST clone-sample` → shows the **editable transcript**, duration, quality
  warnings, then the **consent form** (person name, relationship, permitted-use note,
  required "I attest I have this person's permission" checkbox). **Advance is
  disabled until the sample is acceptable AND consent is complete** — enforced in UI
  and re-validated server-side.

**Phase 2 — Clone & preview.** `POST clone` streams progress in the single-design
phase vocabulary (`loading-model → deriving → rendering`) → audition player +
**advisory** ECAPA fidelity note + name field → **Save** → lands in **My voices**,
cloned section. **No A/B compare in this wave** (single audition).

### 6.2 Reusable recorder component

Factored (getUserMedia + MediaRecorder + meter + re-take + permission states) for
later reuse; touch targets ≥44×44 and responsive across the three viewports per the
mobile protocol.

### 6.3 Library surfaces (`src/views/voices.tsx`)

- Cloned voices in **My voices** with a **'Cloned'** provenance badge (distinct
  from 'Designed'), consent summary (person + relationship), and a **Revoke** action
  (confirmation → `revokedAt`).
- **Broken/Repairable** states on the card: a "Needs repair" pill + re-upload
  affordance (master missing) or silent transparent re-derive (stale model).
- Reuse-gated — absent from cross-book "offer it back" surfaces.

### 6.4 Cast assignment

A cloned voice assigns like any library voice (`overrideTtsVoices` carrying
`libraryUuid` + `provenance:'cloned'`). Switching a character's engine triggers the
lazy per-engine derive, shown as a "preparing voice…" step.

### 6.5 Store & API

Extend the Wave-1 `src/store/voice-library-slice.ts` with clone thunks
(`cloneSample`, `clone`, `revoke`), candidate + wizard state. Paired `real`+`mock`
`src/lib/api.ts` entries; OpenAPI-first types. Consistent with Wave 1, the slice
stays **off** `broadcast-middleware`.

## 7. Error handling & atomicity

Through-line: **fail loud and named, never silent or half-committed.**

- Unsupported/corrupt file or ffmpeg decode failure → 4xx with a specific message;
  never a silent empty candidate.
- Mic permission denied / non-secure context → recorder shows recovery guidance and
  steers to the Upload tab.
- A `cloned` entry is **never persisted half-formed** — the manifest is written
  (atomic tmp+rename, Wave-1) only after artifact-derive **and** preview both
  succeed and consent re-validated. Until then only the candidate + `master.wav`
  exist.
- Sidecar clone errors keep their status (§4.2, #1801). XTTS load failure under VRAM
  pressure → named error, no silent engine degrade.
- Re-derive is stat-before-remove (§5, #1804); genuine derive failure → Broken.

**Two Wave-1 follow-ups are absorbed by this design** (#1801 signal-loss, #1804
stat-before-remove); note them as "delivered by Wave 3" if this ships first.

## 8. Testing strategy

Five harness tiers + e2e + a live-GPU acceptance, weighted toward greenfield XTTS
and the never-substitute invariant. Every new behaviour ships paired tests.

- **Frontend (Vitest + RTL):** slice thunks; wizard state machine; **consent gate
  disables Advance**; provenance badge; Broken/Repairable card states; recorder with
  mocked `getUserMedia`/`MediaRecorder` (granted / denied-fallback / re-take).
- **Server (Vitest + real ffmpeg):** ingest with real fixtures (fatal-short blocks,
  soft-noise warns); **consent hard-validation at the store layer** (cloned without
  valid consent refused); the **three-state resolver with the invariant asserted
  directly** — a Broken cloned voice raises `UnresolvableClonedVoiceError` **and
  provably does not resolve to any other voice** (guards against a placebo test that
  passes while the guard is dead code); cross-book exclusion; status-code
  preservation; atomicity (failure → no half-written entry); stat-before-remove on
  re-derive; orphan detection via model-stamp mismatch → transparent re-derive.
- **Sidecar (pytest):** `/qwen/clone-voice` yields a stable `.pt` **without loading
  the 1.7B** (explicit assertion) **and `design_voice` unchanged** after extraction
  (key regression); XTTS `get_conditioning_latents` stable + low-level `inference`
  yields PCM + no cross-request bleed; ECAPA fidelity returns a sane cosine.
- **E2E (Playwright):** upload → consent → clone → preview → save → **appears only
  in the cloned section** → assign → mock render; consent gate blocks advance;
  Broken-state repair prompt; cloned voice **not offered** cross-book. Upload is the
  deterministic golden path; recorder uses a synthetic media stream.
- **Golden-audio (opt-in, Suite A sidecar):** a cloned voice renders **consistent
  across chapters** (mirrors the Qwen design length/identity checks).
- **Live-GPU acceptance (owed, on-box):** a real sample renders **recognizable,
  consistent** on **both** engines; a simulated Base-model bump orphans then
  transparently re-derives to an **identical** voice; ECAPA score sane. This is the
  definition-of-done gate that cannot run in a mock environment.

## 9. Migration & reversibility

- **Additive:** no `cast.json` change; pre-Wave-3 entries keep their `provenance`
  and simply have no `master`/`consent`. `master.wav` retention starts for
  newly-created voices only (existing designed voices lazily gain a `master.wav`
  the next time they are re-derived, or stay persona-repairable).
- **Reversible:** the whole clone surface (wizard, cloned section, clone routes)
  stays behind the existing `voices.library.enabled` knob; disabling it hides
  cloning and leaves designed/imported voices untouched.
- **Local-only:** samples, artifacts, and renders never leave the machine; export
  remains explicit.

## 10. Open questions / assumptions to confirm at plan time

- Exact quality-gate thresholds (min/max clip seconds, peak/silence cutoffs) —
  pick concrete numbers in the plan, backed by the golden-audio fixture.
- Whether the recorder ships an on-device VAD/level gate or just a raw meter (lean
  raw meter for v1; VAD is polish).
- ECAPA warn threshold value — calibrate against the srv-36 spike data, not a
  guessed constant.
