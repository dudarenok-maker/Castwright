<!--
Draft release notes for the NEXT version (technical register — this IS the
GitHub release body). bump-version.mjs feeds this file verbatim as the
annotated-tag message → release.yml, and now uses it by DEFAULT (no
--notes-file needed). Everything in this HTML comment is invisible in the
rendered release, so it never leaks into the body.

Keep it current for each release:
  1. Update the version marker below.
  2. Rewrite the body (theme paragraph → ## ✨ Headline features with
     ### … (new) subsections → emoji-themed sections → bold-lead bullets with
     (#PR) refs → **Full changelog:** vPREV...vNEW footer). v1.7.0 is the
     canonical example; see CONTRIBUTING.md "Release notes".

The marker is what bump-version checks: if it doesn't match the version being
cut, the bump refuses (so a stale file can't ship as the body). The
user-facing, brand-voice notes live separately in RELEASE_NOTES.md (#/release-notes).

release-notes-next-version: 1.15.0

Cycle opened 2026-07-24 (v1.14.0 shipped 2026-07-23; first PR of the new
cycle reopens this file per CONTRIBUTING.md "Release notes"). Populated
PR-by-PR as the v1.15.0 cycle progresses — do not reconstruct from git
history at cut time.
-->

## 🧱 Internals

- **The `/api/setup/*` surface is now in the API contract** (fe-57, #1883). `openapi.yaml`
  described 91 `/api/` paths and **none** of the setup surface, so the frontend types for all
  8 setup endpoints were hand-written with no mechanical guard — and had already drifted
  (`info.vramTotalMb` is sent by `setup-readiness.ts:99` and was absent from the frontend
  type). Describes all 8 endpoints + 14 schemas, regenerates `src/lib/api-types.ts`, and
  deletes **both** hand-mirrored blocks in `src/lib/api.ts` — the `SetupReadiness` family and
  the `ModelsStatus` family — replacing them with generated aliases under identical names, so
  no consumer import changed.
  **This does not make server↔frontend drift a compile error**, and plan 270 says so
  explicitly: the server does not consume `src/lib/api-types.ts`
  (`workspace/voice-library.ts:9-10`), so describing the contract alone would have *relocated*
  the duplicate rather than removed it. The guarantee is
  `server/src/routes/openapi-setup-parity.test.ts`, which asserts the contract's enums equal
  the server's TypeScript unions — via `satisfies Record<Union, 1>` over type-only imports,
  so a member added to a server union fails `npm run typecheck` inside the test file. (A bare
  array there would have pinned nothing; the first draft did exactly that and was caught at
  review.) Copy count goes three → two.
  **Fixed a live bug found on the way:** `venv-bootstrap.tsx` declared `status: 'installing'`,
  a value the venv endpoint never emits, so its progress card never rendered during a real
  multi-minute bootstrap — and its own tests mocked the fictional status, keeping the suite
  green. That is the only user-visible delta here, and it carries a matching user-facing line in RELEASE_NOTES.md. Plan:
  [`docs/features/270-openapi-setup-surface.md`](https://github.com/dudarenok-maker/Castwright/blob/main/docs/features/270-openapi-setup-surface.md).

---

## 🔧 Setup & prerequisites

- **Castwright now declares a minimum ffmpeg version — 6.0 — and checks it.** (ops-35, #1877)
  The audio pipeline doesn't merely invoke ffmpeg; `server/src/tts/loudnorm.ts` **parses**
  ffmpeg's two-pass loudnorm JSON summary, which makes the version a contract we were relying
  on without ever stating. `castwright.ffmpeg.minimum` in root `package.json` is the single
  source of truth, read by `scripts/preflight-ffmpeg.cjs` (which previously spawned
  `ffmpeg -version` and discarded the output), by `server/src/diagnostics/ffmpeg.ts`, and by
  `pinokio-scripts/lib/ffmpeg-pin.test.js` — never restated anywhere.
  This is a **support** floor, not a capability floor: loudnorm's JSON shape has been stable
  since ffmpeg 3.1, so an evidence-derived floor would sit near 4.x and never fire. 6.0 is
  anchored to Ubuntu 24.04 LTS (6.1.1). **This retires the previously-claimed Ubuntu 22.04**,
  whose archive ffmpeg is 4.4 — a deliberate, user-visible support reduction; snap or a PPA
  satisfies the floor on 22.04.
  Only the preflight hard-fails (it is `server/package.json`'s `pretest`, so it gates
  pre-commit, pre-push and all three `release.yml` legs — every gate channel was measured at
  ≥ 6.1.1 first). Every user-facing surface **warns without blocking**: a new
  `ffmpeg-too-old` `BlockerCause` at `status: 'warn'`, which `setup-readiness.ts:96` already
  counted toward `ready`. The Setup Wizard gains a third card — before this, a below-floor
  ffmpeg rendered "ffmpeg isn't installed yet" to a user who has it installed.
  Pinokio's conda env moves from bare `ffmpeg` to `"ffmpeg>=6"` on **both** `install.js` and
  `update.js`, unblocking #1876, which declined to pin precisely because no validated floor
  existed to pin to. Rollback without reverting: set the floor to `null`.
  Plan: [`docs/features/269-ffmpeg-version-floor.md`](https://github.com/dudarenok-maker/Castwright/blob/main/docs/features/269-ffmpeg-version-floor.md).

---

## 📝 Script review & manuscript

- Detect emotions can now be scoped to the current chapter — the header button runs the emotion + reaction passes on just the chapter you're viewing, with whole-book still available from its ⌄ menu. (fs-35, #592)

---

## 🎙️ Voices & casting

- **fs-38 Wave 1 — book-independent voice library (`#/voices` restructure + designed-voice
  authoring)** (#1800, refs #624). Ships a first-class, book-independent voice-library store ("My
  voices"), restructuring `#/voices` into three sections — **My voices | In use | Catalogue**.
  Adds standalone designed-voice authoring: create a Qwen voice from a persona with a live
  audition, **redesign-with-compare** (A/B old-vs-new, keep or discard), **promote** a
  character's designed voice into the library (new uuid + byte-copy of the `.pt`), and
  **assign** a library voice to any character — reusable across books and series. A new
  `provenance` dimension (`designed`/`cloned`/`imported`) lands now on the schema (cloned/
  imported are inert until Wave 3 of `fs-38`/#624), and the cross-book voice matcher already
  excludes cloned-provenance voices so a person's voice can't be offered back into a stranger's
  book. Local-only; deleting a library voice runs a usage report and full multi-location
  erasure (manifest + `.pt` + cached samples). This wave alone delivers the folded-in `fs-12`.
  Not in Wave 1: clone-from-a-real-sample, consent/attestation, audio ingest, in-app recording,
  Catalogue rebuild (later waves). Plan:
  `docs/superpowers/plans/2026-07-04-fs38-wave1-voice-library-store.md`.
- **fs-38 Wave 3a — voice-clone ingest, consent & recorder** (Refs #624). Voice cloning
  groundwork: sample ingest, consent, and recorder (behind the voice-library flag). Real ffmpeg
  decode (upload or a new `VoiceRecorder`) → a pure quality gate (fatal <4s/silence, warn
  short/clipping) → 60s cap → a Node-written `master.wav` → Whisper transcript, via `POST
  /api/voice-library/clone-sample` (ephemeral candidate — no entry persisted yet). A write-time
  consent-structure guard on `writeEntry()` plus `POST /:uuid/revoke` (revocation orthogonal to
  the guard); the existing sample-audition route now 403s a revoked/consent-absent cloned voice.
  My voices gains a 'Cloned' badge + Revoke action; a capture/consent panel exists as a phase-1
  wizard building block. **Behind-the-flag, no reachable production caller for the consent
  guard/revoke route/cloned-section UI until 3b1** ships the first real cloned entry — disclosed
  scope, not a gap (spec §1.1). Plan: `docs/features/267-fs38-wave3-voice-clone.md`. Spec:
  `docs/superpowers/specs/2026-07-25-fs38-wave3-clone-pipeline-design.md`.
- **First voice clone on the Qwen engine.** Capture or upload a sample, attest consent, and
  Castwright distils a reusable cloned voice — auditioned, ECAPA fidelity-checked, and castable
  like a designed one. A cloned voice is never silently substituted: if Qwen is unavailable the
  chapter fails loud instead. (Refs #624)
- **Voice design and audition endpoints stop flattening the sidecar's status to 502.** The
  library `design` / `redesign` / `sample` routes and the character `design-voice` route now map
  the sidecar's own **5xx** through, so a **503** ("no GPU capacity — free VRAM and retry")
  survives as a 503 instead of reading as a broken gateway, and `NoCapacityError` — which carries
  no status at all — maps to 503. A sidecar **4xx** deliberately stays 502: it describes our
  request to the sidecar, not the caller's request to us, and forwarding it would collide with
  the 409 these routes already use for "design run in progress" / `gpu_busy`. The `0` the
  unreachable/cancelled paths carry also clamps to 502. (#1801)
- **The `voices.library.enabled` feature flag is removed outright** (#1833, subsuming #1802). The
  knob hid the **My voices** tab and 404'd the whole `/api/voice-library` router, but it never
  gated the library's other entry points: the profile drawer's assign / "Save to my voices"
  actions and the In-use card's "View in My voices" link kept rendering and calling routes that
  had just been turned off. "Off" was therefore not a supported state but a half-broken one —
  designed voices depend on the library surface existing — and the two bugs filed against it
  (#1802's blank pane, #1833's dead button) were instances of that class rather than independent
  defects. Deleted: the registry knob and its now-empty `voices-library` settings group,
  `requireVoiceLibraryEnabled` and its mount at `app.ts:196`, the `myVoicesLibraryEnabled` gate
  and the derived-`activeSection` masking added for #1802, `MyVoicesSection`'s `enabled` prop,
  and the boot-time `fetchConfig()` dispatch in `src/store/index.ts` that existed solely to
  hydrate the gate (`advanced.tsx` still dispatches its own on mount; it was the only other
  consumer). A stale `voices.library.enabled: false` left in a user's persisted config overrides
  is inert — pinned by a regression test in `voices.restructure.test.tsx`.
- **fs-38 Wave 3b2 — cloned-voice resolver + lifecycle** (Refs #624). Closes the resolver/
  lifecycle half of the never-substitute invariant 3b1's single `applyQwenFallback` exemption
  only partially covered. A new `clone-voice-resolver.ts` (pure Healthy/Repairable/Broken
  classifier + two async orchestrators) is wired as a per-chapter pre-pass in `synthesiseChapter`,
  running BEFORE any synth call: it transparently re-derives a Repairable cloned voice from its
  retained `master.wav`, and hard-fails the whole chapter via `UnresolvableClonedVoiceError`
  (never a silent reroute) on a Broken one — revoked, missing-master, engine-unavailable,
  wrong-engine, or a persisted derive failure. The readiness gate is intersected to exactly this
  chapter's in-chapter characters, including both the title-beat and orphaned-`characterId`
  narrator paths. Transient re-derive failures (sidecar unreachable, any 5xx) collect Broken
  without persisting `engines.qwen.status:'failed'` — only a genuine 4xx does, so a hiccup can't
  brick a voice. `purgeCloneArtifacts(uuid)` gives revoke and delete one shared, total erasure
  routine (base `.pt`, `__1.7b.pt`, manifest, both `-preview` variants, both `__master.wav`
  variants, sample cache) — closing gaps where revoke erased nothing and delete missed the 1.7B
  cache. A user-directed follow-up widened revoke further: it now also erases the entry-dir
  recording itself (`{ deleteMasterClip: true }`, clearing the entry's `master` field), gated
  behind a two-step confirm dialog that spells out the consequence up front — "revoke" now
  really does mean the person's original recording is gone, not just retained-but-inert.
  Sidecar `.pt` writes for `clone_voice`/`design_voice` are now atomic (temp file +
  `os.replace`, absorbing #1804). A distinct `wrong-engine` `BrokenClonedVoice` reason (+ a new
  `cloned-voice-broken` `FailureCode` with a toast + help link) diagnoses a cloned voice assigned
  to a character/book that simply doesn't route to Qwen, separately from Qwen being unavailable;
  an advisory `POST /:voiceUuid/assign` 409 guard (optional `modelKey` body field) catches the
  same case at assign time. §2.3 (designed-voice clip-persist + orphan self-heal from a retained
  `qwen-<uuid>__master.wav`, scoped to a missing `.pt` only and never throwing) shipped alongside
  as the wave's optional tail. Plan: `docs/features/268-fs38-wave3b2-resolver.md`. Spec:
  `docs/superpowers/specs/2026-07-25-fs38-wave3-clone-pipeline-design.md` §5.
- **Voice previews use the character's engine and the book's quality tier** — the
  audition request resolves its `modelKey` through the single
  `modelKeyForEngineChoice` mapper instead of the lossy `sampleModelKeyForEngine`
  copy, which returned the book's default key for every non-Qwen engine (so a
  Kokoro-overridden character in a Coqui book previewed in Coqui) and pinned every
  Qwen preview to 0.6B. The tier resolves from the session key, so the play and
  design paths keep landing on one shared cache file. Thirteen audition/design call
  sites now go through that one mapper; the three `TtsEngine` declarations and the
  four engine→modelKey mappers collapse to one per side of the wire. The My-voices
  card, the design/redesign preview, the clone wizard and both sides of the A/B
  compare all follow the session tier, so one voice cannot sound different in two
  places. A designed voice's cached audition is now genuinely reused by its first
  Play — the design and play paths previously hashed different filenames because
  only one folded in the persona token, so every first Play silently re-synthesised.
  The Start-generation tier picker disables 1.7B when its separately-downloaded
  weights are absent. GPU admission now frees an idle Qwen base tier before
  refusing a preview on capacity, and when capacity is genuinely exhausted the
  error names the resident model that is holding it and the control that frees it.
  (#1812, #1839, #1841, #1842)
- **fs-38 — clone-wizard transcript edits now reach the derive** (#1840, closes #1836, refs #624). The
  wizard's transcript textarea was editable but write-only: `onReady` forwarded just
  `{ candidateId, consent }` and `CloneVoiceRequest` had no transcript field, so `POST /clone`
  always distilled against `candidate.master.transcript` — the raw Whisper output. Adds an
  optional `transcript` to `CloneVoiceRequest` (OpenAPI-first), forwards the edited value from
  the capture panel through the wizard, and prefers it as the derive's `ref_text` when non-blank.
  The corrected text is persisted as **`master.transcript`** as well as `sampleTranscript` —
  load-bearing, because the Wave 3b2 repair path re-derives from `entry.master.transcript`
  (`readMasterPcmDefault`), so storing it only in `sampleTranscript` would let a later repair
  silently revert to the Whisper text. `master.transcriptSource` now records `'user'` when the
  text differs from the stored Whisper transcript (previously the enum's `'user'` arm was
  unreachable), decided server-side rather than from a client flag. Blank/whitespace falls back
  to the Whisper text, since Whisper can legitimately return an empty transcript for a non-speech
  clip. As the first client-controlled value to reach the derive's `refText` — which travels to
  the sidecar as a base64 `X-Ref-Text` header — it is capped at 2000 chars in both the contract
  and the route (pinned against drift by a test that derives from the exported constant), sized so
  the header stays bounded in BYTES for multi-byte ja/zh/ru text rather than only for ASCII. Over-
  length is a 400, never a truncation: the textarea deliberately carries no `maxLength`, because a
  browser-side cap would silently drop the tail of a correction and persist the remainder as
  `transcriptSource: 'user'` — the same silent-discard shape this fixes. The wizard blocks Continue
  with a visible reason instead, while the field is still editable.
  `mockCloneVoice` mirrors the same semantics so mock/e2e mode stops reproducing the bug. Adds
  Invariant 12 to `docs/features/267-fs38-wave3-voice-clone.md`. Closes the run sheet's KL-k
  finding.
- **`#/voices`' language filter can no longer strand the rollup** (#1834). `languageFilter` was
  raw local state, but the chip row that clears it renders only while the library still carries
  the codes it offers — and it lives inside the rollup's non-empty branch. So a mid-session
  library change that drops the filtered language left the filter matching nothing, collapsing
  the view to the "No voices yet" empty state (wrong copy, too: "Finish setting up a book") with
  the chips gone — a filter still applied and no control left to clear it. The reachable trigger
  is the last voice carrying that language losing it: its qwen override cleared from the profile
  drawer in this same view, the voice deleted, or its design manifest failing to resolve a
  language on a later read — surfaced by the next `voicesActions.hydrate`, which refires on
  `[bookId, stageKind, ttsEngine, genProgress]` while the view stays mounted. Explicitly NOT an
  engine switch or a book switch, both of which the first draft of this entry claimed: the server
  reads `languageCode` from the design manifest independently of the `engine` query param, and
  the voices response walks every book under `BOOKS_ROOT` with `currentBookId` only setting
  `source` — neither can remove a code from `languages` (`server/src/routes/voices.ts:257-260`,
  `:402-406`). The effective filter is now derived during render
  (`languages.includes(languageFilter) ? languageFilter : null`) so the empty rollup is never
  painted; `setLanguageFilter` stays the sole state writer. Same shape and same treatment as
  `activeSection` for #1802 (that derivation is gone with the flag in #1833; this one is not
  gate-dependent). Three regression cases in `voices.test.tsx`: the chip row unmounting entirely,
  the row surviving with the selected code dropped (the "All" chip reads pressed again), and the
  same stranding on the **Qwen** leg — `filteredQwenLibrary`, which is where the whole library
  sits under the default engine (`resolveVoiceAssignment` stamps `provider` from the active
  engine, not per voice) and therefore the only leg a real user can be stranded on, since
  `languageCode` is only ever set on a designed Qwen voice. The independent review proved that
  leg had zero coverage — reverting just its memo left all 69 tests green.
- **`#/voices` no longer mislabels a filtered-out rollup as an empty library, and the Variants
  filter can't blank it outright** (#1866, #1869). Two halves of the structural cause #1834's
  review left standing. **(a)** The "No voices yet" empty state was gated only on
  `variantFilter === 'all'`, so any *other* narrowing that matched nothing collapsed the rollup
  into "Finish setting up a book — once you confirm its cast…" on a fully populated library —
  and took the language chip row down with it, since that row renders inside the ternary's
  non-empty branch. Confirmed repro: one `source: 'library'` Russian voice + one
  `source: 'current'` English voice, pick **Russian**, switch to **This book**. `rollupIsEmpty`
  / `rollupIsNarrowed` now read all three narrowings (variant, language, tab) the same way:
  "No voices yet" claims an empty library only when none of them is on and the library actually
  has voices in it (see the `library.length > 0` gate below), and everything else
  routes to the existing "No voices match this filter" panel, which now names the miss
  ("No Russian voices in this tab — try another language or tab"). Because that panel renders
  inside the non-empty branch, the tab strip and both facet rows stay on screen alongside it.
  **(b)** The Variants facet had #1834's defect in its worst form: its chip row renders only
  while `qwenLibrary` is non-empty, and a non-`all` filter sets `showFamilies = false`, so a
  stale filter blanked *every* tab with no control left to clear it — and `qwenLibrary` empties
  wholesale on an engine switch away from Qwen, since `resolveVoiceAssignment` stamps
  `provider` from the active engine rather than per voice. `activeVariantFilter` gets the same
  derived-during-render treatment `activeLanguageFilter` got; `setVariantFilter` stays the sole
  state writer. This one is load-bearing for (a): without it a stale `variantFilter` would keep
  `rollupIsNarrowed` true forever and pin the new panel on a populated library. `rollupIsNarrowed`
  is additionally gated on `library.length > 0` so the onboarding case is untouched — on an
  empty library every tab is empty, so "try another tab" would be useless advice and a fresh
  install clicking "This book (0)" still gets "Finish setting up a book"; the review's truth-table
  pass proved that clause changes the outcome in exactly that one state and no other. Five cases
  in `voices.test.tsx`, each placebo-verified against the specific line it locks — including a
  control asserting a genuinely empty library still says "No voices yet". The facet's label map
  moves to module scope now that the panel names the language too, as `FACET_LANGUAGE_LABELS`:
  `library-slice.ts` already exports a `LANGUAGE_LABELS` and it is deliberately different
  (endonyms — 'Русский', 'Deutsch' — for the book-library pills, against this one's exonyms),
  so the two must not be confusable at an import site.

- **fs-60 follow-up — profile-drawer engine-seed clamp + one shared fallback-engine derivation**
  (#1534). Two review Minors from the fs-60 whole-branch pass, both now closed. **(1)** The profile
  drawer seeded `engineChoice` straight from `character.ttsEngine`. Since fs-60 stopped hard-locking
  every non-English book to Qwen, a character carrying a stale on-disk `ttsEngine` (`'kokoro'`,
  `'gemini'`) into a ru/es/fr/de book seeded the controlled `<select>` to a value with no matching
  option — so the picker *displayed* "Default (…)" while Save wrote the stale engine the user never
  chose. **The reaching path is `cast-link-prior.ts:203`** (manual "link to prior character",
  `mergedSource.ttsEngine = source.ttsEngine ?? …`, no language check at either end) — **not**
  automatic series reuse, which vetoes cross-language candidates outright
  (`series-reuse-link.ts:309`, fs-61) and leaves the character's own `ttsEngine` empty anyway. The
  first draft of this entry named reuse; a review pass caught that the server refuses to create
  that state. The seed now clamps to `pickerEngines` (the offered `kokoro`/`qwen`/`coqui`
  set ∩ `eligibleTtsEngines`), **not** to raw `eligibleTtsEngines` as originally proposed: `gemini`
  is language-eligible for a Russian book yet has no option row, so an eligibility-only clamp left
  the same desync. Server-authoritative force-Qwen already corrected the engine at render, so this
  was never wrong audio. Locked by tests asserting **`onSave`**, not `select.value` — with no
  matching option React DOM's `updateOptions` selects the first option — in a real browser too, not
  just jsdom — so the DOM reads `'default'` either way and a value-only assertion passes against the
  unfixed code. The tests now assert both halves (displayed value AND what Save emits), since the
  invariant is that they agree. A second review finding added a **reconcile effect**: the seed alone
  left the bug reachable on the `?profile=<id>` deep-link cold boot, where the drawer mounts before
  `state.library.books` lands, eligibility falls back to `ALL_TTS_ENGINES`, a stale `'kokoro'` passes
  the clamp, and nothing re-derives the choice once the option row disappears.
  **(2)** `selectHasNoFallbackEngine`, `selectFallbackEngineName` and `voiceReadinessGateMessage`
  each re-derived the book's eligibility. In the fs-70 (#1303) "non-English but Kokoro-eligible, not
  Coqui-eligible" state they disagreed: soft-gate + a button naming Kokoro + a message naming Coqui
  + a server `applyQwenFallback` that throws `MissingDesignedVoiceError` — a soft-gate→hard-fail
  mismatch, not a cosmetic one. All three now read one `getBookFallbackEligibility(state, bookId)`
  helper whose `fallbackEngine` mirrors `applyQwenFallback` exactly; a table-driven test asserts the
  message always names the same engine as the button across all four eligibility shapes. Pure
  refactor for every state reachable today. Also hoists the 5-engine default array duplicated across
  `profile-drawer.tsx` / `cast.tsx` / `voice-readiness-selectors.ts` into one `ALL_TTS_ENGINES`
  (`src/lib/tts-models.ts`). Plan 249 gains invariants 7 and 8. The sibling `cast.tsx` banner
  assumption (`!qwenOnly ⇒ Coqui-eligible`) is prop-driven, does not read the new helper, and stays
  owed — folded into fs-70.
- **A failed VRAM evict no longer kills a mixed Qwen+Coqui chapter** (#1893). fs-60 partitions a
  chapter that mixes Qwen and Coqui into two serial phases with a sidecar `/unload` between them,
  so the two never co-reside on an 8 GB card. That evict call had no failure isolation: it throws
  on a non-ok `/unload`, `fetch` rejects on a dead socket, and no `try`/`catch` sat anywhere
  between it and `synthesiseChapter`'s head — so a transient sidecar hiccup aborted a chapter that
  would otherwise have rendered, at up to three call sites per chapter (initial body dispatch plus
  the segment-QA and ASR re-record rounds, which share the same wrapper). The evict is now
  best-effort: a failure logs a named warning and the Coqui phase proceeds, mirroring
  `clone-voice-resolver.ts`'s self-heal policy — an abort still propagates, so a paused or
  cancelled run stops here as before. The call is also bounded by the chapter's existing
  `callTimeoutMs` and now forwards the abort signal; previously it could queue behind another
  book's in-flight synth on the sidecar's `_synth_lock` and stall forever, uncancellable. An abort
  is rethrown *as* an `AbortError` rather than verbatim, so a pause that raced a socket-death
  rejection can't read as a chapter failure at `routes/generation.ts`'s pause detector (the trap
  `clone-voice-resolver.ts`'s `abortRejection` already exists to avoid). Failing soft is usually
  cheap — the sidecar's `/unload` is idempotent and returns 200 even when nothing was resident, so
  a failure normally means an unhealthy sidecar, which the Coqui phase then surfaces itself — but
  not always: a wrong/proxied `SIDECAR_URL` can 5xx `/unload` while the synth path is healthy, and
  then Coqui really does load onto a resident Qwen. That residue is deliberately accepted, recorded
  as plan 249's accepted limitation #4 (it weakens that plan's invariant #4 from a guarantee to a
  success-path property) and owed on-box as register row A19. Five regression tests in
  `server/src/tts/synthesise-chapter-coqui-fallback.test.ts`; the sibling residency asymmetry
  (nothing ever evicts Coqui after the last Coqui chapter) stays open as #1894.

---

## 🎧 Listening & revising

- **fs-10 — chapter-title segment on the Listen timeline** (#412). `ChapterAudio.segments[]`
  gains an optional `kind: 'title'` discriminator and the chapter-audio route stops filtering the
  synthetic title beat out of both `/audio` and `/audio/previous`. The mini-player scrubber paints
  it as a non-interactive labelled band; the Generation view's "Narrative order" strip fills it
  neutrally rather than in the narrator's colour. **Also fixes a latent off-by-one:** because the
  published array was short one leading row, `resolveSegmentForSec`'s index no longer matched the
  on-disk index the splice route addresses, so Listen-view "Fix this line" targeted the line before
  the marked one.

- **Series-memory's hardcoded-dark surfaces no longer borrow the theme's accent** (#1832). The
  three `src/components/series-memory/` surfaces pin a `#1b1714` background that never follows the
  app theme, but their accent resolved through the theme-flipping `--magenta` — `#A43C6C` on light,
  **2.918:1** on that surface, failing WCAG AA as text. New pinned `--color-magenta-on-dark` token
  (the accent counterpart to the existing pinned `--color-cream`), applied to the share card's
  label/glyph/separators/footer, the reveal's carried-badge and section label, and both gradient
  CTAs. The reveal's per-book dots are included because they encode which books a character appears
  in — meaningful graphics under WCAG 1.4.11 (3:1), also missed. Pinning their gradient forced the
  CTA ink off flipping `text-ink` (near-white on light pink under dark) onto the already-pinned
  `text-peach-ink`, 5.3–5.8:1 across the gradient. **Matters more than a normal contrast bug
  because the card is exported as a PNG** — a light-theme user shipped the failing version rather
  than merely seeing it. Regression cases live in Playwright, not vitest (jsdom doesn't resolve
  these tokens) and assert *identity across themes* rather than a literal, since the defect was a
  colour that moved when its surface didn't. Trade-off: the card no longer responds to
  `[data-contrast='high']` — ~11:1 → a fixed 7.6:1 for high-contrast dark, but it also stops
  high-contrast light resolving to a near-invisible `#7A1B49`.

---

## 📱 Companion app

- **Demo library covers for _Saltgrave_ and _The Tidewatcher's Oath_ were swapped** (#1792). The
  committed `apps/android/assets/demo-covers/hollow-tide-2.png` (mapped to _The Tidewatcher's Oath_
  in `demo_data.dart`) held the _Saltgrave_ artwork and vice versa — the filenames were correct, so
  the filename-mapping test could not see it. Swapped both the committed downscaled assets and the
  git-ignored `brand/book-covers/` sources (so regeneration stays correct), and added a SHA-256
  regression guard in `scripts/tests/build-demo-covers.test.mjs` that pins the corrected art.

---

## 📖 Help

- **Mirror the marketing site's local-first privacy FAQ into the app Help view** (#1793). Adds two
  Help topics — `is-my-data-private` (files) and `does-it-work-offline` (analysis) — to
  `src/data/help-topics.ts`, matching the website's corrected copy: analysis is local by default and
  the cloud fallback is opt-out (on by default, switchable off), never framed as opt-in-only or
  "never touches the cloud". Guarded by `src/data/help-topics.test.ts`; item-count assertions bumped
  43 → 45.

---

## 🔒 Security & dependencies

- **react-router 7 → 8, `react-router-dom` dropped, and the supported Node floor raised to 22.22**
  (fe-56, #1859). One PR because the upgrade is not adoptable without the floor: react-router 8.3.0
  declares `engines.node >=22.22.0`.
  - **Deployer-visible:** the minimum supported Node moves from **20.19 → 22.22**. Node 20 reached EOL
    in April 2026 and 22 is the active LTS, so the floor was overdue independently of the router.
    **`engines` is advisory, not enforced** — npm emits `EBADENGINE` and exits 0 without
    `engine-strict`, and this repo sets no `.npmrc`. The floor documents intent and fails *late and
    obscurely* on an older Node, it does not block the install. (`164-deps-ci-hygiene.md` already said
    this; an earlier draft of this entry claimed npm would refuse, which is wrong.)
  - **Pinokio no longer depends on whatever Node its own kernel bundles.** `pinokio-scripts/install.js`
    step 1 now conda-installs a pinned `nodejs=24` alongside `ffmpeg mkcert` (matching `.nvmrc` and
    every CI workflow), replacing the unimplemented TODO that file carried since it was written.
    `pinokio-scripts/update.js` re-asserts the same pin so an install made before this change converges
    onto it instead of staying on the bundled Node forever. **It converges one Update late, and that is
    not fixable here:** Pinokio loads `update.js` from the *currently checked-out* release and iterates
    the `run[]` it loaded, while `resolve-release.js` `git checkout`s the new tag mid-run — so a user
    updating FROM a pre-pin release executes their old `update.js` (no pin step) and does that update's
    `npm ci`/build on the bundled Node. The pin applies from their next Update on; fresh installs get it
    immediately. An earlier draft of this entry said "picks it up on its next Update", which was wrong.
    `pinokio-scripts/lib/node-pin.test.js` pins both scripts' pin, asserts each conda step precedes that
    script's first `node`/`npm` step, and checks the pin satisfies `package.json`'s `engines.node` floor
    by **parsing both** rather than hardcoding — so a future floor raise without a matching pin bump
    fails that test. `verify-cache.mjs` gains `package.json` as a `test:pinokio` input, since without it
    a floor-only change prints `[cached]` and the guard never runs locally. What's still owed on-box:
    that the conda Node actually shadows Pinokio's bundled one on PATH, that the solve succeeds against
    the existing env, and that the one-Update lag behaves as described — tracked in
    `docs/testing/onbox-acceptance-register.md` (E1); plan 218's invariant 2 and open-verification
    item 2 are both updated to match. (#1878, closes #1876)
  - `react-router-dom` is now a **dead package**: v8 folded the DOM APIs back into `react-router` and
    left `react-router-dom` frozen at 7.18.1 permanently. 24 files re-pointed.
  - **The trap, recorded because it is invisible to `tsc`:** v8 did not simply rename the package.
    `RouterProvider` (and `HydratedRouter`) live at the DOM-specific subpath **`react-router/dom`**,
    whose `RouterProvider` wraps the base one with `flushSync: ReactDOM.flushSync`. Both modules export
    a component of that name, and `dom-router-provider.d.ts` declares
    `Omit<RouterProviderProps, "flushSync">`, so `<RouterProvider router={router}/>` **compiles against
    either**. Issue #1859 instructed rewriting every `react-router-dom` import to `react-router`, which
    would have silently taken the wrong one past `npm run typecheck` — the app has one
    `RouterProvider` mount site. New `src/main.test.tsx` mocks both modules with distinct sentinels and
    pins the DOM export; mutation-verified (reverting the import fails it).
    **Calibration, after review:** the wrong import would be behaviourally *identical today*, not
    broken. `flushSync` is consumed only behind `if (reactDomFlushSyncImpl && flushSync)`, and the app
    uses no `viewTransition` and no `flushSync` anywhere — the miss degrades to a dev-only `warnOnce`.
    The guard is worth keeping because it protects future view-transition adoption, but an earlier
    draft of this entry called it a runtime break, which overstated it.
  - `react`/`react-dom` tightened `^19.0.0` → `^19.2.7`. The old range could resolve a React that v8
    rejects, so the range was itself the defect. Vite was already 8.0.16, above v8's `>=7` floor.
  - The floor is advertised in **five places that are not generated from each other** and must move
    together: `package.json` `engines`, `INSTALL.md`, the hand-maintained wiki mirror
    `docs/wiki/Installing-Castwright.md` (synced by `scripts/sync-wiki.mjs`, *not* derived from
    INSTALL.md — it drifts silently), `copilot-setup-steps.yml`, which was still pinned to Node 20
    while every other workflow had moved to 24, and `.github/copilot-instructions.md` — the fifth,
    caught by review after an earlier draft of this entry claimed there were four. That the count was
    itself wrong is the argument for the point: nothing mechanical keeps these in sync.
  - `src/lib/router.ts` has a **zero-line diff** — the plan-01 `RouterStore` adapter seam held across a
    router major. The `#/…` grammar is byte-identical: 30 unmodified `router.test.ts` tests (39 assertions), 292
    unmodified e2e specs over ~50 distinct hash shapes, 19 visual snapshots with no drift and nothing
    blessed. Every v8 SSR/framework-mode breaking change was assessed inapplicable — this app is pure
    client-side `createHashRouter` with no loaders, actions, or `meta` functions. Plan
    [269](features/archive/269-react-router-v8-node-floor.md).

- **Sidecar engine deps: kokoro-onnx 0.5.0, a real ONNX Runtime pin, and FastAPI 0.140 via `lifespan`** (#1846).
  Clears the actionable half of the `side-17` umbrella (#893), which an audit found was carrying three
  stale rationales.
  - `kokoro-onnx` `>=0.4.0,<0.5.0` → `>=0.5.0,<0.6.0` across all three overlays. The entire upstream
    delta is `kokoro_onnx/log.py` dropping `colorlog` for stdlib `logging`; `Kokoro.create()`'s signature
    and the private `.sess` attribute are unchanged. Two new contract tests in `test_kokoro.py` run
    against the REAL installed package (the rest of that file stubs `kokoro_onnx` via `sys.modules`) —
    they exist because the indexed-device pin rebuilds `.sess` in a warn-only `try/except`, so an
    upstream rename would silently unpin the device rather than raise.
  - `onnxruntime-gpu` gets an explicit `>=1.27,<1.28` constraint in `scripts/install-ort.mjs`. There was
    no pin before — the swap ran `pip install --force-reinstall --no-deps onnxruntime-gpu` unversioned,
    so the runtime executing Kokoro was whatever was latest on the user's install date. The constraint
    lives in the installer, never the overlays (macOS reads those and has no wheel).
    **Existing installs on 1.28.x will step back to 1.27.x on first upgrade** — both upgrade paths
    (`bootstrap-venv.mjs`, `apply.ts`) re-run the swap.
  - All 12 `@app.on_event` handlers → one `lifespan` context manager (`main.py`), then `fastapi`
    `0.115` → `0.140` and `uvicorn` `0.30` → `0.51` (starlette rides transitively to 1.3.1).
    Startup order preserved exactly; shutdown stays in registration order (FastAPI runs it forwards —
    reversing would be a behaviour change). Teardown is in a `finally`, not after a bare `yield`,
    because `_DefaultLifespan.__aexit__` discards `exc_info` and runs shutdown unconditionally.
    `test_lifespan_order.py` pins both sequences against the actually-wired `lifespan_context`.
  - **Correction to the rationale**: the migration was NOT a hard prerequisite, contrary to what the
    working notes claimed. FastAPI 0.140 re-implements `_DefaultLifespan`, `APIRouter._startup()`,
    `._shutdown()`, `.add_event_handler()` and `.on_event()` locally to preserve backward compatibility
    after Starlette removed them. `on_event` is deprecated on a compat shim carrying its own removal
    TODO — that is the real reason to move, and the comments now say so.
  - Follow-ups folded in: `httpx2` adopted in `requirements-dev.txt` (#1843) so Starlette 1.3.1's
    `testclient` stops warning about the deprecated `httpx` fallback (`httpx` stays — gradio and
    safehttpx still import it); and `install-ort.mjs` now reports the package it actually swapped in
    (#1844) instead of hardcoding `onnxruntime-directml`, which was wrong on every profile that
    reaches the swap.
  - Still upstream-blocked, with corrected reasons in #893: `torch` 2.12/2.13 is blocked because
    **torchaudio's last release is 2.11.0**, NOT by the cu130 driver bump originally recorded;
    `transformers` 5.x and `huggingface_hub` 1.x are both frozen by `qwen-tts==0.1.1`'s exact
    `transformers==4.57.3` pin (#1228).

- **Dependabot sweep: 9 alerts cleared, 1 dismissed as unreachable, 3 recorded as upstream-blocked** (#1863).
  Nine bumps, all of which npm resolves within existing ranges except where noted:
  - Frontend (dev-only, build tooling): `postcss` 8.5.15 → 8.5.23 (GHSA-r28c-9q8g-f849, source-map path
    traversal), `js-yaml` 4.2.0 → 4.3.0 (GHSA-52cp-r559-cp3m, quadratic merge-key chains),
    `brace-expansion` on all three of its major lines — 1.1.15 → 1.1.16, 2.1.1 → 2.1.2, 5.0.6 → 5.0.8
    (GHSA-3jxr-9vmj-r5cp). `nanoid` 3.3.12 → 3.3.16 rides along as postcss's own dependency.
  - `shell-quote` 1.8.4 → 1.9.0 (GHSA-395f-4hp3-45gv) is reached by bumping **`concurrently`
    10.0.3 → 10.0.4**, not the leaf: concurrently pins shell-quote exactly, so `npm update shell-quote`
    is a no-op. 10.0.4 carries 1.9.0 itself.
  - Server: `postcss` 8.5.15 → 8.5.23 (dev), `protobufjs` 7.6.4 → 7.6.5 via `@google/genai`'s `^7.5.4`
    (GHSA-j3f2-48v5-ccww, infinite loop parsing `.proto` options).
  - **`adm-zip` 0.5.17 → 0.6.0 needs an `overrides` entry** in `server/package.json` (GHSA-xcpc-8h2w-3j85,
    crafted ZIP triggers a 4 GB allocation). It arrives via `epub2@3.0.2` — already the latest release, so
    no upstream fix is coming — which requires `^0.5.10`, putting 0.6.0 out of range. This is the one
    runtime-behaviour risk in the sweep: a 0.x minor is breaking by semver, and adm-zip is what parses
    every uploaded EPUB. Verified rather than assumed — `zipfile` (epub2's optional native preference)
    is not installed, so the adm-zip fallback in `epub2/zipfile.js` **is** the live path, and epub2's
    exact call sequence (`new AdmZip(file)` → `getEntries().entryName` → `getEntry` → `readFileAsync`)
    was exercised against a real fixture EPUB on 0.6.0 alongside the 27 `src/parsers/epub.test.ts` cases.
  - **Dismissed, not fixed:** `react-router` (GHSA-qwww-vcr4-c8h2) as `not_used`. GitHub-rated **high**
    (CVSS v4 7.1) but reachable only in RSC/framework mode; we drive a client-side `createHashRouter`,
    so the vulnerable path does not exist here. Reachability is the whole justification — an earlier
    draft of this note cited "CVSS 0.0", which was the advisory's *unscored v3 placeholder* (null
    vector), not a real low rating. The nominal fix is
    8.3.0, but `react-router-dom` has no v8 — it's frozen at 7.18.1 — so it means rewriting 24 files'
    imports **and** raising the product's Node floor from `>=20.19.0` to `>=22.22.0`. Tracked as
    `fe-56` (#1859) on currency grounds rather than as a security fix.
  - **Still upstream-blocked:** the three `torch` alerts (GHSA-rrmf-rvhw-rf47, low/5.3, `torch.jit.script`
    memory corruption; patched in 2.13.0). Recorded on #893 with measured evidence: the `cu128` index we
    install from tops out at torch 2.11.0 while 2.12+ ships only on `cu130`, and — the harder blocker —
    torchaudio's last release is 2.11.0, with Qwen importing `torchaudio.compliance.kaldi` at runtime.
  - **`npm audit` is deliberately still not clean, and that is not an oversight.** A *second*
    brace-expansion advisory (GHSA-mh99-v99m-4gvg, high — unbounded expansion → OOM) expresses its
    affected range as a single `<= 5.0.7` spanning every major line, first patched in **5.0.8**. The
    5.x copy here is 5.0.8 and clears it; the 1.1.16 and 2.1.2 copies cannot, because upstream never
    backported a 1.x or 2.x fix. It is not a Dependabot alert, so the 9-cleared tally above is exact
    against its own source of truth — but a bare `npm run audit` at root will report high findings, and
    the next person to run one should know why rather than assume the sweep missed something. No CI leg
    runs `npm audit`, so nothing goes red on it.
  - The adm-zip override is written `>=0.6.0`, **not** `^0.6.0`: adm-zip has only ever published `0.x`
    releases, and for a `0.x` package a caret caps at `<0.7.0` — which would silently hold the tree back
    the day the next fix lands as 0.7.0, with `npm update` reporting nothing to do.
    `server/src/parsers/adm-zip-pin.test.ts` guards the block, since deleting it reinstalls a vulnerable
    0.5.x with no error (epub2's declared `^0.5.10` is satisfied) and the 27 existing parser cases return
    byte-identical results on both versions, so they cannot detect the regression.

## 🧪 Test gates

- **`vitest --changed` no longer under-selects to zero from an agent worktree** (ops-33, #1868).
  picomatch's globstar refuses to cross a dot-prefixed path segment unless `{ dot: true }` is passed,
  and vitest passes no options when it builds its `forceRerunTriggers` matchers. Agent worktrees live
  under `.claude/worktrees/…`, so from one, every **glob** trigger matched nothing and
  `npx vitest run --changed <base>` selected zero tests — reporting `0 tests found, exit 0`, which
  reads as success. (Vitest also appends resolved `setupFiles` as absolute paths, which carry no
  wildcard and were never affected.) Measured in a single dotted checkout on an identical
  `package.json`-only diff, swapping only the configs: **frontend 1 → 323 test files, server 0 → 446,
  slow tier 0 → 10.** All 10 triggers across `vitest.config.ts`, `server/vitest.config.ts` and
  `server/vitest.config.slow.ts` now carry an explicit dot-segment alternative, and
  `server/vitest.config.ts` gained a trigger for `vitest.config.slow.ts` — the
  `{vitest,vite}.config.ts` brace never matched it, so a slow-config-only diff selected zero tests
  from the suite that holds its own guard.
  - The dot tolerance is exactly **one** segment deep; a checkout nested under a second dotted parent
    still misses. Known bound, and a loud one — the trigger tests' `this checkout` case goes red there
    rather than under-selecting silently.
  - **CI was never affected** — GitHub runners check out to `/home/runner/work/Castwright/Castwright`,
    which has no dot segment, and `verify.yml` holds the repo's only three `--changed` invocations. The
    cost landed entirely on local verification, which is where essentially all non-trivial work in this
    repo happens.
  - This is why the regression tests assert a **synthetic dotted root** rather than only the real
    checkout path: CI always runs from a clean path, so a regression that dropped the dot-tolerant half
    would pass CI unnoticed and break only on developer machines — exactly how #1868 survived. It cost
    real time twice before being fixed: once masquerading as the bug under investigation in #1848, and
    again in #1873, whose own trigger tests hit it and had to route around it with a synthetic root.

- **`golden-audio`: the assembly tier now compares its output against a recorded, ffmpeg-stamped
  baseline across five layers (plus a dedicated linear-loudnorm-arm baseline) instead of a 20-LU
  tolerance band; `--bless` is now suite-scoped** (ops-36, #PR). Bare `--bless` re-records both
  suites' baselines; `--assembly-only --bless` / `--sidecar-only --bless` record only their own.
  **Fixed a live bug found on the way:** the chapter loudness sidecar (`<slug>.lufs.json`) now
  persists a real `ebur128` measurement of the finished audio file instead of loudnorm's
  self-reported `output_i`/`output_lra`/`output_tp` — `output_tp` in particular is the ceiling
  loudnorm was asked to hit, not a measurement, and could read below the true sample peak. On the
  golden fixture, `lra` moved `0.5 → 1.7` and `tp` moved off the requested `-1.5`; `i` is
  effectively unchanged (`-16.3 → -16.2` after the badge's `toFixed(1)` rounding). This is the
  only user-visible delta here, and it carries a matching user-facing line in RELEASE_NOTES.md.
  `LoudnormSidecarJson`/`ChapterLoudness` also gain an optional `normalizationType: 'linear' |
  'dynamic'`, whose absence is meaningful (single-pass output, a failed second-pass JSON parse, or
  a `scripts/relufs-existing.mjs` rewrite) rather than a bug. Plan:
  [`docs/features/272-golden-assembly-comparison.md`](https://github.com/dudarenok-maker/Castwright/blob/main/docs/features/272-golden-assembly-comparison.md).
