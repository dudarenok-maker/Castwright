# Backlog (MoSCoW)

The prioritized planning view. Each item maps to exactly one GitHub issue — the
**canonical detail home** (What / Acceptance / Key files / Depends on / Benefit).
This file stays the single MoSCoW-bucketed, position-prioritized list; the issue
holds the detail and the delivery history. Bugs are GitHub issues with the `bug`
label and stay **off** this list (they're out-of-band — filed as the user hits
them). See [CONTRIBUTING.md "Issues"](../CONTRIBUTING.md#issues).

**Item IDs are permanent.** Each item carries a `<prefix>-<n>` ID — `fe` (frontend),
`srv` (server), `side` (TTS sidecar), `ops` (CI / build / dev-tooling), `fs`
(full-stack), or `app` (Android companion app). IDs are assigned once and **never reused or renumbered**; gaps are
expected. Cite an item by its ID from code or docs and the reference won't rot.
The issue title leads with the same ID; the issue `#NN` is the GitHub-native
auto-close hook (`Closes #NN` on the delivering PR).

**Priority = position.** Top of a bucket — and of a sub-group within it — is
highest priority. Reprioritising is pure reordering; it never changes an ID.

**Update rule:** when an item ships, close its issue (or let the PR auto-close it
via `Closes #NN`) and remove its row here; update the source plan's `status:` /
Ship notes and archive it if `stable`. When you discover a new item, file a
Backlog-item issue AND add the thin row here linking it, in the same round.

_Last reprioritised 2026-06-02 (whole-backlog pass that folded in the 29 brainstorm
items #458–#486). Ranking lens: stability / data-safety anchors first, high-ROI quick
listener wins interleaved near the top, big multi-week bets grouped lower in Could._

---

## Must — blocks v1 ship or hurts existing users

### `side-11` — Eliminate the variable-input-shape host-memory leak (so recycling isn't needed) ([#399](https://github.com/dudarenok-maker/AudioBook-Generator/issues/399))

- _What:_ The Qwen generation forward leaks committed host RAM monotonically (a new never-freed native workspace per sentence length; ~1,150 MB/batch), forcing plan-143 process-recycles every ~10 chapters. Goal: a full book on one warm sidecar with no recycles and no dropped chapters, now that RTF is solved (~1.04). Open levers: fixed-shape batch padding, chapter-boundary recycle, torch/transformers version pin.
- _Benefit (user / technical):_ removes mid-run recycle interruptions + dropped chapters (`srv-17c`) on long books — the cleanest end-to-end win now that RTF is solved. **Promoted to Must on 2026-06-02:** dropped chapters on long books actively hurt existing users.
_Full detail + acceptance:_ [#399](https://github.com/dudarenok-maker/AudioBook-Generator/issues/399).

_`fs-2` (multi-language, Russian first) shipped — the engine half via
[plan 108](features/108-qwen-coexistence.md), the language half via
[plan 162](features/162-fs2-multilanguage.md); the library/cast language UX
polish (`fe-16`) shipped via [plan 165](features/165-fe-15-16-language-and-revision-e2e.md).
The remaining deferred follow-up is `fs-14` (Russian UI localization) below._

---

## Should — important, not blocking ship

Ranked top = highest priority. Reliability / data-safety anchors lead, with the two
highest-ROI quick listener wins interleaved near the top, then medium user-value items,
then the large-but-important localization item. (The dependency-major cluster that sat at
the bottom of Should all shipped via plans 167 + 170 on 2026-06-02 — see the note below.)

### `srv-1` — Merge journal for deterministic alias un-link ([#397](https://github.com/dudarenok-maker/AudioBook-Generator/issues/397))

- _What:_ At every cast-merge call site (manual merge route, fold-minor-cast post-stage-2 pass), append a record to a per-book journal file `<bookDir>/.audiobook/cast-merges.json` of shape `{ ts, kind: 'manual' | 'fold', sourceId, sourceName, targetId, affectedSentenceIds: number[] }`. The unlink-alias route then reads this journal to compute `impactedChapters.candidateSentenceIds` as the exact sentences originally rewritten by the merge — no `chapterCast` heuristic, no per-chapter listing of sentences that may belong to a third party.
- _Benefit (user):_ reattribute modal becomes a precise checklist instead of a scoped review — every row the user sees is provably their merge's work, no third-party sentences to skip over. Big quality-of-life win for series-2-into-1 cleanups where merges pile up.
_Full detail + acceptance:_ [#397](https://github.com/dudarenok-maker/AudioBook-Generator/issues/397).

### `fs-15` — Continue listening: global cross-book resume ([#462](https://github.com/dudarenok-maker/AudioBook-Generator/issues/462))

- _What:_ Resume bookmarks are persisted per book on the server. Aggregate them into a "Continue listening" surface (books library and/or a landing rail) that jumps straight to the most-recently-played position across **any** book in one tap.
- _Benefit (user):_ one-tap re-entry; rewards the multi-book workflow that's already a first-class invariant.
_Full detail + acceptance:_ [#462](https://github.com/dudarenok-maker/AudioBook-Generator/issues/462).

### `fs-24` — Per-character pronunciation lexicon ([#478](https://github.com/dudarenok-maker/AudioBook-Generator/issues/478))

- _What:_ Per-book custom pronunciation overrides for invented names/places (term → phonetic/respelling), applied at synth time. Fiction — especially fantasy proper nouns — is where the TTS mangles the most. Net-new vs the existing chapter-title prosody handling.
- _Benefit (user):_ fixes the #1 narration-quality complaint for fiction.
_Full detail + acceptance:_ [#478](https://github.com/dudarenok-maker/AudioBook-Generator/issues/478).

### `fs-14` — Russian UI localization (interface strings, react-i18next) ([#396](https://github.com/dudarenok-maker/AudioBook-Generator/issues/396))

- _What:_ Localize the application interface to Russian. Stand up an i18n framework (**react-i18next** — user-confirmed choice) + a per-user `UserSettings.uiLanguage` preference with a language switcher in Account management, then translate the high-traffic surfaces first (top nav, account, upload/confirm, listen, cast) and grow coverage incrementally. Ground truth at capture: **no i18n library today**, ~1,500 hardcoded user-facing strings across ~82 components (densest: `account.tsx` ~92, `profile-drawer.tsx` ~79, `voices.tsx` ~68, `analysing.tsx` ~59, `cast.tsx` ~58, `export-audiobook.tsx` ~52). Centralisable copy already lives in `src/data/{walkthroughs,analysis-phases,regen-reasons,match-factors,listener-apps}.ts`. Locale-sensitive formatting is minimal (`src/lib/time.ts` durations only; no currency/date pickers).
- _Benefit (user / architectural):_ a fully Russian-speaking user gets a Russian app, not just Russian audio. The i18n framework makes every future language an incremental translation-file add rather than a code change. Pairs with fs-2 to make Russian a first-class end-to-end experience. (Large; ranked below the smaller wins.)
_Full detail + acceptance:_ [#396](https://github.com/dudarenok-maker/AudioBook-Generator/issues/396).

### Dependency major upgrades — _all shipped (section empty)_

Source: net-new (2026-06-01), from the [plan 164](features/164-deps-ci-hygiene.md) dependency audit, which filed every framework **major** then behind as a research-complete BACKLOG item. **All shipped — this section is now empty.** Round 1 (**2026-06-02**, [plan 167](features/archive/167-fe-react-cluster-upgrade.md)): the React cluster (`fe-19` Vite 8 + Vitest 4, `fe-18` React 19, `fe-21` react-router 7) + `ops-10` (TypeScript 6). Round 2 (**2026-06-02**, [plan 170](features/archive/170-deps-majors-zod-express-pdfjs-tailwind.md)): `srv-25` Zod 4 (deletes `zod-to-json-schema`), `srv-24` Express 5, `srv-26` pdfjs-dist 5, `fe-20` Tailwind 4 — closes #405/#406/#410/#409.

_`ops-8` (bump GitHub Actions off the deprecated Node-20 runtime) **shipped 2026-06-01** via
[plan 164](features/164-deps-ci-hygiene.md) — all workflows now pin the latest Node-24 action
majors (`checkout@v6`, `setup-node@v6`, `cache@v5`, `upload-artifact@v7`). Acceptance is the
PR's own annotation-free CI run._

---

## Could — nice to have, low-cost wins

Organised into thematic sub-groups (reliability & observability, listener experience &
playback, cast & voice, revisions & regen, voice & cast sharing, net-new capabilities,
onboarding & first-run, security & hardening, ops & distribution, listener-app handoffs).
Sub-groups and the items within them are ranked top = highest priority.

### Reliability & observability

#### `srv-30` — CPU-only analyzer device (large RAM-resident model, concurrent with GPU TTS) ([#507](https://github.com/dudarenok-maker/AudioBook-Generator/issues/507))

- _What:_ Run the local (Ollama) analyzer **CPU-only** (`num_gpu:0`, system RAM) per-model, so a large model (e.g. **Gemma 4 12B**, which doesn't fit the 8 GB GPU) can be used without touching the GPU. A CPU model **skips the GPU semaphore**, so CPU analysis and GPU TTS run **concurrently** instead of evicting each other. Phase 0 (small GPU model) + Phase 1 (big CPU model) run side-by-side. Server-authoritative device resolver + CPU knobs (`ANALYZER_CPU_*`); required wiring so `/api/ollama/load` matches the device and the TTS auto-evict skips CPU models. Gemma 4 12B entry gated behind env until validated (brand-new).
- _Benefit (architectural):_ frees the 8 GB GPU entirely for TTS (serves the concurrent multi-book invariant) and lifts the local analyzer model-size ceiling for better fiction attribution. Trade: slower CPU analysis (~minutes/chapter) — fine as a GPU-free background step.
_Full detail + acceptance:_ [#507](https://github.com/dudarenok-maker/AudioBook-Generator/issues/507) · plan `docs/features/178-cpu-only-analyzer.md`.

### Listener experience & playback

#### `fe-26` — Marker export + shareable notes ([#461](https://github.com/dudarenok-maker/AudioBook-Generator/issues/461))

- _What:_ Export the per-book markers (note + re-record kinds already in the listen-progress slice) to a text/JSON file the user can save or share. Extends the existing markers panel.
- _Benefit (user):_ makes re-record markers actionable outside the app (study / review / handoff to an editor).
_Full detail + acceptance:_ [#461](https://github.com/dudarenok-maker/AudioBook-Generator/issues/461).

#### `fs-16` — Listening-stats dashboard ([#463](https://github.com/dudarenok-maker/AudioBook-Generator/issues/463))

- _What:_ Derive and display listening statistics from the existing per-book progress records: total hours listened, books finished, per-book completion %, a simple streak. Lightweight dashboard (own view or an Account/library card).
- _Benefit (user):_ engagement + a sense of progress through long series.
_Full detail + acceptance:_ [#463](https://github.com/dudarenok-maker/AudioBook-Generator/issues/463).

#### `fs-9` — Configurable chapter-title silence durations ([#411](https://github.com/dudarenok-maker/AudioBook-Generator/issues/411))

- _What:_ Promote the two hard-coded constants `CHAPTER_LEAD_SILENCE_SEC = 1.5` and `CHAPTER_POST_TITLE_SILENCE_SEC = 1.5` in `server/src/tts/synthesise-chapter.ts` to a per-book setting on `state.json`. Surface in the Listen view's metadata editor (the same panel that already edits narratorCredit / genre / etc.) as a "Chapter break duration" slider with a small preset list (e.g. 0.5/1/1.5/2/3 s) for the leading + post-title legs. Generation route reads the per-book values and forwards into `synthesiseChapter` opts.
- _Benefit (user):_ lets the user pace chapter breaks to match book length / mood (a tight 0.5 s for a short kids' book, a longer 3 s for a slow-burn novel) without code changes. Today the 3.0 s default is "audiobook-standard" but not universally right.
_Full detail + acceptance:_ [#411](https://github.com/dudarenok-maker/AudioBook-Generator/issues/411).

#### `fs-10` — Render the chapter-title segment on the Listen view timeline ([#412](https://github.com/dudarenok-maker/AudioBook-Generator/issues/412))

- _What:_ The new title segment in `segments.json` (kind: `'title'`, empty `sentenceIds[]`) is currently filtered out at the `ChapterAudio` API boundary in `server/src/routes/chapter-audio.ts` because the wire contract types `sentenceId` as a required integer. To surface the title on the listen-view timeline (a labelled "TITLE" pill anchored at the start of the chapter, ~3 s wide including silence), widen the API segment shape so `sentenceId` is optional and add an optional `kind?: 'title' | 'sentence'` discriminator, regenerate `src/lib/api-types.ts`, then teach `src/components/listen/listen-player-region.tsx` to render title-kind segments differently from sentence-kind segments.
- _Benefit (user):_ visual cue that matches the audible cue — listener sees "you're hearing the title now" before the body segments start. Today the title beat is audible-only.
_Full detail + acceptance:_ [#412](https://github.com/dudarenok-maker/AudioBook-Generator/issues/412).

#### `fs-3` — Streaming audio for live playback during chapter generation ([#414](https://github.com/dudarenok-maker/AudioBook-Generator/issues/414))

- _What:_ Change the chapter audio pipeline from "encode the full chapter, then signal complete" to "emit MP3 frames as ffmpeg produces them, signal each chunk via SSE, frontend appends to a MediaSource". Magic moment: listen as it generates.
- _Benefit (user):_ "listen as it generates" is the magic moment audiobook tools sell on.
_Full detail + acceptance:_ [#414](https://github.com/dudarenok-maker/AudioBook-Generator/issues/414).

#### `fs-17` — Read-along: sentence highlight synced to audio ([#464](https://github.com/dudarenok-maker/AudioBook-Generator/issues/464))

- _What:_ Show manuscript text beside the player and highlight the current sentence as audio plays, leveraging the per-segment timing already used for the waveform; tap a sentence to seek. Widen the API to expose per-sentence start/end if not already surfaced.
- _Benefit (user):_ immersion / accessibility / pronunciation learning — a differentiating feature. (Large; owes its own plan.)
_Full detail + acceptance:_ [#464](https://github.com/dudarenok-maker/AudioBook-Generator/issues/464).

### Cast, voice & duplicates

#### `fe-7` — Per-voice row sample-preview button inside `<VoiceOverridePicker>` ([#416](https://github.com/dudarenok-maker/AudioBook-Generator/issues/416))

- _What:_ Add a per-row Play button that routes through `playSampleWithAutoLoad` (same helper the existing "Preview voice" / cast-row swatch use). Hover/focus reveals the icon on pointer devices; `coarse-pointer:opacity-60` keeps it faintly visible on touch. Sample text comes from the same drawer-level `previewText` the candidate-preview block uses. Single-row in-flight gate (the helper already coalesces concurrent clicks).
- _Benefit (user):_ shortens the "scrolled past 40 Kokoro voices, want to hear three before committing" flow from "pick → close → preview from drawer → pick another" to "▶ in-row, ▶ in-row, pick the one I like." Pairs with the autocomplete added in this bundle — search narrows the list, in-row preview judges the few remaining options.
_Full detail + acceptance:_ [#416](https://github.com/dudarenok-maker/AudioBook-Generator/issues/416).

#### `fe-12` — Bulk pin / bulk delete in voice library ([#420](https://github.com/dudarenok-maker/AudioBook-Generator/issues/420))

- _What:_ Multi-select in the voice library with bulk actions — pin/unpin and delete across the selection (with a confirm + count). Deletion respects in-use voices (warn or block when a voice is assigned to a character in any book).
- _Benefit (user):_ curating a large accumulated voice library stops being a per-voice click-fest.
_Full detail + acceptance:_ [#420](https://github.com/dudarenok-maker/AudioBook-Generator/issues/420).

#### `fe-30` — Voice-actor (multi-narrator) view ([#477](https://github.com/dudarenok-maker/AudioBook-Generator/issues/477))

- _What:_ A voice-centric view that groups characters **by assigned voice** — "this voice plays N characters across M books" — with bulk reassign. The inverse axis of the character-centric cast view; adjacent to `fe-12` / `fs-6` but a different lens.
- _Benefit (user):_ manage a cast at the voice level; spot overloaded voices at a glance.
_Full detail + acceptance:_ [#477](https://github.com/dudarenok-maker/AudioBook-Generator/issues/477).

#### `fs-6` — Batch voice-replace across all books ([#417](https://github.com/dudarenok-maker/AudioBook-Generator/issues/417))

- _What:_ Add a "Replace voice everywhere" affordance in the voice library: pick a current voice, pick a replacement, see a preview of all (book, character) pairs that would be affected, confirm. Affected books' cast slices are mutated; audio is invalidated (regen prompt per book).
- _Benefit (user):_ cross-book voice consistency without per-book re-casting. Common need when switching a recurring narrator across a series.
_Full detail + acceptance:_ [#417](https://github.com/dudarenok-maker/AudioBook-Generator/issues/417).

#### `srv-7` — Cross-series voice linking ([#418](https://github.com/dudarenok-maker/AudioBook-Generator/issues/418))

- _What:_ Plan 108's per-character engine + voice changes propagate across one series via `findAuthorSeriesForBookId`. A character who recurs across DIFFERENT series by the same author (or a shared-universe crossover) is not covered — the rebaseline / per-character write stops at the series boundary by design. Add an explicit cross-series link affordance (extend `Character.aliases` / a new link record) so a deliberate "this is the same voice across series X and Y" decision propagates voice + engine across both.
- _Benefit (user):_ recurring narrators / crossover characters stay consistent across an author's whole catalogue, not just within one series.
_Full detail + acceptance:_ [#418](https://github.com/dudarenok-maker/AudioBook-Generator/issues/418).

#### `fs-12` — Standalone library-voice authoring (a voice not tied to one character) ([#419](https://github.com/dudarenok-maker/AudioBook-Generator/issues/419))

- _What:_ A standalone library-voice authoring surface on top of the per-character Qwen design flow (plan 108, which already designs → clones → caches → reuses a bespoke voice scoped to a cast member). Add first-class library entries not tied to a single character: design a voice from a persona (or a reference clip), name + tag + pin it, reuse it across books, with optional fine-tuning of an already-designed voice.
- _Benefit (user):_ build a personal stable of named narrators to assign across the catalogue, independent of any single character. Pairs with `fe-12` (bulk library ops): a from-scratch author flow is what grows the library big enough to need them.
_Full detail + acceptance:_ [#419](https://github.com/dudarenok-maker/AudioBook-Generator/issues/419).

#### `srv-23` — Opt-in "refresh personas + re-design voices" sweep for existing books ([#423](https://github.com/dudarenok-maker/AudioBook-Generator/issues/423))

- _What:_ a per-book opt-in action that re-runs `generate-all` voice-style then re-designs every Qwen voice from the refreshed personas, so an existing book can adopt the improved format in one click. Must NOT clobber hand-edited personas without confirmation, and must surface the Gemini-quota + GPU-time cost up front.
- _Benefit (user):_ existing libraries can adopt the better voice-design format without re-casting by hand. Low urgency — costly (quota + GPU) and only matters for books a user wants to re-render.
_Full detail + acceptance:_ [#423](https://github.com/dudarenok-maker/AudioBook-Generator/issues/423).

### Revisions & regen

#### `fs-5` — Multi-step rollback / snapshot-per-entry (revision history) ([#415](https://github.com/dudarenok-maker/AudioBook-Generator/issues/415))

- _What:_ Extend plan 20's `preserveExistingAsPrevious` to write `.previous.<entryId>.<slug>.mp3` per timeline entry (not just one `.previous.<slug>.mp3` per chapter). Wire a server `POST /api/books/:bookId/revisions/:entryId/rollback` endpoint that restores a specific timeline entry's audio + flips subsequent entries to `rolled-back-from`. Add a GC pass that prunes oldest snapshots after the user commits (or when disk pressure exceeds a cap, e.g. 10 entries / chapter).
- _Benefit (user):_ closes the centerpiece feature from plan 55 — true non-linear undo per chapter. Today the timeline modal is read-only; the user has to walk through accept/reject in the A/B player.
_Full detail + acceptance:_ [#415](https://github.com/dudarenok-maker/AudioBook-Generator/issues/415).

### Voice & cast sharing

Build bottom-up: `side-13` (safe-load gate) → `fs-28` (bundle format) → `fs-29` / `fs-30` → `fs-31` (externally-facing). Scoped to **synthetic / designed** voices with a consent/licensing note throughout — never framed as cloning a real person's voice.

#### `side-13` — Import safety + provenance for shared voice artifacts ([#485](https://github.com/dudarenok-maker/AudioBook-Generator/issues/485))

- _What:_ A safe ingestion layer for **untrusted** voice artifacts: validation + `weights_only=True` safe-load (or a safetensors/JSON-sidecar container) + a provenance/consent display before any imported voice is usable. Extends `side-12` (our own `.pt` files) to files arriving from other users.
- _Benefit (technical / security):_ makes the entire sharing theme safe to ship — removes the RCE-on-untrusted-file footgun. **Gates `fs-28`/`fs-29`/`fs-30`/`fs-31`.**
_Full detail + acceptance:_ [#485](https://github.com/dudarenok-maker/AudioBook-Generator/issues/485).

#### `fs-28` — Voice export/import bundle (sharing foundation) ([#482](https://github.com/dudarenok-maker/AudioBook-Generator/issues/482))

- _What:_ Export a designed voice — embedding `.pt` + persona + metadata + provenance — as one portable bundle, and import it into another install's library (through the `side-13` safe-load layer). The base format every other sharing item builds on.
- _Benefit (user):_ share a great character voice + back up the most expensive asset (designed voices). _Depends on `side-13`; blocks `fs-29`/`fs-30`/`fs-31`._
_Full detail + acceptance:_ [#482](https://github.com/dudarenok-maker/AudioBook-Generator/issues/482).

#### `fs-29` — Cast/profile pack sharing ([#483](https://github.com/dudarenok-maker/AudioBook-Generator/issues/483))

- _What:_ Export a book's full cast (character personas + voice assignments) as a shareable pack; import to seed a new book or apply on a re-read. Builds on the `fs-28` bundle format and ties into `srv-1` (merge journal) + the cross-book reuse machinery.
- _Benefit (user):_ reuse a curated cast; hand a friend your exact setup for a book. _Depends on `fs-28` (+ `side-13`)._
_Full detail + acceptance:_ [#483](https://github.com/dudarenok-maker/AudioBook-Generator/issues/483).

#### `fs-30` — Whole voice-library export/import ([#484](https://github.com/dudarenok-maker/AudioBook-Generator/issues/484))

- _What:_ Bulk export the entire voice library (all designed voices + metadata) as one archive for backup, migration to a new machine, or wholesale sharing — and import it back, through `side-13` safe-load. Complements `srv-2` (auto-backup) and `fs-1` (upgrade/migration).
- _Benefit (user / technical):_ portability + disaster recovery for the most expensive asset in the app. _Depends on `fs-28` (+ `side-13`)._
_Full detail + acceptance:_ [#484](https://github.com/dudarenok-maker/AudioBook-Generator/issues/484).

#### `fs-31` — Community voice registry / share-by-link ([#486](https://github.com/dudarenok-maker/AudioBook-Generator/issues/486))

- _What:_ Publish a designed voice to a shared location and let others pull it by link/code — the flagship "community library" version. Requires a hosting story the local-first app doesn't have yet, plus a licensing/consent/abuse policy, and `side-13` as a hard prerequisite.
- _Benefit (user):_ a community library — the most ambitious expression of voice sharing. The only item here that publishes data externally; treat as its own initiative after `fs-28` + `side-13` land. (Large; owes a regression plan + a privacy/licensing/abuse design.)
_Full detail + acceptance:_ [#486](https://github.com/dudarenok-maker/AudioBook-Generator/issues/486).

### Net-new capabilities

#### `fs-38` — Voice cloning (your own / family voice) + cloned-vs-designed library split ([#624](https://github.com/dudarenok-maker/AudioBook-Generator/issues/624))

- _What:_ Clone a real person's voice from a short in-app sample (XTTS reference first, then Qwen design-to-target) and cast it like any other voice — held consistent across a book/series. Explicit consent on the record; cloned voices get their own `#/voices` section and are excluded from the cross-book reuse matcher; local-only. The **next big release** — pays off the _"even in your own voice"_ promise.
- _Benefit (user):_ the most personal, gift-able feature — a bedtime story in your own voice, or your kid as the hero.
_Full detail + acceptance:_ plan [`194-voice-cloning.md`](features/194-voice-cloning.md) · [#624](https://github.com/dudarenok-maker/AudioBook-Generator/issues/624).

#### `fs-27` — Chapter recaps / "previously…" summaries ([#481](https://github.com/dudarenok-maker/AudioBook-Generator/issues/481))

- _What:_ LLM-generated short recap per chapter (the analyzer already does LLM work), shown — and optionally synthesized as a spoken "previously…" intro — when the user resumes a book after a gap. Opt-in per book; cost surfaced up front.
- _Benefit (user):_ graceful re-entry into a long book after days away.
_Full detail + acceptance:_ [#481](https://github.com/dudarenok-maker/AudioBook-Generator/issues/481).

#### `fe-32` — Rebaseline modal: series-wide emotion-variant design (fs-25 Wave 6b) ([#512](https://github.com/dudarenok-maker/AudioBook-Generator/issues/512))

- _What:_ Extend the plan-108 "Rebaseline the series" modal to also design chosen emotion variants for the principal cast across a series (gated on each base existing), reusing the Wave-5b per-emotion controls + variant-aware audition; the base-only path stays intact when no variants are selected.
- _Benefit (user):_ design expressive variants for a recurring cast across a whole series in one flow. _Re-homed from `fs-25` on archive._
_Full detail + acceptance:_ [#512](https://github.com/dudarenok-maker/AudioBook-Generator/issues/512).

#### `fs-35` — per-chapter Detect-emotions trigger (fs-33 follow-up) ([#592](https://github.com/dudarenok-maker/AudioBook-Generator/issues/592))

- _What:_ Add a per-chapter "Detect emotions" option (the emotion-only backfill pass scoped to the current chapter) alongside the whole-book trigger. The fs-33 v1 shipped whole-book only.
- _Benefit (user):_ cheap targeted re-detect for one edited/late-added chapter without re-running the whole book's quota.
_Full detail + acceptance:_ [#592](https://github.com/dudarenok-maker/AudioBook-Generator/issues/592).

#### `fs-36` — per-quote emotion: "manual clear sticks" sentinel (fs-33 follow-up) ([#593](https://github.com/dudarenok-maker/AudioBook-Generator/issues/593))

- _What:_ A manually-*cleared* emotion is stored as `undefined` today, indistinguishable from never-set, so a re-run of Detect-emotions re-fills it. Persist an explicit `neutral` sentinel and have `applyDetectedEmotions` treat it as occupied.
- _Benefit (user):_ an intentional "no emotion here" survives a later Detect-emotions run.
_Full detail + acceptance:_ [#593](https://github.com/dudarenok-maker/AudioBook-Generator/issues/593).

#### `fe-34` — Voices view: "Has emotion variants" filter (fs-34 follow-up) ([#595](https://github.com/dudarenok-maker/AudioBook-Generator/issues/595))

- _What:_ The cross-book Voices view renders the `VariantsBadge` on Qwen designed-voice cards (shipped), but has no status-filter like the cast view's chips. Add a filter toggle to narrow the view to voices whose character has ≥1 designed emotion variant.
- _Benefit (user):_ quickly find which cross-book voices already have expressive variants.
_Full detail + acceptance:_ [#595](https://github.com/dudarenok-maker/AudioBook-Generator/issues/595).

#### `fe-4` — Single-poll TTS lifecycle for a third consumer (tracking) ([#421](https://github.com/dudarenok-maker/AudioBook-Generator/issues/421))

- _What:_ Tracking item. The consolidated `useTtsLifecycle()` hook (`src/lib/use-tts-lifecycle.ts`) drives today's pill surfaces — top-bar (`src/components/layout.tsx`) and Generation view (`src/views/generation.tsx`) — from one `setInterval` via `LayoutContext`. Per the 2026-05-21 Kokoro-Stop-pill change, the hook now fans out per engine: it returns `{ coqui, kokoro, evictionNotice, loadErrorNotice, dismissNotices }` from a single /health probe. **Wake this item when a JIT-warmed surface graduates to pill-driven UI.** Concrete triggers: Profile Drawer Play, Cast row Play, or the per-character "regenerate this voice across the book" button — whichever first stops using `playSampleWithAutoLoad` and starts wanting an always-on Load/Stop affordance.
- _Benefit (architectural):_ prevents the duplicated-poll explosion that motivated plan 30 G1 in the first place.
_Full detail + acceptance:_ [#421](https://github.com/dudarenok-maker/AudioBook-Generator/issues/421).

### Onboarding & first-run

#### `fs-22` — Bundled demo book (real, generate-able) ([#475](https://github.com/dudarenok-maker/AudioBook-Generator/issues/475))

- _What:_ Ship a tiny public-domain manuscript so a new user can analyze + generate + hear real output in ~30s without uploading anything. Distinct from the mock canned-data — this one runs the real pipeline and doubles as a smoke test.
- _Benefit (user):_ instant "wow" + a built-in end-to-end smoke test.
_Full detail + acceptance:_ [#475](https://github.com/dudarenok-maker/AudioBook-Generator/issues/475).

#### `fe-28` — Onboarding empty states + first-run checklist ([#472](https://github.com/dudarenok-maker/AudioBook-Generator/issues/472))

- _What:_ Make first-run guidance explicit: the books-library empty state walks a new user to their first upload, plus a small dismissible first-run checklist (upload → confirm cast → generate → listen). Pure frontend, driven off existing state.
- _Benefit (user):_ reduces first-session bounce for non-technical deployers.
_Full detail + acceptance:_ [#472](https://github.com/dudarenok-maker/AudioBook-Generator/issues/472).

#### `fe-27` — In-app update notifier ([#471](https://github.com/dudarenok-maker/AudioBook-Generator/issues/471))

- _What:_ Check GitHub Releases (via a small server proxy) and surface "vX.Y.Z available" + a changelog link when the running version is behind. Complements `fs-1` (the upgrade *mechanism*) — this is the *prompt*.
- _Benefit (user):_ closes the distribution loop so testers actually know to upgrade.
_Full detail + acceptance:_ [#471](https://github.com/dudarenok-maker/AudioBook-Generator/issues/471).

#### `fe-29` — In-app help / troubleshooting panel ([#473](https://github.com/dudarenok-maker/AudioBook-Generator/issues/473))

- _What:_ A Help surface covering core workflows, keyboard shortcuts (from the keybindings registry), and the common-failure remediations (shares copy with `fs-19`). Works offline.
- _Benefit (user):_ support deflection; the answers live where the user already is.
_Full detail + acceptance:_ [#473](https://github.com/dudarenok-maker/AudioBook-Generator/issues/473).

#### `fs-21` — First-run setup wizard ([#474](https://github.com/dudarenok-maker/AudioBook-Generator/issues/474))

- _What:_ A guided fresh-install flow: detect GPU, check/install the required models (Kokoro, Qwen, analyzer), pick defaults (engine, analysis model, theme), then run a one-sentence smoke synth to prove the whole stack end to end before the user uploads anything.
- _Benefit (user):_ turns a multi-step manual bootstrap into one guided path — the biggest adoption lever for non-technical deployers. (Large; owes its own plan — pairs with `fs-1`/`ops-1`/`ops-2`.)
_Full detail + acceptance:_ [#474](https://github.com/dudarenok-maker/AudioBook-Generator/issues/474).

#### `fe-1` — In-app LAN HTTPS banner under dev settings ([#401](https://github.com/dudarenok-maker/AudioBook-Generator/issues/401))

- _What:_ Account settings card showing the current LAN HTTPS URL (from `GET /api/export/lan` when LAN_HTTPS=1) with one-click "Copy URL" + "Install cert on phone" links. The latter opens a doc / route that shows the QR code that `npm run install:cert-mobile` prints to the terminal today. Dev-mode only — hidden in production single-user environments.
- _Benefit (user):_ surfaces the LAN access flow inside the app instead of requiring the user to read terminal output. Especially valuable for users who first installed via the alpha release zip (no terminal interaction expected). **Demoted from Should on 2026-06-02** — niche dev/LAN surfacing.
- _Companion coherence (plan 188):_ shares the LAN-URL + cert plumbing, but the companion (`app-2`) needs its own **structured pairing QR** carrying `{ url, token, caFingerprint }` — do NOT make `fe-1`'s browser-open QR a JSON blob (a phone browser can't scan it). The pairing-QR surface reuses this machinery; whoever builds it (with `srv-20`) is the home for the companion QR.
_Full detail + acceptance:_ [#401](https://github.com/dudarenok-maker/AudioBook-Generator/issues/401).

#### `fe-5` — Broad hover-affordance audit with `coarse-pointer:` Tailwind variant ([#402](https://github.com/dudarenok-maker/AudioBook-Generator/issues/402))

- _What:_ Plan 81 wave 4 shipped a `coarse-pointer:` Tailwind variant (matches `@media (pointer: coarse)`) for touch devices that don't expose hover. First consumer is the manuscript boundary handle label. Sweep `src/` for all uses of `group-hover:` / `peer-hover:` / `hover:opacity-0` and apply the variant where the hover-revealed content is functional (e.g. action buttons), not purely decorative (e.g. card lift transitions).
- _Benefit (user):_ touch users get every action that mouse users do, without needing to discover hidden affordances. **Demoted from Should on 2026-06-02** — touch-a11y polish sweep.
_Full detail + acceptance:_ [#402](https://github.com/dudarenok-maker/AudioBook-Generator/issues/402).

### Security & hardening

Source for the whole sub-group: the [2026-05-31 security review](security/2026-05-31-security-review.md). All are scoped to the **opt-in LAN exposure surface** (`npm run start:lan`) or local-only defense-in-depth — the app is single-user/local-first by design, so these harden the hostile-LAN and local-write threat models rather than fixing an exploited-today hole. `srv-19` (draft plan 157) is the partner default-bind fix.

#### ✅ `srv-20` — Optional shared-secret token for the LAN flow — **SHIPPED 2026-06-06** (PR #561 + #564, closed #425) ([#425](https://github.com/dudarenok-maker/AudioBook-Generator/issues/425))

- _What:_ a single shared-secret token (env-configured, surfaced in the LAN URL / QR alongside the existing cert flow) checked by a small Express middleware on `/api/*` and the `/workspace` mount when LAN mode is on. Loopback requests bypass the check (so `npm start` is unaffected). Reuse the existing LAN-URL/QR plumbing (`GET /api/export/lan`, `npm run install:cert-mobile`) to carry the token.
- _Benefit (user):_ the mobile flow stops being "open to everyone on the network" without re-introducing friction — the token rides the URL the user already scans.
- _Companion dependency:_ the **Android companion app** (plan 188, `app-2`) depends on this token as its v1 auth primitive, and needs the QR/pairing payload to also carry the CA **SHA-256 fingerprint** so the app auto-verifies the pinned cert (no manual hex compare). Two acceptance constraints from the companion: **exempt `/cert/root.crt`** from the token check (public CA material the app fetches over the untrusted channel *before* it can present the token), and don't break the web app's existing LAN access. A kickoff-time reason to prioritise it. The multi-device / revocable evolution is `srv-33`.
_Full detail + acceptance:_ [#425](https://github.com/dudarenok-maker/AudioBook-Generator/issues/425).

#### `side-12` — Load Qwen voice `.pt` prompts with `weights_only=True` (or a safe format) ([#428](https://github.com/dudarenok-maker/AudioBook-Generator/issues/428))

- _What:_ switch the voice-prompt load to `weights_only=True`; if the saved payload isn't a pure tensor/state-dict, migrate the design-time save (`design_voice`) to a safe container (safetensors, or JSON sidecar + tensors) so the load no longer needs arbitrary unpickling. One-time read-compat shim for already-cached `.pt` files (re-derive or one-shot re-save). Prerequisite groundwork for `side-13`.
- _Benefit (technical):_ removes a local RCE-on-untrusted-file footgun; aligns with torch's `weights_only` default direction.
_Full detail + acceptance:_ [#428](https://github.com/dudarenok-maker/AudioBook-Generator/issues/428).

#### `srv-22` — Constrain / document the `sync-folder/test` write-probe path ([#427](https://github.com/dudarenok-maker/AudioBook-Generator/issues/427))

- _What:_ the probe is a legitimate "is this folder writable" UX check, so the fix is proportionate: keep the feature but (a) refuse obviously-dangerous targets (system roots), and/or (b) document the trust boundary explicitly and lean on `srv-19`/`srv-20` to remove the unauth-LAN reachability. Decide between hard-constraint vs. document-and-gate when the item opens.
- _Benefit (technical):_ removes a small unauthenticated filesystem-touch primitive without breaking the Test button.
_Full detail + acceptance:_ [#427](https://github.com/dudarenok-maker/AudioBook-Generator/issues/427).

### Ops, CI & distribution


#### `ops-9` — Enable server-side branch protection on `main` (when Pro/public) ([#429](https://github.com/dudarenok-maker/AudioBook-Generator/issues/429))

- _What:_ create an active ruleset on the default branch blocking deletion + non-fast-forward (force) pushes. Ready command:
- _Benefit (technical):_ server-side enforcement that no `--no-verify` local bypass or fresh clone can sidestep; the local guard (plan 163) becomes belt-and-suspenders. Required status checks deliberately excluded (would deadlock doc-only PRs that skip `verify.yml`).
_Full detail + acceptance:_ [#429](https://github.com/dudarenok-maker/AudioBook-Generator/issues/429).

#### `srv-4` — Track upstream-blocked deprecation chains (jsdom · archiver · @google/genai) ([#431](https://github.com/dudarenok-maker/AudioBook-Generator/issues/431))

- _What:_ Periodically re-run the deprecation audit (`npm install` at root + `npm install --prefix server` on a fresh clone, grep `npm warn deprecated`) and bump direct deps whose upstream majors drop one of these transitives. Status of the three tracked chains:
- _Benefit (technical):_ keeps the `npm install` warning surface clean over time. Without explicit tracking, deprecation messages accumulate, new ones get lost in the noise, and the eventual audit becomes harder. This item is the watchdog. As of 2026-06-01 a fresh root `npm install` prints ZERO deprecation warnings (ESLint 9 + jsdom 29 + archiver 8 all cleared); the only remaining deprecation in the monorepo is the `@google/genai` `node-domexception` chain on the server side.
_Full detail + acceptance:_ [#431](https://github.com/dudarenok-maker/AudioBook-Generator/issues/431).

#### `ops-1` — Windows installer (Inno Setup or NSIS) wrapping the release zip ([#432](https://github.com/dudarenok-maker/AudioBook-Generator/issues/432))

- _What:_ Add an Inno Setup (or NSIS) script that wraps the `audiobook-generator-vX.Y.Z.zip` produced by the release-package pipeline (plan 49) into a signed `.exe` installer. Installer extracts to `%LocalAppData%\AudiobookGenerator`, drops a Start Menu entry, runs prerequisite checks (Node 20.6+, Python 3.11, ffmpeg on PATH) with download links shown for any missing dep, and offers to run `install-kokoro.ps1` post-install. Extend `release.yml` with a follow-on job that builds the installer (on a Windows runner) and uploads it as a second release asset.
- _Benefit (user):_ friction-free install for non-developers. Today's plan-49 deployer must read INSTALL.md and run PowerShell commands by hand; the installer reduces that to a click.
_Full detail + acceptance:_ [#432](https://github.com/dudarenok-maker/AudioBook-Generator/issues/432).

#### `ops-2` — Docker image + compose file for headless / Linux deployment ([#433](https://github.com/dudarenok-maker/AudioBook-Generator/issues/433))

- _What:_ Add a multi-stage `Dockerfile` (frontend build → node runtime stage → sidecar Python stage) and a `docker-compose.yml` that wires the three services on `:5173 / :8080 / :9000`. Document the NVIDIA Container Toolkit GPU-passthrough prereq. Resolve whether `WORKSPACE_DIR` is bind-mounted from the host or held in a named volume (host-bind recommended — keeps per-book `.audiobook/state.json` portable across container rebuilds). Extend `release.yml` with `docker/build-push-action` to publish the image to `ghcr.io/dudarenok-maker/audiobook-generator:vX.Y.Z` on tag push.
- _Benefit (user):_ enables hosting on a Linux box with a GPU (home server, single-tenant VPS) — the Windows-only PowerShell orchestration is the current ceiling for that use case.
- _Companion coherence (plan 188):_ if the companion is used against a Dockerised server, (a) **mount a persistent volume for the mkcert CA** (`mkcert -CAROOT` dir) so the pinned `caFingerprint` survives container rebuilds (else every update forces a re-pair), and (b) honour a **`LAN_HOST` override** in `enumerateLanUrls` (`export-lan.ts` reads `os.networkInterfaces()` → container bridge IPs like `172.18.0.x`) so the pairing QR carries the host's real LAN IP.
_Full detail + acceptance:_ [#433](https://github.com/dudarenok-maker/AudioBook-Generator/issues/433).

### Listener-app handoffs

#### `fe-3` — Apple Books (iOS / macOS) handoff modal ([#434](https://github.com/dudarenok-maker/AudioBook-Generator/issues/434))

- _What:_ Wire Apple Books tile with the appropriate handoff: macOS supports drag-into-Books; iOS supports AirDrop or sync via Files. Modal shows the platform-specific flow (detect Mac vs other UA, default to "iOS via AirDrop"). Copy-and-instructions only — no direct integration with Apple Books library API (which is restricted).
- _Benefit (user):_ closes one more "Coming soon" tile.
_Full detail + acceptance:_ [#434](https://github.com/dudarenok-maker/AudioBook-Generator/issues/434).

#### `fs-7` — Plex (self-hosted media server) handoff modal ([#435](https://github.com/dudarenok-maker/AudioBook-Generator/issues/435))

- _What:_ Wire Plex tile with two paths: (a) instructions for manual upload to a Plex server library, (b) optional direct upload via the Plex API if the user has provided a Plex token (settings field). Path (b) is the most-complex of the four — Plex auth + library scan trigger.
- _Benefit (user):_ closes one more "Coming soon" tile; opens the door to direct upload integration.
_Full detail + acceptance:_ [#435](https://github.com/dudarenok-maker/AudioBook-Generator/issues/435).

#### `fs-8` — PocketBook Cloud direct upload OR `@pbsync.com` email gateway ([#436](https://github.com/dudarenok-maker/AudioBook-Generator/issues/436))

- _What:_ Research and prototype either (a) PocketBook Cloud upload (protocol is closed — needs reverse-engineering or vendor contact) or (b) sending the exported file as an attachment to `<user>@pbsync.com` (officially marketed for ebooks; audiobook size limits undocumented).
- _Benefit (user):_ true sideload-free path. Low priority because LAN download + sync folder already work.
_Full detail + acceptance:_ [#436](https://github.com/dudarenok-maker/AudioBook-Generator/issues/436).

### Android companion app (Flutter)

A net-new, multi-week initiative: a native Android-first listening companion that
**delta-syncs a constantly-regenerated library** (per-chapter `…/audio.mp3` pulls, not
whole-book M4B re-exports) with **two-way resume sync**, offline playback, and
Bluetooth/lock-screen controls — the differentiator vs. the export→sideload→third-party
flow above (`fe-3`/`fs-7`/`fs-8`, which it complements, not obsoletes). Full spec, v1
definition-of-done, and the 7-wave delivery roadmap live in **[plan
188](features/188-android-companion-app.md)** — the canonical detail home for this
group. Flutter (`just_audio`/`audio_service`) so iOS is an incremental follow-up; the
load-bearing iOS-readiness move is **app-managed, auto-verified TLS trust** (the QR
carries the CA fingerprint; the app pins the fetched `/cert/root.crt` after asserting its
hash matches — no OS cert install, no manual hex compare).

> _GitHub issues filed (#538–#555); each row links its issue. **[Plan 188](features/188-android-companion-app.md)
> stays the canonical detail home** for this group — the issues are thin tracking hooks.
> Five 2026-06-06 reviews are folded into the plan. IDs + positions are final._
>
> _**Progress (2026-06-06):** ✅ shipped — `srv-34`, `srv-20`, `app-1`, `app-2` (the MVP
> foundation; full toolchain installed + the app runs on a Pixel 10 Pro emulator — see
> plan 188 → "Build progress & dev setup"). 🔄 in progress on a parallel agent — `srv-35`,
> `srv-32`; the rest of the app track is gated on those. Rows below are prefixed ✅/🔄._

**Server prereqs:**

- 🔄 *(parallel agent)* `srv-32` ([#538](https://github.com/dudarenok-maker/AudioBook-Generator/issues/538)) — **Per-chapter sync-manifest endpoint** — **two-level** (book index + per-book detail), gzip'd; carries each chapter's stable `uuid`, fingerprint, **actual audio `urlSuffix`** (mp3/m4a/ogg), and active-ID sets; `?since` delta; fingerprint must bump on every audio-mutating path. _Benefit:_ delta sync that scales to big libraries + is multi-format-safe. Feeds `fs-15`.
- ✅ **SHIPPED (PR #558)** `srv-34` ([#539](https://github.com/dudarenok-maker/AudioBook-Generator/issues/539)) — **Listen-progress PUT accepts client `listenedAt`** + **guarded compare-and-set** (commit only if strictly newer; return the stored record on a stale write). _Benefit:_ offline-correct conflict ordering AND safe concurrent web+companion writers (does not wake `srv-10`/`fe-11`); unblocks `app-6`.
- 🔄 *(parallel agent)* `srv-35` ([#540](https://github.com/dudarenok-maker/AudioBook-Generator/issues/540)) — **Stable per-chapter identifier** (immutable `uuid` preserved through restructure/rename + lazy migration), keying the sync manifest + listen-progress. **MVP (user directive 2026-06-06).** Verified gap: chapter `id` is positional and `slug` embeds id+title, so neither survives reorder/rename. Also repairs the **existing web player**. Lands first in the server track.

**MVP block (v1)** — ranked:

1. ✅ **SHIPPED (PR #562)** `app-1` ([#541](https://github.com/dudarenok-maker/AudioBook-Generator/issues/541)) — Flutter scaffold (`apps/android/`) + test harness + CI lane (incl. unsigned iOS compile) + debug APK. _Benefit:_ the foundation everything builds on.
2. ✅ **SHIPPED (PR #565/#566/#567)** `app-2` ([#542](https://github.com/dudarenok-maker/AudioBook-Generator/issues/542)) — Pairing + **auto-verified app-managed TLS trust** (QR fingerprint match; bad-cert-bypass bootstrap then pin) + a cert-pinned `ApiClient` + secure token. _Benefit:_ one-time, MitM-safe pairing that works on Android *and* iOS. _Depends:_ `srv-20`.
3. ✅ **SHIPPED** `app-3` ([#543](https://github.com/dudarenok-maker/AudioBook-Generator/issues/543)) — Delta sync engine: per-book pull via the manifest's per-chapter `urlSuffix` (never hardcodes `.mp3`); range-resume from the partial `.tmp` (no restart at byte 0) + size integrity; atomic `.tmp`→rename swap, defers if playing; thin `flutter_foreground_task` keep-alive shim; evict via active-ID diff; keyed by the `srv-35` `uuid`. 41 paired Dart tests; live device acceptance owed (no sync-trigger UI until `app-7`/`app-14`). _Benefit:_ no full-book resync; downloads resume + finish in the background.
4. ✅ **SHIPPED** `app-4` ([#544](https://github.com/dudarenok-maker/AudioBook-Generator/issues/544)) — Offline library store: **drift/SQLite** `DriftLocalLibrary` behind the app-3 `LocalLibrary` port (actual codec extension stored; accounting + auto-eviction — auto-delete-finished + LRU book eviction) + cover **thumbnails** (~250×250 client-downscaled, also for lock-screen) + one-time `sync-state.json`→drift import. On-device only (server `state.json` untouched). 25 paired Dart tests; live device acceptance owed. _Benefit:_ listen anywhere; cache never fills the phone; lists stay smooth.
5. ✅ **SHIPPED** `app-5` ([#545](https://github.com/dudarenok-maker/AudioBook-Generator/issues/545)) — Native player: testable `PlayerController` over an injectable `AudioEngine` (per-book resume/switch, ~10 s autosave throttle survives OS kill, media keys default to **seek ±30/±15 s** not chapter-skip, `isInUse` for app-3 deferred swap) + drift Playback table; real `JustAudioEngine` + `CompanionAudioHandler` (audio_service lock-screen/Bluetooth/notification). 14 paired Dart tests; live device acceptance owed (batched at end). _Benefit:_ table-stakes UX that survives backgrounding + car controls.
6. ✅ **SHIPPED** `app-6` ([#546](https://github.com/dudarenok-maker/AudioBook-Generator/issues/546)) — Two-way resume sync: pure `reconcileResume` (**last-write-wins by client `listenedAt`**, not network-receive time) + `ResumeSyncService` (push/pull/noop; local Playback row = offline queue) + `ApiClient.get/putListenProgress` (CA-pinned, srv-34). 12 paired Dart tests; live device acceptance owed (batched). _Benefit:_ in-car position flows back without clobbering a newer position set elsewhere.
7. ✅ **SHIPPED** `app-7` ([#547](https://github.com/dudarenok-maker/AudioBook-Generator/issues/547)) — Hierarchical browse + management: pure `library_tree` (**author → series → book** grouping/sort + search) + `LibraryScreen` (collapsible groups, state pills, download/remove). 9 paired Dart tests; live device acceptance owed (batched). _Benefit:_ find any book fast in a big multi-series library.
8. ✅ **SHIPPED** `app-14` ([#550](https://github.com/dudarenok-maker/AudioBook-Generator/issues/550)) — Home shelf + multi-book switching: pure `home_shelf` ("Continue listening" most-recently-played first + recently-updated rail) + `HomeScreen` (tap → player `switchBook` for seamless per-book resume). 6 paired Dart tests; live device acceptance owed (batched). _Benefit:_ the listen-to-several-books day-to-day surface.
9. ✅ **SHIPPED** `app-8` ([#548](https://github.com/dudarenok-maker/AudioBook-Generator/issues/548)) — Auto-sync on reconnect: pure `shouldAutoSync` gate (**network-gated** — never mobile/offline, only when the paired server is reachable, **unmetered-only** unless opted in; token never leaves the home LAN) + `AutoSyncService` (pre-gates before probing) + `connectivity_plus` resolver. 17 paired Dart tests; live device acceptance owed (batched). _Benefit:_ fixes + new chapters appear with no manual action, safely off-network.
10. ✅ **SHIPPED** `app-13` ([#549](https://github.com/dudarenok-maker/AudioBook-Generator/issues/549)) — Playback & download settings: pure `AppSettings` (**sleep timer**, skip-button toggle seek-vs-chapter, **unmetered-Wi-Fi-only**, auto-sync, **storage cap + auto-delete-finished + LRU keep-recent** — drives app-5/app-4/app-8) + `SettingsStore` (JSON, defaults-on-corrupt) + testable `SleepTimer` + `SettingsScreen`. 14 paired Dart tests; live device acceptance owed (batched). _Benefit:_ the settings a real listening app needs. _(Shake-to-extend sleep timer = follow-up nice-to-have.)_

**Follow-ups (post-MVP)** — ranked:

11. ✅ **SHIPPED** `srv-33` ([#551](https://github.com/dudarenok-maker/AudioBook-Generator/issues/551)) — Per-device tokens + revoke (server, layered on `srv-20`): `device-tokens.ts` store (sha-256 at rest, cache-backed) + `GET/POST/DELETE /api/devices` behind the LAN guard + `lan-auth` accepts shared secret OR a non-revoked device token. Backward-compatible. 18 server tests + openapi. App-side adoption is an optional follow-up. _Benefit:_ revocable per-device access.
12. ✅ **SHIPPED** `app-9` ([#552](https://github.com/dudarenok-maker/AudioBook-Generator/issues/552)) — In-car (**Android Auto + CarPlay**): pure `media_browse_tree` (root→books→chapters + mediaId codec) wired into `CompanionAudioHandler` MediaBrowser callbacks + Android Auto descriptor. 6 paired Dart tests; head-unit acceptance owed (batched). _Benefit:_ first-class in-car beyond the Bluetooth path.
13. ⛔ **BLOCKED (reopened)** `app-10` ([#553](https://github.com/dudarenok-maker/AudioBook-Generator/issues/553)) — Stream-over-LAN instant play. The pure pieces shipped (`resolvePlaybackSource` + `AppSettings.streamOverLan` + `AudioEngine.setStreamUrl`, 4 tests) but **cannot be wired**: `just_audio` streams via the platform player (ExoPlayer/AVPlayer) over the **OS** network stack, which can't trust the **app-pinned mkcert CA** (the TLS model deliberately avoids an OS cert install) → streaming `https://<lan>:8443` fails TLS. No `streamOverLan` toggle was wired (no dead control). _Unblock (later):_ a local loopback proxy that re-serves chapter bytes (fetched via the pinned `ApiClient`) to just_audio over `127.0.0.1`. Low priority — offline-first download/play is unaffected. _Benefit when unblocked:_ zero-wait preview before a download.
14. ✅ **SHIPPED** `app-11` ([#554](https://github.com/dudarenok-maker/AudioBook-Generator/issues/554)) — Distribution: Gradle release signing via git-ignored `key.properties` (real upload keystore) with a debug-signed fallback so `flutter build apk --release` always sideloads; `key.properties.example` + CI `companion-release-apk` artifact. Release APK verified (65.6 MB). _Benefit:_ testers can install it.

---

## Won't (this round) — explicitly parked

Specific items someone might reasonably re-propose. Each carries a _Why parked_ (the v1 design or operational constraint) and a _Wake when_ (the trigger that makes us reopen). The broad "v1 scope freeze" and "no visual redesign" are covered by CLAUDE.md "Out of scope" and don't need restating here — this list is for tracked-specific decisions only.

- `ops-5` — Trim `build` / `e2e` out of the per-PR `verify.yml` ([#437](https://github.com/dudarenok-maker/AudioBook-Generator/issues/437)). _Why parked:_ would shave ~1–3 min off each frontend/server PR run, but the dev box is Windows (case-insensitive FS) and CI is Linux (case-sensitive) — a build break like a wrong-case import would slip past PR CI and only surface in ` … _Wake when:_ the safer round-2 levers prove insufficient AND a Linux-build / e2e signal moves earlier in the pipeline (e.g. …

- `side-4` — A/B Qwen `x_vector_only_mode=True` (speed vs. fidelity) ([#438](https://github.com/dudarenok-maker/AudioBook-Generator/issues/438)). _Why parked:_ the perf problem that motivated it is solved — after the plan-113 batching + the concurrent-batch race fix, end-to-end Qwen chapters run at **~RTF 1.15**, and the **2026-05-31 overnight full-book run held aggregate RTF ≈ … _Wake when:_ Qwen synthesis becomes a real bottleneck again (much longer books, a slower GPU, or a per-quote-emotion feature that inflates decode cost) AND a listen-test shows x-vector-only holds identity acceptably.

- `side-7` — Qwen decode CUDA-graph / static-cache spike (probe-gated) ([#439](https://github.com/dudarenok-maker/AudioBook-Generator/issues/439)). _Why parked:_ the perf goal is met. The 2026-05-31 overnight full-book run rendered 25 real multi-voice chapters at aggregate **RTF ≈ 1.04** (range 0.91–1.26) on the adopted 32/3600 + single-worker config — ~realtime, the target. … _Wake when:_ Qwen synthesis becomes a real bottleneck again (much longer books, a slower GPU, or a per-quote-emotion feature that inflates decode cost). Then run plan-129 Probe 1 first; only fork if it proves still launch-bound.

- `side-10` — Coalesce consecutive same-speaker short lines before batching ([#440](https://github.com/dudarenok-maker/AudioBook-Generator/issues/440)). _Why parked:_ two reasons. (1) **Perf goal met** — the 2026-05-31 overnight full-book run held aggregate RTF ~1.04 even on multi-voice/dialogue-dense chapters, so the dialogue floor isn't worth chasing. … _Wake when:_ Qwen synthesis becomes a real bottleneck again specifically on dialogue-dense books AND a captions/timing-preservation design + a quality A/B prove the merge doesn't hurt quote-audit fidelity.

- `ops-4` — Auto-install Ollama / auto-pull models ([#441](https://github.com/dudarenok-maker/AudioBook-Generator/issues/441)). _Why parked:_ installer + `ollama pull` are platform-specific and fragile under the OneDrive workspace path; the README addendum + explicit user opt-in is the v1 contract. _Wake when:_ Ollama upstream ships a stable cross-platform headless installer, OR a CI / dev-container path needs one-command bring-up. Likely two separate items then.

- `srv-8` — Multi-model fan-out for Gemini analyzer ([#442](https://github.com/dudarenok-maker/AudioBook-Generator/issues/442)). _Why parked:_ one model per run keeps cost predictable and the SSE stream simple; A/B comparison today is two sequential runs. _Wake when:_ a real product use case for "render the same chapter under two models side-by-side in one view" emerges. The audio-layer a/b audition (plan 20) covers the listening-side intent today.

- `fe-11` — Multi-tab catch-up race resilience ([#443](https://github.com/dudarenok-maker/AudioBook-Generator/issues/443)). _Why parked:_ disk `state.json` is authoritative + single-user-per-workspace, so two tabs on the same book never compete on writes. Tab B catches up by re-reading state on focus. _Wake when:_ multi-user collab on a shared workspace becomes a real use case. Pairs with `srv-10` — both wake under the same trigger.

- `fe-13` — Live `VITE_USE_MOCKS` toggle in running UI ([#444](https://github.com/dudarenok-maker/AudioBook-Generator/issues/444)). _Why parked:_ the mock layer swaps the entire `api` module at module-load via the env flag; flipping at runtime would need a different architecture (e.g. mock middleware around the api object). _Wake when:_ demo / QA flow requires mid-session real↔mock flipping. Today rebuilding with `VITE_USE_MOCKS=true` takes 5 s — building the runtime toggle would cost more than the friction it removes.

- `srv-10` — Conflict resolution for two simultaneous `state.json` writers ([#445](https://github.com/dudarenok-maker/AudioBook-Generator/issues/445)). _Why parked:_ single-user-per-workspace assumption; file locking is advisory at best on Windows network shares. _Wake when:_ multi-user collab on a shared workspace becomes a real use case. Pairs with `fe-11` — both wake under the same trigger.

- `srv-6` — Engine-drift factor polish + `resolvedVoiceName` backfill ([#446](https://github.com/dudarenok-maker/AudioBook-Generator/issues/446)). _Why parked:_ the user is regenerating the whole catalogue with Qwen, so every book will get a fresh post-plan-108 `resolvedVoiceName` snapshot at render time — there are no stranded legacy chapters left for the backfill to rescue. _Wake when:_ a corpus of pre-plan-108 chapters that will _not_ be regenerated needs drift detection after all (e.g. an imported back-catalogue from another deployer). Until then the regen sweep makes the backfill moot.

- `srv-5` — Tune per-engine VRAM cost map against real hardware ([#447](https://github.com/dudarenok-maker/AudioBook-Generator/issues/447)). _Why parked:_ most of the original scope dissolved under the Qwen tuning work. The plan-113 fix serialises the Qwen forward per-engine (it isn't thread-safe), so `GPU_VRAM_BUDGET>1` gives **no same-engine Qwen parallelism** — the cost … _Wake when:_ cross-engine packing actually thrashes (spill-to-RAM slowdown, `nvidia-smi` near the card ceiling) on real hardware, or a different/smaller GPU changes the headroom math. …

- `app-12` — iOS build + release of the companion app ([#555](https://github.com/dudarenok-maker/AudioBook-Generator/issues/555), [plan 188](features/188-android-companion-app.md)). _Why parked:_ "Android **initially**" — v1 ships Android only; the codebase stays iOS-ready by construction (app-managed TLS trust, dual-platform Flutter plugins, an unsigned iOS CI compile from `app-1`), so this is incremental, not a rewrite. _Codec caveat (5th review):_ iOS `AVPlayer` can't play `.ogg` — for iOS, the server must render MP3/M4A (OGG is Android-only); the app reads the format from the manifest and surfaces it. _Wake when:_ the Android v1 MVP is stable on real devices AND there's listener demand for iOS.

---

## Retired numbering

The old per-bucket `Could #N` / `Should #N` numbering was retired on 2026-05-25 in
favour of the permanent `<prefix>-<n>` IDs above (it renumbered on every ship, so
external references rotted). Any code comment or plan doc still citing a bare
`Could/Should/Must #N` is either (a) a stale pre-2026-05-25 reference — resolve it by
matching the comment's described feature to an item above or to its shipping plan —
or (b) **plan-internal** numbering of the form `plan <NN> Should #M`, which is frozen
and correct. Don't reintroduce bare-number backlog references.
