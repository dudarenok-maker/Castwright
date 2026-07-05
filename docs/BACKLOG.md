# Backlog (MoSCoW)

The prioritized planning view, **generated from the GitHub Projects board**
by `npm run backlog:sync` (ops-25) — do not hand-edit; edit the linked issue
and re-run the sync instead. Each item maps to exactly one GitHub issue — the
**canonical detail home** (What / Acceptance / Key files / Depends on /
Benefit). This file lists only `type:feature` issues whose board Status is
not `Done`; bugs and `type:chore` issues live on the board's "Bugs & Chores"
view instead and never appear here. See
[CONTRIBUTING.md "Issues"](../CONTRIBUTING.md#issues).

**Item IDs are permanent.** Each item carries a `<prefix>-<n>` ID — `fe`
(frontend), `srv` (server), `side` (TTS sidecar), `ops` (CI / build /
dev-tooling), `fs` (full-stack), or `app` (Android companion app). IDs are
assigned once and **never reused or renumbered**; gaps are expected.

**Priority = position.** Ordering within a tier follows each issue's numeric
`Priority` field on the board (lower number = higher priority, appears
first) — set it via the board UI or `gh project item-edit --field-id
<priorityFieldId> --number <n>` to reprioritize, then re-run `npm run
backlog:sync`. An issue with no `Priority` set sorts after every
prioritized issue in its tier.

---

## Must — the beta → full-product spine (marketability & discoverability)

#### `fs-51` — Per-book performance-QA report (visible + exportable acoustic+ASR+drift summary) ([#973](https://github.com/dudarenok-maker/Castwright/issues/973))

- _What:_ Turn the existing **acoustic + ASR + drift** QA gate into a **visible, exportable per-book QA report** — e.g. "*N lines re-recorded, M transcript-verified, 0 drift detected*". Aggregates signals the pipeline already produces; presents and exports them.
- _Benefit:_ **Proof, not promises.** epub2tts now does ASR-matching; making ours *legibly* more (acoustic + ASR + drift, automatic, per book) defends the QA moat. Beta→full-product **Must**. _Source:_ triage of `brand/oss-gap-backlog-2026-06-20.md` (OSS gap analysis) · triage record: `docs/superpowers/specs/2026-06-21-oss-gap-backlog-triage-design.md` (2026-06-21).
_Full detail + acceptance:_ [#973](https://github.com/dudarenok-maker/Castwright/issues/973).

#### `fs-38` — Voice cloning (your own / family voice) + cloned-vs-designed library split ([#624](https://github.com/dudarenok-maker/Castwright/issues/624))

- _What:_ In-app voice-sample **capture** (record/upload) with quality guidance + re-take. Explicit **consent on the record** (names the person + permitted use); cloning blocked without it. **Clone + cast** via XTTS (zero-shot reference) first, then Qwen design-to-target; held consistent across book + series. **Voice-library split:** cloned voices get their own `#/voices` section with provenance + consent, **excluded** from the cross-book "offer it back" matcher so a person's voice is never reused into a stranger's book. **Local-only**; export explicit.
- _Benefit:_ the most personal, gift-able feature the product can offer — and the strongest consumer hook.
_Full detail + acceptance:_ [#624](https://github.com/dudarenok-maker/Castwright/issues/624).

#### `fs-52` — Caption/SRT export (.srt/.vtt; line/sentence/word) from per-sentence alignment ([#975](https://github.com/dudarenok-maker/Castwright/issues/975))

- _What:_ Emit **.srt / .vtt captions** in **line + sentence + word** modes from the per-sentence alignment we already compute during synthesis.
- _Benefit:_ abogen's **headline feature**, near-free for us given existing alignment — AND it **feeds demo/social clips**, so it doubles as an awareness/content lever. Beta→full-product **Must** (reach & perception). _Source:_ triage of `brand/oss-gap-backlog-2026-06-20.md` (OSS gap analysis) · triage record: `docs/superpowers/specs/2026-06-21-oss-gap-backlog-triage-design.md` (2026-06-21).
_Full detail + acceptance:_ [#975](https://github.com/dudarenok-maker/Castwright/issues/975).

#### `ops-1` — Windows installer (Inno Setup or NSIS) wrapping the release zip ([#432](https://github.com/dudarenok-maker/Castwright/issues/432))

- _What:_ Add an Inno Setup (or NSIS) script that wraps the `castwright-vX.Y.Z.zip` produced by the release-package pipeline (plan 49) into a signed `.exe` installer. Installer extracts to `%LocalAppData%\Castwright`, drops a Start Menu entry, checks the **runtime** prerequisites (Node 20.6+, Python 3.11, ffmpeg on PATH) with download links shown for any missing dep, then launches the app. **Model install + smoke test are NOT the installer\s job** — they are owned by the shared [`fs-21` first-run wizard](https://github.com/dudarenok-maker/Castwright/issues/474) (cross-platform, also used by the macOS `.dmg` [`ops-15`](https://github.com/dudarenok-maker/Castwright/issues/735)), so the Windows and macOS paths stay consistent. Extend `release.yml` with a follow-on job that builds the installer (on a Windows runner) and uploads it as a second release asset.
- _Benefit:_ friction-free install for non-developers. Today\s plan-49 deployer must read INSTALL.md and run PowerShell commands by hand; the installer reduces that to a click.
_Full detail + acceptance:_ [#432](https://github.com/dudarenok-maker/Castwright/issues/432).

#### `ops-15` — macOS installer (.dmg) wrapping the release zip ([#735](https://github.com/dudarenok-maker/Castwright/issues/735))

- _What:_ Add a build step that wraps the `castwright-vX.Y.Z.zip` produced by the release-package pipeline (plan 49) into a **signed, notarized `.dmg`** — a drag-to-`/Applications` disk image (the Mac-native idiom). The bundle delivers the app + a launcher (`.app` wrapper invoking `start.sh`); it does **not** embed a model-install script. All app-level setup — GPU detect, model install (Kokoro/Qwen/Ollama analyzer), defaults, smoke synth — is owned by the shared **`fs-21` first-run wizard**, identical across Windows/macOS/Linux. The installer only needs the app on disk + the runtime prerequisites (Node 20.6+, Python 3.11, ffmpeg) bundled or checked. Extend `release.yml` with a follow-on job that builds the `.dmg` on a **macOS runner** and uploads it as a release asset (sibling to the `ops-1` `.exe` job).
- _Benefit:_ friction-free install for non-developer Mac users — the other primary deployer platform alongside Windows. Today a Mac deployer must read INSTALL.md and run shell commands by hand; the `.dmg` reduces that to drag-and-drop.
_Full detail + acceptance:_ [#735](https://github.com/dudarenok-maker/Castwright/issues/735).

#### `app-12` — iOS build + release ([#555](https://github.com/dudarenok-maker/Castwright/issues/555))

- _What:_ The "Android initially" follow-through; incremental thanks to the iOS-readiness principles. Codec caveat: iOS AVPlayer can’t play .ogg (server must render MP3/M4A for iOS).
- _Benefit:_ One codebase, both platforms.
_Full detail + acceptance:_ [#555](https://github.com/dudarenok-maker/Castwright/issues/555).

## Should — important, not blocking ship

#### `fs-14` — Russian UI localization (interface strings, react-i18next) ([#396](https://github.com/dudarenok-maker/Castwright/issues/396))

- _What:_ Localize the application interface to Russian. Stand up an i18n framework (**react-i18next** — user-confirmed choice) + a per-user `UserSettings.uiLanguage` preference with a language switcher in Account management, then translate the high-traffic surfaces first (top nav, account, upload/confirm, listen, cast) and grow coverage incrementally. Ground truth at capture: **no i18n library today**, ~1,500 hardcoded user-facing strings across ~82 components (densest: `account.tsx` ~92, `profile-drawer.tsx` ~79, `voices.tsx` ~68, `analysing.tsx` ~59, `cast.tsx` ~58, `export-audiobook.tsx` ~52). Centralisable copy already lives in `src/data/{walkthroughs,analysis-phases,regen-reasons,match-factors,listener-apps}.ts`. Locale-sensitive formatting is minimal (`src/lib/time.ts` durations only; no currency/date pickers).
- _Benefit:_ a fully Russian-speaking user gets a Russian app, not just Russian audio. The i18n framework makes every future language an incremental translation-file add rather than a code change. Pairs with fs-2 to make Russian a first-class end-to-end experience.
_Full detail + acceptance:_ [#396](https://github.com/dudarenok-maker/Castwright/issues/396).

#### `fs-44` — MCP agent surface (agents drive Castwright end-to-end) ([#721](https://github.com/dudarenok-maker/Castwright/issues/721))

- _What:_ An **MCP (Model Context Protocol) server surface** so any MCP-capable agent — Claude Cowork / Claude Code, **Codex, Copilot CLI, Gemini CLI, Cursor**, whatever the user's primary harness is — can drive the full Castwright pipeline programmatically (upload → analyze → cast → generate → export) instead of computer-use button-clicking against the web UI. **In-process Streamable-HTTP endpoint** at `/mcp` on the existing Express server (`@modelcontextprotocol/sdk`, stateless transport), behind the existing `requireLanToken` guard — localhost free, LAN token + TLS via `start:lan`, identical posture to `/api`. A **`castwright-mcp` stdio bridge** (pure transport proxy bin, wave 4) ships in the **same delivery** so stdio-only harnesses (Codex etc.) work out of the box — every agent type, both transports, one tool surface. **~15 hand-designed workflow-level tools** (not auto-generated CRUD from the ~60 REST routes): read/inspect (`list_books`, `get_book`, `get_cast`, `list_voices`, `get_job`, `get_system_status`), pipeline (`upload_manuscript`, `start_analysis`, `start_generation`, `export_audiobook`), cast/voice parity (`update_character`, `merge_characters`, `design_voice`, `design_full_cast`), and `wait_for_job` (long-poll so agents don't busy-loop). **Client-agnostic by requirement:** core-spec MCP only (tools + JSON/text results); no sampling/elicitation/roots; annotations advisory only. Long ops return `jobId`s projected through a uniform job view; SSE stays UI-only. Structured errors carry `{ code, message, remediation }` so agents self-serve recovery. Every tool calls the same route/service layer the REST API uses — `openapi.yaml` stays the single contract; MCP is a curated façade, never a second implementation. Full design: [`docs/superpowers/specs/2026-06-11-castwright-mcp-agent-surface-design.md`](../blob/main/docs/superpowers/specs/2026-06-11-castwright-mcp-agent-surface-design.md) (delivery waves 1–4 + v1 DoD inside). Implementation plan: [`docs/superpowers/plans/2026-06-11-fs44-mcp-agent-surface.md`](../blob/main/docs/superpowers/plans/2026-06-11-fs44-mcp-agent-surface.md) (17 TDD tasks, critically reviewed 2026-06-11 — zod-4/SDK compat verified, `sub.res.end()` crash path mitigated via stub-res recorder subscribers).
- _Benefit:_ _(user / strategic):_ Castwright becomes drivable by whatever agent the user already lives in — "produce this book overnight and tell me when it's exported" becomes a one-line prompt instead of an evening of clicking. Aligns the product with the agent-first direction of every major harness, and the MCP e2e doubles as the missing whole-pipeline integration test.
_Full detail + acceptance:_ [#721](https://github.com/dudarenok-maker/Castwright/issues/721).

#### `fe-7` — Per-voice row sample-preview button inside `<VoiceOverridePicker>` ([#416](https://github.com/dudarenok-maker/Castwright/issues/416))

- _What:_ Add a per-row Play button that routes through `playSampleWithAutoLoad` (same helper the existing "Preview voice" / cast-row swatch use). Hover/focus reveals the icon on pointer devices; `coarse-pointer:opacity-60` keeps it faintly visible on touch. Sample text comes from the same drawer-level `previewText` the candidate-preview block uses. Single-row in-flight gate (the helper already coalesces concurrent clicks).
- _Benefit:_ shortens the "scrolled past 40 Kokoro voices, want to hear three before committing" flow from "pick → close → preview from drawer → pick another" to "▶ in-row, ▶ in-row, pick the one I like." Pairs with the autocomplete added in this bundle — search narrows the list, in-row preview judges the few remaining options.
_Full detail + acceptance:_ [#416](https://github.com/dudarenok-maker/Castwright/issues/416).

#### `fs-35` — per-chapter Detect-emotions trigger (fs-33 follow-up) ([#592](https://github.com/dudarenok-maker/Castwright/issues/592))

- _What:_ Follow-up to fs-33 (#510), shipped whole-book only. Add a per-chapter "Detect emotions" option (the emotion-only backfill pass scoped to the current chapter) alongside the whole-book trigger in the manuscript header.
- _Benefit:_ cheap targeted re-detect for one chapter.
_Full detail + acceptance:_ [#592](https://github.com/dudarenok-maker/Castwright/issues/592).

#### `app-10` — Stream-over-LAN instant play ([#553](https://github.com/dudarenok-maker/Castwright/issues/553))

- _What:_ Optionally stream …/audio.mp3 (range) to start a not-yet-downloaded chapter on the home network.
- _Benefit:_ Zero-wait preview before committing a download (deprioritised — offline emphasised).
_Full detail + acceptance:_ [#553](https://github.com/dudarenok-maker/Castwright/issues/553).

#### `srv-57` — Multi-GPU Wave 2 — on-box acceptance + Task 16/16.5 auto-revert follow-up ([#1230](https://github.com/dudarenok-maker/Castwright/issues/1230))

- _What:_ Two related, gated items left over from the multi-GPU per-model arc (Wave 1 → Wave 2 → Plan 2a, all merged to `main`): 1. **Wave 2's on-box acceptance checklist has never run against real hardware.** `test:sidecar` is venv-gated so CI never exercises the real CUDA paths — this checklist is the only place Wave 2's per-card safety runtime (device ledger, free-VRAM floor, code-43 streak guard, cross-charge guards) gets verified against real GPUs. Full list lives in `docs/superpowers/plans/2026-07-02-multi-gpu-wave2-plan2.md` → "## Ship notes" → "### Wave 2" (status: NOT YET SHIPPED as of 2026-07-03), also referenced from `docs/features/236-multi-gpu-per-model-safety.md`. Checklist items: [ ] Confirm torch exposes real per-card UUIDs on this box (`python -c "import torch; print(torch.cuda.get_device_properties(0).uuid)"` in the sidecar venv) — if it errors, `DeviceLedger`'s renumber-detection is a no-op on this box; note that explicitly rather than assuming the guarantee holds. [ ] `SIDECAR_VRAM_FREE_FLOOR_MB=1024` (default) — starve a card to <1024MB free → sidecar self-exits (code 43), `/health` gpus[] showed the breach before exit. [ ] `QWEN_DEVICE=cuda:0 KOKORO_DEVICE=cuda:1` (different cards) → VoiceDesign + concurrent Kokoro synth, no blocking (`shares_device=False`). [ ] `QWEN_DEVICE=cuda:0 KOKORO_DEVICE=cuda:0` (same card, default) → VoiceDesign blocks new Kokoro synths until done (`shares_device=True`, unchanged from Wave 1). [ ] Force 3 code-43 exits within 10 minutes via a CARD-SPECIFIC trigger → streak-trip warning logs; sidecar stops respawning; `tripEvent()` shows the right card + resident engines. [ ] Force 3 code-43 exits within 10 minutes via a NON-card-specific trigger (e.g. absurdly low `SIDECAR_RESTART_MB`) → streak still trips; the "tripped WITHOUT a specific card... requires MANUAL investigation" path is exercised (this is exactly what makes auto-revert's "unrevertable" status meaningful — see item 2 below). [ ] Analyzer confirmed on CPU (`ANALYZER=local`, Ollama CPU-only) — run at least one analysis first so `analyzer-device-state.ts`'s cache actually populates — → a concurrent Qwen GPU synth is NOT serialized behind the analyzer. [ ] Analyzer confirmed on GPU → existing serialization behaviour unchanged (regression check). [ ] `COQUI_DEVICE=cpu` while the analyzer holds the GPU → the Coqui load runs immediately, no eviction wait. [ ] Qwen voice-design while `tts.qwen.device=cpu` → the design's `withGpuLoad` call runs immediately too. 2. **Task 16/16.5 (auto-revert on a repeated bad pin + its operator toast)** — deliberately excluded from Plan 2a (#1222, shipped 2026-07-03) because `runAutoRevert` directly consumes Wave 2's `tripEvent()`, which item 1 above is what actually exercises on real hardware. Scope (already designed, not yet built): a card-specific code-43 streak triggers `runAutoRevert`, which reverts the offending pin and surfaces a toast ("auto-reverted: ..."); a non-card-specific streak instead surfaces a distinct "not tied to a specific GPU card... manual investigation" toast via `/api/gpu/trip-status` reporting `status:'unrevertable'`.
- _Benefit:_ Converts merged-but-unvalidated multi-GPU safety code into a confirmed guarantee, and closes the auto-revert gap so a repeated bad GPU pin self-heals with an operator-visible toast instead of silently degrading.
_Full detail + acceptance:_ [#1230](https://github.com/dudarenok-maker/Castwright/issues/1230).

## Could — nice to have, low-cost win

#### `fs-17` — Read-along: sentence highlight synced to audio ([#464](https://github.com/dudarenok-maker/Castwright/issues/464))

- _What:_ Show manuscript text beside the player and highlight the current sentence as audio plays. Leverage the per-segment timing already used to drive the listen-view waveform/segments (`segments.json` via `server/src/routes/chapter-audio.ts`); widen the API to expose per-sentence start/end if not already surfaced, then map the live playhead to the active sentence.
- _Benefit:_ Immersion / accessibility / pronunciation learning — a differentiating feature. _Owes a `docs/features/NN-*.md` regression plan (substantial)._ _Net-new from the 2026-06-02 backlog brainstorm (Listener / Reliability / Distribution / Net-new / Sharing lenses). MoSCoW `should` is a placeholder — to be re-bucketed in the upcoming whole-backlog priority pass._
_Full detail + acceptance:_ [#464](https://github.com/dudarenok-maker/Castwright/issues/464).

#### `fs-41` — Auto-detect manuscript language on ingest (filter voice library + auto-load engine) ([#666](https://github.com/dudarenok-maker/Castwright/issues/666))

- _What:_ Complete the multi-language "second half": on book ingest, **auto-detect the manuscript language**, **filter the voice library** to that language, and **auto-load the right engine** (e.g. Qwen3-TTS for Russian, Kokoro for English) — keeping the existing hard invariant that a cast never crosses languages within a book. Today the language path works end-to-end (fs-2) but the user drives engine/voice selection manually.
- _Benefit:_ Removes the most error-prone manual step for non-English books; one of the most-requested multi-language directions. Pairs with fs-2 (language engine half, shipped) and fs-14 (Russian UI localization).
_Full detail + acceptance:_ [#666](https://github.com/dudarenok-maker/Castwright/issues/666).

#### `fs-27` — Chapter recaps / previously summaries ([#481](https://github.com/dudarenok-maker/Castwright/issues/481))

- _What:_ LLM-generated short recap per chapter (the analyzer already does LLM work), shown — and optionally synthesized as a spoken "previously…" intro — when the user resumes a book after a gap. Opt-in per book; cost surfaced up front (quota/GPU).
- _Benefit:_ Graceful re-entry into a long book after days away. _Net-new from the 2026-06-02 backlog brainstorm (Listener / Reliability / Distribution / Net-new / Sharing lenses). MoSCoW `should` is a placeholder — to be re-bucketed in the upcoming whole-backlog priority pass._
_Full detail + acceptance:_ [#481](https://github.com/dudarenok-maker/Castwright/issues/481).

#### `fe-26` — Marker export + shareable notes ([#461](https://github.com/dudarenok-maker/Castwright/issues/461))

- _What:_ Per-book markers (note + re-record kinds) already live in `src/store/listen-progress-slice.ts` and render in the markers panel (`src/components/listen/listen-player-region.tsx`). Add an export affordance that writes the marker list (timestamp · chapter · label · kind) to a text/JSON file the user can save or share.
- _Benefit:_ Makes re-record markers actionable outside the app (study / review / handoff to an editor). _Net-new from the 2026-06-02 backlog brainstorm (Listener / Reliability / Distribution / Net-new / Sharing lenses). MoSCoW `should` is a placeholder — to be re-bucketed in the upcoming whole-backlog priority pass._
_Full detail + acceptance:_ [#461](https://github.com/dudarenok-maker/Castwright/issues/461).

#### `fs-59` — CJK (Chinese/Japanese) language support: analysis + synthesis ([#1004](https://github.com/dudarenok-maker/Castwright/issues/1004))

- _What:_ CJK (Chinese `zh`, Japanese `ja`) language support, end-to-end, as a follow-on to the Latin-script Qwen tranche (`fs-50` / the 2026-06-22 language-aware-ingest spec). Split out because CJK analysis is materially harder than Latin and needs its own foundations.
- _Benefit:_ Extends language breadth to the two highest-population CJK languages — a large slice of the "rivals show 1,158 languages" gap that Latin alone can't close.
_Full detail + acceptance:_ [#1004](https://github.com/dudarenok-maker/Castwright/issues/1004).

#### `fs-10` — Render the chapter-title segment on the Listen view timeline ([#412](https://github.com/dudarenok-maker/Castwright/issues/412))

- _What:_ The new title segment in `segments.json` (kind: `'title'`, empty `sentenceIds[]`) is currently filtered out at the `ChapterAudio` API boundary in `server/src/routes/chapter-audio.ts` because the wire contract types `sentenceId` as a required integer. To surface the title on the listen-view timeline (a labelled "TITLE" pill anchored at the start of the chapter, ~3 s wide including silence), widen the API segment shape so `sentenceId` is optional and add an optional `kind?: 'title' | 'sentence'` discriminator, regenerate `src/lib/api-types.ts`, then teach `src/components/listen/listen-player-region.tsx` to render title-kind segments differently from sentence-kind segments.
- _Benefit:_ visual cue that matches the audible cue — listener sees "you're hearing the title now" before the body segments start. Today the title beat is audible-only.
_Full detail + acceptance:_ [#412](https://github.com/dudarenok-maker/Castwright/issues/412).

#### `fs-60` — Coqui XTTS per-language engine eligibility (gap-fill beyond Qwen) ([#1005](https://github.com/dudarenok-maker/Castwright/issues/1005))

- _What:_ Per-language **engine eligibility** for Coqui XTTS on the five languages Qwen already fully supports (en/ru/es/fr/de, per fs-41/fs-50) — lets a non-English book use Coqui voices instead of being hard-forced to a designed Qwen voice with no recovery path when Qwen is unavailable/undesigned/erroring. Primary driver is **resilience** (a fallback path for non-English books, mirroring English's existing Kokoro fallback), plus this is the plumbing fs-38 (voice cloning) needs to let a cloned voice speak a non-English book at all. **Narrowed on design (2026-07-04)** — see `docs/superpowers/specs/2026-07-04-fs60-xtts-language-eligibility-design.md`. The original ask bundled Kokoro non-English support and a broader language set into this issue; design work found those are much larger, differently-shaped problems and split them out: Kokoro non-English (G2P backend + voice packs — real new-dependency work) → `fs-69` (#1302) XTTS languages beyond this five (zh-cn, ja, ko, ar, hi, nl, pl, tr, cs, hu, it, pt — real analyze-side scope) → `fs-70` (#1303) Cross-book/cross-language voice-identity check (no real trigger until a multi-language series or fs-38 exists) → `fs-71` (#1304)
- _Benefit:_ Resilience for non-English generation (no hard-fail when Qwen is unavailable); unblocks fs-38 voice cloning's XTTS path for non-English books. Lowest strategic priority.
_Full detail + acceptance:_ [#1005](https://github.com/dudarenok-maker/Castwright/issues/1005).

#### `fs-68` — Wiki: Release Notes section, one page per release ([#1280](https://github.com/dudarenok-maker/Castwright/issues/1280))

- _What:_ Add a **Release Notes** section to the GitHub wiki (alongside the guide built by #1276): one wiki page per shipped release, each page's content copied from that release's **actual GitHub Release page** (`gh release view vX.Y.Z` — the detailed, PR-refed technical notes), not from the user-facing summary in `RELEASE_NOTES.md`. The GitHub release body is the more detailed and useful source for wiki readers digging into specifics; `RELEASE_NOTES.md` stays the brand-voice summary surfaced in-app. Gives readers a way to browse full release history and detail without leaving the wiki or paging through GitHub's release list, and gives the app itself (or docs) an easy stable link target per release.
- _Benefit:_ *Benefit (user):* browse full, detailed release history directly in the wiki, no GitHub-release-list spelunking, more detail than the in-app summary. *Benefit (technical):* app and docs get a stable, linkable per-release URL without duplicating release-note authoring — pulls the existing GitHub Release body verbatim. Refs #1276
_Full detail + acceptance:_ [#1280](https://github.com/dudarenok-maker/Castwright/issues/1280).

#### `fs-9` — Configurable chapter-title silence durations ([#411](https://github.com/dudarenok-maker/Castwright/issues/411))

- _What:_ Promote the two hard-coded constants `CHAPTER_LEAD_SILENCE_SEC = 1.5` and `CHAPTER_POST_TITLE_SILENCE_SEC = 1.5` in `server/src/tts/synthesise-chapter.ts` to a per-book setting on `state.json`. Surface in the Listen view's metadata editor (the same panel that already edits narratorCredit / genre / etc.) as a "Chapter break duration" slider with a small preset list (e.g. 0.5/1/1.5/2/3 s) for the leading + post-title legs. Generation route reads the per-book values and forwards into `synthesiseChapter` opts.
- _Benefit:_ lets the user pace chapter breaks to match book length / mood (a tight 0.5 s for a short kids' book, a longer 3 s for a slow-burn novel) without code changes. Today the 3.0 s default is "audiobook-standard" but not universally right.
_Full detail + acceptance:_ [#411](https://github.com/dudarenok-maker/Castwright/issues/411).

#### `fs-24` — Per-character pronunciation lexicon ([#478](https://github.com/dudarenok-maker/Castwright/issues/478))

- _What:_ Per-book custom pronunciation overrides for invented names/places (the TTS mangles fantasy proper nouns the most). A small lexicon (term → phonetic/respelling) applied at synth time. Net-new vs the existing chapter-title prosody handling.
- _Benefit:_ Fixes the #1 narration-quality complaint for fiction (esp. fantasy proper nouns). _Net-new from the 2026-06-02 backlog brainstorm (Listener / Reliability / Distribution / Net-new / Sharing lenses). MoSCoW `should` is a placeholder — to be re-bucketed in the upcoming whole-backlog priority pass._
_Full detail + acceptance:_ [#478](https://github.com/dudarenok-maker/Castwright/issues/478).

#### `fs-69` — Kokoro non-English support (G2P backend + non-English voice packs) ([#1302](https://github.com/dudarenok-maker/Castwright/issues/1302))

- _What:_ Give Kokoro a real non-English synthesis path: a G2P backend for target languages (`misaki[ja,zh]` + `fugashi`/`unidic`/`jieba`/`pypinyin` for CJK, `espeak-ng` language data more broadly — all currently absent from every requirements file) **and** sourcing non-English voice packs, since Kokoro's shipped voices are English-only by construction (`ENGLISH_VOICE_PREFIXES = ("af_","am_","bf_","bm_")`, `server/tts-sidecar/main.py:966`).
- _Benefit:_ Gives non-English books Kokoro's cheap, always-available fallback tier — today they only have Qwen (fail-loud) and, after fs-60, Coqui. Lowest strategic priority of the three fs-60 follow-ups given the dependency-sourcing risk.
_Full detail + acceptance:_ [#1302](https://github.com/dudarenok-maker/Castwright/issues/1302).

#### `fe-39` — Decorative hover-feedback parity for touch (group-active mirrors) ([#799](https://github.com/dudarenok-maker/Castwright/issues/799))

- _What:_ `fe-5` applied the `coarse-pointer:`/`fine-pointer:` variants only to hover patterns that **hide a functional action** (regenerate button, book-options ⋯, scrubber thumb), and deliberately left the **decorative hover-feedback** controls untouched — color/bg shifts on controls that are already visible. This item is the optional follow-up to give touch users a press-feedback equivalent (`group-active:` mirroring the existing `group-hover:`) on those decorative controls, for visual parity.
- _Benefit:_ marginal — touch users get a brief press-feedback flash on already-visible controls. Low priority precisely because the controls are already reachable; this is cosmetic parity only.
_Full detail + acceptance:_ [#799](https://github.com/dudarenok-maker/Castwright/issues/799).

#### `fs-70` — XTTS languages beyond Qwen's five (zh-cn, ja, ko, ar, hi, nl, pl, tr, cs, hu, it, pt) ([#1303](https://github.com/dudarenok-maker/Castwright/issues/1303))

- _What:_ Coqui XTTS v2 natively supports 17 languages; fs-60 (#1005) only enabled the five the analyze/attribution pipeline already fully supports (en/ru/es/fr/de, via fs-41/fs-50). This item opens the remaining XTTS-capable languages (zh-cn, ja, ko, ar, hi, nl, pl, tr, cs, hu, it, pt) as new book languages, gated to XTTS-only casting (no Qwen path, since Qwen design doesn't support them).
- _Benefit:_ Extends language reach past Qwen's five without waiting on Qwen design support for each one — XTTS becomes a real gap-filler for languages Qwen may never reach. Lowest strategic priority; large analyze-side lift for a broad language set.
_Full detail + acceptance:_ [#1303](https://github.com/dudarenok-maker/Castwright/issues/1303).

#### `fs-71` — Cross-book/cross-language voice-identity check (srv-36 extension) ([#1304](https://github.com/dudarenok-maker/Castwright/issues/1304))

- _What:_ Extend srv-36's render-integrity ECAPA pipeline (`server/src/audio/render-integrity/`) with a cross-book comparison mode: when the same character is cast on the same Coqui voice across sibling books in a series that are in *different* languages (e.g. the fs-61 per-language Coalfall demo books), pull that character's persisted centroid from the other-language book (via the existing cross-book linking machinery + `centroids-io.ts`) and compute cross-book cosine similarity against it — reusing `buildCentroid`/`cosineToCentroid`/`CUTOFFS` as-is, with one new orchestration step. Below-threshold similarity surfaces as a **non-blocking** QA flag via the existing verdict-file/badge mechanism — never blocks generation.
- _Benefit:_ Catches identity drift across a series' translated editions before an operator notices by ear; builds the comparison primitive fs-38 will need anyway. Lowest strategic priority of the three fs-60 follow-ups — no real trigger exists until a multi-language series or fs-38 lands.
_Full detail + acceptance:_ [#1304](https://github.com/dudarenok-maker/Castwright/issues/1304).

#### `fs-3` — Streaming audio for live playback during chapter generation ([#414](https://github.com/dudarenok-maker/Castwright/issues/414))

- _What:_ Change the chapter audio pipeline from "encode the full chapter, then signal complete" to "emit MP3 frames as ffmpeg produces them, signal each chunk via SSE, frontend appends to a MediaSource". Magic moment: listen as it generates.
- _Benefit:_ "listen as it generates" is the magic moment audiobook tools sell on.
_Full detail + acceptance:_ [#414](https://github.com/dudarenok-maker/Castwright/issues/414).

#### `fe-12` — Bulk pin / bulk delete in voice library ([#420](https://github.com/dudarenok-maker/Castwright/issues/420))

- _What:_ Multi-select in the voice library with bulk actions — pin/unpin and delete across the selection (with a confirm + count). Deletion respects in-use voices (warn or block when a voice is assigned to a character in any book).
- _Benefit:_ curating a large accumulated voice library stops being a per-voice click-fest.
_Full detail + acceptance:_ [#420](https://github.com/dudarenok-maker/Castwright/issues/420).

#### `fs-61` — Per-language sample books in the demo pack (Spanish Coalfall + future languages) ([#1027](https://github.com/dudarenok-maker/Castwright/issues/1027))

- _What:_ The fs-22 bundled demo pack ships **one** sample — the English _Coalfall Commission_ — with English-designed voices. A Qwen voice is calibrated in its design language (`clearMismatchedDesignedVoices` drops a designed voice whose manifest `language` ≠ the book's, to avoid cross-language garbage), so a non-English user can't get a runnable demo from the English sample. The pack should carry **a sample book per supported language**, each with its own language-matched designed voices.
- _Benefit:_ A non-English user gets a runnable, language-matched demo experience out of the box instead of only the English sample — proving the multi-language pipeline end-to-end for every supported language, not just English.
_Full detail + acceptance:_ [#1027](https://github.com/dudarenok-maker/Castwright/issues/1027).

#### `fs-6` — Batch voice-replace across all books ([#417](https://github.com/dudarenok-maker/Castwright/issues/417))

- _What:_ Add a "Replace voice everywhere" affordance in the voice library: pick a current voice, pick a replacement, see a preview of all (book, character) pairs that would be affected, confirm. Affected books' cast slices are mutated; audio is invalidated (regen prompt per book).
- _Benefit:_ cross-book voice consistency without per-book re-casting. Common need when switching a recurring narrator across a series.
_Full detail + acceptance:_ [#417](https://github.com/dudarenok-maker/Castwright/issues/417).

#### `ops-2` — Docker image + compose file for headless / Linux deployment ([#433](https://github.com/dudarenok-maker/Castwright/issues/433))

- _What:_ Add a multi-stage `Dockerfile` (frontend build → node runtime stage → sidecar Python stage) and a `docker-compose.yml` that wires the three services on `:5173 / :8080 / :9000`. Document the NVIDIA Container Toolkit GPU-passthrough prereq. Resolve whether `WORKSPACE_DIR` is bind-mounted from the host or held in a named volume (host-bind recommended — keeps per-book `.audiobook/state.json` portable across container rebuilds). Extend `release.yml` with `docker/build-push-action` to publish the image to `ghcr.io/dudarenok-maker/castwright:vX.Y.Z` on tag push.
- _Benefit:_ enables hosting on a Linux box with a GPU (home server, single-tenant VPS) — the Windows-only PowerShell orchestration is the current ceiling for that use case.
_Full detail + acceptance:_ [#433](https://github.com/dudarenok-maker/Castwright/issues/433).

#### `fe-30` — Voice-actor (multi-narrator) view ([#477](https://github.com/dudarenok-maker/Castwright/issues/477))

- _What:_ A voice-centric view that groups characters **by assigned voice** — "this voice plays N characters across M books" — with bulk reassign. The current cast view is character-centric; this is the inverse axis. Adjacent to `fe-12` (bulk library ops) and `fs-6` (batch voice-replace) but a different lens, not a duplicate.
- _Benefit:_ Manage a cast at the voice level; spot overloaded voices at a glance. _Net-new from the 2026-06-02 backlog brainstorm (Listener / Reliability / Distribution / Net-new / Sharing lenses). MoSCoW `should` is a placeholder — to be re-bucketed in the upcoming whole-backlog priority pass._
_Full detail + acceptance:_ [#477](https://github.com/dudarenok-maker/Castwright/issues/477).

#### `srv-7` — Cross-series voice linking ([#418](https://github.com/dudarenok-maker/Castwright/issues/418))

- _What:_ Plan 108's per-character engine + voice changes propagate across one series via `findAuthorSeriesForBookId`. A character who recurs across DIFFERENT series by the same author (or a shared-universe crossover) is not covered — the rebaseline / per-character write stops at the series boundary by design. Add an explicit cross-series link affordance (extend `Character.aliases` / a new link record) so a deliberate "this is the same voice across series X and Y" decision propagates voice + engine across both.
- _Benefit:_ recurring narrators / crossover characters stay consistent across an author's whole catalogue, not just within one series.
_Full detail + acceptance:_ [#418](https://github.com/dudarenok-maker/Castwright/issues/418).

#### `srv-23` — Opt-in "refresh personas + re-design voices" sweep for existing books ([#423](https://github.com/dudarenok-maker/Castwright/issues/423))

- _What:_ a per-book opt-in action that re-runs `generate-all` voice-style then re-designs every Qwen voice from the refreshed personas, so an existing book can adopt the improved format in one click. Must NOT clobber hand-edited personas without confirmation, and must surface the Gemini-quota + GPU-time cost up front.
- _Benefit:_ existing libraries can adopt the better voice-design format without re-casting by hand. Low urgency — costly (quota + GPU) and only matters for books a user wants to re-render.
_Full detail + acceptance:_ [#423](https://github.com/dudarenok-maker/Castwright/issues/423).

#### `fe-35` — Voices variant-filter toggle persists across tab switches ([#644](https://github.com/dudarenok-maker/Castwright/issues/644))

- _What:_ The All / Has variants / Needs variants toggle keeps its active state when the user switches the view tab (All / This book / Series & older). Its visibility guard also uses the *unfiltered* `qwenLibrary`, so on a tab whose tab-filtered Qwen set is empty, the toggle can render with an active "Has"/"Needs" state and no cards beneath it. The PR added a "No voices match this filter" state so the user is never stranded on a false empty screen, but the cross-tab staleness itself remains.
- _Benefit:_ the variant filter never silently carries over to a tab where it shows nothing, avoiding a confusing "active filter, empty view" state.
_Full detail + acceptance:_ [#644](https://github.com/dudarenok-maker/Castwright/issues/644).

#### `fs-36` — per-quote emotion: "manual clear sticks" sentinel (fs-33 follow-up) ([#593](https://github.com/dudarenok-maker/Castwright/issues/593))

- _What:_ Follow-up to fs-33 (#510). Today a manually *cleared* emotion is stored as `undefined` (manuscript-slice deletes the field on neutral), indistinguishable from never-set — so a re-run of Detect-emotions re-fills it. If we want a manual clear to *stick* across re-detection, store an explicit sentinel (e.g. persist `emotion: 'neutral'` instead of deleting) and have `applyDetectedEmotions` treat it as occupied.
- _Benefit:_ an intentional 'no emotion here' survives a later Detect-emotions run.
_Full detail + acceptance:_ [#593](https://github.com/dudarenok-maker/Castwright/issues/593).

#### `srv-46` — OCR ingest for scanned / image-only PDFs ([#977](https://github.com/dudarenok-maker/Castwright/issues/977))

- _What:_ Add an **OCR ingest path** for **image-only / scanned PDFs**. We already ingest text PDF / EPUB / MOBI / AZW3; this closes the scanned-PDF sliver.
- _Benefit:_ Closes the last input-format gap vs ebook2audiobook. _Source:_ triage of `brand/oss-gap-backlog-2026-06-20.md` (OSS gap analysis) · triage record: `docs/superpowers/specs/2026-06-21-oss-gap-backlog-triage-design.md` (2026-06-21).
_Full detail + acceptance:_ [#977](https://github.com/dudarenok-maker/Castwright/issues/977).

#### `fs-49` — IndexTTS-2 expressive TTS engine (decoupled per-line emotion · 8GB bet) ([#968](https://github.com/dudarenok-maker/Castwright/issues/968))

- _What:_ An **opt-in** fifth TTS engine (alongside Kokoro/Coqui/Qwen) whose verified edge is **decoupled, per-line emotional expression**: one timbre (`spk_audio_prompt`) with emotion driven **per sentence** via IndexTTS-2's **8-float `emo_vector`**, fed by our existing fs-25 per-quote `Emotion` (`neutral/whisper/angry/excited/sad`). This **collapses the pre-baked Qwen variant-voice machinery** for this engine (one timbre covers all emotions). Timbre authored via "**design in Qwen, perform in IndexTTS-2**" (capture a Qwen-VoiceDesign clip → IndexTTS-2 clone), bundled seed library as cold-start fallback. Driving emotion from the vector path (not `emo_text`) deliberately **skips the Qwen3-1.7B emotion sub-model** — the integration choice and the worst-case VRAM ceiling cut are the same decision.
- _Benefit:_ Finer **per-line emotional performance** from a single designed voice — what our variant-voice flow does expensively and Qwen-only — driven by emotion data we already detect, **potentially on the 8GB card the user already owns**. The evidenced upside over Fish is the **mechanism** (native per-line emotion); the 8GB fit, the quality-vs-Qwen win, and the license advantage are all **unverified bets**, not settled wins.
_Full detail + acceptance:_ [#968](https://github.com/dudarenok-maker/Castwright/issues/968).

#### `fs-48` — Fish Audio S2-Pro TTS engine (16GB premium-quality tier · parked) ([#964](https://github.com/dudarenok-maker/Castwright/issues/964))

- _What:_ Add **Fish Audio S2-Pro** as a fourth, **opt-in** TTS engine alongside Kokoro / Coqui / Qwen, for quality-chasing users on **16GB consumer GPUs**. S2-Pro is a ~4.4B-param zero-shot clone model (Dual-AR) with free-form inline tone tags and ~80-language coverage. **16GB via BNB NF4 4-bit** is the target path (FP8 is really a ~20GB path; GGUF/s2.cpp fits but runs at RTF≈3 — too slow for audiobooks). 24GB/full precision is the fallback. **Integration:** prefer reusing the existing sidecar PyTorch/CUDA stack **in-process** (NF4 via `bitsandbytes` is pure torch, per the `groxaxo/fish-speech-int4-patch` + ComfyUI nodes); an out-of-process HTTP child is the documented fallback. A hardware-gated **Task-0 spike** decides which. **Voice model:** Qwen-style per-character bespoke-voice lifecycle, but clone-from-seed — needs a bundled **age×gender seed-reference library** (child/teenager/young-adult/adult/elderly × male/female/neutral), synthetic/consented audio only.
- _Benefit:_ Premium-quality, expressive, multilingual voices on a **mainstream 16GB consumer GPU** — bringing the best-quality engine within reach of quality-chasers who don't have a 24GB card.
_Full detail + acceptance:_ [#964](https://github.com/dudarenok-maker/Castwright/issues/964).

#### `side-18` — Engine-native bracket cues (laughs)/(sighs) — non-Qwen sibling of fs-57, depends on fs-48/fs-49 ([#979](https://github.com/dudarenok-maker/Castwright/issues/979))

- _What:_ A **scripted nonverbal-cue layer** — `(laughs)` / `(sighs)` / breaths — model-native in Orpheus / Dia / Chatterbox. **Spike before committing an engine.**
- _Benefit:_ Extends the expressive performance lead beyond emotion sliders. _Source:_ triage of `brand/oss-gap-backlog-2026-06-20.md` (OSS gap analysis) · triage record: `docs/superpowers/specs/2026-06-21-oss-gap-backlog-triage-design.md` (2026-06-21).
_Full detail + acceptance:_ [#979](https://github.com/dudarenok-maker/Castwright/issues/979).

#### `srv-30` — CPU-only analyzer device (large RAM-resident model, concurrent with GPU TTS) ([#507](https://github.com/dudarenok-maker/Castwright/issues/507))

- _What:_ Add a CPU-only analyzer device option: run the analysis LLM on a large RAM-resident model on the CPU, freeing the GPU entirely for concurrent TTS synthesis. Today the analyzer and TTS engines compete for the same GPU VRAM budget; a CPU-resident analyzer removes that contention for users with enough system RAM to spare.
- _Benefit:_ Removes GPU contention between analysis and TTS on boxes with spare system RAM, letting a book generate faster end-to-end when the analyzer doesn't need to fight the TTS engine for VRAM.
_Full detail + acceptance:_ [#507](https://github.com/dudarenok-maker/Castwright/issues/507).

#### `fs-5` — Multi-step rollback / snapshot-per-entry (revision history) ([#415](https://github.com/dudarenok-maker/Castwright/issues/415))

- _What:_ Extend plan 20's `preserveExistingAsPrevious` to write `.previous.<entryId>.<slug>.mp3` per timeline entry (not just one `.previous.<slug>.mp3` per chapter). Wire a server `POST /api/books/:bookId/revisions/:entryId/rollback` endpoint that restores a specific timeline entry's audio + flips subsequent entries to `rolled-back-from`. Add a GC pass that prunes oldest snapshots after the user commits (or when disk pressure exceeds a cap, e.g. 10 entries / chapter).
- _Benefit:_ closes the centerpiece feature from plan 55 — true non-linear undo per chapter. Today the timeline modal is read-only; the user has to walk through accept/reject in the A/B player.
_Full detail + acceptance:_ [#415](https://github.com/dudarenok-maker/Castwright/issues/415).

#### `fs-28` — Voice export/import bundle (sharing foundation) ([#482](https://github.com/dudarenok-maker/Castwright/issues/482))

- _What:_ Export a designed voice — embedding `.pt` + persona + metadata + provenance — as one portable bundle, and import it into another install's library. This is the base format every other sharing item (fs-29, fs-30, fs-31) builds on. **Import must go through the safe-load layer (`side-13`)** — never raw-unpickle an untrusted `.pt`.
- _Benefit:_ Share a great character voice + back up the most expensive asset (designed voices). _Depends on: side-13 (import safety). Blocks: fs-29, fs-30, fs-31._ _Net-new from the 2026-06-02 backlog brainstorm (Listener / Reliability / Distribution / Net-new / Sharing lenses). MoSCoW `should` is a placeholder — to be re-bucketed in the upcoming whole-backlog priority pass._
_Full detail + acceptance:_ [#482](https://github.com/dudarenok-maker/Castwright/issues/482).

#### `fs-29` — Cast/profile pack sharing ([#483](https://github.com/dudarenok-maker/Castwright/issues/483))

- _What:_ Export a book's full cast (character personas + voice assignments) as a shareable pack; import it to seed a new book or apply on a re-read. Builds on the fs-28 voice bundle format and ties into `srv-1` (merge journal) + the cross-book reuse machinery.
- _Benefit:_ Reuse a curated cast; hand a friend your exact setup for a book. _Depends on: fs-28 (+ side-13)._ _Net-new from the 2026-06-02 backlog brainstorm (Listener / Reliability / Distribution / Net-new / Sharing lenses). MoSCoW `should` is a placeholder — to be re-bucketed in the upcoming whole-backlog priority pass._
_Full detail + acceptance:_ [#483](https://github.com/dudarenok-maker/Castwright/issues/483).

#### `fs-30` — Whole voice-library export/import ([#484](https://github.com/dudarenok-maker/Castwright/issues/484))

- _What:_ Bulk export the entire voice library (all designed voices + metadata) as one archive for backup, migration to a new machine, or wholesale sharing — and import it back. Complements `srv-2` (auto-backup) and `fs-1` (upgrade/migration); built on the fs-28 per-voice bundle.
- _Benefit:_ Portability + disaster recovery for the most expensive asset in the app. _Depends on: fs-28 (+ side-13)._ _Net-new from the 2026-06-02 backlog brainstorm (Listener / Reliability / Distribution / Net-new / Sharing lenses). MoSCoW `should` is a placeholder — to be re-bucketed in the upcoming whole-backlog priority pass._
_Full detail + acceptance:_ [#484](https://github.com/dudarenok-maker/Castwright/issues/484).

#### `fs-31` — Community voice registry / share-by-link ([#486](https://github.com/dudarenok-maker/Castwright/issues/486))

- _What:_ Publish a designed voice to a shared location and let others pull it by link/code — the flagship "community library" version of the sharing theme. Requires a hosting story the local-first app doesn't have yet, plus a licensing/consent/abuse policy, and the `side-13` safe-load layer as a hard prerequisite.
- _Benefit:_ A community library — the most ambitious expression of voice sharing. _The only item here that publishes data externally — treat as its own initiative AFTER fs-28 + side-13 (and ideally fs-29/30) land. Owes a regression plan + a privacy/licensing/abuse design._ _Net-new from the 2026-06-02 backlog brainstorm (Listener / Reliability / Distribution / Net-new / Sharing lenses). MoSCoW `should` is a placeholder — to be re-bucketed in the upcoming whole-backlog priority pass._
_Full detail + acceptance:_ [#486](https://github.com/dudarenok-maker/Castwright/issues/486).

#### `side-12` — Load Qwen voice `.pt` prompts with `weights_only=True` (or a safe format) ([#428](https://github.com/dudarenok-maker/Castwright/issues/428))

- _What:_ switch the voice-prompt load to `weights_only=True`; if the saved payload isn't a pure tensor/state-dict, migrate the design-time save (`design_voice`) to a safe container (safetensors, or JSON sidecar + tensors) so the load no longer needs arbitrary unpickling. One-time read-compat shim for already-cached `.pt` files (re-derive or one-shot re-save).
- _Benefit:_ removes a local RCE-on-untrusted-file footgun; aligns with torch's `weights_only` default direction.
_Full detail + acceptance:_ [#428](https://github.com/dudarenok-maker/Castwright/issues/428).

#### `fs-42` — Advanced Settings: export/import config as JSON + env-diff view ([#668](https://github.com/dudarenok-maker/Castwright/issues/668))

- _What:_ The `#/advanced` config surface (plan 199) is shipped, but two power-user follow-ups remain: 1. **Export config as JSON** — a "Download config.json" button that lets a user back up or share their knob overrides. 2. **Import config from JSON** — a complementary "Import" flow that validates the payload against the live descriptor list before applying. 3. **Env-diff view** — a side-by-side "what your .env says vs. what the UI override says" diff panel so users can decide whether to move their .env override into the UI or vice versa.
- _Benefit:_ **User:** power users can snapshot and restore their tuning profile across machines or reinstall without re-entering values manually. **Technical:** validates that the descriptor schema is stable enough to round-trip through JSON. **Architectural:** the export format becomes a natural migration target if server-side config shapes change in future. _Full detail + acceptance:_ plan `docs/features/199-advanced-settings.md`.
_Full detail + acceptance:_ [#668](https://github.com/dudarenok-maker/Castwright/issues/668).

#### `fe-1` — In-app LAN HTTPS banner under dev settings ([#401](https://github.com/dudarenok-maker/Castwright/issues/401))

- _What:_ Account settings card showing the current LAN HTTPS URL (from `GET /api/export/lan` when LAN_HTTPS=1) with one-click "Copy URL" + "Install cert on phone" links. The latter opens a doc / route that shows the QR code that `npm run install:cert-mobile` prints to the terminal today. Dev-mode only — hidden in production single-user environments.
- _Benefit:_ surfaces the LAN access flow inside the app instead of requiring the user to read terminal output. Especially valuable for users who first installed via the alpha release zip (no terminal interaction expected).
_Full detail + acceptance:_ [#401](https://github.com/dudarenok-maker/Castwright/issues/401).

#### `ops-21` — Robust per-interface / multi-address mDNS answers for friendly LAN hostnames ([#1239](https://github.com/dudarenok-maker/Castwright/issues/1239))

- _What:_ Replace the single "OS default-route interface" heuristic the `castwright.local`/`castwright.dev.local` mDNS responder uses (see `docs/superpowers/specs/2026-07-03-castwright-local-hostnames-design.md`, Component 1) with a more robust answer strategy — either answering per the interface the query actually arrived on, or returning multiple candidate LAN addresses and letting the client's own connection-retry behavior (the repo's `vite.config.ts` already documents hitting an analogous Happy-Eyeballs-style multi-address tradeoff) sort out which one is reachable.
- _Benefit:_ **Technical/architectural** — closes a known, adversarial-review-identified gap (three rounds of `assumption-checker` review on the base spec flagged that the v1 "primary LAN IP" heuristic is a best-effort default, not a guarantee, under VPN or dual-homed LAN setups) without blocking the base feature's ship, which already degrades gracefully to the existing LAN-IP URL in the meantime.
_Full detail + acceptance:_ [#1239](https://github.com/dudarenok-maker/Castwright/issues/1239).

#### `ops-9` — Enable server-side branch protection on `main` (when Pro/public) ([#429](https://github.com/dudarenok-maker/Castwright/issues/429))

- _What:_ create an active ruleset on the default branch blocking deletion + non-fast-forward (force) pushes. Ready command:
- _Benefit:_ server-side enforcement that no `--no-verify` local bypass or fresh clone can sidestep; the local guard (plan 163) becomes belt-and-suspenders. Required status checks deliberately excluded (would deadlock doc-only PRs that skip `verify.yml`).
_Full detail + acceptance:_ [#429](https://github.com/dudarenok-maker/Castwright/issues/429).

#### `fs-72` — VRAM MB-accounting policy + two-model-split UI (Wave 4 — beta 12/16GB cards) ([#845](https://github.com/dudarenok-maker/Castwright/issues/845))

- _What:_ Wave 1 already gives 12/16GB cards coexistence via the gpu.safeCoexistMb threshold (a roomy card doesn't evict). Wave 4 refines this for beta testers who run better cards than the 8GB dev box: (1) per-(engine,mode) MB cost table vs detected VRAM (non-additive Qwen synth/design modes) so a 12GB card with a heavy combo that passes the coarse threshold but would overcommit is caught; (2) two-model analysis-split warn+confirm UI when phase0/phase1 use two different local models that won't co-fit. Design: docs/superpowers/specs/2026-06-16-vram-budget-aware-gpu-policy-design.md §7; context in docs/features/222.
- _Benefit:_ Beta testers on 12/16GB cards get accurate overcommit protection (not just the coarse 8GB-dev-box threshold) and a clear warning instead of a silent OOM when two local models cannot co-fit during analysis.
_Full detail + acceptance:_ [#845](https://github.com/dudarenok-maker/Castwright/issues/845).

#### `ops-26` — LAN public cert broker (mkcert-based, per-device trust) ([#1333](https://github.com/dudarenok-maker/Castwright/issues/1333))

- _What:_ A broker service to streamline LAN HTTPS trust distribution for mobile/tablet devices — designed but not implemented yet.
- _Benefit:_ Removes the current per-device manual root-CA install friction for the mobile testing protocol (plan 81), making LAN HTTPS setup a one-step flow instead of a per-OS manual walkthrough.
_Full detail + acceptance:_ [#1333](https://github.com/dudarenok-maker/Castwright/issues/1333).

#### `fs-73` — Cast Pass (multi-book cast consistency pass) ([#1334](https://github.com/dudarenok-maker/Castwright/issues/1334))

- _What:_ Cast Pass work — a multi-book cast-consistency effort that was parked pending the voiceUuid migration. That migration has since merged, so this may now be unblocked; verify before resuming.
- _Benefit:_ Unblocks a parked multi-book cast-consistency initiative once confirmed ready.
_Full detail + acceptance:_ [#1334](https://github.com/dudarenok-maker/Castwright/issues/1334).

## Won't (this round) — explicitly parked

- `side-11` — Eliminate the variable-input-shape host-memory leak (so recycling isn't needed) ([#399](https://github.com/dudarenok-maker/Castwright/issues/399)).

- `ops-5` — Trim `build` / `e2e` out of the per-PR `verify.yml` ([#437](https://github.com/dudarenok-maker/Castwright/issues/437)).

- `side-4` — A/B Qwen `x_vector_only_mode=True` (speed vs. fidelity) ([#438](https://github.com/dudarenok-maker/Castwright/issues/438)).

- `side-7` — Qwen decode CUDA-graph / static-cache spike (probe-gated) ([#439](https://github.com/dudarenok-maker/Castwright/issues/439)).

- `side-10` — Coalesce consecutive same-speaker short lines before batching ([#440](https://github.com/dudarenok-maker/Castwright/issues/440)).

- `srv-8` — Multi-model fan-out for Gemini analyzer ([#442](https://github.com/dudarenok-maker/Castwright/issues/442)).

- `fe-11` — Multi-tab catch-up race resilience ([#443](https://github.com/dudarenok-maker/Castwright/issues/443)).

- `fe-13` — Live `VITE_USE_MOCKS` toggle in running UI ([#444](https://github.com/dudarenok-maker/Castwright/issues/444)).

- `srv-10` — Conflict resolution for two simultaneous `state.json` writers ([#445](https://github.com/dudarenok-maker/Castwright/issues/445)).

- `srv-5` — Tune per-engine VRAM cost map against real hardware ([#447](https://github.com/dudarenok-maker/Castwright/issues/447)).

- `side-16` — Kokoro on DirectML (AMD-Windows GPU acceleration for Kokoro) ([#819](https://github.com/dudarenok-maker/Castwright/issues/819)).

## Retired numbering

The old per-bucket `Could #N` / `Should #N` numbering was retired on
2026-05-25 in favour of the permanent `<prefix>-<n>` IDs above (it renumbered
on every ship, so external references rotted). Any code comment or plan doc
still citing a bare `Could/Should/Must #N` is either (a) a stale
pre-2026-05-25 reference — resolve it by matching the comment's described
feature to an item above or to its shipping plan — or (b) **plan-internal**
numbering of the form `plan <NN> Should #M`, which is frozen and correct.
Don't reintroduce bare-number backlog references.

