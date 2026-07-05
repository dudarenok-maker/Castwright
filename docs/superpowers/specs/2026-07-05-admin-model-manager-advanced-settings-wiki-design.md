# Admin / Model Manager split + Advanced Settings rewrite + remaining wiki
# interaction-state screenshots — design

Status: draft
Date: 2026-07-05

## Problem

Two tracked follow-ups from the wiki screenshot audit (PR #1315), plus one
problem discovered while scoping them, turned out to be the same underlying
issue at different scales:

- **#1319** — `docs/wiki/Admin-and-Model-Manager.md` covers two distinct
  surfaces (the Admin watch console, and the full Model Manager) on one page
  with two hero screenshots, raised as "consider splitting on a secondary
  audit."
- **Advanced Settings**, on inspection, has the same problem much worse:
  `docs/wiki/Advanced-Settings.md` documents only 1 of its 11 knob groups
  (Voice engine & device) in real detail with a screenshot; the other 10 —
  97 knobs total — get a single bullet-list line each.
- **#1318** — 11 wiki pages each carry an inline "tracked as a follow-up"
  note for one or more interaction-state screenshots (a modal open, a drag
  mid-flight, a specific tab clicked) that PR #1315 didn't attempt, either
  because they need a Playwright `action()` step or because the marketing
  harness's fixture data doesn't yet model the state.

Both the split/rewrite work and #1318 need the same underlying mechanism —
an `action()` step added to an `e2e/marketing/scenes.ts` scene — so this
design covers all three together rather than as separate passes.

## Goal

- Split `Admin-and-Model-Manager.md` into `Admin.md` and `Model-Manager.md`,
  each covering only its own surface.
- Expand `Model-Manager.md`'s settings sections (Defaults for new books,
  Two-model analyzer split, Voice engine, Server configuration, Install/update
  analyzer) from one summary paragraph to full per-knob detail.
- Rewrite `Advanced-Settings.md` so all 11 knob groups get the same
  per-section-screenshot + per-knob-table treatment currently given to only
  1 of them.
- Close out all 11 items in #1318: add the missing screenshot(s) to each of
  Manuscript Management, Generating Audio, Reviewing Cast & Assigning Voices,
  Reviewing Low-Confidence Speaker Tags, Designing a Voice, The Model Control
  Pill, Listening & Revising, Exporting, Mobile/Tablet/Companion,
  Multi-language Support, and Voice Engines.
- Every new section/state gets a real screenshot from the `e2e/marketing/`
  harness, not a placeholder or a reused unrelated shot.
- Update every cross-reference (sidebar, other wiki pages) to point at the
  correct new page.

## Non-goals

- No changes to real (non-mock) application behavior. Touched source is
  limited to: `e2e/marketing/scenes.ts` (new scenes/actions, test-only),
  `e2e/marketing/capture.spec.ts` (adds an opt-in `strict` failure mode,
  test-only — see "Harness reliability" below),
  `src/mocks/marketing/hollow-tide.ts` (new marketing-only fixture data —
  an undesigned character, seeded markers/export-queue items, a Russian and
  a German book+cast), and `src/lib/api.ts`'s shared
  `mockGetModelInventory` (Coqui/Qwen-base flipped to installed/ready — see
  Part 2, item 11). The last one is the one change visible outside the
  marketing harness (dev-mode `VITE_USE_MOCKS` UI, other frontend tests),
  which is why it's verified against the full frontend suite rather than
  treated as harness-local.
- Not a rewrite of Admin's own content (Health/throughput/trends) — that
  prose is accurate today and just moves to its own page unchanged.
- Not a redesign of the wiki's information architecture beyond this one
  split — other pages are out of scope.
- Not adding new knobs, changing defaults, or altering any knob's behavior.
  Purely descriptive of what already exists in
  `server/src/config/registry.ts`.
