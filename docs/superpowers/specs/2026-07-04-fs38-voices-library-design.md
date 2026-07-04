# fs-38 — Voices library: custom voice store (designed + cloned + imported)

> Spec (validated design) · 2026-07-04 · fs-38 / [#624](https://github.com/dudarenok-maker/AudioBook-Generator/issues/624), folds in fs-12 (#419, closed into #624)
> Source plan: [`docs/features/194-voice-cloning.md`](../../features/194-voice-cloning.md) (draft → this spec supersedes its open questions)
> Companion shipped context: plan 108 (Qwen design), srv-43 voiceUuid (plan 226), plan 161 (A/B preview-then-promote), plan 240 / fe-46 (voice-readiness gate), srv-31 Whisper ASR, srv-36 ECAPA embed.

The next big release: a first-class personal voice library that pays off the brand promise
— _any book, performed by a full cast, even in your own voice._ Users build a stable of
named narrators — designed from a persona, cloned from their own or a family voice, or
imported from freely-available samples — and cast them across the whole catalogue.

## 1. Mental model & taxonomy (settled with the user)

Three top-level voice classes, presented in this order on one restructured `#/voices` page:

1. **My voices** — a NEW first-class, book-independent store. The only things in it are
   voices the user **deliberately kept**. Two entry axes, three provenance classes:
   - `designed` — authored from a persona in the library ("Create voice"), or **explicitly
     promoted** from a per-character designed voice ("Save to my voices"). Promotion is the
     ONLY way a character voice enters the library — nothing lands by side effect (fs-12).
   - `cloned` — a **real person, personal** (self / family / own child). Always born in the
     library via the clone wizard. Consent-gated, matcher-excluded, local-only. Must look
     different from designed voices **everywhere it appears** (library, assign panel, cast
     rows, profile drawer) — not just inside the library page.
   - `imported` — cloned from a **freely-available/public sample** (public-domain recording,
     licensed pack). Same pipeline as `cloned` minus the personal-consent regime: a
     lightweight source attestation instead, matcher-INCLUDED, its own badge.
2. **In use** — the existing derived rollup (aggregated from every book's `cast.json`;
   All / This book / Series & older), essentially as-is. Every card gains a **provenance
   badge** (`Designed` / `Catalogue` / `My voice` / `Cloned` / `Imported`). Character-scoped
   designed voices (e.g. Sophie Foster) live HERE until promoted; their cards carry an
   inline **Save to my voices** action. A `My voice`-badged card links to its library card
   (single place of management) rather than duplicating edit affordances. Existing
   family/compare/merge machinery untouched.
3. **Catalogue** — the existing Base-voices tab, rebuilt with a first-class **engine filter**
   (segmented Qwen / Kokoro / Coqui) + language and gender facets, replacing the current
   poorly-organized flat list. Deliberately LAST: the product's center of gravity is unique
   voices per cast, not presets.

Decisions locked with the user (2026-07-04 session):

- Q1 **Strict separation with explicit promotion** — character designed voices stay
  character-scoped; the library only holds deliberate keeps. Cloned voices always live in
  the library.
- Q2 **Three-way split** catalogue | designed | cloned (later extended with `imported`).
- Q3 **Both clone engines in v1** (Qwen + XTTS) — deliberately, to force an engine-generic
  cloned-voice contract so engine #3 (e.g. parked fs-48 Fish Audio) is cheap.
- Q4 **Consent = mandatory attestation form + consent line baked into the default reading
  script** (script line optional in practice — upload of arbitrary speech proceeds on the
  form alone).
- Q5 **Fine-tuning = redesign-with-compare** (plan-161 A/B pattern), single current version,
  no history. Cloned analogue: re-record with old-vs-new compare.
- Q6 **One `#/voices` page**, sections ordered My voices → In use → Catalogue.
- Q7 **Emotion variants out of v1** — variants stay character-scoped post-assignment
  (custom voices lean on the 1.7B prosody tier anyway).
- Q8 **`imported` ships in v1** as the third provenance class.
- The default reading script must have **emotional variety** (not one flat line) so the
  master clip carries prosodic range.
- The Catalogue must be **clearly filterable by engine** (current design acknowledged poor).

## 2. Data model & storage

New persistent store — the first book-independent voice entity in the system:

```
audiobook-workspace/voice-library/
  <voiceUuid>/
    voice.json          ← manifest, source of truth
    master.wav          ← cloned/imported only: retained reference clip (durable master)
    qwen.pt             ← Qwen clone-prompt cache (regenerable from master/persona)
    preview-qwen.mp3    ← audition cache per engine
    preview-xtts.mp3
```

`LibraryVoice` schema (new in `openapi.yaml`; types generated — never hand-written):

- **Identity:** `voiceUuid` (srv-43 nanoid, THE key), `name`, `createdAt`, `updatedAt`.
- **Classification:** `provenance: 'designed' | 'cloned' | 'imported'` (immutable after
  creation), `tags: string[]` (first voice-level tags in the system), `pinned: boolean`,
  `languageCode`.
- **Designed-only:** `persona` (instruct text; editable → drives redesign-with-compare).
- **Cloned-only:** `consent: { personName, relationship: 'self' | 'family-with-permission'
  | 'guardian-of-minor', permittedUse: 'personal', attestedAt, attestedBy }`.
- **Imported-only:** `sourceAttestation: { source, rightsNote, attestedAt }`.
- **Cloned + imported:** `sampleTranscript` (Whisper-derived `ref_text`, user-confirmable),
  `sampleMeta` (duration, sample rate, quality-check results).
- **Per-engine readiness:** `engines: { qwen?: { status: 'ready' | 'deriving' | 'stale' |
  'failed', baseModel }, xtts?: { status } }` — `stale` = derived under a different
  `baseModel` than current.
- **Origin:** `promotedFrom?: { bookId, characterId }` — breadcrumb only, no live link.

Baked-in decisions:

1. **Master clip is source of truth; `.pt` is a cache.** Base-model upgrade → `stale` →
   re-derive from `master.wav` (plan 194's verified lesson: `design_voice` discards its
   reference audio; the clone path must NOT).
2. **Promotion shares the `voiceUuid`.** "Save to my voices" registers a library manifest
   under the character's existing uuid and copies persona + `.pt` in. Character assignments
   already reference `qwen-<voiceUuid>`, so the promoted voice IS the same voice everywhere
   — byte-identical, no re-derivation, and fs-12's "same voice across books via shared
   cached embedding" acceptance falls out for free.
3. **Consent lives in the manifest**, never in an engine cache dir — survives re-derivation,
   shown on the voice card forever.
4. **Deletion never silently breaks casts:** `DELETE` returns current usage
   (books/characters) and requires explicit confirm; affected characters fall back to
   "needs a voice," surfacing via the fe-46 readiness gate.

Migration: purely additive. No existing file changes shape; the store starts empty; the
dormant `VoiceKind.cloned` branch (`server/src/workspace/voice-kind.ts`) finally gets set.

## 3. Server API + the engine-generic clone contract

New route module `server/src/routes/voice-library.ts`:

| Endpoint | Does |
|---|---|
| `GET /api/voice-library` | list manifests (My-voices sections read this, not the derived aggregation) |
| `POST /api/voice-library/design` | persona → designed library voice; wraps the existing 1.7B→`.pt` design flow library-scoped; preview-then-promote (plan 161) |
| `POST /api/voice-library/clone` | multipart upload (multer; `manuscripts.ts`/`cover.ts` precedent): audio + consent/attestation fields → quality checks → Whisper `ref_text` → manifest + `master.wav` → derive engine caches → previews. **Consent/attestation validated server-side — UI cannot bypass** |
| `PATCH /api/voice-library/:uuid` | name / tags / pinned / persona edits |
| `POST /api/voice-library/:uuid/redesign` | designed-only: new persona → preview → A/B → promote or discard |
| `POST /api/voice-library/:uuid/rederive` | rebuild a `stale`/`failed` engine cache from master (clip or persona) |
| `POST /api/voice-library/:uuid/assign` | write a character's `overrideTtsVoices` slot(s) to reference this voice |
| `POST /api/voice-library/promote` | `{bookId, characterId}` → library manifest under the character's existing `voiceUuid` |
| `DELETE /api/voice-library/:uuid` | usage report + explicit confirm |

**Engine contract** — each engine implements two functions behind one interface:
`deriveArtifacts(master, refText) → cache files` and `resolveVoice(voiceUuid) → synthesis
param`. This seam is what makes engine #3 cheap. In v1:

- **Qwen:** derive = new sidecar endpoint `POST /qwen/clone-voice` (ref-audio PCM +
  `ref_text` → `Base.create_voice_clone_prompt` → `.pt`) — exposes the proven internal
  back-half of `design_voice` with real audio as input. Resolve = existing
  `qwen-<voiceUuid>` storage-key convention. No 1.7B involved; same VRAM profile as
  designed voices.
- **XTTS:** derive = nothing (zero-shot; the master clip IS the artifact). Resolve = wire
  `speaker_wav` into `CoquiEngine.synthesize()` (net-new: today it only accepts named
  preset speakers), `xtts-clone-<voiceUuid>` convention resolved server-side to
  `master.wav`.

**Quality gates on capture:** duration bounds, clipping, noise floor, minimum speech
content (Whisper `no_speech_prob`) — actionable plain-language verdicts driving the
re-take loop. **Post-clone verification:** reuse ECAPA `POST /embed` (srv-36) to score
rendered-preview vs master-clip speaker similarity — a "clone fidelity" indicator,
warn-not-block.

## 4. Capture & consent wizard (cloned/imported front door)

New wizard modal from My voices → Cloned ("Clone a voice") / Imported ("Import a sample
voice"). Phone-first (44px targets, full-screen on phones). Four steps:

1. **Consent form FIRST** (cloned) — person's name, relationship (`this is me` /
   `family member — I have their permission` / `parent/guardian of this minor`),
   permitted use fixed to "personal listening on this machine," date auto-stamped; plain
   statement that sample and voice never leave the machine. Imported variant: source
   attestation instead (source + rights note). Doing consent first lets the reading script
   bake in the person's actual name.
2. **Record or upload** —
   - *Record:* MediaRecorder (net-new frontend surface); default reading script rendered
     card-by-card: consent line ("I'm <name>, and I'm happy for my voice to be used in
     Castwright…") + **emotionally varied passages** (calm narration, excited burst, a
     question, something soft) sourced from Castwright-owned Coalfall text. Live input
     meter + elapsed-time guidance (aim 30–60 s).
   - *Upload:* drop an existing recording (the "grandma's voicemail" gift path) — proceeds
     on the form alone.
3. **Quality check + re-take loop** — server verdicts as plain-language cards with
   prominent Re-take; Whisper transcript shown for confirmation (editable → `ref_text`).
4. **Name & shelve** — name, optional tags, derive + audition (per-engine progress),
   ECAPA fidelity ("Very close match / Fair / Weak — consider re-taking"). Save → lands in
   the correct section.

**Distinct card identity everywhere:** shared voice-card component carries the treatment —
"Cloned · Mum · consented 4 Jul 2026" badge for cloned; "Sampled from source" for
imported; quiet "My voice" marker for designed library voices — so cast-view assign panel
and profile drawer show the same identity as the library.

**Re-take after save (cloned/imported fine-tune):** re-record/re-upload via wizard steps
2–4, replacing master + re-deriving caches, with old-vs-new A/B before committing. Consent
persists; re-attest only if the person name changes.

## 5. `#/voices` restructure & assignment surfaces

- `src/views/voices.tsx` gains top-level segmented nav: **My voices | In use | Catalogue**
  (order fixed; see §1 for each section's content). My voices backed by a new
  `voice-library` RTK slice. Cards: name, inline tags, pin, language, engine-readiness
  chips (Qwen ✓ / XTTS ✓ / stale ⟳), preview-play, Assign, provenance treatment. Sort:
  pinned first, then recency.
- **Assignment:** cast-view `VoiceLibraryPanel` gains a My-voices group at the top (same
  tap-to-assign/drag affordances + eligibility filtering); profile drawer voice picker
  likewise; profile drawer also gains **Save to my voices** on any designed character
  voice. Assigning writes `overrideTtsVoices` per engine — downstream (series consistency,
  readiness gate, generation) a cloned voice behaves exactly like a designed one because
  it IS the same `.pt`/reference machinery.

## 6. Guardrails (invariants, enforced at choke points)

- **Matcher exclusion:** `scanLibraryCharacters()` / `projectLibraryVoice()` — the single
  seam shared by the confirm-time matcher (`voice-match.ts`) and analysis-time auto-linker
  (`series-reuse-link.ts`) — filters out `provenance: 'cloned'`. A person's voice is NEVER
  offered back by cross-book matching; explicit assignment only. `imported` and `designed`
  ARE matchable. Unit-pinned.
- **Never-cross-language (plan 162):** cloned/imported voices carry the sample's
  `languageCode` and obey standard eligibility filtering.
- **Local-only:** samples, `.pt`s, manifests stay in the workspace; excluded from any
  share/export surface; no community sharing; cloned-voice export explicitly out of scope
  in v1.
- **Consent server-side:** clone creation rejects without a complete consent/attestation
  record (400 with field errors).
- **Reversibility:** entire My-voices surface behind a feature flag; off = today's page.

## 7. Error handling & edge cases

- **Derivation failure** (sidecar down, OOM, bad clip): engine status `failed` + reason;
  voice stays usable on engines that succeeded; per-engine retry chip; zero ready engines
  → Assign disabled with explanation.
- **Base-model upgrade:** startup scan marks mismatched manifests `stale`; lazy re-derive
  on next use or via retry chip.
- **Deletion in use:** usage report + confirm; casts fall back to "needs a voice" (fe-46
  gate surfaces it).
- **Mic denied / absent:** record card degrades to upload with a clear message.
- **Concurrency:** reuse design-lock/bulk-design mutex conventions — one derivation per
  voice at a time; library ops don't fight character-scoped design jobs.

## 8. Testing

- *Unit (server):* manifest CRUD + consent-gate rejection; matcher exclusion (`cloned`
  never returned; `imported`/`designed` are); stale detection on `baseModel` change;
  deletion usage report.
- *Unit (frontend):* `voice-library` slice; provenance-driven card rendering; wizard step
  gating (record unreachable before consent).
- *Sidecar (pytest):* `/qwen/clone-voice` produces a `.pt` whose `generate_voice_clone`
  output is stable across calls; XTTS `speaker_wav` synthesizes; both join the concurrency
  battery.
- *E2E (Playwright):* upload→consent→clone→appears only in Cloned→assign→cast row shows
  cloned badge; create-designed→save→reuse in a second book; three-section page at all
  three viewports (mobile protocol).
- *Golden-audio:* out of v1 gates (clone output depends on user samples); ECAPA fidelity
  is the runtime stand-in.
- *Live-GPU acceptance:* real sample → chapter render recognisably in that voice,
  consistent across chapters (plan 194's bar).

## 9. Delivery waves (independently shippable PR trains, behind the flag)

1. **Store + page skeleton** — manifest schema, CRUD routes, RTK slice, three-section
   restructure, Designed authoring (design/redesign/promote on existing engine paths).
   No clone yet; immediately useful — this wave alone delivers fs-12.
2. **Catalogue rebuild** — engine filter + facets (small; may ride wave 1's train).
3. **Clone pipeline** — sidecar `/qwen/clone-voice`, XTTS `speaker_wav`, upload path +
   quality checks + Whisper `ref_text`, consent + imported attestation, wizard
   (upload-first), ECAPA fidelity.
4. **In-app recording** — MediaRecorder capture + scripted reading cards +
   re-record-with-compare.
5. **Polish** — matcher-exclusion hardening tests, Series-Memory `voiceKind` labels,
   deletion UX, mobile passes.

## 10. Out of scope (v1)

- Emotion variants on library voices (stay character-scoped post-assignment).
- Version history for redesigns (single current version).
- Voice export/import, sharing, or any community surface.
- Additional clone engines beyond Qwen + XTTS (the contract makes them cheap later).
- fe-12 bulk library ops (pairs with, not part of).
- Golden-audio gating of clone output.
