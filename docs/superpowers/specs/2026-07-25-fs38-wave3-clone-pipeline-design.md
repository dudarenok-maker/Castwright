# fs-38 Wave 3 — voice clone pipeline (design)

> Status: design — awaiting approval → `writing-plans` (plan sub-wave **3a** first)
> Feature: fs-38 voice cloning · issue [#624](https://github.com/dudarenok-maker/Castwright/issues/624) · master doc [`docs/features/194-voice-cloning.md`](../../features/194-voice-cloning.md)
> Builds on: fs-38 Wave 1 (voice library store), merged `3d8e10f4` — references the **post-Wave-1** `main` seams by name.
> Adversarial `assumption-checker` pass applied (2026-07-25); the four mislocated-mechanism claims below are the corrections it surfaced.

## 1. Summary & scope

Wave 1 shipped the book-independent voice library and **scaffolded** the cloning
data model — `provenance: 'cloned'`, `VoiceConsentRecord`, `VoiceSourceAttestation`,
`sampleTranscript`/`sampleMeta`, and a per-engine `VoiceLibraryEngineStatus`
lifecycle (`ready` | `deriving` | `stale` | `failed`) — all currently inert.
Wave 3 **activates** that scaffolding into a working clone pipeline: a user brings
a voice sample (record **or** upload), attests consent, and gets a reusable
**cloned** voice cast like a designed one — consistent across a book/series, on
**both** the Qwen and XTTS engines, and **never silently substituted**.

### 1.1 Sub-wave decomposition (the delivery unit)

The `assumption-checker` established that two engines + the never-substitute
resolver + a recorder in one PR cannot get a competent review, and that the
resolver work is materially more invasive than a single function change. Wave 3
therefore ships as **three independently-reviewable sub-waves**, each its own
plan + PR + acceptance. This design doc is the umbrella spec; **`writing-plans`
produces the 3a plan first**, and 3b/3c get their own plans when scheduled.

| Sub-wave | Scope | Ships alone? | Depends on |
|---|---|---|---|
| **3a — Ingest, consent, recorder** (no ML) | ffmpeg ingest (upload + recorder), quality gate, Whisper transcript, `master.wav` persistence + WAV writer, consent-at-write store enforcement, cloned-section UI shell, cross-book exclusion | Yes — capture + a persisted, consented (but not-yet-cloned) sample is a coherent slice | Wave 1 |
| **3b — Qwen clone + resolver** | `/qwen/clone-voice` extraction, `deriveEngineArtifact` (Qwen), the three-state resolver in `synthesise-chapter.ts` **+ sidecar fail-loud**, cast assignment, ECAPA fidelity, two-phase wizard wired to Qwen | Yes — the actual clone payoff on the **default** engine | 3a |
| **3c — XTTS clone** | `/xtts/clone-voice` (`get_conditioning_latents` + low-level `inference`), latents-backed Coqui synth branch + its fail-loud, designed-voice XTTS-eligibility (spike-gated), wizard engine choice | Yes — second engine for the same contract | 3b (reuses the resolver + derive contract) |

**XTTS API spike — GREEN (verified 2026-07-25):** `get_conditioning_latents(audio_path, …)`
(returns latents + speaker embedding) and low-level `inference(text, language,
gpt_cond_latent, speaker_embedding, …)` both exist on the installed
`coqui-tts 0.27.5` XTTS model (`…/TTS/tts/models/xtts.py:331,448`). 3c rests on
verified API, not an assumption. The remaining 3c risk is *quality* (does a clone
from a real clip / a synthetic Qwen clip sound right), not *feasibility*.

**Out of scope (later / doc 194 wave 5):** A/B compare of a clone vs. a designed
alternative in the wizard; cloned-voice drift auditions; **1.7B-native clone
prompts** (cloned voices render on the 0.6B Base only in v1 — no anchored-emotion
variant minting for cloned voices; see §5.4); any sharing of cloned voices; the
doc-194 "same-owner/same-consent" cross-book relaxation.

### 1.2 Wave-ordering note

Doc 194 sequences XTTS (wave 3) before Qwen (wave 4) and splits capture from clone.
This design collapses doc-194 waves 2–4 into the fs-38-Wave-3 umbrella and **inverts
the engine emphasis**: Qwen clone is a refactor of proven code and the product's
**default** engine, so it leads (3b); XTTS is greenfield and ships last (3c).

## 2. Data model

Additive extensions to the Wave-1 `VoiceLibraryEntry`
(`server/src/workspace/voice-library.ts`); all changes land **OpenAPI-first**
(`openapi.yaml` → `npm run openapi:types`). **Sub-wave 3a** owns the schema.

### 2.1 Manifest (`voice.json`) additions

- `provenance: 'cloned'` — activated. **Consent hard-required** for this value; the
  store refuses to write a `cloned` entry without a valid, non-revoked `consent`
  (see §4.3 for the *new* enforcement — it does not exist in Wave 1's `writeEntry`).
- `master?: VoiceMaster` — **new**, present for every voice retaining a source clip
  (all newly-created cloned voices; designed voices per §2.3):

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

  `sampleTranscript` (Wave-1) is kept in sync with `master.transcript`.

- `consent?: VoiceConsentRecord` — Wave-1 shape **unchanged**, now populated:
  `{ personName, relationship: 'self'|'family-with-permission'|'guardian-of-minor',
  permittedUse: 'personal', attestedAt, attestedBy, revokedAt? }`. The UI's three
  relationship choices map onto this shipped enum verbatim — **no enum change**.

- `engines.{qwen,xtts}?: VoiceLibraryEngineStatus` — Wave-1 shape **unchanged**, now
  the resolver's state source (§5). `status` ∈ `ready|deriving|stale|failed`;
  `baseModel` (Qwen) / `coquiVersion` (XTTS) stamp the model the artifact was derived
  against, for orphan detection.

### 2.2 On-disk layout (per voice, under the Wave-1 entry dir)

```
<WORKSPACE_ROOT>/voice-library/<voiceUuid>/
  voice.json          ← manifest (Wave-1 store, atomic tmp+rename)
  master.wav          ← retained normalized source clip     [NEW — the master]
  qwen.pt             ← derived Qwen clone prompt            (regenerable cache)
  xtts-latents.pt     ← derived XTTS conditioning latents    (regenerable cache)
  preview.mp3         ← last audition
```

`master.wav` is **never auto-deleted**; `.pt`/latents are freely rebuildable from
it. Storage-key scope stays `qwen-<voiceUuid>` (Wave-1 convention). **Note:** the
codebase has **no WAV writer** today — `encodePcmToAudio` (`tts/mp3.ts:52`) emits
only mp3/aac/opus. Writing `master.wav` is a **new ffmpeg `-f wav` container step**
(3a), not a reuse of an existing encoder.

### 2.3 Designed voices also retain `master.wav` (deliberate, additive change)

Today the Qwen design flow **discards** its reference clip **inside the sidecar** —
`design_voice` consumes `ref_audio` into `create_voice_clone_prompt` (`main.py:~3754`)
and returns only the *audition* PCM; the server never sees the clip. Retaining it
is therefore **net-new sidecar work** (persist/return the ref clip), owned by 3b.

- **This is strictly additive.** `design_voice`'s audition output and voice quality
  are unchanged; the *only* addition is persisting the reference clip. (The earlier
  "byte-for-byte unchanged" framing was wrong — the function *does* change, just
  additively. The regression guard is: audition PCM + `.pt` identical to before.)
- **Payoff:** deterministic orphan-repair for all voices; one derive path.
- **Caveat (down-ranked from "for free"):** deriving XTTS latents from a *synthetic*
  Qwen calibration clip is **quality-unvalidated** — gated behind the 3c golden-audio
  check, not assumed.

## 3. Sidecar (`server/tts-sidecar/main.py`)

Shared contract: **"derive an engine artifact from a master clip"** —
`(master-clip + ref_text) → persisted artifact + stamped derivation source`.

### 3.1 Qwen — `POST /qwen/clone-voice` (3b · extraction)

`create_voice_clone_prompt(ref_audio, ref_text)` is a Base-0.6B call taking an
*external* clip (`main.py:~3759`) — confirmed separable from the 1.7B design flow.
**Factor the shared distillation into one helper** called by both `design_voice`
and the new endpoint. Scope-honest caveat: the inline logic is embedded in
`design_voice`'s VRAM-arbitration / `_synth_lock` / cache-eviction machinery, so the
extracted helper is **narrower than "the whole back-half"** — the plan must isolate
exactly the clip→`.pt` step. Does **not** load the 1.7B VoiceDesign. **Regression
guard (mandatory tests):** existing sidecar `test_*` + `qwen-voice.test.ts` stay
green; the extraction's correctness rides entirely on these being written.

### 3.2 XTTS — `POST /xtts/clone-voice` (3c · net-new, API verified)

1. Load XTTS (auto-evicts the analyzer Ollama, as any Coqui `/load`), call
   `get_conditioning_latents(master.wav) → (gpt_cond_latent, speaker_embedding)`
   (`xtts.py:331`), persist both to `xtts-latents.pt`.
2. **New synth branch:** the Coqui synth path today calls only high-level
   `self._tts.tts(text, speaker, language)` with **baked** speakers
   (`main.py:1252`). Add a **low-level** `tts_model.inference(text, lang,
   gpt_cond_latent, speaker_embedding, …)` (`xtts.py:448`) branch for latents-backed
   voices. This branch **must fail loud** (§5.3) — it must NOT fall through to
   `FALLBACK_SPEAKER`.

### 3.3 ref_text — Whisper auto-transcribe (3a)

`create_voice_clone_prompt` needs the clip transcript. The in-stack Whisper
`POST /transcribe` (`main.py:4605`, srv-31) auto-fills it; user-editable.
`transcriptSource` records `whisper` vs `user`. *(Endpoint confirmed present.)*

### 3.4 Fidelity — ECAPA, warn-not-block (3b)

After the phase-2 preview renders, embed the master clip and the rendered preview
via `POST /embed` (192-d ECAPA, `main.py:4751`) and cosine-score
(`embed-client.ts` + `render-integrity/score.ts::cosineToCentroid`). Below a
threshold → a **non-blocking** wizard warning. Threshold calibrated against the
srv-36 spike data, not a guessed constant. *(Both endpoints confirmed present.)*

## 4. Server (`server/src/`)

### 4.1 Ingest pipeline (3a)

1. Multipart upload (multer `memoryStorage`, `routes/cover.ts` pattern) **or** a
   recorded-blob POST → `decodeAudioToPcm` (`tts/mp3.ts:501`, real ffmpeg,
   format auto-probed) → normalize (sample-rate + mono) → **write `master.wav` via
   the new ffmpeg `-f wav` step** (§2.2).
   - **webm/opus caveat:** MediaRecorder emits webm/opus; `decodeAudioToPcm`'s
     tested inputs are mp3/m4a/ogg, and webm-from-a-non-seekable-pipe (Matroska
     tail metadata) is probe-fragile. 3a **adds a webm/opus fixture** to
     `decode-audio-to-pcm.test.ts` as an acceptance gate for the record path.
2. **Quality gate:** duration bounds, clip/peak detection, silence/noise floor.
   Cloning-fatal input (too short / all-silence) **blocks phase 1**; soft issues →
   non-blocking `qualityChecks` warnings. Concrete thresholds chosen at plan time.
3. Whisper `/transcribe` → editable `ref_text`.

### 4.2 Routes (new `voice-library` sub-routes, gated by `voices.library.enabled`)

- `POST /api/voice-library/clone-sample` **(phase 1 · 3a)** — audio in → ingest →
  ephemeral **candidate** `{ candidateId, transcript, durationSeconds, sampleRate,
  qualityChecks, clipPreviewUrl }`. No entry, no consent yet.
- `POST /api/voice-library/clone` **(phase 2 · 3b)** — `{ candidateId, name, consent,
  targetEngine }` → **consent hard-validated first** (invalid → 4xx, no entry) →
  `deriveEngineArtifact` for the active engine → render preview → ECAPA score →
  persist entry. Returns entry + preview + advisory fidelity.
- `POST /api/voice-library/:uuid/revoke` **(3a)** — stamps `consent.revokedAt`.
- **Internal `deriveEngineArtifact(uuid, engine)` (3b/3c)** — not a public route:
  when a voice is resolved for engine X and `engines.X` is absent, `stale`, or its
  stamped model ≠ current → set `status:'deriving'`, call the sidecar clone endpoint,
  stamp `status:'ready'`. One function; serves engine-switch **and** orphan self-heal.

Clone routes reuse the Wave-1 `SidecarDesignError` (`design-voice-core.ts:33`), which
already carries `status`/`code`/`reason`, so sidecar 503/502/500 semantics are
**preserved end-to-end** — absorbing follow-up **#1801** rather than inheriting the
signal-loss.

### 4.3 Consent-at-write — NEW store enforcement (3a)

Wave-1 `writeEntry` (`voice-library.ts:109`) has **no validation hook** — it stamps
`updatedAt` and writes; `isValidEntry` only checks `voiceUuid`/`name`/`provenance`.
Consent-at-write is **net-new** and touches the **shared writer** (used by
designed/imported too). Design: add a guard that **throws** when
`provenance==='cloned'` and `consent` is absent or `revokedAt` is set. The guard
lives in `writeEntry` (single choke-point) so *every* caller is covered; its blast
radius (all provenances now pass through the check, no-op for non-cloned) is called
out and tested.

### 4.4 Cross-book reuse exclusion — via provenance projection (3a)

**Corrected location.** `voice-match.ts` scores against *other books' confirmed
cast* via `scanLibraryCharacters → projectLibraryVoice` (`:87`), and its
`LibraryVoice` shape carries **no `provenance` field** (`:73`) — a cloned voice
reaches it only as a cast override (`overrideTtsVoices.<e>.provenance`), which the
projection **drops**. Exclusion therefore requires **projecting `provenance`
through** `LibraryCharacterRecord → LibraryVoice` and filtering `cloned` there
(and excluding cloned entries from any voice-library reuse/assignment listing). A
test asserts a cloned voice never appears in a cross-book suggestion.

## 5. Never-silent-substitution — the resolver (3b)

The invariant this feature exists to protect. The `assumption-checker` corrected
**where** it lives.

### 5.1 It is NOT in `pickVoiceForEngine`

`pickVoiceForEngine` (`voice-mapping.ts:317`) is **pure/synchronous** — no
filesystem, no async, cannot read the manifest or call the sidecar. The resolver
does **not** go there.

### 5.2 It lives in the synth path

Real resolution + the existing Qwen→Kokoro fallback are in
`server/src/tts/synthesise-chapter.ts` (`resolveGroup`/`routeFor`/`applyQwenFallback`,
~`:930–970,1120–1177`) — a per-group, capacity-gated path. The three-state resolver
is injected **there**, before synth, made **async/stat-aware**:

| State | Condition | Behaviour |
|---|---|---|
| **Healthy** | `engines.<e>.status==='ready'`, stamped model current, consent valid | render normally |
| **Repairable** | `master.wav` present, artifact absent / `stale` / model stale | **transparently `deriveEngineArtifact`** ("preparing voice…"), then render — never substitute |
| **Broken** | `master.wav` missing/deleted **or** consent revoked **or** derive `failed` | raise typed `UnresolvableClonedVoiceError` — **do not substitute** |

### 5.3 The sidecar must also fail loud

**Critical, from the audit:** the sidecar *itself* silently substitutes — Coqui →
`FALLBACK_SPEAKER` (`main.py:1224–1238`), Kokoro → `FALLBACK_VOICE` (`:1286–1293`).
A missing clone artifact would be swapped **below** the Node resolver. So the
latents/`.pt`-backed clone-synth branches (§3.1/§3.2) **must reject** an
unknown/missing cloned voice with an error instead of falling through to
`FALLBACK_*`. Both layers (Node resolver + sidecar branch) are required; either
alone leaves a silent-substitution hole. Sidecar tests assert the clone branches
raise rather than substitute.

### 5.4 Blast-radius of the hard-block — a real design cost

The current model is **fail-fast**: `MissingDesignedVoiceError` thrown inside
`resolveGroup` aborts the **whole chapter** synth. The desired
"block only the affected characters, continue everyone else" is a **different
execution model** — net-new per-character orchestration in `synthesise-chapter.ts`,
not a given. **Plan-time decision:** implement per-character continue if tractable;
otherwise the acceptable **v1 floor** is fail-the-chapter-with-a-named-error +
repair/reassign prompt (still never a silent substitution — just coarser blast
radius). The invariant (no silent swap) holds under either; only the granularity
differs.

**1.7B path:** `create_voice_clone_prompt` also has a 1.7B derivation
(`main.py:~3940/4141`) for the emotion/instruct quality tier. v1 **excludes** cloned
voices from the 1.7B path — cloned voices render on the 0.6B Base only (no
anchored-emotion minting). A cloned voice routed to the 1.7B path resolves to its
0.6B artifact; 1.7B-native clone is a documented follow-up.

**Revocation bites in-flight renders:** `revokedAt` → Broken; the render hard-blocks
that voice's characters (per §5.4 granularity) rather than silently continuing.

**Stat-before-remove:** re-derive writes to a temp path, **stats/verifies, then
swaps** — the working artifact is never removed before its replacement is verified
(absorbs follow-up **#1804**).

## 6. Frontend (`src/`)

### 6.1 Two-phase clone wizard (3a shell → 3b/3c wiring)

**Phase 1 — Capture & consent (3a).** Segmented `[ Record | Upload ]`:
- *Record:* `getUserMedia → MediaRecorder`, live level/clip meter, timer with
  min/max guidance, re-take loop, explicit mic-permission UX (granted /
  denied-with-recovery → steer to Upload; LAN HTTPS satisfies secure-context).
- *Upload:* drop an audio file.
- Both → `POST clone-sample` → editable transcript, duration, quality warnings, then
  the **consent form** (person name, relationship, permitted-use note, required "I
  attest I have this person's permission" checkbox). **Advance disabled until sample
  acceptable AND consent complete** — enforced in UI **and** re-validated server-side.

**Phase 2 — Clone & preview (3b, +engine choice in 3c).** `POST clone` streams
progress in the single-design phase vocabulary (`loading-model → deriving →
rendering`) → audition player + **advisory** ECAPA note + name field → **Save** →
**My voices**, cloned section. **No A/B compare this wave** (single audition).

### 6.2 Reusable recorder component (3a)

Factored (getUserMedia + MediaRecorder + meter + re-take + permission states);
touch targets ≥44×44, responsive across the three viewports per the mobile protocol.

### 6.3 Library surfaces — `src/views/voices.tsx` (3a shell, 3b states)

- Cloned voices in **My voices** with a **'Cloned'** provenance badge, consent
  summary (person + relationship), **Revoke** action.
- **Broken/Repairable** card states: "Needs repair" pill + re-upload (master missing)
  or silent transparent re-derive (stale model).
- Reuse-gated — absent from cross-book surfaces (§4.4).

### 6.4 Cast assignment (3b)

Assigns like any library voice (`overrideTtsVoices` with `libraryUuid` +
`provenance:'cloned'`). Engine-switch triggers the lazy per-engine derive
("preparing voice…").

### 6.5 Store & API (3a slice, extended per sub-wave)

Extend Wave-1 `src/store/voice-library-slice.ts` with clone thunks (`cloneSample`,
`clone`, `revoke`) + candidate/wizard state. Paired `real`+`mock` `src/lib/api.ts`
entries; OpenAPI-first types. Stays **off** `broadcast-middleware` (Wave-1 choice).

## 7. Error handling & atomicity

Through-line: **fail loud and named, never silent or half-committed.**

- Corrupt/unsupported file or ffmpeg decode failure → 4xx specific message; never a
  silent empty candidate.
- Mic denied / non-secure context → recorder recovery guidance → Upload tab.
- A `cloned` entry is **never persisted half-formed** — manifest written (atomic
  tmp+rename) only after derive **and** preview succeed and consent re-validated.
- Sidecar clone errors keep status (§4.2, #1801); XTTS load failure under VRAM
  pressure → named error, no silent engine degrade.
- Re-derive stat-before-remove (§5, #1804); genuine derive failure → Broken.

**Absorbs Wave-1 follow-ups #1801 + #1804** — note as "delivered by Wave 3" (3b) if
this ships before they're separately addressed.

## 8. Testing strategy

Five harness tiers + e2e + live-GPU acceptance; **per sub-wave** so each PR is
self-verifying. Every new behaviour ships paired tests.

**3a (no ML):** ingest with real fixtures incl. the **webm/opus** case (fatal-short
blocks, soft-noise warns); WAV-writer output is a valid WAV; **consent hard-validation
at the store layer** (cloned without valid consent → `writeEntry` throws) with the
shared-writer no-op-for-others test; cross-book exclusion (cloned never suggested);
recorder component with mocked `getUserMedia`/`MediaRecorder` (granted /
denied-fallback / re-take); wizard phase-1 state machine + consent-gate-disables-Advance.

**3b (Qwen + resolver):** `/qwen/clone-voice` yields a stable `.pt` **without loading
the 1.7B** (explicit assertion) **and `design_voice` audition/`.pt` unchanged** after
extraction (regression); the **three-state resolver with the invariant asserted
directly** — a Broken cloned voice raises `UnresolvableClonedVoiceError` **and
provably resolves to no other voice** (guards the placebo-test trap); **sidecar
clone branch rejects an unknown cloned voice instead of `FALLBACK_*`**; orphan
detection → transparent re-derive; stat-before-remove; ECAPA fidelity returns a sane
cosine; e2e upload→consent→clone→preview→save→cloned-section→assign→mock-render.

**3c (XTTS):** `get_conditioning_latents` stable + low-level `inference` yields PCM +
no cross-request bleed; latents-backed synth fails loud on missing latents; golden-audio
check that a cloned voice (and a designed voice's synthetic-clip→latents) renders
**consistent across chapters** — this is where the down-ranked "synthetic clip →
XTTS" quality claim (§2.3) is validated or rejected.

**Live-GPU acceptance (owed, on-box, per sub-wave):** a real sample renders
**recognizable, consistent** on the target engine; a simulated Base-model bump
orphans then re-derives to an **identical** voice; ECAPA sane. Cannot run in mock.

## 9. Migration & reversibility

- **Additive:** no `cast.json` change; pre-Wave-3 entries keep `provenance`, have no
  `master`/`consent`. `master.wav` retention starts for new voices; existing designed
  voices lazily gain one on next re-derive, else stay persona-repairable.
- **Reversible:** the whole clone surface stays behind `voices.library.enabled`;
  disabling it hides cloning, leaves designed/imported voices untouched.
- **Local-only:** samples, artifacts, renders never leave the machine.

## 10. Open questions / plan-time decisions

- Quality-gate thresholds (min/max clip seconds, peak/silence cutoffs) — concrete
  numbers in the 3a plan, backed by a golden fixture.
- Recorder: raw level meter (lean v1) vs. on-device VAD (polish).
- ECAPA warn threshold — calibrate from srv-36 spike data.
- §5.4 blast-radius: per-character-continue vs. fail-chapter-with-repair v1 floor —
  decide in the 3b plan against how invasive per-character orchestration proves.