- No product-code change to add a pill for Qwen VoiceDesign specifically —
  #1318's "Qwen's row" is read as the Qwen3-TTS Base row (the one with an
  existing `TTS_ENGINE_BY_ID` mapping); VoiceDesign has no such mapping and
  would need a real `src/views/model-manager.tsx` change to ever show a
  pill, which is out of scope here.

## Scope tracking

This stays under **#1319**, and now also closes **#1318** in the same PR —
#1319 already frames the question as "consider splitting Admin & Model
Manager," and the Advanced Settings rewrite is that same consideration
taken to its logical conclusion; #1318's fix shares the identical
mechanism (an `action()` scene addition) discovered while scoping #1319, so
folding it in avoids a second near-identical PR. The PR body will call out
explicitly that scope grew from a single page split to a 3-page rewrite
plus 11 additional screenshot fixes, so the delta is visible in review
rather than buried. Both issues get `Closes #NN`.

## Part 1: #1319 — Admin/Model Manager split + Advanced Settings rewrite

### Page 1: `Admin.md` (new file, replaces the Admin half of the old page)

Content is the existing Admin prose from `Admin-and-Model-Manager.md`
unchanged: the Health board, Generation throughput, Resource trends, the
three link-out cards (About Castwright / Model Manager / Advanced
configuration), the LAN access card, and the dev-only Worktrees note.

- Reuses the existing screenshot, moved from
  `docs/wiki/images/admin-and-model-manager/01-admin-overview.png` to
  `docs/wiki/images/admin/01-admin-overview.png`.
- No content changes beyond the page split and updated "Next:" link (now
  points to `Model-Manager`, since that's the natural next stop from Admin's
  own "Model Manager" card).
- e2e/marketing scene: existing `admin` scene (`hash: '#/admin'`) is
  untouched.

### Page 2: `Model-Manager.md` (new file, replaces the Model Manager half)

Structure, in page order:

1. **Device** — GPU(s) detected, VRAM, what determines which engines are
   even offered. New content (previously mentioned in one clause); new
   screenshot.
