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

---

## Must — the beta → full-product spine (marketability & discoverability)

_Reframed 2026-06-21 (triage record: [`docs/superpowers/specs/2026-06-21-oss-gap-backlog-triage-design.md`](superpowers/specs/2026-06-21-oss-gap-backlog-triage-design.md))._
Must no longer means "blocks v1 ship or hurts existing beta users" — it now means
**what moves Castwright from beta to a sellable full product**: the moats made
visible/provable, the parity that wins comparison shoppers, and the
adoption-friction removers that widen the funnel. Ranked top = highest priority;
within each sub-group, ship-now-unblocked work leads.

### Differentiation — the moats, made marketable

#### `fs-51` — Per-book performance-QA report ([#973](https://github.com/dudarenok-maker/Castwright/issues/973))

- _What:_ Turn the existing acoustic + ASR + drift gate into a visible, exportable per-book QA summary ("N lines re-recorded, M transcript-verified, 0 drift"). Aggregates signals the pipeline already produces.
- _Benefit (user / strategic):_ **proof, not promises** — epub2tts now does ASR-matching; a legible acoustic+ASR+drift report defends the QA moat. _Depends on `srv-36` (drift calibration) for trustworthy drift figures._
_Full detail + acceptance:_ [#973](https://github.com/dudarenok-maker/Castwright/issues/973).

#### `fs-38` — Voices library: standalone voice authoring + voice cloning (designed & cloned) ([#624](https://github.com/dudarenok-maker/AudioBook-Generator/issues/624))

- _What:_ A first-class `#/voices` library that authors **both designed and cloned** standalone voices, not tied to a single character — the **next big release**. Two axes share one library + tagging + pinning + assignment surface, kept distinct by a cloned-vs-designed provenance split: **(a) Standalone authoring** (folds in former `fs-12`, [#419](https://github.com/dudarenok-maker/AudioBook-Generator/issues/419)) — design a voice from a persona or a reference clip on top of the per-character Qwen design flow (plan 108), name + tag + pin it, reuse it across books, with optional fine-tuning of an already-designed voice. **(b) Voice cloning** (former `fs-38`) — clone a real person's voice from a short in-app sample (XTTS reference first, then Qwen design-to-target) and cast it like any other voice, held consistent across a book/series; explicit consent on the record, cloned voices excluded from the cross-book reuse matcher, local-only.
- _Benefit (user):_ build a personal stable of named narrators — designed _or_ in your own / a family voice — to cast across the whole catalogue. The most personal, gift-able feature (a bedtime story in your own voice, or your kid as the hero); pays off the _"even in your own voice"_ promise. Pairs with `fe-12` (bulk library ops).
_Full detail + acceptance:_ plan [`194-voice-cloning.md`](features/194-voice-cloning.md) · [#624](https://github.com/dudarenok-maker/AudioBook-Generator/issues/624) (folds in `fs-12` [#419](https://github.com/dudarenok-maker/AudioBook-Generator/issues/419)).

### Reach & perception — win the comparison

#### `fs-59` — CJK (Chinese/Japanese) language support ([#1004](https://github.com/dudarenok-maker/Castwright/issues/1004))

- _What:_ ZH/JA end-to-end — the deferred CJK follow-on to `fs-50`. Needs its own foundations: a server-side word segmenter (`Intl.Segmenter`/jieba/fugashi), CJK quote handling (「」), a CJK token divisor, per-language prompt examples, and fluent ZH/JA labelers for the attribution gate.
- _Benefit (user / strategic):_ the two highest-population CJK languages — breadth Latin alone can't reach. Deferred until the `fs-50` Latin framework lands.
_Full detail + acceptance:_ [#1004](https://github.com/dudarenok-maker/Castwright/issues/1004).

#### `fs-60` — Kokoro/XTTS per-language engine eligibility (gap-fill beyond Qwen) ([#1005](https://github.com/dudarenok-maker/Castwright/issues/1005))

- _What:_ Let non-English books use Kokoro-native / Coqui-XTTS voices instead of forced Qwen — the gap-fill tail. Owns the Kokoro non-English G2P deps, per-language default voices, the 3-engine VRAM constraint, Coqui per-synth language threading, and a cross-language voice-identity check (srv-36 ECAPA).
- _Benefit (user / strategic):_ languages + voice variety beyond Qwen's reach; same engine choice for non-English books. Lowest strategic priority.
_Full detail + acceptance:_ [#1005](https://github.com/dudarenok-maker/Castwright/issues/1005).

#### `fs-61` — Per-language sample books in the demo pack ([#1027](https://github.com/dudarenok-maker/Castwright/issues/1027))

- _What:_ The `fs-22` demo pack ships one English Coalfall sample with English-designed voices. Because Qwen voice designs are **per-language** (a voice baked for one language is cleared on a book in another), a non-English user can't run the English sample's voices. Ship **a sample book per supported language** — each with its own language-matched designed voices (Spanish translation already at `samples/the-coalfall-commission/manuscript.es.md`) — wired into the bundle/zip pipeline, plus a convention so each new supported language adds its sample.
- _Benefit (user / strategic):_ a non-English user gets a generate-able demo in their own language out of the box, not a dead English-voiced sample. Surfaced by the `fs-50` Spanish ship.
_Full detail + acceptance:_ [#1027](https://github.com/dudarenok-maker/Castwright/issues/1027).

#### `fs-63` — auto-voice a created off-roster character (fs-58 Unit B follow-up) ([#1119](https://github.com/dudarenok-maker/Castwright/issues/1119))

- _What:_ An off-roster `reattribute` mints a new cast member (operator-confirmed `CreateCharacterForm` → `POST /cast/create`) that lands voice-unassigned and is silent until manually voiced in the Cast view. Auto-assign/design a voice for a character created through the reattribute confirm flow.
- _Benefit (user):_ off-roster reattribute becomes audible in one pass, not two.
_Full detail + acceptance:_ [#1119](https://github.com/dudarenok-maker/Castwright/issues/1119).

#### `fs-64` — cross-chapter context for reattribute (fs-58 Unit B follow-up) ([#1120](https://github.com/dudarenok-maker/Castwright/issues/1120))

- _What:_ `reattribute` runs per-chapter, so a chapter-opening tagless line whose speaker was set by the previous chapter's last turn can mis-resolve. Feed the prior chapter's tail into the review prompt so straddling turn-taking resolves. Weigh against RPD cost.
- _Benefit (technical):_ closes the per-chapter straddle limitation in the Unit B spec.
_Full detail + acceptance:_ [#1120](https://github.com/dudarenok-maker/Castwright/issues/1120).

#### `fs-52` — Caption/SRT export (.srt/.vtt; line/sentence/word) ([#975](https://github.com/dudarenok-maker/Castwright/issues/975))

- _What:_ Emit `.srt`/`.vtt` (line + sentence + word modes) from the per-sentence alignment we already compute.
- _Benefit (user / strategic):_ a rival's **headline feature**, near-free for us; also **feeds demo/social clips** (an awareness lever, not just parity).
_Full detail + acceptance:_ [#975](https://github.com/dudarenok-maker/Castwright/issues/975).

_`fs-2` (multi-language, Russian first) shipped — the engine half via
[plan 108](features/108-qwen-coexistence.md), the language half via
[plan 162](features/162-fs2-multilanguage.md); the library/cast language UX
polish (`fe-16`) shipped via [plan 165](features/165-fe-15-16-language-and-revision-e2e.md).
`fs-50` extends that framework to ES/FR/DE (the Latin Qwen tranche, folding in
`fs-41`); CJK (ZH/JA) is split to `fs-59` and the Kokoro/XTTS engine relaxation to
`fs-60`; the remaining deferred follow-up is `fs-14` (Russian UI localization, now
under Should → Ingest & languages)._

### Adoption — widen the funnel (ship-now first)

_Adoption-friction items (the onboarding & install cluster was promoted to Must on
2026-06-08 — first-run friction is the biggest adoption blocker for non-technical
deployers). `ops-2` leads because it's the only one with **no licensing/cert
dependency**; `ops-1`/`ops-15`/`app-12` wait on cert + Apple-account procurement
(the long pole, tracked privately)._

#### `ops-2` — Docker image + compose file for headless / Linux deployment ([#433](https://github.com/dudarenok-maker/AudioBook-Generator/issues/433))

- _What:_ Add a multi-stage `Dockerfile` (frontend build → node runtime stage → sidecar Python stage) and a `docker-compose.yml` that wires the three services on `:5173 / :8080 / :9000`. Document the NVIDIA Container Toolkit GPU-passthrough prereq. Resolve whether `WORKSPACE_DIR` is bind-mounted from the host or held in a named volume (host-bind recommended — keeps per-book `.audiobook/state.json` portable across container rebuilds). Extend `release.yml` with `docker/build-push-action` to publish the image to `ghcr.io/dudarenok-maker/castwright:vX.Y.Z` on tag push.
- _First-run setup (consistency with `ops-1`/`ops-15`):_ a headless/Docker deploy still serves the web UI, so first-run setup + model install flow through the same `fs-21` wizard (at `:5173`) — no Linux-specific install script. **Mount a persistent volume for the model dirs** (Kokoro/Qwen weights + the Ollama store) so wizard-installed models survive container rebuilds.
- _Benefit (user):_ enables hosting on a Linux box with a GPU (home server, single-tenant VPS) — the Windows-only PowerShell orchestration is the current ceiling for that use case. Linux is the third primary deployer platform alongside Windows (`ops-1`) and macOS (`ops-15`).
- _Companion coherence (plan 188):_ if the companion is used against a Dockerised server, (a) **mount a persistent volume for the mkcert CA** (`mkcert -CAROOT` dir) so the pinned `caFingerprint` survives container rebuilds (else every update forces a re-pair), and (b) honour a **`LAN_HOST` override** in `enumerateLanUrls` (`export-lan.ts` reads `os.networkInterfaces()` → container bridge IPs like `172.18.0.x`) so the pairing QR carries the host's real LAN IP.
_Full detail + acceptance:_ [#433](https://github.com/dudarenok-maker/AudioBook-Generator/issues/433).

#### `ops-1` — Windows installer (Inno Setup or NSIS) wrapping the release zip ([#432](https://github.com/dudarenok-maker/AudioBook-Generator/issues/432))

- _What:_ Add an Inno Setup (or NSIS) script that wraps the `castwright-vX.Y.Z.zip` produced by the release-package pipeline (plan 49) into a signed `.exe` installer. Installer extracts to `%LocalAppData%\Castwright`, drops a Start Menu entry, checks the **runtime** prereqs (Node 20.6+, Python 3.11, ffmpeg on PATH) with download links for any missing dep, then launches the app. **Model install + smoke test are owned by the `fs-21` first-run wizard** (shared with macOS `ops-15`), not the installer — so the platforms stay consistent. Extend `release.yml` with a follow-on job that builds the installer (on a Windows runner) and uploads it as a second release asset.
- _Signing:_ the installer **must be code-signed** (wire `signtool` into the `release.yml` job; an **OV** certificate is sufficient — Microsoft dropped EV's SmartScreen advantage in Aug 2024). An unsigned installer trips the full-screen SmartScreen / Smart App Control "protected your PC" wall — a major funnel-killer for exactly the non-technical user the installer targets; reputation accrues to the cert as download volume grows. _(Cert procurement is tracked privately.)_
- _Benefit (user):_ friction-free install for non-developers. Today's plan-49 deployer must read INSTALL.md and run PowerShell commands by hand; the installer reduces that to a click.
_Full detail + acceptance:_ [#432](https://github.com/dudarenok-maker/AudioBook-Generator/issues/432).

#### `ops-15` — macOS installer (`.dmg`) wrapping the release zip ([#735](https://github.com/dudarenok-maker/Castwright/issues/735))

- _What:_ Wrap the `castwright-vX.Y.Z.zip` (plan 49) into a **signed, notarized `.dmg`** — a drag-to-`/Applications` disk image (the Mac-native idiom). The bundle delivers the app + a launcher (`.app` wrapping `start.sh`); it embeds **no** model-install script. All app-level setup — GPU detect, model install (Kokoro/Qwen/Ollama analyzer), defaults, smoke synth — is owned by the shared `fs-21` first-run wizard, identical to Windows (`ops-1`). The installer only handles the app + runtime prereqs (Node/Python/ffmpeg, bundled or checked). Extend `release.yml` with a follow-on job that builds, **signs + notarizes** the `.dmg` on a **macOS runner** and uploads it as a release asset (notarization itself is free, but the notary service only accepts uploads from a paid account — so the notarized half can't ship until the Developer account exists). Builds on the shipped cross-platform launch groundwork (`start.sh`, cross-platform sidecar spawn).
- _Depends on:_ a paid **Apple Developer account** (~$99/yr) + a Developer ID Application cert for signing/notarization — external prerequisite that blocks the notarized half (Gatekeeper **hard-blocks** unnotarized internet-downloaded apps on Apple Silicon — not a click-through); unsigned `.dmg` mechanics can be built ahead of that. The same membership is the only iOS distribution path (`app-12`). _(Account procurement is tracked privately.)_
- _Benefit (user):_ friction-free install for non-developer Mac users — the other primary deployer platform alongside Windows. Reduces a read-INSTALL.md-and-run-shell-commands bootstrap to drag-and-drop.
_Full detail + acceptance:_ [#735](https://github.com/dudarenok-maker/Castwright/issues/735).

_The Android companion shipped (plan 188); the deep-link pairing flip (`app-17`)
shipped + was on-device-accepted 2026-06-19 (#729 closed) — the remaining
launch-blocking gap is the iOS half of the mobile audience._

#### `app-12` — iOS build + release of the companion app ([#555](https://github.com/dudarenok-maker/AudioBook-Generator/issues/555))

- _What:_ Build + release the Flutter companion on iOS. The codebase stays iOS-ready by construction (app-managed TLS trust, dual-platform Flutter plugins, an unsigned iOS CI compile from `app-1`), so this is incremental, not a rewrite. _Codec caveat:_ iOS `AVPlayer` can't play `.ogg` — for iOS the server must render MP3/M4A (OGG is Android-only); the app reads the format from the manifest and surfaces it.
- _Benefit (user):_ brings the companion to iPhone/iPad listeners — the other half of the mobile audience.
- _CI note (2026-06-14):_ the per-release unsigned `companion-ios` build was removed from `release.yml` (saved ~80–120 macOS-billed min/tag; `app.yml`'s `ios-compile` still guards build health). This item should add a **signed** `.ipa` release job when it lands — weighing whether it's worth the macOS minutes on every tag vs. an occasional manual build.
_Full detail + acceptance:_ [#555](https://github.com/dudarenok-maker/AudioBook-Generator/issues/555) · [plan 188](features/188-android-companion-app.md).

---

## Should — important, not blocking ship

Ranked top = highest priority. Ingest & languages leads (it amplifies the Must
language push), then the agent surface (`fs-44` — a latent moat no rival ships),
then voice/cast quality, listener magic, QA credibility, ops/maintenance, and the
blocked companion follow-up.

### Ingest & languages

#### `fs-41` — Auto-detect manuscript language on ingest — **folded into `fs-50`** ([#666](https://github.com/dudarenok-maker/AudioBook-Generator/issues/666))

- _Folded:_ the detect + auto-load halves shipped via `fs-2`/`fe-16`; the remaining voice-library language filtering is now part of the `fs-50` Latin-Qwen initiative spec (§6, `docs/superpowers/specs/2026-06-22-fs41-fs50-language-aware-ingest-and-breadth-design.md`). Tracked there; row kept for ID continuity. _Detail:_ [#666](https://github.com/dudarenok-maker/AudioBook-Generator/issues/666).

#### `fs-14` — Russian UI localization (interface strings, react-i18next) ([#396](https://github.com/dudarenok-maker/AudioBook-Generator/issues/396))

- _What:_ Localize the application interface to Russian. Stand up an i18n framework (**react-i18next** — user-confirmed choice) + a per-user `UserSettings.uiLanguage` preference with a language switcher in Account management, then translate the high-traffic surfaces first (top nav, account, upload/confirm, listen, cast) and grow coverage incrementally. Ground truth at capture: **no i18n library today**, ~1,500 hardcoded user-facing strings across ~82 components (densest: `account.tsx` ~92, `profile-drawer.tsx` ~79, `voices.tsx` ~68, `analysing.tsx` ~59, `cast.tsx` ~58, `export-audiobook.tsx` ~52). Centralisable copy already lives in `src/data/{walkthroughs,analysis-phases,regen-reasons,match-factors,listener-apps}.ts`. Locale-sensitive formatting is minimal (`src/lib/time.ts` durations only; no currency/date pickers).
- _Benefit (user / architectural):_ a fully Russian-speaking user gets a Russian app, not just Russian audio. The i18n framework makes every future language an incremental translation-file add rather than a code change. Pairs with fs-2 to make Russian a first-class end-to-end experience. (Large; ranked below the smaller wins.)
_Full detail + acceptance:_ [#396](https://github.com/dudarenok-maker/AudioBook-Generator/issues/396).

### Agents & integrations

#### `fs-44` — MCP agent surface (agents drive Castwright end-to-end) ([#721](https://github.com/dudarenok-maker/Castwright/issues/721))

- _What:_ An MCP server surface so any MCP-capable agent — Claude Cowork/Code, **Codex, Copilot CLI, Gemini CLI, Cursor**, whatever harness the user lives in — drives the full pipeline (upload → analyze → cast → generate → export) programmatically instead of computer-use clicking. In-process Streamable-HTTP endpoint at `/mcp` behind the existing `requireLanToken` guard, ~15 hand-designed workflow-level tools (read/inspect, pipeline actions, cast/voice parity, `wait_for_job` long-poll over the existing job state); core-spec MCP only (client-agnostic); `castwright-mcp` stdio bridge included in the main delivery (wave 4) so stdio-only harnesses work out of the box. Spec: [`2026-06-11-castwright-mcp-agent-surface-design.md`](superpowers/specs/2026-06-11-castwright-mcp-agent-surface-design.md) · plan: [`2026-06-11-fs44-mcp-agent-surface.md`](superpowers/plans/2026-06-11-fs44-mcp-agent-surface.md).
- _Benefit (user / strategic):_ "produce this book overnight and tell me when it's exported" becomes a one-line agent prompt; aligns Castwright with the agent-first direction of every major harness, and the MCP pipeline e2e doubles as the missing whole-pipeline integration test. **Latent moat — agent-driven generation is not something rivals ship; prime Should→Must candidate next round (2026-06-21).**
_Full detail + acceptance:_ [#721](https://github.com/dudarenok-maker/Castwright/issues/721).

_(fs-15 + fs-16 shipped — cross-book "Continue listening" rail + `#/stats` dashboard; see [plan 212](features/212-fs15-fs16-listening-stats.md). Companion reporter = Wave H follow-up.)_

### Voice & cast

#### `fs-24` — Per-character pronunciation lexicon ([#478](https://github.com/dudarenok-maker/AudioBook-Generator/issues/478))

- _What:_ Per-book custom pronunciation overrides for invented names/places (term → phonetic/respelling), applied at synth time. Fiction — especially fantasy proper nouns — is where the TTS mangles the most. Net-new vs the existing chapter-title prosody handling.
- _Benefit (user):_ fixes the #1 narration-quality complaint for fiction. _(Re-promoted Could → Should 2026-06-21 — quality is marketability.)_
_Full detail + acceptance:_ [#478](https://github.com/dudarenok-maker/AudioBook-Generator/issues/478).

#### `fe-7` — Per-voice row sample-preview button inside `<VoiceOverridePicker>` ([#416](https://github.com/dudarenok-maker/AudioBook-Generator/issues/416))

- _What:_ Add a per-row Play button that routes through `playSampleWithAutoLoad` (same helper the existing "Preview voice" / cast-row swatch use). Hover/focus reveals the icon on pointer devices; `coarse-pointer:opacity-60` keeps it faintly visible on touch. Sample text comes from the same drawer-level `previewText` the candidate-preview block uses. Single-row in-flight gate (the helper already coalesces concurrent clicks).
- _Benefit (user):_ shortens the "scrolled past 40 Kokoro voices, want to hear three before committing" flow from "pick → close → preview from drawer → pick another" to "▶ in-row, ▶ in-row, pick the one I like." Pairs with the autocomplete added in this bundle — search narrows the list, in-row preview judges the few remaining options.
_Full detail + acceptance:_ [#416](https://github.com/dudarenok-maker/AudioBook-Generator/issues/416).

#### `fs-35` — per-chapter Detect-emotions trigger (fs-33 follow-up) ([#592](https://github.com/dudarenok-maker/AudioBook-Generator/issues/592))

- _What:_ Add a per-chapter "Detect emotions" option (the emotion-only backfill pass scoped to the current chapter) alongside the whole-book trigger. The fs-33 v1 shipped whole-book only.
- _Benefit (user):_ cheap targeted re-detect for one edited/late-added chapter without re-running the whole book's quota.
_Full detail + acceptance:_ [#592](https://github.com/dudarenok-maker/AudioBook-Generator/issues/592).

### Listener experience & playback

#### `fs-3` — Streaming audio for live playback during chapter generation ([#414](https://github.com/dudarenok-maker/AudioBook-Generator/issues/414))

- _What:_ Change the chapter audio pipeline from "encode the full chapter, then signal complete" to "emit MP3 frames as ffmpeg produces them, signal each chunk via SSE, frontend appends to a MediaSource". Magic moment: listen as it generates.
- _Benefit (user):_ "listen as it generates" is the magic moment audiobook tools sell on. _(Promoted Could → Should 2026-06-21 — a demo/marketing centerpiece.)_
_Full detail + acceptance:_ [#414](https://github.com/dudarenok-maker/AudioBook-Generator/issues/414).

### Ops & maintenance

#### `srv-4` — Track upstream-blocked deprecation chains (jsdom · archiver · @google/genai) ([#431](https://github.com/dudarenok-maker/AudioBook-Generator/issues/431))

- _What:_ Re-run the deprecation audit (`npm install` at root + `npm install --prefix server` on a fresh clone, grep `npm warn deprecated`) and bump the direct dep whose upstream drops the offending transitive. **Re-confirmed 2026-06-18 (deps round 4 / plan 224):** root is clean; the **server** tree's only deprecation is **`node-domexception`**, pulled via `@google/genai@2.8.0 → google-auth-library@10.7.0 → gaxios@7.1.5 → node-fetch@^3.3.2 → fetch-blob → node-domexception`. The earlier "bump `@google/genai` to 2.8+" fix is **moot** — genai is _already_ at 2.8.0; the real culprit is `gaxios` still depending on `node-fetch` (no published gaxios drops it for native fetch), and bumping `fetch-blob` to 4.x doesn't help (it still pins node-domexception; node-domexception 2.0.2 is also deprecated). **Blocked upstream** until gaxios migrates to native fetch.
- _Benefit (technical):_ keeps the `npm install` warning surface at zero so new deprecations stand out instead of getting lost in the noise.
_Full detail + acceptance:_ [#431](https://github.com/dudarenok-maker/AudioBook-Generator/issues/431).

#### `ops-17` — Migrate companion off KGP-applying plugins (Flutter built-in Kotlin / AGP 9) ([#790](https://github.com/dudarenok-maker/Castwright/issues/790))

- _What:_ `flutter build apk --release` warns that `audio_session`, `flutter_foreground_task`, `mobile_scanner` still apply the standalone Kotlin Gradle Plugin; "future versions of Flutter will fail to build" once the temporary KGP allowance is removed. Per Flutter's for-app-developers guide the only app-side fix is upgrading each plugin to a built-in-Kotlin/AGP-9 release — and as of **2026-06-14** (re-confirmed **2026-06-18**, deps round 4) all three are already at their latest pub versions with no migrated release available. **Blocked upstream** (the companion analogue of `ops-14`'s eslint-10 plugin-peer cap); re-check `flutter pub outdated` periodically and bump when upstream ships support. **Guardrail landed 2026-06-19** (`feat/app-ops-17-kgp-guardrail`): `app-deps-watch.yml` runs a monthly `flutter pub outdated` watch — A1 reds on any direct/dev drift (catch-up nudge), A2 posts a dedicated ⚠️ banner + one-off @mention on #790 when one of the three KGP plugins first shows a newer version — and `app.yml` now asserts the escape-hatch flags + Flutter-pin lockstep (Trip B). The item **stays open** (still blocked upstream; the guardrail is the interim watch, not the migration). Plan: `docs/superpowers/plans/2026-06-19-ops-17-kgp-guardrail.md`.
- _Benefit (technical):_ keeps the companion buildable on future Flutter versions before the temporary KGP support is dropped (avoids a hard build failure later). Not a current break.
_Full detail + acceptance:_ [#790](https://github.com/dudarenok-maker/Castwright/issues/790).

### Companion app

_`app-10` is the companion-app follow-up left after the Android v1 shipped
(2026-06-07); it's technically **blocked** — kept at Should, but can't ship until
its loopback-proxy prerequisite is built._

#### `app-10` — Stream-over-LAN instant play (companion) — **blocked on a loopback proxy** ([#553](https://github.com/dudarenok-maker/AudioBook-Generator/issues/553))

- _What:_ The pure pieces shipped (`resolvePlaybackSource` + `AppSettings.streamOverLan` + `AudioEngine.setStreamUrl`, 4 tests) but **cannot be wired**: `just_audio` streams via the platform player (ExoPlayer/AVPlayer) over the **OS** network stack, which can't trust the **app-pinned mkcert CA** (the TLS model deliberately avoids an OS cert install) → streaming `https://<lan>:8443` fails TLS. No `streamOverLan` toggle was wired (no dead control). _Unblock:_ a local loopback proxy that re-serves chapter bytes (fetched via the pinned `ApiClient`) to `just_audio` over `127.0.0.1`.
- _Benefit (user):_ zero-wait preview before a download. Low urgency — offline-first download/play is unaffected.
_Full detail + acceptance:_ [#553](https://github.com/dudarenok-maker/AudioBook-Generator/issues/553) · [plan 188](features/188-android-companion-app.md).

---

## Could — nice to have, low-cost wins

Organised into the shared functional sub-groups (see the triage record
[`docs/superpowers/specs/2026-06-21-oss-gap-backlog-triage-design.md`](superpowers/specs/2026-06-21-oss-gap-backlog-triage-design.md)).
Sub-groups and the items within them are ranked top = highest priority;
user-visible listener/voice wins lead, infra/security/ops below.

### Listener experience & playback

#### `fs-17` — Read-along: sentence highlight synced to audio ([#464](https://github.com/dudarenok-maker/AudioBook-Generator/issues/464))

- _What:_ Show manuscript text beside the player and highlight the current sentence as audio plays, leveraging the per-segment timing already used for the waveform; tap a sentence to seek. Widen the API to expose per-sentence start/end if not already surfaced.
- _Benefit (user):_ immersion / accessibility / pronunciation learning — a differentiating feature. (Large; owes its own plan — top Could → Should candidate once planned.)
_Full detail + acceptance:_ [#464](https://github.com/dudarenok-maker/AudioBook-Generator/issues/464).

#### `fs-27` — Chapter recaps / "previously…" summaries ([#481](https://github.com/dudarenok-maker/AudioBook-Generator/issues/481))

- _What:_ LLM-generated short recap per chapter (the analyzer already does LLM work), shown — and optionally synthesized as a spoken "previously…" intro — when the user resumes a book after a gap. Opt-in per book; cost surfaced up front.
- _Benefit (user):_ graceful re-entry into a long book after days away.
_Full detail + acceptance:_ [#481](https://github.com/dudarenok-maker/AudioBook-Generator/issues/481).

#### `fe-26` — Marker export + shareable notes ([#461](https://github.com/dudarenok-maker/AudioBook-Generator/issues/461))

- _What:_ Export the per-book markers (note + re-record kinds already in the listen-progress slice) to a text/JSON file the user can save or share. Extends the existing markers panel.
- _Benefit (user):_ makes re-record markers actionable outside the app (study / review / handoff to an editor).
_Full detail + acceptance:_ [#461](https://github.com/dudarenok-maker/AudioBook-Generator/issues/461).

#### `fs-10` — Render the chapter-title segment on the Listen view timeline ([#412](https://github.com/dudarenok-maker/AudioBook-Generator/issues/412))

- _What:_ The new title segment in `segments.json` (kind: `'title'`, empty `sentenceIds[]`) is currently filtered out at the `ChapterAudio` API boundary in `server/src/routes/chapter-audio.ts` because the wire contract types `sentenceId` as a required integer. To surface the title on the listen-view timeline (a labelled "TITLE" pill anchored at the start of the chapter, ~3 s wide including silence), widen the API segment shape so `sentenceId` is optional and add an optional `kind?: 'title' | 'sentence'` discriminator, regenerate `src/lib/api-types.ts`, then teach `src/components/listen/listen-player-region.tsx` to render title-kind segments differently from sentence-kind segments.
- _Benefit (user):_ visual cue that matches the audible cue — listener sees "you're hearing the title now" before the body segments start. Today the title beat is audible-only.
_Full detail + acceptance:_ [#412](https://github.com/dudarenok-maker/AudioBook-Generator/issues/412).

#### `fs-9` — Configurable chapter-title silence durations ([#411](https://github.com/dudarenok-maker/AudioBook-Generator/issues/411))

- _What:_ Promote the two hard-coded constants `CHAPTER_LEAD_SILENCE_SEC = 1.5` and `CHAPTER_POST_TITLE_SILENCE_SEC = 1.5` in `server/src/tts/synthesise-chapter.ts` to a per-book setting on `state.json`. Surface in the Listen view's metadata editor (the same panel that already edits narratorCredit / genre / etc.) as a "Chapter break duration" slider with a small preset list (e.g. 0.5/1/1.5/2/3 s) for the leading + post-title legs. Generation route reads the per-book values and forwards into `synthesiseChapter` opts.
- _Benefit (user):_ lets the user pace chapter breaks to match book length / mood (a tight 0.5 s for a short kids' book, a longer 3 s for a slow-burn novel) without code changes. Today the 3.0 s default is "audiobook-standard" but not universally right.
_Full detail + acceptance:_ [#411](https://github.com/dudarenok-maker/AudioBook-Generator/issues/411).

#### `fe-39` — Decorative hover-feedback parity for touch (`group-active:` mirrors) ([#799](https://github.com/dudarenok-maker/AudioBook-Generator/issues/799))

- _What:_ Optional follow-up to `fe-5` (#402): give the **decorative** hover-feedback controls fe-5 deliberately skipped (color/bg shifts on already-visible controls — revision-diff play badges, the "Add book" tile, continue-listening badge, setup "Review ›", voice-library drag icon, manuscript hit-area tint) a touch press-feedback equivalent (`group-active:` mirroring `group-hover:`), resting appearance unchanged. Caveats from the fe-5 review: don't force the "Add book" tile's full-peach hover on at rest, and the revision-diff badge mirrors may be masked by the play-state flip (verify benefit before shipping).
- _Benefit (user):_ marginal cosmetic parity — touch users get a brief press-feedback flash on controls they can already see and use. Low priority by design.
_Full detail + acceptance:_ [#799](https://github.com/dudarenok-maker/AudioBook-Generator/issues/799).

### Voice & cast

#### `fe-12` — Bulk pin / bulk delete in voice library ([#420](https://github.com/dudarenok-maker/AudioBook-Generator/issues/420))

- _What:_ Multi-select in the voice library with bulk actions — pin/unpin and delete across the selection (with a confirm + count). Deletion respects in-use voices (warn or block when a voice is assigned to a character in any book).
- _Benefit (user):_ curating a large accumulated voice library stops being a per-voice click-fest.
_Full detail + acceptance:_ [#420](https://github.com/dudarenok-maker/AudioBook-Generator/issues/420).

#### `fs-6` — Batch voice-replace across all books ([#417](https://github.com/dudarenok-maker/AudioBook-Generator/issues/417))

- _What:_ Add a "Replace voice everywhere" affordance in the voice library: pick a current voice, pick a replacement, see a preview of all (book, character) pairs that would be affected, confirm. Affected books' cast slices are mutated; audio is invalidated (regen prompt per book).
- _Benefit (user):_ cross-book voice consistency without per-book re-casting. Common need when switching a recurring narrator across a series.
_Full detail + acceptance:_ [#417](https://github.com/dudarenok-maker/AudioBook-Generator/issues/417).

#### `fe-30` — Voice-actor (multi-narrator) view ([#477](https://github.com/dudarenok-maker/AudioBook-Generator/issues/477))

- _What:_ A voice-centric view that groups characters **by assigned voice** — "this voice plays N characters across M books" — with bulk reassign. The inverse axis of the character-centric cast view; adjacent to `fe-12` / `fs-6` but a different lens.
- _Benefit (user):_ manage a cast at the voice level; spot overloaded voices at a glance.
_Full detail + acceptance:_ [#477](https://github.com/dudarenok-maker/AudioBook-Generator/issues/477).

#### `srv-7` — Cross-series voice linking ([#418](https://github.com/dudarenok-maker/AudioBook-Generator/issues/418))

- _What:_ Plan 108's per-character engine + voice changes propagate across one series via `findAuthorSeriesForBookId`. A character who recurs across DIFFERENT series by the same author (or a shared-universe crossover) is not covered — the rebaseline / per-character write stops at the series boundary by design. Add an explicit cross-series link affordance (extend `Character.aliases` / a new link record) so a deliberate "this is the same voice across series X and Y" decision propagates voice + engine across both.
- _Benefit (user):_ recurring narrators / crossover characters stay consistent across an author's whole catalogue, not just within one series.
_Full detail + acceptance:_ [#418](https://github.com/dudarenok-maker/AudioBook-Generator/issues/418).

#### `srv-23` — Opt-in "refresh personas + re-design voices" sweep for existing books ([#423](https://github.com/dudarenok-maker/AudioBook-Generator/issues/423))

- _What:_ a per-book opt-in action that re-runs `generate-all` voice-style then re-designs every Qwen voice from the refreshed personas, so an existing book can adopt the improved format in one click. Must NOT clobber hand-edited personas without confirmation, and must surface the Gemini-quota + GPU-time cost up front.
- _Benefit (user):_ existing libraries can adopt the better voice-design format without re-casting by hand. Low urgency — costly (quota + GPU) and only matters for books a user wants to re-render.
_Full detail + acceptance:_ [#423](https://github.com/dudarenok-maker/AudioBook-Generator/issues/423).

#### `fe-35` — Voices variant-filter toggle persists across tab switches (fe-34 follow-up) ([#644](https://github.com/dudarenok-maker/AudioBook-Generator/issues/644))

- _What:_ The Voices view All/Has/Needs variants toggle keeps its active state across tab switches, and its visibility guard uses the unfiltered `qwenLibrary`, so a tab whose filtered Qwen set is empty can show an active filter with no cards. Reset `variantFilter` on tab change and/or guard visibility on the tab-filtered count.
- _Benefit (user):_ the variant filter never silently carries over to a tab where it shows nothing.
_Full detail + acceptance:_ [#644](https://github.com/dudarenok-maker/AudioBook-Generator/issues/644).

#### `fs-36` — per-quote emotion: "manual clear sticks" sentinel (fs-33 follow-up) ([#593](https://github.com/dudarenok-maker/AudioBook-Generator/issues/593))

- _What:_ A manually-*cleared* emotion is stored as `undefined` today, indistinguishable from never-set, so a re-run of Detect-emotions re-fills it. Persist an explicit `neutral` sentinel and have `applyDetectedEmotions` treat it as occupied.
- _Benefit (user):_ an intentional "no emotion here" survives a later Detect-emotions run.
_Full detail + acceptance:_ [#593](https://github.com/dudarenok-maker/AudioBook-Generator/issues/593).

### Ingest & languages

#### `srv-46` — OCR ingest for scanned / image-only PDFs ([#977](https://github.com/dudarenok-maker/Castwright/issues/977))

- _What:_ Add an OCR path for image-only PDFs (we already ingest text PDF/EPUB/MOBI/AZW3).
- _Benefit (user):_ closes the last input-format sliver vs ebook2audiobook.
_Full detail + acceptance:_ [#977](https://github.com/dudarenok-maker/Castwright/issues/977).

### TTS engines

#### `fs-49` — IndexTTS-2 expressive TTS engine (decoupled per-line emotion · 8GB bet) ([#968](https://github.com/dudarenok-maker/Castwright/issues/968))

- _What:_ Opt-in TTS engine whose verified edge is **decoupled, per-line emotion** — one timbre (`spk_audio_prompt`) + emotion driven **per sentence** via IndexTTS-2's 8-float `emo_vector`, fed by our existing fs-25 per-quote `Emotion`, **collapsing the pre-baked Qwen variant-voice machinery** for this engine. Timbre via "design in Qwen, perform in IndexTTS-2" (capture a VoiceDesign clip → clone); the vector path deliberately skips the Qwen3-1.7B `emo_text` sub-model (the integration choice = the worst-case VRAM lever). **Sibling to `fs-48`** competing for the same expressive-engine slot, but an **8GB bet** (vs Fish's 16GB) on a **thinner VRAM-evidence base** (no published params/VRAM/RTF, no community quant; desk envelope ≈ 5–8 GB fp16 = plausible-but-tight). License is **lighter than Fish but contested** (source-available bilibili grant, commercial OK below 100M MAU / RMB 1B, but open ambiguity #228 + anti-distillation §4.1c + PRC arbitration). **Could now → eligible for re-triage to Should iff the 8GB spike passes** (human judgment, not auto). Go/no-go is the 8GB hardware/quality spike + a license re-verify before any paid exposure; `srv-43` (`voiceUuid`) is a soft follow-on (the field + storage-key already exist on `main`), not a spike gate.
- _Benefit (user):_ finer per-line emotional performance from a single designed voice — what the variant-voice flow does expensively and Qwen-only — potentially on the 8GB card the user already owns. Evidenced upside over Fish is the **mechanism**; the 8GB fit, quality-vs-Qwen, and license advantage are all unverified bets.
_Full detail + acceptance:_ spec `docs/superpowers/specs/2026-06-20-indextts2-engine-design.md` (brainstormed + 2 adversarial rounds) · [#968](https://github.com/dudarenok-maker/Castwright/issues/968).

#### `fs-48` — Fish Audio S2-Pro TTS engine (16GB premium tier) ([#964](https://github.com/dudarenok-maker/Castwright/issues/964))

- _What:_ Opt-in fourth TTS engine (alongside Kokoro/Coqui/Qwen) targeting **16GB consumer GPUs** via **BNB NF4 4-bit** (FP8 ≈ 20GB, GGUF too slow at RTF≈3). Prefer in-process PyTorch reuse; clone-from-seed voices on a Qwen-style per-character lifecycle + a bundled age×gender seed-reference library. **Parked — blocked on four gates:** legal sign-off (Fish Audio Research License — personal use OK, for-sale is the user's own licence), a physical 16GB card for the hardware-gated Task-0 spike, `srv-43` (`voiceUuid`), and the unproven make-or-break 4-bit prosody-quality question.
- _Benefit (user):_ the best-quality, expressive, multilingual engine within reach of quality-chasers on a mainstream 16GB card (no 24GB required).
_Full detail + acceptance:_ spec `docs/superpowers/specs/2026-06-20-fish-audio-s2pro-engine-design.md` (brainstormed + 3 adversarial reviews) · [#964](https://github.com/dudarenok-maker/Castwright/issues/964).

#### `side-18` — Engine-native bracket cues `(laughs)`/`(sighs)` — non-Qwen sibling of fs-57, depends on fs-48/fs-49 ([#979](https://github.com/dudarenok-maker/Castwright/issues/979))

- _What:_ A scripted-cue layer for `(laughs)`/`(sighs)`/breaths, model-native in Orpheus/Dia/Chatterbox. **Spike before committing an engine.** Rides on the expressive-engine decision (`fs-48`/`fs-49`). **Reframed 2026-06-22:** the **Qwen** path for non-verbal sounds is now `fs-57` (pronounceable text + instruct, spike-validated); side-18 is scoped to these **other, bracket-cue-native engines** — the sibling extension, not a duplicate of fs-57.
- _Benefit (user):_ extends the expressive performance lead beyond emotion sliders.
_Full detail + acceptance:_ [#979](https://github.com/dudarenok-maker/Castwright/issues/979).

### Reliability & observability

#### `srv-30` — CPU-only analyzer device (large RAM-resident model, concurrent with GPU TTS) ([#507](https://github.com/dudarenok-maker/AudioBook-Generator/issues/507))

- _What:_ Run the local (Ollama) analyzer **CPU-only** (`num_gpu:0`, system RAM) per-model, so a large model (e.g. **Gemma 4 12B**, which doesn't fit the 8 GB GPU) can be used without touching the GPU. A CPU model **skips the GPU semaphore**, so CPU analysis and GPU TTS run **concurrently** instead of evicting each other. Phase 0 (small GPU model) + Phase 1 (big CPU model) run side-by-side. Server-authoritative device resolver + CPU knobs (`ANALYZER_CPU_*`); required wiring so `/api/ollama/load` matches the device and the TTS auto-evict skips CPU models. Gemma 4 12B entry gated behind env until validated (brand-new).
- _Benefit (architectural):_ frees the 8 GB GPU entirely for TTS (serves the concurrent multi-book invariant) and lifts the local analyzer model-size ceiling for better fiction attribution. Trade: slower CPU analysis (~minutes/chapter) — fine as a GPU-free background step.
_Full detail + acceptance:_ [#507](https://github.com/dudarenok-maker/AudioBook-Generator/issues/507) · plan `docs/features/178-cpu-only-analyzer.md`.

#### `fs-45` — VRAM MB-accounting policy (Wave 4, beta 12/16 GB cards) ([#845](https://github.com/dudarenok-maker/Castwright/issues/845))

- _What:_ A per-(engine, mode) MB cost table vs detected VRAM, replacing Wave 1's coarse `gpu.safeCoexistMb` threshold so a 12 GB card with a heavy combo that passes the threshold but would overcommit is caught. **Deferred (Could) until a real 12/16 GB box yields measured cost numbers:** an adversarial review found that with guessed values the engine makes the same evict/coexist decisions as the threshold (and even mis-evicts on a 12 GB card during voice design), so it adds OOM risk for ~no decision-quality gain. The related two-model-split gotcha is now documented in `docs/local-llm.md` (no UI built). Revisit with telemetry from a beta tester's card.
- _Benefit (user):_ precise coexistence on bigger cards without edge-case OOMs — once the cost table is measured rather than guessed.
_Full detail + acceptance:_ plan [222](features/222-gpu-residency-and-analysing-honesty.md) "Out of scope" + spec `docs/superpowers/specs/2026-06-16-vram-budget-aware-gpu-policy-design.md` §7 · drafted plan `docs/superpowers/plans/2026-06-16-wave4-vram-mb-accounting.md` · [#845](https://github.com/dudarenok-maker/Castwright/issues/845).

#### `side-17` — Sidecar engine-dep major bump (torch · transformers · huggingface_hub · …) ([#893](https://github.com/dudarenok-maker/Castwright/issues/893))

- _What:_ The Python TTS sidecar engine deps are ~24 behind, but the heavy ones are **safety-pinned** (torch 2.11→2.12 = cu130 driver bump + voids the CVE-cleared cu128 pin; transformers 4.57→5.12 breaks the `<5.0` Qwen/Kokoro/Coqui lockstep; huggingface_hub 0.36→1.19 major; kokoro-onnx, onnxruntime-gpu, fastapi/starlette/uvicorn majors). Audited in deps round 4 (plan 224) and deferred — each is a GPU-box + golden-audio validated spike, not hygiene. Supersedes the closed #883 (torch CVE bump) with a full engine-dep sweep.
- _Benefit (technical):_ keeps the sidecar's engine stack current and CVE-clear once the bumps are validated against real model output, without risking the TTS pipeline on a blind bump.
_Full detail + acceptance:_ [#893](https://github.com/dudarenok-maker/Castwright/issues/893).

#### `side-19` — Faster book rendering: `torch.compile` the Qwen Code2Wav decoder ([#988](https://github.com/dudarenok-maker/Castwright/issues/988))

- _What:_ Speed up batched chapter rendering on our **default Qwen engine** by `torch.compile`-ing the **Code2Wav** codec decoder (token→waveform). Low-risk — a self-contained feed-forward module, **distinct from the parked `side-7`** LM-loop fork. **Phase 0 sizes the win first** (Code2Wav's share of batch wall-time on the 8 GB box); Phase 1 (`QWEN_COMPILE_CODEC`, batch-path-only, default-OFF on Windows) ships only if it clears the bar + stays 8 GB VRAM-neutral + golden-audio output-preserving.
- _Benefit (user):_ long books finish faster than playback by a wider margin on the engine every render uses — snappier generation, with no interactive-path or audio-quality cost.
_Full detail + acceptance:_ spec `docs/superpowers/specs/2026-06-22-qwen-codec-compilation-design.md` · [#988](https://github.com/dudarenok-maker/Castwright/issues/988).

#### `side-21` — FA2: fix the stale pin + conditional auto-enable on the real stack ([#1000](https://github.com/dudarenok-maker/Castwright/issues/1000))

- _What:_ `install-qwen3.mjs` pins a cp311/torch2.6/cu124 FlashAttention-2 wheel, but the venv is **cp312/torch2.11/cu128** — so FA2 silently skips (SDPA in use). Fix the gate to the real stack; auto-install+activate only when a matching wheel exists; SDPA fallback otherwise. Do NOT downgrade torch for FA2 (modest win on short TTS decode).
- _Benefit (technical):_ removes a silently-dead config; a modest speedup where a wheel exists.
_Full detail + acceptance:_ spec `docs/superpowers/specs/2026-06-22-expressive-tts-instruct-tiers-design.md` §4.8 · depends on `side-22` · [#1000](https://github.com/dudarenok-maker/Castwright/issues/1000).

#### `side-22` — Explore building FlashAttention-2 from source for Windows cp312/torch2.11/cu128 ([#1001](https://github.com/dudarenok-maker/Castwright/issues/1001))

- _What:_ No prebuilt Windows FA2 wheel exists for torch 2.11 (lldacing ≤ 2.8; 2.11 builds are Linux-only). Explore a source build for Windows cp312/torch2.11/cu128; if it works, publish the wheel for community reuse (open demand). Blocks `side-21` enablement.
- _Benefit (technical / community):_ unblocks FA2 on the real stack; community goodwill + visibility.
_Full detail + acceptance:_ spec `docs/superpowers/specs/2026-06-22-expressive-tts-instruct-tiers-design.md` §4.8/§10 · [#1001](https://github.com/dudarenok-maker/Castwright/issues/1001).

### Revisions & regen

#### `fs-5` — Multi-step rollback / snapshot-per-entry (revision history) ([#415](https://github.com/dudarenok-maker/AudioBook-Generator/issues/415))

- _What:_ Extend plan 20's `preserveExistingAsPrevious` to write `.previous.<entryId>.<slug>.mp3` per timeline entry (not just one `.previous.<slug>.mp3` per chapter). Wire a server `POST /api/books/:bookId/revisions/:entryId/rollback` endpoint that restores a specific timeline entry's audio + flips subsequent entries to `rolled-back-from`. Add a GC pass that prunes oldest snapshots after the user commits (or when disk pressure exceeds a cap, e.g. 10 entries / chapter).
- _Benefit (user):_ closes the centerpiece feature from plan 55 — true non-linear undo per chapter. Today the timeline modal is read-only; the user has to walk through accept/reject in the A/B player.
_Full detail + acceptance:_ [#415](https://github.com/dudarenok-maker/AudioBook-Generator/issues/415).

### Agents & integrations

#### `fs-54` — Audiobookshelf export / hand-off ([#978](https://github.com/dudarenok-maker/Castwright/issues/978))

- _What:_ Push or export finished books into Audiobookshelf (the OSS audience's library home). **Triage decision (2026-06-21): a bridge, not a pivot** — the companion app is the strategic library answer.
- _Benefit (user):_ interop with the OSS field's de-facto library without diverting from the companion-app bet.
_Full detail + acceptance:_ [#978](https://github.com/dudarenok-maker/Castwright/issues/978).

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

### Security & hardening

Source for the whole sub-group: the [2026-05-31 security review](security/2026-05-31-security-review.md). All are scoped to the **opt-in LAN exposure surface** (`npm run start:lan`) or local-only defense-in-depth — the app is single-user/local-first by design, so these harden the hostile-LAN and local-write threat models rather than fixing an exploited-today hole. `srv-19` (draft plan 157) is the partner default-bind fix.

#### `side-12` — Load Qwen voice `.pt` prompts with `weights_only=True` (or a safe format) ([#428](https://github.com/dudarenok-maker/AudioBook-Generator/issues/428))

- _What:_ switch the voice-prompt load to `weights_only=True`; if the saved payload isn't a pure tensor/state-dict, migrate the design-time save (`design_voice`) to a safe container (safetensors, or JSON sidecar + tensors) so the load no longer needs arbitrary unpickling. One-time read-compat shim for already-cached `.pt` files (re-derive or one-shot re-save). Prerequisite groundwork for `side-13`.
- _Benefit (technical):_ removes a local RCE-on-untrusted-file footgun; aligns with torch's `weights_only` default direction.
_Full detail + acceptance:_ [#428](https://github.com/dudarenok-maker/AudioBook-Generator/issues/428).

#### `srv-41` — Pairing device-token hardening: TTL + scoped access ([#898](https://github.com/dudarenok-maker/Castwright/issues/898))

- _What:_ Give the companion device token a second post-mint layer — a scope (no authorization-scope model exists today; full `/api` access) and a refreshable TTL that doesn't break offline-first playback. Surfaced by the app-17 defence-in-depth review (rec D), deliberately NOT folded into app-17 because a naive TTL/scope is the wrong change (offline UX + new authz model). Needs its own brainstorm.
- _Benefit (architectural):_ turns the only post-mint control (manual revocation, one layer) into defence-in-depth — a leaked companion token can't do everything.
_Full detail + acceptance:_ [#898](https://github.com/dudarenok-maker/Castwright/issues/898).

### Ops & maintenance

#### `fs-42` — Advanced Settings: export/import config as JSON + env-diff view ([#668](https://github.com/dudarenok-maker/Castwright/issues/668))

- _What:_ Power-user follow-ups for the shipped `#/advanced` surface (plan 199): a "Download config.json" export of all active overrides, a complementary JSON import flow (validates keys against live descriptors), and an env-diff indicator showing when a `.env`-locked value differs from the configured default.
- _Benefit (user / technical / architectural):_ snapshot and restore tuning profiles across machines without re-entering values; validates the descriptor schema round-trips; natural migration target for future config shape changes.
_Full detail + acceptance:_ [#668](https://github.com/dudarenok-maker/Castwright/issues/668) · plan `docs/features/199-advanced-settings.md`.

#### `fe-1` — In-app LAN HTTPS banner under dev settings ([#401](https://github.com/dudarenok-maker/AudioBook-Generator/issues/401))

- _What:_ Account settings card showing the current LAN HTTPS URL (from `GET /api/export/lan` when LAN_HTTPS=1) with one-click "Copy URL" + "Install cert on phone" links. The latter opens a doc / route that shows the QR code that `npm run install:cert-mobile` prints to the terminal today. Dev-mode only — hidden in production single-user environments. _Not yet built — the LAN URL is surfaced in the export-to-phone modal, but the Account-card + cert-QR flow doesn't exist._
- _Benefit (user):_ surfaces the LAN access flow inside the app instead of requiring the user to read terminal output. Especially valuable for users who first installed via the alpha release zip (no terminal interaction expected). **Niche dev/LAN surfacing — kept at Could 2026-06-08.**
_Full detail + acceptance:_ [#401](https://github.com/dudarenok-maker/AudioBook-Generator/issues/401).

#### `srv-49` — Consolidate Coalfall manuscript locations (fixtures ↔ sample book; consider brand/) ([#1043](https://github.com/dudarenok-maker/Castwright/issues/1043))

- _What:_ Reduce the number of Coalfall homes — point e2e + language-detection tests at the `samples/` manuscripts (or vice-versa) so English/ru text isn't duplicated in `__fixtures__/`, optionally add an English `manuscript.en.md` to `samples/` for `.md` uniformity, and resolve the open question of whether the Castwright-original book belongs under `brand/` (git-ignored) vs staying the shipped bundled demo in `samples/`.
- _Benefit (technical):_ one source of truth per manuscript; less drift between the demo book and the test fixtures. Pairs with `fs-61` (#1027) and `fs-22`.
_Full detail + acceptance:_ [#1043](https://github.com/dudarenok-maker/Castwright/issues/1043).

#### `ops-18` — Catch any large-region visual change (not just the top-bar) ([#947](https://github.com/dudarenok-maker/Castwright/issues/947))

- _What:_ Full-page re-blessed baselines + a contiguity gate to catch branding-scale changes outside the top-bar. Follow-up to #925; build only if a real non-top-bar regression is seen.

#### `ops-14` — eslint 9→10 (+@eslint/js): deferred, upstream-blocked ([#711](https://github.com/dudarenok-maker/AudioBook-Generator/issues/711))

- _What:_ The one item deps round 3 (plan 202) could not ship. `eslint ^9→^10` is blocked because the latest `eslint-plugin-react` (7.37.5) and `eslint-plugin-jsx-a11y` (6.10.2) still cap their eslint peer at `^9`, and eslint 10 removes deprecated context APIs those plugins use. **Re-confirmed 2026-06-18 (deps round 4):** still capped (only `eslint-plugin-react-hooks` added `^10`); eslint 9 is now in the `maintenance` dist-tag. Unblock when both plugins ship eslint-10 peer ranges; then bump eslint + @eslint/js + the two plugins together.
- _Benefit (technical):_ stays on a supported eslint line; clears the last row of the round-3 `npm outdated`.
_Full detail + acceptance:_ [#711](https://github.com/dudarenok-maker/AudioBook-Generator/issues/711).

---

## Won't (this round) — explicitly parked

Specific items someone might reasonably re-propose. Each carries a _Why parked_ (the v1 design or operational constraint) and a _Wake when_ (the trigger that makes us reopen). The broad "v1 scope freeze" and "no visual redesign" are covered by CLAUDE.md "Out of scope" and don't need restating here — this list is for tracked-specific decisions only.

- `side-11` — Eliminate the variable-input-shape host-memory leak (so recycling isn't needed) ([#399](https://github.com/dudarenok-maker/AudioBook-Generator/issues/399)). _Why parked:_ RTF is solved (~1.04) and the plan-143 process-recycle every ~10 chapters keeps full-book runs reliable in practice — the leak is **worked around**, so this is now **monitoring** rather than active work (moved out of Must 2026-06-08). _Wake when:_ recycling proves insufficient on a real long book (dropped chapters return) OR a smaller/different GPU shifts the headroom math — then pursue fixed-shape batch padding, chapter-boundary recycle, or a torch/transformers version pin.

- `side-16` — Kokoro on DirectML (AMD-Windows GPU acceleration for Kokoro) ([#819](https://github.com/dudarenok-maker/Castwright/issues/819)). _Why parked:_ **validated FAIL on-box** (2026-06-15, Radeon 780M + onnxruntime-directml 1.24.4, the latest) — Kokoro errors at the `/encoder/F0.1/pool/ConvTranspose` node (`0x80070005`) while the same inputs run on the CPU EP; four session-option workarounds all failed and no newer ORT exists. So AMD Kokoro ships on **CPU** (Qwen/Coqui still target ROCm); the DirectML scaffolding is retained for a one-line re-enable. _Wake when:_ a future `onnxruntime-directml` adds working ConvTranspose support OR onnx-community publishes a re-exported/higher-opset Kokoro model that runs on DirectML (we consume the community ONNX artifact, so the export depends on upstream). Tracks off `side-15` (#813, PR #818).

- `ops-5` — Trim `build` / `e2e` out of the per-PR `verify.yml` ([#437](https://github.com/dudarenok-maker/AudioBook-Generator/issues/437)). _Why parked:_ would shave ~1–3 min off each frontend/server PR run, but the dev box is Windows (case-insensitive FS) and CI is Linux (case-sensitive) — a build break like a wrong-case import would slip past PR CI and only surface in ` … _Wake when:_ the safer round-2 levers prove insufficient AND a Linux-build / e2e signal moves earlier in the pipeline (e.g. …

- `side-4` — A/B Qwen `x_vector_only_mode=True` (speed vs. fidelity) ([#438](https://github.com/dudarenok-maker/AudioBook-Generator/issues/438)). _Why parked:_ the perf problem that motivated it is solved — after the plan-113 batching + the concurrent-batch race fix, end-to-end Qwen chapters run at **~RTF 1.15**, and the **2026-05-31 overnight full-book run held aggregate RTF ≈ … _Wake when:_ Qwen synthesis becomes a real bottleneck again (much longer books, a slower GPU, or a per-quote-emotion feature that inflates decode cost) AND a listen-test shows x-vector-only holds identity acceptably.

- `side-7` — Qwen decode CUDA-graph / static-cache spike (probe-gated) ([#439](https://github.com/dudarenok-maker/AudioBook-Generator/issues/439)). _Why parked:_ the perf goal is met. The 2026-05-31 overnight full-book run rendered 25 real multi-voice chapters at aggregate **RTF ≈ 1.04** (range 0.91–1.26) on the adopted 32/3600 + single-worker config — ~realtime, the target. … _Wake when:_ Qwen synthesis becomes a real bottleneck again (much longer books, a slower GPU, or a per-quote-emotion feature that inflates decode cost). Then run plan-129 Probe 1 first; only fork if it proves still launch-bound.

- `side-10` — Coalesce consecutive same-speaker short lines before batching ([#440](https://github.com/dudarenok-maker/AudioBook-Generator/issues/440)). _Why parked:_ two reasons. (1) **Perf goal met** — the 2026-05-31 overnight full-book run held aggregate RTF ~1.04 even on multi-voice/dialogue-dense chapters, so the dialogue floor isn't worth chasing. … _Wake when:_ Qwen synthesis becomes a real bottleneck again specifically on dialogue-dense books AND a captions/timing-preservation design + a quality A/B prove the merge doesn't hurt quote-audit fidelity.

- `srv-8` — Multi-model fan-out for Gemini analyzer ([#442](https://github.com/dudarenok-maker/AudioBook-Generator/issues/442)). _Why parked:_ one model per run keeps cost predictable and the SSE stream simple; A/B comparison today is two sequential runs. _Wake when:_ a real product use case for "render the same chapter under two models side-by-side in one view" emerges. The audio-layer a/b audition (plan 20) covers the listening-side intent today.

- `fe-11` — Multi-tab catch-up race resilience ([#443](https://github.com/dudarenok-maker/AudioBook-Generator/issues/443)). _Why parked:_ disk `state.json` is authoritative + single-user-per-workspace, so two tabs on the same book never compete on writes. Tab B catches up by re-reading state on focus. _Wake when:_ multi-user collab on a shared workspace becomes a real use case. Pairs with `srv-10` — both wake under the same trigger.

- `fe-13` — Live `VITE_USE_MOCKS` toggle in running UI ([#444](https://github.com/dudarenok-maker/AudioBook-Generator/issues/444)). _Why parked:_ the mock layer swaps the entire `api` module at module-load via the env flag; flipping at runtime would need a different architecture (e.g. mock middleware around the api object). _Wake when:_ demo / QA flow requires mid-session real↔mock flipping. Today rebuilding with `VITE_USE_MOCKS=true` takes 5 s — building the runtime toggle would cost more than the friction it removes.

- `srv-10` — Conflict resolution for two simultaneous `state.json` writers ([#445](https://github.com/dudarenok-maker/AudioBook-Generator/issues/445)). _Why parked:_ single-user-per-workspace assumption; file locking is advisory at best on Windows network shares. _Wake when:_ multi-user collab on a shared workspace becomes a real use case. Pairs with `fe-11` — both wake under the same trigger.

- `srv-5` — Tune per-engine VRAM cost map against real hardware ([#447](https://github.com/dudarenok-maker/AudioBook-Generator/issues/447)). _Why parked:_ most of the original scope dissolved under the Qwen tuning work. The plan-113 fix serialises the Qwen forward per-engine (it isn't thread-safe), so `GPU_VRAM_BUDGET>1` gives **no same-engine Qwen parallelism** — the cost … _Wake when:_ cross-engine packing actually thrashes (spill-to-RAM slowdown, `nvidia-smi` near the card ceiling) on real hardware, or a different/smaller GPU changes the headroom math. …

- `fs-8` — PocketBook Cloud direct upload OR `@pbsync.com` email gateway ([#436](https://github.com/dudarenok-maker/Castwright/issues/436)). _Why parked:_ the sideload-*free* transport isn't worth building — LAN download + the sync-folder path already get a finished book onto a PocketBook, and both candidate routes are unattractive: PocketBook Cloud's protocol is closed (needs reverse-engineering or vendor contact), and `@pbsync.com` is documented for ebooks with undocumented audiobook size limits. The PocketBook *sideload* tile (M4B) stays live and covers the need. _Wake when:_ PocketBook ships a documented upload API, OR enough users ask for a no-sideload PocketBook path to justify the reverse-engineering cost.

---

## Retired numbering

The old per-bucket `Could #N` / `Should #N` numbering was retired on 2026-05-25 in
favour of the permanent `<prefix>-<n>` IDs above (it renumbered on every ship, so
external references rotted). Any code comment or plan doc still citing a bare
`Could/Should/Must #N` is either (a) a stale pre-2026-05-25 reference — resolve it by
matching the comment's described feature to an item above or to its shipping plan —
or (b) **plan-internal** numbering of the form `plan <NN> Should #M`, which is frozen
and correct. Don't reintroduce bare-number backlog references.
