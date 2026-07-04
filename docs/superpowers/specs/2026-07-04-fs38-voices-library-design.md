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
    master.wav          ← cloned/imported only: retained reference clip (durable master),
                          normalised WAV/PCM produced by the ingest stage (§3)
    xtts-latents.pt     ← XTTS conditioning-latents cache (regenerable from master)
```

**Previews have ONE home: the shared sample cache** (`server/audio/voices/`, via
`voice-sample-cache`) — the wizard's audition and the card's play button read the same
entry (§3 keying). No `preview-*.mp3` files live in the library dir.

**The Qwen `.pt` cache does NOT live here.** The sidecar resolves `.pt`s exclusively from
the global `voices/qwen/qwen-<uuid>.pt` store (`main.py _voice_paths`), so the library's
Qwen cache is written there under the library voice's uuid — same place, same convention,
one home. The manifest's `engines.qwen` block tracks its status; delete/rederive manage it.

`VoiceLibraryEntry` schema (new in `openapi.yaml`; types generated — never hand-written;
deliberately NOT named `LibraryVoice`, which already exists in `voice-match.ts` meaning
"a voice a book character already uses"):

- **Identity:** `voiceUuid` (srv-43 nanoid, THE key), `name`, `createdAt`, `updatedAt`.
- **Classification:** `provenance: 'designed' | 'cloned' | 'imported'` (immutable after
  creation), `tags: string[]` (first voice-level tags in the system), `pinned: boolean`,
  `languageCode`.
- **Designed-only:** `persona` (instruct text; editable → drives redesign-with-compare).
- **Cloned-only:** `consent: { personName, relationship: 'self' | 'family-with-permission'
  | 'guardian-of-minor', permittedUse: 'personal', attestedAt, attestedBy, revokedAt? }` —
  a revoked consent blocks assignment and generation immediately and prompts deletion;
  already-rendered chapter audio is NOT retroactively scrubbed (documented, honest limit).
- **Imported-only:** `sourceAttestation: { source, rightsNote, attestedAt }`.
- **Cloned + imported:** `sampleTranscript` (Whisper-derived `ref_text`, user-confirmable),
  `sampleMeta` (duration, sample rate, quality-check results).
- **Per-engine readiness:** `engines: { qwen?: { status: 'ready' | 'deriving' | 'stale' |
  'failed', baseModel }, xtts?: { status, coquiVersion, modelId } }` — `stale` = derived
  under a different model/version than current. XTTS needs its own anchor because
  coqui-tts is deliberately unpinned (`install-coqui.mjs`): the resolved package version +
  model id are recorded at derive time, and the startup stale-scan covers BOTH engines
  symmetrically.
- **Origin:** `promotedFrom?: { bookId, characterId }` — breadcrumb only, no live link.

**Cast-side additive change (declared here because §5/§6/§7 all key on it):** the
per-engine override slot `overrideTtsVoices[engine]` gains optional
`{ libraryUuid, provenance }` alongside `name` (and the existing `variants`). One field
name everywhere: **`provenance`** (the server-side `VoiceKind` enum remains a separate,
derived display concept). Threading it through is a known four-site change — `VoiceLike`,
`CastCharacter`, and the three openapi `overrideTtsVoices` blocks — plus the
`normaliseVoiceOverrides` spread; the legacy single-field `overrideTtsVoice` migration
keeps emitting `{ name }`-only (a legacy voice is never a library voice).

Baked-in decisions:

1. **Master clip is source of truth; `.pt` is a cache.** Base-model upgrade → `stale` →
   re-derive from `master.wav` (plan 194's verified lesson: `design_voice` discards its
   reference audio; the clone path must NOT).
2. **Promotion mints a NEW library `voiceUuid` and byte-copies the `.pt`.** "Save to my
   voices" creates an independent library entry: new uuid, persona copied, the character's
   `qwen-<origUuid>.pt` byte-copied to `qwen-<libUuid>.pt`. Byte-identical sound at
   promotion time, but fully independent thereafter — redesigning the origin character
   never mutates the library voice, and redesigning the library voice never mutates the
   origin character. (Sharing the uuid was rejected: the `.pt` store is keyed purely on
   uuid, so aliasing means a later character-scoped redesign silently overwrites the
   library master.) `promotedFrom` stays a breadcrumb only. fs-12's "same voice across
   books via shared cached embedding" holds through the library entry: every ASSIGNMENT of
   the library voice shares the single `qwen-<libUuid>.pt`. Two edge rules: a
   **reused/matched** character's `.pt` lives under the SOURCE voice's uuid, not the
   character's — promotion resolves and copies from the true source key; and if no `.pt`
   exists yet (voice never designed), promotion copies the persona only and marks
   `engines.qwen: 'stale'` for on-demand derivation.
3. **Consent lives in the manifest**, never in an engine cache dir — survives re-derivation,
   shown on the voice card forever.
4. **Deletion = multi-location ERASURE, not just cast integrity.** `DELETE` returns
   current usage — computed by scanning every cast.json for override slots referencing the
   library key (`qwen-<libUuid>` / `xtts-clone-<libUuid>`) — and requires explicit
   confirm; affected characters fall back to "needs a voice" (fe-46 gate surfaces it).
   Erasure then removes EVERY derived artifact, not only the library dir: `master.wav` +
   latents (library dir), the global `voices/qwen/qwen-<libUuid>.pt`, and the voice's
   sample-cache preview MP3s — asserted by a unit test, since "local-only, never leaves
   the machine" (§6) is hollow if deletion leaves embeddings behind. Because promotion
   copies rather than aliases, deleting a library voice can never touch an origin
   character's own `.pt`. Already-rendered book audio persists (see consent note above).

Migration: purely additive. No existing file changes shape; the store starts empty; the
dormant `VoiceKind.cloned` branch (`server/src/workspace/voice-kind.ts`) finally gets set,
and the enum gains `imported` — which means auditing every binary
`kind === 'designed' ? 'Designed' : 'Cloned'` render site (e.g.
`series-memory-reveal.tsx`) so imported voices aren't mislabelled "Cloned".

## 3. Server API + the engine-generic clone contract

New route module `server/src/routes/voice-library.ts`:

| Endpoint | Does |
|---|---|
| `GET /api/voice-library` | list manifests (My-voices sections read this, not the derived aggregation) |
| `POST /api/voice-library/design` | persona → designed library voice; the design flow **extracted from its book/character scoping** (see below) ; preview-then-promote (plan 161 pattern generalised to library uuids) |
| `POST /api/voice-library/clone-sample` | **phase 1 (stateless):** multipart upload (multer; `manuscripts.ts`/`cover.ts` precedent) → ingest/decode → quality checks → Whisper transcript. Returns an ephemeral `sampleId` in a temp area (auto-pruned) + verdicts + editable transcript. No manifest yet — abandoning the wizard orphans nothing |
| `POST /api/voice-library/clone` | **phase 2 (finalize):** `{sampleId, name, tags, consent/attestation}` → manifest + `master.wav` persisted → engine caches derived → previews. **Consent/attestation validated server-side — UI cannot bypass.** Derive failure after finalize = per-engine `failed` status (§7) |
| `PATCH /api/voice-library/:uuid` | name / tags / pinned / persona edits |
| `POST /api/voice-library/:uuid/redesign` | designed-only: new persona → preview → A/B → promote or discard |
| `POST /api/voice-library/:uuid/rederive` | rebuild a `stale`/`failed` engine cache from master (clip or persona) |
| `POST /api/voice-library/:uuid/assign` | write a character's `overrideTtsVoices` slot(s) to reference this voice |
| `POST /api/voice-library/promote` | `{bookId, characterId}` → library manifest under the character's existing `voiceUuid` |
| `DELETE /api/voice-library/:uuid` | usage report + explicit confirm |

**Audio ingest stage (new, load-bearing — nothing in the stack decodes containers
today).** Every entry point downstream (Whisper `/transcribe`, `create_voice_clone_prompt`,
XTTS conditioning) consumes raw PCM; MediaRecorder yields webm/opus and uploads may be
mp3/m4a/anything. A new server-side ffmpeg ingest component (`server/src/audio/ingest.ts`;
ffmpeg is already a runtime dep for export) normalises any uploaded/recorded container to:
16 kHz mono PCM for Whisper, a canonical normalised WAV as `master.wav`, and per-engine
reference PCM at each engine's expected sample rate. All quality checks (§ below) run on
the decoded PCM. Owned by Wave 3; without it the clone pipeline cannot run at all.

**Engine contract** — each engine implements two functions behind one interface:
`deriveArtifacts(master, refText) → cache files` and `resolveVoice(libUuid) → synthesis
param`. This seam is what makes engine #3 cheap. In v1:

- **Qwen:** derive = new sidecar endpoint `POST /qwen/clone-voice` (decoded ref-audio PCM
  + `ref_text` → `Base.create_voice_clone_prompt` → global `qwen-<libUuid>.pt`). This is
  an **extraction, not a flip-of-a-switch**: the clone-prompt step is today inlined inside
  `design_voice`'s VRAM-arbitration/lock dance and must be re-plumbed as its own endpoint
  (and `main.py` carries a standing empirical-signature caveat at ~1630 to clear). Still:
  no 1.7B involved; same VRAM profile as designed voices; the `.pt`-consuming synth path
  is unchanged and proven.
- **XTTS:** derive = **compute conditioning latents once and cache them** — load
  `master.wav` via `soundfile` (never `torchaudio.load`; a guardrail test forbids it),
  run `get_conditioning_latents`, persist `xtts-latents.pt` in the library dir (stamped
  with coqui version + model id, §2). Synthesis resolves `xtts-clone-<libUuid>` to the
  cached latents, NOT to a per-sentence `speaker_wav` (recomputing latents every sentence
  would be unusably slow — Coqui has no batch path). **This changes the Coqui synth call
  itself:** today `CoquiEngine` uses the high-level `tts()` API; latents-driven synthesis
  calls the lower-level `tts_model.inference(...)` and must re-carry the call-site fp16
  autocast (DeepSpeed wiring is model-level and persists, but is best-effort — the
  sidecar test asserts GPU + fp16 only, never DeepSpeed). **Clone keys bypass speaker
  validation:** `CoquiEngine` validates inbound voice names against its speaker manifest
  and silently substitutes unknown ones (`voiceSubstitutedFrom`) — a second substitution
  vector. The clone-resolution branch (`xtts-clone-*` / `qwen-*` prefixes) must run AHEAD
  of manifest validation; a sidecar test pins that a clone key never yields
  `voiceSubstitutedFrom`. Real Wave-3 work, not a cache add-on.

**Library-scoped design flow = an extraction, not a wrap.** Every layer of today's design
machinery hard-requires a book/character: `withDesignLock` keys on `bookDir`,
`ensureCharacterVoiceUuid` requires a cast.json row, routes mount under
`/:bookId/cast/:characterId`, and the design-pill slice + `designRunningElsewhere` guard
compare `bookId`s. Wave 1 therefore extracts the engine-facing core with: a
library-scoped lock (serializes library design jobs among THEMSELVES — note the server's
`withDesignLock`/`isDesignBusy` are per-`bookDir` maps and provide NO cross-scope
serialization; the spec does not pretend otherwise), uuids minted library-side without
touching any cast.json, and the design pill/snapshot shape gaining an optional book-less
variant. **Cross-scope co-run protection is attributed honestly:** it comes from (1) the
frontend's single `castDesign.active` slot — a running library design occupies it with a
book-less id, so `designRunningElsewhere` correctly disables every book's Design buttons,
same as today's cross-book guard — and (2) the sidecar's VRAM arbitration
(gpuSemaphore + VoiceDesign co-residency handling), which is what actually prevents the
plan-155 OOM class for book-vs-book today. No new global server-side design mutex is
introduced (deliberate: it would duplicate protection that already lives at the two real
choke points).

**Sample/preview caching:** previews live ONLY in the shared `voice-sample-cache`
(`server/audio/voices/`) — wizard audition and card play read the same entry. The cache
key folds in a `master.wav`/persona content hash — otherwise a re-record under the same
uuid serves the OLD preview forever (the known uuid-rekey stale-badge gotcha, in
reverse). Re-derive purges the voice's cached sample MP3s.

**Assignment & resolution (real Node-side work, not a slot-write).** Today
`pickVoiceForEngine` derives the Qwen key from the CHARACTER's `voiceUuid`, ignoring the
override-name string. Assigning a library voice must NOT stamp the character's uuid (that
would orphan a character's own designed voice). Instead: the assign endpoint writes an
explicit library reference into the override slot (`overrideTtsVoices.qwen.name =
'qwen-<libUuid>'`, `overrideTtsVoices.coqui.name = 'xtts-clone-<libUuid>'`), and
`voice-mapping.ts` learns to pass through an explicit library key when present — the
character's own `voiceUuid` and artifacts stay untouched. **Auditioning an unassigned
library voice** needs a cast-independent path: a library-scoped variant of the existing
voice-sample route/cache (`POST /api/voice-library/:uuid/sample`), reusing the same
sample-cache keying so wizard previews and later card plays share one synthesis.

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
     meter + elapsed-time guidance (aim 30–60 s). MediaRecorder emits webm/opus (browsers
     don't record WAV) — the upload is container-agnostic and the server ingest stage (§3)
     owns all decoding.
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
  voice. Assigning writes an explicit library key into `overrideTtsVoices` per engine
  (resolver pass-through semantics, §3) **and stamps the assignment's provenance** — the
  override slot gains an optional `{ libraryUuid, provenance }` alongside `name` (additive
  openapi change; slots are `{ name }`-only today) — which is what the matcher filtering
  (§6) and the fallback protection (§7) key on. The pass-through change must leave the
  emotion-variant key derivation (`pickEmotionVariantVoice`, also `voiceUuid`-derived)
  untouched for non-library voices.
- **Cross-tab consistency (explicit v1 decision):** the `voice-library` slice does NOT
  join `broadcast-middleware` (which deliberately syncs only ephemeral stream state, never
  entity lists); it refetches on tab focus/visibility and after every local mutation.
  Cheap, consistent-enough for a personal library; revisit if stale-tab reports appear.

## 6. Guardrails (invariants, enforced at choke points)

- **A personal voice NEVER silently becomes someone else's voice.** There are THREE
  render-time states for a character whose assignment carries
  `provenance: 'cloned' | 'imported'`, each with its own (correct) choke point — the
  #1284 loud-fallback helper alone covers none of them (it runs only when Qwen is
  HEALTHY, and only parks voices resolving to empty; a clone resolves non-empty):
  1. **Engine healthy + artifact present** → renders normally. No gate, no parking —
     the common case must stay friction-free.
  2. **Engine unavailable** (Qwen down — the "Mum's voice is unavailable" case) → the
     `qwen_unavailable` warning branch in `generation.ts` (~:676), which today warns and
     falls through to a generic Kokoro substitute, is UPGRADED to the park-and-confirm
     flow when any speaker's assignment is personal-provenance: generation pauses for
     explicit confirmation naming the substitution ("Mum's voice is unavailable — render
     these chapters in a standard voice instead?"). No silent path.
  3. **Engine healthy + artifact MISSING on disk** (orphaned/never-derived `.pt` — a real,
     documented state) → the parked-set predicate gains an **artifact-existence check**
     for library-key assignments (does `qwen-<libUuid>.pt` / `xtts-latents.pt` exist for
     the effective engine) — provenance alone can't catch this because the resolver is
     pure and disk-blind.
  **Engine-switch-after-assign** is caught BEFORE render: the fe-46 pre-flight gate is
  Qwen-only today (`resolveVoiceStatus` has no per-engine artifact concept), so this is
  net-new selector work — the frontend receives per-engine readiness from the manifest
  (`engines.*.status`) and `resolveVoiceStatus` gains an
  "assigned-library-voice-has-no-artifact-for-effective-engine → Needs voice" path
  covering non-Qwen engines (incl. Kokoro, which can never carry a clone). A third
  substitution vector — the sidecar's own speaker-manifest validation — is closed in §3.
- **Matcher exclusion — assignment-level, not manifest-level.** The matcher scans book
  casts (`scanLibraryCharacters()` / `projectLibraryVoice()` — the single seam shared by
  the confirm-time matcher and the analysis-time auto-linker), so an unassigned library
  voice is invisible to it by construction. The invariant to enforce is about ASSIGNED
  voices: once a cloned voice is cast in a book, that character enters the scans — so
  assignments carry their `provenance` (the §2 override-slot field, stamped at assign
  time), and the scan seam filters out cloned-provenance candidates. A person's voice is NEVER offered back by
  cross-book matching; explicit assignment only. Characters using `imported`/`designed`
  library voices remain matchable exactly as any designed character is today. Direct
  matching of unassigned library manifests is OUT of v1 (the matcher scores on character
  identity, which a standalone voice named "Mum" doesn't have). Unit-pinned.
- **Never-cross-language (plan 162):** cloned/imported voices carry the sample's
  `languageCode` and obey standard eligibility filtering.
- **Local-only:** samples, `.pt`s, manifests stay in the workspace; excluded from any
  share/export surface; no community sharing; cloned-voice export explicitly out of scope
  in v1.
- **Consent server-side:** clone creation rejects without a complete consent/attestation
  record (400 with field errors).
- **Reversibility (scoped honestly — no feature-flag infra exists today):** the My-voices
  section, wizard, and clone endpoints sit behind a new user-setting in the existing
  server config registry (`server/src/config/registry.ts`; the `tts.preload.kokoro`
  setting is the shape precedent — note the registry has never gated an Express route
  before, so the settings-checking middleware that 404s the clone routes is small
  net-new wiring, not an existing pattern). Off = section hidden, clone routes 404. The
  In-use provenance badges and the Catalogue rebuild ship unconditionally — they are
  presentation-only and don't need the net.

## 7. Error handling & edge cases

- **Derivation failure** (sidecar down, OOM, bad clip): engine status `failed` + reason;
  voice stays usable on engines that succeeded; per-engine retry chip; zero ready engines
  → Assign disabled with explanation.
- **Base-model upgrade:** startup scan marks mismatched manifests `stale`; lazy re-derive
  on next use or via retry chip.
- **Deletion in use:** usage report + confirm; casts fall back to "needs a voice" (fe-46
  gate surfaces it).
- **Mic denied / absent:** record card degrades to upload with a clear message.
- **Concurrency:** one derivation per voice at a time; library design jobs join the SAME
  single-owner design mutex as book jobs via the `library` lock scope (§3), so the 1.7B
  VoiceDesign is never double-loaded.
- **Windows file locking (evict-before-replace):** the sidecar caches loaded `.pt`
  prompts in memory and holds files open — re-derive and delete must evict first
  (`/qwen/evict-voice` precedent) before unlinking/replacing `master.wav`, `.pt`, or
  latents, or Windows sharing violations corrupt the operation midway.
- **Abandoned wizard:** phase 1 (`clone-sample`) writes only to a temp area, auto-pruned
  on a TTL — closing the modal mid-flow orphans no manifest (two-phase design, §3).

## 8. Testing

- *Unit (server):* manifest CRUD + consent-gate rejection; matcher exclusion (a
  cloned-provenance ASSIGNMENT is never offered back; imported/designed-hosting
  characters are); stale detection on `baseModel`/coqui-version change; deletion usage
  report + **erasure completeness** (no `.pt`/latents/sample-MP3 survives a delete);
  **the §6 three-state never-silent-substitution invariant** pinned as regression tests:
  the upgraded `qwen_unavailable` branch parks personal-provenance speakers (state 2),
  the parked-set artifact-existence check catches a missing `.pt` (state 3), and a
  healthy artifact-present clone does NOT park (state 1); plus the sidecar
  no-`voiceSubstitutedFrom`-for-clone-keys test (§3).
- *Unit (frontend):* `voice-library` slice; provenance-driven card rendering; wizard step
  gating (record unreachable before consent).
- *Sidecar (pytest):* `/qwen/clone-voice` produces a `.pt` whose `generate_voice_clone`
  output is stable across calls; XTTS `speaker_wav` synthesizes; both join the concurrency
  battery.
- *E2E (Playwright — split honestly by harness capability):* the **upload** path is
  mockable today (blob-URL upload precedent): consent→upload→clone→appears only in
  Cloned→assign→cast row shows cloned badge; create-designed→save→reuse in a second book;
  three-section page at all three viewports (mobile protocol). The **record** path (Wave
  4) is greenfield in the harness: needs chromium fake-media launch flags
  (`--use-fake-device-for-media-stream` / `--use-file-for-fake-audio-capture`) or a
  `MediaRecorder` stub — sized as its own e2e work item, not assumed free. Every new
  endpoint lands as a PAIRED `real*` + `mock*` implementation in `api.ts` plus
  `src/mocks/` fixtures (components only ever import `api.*`).
- *Golden-audio:* out of v1 gates (clone output depends on user samples); ECAPA fidelity
  is the runtime stand-in.
- *Live-GPU acceptance:* real sample → chapter render recognisably in that voice,
  consistent across chapters (plan 194's bar).

## 9. Delivery waves (independently shippable PR trains, behind the flag)

1. **Store + page skeleton** — manifest schema, CRUD routes, RTK slice, three-section
   restructure, Designed authoring. Includes the **design-flow extraction** (§3: `library`
   library-scoped lock, book-less uuid minting, book-less design pill/snapshot variant,
   honest cross-scope co-run attribution) — the biggest single item in this wave, NOT a
   wrap of existing paths — plus the config-registry setting + route-gating middleware
   (§6 reversibility). No clone yet; immediately useful — this wave alone delivers fs-12.
2. **Catalogue rebuild** — engine filter + facets (small; may ride wave 1's train).
3. **Clone pipeline** — the ffmpeg **audio ingest stage** (§3, first — everything else
   consumes its output), sidecar `/qwen/clone-voice` (extracted from `design_voice`),
   XTTS latents-cache derive + synthesize-from-latents, upload path + quality checks +
   Whisper `ref_text`, consent + imported attestation, two-phase wizard (upload-first),
   ECAPA fidelity, and the **three-state substitution protection** (§6: upgraded
   `qwen_unavailable` park-and-confirm, artifact-existence predicate, per-engine
   readiness selectors, sidecar clone-key validation bypass — must ALL land before the
   first cloned voice can render). The largest wave — sized as an extraction/re-plumb,
   not a switch-flip.
4. **In-app recording** — MediaRecorder capture (webm/opus → ingest stage) + scripted
   reading cards + re-record-with-compare.
5. **Polish** — matcher-exclusion hardening tests, `VoiceKind` `imported` label audit,
   deletion UX, mobile passes.

## 10. Out of scope (v1)

- Emotion variants on library voices (stay character-scoped post-assignment).
- Version history for redesigns (single current version).
- Voice export/import, sharing, or any community surface.
- Additional clone engines beyond Qwen + XTTS (the contract makes them cheap later).
- fe-12 bulk library ops (pairs with, not part of).
- Golden-audio gating of clone output.
