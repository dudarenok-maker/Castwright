# fs-38 Wave 3 — voice clone pipeline (design)

> Status: design — awaiting approval → `writing-plans` (plan sub-wave **3a** first)
> Feature: fs-38 voice cloning · issue [#624](https://github.com/dudarenok-maker/Castwright/issues/624) · master doc [`docs/features/194-voice-cloning.md`](../../features/194-voice-cloning.md)
> Builds on: fs-38 Wave 1 (voice library store), merged `3d8e10f4` — references the **post-Wave-1** `main` seams by name.
> Reviewed by two independent adversarial passes (`assumption-checker` + Fable, 2026-07-25); their code-verified corrections are folded below.

## 1. Summary & scope

Wave 1 shipped the book-independent voice library and **scaffolded** the cloning
data model — `provenance: 'cloned'`, `VoiceConsentRecord`, `VoiceSourceAttestation`,
`sampleTranscript`/`sampleMeta`, a per-engine `VoiceLibraryEngineStatus` lifecycle
(`ready`|`deriving`|`stale`|`failed`), **and the cross-book matcher exclusion**
(`library-cast-scan.ts:81`) — most currently inert. Wave 3 **activates** that
scaffolding into a working clone pipeline: a user brings a voice sample (record or
upload), attests consent, and gets a reusable **cloned** voice cast like a designed
one — consistent across a book/series, on both the Qwen and XTTS engines, and
**never silently substituted**.

### 1.1 Sub-wave decomposition (the delivery unit)

Two engines + the never-substitute resolver + a recorder in one PR cannot get a
competent review, and the resolver work is materially more invasive than a single
function change. Wave 3 ships as **four independently-reviewable sub-waves**, each
its own plan + PR + acceptance. This doc is the umbrella spec; **`writing-plans`
produces the 3a plan first**; later sub-waves get their own plans when scheduled.

| Sub-wave | Scope | Nature |
|---|---|---|
| **3a — Ingest, consent, recorder** | ffmpeg ingest (upload + recorder), quality gate, Whisper transcript, `master.wav` write, OpenAPI schema, consent-at-write store guard, wizard **phase 1**, cloned-section UI shell, sample-route consent gate | **No-ML, behind-flag engineering slice.** CI-verifiable, no GPU. See honesty note below. |
| **3b1 — Qwen clone (happy path)** | `design_voice` clip-persist + `/qwen/clone-voice` extraction, `deriveEngineArtifact` (Qwen), `POST /clone`, wizard **phase 2**, save + cast assignment, ECAPA fidelity, **the C1 `applyQwenFallback` cloned-exemption** | **First user-visible clone**, on the default engine. Interim safety floor is real (Qwen already fails loud on a missing `.pt` — §3.1). |
| **3b2 — Resolver + lifecycle** | The three-state resolver as an async **per-chapter pre-pass** in `synthesise-chapter.ts`, transparent re-derive, orphan self-heal, revocation-at-render, stat-before-remove, the §5.4 blast-radius + §5.5 1.7B decisions | **The invasive synth-path work**, isolated so it can't block the payoff. |
| **3c — XTTS clone** | `/xtts/clone-voice` (`get_conditioning_latents` + low-level `inference`), latents-backed Coqui synth branch + its fail-loud, the coqui voice-key wire contract (§3.2), designed-voice XTTS-eligibility (spike-gated) | **Greenfield, API-verified.** Remaining risk is quality, not feasibility. |

**3a honesty note (per Fable).** Under this spec's own rules, 3a persists **no
cloned entry** — phase 1 (`POST clone-sample`) yields an *ephemeral candidate*, and
§7 forbids a half-formed entry, so the first entry is written by 3b1's `POST /clone`.
3a is therefore a **behind-the-flag engineering slice** whose UI dead-ends at the
consent screen; three of its items (the consent-at-write guard, the revoke route, the
cloned-section states) have **no reachable production caller until 3b1**. That is a
normal behind-flag merge in this repo — but it is *not* a user-facing feature on its
own. The store guard + schema live in 3a because they are the store contract the
whole wave builds on; the first ship a user notices is 3b1.

**XTTS API spike — GREEN (2026-07-25):** `get_conditioning_latents(audio_path, …)`
and low-level `inference(text, language, gpt_cond_latent, speaker_embedding, …)` both
exist on the installed `coqui-tts 0.27.5` XTTS model (`…/TTS/tts/models/xtts.py:331,448`).

**Out of scope (later / doc 194 wave 5):** A/B compare of a clone vs. a designed
alternative; cloned-voice drift auditions; any sharing of cloned voices; the doc-194
"same-owner/same-consent" cross-book relaxation. The **1.7B-native clone** question is
*not* punted — it is a live §5.5 decision because the sidecar auto-derives one today.

### 1.2 Wave-ordering note

Doc 194 sequences XTTS before Qwen and splits capture from clone; this design inverts
the engine emphasis (Qwen leads — it is the default engine and a refactor of proven
code). **The stale doc-194 roadmap + "XTTS reference path first" DoD text must be
updated in the same PR that lands 3a** (M4).

## 2. Data model

Additive extensions to the Wave-1 `VoiceLibraryEntry`
(`server/src/workspace/voice-library.ts`); all changes land **OpenAPI-first**.
**3a** owns the schema.

### 2.1 Manifest additions

- `provenance: 'cloned'` — activated; **consent hard-required** (see §4.3 — new
  enforcement, absent in Wave-1 `writeEntry`).
- `master?: VoiceMaster` — new: `{ clipFile:'master.wav', sampleRate, durationSeconds,
  transcript, transcriptSource:'whisper'|'user', captureMethod:'upload'|'record' }`.
  `sampleTranscript` kept in sync with `master.transcript`.
- `consent?: VoiceConsentRecord` — Wave-1 shape unchanged, now populated
  (`personName`, `relationship:'self'|'family-with-permission'|'guardian-of-minor'`,
  `permittedUse:'personal'`, `attestedAt`, `attestedBy`, `revokedAt?`). No enum change.
- `engines.{qwen,xtts}?: VoiceLibraryEngineStatus` — Wave-1 shape unchanged; the
  resolver's state source (§5). `status` ∈ `ready|deriving|stale|failed`;
  `baseModel`/`coquiVersion` stamp the derivation model for orphan detection.

### 2.2 On-disk layout (corrected per Fable I2)

**The `.pt` does NOT move into the entry dir** — the sidecar reads Qwen clone prompts
only from `QWEN_VOICES_DIR` (`<workspace>/voices/qwen/`, `main.py:~2828`; Node writes
via `qwenVoicePtPath`). Relocating it breaks every synth path.

```
<WORKSPACE_ROOT>/voice-library/<voiceUuid>/     <workspace>/voices/qwen/
  voice.json    ← manifest (atomic tmp+rename)    qwen-<voiceUuid>.pt   ← Qwen cache
  master.wav    ← retained source clip [NEW]
  preview.mp3   ← last audition
```

`master.wav` is never auto-deleted; `.pt`/latents rebuild from it. **`xtts-latents.pt`
location is an explicit 3c decision** (a `voices/xtts/` sibling vs. the entry dir),
gated on how the sidecar loads it (§3.2). Storage-key scope stays `qwen-<voiceUuid>`.
**No WAV writer exists** — either a ~20-line Node RIFF header over the normalized PCM
(no subprocess) or a new ffmpeg `-f wav` step; 3a plan picks one and says why (M1).

### 2.3 Designed voices also retain `master.wav` (additive)

Today the design flow **discards** its reference clip **inside the sidecar** —
`design_voice` consumes `ref_audio` into `create_voice_clone_prompt` (`main.py:~3754`)
and returns only the audition PCM. Retaining it is **net-new sidecar work** (3b1),
**strictly additive**: `design_voice`'s audition output and `.pt` are unchanged; the
only addition is persisting the clip (the regression guard). Payoff: deterministic
orphan-repair for all voices, one derive path. **Caveat:** deriving XTTS latents from
a *synthetic* Qwen calibration clip is quality-unvalidated — gated behind the 3c
golden-audio check, not assumed.

## 3. Sidecar (`server/tts-sidecar/main.py`)

Shared contract: **"derive an engine artifact from a master clip."**

### 3.1 Qwen — `POST /qwen/clone-voice` (3b1 · extraction)

`create_voice_clone_prompt(ref_audio, ref_text)` is a Base-0.6B call on an external
clip (`main.py:~3759`) — separable, but embedded in `design_voice`'s VRAM-arbitration
/ `_synth_lock` / cache-eviction machinery, so the extracted helper is **narrower than
"the back-half"**; the plan isolates exactly the clip→`.pt` step. Does not load the
1.7B. **Already fails loud on a missing `.pt`** (`VoiceNotDesignedError`,
`main.py:~4058` → 409 in `routes/voice-sample.ts:176`) — so 3b1's interim floor
(clone without the full resolver) is genuinely safe. Regression guard: existing
sidecar `test_*` + `qwen-voice.test.ts` stay green; `design_voice` audition/`.pt`
unchanged after extraction.

### 3.2 XTTS — `POST /xtts/clone-voice` (3c · net-new, API verified)

1. `get_conditioning_latents(master.wav) → (gpt_cond_latent, speaker_embedding)`
   (`xtts.py:331`), persist to `xtts-latents.pt`.
2. **New low-level synth branch:** the Coqui path today calls only high-level
   `self._tts.tts(text, speaker, language)` with baked speakers (`main.py:~1252`). Add
   a `tts_model.inference(...)` (`xtts.py:448`) branch for latents-backed voices that
   **fails loud** on missing latents — must NOT fall through to `FALLBACK_SPEAKER`
   (`main.py:1226-1238`).
3. **Wire contract (Fable I3 — must be designed in 3c):** `TtsEngine` has **no
   `'xtts'` id** — the XTTS engine *is* `'coqui'`; `engines.xtts` (manifest) maps to
   the `coqui` engine slot. Today `pickVoiceForEngine`'s coqui path returns the slot
   name verbatim (`voice-mapping.ts:343`) with **no `libraryUuid` branch** like qwen's
   (`:339`), so a cloned name would hit `FALLBACK_SPEAKER`. 3c must add: a coqui
   voice-key convention (e.g. `xtts-<uuid>`), the coqui-`libraryUuid` branch in
   `pickVoiceForEngine`, and how the latents path travels to the sidecar.

### 3.3 ref_text — Whisper `/transcribe` (3a) · 3.4 Fidelity — ECAPA `/embed`, warn-not-block (3b1)

Whisper `POST /transcribe` (`main.py:~4605`) auto-fills `ref_text` (user-editable;
`transcriptSource` records which). After the phase-2 preview, embed master + preview
via `POST /embed` (192-d ECAPA, `main.py:~4751`) and cosine-score
(`embed-client.ts` + `render-integrity/score.ts::cosineToCentroid`); below a
srv-36-calibrated threshold → **non-blocking** warning. Both endpoints confirmed present.

## 4. Server (`server/src/`)

### 4.1 Ingest pipeline (3a)

Multipart upload (multer `memoryStorage`, `routes/cover.ts`) **or** recorded-blob POST
→ `decodeAudioToPcm` (`tts/mp3.ts:501`, real ffmpeg, format auto-probed) → normalize
→ write `master.wav` (§2.2). **webm/opus caveat:** MediaRecorder emits webm/opus;
`decodeAudioToPcm`'s tested inputs are mp3/m4a/ogg and webm-over-a-non-seekable-pipe is
probe-fragile — 3a **adds a webm/opus fixture** to `decode-audio-to-pcm.test.ts` as the
record-path acceptance gate. **Quality gate:** fatal input (too short/all-silence)
blocks phase 1; soft issues → non-blocking `qualityChecks`. Whisper → editable `ref_text`.

### 4.2 Routes (gated by `voices.library.enabled`)

- `POST /api/voice-library/clone-sample` **(phase 1 · 3a)** → ephemeral candidate.
- `POST /api/voice-library/clone` **(phase 2 · 3b1)** → consent hard-validated first
  → `deriveEngineArtifact` (active engine) → preview → ECAPA → persist entry.
- `POST /api/voice-library/:uuid/revoke` **(3a)** → stamps `consent.revokedAt` (see the
  C2 guard carve-out, §4.3).
- **`POST /api/voice-library/:uuid/sample` consent gate (Fable I5 · 3a):** the existing
  sample route (`routes/voice-library.ts:~360`) synthesises via `qwen-<uuid>` with **no
  consent check** — after revocation the card's Play button would still speak the
  person. 3a adds a consent-valid gate here + a test.
- **Internal `deriveEngineArtifact(uuid, engine)` (3b1/3c)** — derives when
  `engines.X` is absent/`stale`/model-mismatched; serves engine-switch + orphan self-heal.

Clone routes reuse `SidecarDesignError` (carries `status`/`code`/`reason`) so 503/502/500
semantics are preserved — absorbing follow-up **#1801**.

### 4.3 Consent-at-write guard (3a) — with the C2 carve-out

Wave-1 `writeEntry` (`voice-library.ts:109`) has no validation hook. Add a guard at
that single choke-point that **throws when `provenance==='cloned'` and consent is
absent/invalid**. **Critical carve-out (Fable C2):** the guard must NOT block the
`/revoke` write — revocation persists `revokedAt` *through* `writeEntry`. So the guard
rejects *creation/use with absent-or-invalid consent* but **permits a write whose only
consent delta is adding `revokedAt`** (or an explicit `allowRevocation` option). Blast
radius (all provenances traverse the check, no-op for non-cloned) is tested.

### 4.4 Cross-book exclusion — ALREADY SHIPPED (Fable I1, corrected)

Wave 1 **already excludes** cloned-provenance assignments at the scan feeder
(`library-cast-scan.ts:81-83`, before projection, feeding both `voice-match.ts` and
`series-reuse-link.ts`). **No new matcher work.** What remains for Wave 3 is only:
keep cloned entries out of **automatic suggestion** surfaces — while **deliberate owner
assignment from My voices stays allowed** (reconciles with §6.4 and §1's reusable
premise; the earlier "exclude from any assignment listing" wording was wrong).

## 5. Never-silent-substitution — the resolver (3b2, except the 3b1 exemption)

### 5.1 It is NOT in `pickVoiceForEngine`
Pure/synchronous (`voice-mapping.ts:317`) — no fs, no async. The resolver isn't there.

### 5.2 It is an async per-chapter PRE-PASS (Fable I4)
`resolveGroup` is synchronous with ~17 call sites, some inside sync `map`/`filter`
expressions — making *it* async is a rewrite, and deriving mid-render would contend
with synth batches for `_synth_lock` + the VRAM semaphore. Instead: an **async pre-pass
resolves + derives + consent-checks every cloned voice in the chapter's cast BEFORE the
group loop**; the sync `resolveGroup` then consumes pre-resolved state. `synthesiseChapter`
has three callers (`generation.ts:1583`, `chapter-splice.ts:310`, `chapter-qa-repair.ts:437`)
— the pre-pass sits at that single shared entry, which is why the resolver belongs here.

| State | Condition | Behaviour |
|---|---|---|
| **Healthy** | `engines.<e>.status==='ready'`, model current, consent valid, engine available | render normally |
| **Repairable** | `master.wav` present, artifact absent/`stale`/model-stale | pre-pass **derives** ("preparing voice…"), then render |
| **Broken** | `master.wav` missing **or** consent revoked **or** derive `failed` **or engine unavailable** (see 5.3) | typed `UnresolvableClonedVoiceError` — **never substitute** |

### 5.3 Close BOTH substitution holes
- **Node (Fable C1 — the big one, lands in 3b1):** `applyQwenFallback`
  (`synthesise-chapter.ts:946`) reroutes a Qwen group to Kokoro/Coqui when
  `qwenUnavailable`. A cloned voice has a name, so `!voiceName` never fires, but
  `qwenUnavailable` **does** — silently swapping a real person's voice. **Cloned-provenance
  groups are exempt from `applyQwenFallback`; `qwenUnavailable` + cloned → Broken.** This
  is the minimum guard 3b1 must ship with its happy path, ahead of the full 3b2 resolver.
- **Sidecar:** the latents/`.pt` clone-synth branches (§3.1/§3.2) must reject an
  unknown cloned voice, not fall through to `FALLBACK_SPEAKER`/`FALLBACK_VOICE`
  (`main.py:1226-1238,1286-1293`). Qwen already does (`VoiceNotDesignedError`); the
  genuinely new fail-loud work is the **XTTS branch (3c)**.

### 5.4 Hard-block blast-radius (3b2 decision)
Current model is fail-fast — `MissingDesignedVoiceError` aborts the whole chapter.
"Block only the affected character, continue the rest" is a **different execution
model** (net-new pre-pass orchestration). v1 floor if per-character proves too invasive:
fail-the-chapter-with-a-named-repair-prompt (still never a silent swap; coarser blast
radius). Revocation realistically bites **at the next chapter boundary** (per-chapter
pre-pass + group cache), not mid-chapter (M3) — state it that way.

### 5.5 1.7B path (3b2 decision — NOT a free exclusion · Fable C3)
`_load_voice_prompt_17b` (`main.py:~4076`) **auto-derives** a 1.7B-native clone prompt
from the 0.6B `.pt` on cache miss, and fs-56 tiering is **elevate-only** (no downgrade)
— so a book run at 1.7B default would silently mint a 1.7B prompt of the real person's
voice, contradicting §1's "0.6B-only" line. The 3b2 plan must choose: **(a)** allow the
auto-derive — simplest, but the derived `<voice>__1.7b.pt` becomes another
**consent-scoped artifact** revocation must erase; or **(b)** an active gate —
per-character downgrade for cloned provenance in `routeFor` + hiding the tier control
for cloned characters — net-new UI that deliberately breaks the elevate-only invariant.

### 5.6 Stat-before-remove
Re-derive writes to temp, stats/verifies, then swaps (absorbs **#1804**).

## 6. Frontend (`src/`)

- **Two-phase wizard:** phase 1 (3a) — segmented `[Record|Upload]`, recorder
  (getUserMedia + MediaRecorder + meter + re-take + mic-permission→Upload fallback),
  editable transcript, consent form; **Advance disabled until sample OK AND consent
  complete** (UI + server-re-validated). Phase 2 (3b1, +engine choice 3c) — progress in
  the single-design vocabulary, audition + advisory ECAPA + name → Save. No A/B this wave.
- **Reusable recorder component (3a):** touch targets ≥44×44, responsive per the mobile
  protocol.
- **Library surfaces `voices.tsx`:** cloned voices in **My voices** with a 'Cloned'
  badge, consent summary, Revoke (shell 3a); Broken/Repairable card states (3b2).
- **Cast assignment (3b1 qwen / 3c coqui):** `overrideTtsVoices` with `libraryUuid` +
  `provenance:'cloned'`; engine-switch triggers lazy derive.
- **Store/API:** extend Wave-1 `voice-library-slice.ts` (clone thunks + candidate/wizard
  state); paired `real`+`mock`; OpenAPI-first; stays off `broadcast-middleware`.

## 7. Error handling & atomicity

Fail loud and named, never silent or half-committed. A `cloned` entry is never persisted
half-formed (manifest written only after derive + preview succeed + consent re-validated).
Corrupt file → 4xx; mic denied → Upload fallback; sidecar clone errors keep status
(#1801); re-derive stat-before-remove (#1804); genuine derive failure → Broken.
**Absorbs #1801 + #1804** (note as "delivered by Wave 3", 3b1).

## 8. Testing strategy (per sub-wave)

- **3a:** ingest fixtures incl. **webm/opus** (fatal-short blocks, soft-noise warns);
  WAV output valid; **consent guard throws** (cloned w/o consent) **and permits the
  revoke write** (C2); shared-writer no-op-for-others; sample-route consent gate (I5);
  recorder mocks (granted/denied-fallback/re-take); wizard phase-1 + consent-gate.
- **3b1:** `/qwen/clone-voice` stable `.pt` **without the 1.7B** + `design_voice`
  audition/`.pt` unchanged (regression); **`applyQwenFallback` cloned-exemption** —
  `qwenUnavailable:true` + cloned ⇒ raises, provably renders on no other voice (C1);
  `POST /clone` atomicity; ECAPA sane; e2e upload→consent→clone→save→cloned-section→assign.
- **3b2:** three-state pre-pass resolver, invariant asserted directly (Broken ⇒ raises,
  resolves to no other voice — guards the placebo trap); orphan → transparent re-derive;
  revocation-at-next-chapter; stat-before-remove; the §5.4/§5.5 decisions' tests.
- **3c:** `get_conditioning_latents` stable + low-level `inference` PCM + no cross-request
  bleed; latents branch fails loud on missing latents; the coqui voice-key branch resolves
  a cloned voice (not `FALLBACK_SPEAKER`); golden-audio consistency (validates the §2.3
  synthetic-clip→latents quality claim).
- **Live-GPU (owed, on-box, per sub-wave):** real sample renders recognizable/consistent;
  simulated Base-bump orphans → re-derives identical; ECAPA sane.

## 9. Migration & reversibility

Additive (no `cast.json` change; pre-Wave-3 entries keep `provenance`, no `master`/`consent`).
Reversible behind `voices.library.enabled`. Local-only.

## 10. Plan-time decisions (carried into the sub-wave plans)

- **3a:** quality-gate thresholds; WAV-writer choice (Node RIFF vs ffmpeg, M1);
  consent-guard revoke carve-out shape (C2).
- **3b2:** §5.4 blast-radius (per-character vs fail-chapter floor); **§5.5 1.7B handling
  (auto-derive-as-consent-artifact vs active downgrade gate — C3)**.
- **3c:** `xtts-latents.pt` location + the coqui voice-key wire contract (I2/I3);
  recorder VAD vs raw meter (polish).
- **Same-PR-as-3a:** update stale doc-194 roadmap/DoD text (M4).