2. **Installed models** — Standard / Optional add-ons / Analyzer models
   (Ollama) / ASR groups; existing prose on status badges, Load/Stop,
   Install/Update/Repair, Remove stays largely as-is (it's already accurate
   and reasonably detailed). Screenshot re-captured under the renamed scene
   (content is the same as today's, just re-shot for a clean filename/id).
3. **Defaults for new books** — Analysis model, Voice engine, Voice model
   dropdowns. New per-knob table + screenshot.
4. **Two-model analyzer split (advanced)** — Phase 0 model, Phase 1 model,
   Phase 1 minimum chapter lag. New per-knob table + screenshot. Default-off
   framing kept front and center (this is the one group most likely to
   confuse a reader into thinking it's required).
5. **Voice engine** — Auto-start with server, dual-model mode, Generation
   workers. New per-knob table + screenshot.
6. **Server configuration** — Voice engine URL, Analyzer engine, Ollama URL,
   Gemini API key. New per-knob table + screenshot.
7. **Install / update analyzer (Ollama)** — currently entirely undocumented
   in prose. New section, new per-knob table + screenshot.

Each knob table: **label · what it does · default · range/values**. (Model
Manager's settings knobs don't carry the apply-tag/risk pills that Advanced
Settings' registry-driven knobs do — those are Advanced-Settings-specific,
per the research above — so this table is narrower than the Advanced
Settings tables below.)

### Knob reference (source: `src/components/model-settings-form.tsx`)

**Defaults for new books**
| Knob | What it does | Default | Range |
|---|---|---|---|
| Analysis model | Model used to analyze new books | `account.defaultAnalysisModel` | curated list ∪ live Ollama tags |
| Voice engine | Default TTS engine for new books | `account.defaultTtsEngine` | Kokoro / Qwen3-TTS / Coqui |
| Voice model | Default voice model, scoped to chosen engine | resolved `defaultTtsModelKey` | engine-dependent |

**Two-model analyzer split (advanced)** — default OFF (both phases use the
default analysis model)
| Knob | What it does | Default | Range |
|---|---|---|---|
| Phase 0 model (cast detection) | Model used for cast detection | blank = server default | dropdown |
| Phase 1 model (attribution) | Model used for sentence attribution | blank = server default | dropdown |
| Phase 1 minimum chapter lag | Chapters Phase 0 must clear before Phase 1 starts | 10 (effective) | integer, 0–50 |

**Voice engine**
| Knob | What it does | Default | Range |
|---|---|---|---|
| Auto-start with server | Starts the TTS sidecar automatically with the server (needs server restart) | `true` | boolean |
| Keep both voice engines loaded | Dual-model mode — both engines resident at once | `false` | boolean |
| Generation workers | Chapters synthesized concurrently | **1** | integer, 1–4 |

**Server configuration**
| Knob | What it does | Default | Range |
|---|---|---|---|
| Voice engine URL | Base URL of the TTS sidecar | `http://localhost:9000` | string, private/loopback host only |
| Analyzer engine | Routes analysis through local Ollama vs. Gemini direct | **`local`** | local / gemini |
| Ollama URL | Base URL of the local Ollama daemon | `http://localhost:11434` | string |
| Gemini API key | API key for Gemini analyzer/persona calls | (unset) | string |

**Install / update analyzer (Ollama)** — install/pull-tag UI + health probe,
described in prose (no knob table — it's an action panel, not settings).

> **Pre-existing UI-copy bug found while verifying these two defaults (out
> of scope, flagged only):** the Model Manager form's own field text claims
> the opposite for both. `model-settings-form.tsx:489` labels the Gemini
> option "(default — direct)" and its sublabel says "Default — Gemini API
> sends every chapter straight to Google" — but the registry's actual
> shipped default (`server/.env.example` line 14, `registry.ts:850`) is
> `local`. Similarly `model-settings-form.tsx:435`'s sublabel claims
> "1–4, default 2" for Generation workers, but `getResolvedGenerationWorkers()`
> is tested to default to `1` (`server/src/workspace/user-settings.test.ts:174`,
> commented "shipped default" in the registry). The wiki documents the
> **true** registry/tested defaults above, not the UI copy — this doc PR
> does not touch the UI text itself (no product-code change), but the
> discrepancy is real and worth its own follow-up bug issue.

### Page 3: `Advanced-Settings.md` rewrite (same file, full rewrite)

Keep the existing intro paragraph (accordion structure, risk badges, which
groups collapse by default, Reset all / Reset section, restart-banner
behavior, the prompt-row Edit/Revert pattern for group 3). Replace "Below,
that group expanded..." single-group treatment with **one section per
group, in registry order**, each with a screenshot of that group expanded
and a full knob table: **label · what it does · default · range/values ·
apply tag · risk**.

Two format exceptions, called out once in prose rather than fought into the
table shape every time:

- **Group 3 (Analyzer prompts & skills)** — all 6 rows are prompt-shaped
  (Edit / Revert-to-default pairs, not form controls). Table columns become
  **label · what it does · default (shipped skill file)** — no range/apply
  columns, since these aren't per-value settings.
- **Group-level risk exceptions** — `qa-gates` (group risk low) contains 3
  knobs individually tagged medium risk (Voice-QA device, Content-QA device,
  Auto-fix voice mismatches); `gpu-lifecycle` (group risk high) has one knob
  individually tagged medium (Per-card VRAM free floor). Each of these two
  sections gets a one-line callout noting the outliers; the table's own risk
  column already shows the per-knob value correctly.

### Groups, in page order (source: `server/src/config/registry.ts`)

1. **LLM sampling parameters** (`analyzer-sampling`, medium, open) — 6 knobs:
   Ollama temperature (0.2, 0–2), Ollama retry temperature (0.6, 0–2), Ollama
   num_predict (-1, min -1), Gemini max output tokens (8192, 256–32768),
   Ollama num_ctx (32768, min 0), Ollama num_gpu (999, min 0). All live/medium.
2. **Analyzer chunking & truncation guards** (`analyzer-chunking`, medium,
   open) — 7 knobs: Stage-2 chunk char budget (9000), Stage-1 chunk char
   budget (24000), Coverage min ratio (0.6, 0–1), Coverage max ratio (1.6,
   1–5), Ending tail words (8), Min duplicated-sentence run (4),
   Coverage-guard retries (2, 0 disables). All live/medium.
3. **Analyzer prompts & skills** (`analyzer-prompts`, **high, collapsed**) —
   6 prompt rows, all live/high: Cast detection, Sentence attribution,
   Emotion annotation, Script review, Instruct-annotation, Voice-style —
   each defaulting to its shipped `skills/audiobook-*.md` file.
4. **Analyzer models & endpoints** (`analyzer-models`, medium, open) — 11
   knobs: Analyzer engine (local/gemini, default local), Ollama URL
   (`localhost:11434`), Ollama model (`qwen3.5:4b`), Gemini analyzer model
   (`gemma-4-31b-it`), Voice-style model (`gemini-3.1-flash-lite`), Persona
   generation engine (gemini/local, default gemini), Persona local model
   (blank, low risk), Phase-0/Phase-1 model overrides (blank), Phase-1
   minimum lag (10, min 0), Analyzer keep-alive (`5m`). All live/medium
   except Persona local model (low).
5. **Voice engine & device** (`tts-engine`, **high, collapsed**) — 9 knobs:
   Accelerator profile (auto, **rebuild**), Coqui/Kokoro/Qwen device pins
   (auto, restart-sidecar), Qwen attention impl (sdpa/flash_attention_2,
   restart-sidecar), 4 preload-at-startup toggles (Coqui false, Kokoro true,
   Qwen Base false, Qwen 1.7B-Base false — all restart-sidecar). Plus the
   read-only synthetic "Analyzer (Ollama) device" row (shown only when the
   local analyzer is active).
6. **Voice batching & throughput** (`tts-batching`, medium, open) — 6 knobs:
   Qwen batch size (32, min 1), Qwen batch token budget (3600, min 0), Qwen
   1.7B batch size (32) and token budget (3600), Qwen batch length bucketing
   (true), Generation workers (1, 1–4). All restart-server/medium.
7. **Per-sentence QA gates** (`qa-gates`, low, open) — 25 knobs spanning
   signal QA (re-record budget, RMS/silence thresholds, duration ratios,
   runaway floor), ASR content-QA (enabled false by default, re-record
   budget, sample rate, WER thresholds incl. per-language ES/RU overrides,
   deletion-run/compound-bridge/homophone tolerances, compression-ratio and
   log-prob/no-speech-prob confidence gates), render-integrity voice-match
   (ECAPA, false by default), and the two device knobs (Voice-QA device,
   Content-QA device — both cpu by default, medium risk, restart-sidecar).
8. **Audio loudness targets** (`audio-loudness`, low, open) — 4 knobs:
   Loudnorm enabled (true), Target LUFS (-16), Loudness range (11 LU),
   True-peak ceiling (-1.5 dBTP). All live/low.
9. **GPU arbitration, memory & lifecycle** (`gpu-lifecycle`, **high,
   collapsed**) — 19 knobs: GPU concurrency (1) and VRAM token budget (0 =
   disabled) for the weighted semaphore, per-engine weights (Kokoro 1, Qwen
   1, Coqui 3, Analyzer 4, ASR 1, Speaker-embed 1), safe coexistence VRAM
   floor (11000 MB), 4 idle-TTL knobs (120s each: VoiceDesign, 1.7B-Base,
   ASR, ECAPA), disable-MKLDNN toggle (false), soft/hard RAM and VRAM
   recycle/restart thresholds (0 = auto), per-card VRAM free floor (1024 MB,
   medium risk — the one outlier in this group).
10. **Gemini rate limits** (`rate-limits`, low, open) — 3 knobs: Gemma 4 31B
    RPM (15), TPM (0 = unlimited), RPD (1500). All restart-server/low.
11. **LAN access & device tokens** (`lan-access`, low, open) — 1 knob:
    Device authorization lifetime (30 days, min 1). live/low.

Total: 97 registry knobs + 1 synthetic read-only row, across 11 groups.

### Screenshot / scene plan (`e2e/marketing/scenes.ts`)

All new scenes reuse the `action()` mechanism already established in the
harness — a Playwright step run after navigation, before the screenshot.
The Model Manager and Advanced Settings scenes specifically reuse the
nav-click pattern already proven in the existing single `advanced-settings`
scene: click the group's label inside
`getByRole('navigation', { name: 'Settings sections' })`. (This is distinct
from `regenerate-modal`/`export-audiobookshelf`, which click a plain
`getByRole('button')` — same `action()` mechanism, different selector
shape, since those open modals rather than expand an accordion section.)

**Model Manager** (7 scenes total):
- Rename existing `model-manager` → `model-manager-installed` (no behavior
  change, same hash `#/models`).
- Add: `model-manager-device`, `model-manager-defaults`,
  `model-manager-analyzer-split`, `model-manager-voice-engine`,
  `model-manager-server-config`, `model-manager-install-ollama` — each
  `hash: '#/models'`, each clicking its section's nav label (`Device`,
  `Defaults for new books`, `Two-model analyzer split (advanced)`, `Voice
  engine`, `Server configuration`, `Install / update analyzer (Ollama)`).

**Advanced Settings** (11 scenes total):
- Rename existing `advanced-settings` → `adv-tts-engine` (same hash
  `#/advanced`, same action — clicks "Voice engine & device").
- Add 10 scenes, one per remaining group, `hash: '#/advanced'`, each
  clicking its own nav label per the table above: `adv-analyzer-sampling`,
  `adv-analyzer-chunking`, `adv-analyzer-prompts`, `adv-analyzer-models`,
  `adv-tts-batching`, `adv-qa-gates`, `adv-audio-loudness`,
  `adv-gpu-lifecycle`, `adv-rate-limits`, `adv-lan-access`.
- For the 3 high-risk/collapsed-by-default groups (`adv-analyzer-prompts`,
  `adv-tts-engine`, `adv-gpu-lifecycle`), add a `waitFor` on a distinctive
  in-section knob label alongside the click, since the section is opening
  from closed rather than re-triggering an already-open scroll.

**Admin**: existing `admin` scene untouched.

Screenshots land in `mockups/marketing-screens/<id>.<viewport>.<theme>.png`
(harness output, git-ignored) and get manually curated into
`docs/wiki/images/<page>/NN-caption.png` the same way the existing hero
shots were produced.

### Harness reliability: `strict` mode for new scenes

**Added in response to the mandatory assumption-checker review's top
finding.** Today, both `scene.waitFor` and `scene.action` failures in
`e2e/marketing/capture.spec.ts` are caught, `console.warn`'d, and the
capture proceeds anyway (lines 75-95 of that file) — a deliberate design so
one broken scene can't abort a whole capture run. But this PR's entire
value in ~39 new/renamed scenes (18 in Part 1, 21 in Part 2) is the
*post-interaction* state — a section expanded, a modal open, a drag
mid-flight. Under the current non-fatal contract, a selector drift doesn't
fail anything: it silently produces a screenshot of the *pre-interaction*
state, which then gets hand-curated into the wiki as if it were correct.
Manual review of ~39 images is the only backstop, and it already missed
one case while this spec was being drafted (the boundary-drag selector
correction above).

Fix: add an optional `strict?: boolean` field to the `Scene` type. When
`true`, a `waitFor` timeout or `action` throw is re-thrown instead of
caught, failing that scene's Playwright test outright instead of degrading
to a warning. Every scene added or renamed by this PR sets `strict: true`
and pairs its `action()` with a `waitFor` targeting a selector that only
exists in the *target* state (an `aria-expanded="true"` on the specific
section, a `role="dialog"` on the opened modal, a class/attribute unique to
mid-drag, etc.) — not just the click itself. Existing scenes this PR
doesn't touch stay non-strict, unchanged. This turns "capture ran green"
into an actual signal that every new scene reached its intended state,
rather than "capture ran green" meaning nothing more than "no scene threw
an uncaught exception."

### Image reorganization

- `docs/wiki/images/admin-and-model-manager/` is retired.
- `docs/wiki/images/admin/01-admin-overview.png` — moved, unchanged content.
- `docs/wiki/images/model-manager/` — new directory, 7 images:
  `01-device.png`, `02-installed-models.png`,
  `03-defaults-for-new-books.png`, `04-analyzer-split.png`,
  `05-voice-engine.png`, `06-server-config.png`, `07-install-ollama.png`.
- `docs/wiki/images/advanced-settings/` — stays, renumbered 01–11 in
  registry order (the existing accelerator-profile shot is re-shot as
  `05-voice-engine-device.png` to keep the sequence contiguous with the 10
  new images).

### Cross-link updates

| File | Change |
|---|---|
| `_Sidebar.md` | `[Admin & Model Manager](Admin-and-Model-Manager)` → two entries: `[Admin](Admin)`, `[Model Manager](Model-Manager)` |
| `Advanced-Settings.md` | "used by [Model Manager](Admin-and-Model-Manager)" → `(Model-Manager)` |
| `Mobile-Tablet-and-Companion-App.md` (line 16, LAN access card) | `(Admin-and-Model-Manager)` → `(Admin)` |
| `Mobile-Tablet-and-Companion-App.md` (line 55, "Next:") | `(Admin-and-Model-Manager)` → `(Admin)` |
| `Account-and-Settings.md` (×2, "Models & engines" pointer) | `(Admin-and-Model-Manager)` → `(Model-Manager)` |
| `Admin.md` (new, "Next:") | → `Model-Manager` |
| `Model-Manager.md` (new, "Next:") | → `Advanced-Settings` (unchanged destination, just now originating from a different page) |

## Part 2: #1318 — remaining interaction-state screenshots (11 pages)

Each item below closes independently per #1318's own acceptance checklist.
Grouped by effort tier so the reviewer can see where the risk actually is —
most of this is mechanical.

### Tier A — simple click, no new fixture data

- **Manuscript Management** — Review Script diff: click
  `data-testid="review-script-chapter"` (coalfall ch.3 already has real
  strip_tag/validate_instruct ops queued), wait for the phased mock
  (`mockReviewScript`, ~1.5s) to resolve.
- **Reviewing Cast & Assigning Voices** — A/B compare: click the **"Design &
  compare"** button (`insp-cray`/`dr-wren` already qualify — both have a
  prior `designedVoiceId`).
- **Reviewing Low-Confidence Speaker Tags** — segment inspector: add a click
  on the existing `coalfall-manuscript-low-confidence` scene targeting
  `aria-label="Next low-confidence sentence"`.
- **Designing a Voice** — full-cast scope picker: click "Design full cast"
  on the cast view.
- **The Model Control Pill** — idle state: new scene targeting the
  already-idle `ollama:llama3.1:8b` row on the existing `model-manager`
  scene (`scrollTo`, no click needed — it's idle by default already, just
  unremarked below the fold).
- **Listening & Revising** — share-clip picker: click the
  `aria-label="Share clip of chapter {id}"` button on the existing `listen`
  scene.
- **Exporting** — format-tile row + Companion app banner: `scrollTo` on the
  existing `listen` scene target elements, no click needed (both render
  unconditionally).
- **Mobile, Tablet & Companion App** — LAN-access QR card: click "Authorize
  a device" on the existing `admin` scene.
- **Mobile, Tablet & Companion App** — Pair-a-device modal: click
  `aria-label="Pair a device with the Castwright Companion"` on the existing
  `listen` scene.
- **Exporting** — LAN/QR download tab: new scene using a generic (non-
  Audiobookshelf-hinted) export entry point so the modal opens on the
  `download` tab instead of the `sync-folder`-hinted one `export-
  audiobookshelf` already covers.

### Tier B — simple click, timing-sensitive (screenshot mid-transition)

- **Designing a Voice** — design-in-progress state: click a scope in the
  picker above, screenshot before the mock design run completes.
- **The Model Control Pill** — loading state: click "Load model", screenshot
  before the mock's `await wait(...)` resolves.

### Tier C — needs drag simulation

- **Manuscript Management** — boundary-drag interaction: simulate
  `pointerdown` → `pointermove` → hold (screenshot) → `pointerup` on the
  boundary handle carrying `data-tour-id="chapter-boundary"`
  (`src/views/manuscript.tsx:1663` — this attribute is only emitted for the
  first boundary, `boundaryIdx === 1`, which is fine since the scene just
  needs *a* boundary to drag, not a specific one). **Correction from an
  earlier draft of this spec**, which named a `[data-boundary-idx]`
  attribute that doesn't exist in the DOM — `boundaryIdx` is a React prop,
  not a rendered data-attribute; verified by reading the component directly
  rather than trusting the prop name.

### Tier D — new marketing-only fixture data (`src/mocks/marketing/hollow-tide.ts`)

Isolated to the marketing capture path — no shared-mock risk.

- **Generating Audio** — voice-readiness gate: add an undesigned Qwen-engine
  character to a marketing book's cast so `startGenerationFlow` opens the
  gate.
- **Listening & Revising** — markers panel + re-record flow: seed a
  `markers` entry (and one with `kind:'re-record'`) in the mock
  listen-progress response.
- **Exporting** — export queue: seed a non-empty `queueItems` entry.
- **Multi-language Support** — add both a Russian-language and a
  German-language book+cast to the marketing fixtures (ported from
  `server/src/__fixtures__/the-coalfall-commission.ru.md` and a new German
  equivalent). Two new scenes: Russian book upload → language-detection
  screenshot (Cyrillic is the clearest detection signal); German book →
  non-English cast-confirmation screenshot. One language per shot, not both
  languages through both screens.

### Tier E — shared mock code change + full test verification

- **Voice Engines** — Coqui row: flip `mockGetModelInventory`'s Coqui entry
  in `src/lib/api.ts` from `present:false/'not-installed'` to
  `present:true` with an installed state, so a `ModelControlPill` renders.
  Qwen row: flip `qwen-base`'s `installState` from `'package-missing'` to
  `'ready'`. Both new scenes reuse the existing `model-manager` scene's
  hash with a `scrollTo` to the relevant row.
  **This is the one change with regression risk beyond the marketing
  harness** — `mockGetModelInventory` is shared by every mock consumer, not
  just marketing scenes. Run the full frontend suite (`npm run test`) after
  the flip and fix (not skip) anything that asserted the old
  not-installed/package-missing state.
  **Second flip required, found during review**: Qwen's install state has
  a *second* source of truth — the module-level
  `MOCK_SIDECAR_QWEN_INSTALL_STATE` const (`src/lib/api.ts:6749`), consumed
  by `qwenInstallState`/`qwenPackageInstalled` and, transitively,
  `getSidecarHealth`. Flipping only the inline literal inside
  `mockGetModelInventory` leaves this second const at its old value, so the
  Model Manager row would show "ready" while health/promo-banner UI still
  reports Qwen as not installed. Both consts need to flip together, and the
  `npm run test` verification pass must explicitly exercise the
  sidecar-health/promo path, not just the Model Manager row's own tests.

### Tier F — hardest: needs new fixture data + mock-stream timing

- **Generating Audio** — preview + A/B revision player
  (`RevisionDiffPlayer`): needs a book reliably posed mid-preview-regen
  (dispatch `setPreviewRegen`, wait for the mock `chapter_complete` stream
  event, screenshot before the diff player closes). More involved than a
  static fixture seed since it depends on stream-event timing, not just
  data shape — budget extra iteration time on this one scene specifically.

### Scenes added (`e2e/marketing/scenes.ts`), Part 2 total: 21

`manuscript-review-script`, `cast-ab-compare`, `low-confidence-inspector`
(action added to existing scene), `voice-design-scope-picker`,
`voice-design-in-progress`, `model-pill-idle`, `model-pill-loading`,
`listen-share-clip`, `export-format-companion` (action added to existing
scene), `export-lan-qr`, `mobile-lan-qr` (action added to existing `admin`
scene), `mobile-pair-device`, `manuscript-boundary-drag`,
`generating-voice-readiness`, `listen-markers-rerecord`, `export-queue`,
`language-detect-russian`, `language-cast-confirm-german`,
`voice-engines-coqui`, `voice-engines-qwen`, `generating-revision-diff` —
21 scenes total (Tier A: 10, Tier B: 2, Tier C: 1, Tier D: 5, Tier E: 2,
Tier F: 1).

## Testing / verification

This PR is **not** docs-only, even for the Part 1-only slice — it edits
`e2e/marketing/scenes.ts`, which isn't under the `docs/**` doc-only glob.
The full `npm run verify` battery is required (not exempt), and the
mandatory `code-review` gate applies. Given this spans docs (Part 1) +
test/fixture code (Parts 1 & 2) + one shared-mock behavior change (Part 2
Tier E), it's a multi-scope PR → **high** effort per the model-routing
table, not the `low`/`medium` a single-scope docs or fix PR would get.

- `npx playwright test e2e/marketing/capture.spec.ts` must pass green with
  every new/renamed scene's `strict: true` — this is now the primary
  automated backstop that a scene actually reached its target state (see
  "Harness reliability" above), not merely that the run didn't crash.
- Scripted check that every `docs/wiki/**/*.md` image reference resolves to
  an existing file, and no orphaned image files remain after the
  `admin-and-model-manager` → `admin` + `model-manager` split.
- Manual review of every new/re-captured screenshot against its caption for
  content accuracy — now a secondary check (strict mode catches a missed
  interaction; this catches a *correct* interaction with wrong/misleading
  framing) — especially the 3 high-risk collapsed Advanced Settings groups
  and the two Tier B timing-sensitive captures.
- `npm run test` (frontend) run explicitly after the Tier E mock-inventory
  flip, covering both `mockGetModelInventory` consumers AND the
  `MOCK_SIDECAR_QWEN_INSTALL_STATE`-derived health/promo path (see Tier E
  above) — not just the Model Manager row's own tests.
- `npm run verify` full battery before merge (not exempt — see above).

## Out of scope

- Re-shooting Admin's own screenshot (content unchanged, already accurate).
- Any change to Account & Settings, Mobile/Tablet/Companion, or other pages
  beyond fixing their cross-references.
- Adding new knobs or changing any default/behavior in
  `server/src/config/registry.ts` or `model-settings-form.tsx`.
- Non-English *wiki prose* (still English-only for the guide text itself —
  only the two new Multi-language Support screenshots show non-English
  in-app content, per the parent wiki design's English-only scope).
- A product-code pill for Qwen VoiceDesign (see Non-goals).
- Any UI/UX change to make the harder Tier E/F states easier to capture —
  these are worked around in test fixtures/timing, not by changing the app.
