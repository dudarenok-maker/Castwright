# Admin/Model Manager Split + Advanced Settings Rewrite + #1318 Screenshots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `docs/wiki/Admin-and-Model-Manager.md` into `Admin.md` + `Model-Manager.md` with full per-knob detail, rewrite `docs/wiki/Advanced-Settings.md` so all 11 knob groups get the same treatment, and close out GitHub issue #1318's 11 pages of missing interaction-state screenshots — all via the `e2e/marketing/` screenshot harness.

**Architecture:** Every new/changed screenshot is a `Scene` entry in `e2e/marketing/scenes.ts`, captured via `npm run capture:marketing` into `mockups/marketing-screens/` and manually curated into `docs/wiki/images/<page>/NN-name.png`. A new `strict` mode is added to the harness first so every scene this plan adds fails loudly (not silently) if its selector drifts. Wiki content is hand-authored markdown in `docs/wiki/*.md`, cross-referencing the exact knob defaults verified against `server/src/config/registry.ts` and `server/src/workspace/user-settings.ts`.

**Tech Stack:** Playwright (marketing capture harness), React/TypeScript (mock fixtures), Markdown (wiki pages).

**Spec:** `docs/superpowers/specs/2026-07-05-admin-model-manager-advanced-settings-wiki-design.md` (this plan implements it in full — read it once for the "why" behind every default/selector cited below; this plan restates only what's needed to execute).

## Global Constraints

- No changes to real (non-mock) application behavior. Touched source is limited to `e2e/marketing/scenes.ts`, `e2e/marketing/capture.spec.ts`, `src/mocks/marketing/hollow-tide.ts`, `src/lib/api.ts`'s `mockGetModelInventory` (Task 12) and `mockGetListenProgress` (Task 11 — adds a `DEMO_CAPTURE` branch following the exact pattern already used by ~8 other mock functions in that file), and `e2e/model-manager-health.spec.ts` (Task 12, fixing assertions the mock flip breaks).
- This PR is **not docs-only** (it edits `e2e/marketing/scenes.ts`, outside the `docs/**` glob) — the full `npm run verify` battery is required before merge, and it's a **high**-effort `code-review` gate (multi-scope: docs + test/fixture code + one shared-mock change).
- No new knobs, no changed defaults/behavior in `server/src/config/registry.ts` or `model-settings-form.tsx` — this is descriptive documentation of what already ships.
- No product-code change to add a Model Manager pill for Qwen VoiceDesign — #1318's "Qwen's row" means the Qwen3-TTS Base row only.
- PR body: `Closes #1319` and `Closes #1318`.
- Every screenshot scene added in this plan sets `strict: true` (Task 1) and pairs it with a `waitFor` targeting a selector unique to the scene's *target* state — never `action()`/`scrollTo` alone.

---

## Task 1: Harness reliability — `strict` mode for scenes

**Files:**
- Modify: `e2e/marketing/scenes.ts:9-28` (the `Scene` interface)
- Modify: `e2e/marketing/capture.spec.ts:74-104` (the per-scene capture logic)
- Test: `e2e/marketing/capture.spec.ts` itself (this is a Playwright spec — its own "test" is a scene deliberately engineered to fail)

**Interfaces:**
- Produces: `Scene.strict?: boolean` field, consumed by every later task's new scene entries.

Today, `waitFor` timeouts (`capture.spec.ts:75-83`) and `action()` throws (`capture.spec.ts:88-95`) are caught, `console.warn`'d, and the capture proceeds — a deliberate design so one broken scene can't abort the whole run. This plan adds ~39 new/renamed scenes whose entire point is a *post-interaction* state; under the current contract, a selector drift silently ships a screenshot of the wrong (pre-interaction) state. `strict: true` makes that fail loudly instead.

- [ ] **Step 1: Add the `strict` field to the `Scene` interface**

Edit `e2e/marketing/scenes.ts`, inside the `Scene` interface (after the `action` field):

```ts
  /** Optional interaction (e.g. open a modal) run after navigation + waitFor,
      before the screenshot. Best-effort — a thrown action is caught and
      logged, never aborts the run, so a selector drift degrades to "scene
      captured pre-interaction" rather than failing the whole capture. */
  action?: (page: Page) => Promise<void>;
  /** Optional selector to await AFTER `action` runs (not before, unlike
      `waitFor` — see the ordering note below). This is how a scene confirms
      its action actually reached its target state (a modal opened, a
      section expanded), since `waitFor` runs before `action` and can only
      ever confirm PRE-action page state. */
  waitForAfterAction?: string;
  /** When true, a `waitFor`/`waitForAfterAction` timeout or `action` throw is
      re-thrown instead of caught — failing this scene's test outright.
      Every scene this repo adds going forward that has an `action` should
      set this and use `waitForAfterAction` (not `waitFor`) to confirm the
      action's target state, so "capture ran green" means the scene actually
      reached that state, not merely that nothing threw. `waitFor` alone is
      only for confirming pre-action page/navigation state (e.g. the page
      loaded before any click happens). Existing/legacy scenes stay
      non-strict. */
  strict?: boolean;
}
```

> **Why `waitForAfterAction` is a separate field, not just reordering `waitFor`
> after `action` in `capture.spec.ts`:** some scenes have no `action` at all
> (plain navigation + scrollTo) and still need to wait for page content
> before screenshotting — that's what today's `waitFor` already does, and it
> must keep running where it already runs (before `waitForImages`/`scrollTo`,
> which assume the page has settled). Reordering `waitFor` to always run
> after `action` would break every existing non-interactive scene's timing.
> A second, explicitly-post-action field is the smallest correct fix.

- [ ] **Step 2: Add a temporary failing scene to prove strict mode works on `waitForAfterAction`**

Add this scene temporarily to the end of the `SCENES` array in `e2e/marketing/scenes.ts` (it will be deleted in Step 5 — it exists only to prove the mechanism, and deliberately exercises `waitForAfterAction` since that's the field every real interaction scene in this plan actually uses):

```ts
  {
    id: '__strict-mode-smoke-test',
    hash: '#/',
    viewports: ['desktop'],
    action: async () => {},
    waitForAfterAction: '[data-testid="this-selector-does-not-exist"]',
    strict: true,
  },
```

- [ ] **Step 3: Run the capture spec and confirm it currently does NOT fail (proving the bug exists)**

Run: `CAPTURE_SCENE=__strict-mode-smoke-test npx playwright test --config=playwright.marketing.config.ts --project=desktop`
Expected: **PASS** — `waitForAfterAction` doesn't exist in the harness yet, so it's silently ignored; this confirms the field isn't wired up.

- [ ] **Step 4: Implement `strict` handling for both `waitFor` and the new `waitForAfterAction` in `capture.spec.ts`**

Edit the existing `waitFor` block (`capture.spec.ts:75-83`) to add strict re-throw:

```ts
    if (scene.waitFor) {
      // Non-fatal by default: if a view never reaches its content selector we
      // still want a screenshot (plus a console note) rather than an aborted
      // run. `strict: true` scenes re-throw instead.
      try {
        await page.waitForSelector(scene.waitFor, { timeout: 20_000 });
      } catch (err) {
        if (scene.strict) throw err;
        console.warn(`[capture] ${scene.id}: waitFor "${scene.waitFor}" timed out — capturing anyway`);
      }
    }
```

Edit the `action` block (`capture.spec.ts:88-95`) to add strict re-throw AND the new post-action wait:

```ts
    if (scene.action) {
      try {
        await scene.action(page);
        await page.waitForTimeout(300); // let the modal's open transition settle
      } catch (err) {
        if (scene.strict) throw err;
        console.warn(`[capture] ${scene.id}: action failed — capturing pre-interaction:`, err);
      }
    }

    /* Confirms the action actually reached its target state (unlike
       `waitFor` above, which runs BEFORE `action` and can only ever confirm
       pre-action page state). This is the field every interaction scene in
       this repo's screenshot plan uses to verify a modal opened / a section
       expanded, rather than merely that a click didn't throw. */
    if (scene.waitForAfterAction) {
      try {
        await page.waitForSelector(scene.waitForAfterAction, { timeout: 20_000 });
      } catch (err) {
        if (scene.strict) throw err;
        console.warn(
          `[capture] ${scene.id}: waitForAfterAction "${scene.waitForAfterAction}" timed out — capturing anyway`,
        );
      }
    }
```

- [ ] **Step 5: Run the capture spec again and confirm it now fails, then delete the smoke-test scene**

Run: `CAPTURE_SCENE=__strict-mode-smoke-test npx playwright test --config=playwright.marketing.config.ts --project=desktop`
Expected: **FAIL** — the test now throws on the `waitForAfterAction` timeout.

Delete the `__strict-mode-smoke-test` scene entry added in Step 2.

- [ ] **Step 6: Run the full marketing capture to confirm nothing else broke**

Run: `npm run capture:marketing`
Expected: all existing (non-strict) scenes still pass green, same as before this change.

- [ ] **Step 7: Commit**

```bash
git add e2e/marketing/scenes.ts e2e/marketing/capture.spec.ts
git commit -m "test(e2e): add strict mode + post-action wait to marketing capture scenes"
```

---

## Task 2: Model Manager scenes

**Files:**
- Modify: `e2e/marketing/scenes.ts:156-160` (rename `model-manager` scene) and append 6 new scenes

**Interfaces:**
- Consumes: `Scene.strict` (Task 1)
- Produces: 7 scene ids consumed by Task 3's screenshot capture — `model-manager-installed`, `model-manager-device`, `model-manager-defaults`, `model-manager-analyzer-split`, `model-manager-voice-engine`, `model-manager-server-config`, `model-manager-install-ollama`.

- [ ] **Step 1: Rename the existing `model-manager` scene**

In `e2e/marketing/scenes.ts`, change:

```ts
  {
    id: 'model-manager',
    hash: '#/models',
    viewports: ['desktop'],
  },
```

to:

```ts
  {
    id: 'model-manager-installed',
    hash: '#/models',
    viewports: ['desktop'],
    waitFor: '[data-testid^="model-row-"]',
    strict: true,
  },
```

- [ ] **Step 2: Add the 6 new Model Manager scenes**

Add immediately after the renamed scene:

```ts
  {
    id: 'model-manager-device',
    hash: '#/models',
    viewports: ['desktop'],
    waitFor: '[data-testid="device-panel"]',
    scrollTo: '[data-testid="device-panel"]',
    strict: true,
  },
  {
    id: 'model-manager-defaults',
    hash: '#/models',
    viewports: ['desktop'],
    action: async (page) => {
      await page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByText('Defaults for new books', { exact: true })
        .click({ timeout: 5000 });
    },
    waitForAfterAction: '[data-testid="account-generation-workers"]',
    strict: true,
  },
  {
    id: 'model-manager-analyzer-split',
    hash: '#/models',
    viewports: ['desktop'],
    action: async (page) => {
      await page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByText('Two-model analyzer split (advanced)', { exact: true })
        .click({ timeout: 5000 });
    },
    waitForAfterAction: '[data-testid="account-analyzer-phase1-min-lag"]',
    strict: true,
  },
  {
    id: 'model-manager-voice-engine',
    hash: '#/models',
    viewports: ['desktop'],
    action: async (page) => {
      await page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByText('Voice engine', { exact: true })
        .click({ timeout: 5000 });
    },
    waitForAfterAction: '[data-testid="account-generation-workers"]',
    strict: true,
  },
  {
    id: 'model-manager-server-config',
    hash: '#/models',
    viewports: ['desktop'],
    action: async (page) => {
      await page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByText('Server configuration', { exact: true })
        .click({ timeout: 5000 });
    },
    waitForAfterAction: '[data-testid="account-sidecar-url"]',
    strict: true,
  },
  {
    id: 'model-manager-install-ollama',
    hash: '#/models',
    viewports: ['desktop'],
    action: async (page) => {
      await page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByText('Install / update analyzer (Ollama)', { exact: true })
        .click({ timeout: 5000 });
    },
    waitForAfterAction: 'text=Install / update analyzer',
    strict: true,
  },
```

> **`model-manager-defaults` and `model-manager-voice-engine` share the same
> `waitForAfterAction` target** (`account-generation-workers`, per the spec —
> "Voice engine" also documents Generation workers) — that's intentional,
> both scenes land on the same accordion neighborhood, just scrolled/clicked
> from different nav entries. **Verify every selector against
> `src/components/model-settings-form.tsx` and `src/components/device-panel.tsx`
> before running the batch capture** — these `data-testid`s
> (`account-generation-workers`, `account-analyzer-phase1-min-lag`,
> `account-sidecar-url`) were confirmed directly against source during this
> plan's own assumption-checker review; the nav-label click targets (exact
> section titles) should still be spot-checked since accordion labels are
> case/punctuation-sensitive for `{ exact: true }`.

- [ ] **Step 2b: Run typecheck**

Run: `npm run typecheck`
Expected: no errors (scenes.ts is plain TS array literals, but this confirms no syntax mistakes).

- [ ] **Step 3: Capture all 7 scenes and confirm each passes strict mode**

Run: `CAPTURE_SCENE=model-manager-installed npx playwright test --config=playwright.marketing.config.ts --project=desktop`, then repeat for each of the other 6 scene ids.
Expected: all 7 PASS. If any fails, open `mockups/marketing-screens/<id>.desktop.light.png` (captured even on a strict failure isn't guaranteed — check the Playwright error trace/screenshot instead) and fix the selector before moving on.

- [ ] **Step 4: Commit**

```bash
git add e2e/marketing/scenes.ts
git commit -m "test(e2e): add Model Manager section scenes"
```

---

## Task 3: `Model-Manager.md` — capture screenshots and write the page

**Files:**
- Create: `docs/wiki/images/model-manager/01-device.png` through `07-install-ollama.png` (7 files)
- Create: `docs/wiki/Model-Manager.md`
- Modify: none yet (cross-links land in Task 7)

**Interfaces:**
- Consumes: the 7 scene ids from Task 2.

- [ ] **Step 1: Capture and curate the 7 screenshots**

Run: `npm run capture:marketing` (or `CAPTURE_SCENE=<id>` per-scene, faster iteration). This produces `mockups/marketing-screens/<id>.desktop.light.png` and `.dark.png` for each of the 7 scenes.

```bash
mkdir -p docs/wiki/images/model-manager
cp mockups/marketing-screens/model-manager-device.desktop.light.png docs/wiki/images/model-manager/01-device.png
cp mockups/marketing-screens/model-manager-installed.desktop.light.png docs/wiki/images/model-manager/02-installed-models.png
cp mockups/marketing-screens/model-manager-defaults.desktop.light.png docs/wiki/images/model-manager/03-defaults-for-new-books.png
cp mockups/marketing-screens/model-manager-analyzer-split.desktop.light.png docs/wiki/images/model-manager/04-analyzer-split.png
cp mockups/marketing-screens/model-manager-voice-engine.desktop.light.png docs/wiki/images/model-manager/05-voice-engine.png
cp mockups/marketing-screens/model-manager-server-config.desktop.light.png docs/wiki/images/model-manager/06-server-config.png
cp mockups/marketing-screens/model-manager-install-ollama.desktop.light.png docs/wiki/images/model-manager/07-install-ollama.png
```

(Follow the light-theme convention already used by every other wiki screenshot in `docs/wiki/images/**`.)

- [ ] **Step 2: Write `docs/wiki/Model-Manager.md`**

```markdown
# Model Manager

**Model Manager** (`#/models`, reached via the **Open Model Manager** button
on [Admin](Admin)) is where every local model — TTS engines, the ASR model,
and the local analyzer — gets installed, updated, removed, and loaded or
unloaded from the GPU, all from one place. It's also where the settings that
used to live on the Account page now live: default engine per model kind,
the two-model analyzer split, TTS sidecar tuning, and server configuration.

## Device

![Device panel — detected GPU and VRAM](images/model-manager/01-device.png)

The **Device** panel shows the GPU(s) detected on this machine and their
VRAM — this is what determines which engines are even offered (a CPU-only
box still runs Kokoro; a GPU box can run Qwen/Coqui too).

## Installed models

![Installed models — Standard group](images/model-manager/02-installed-models.png)

Every model is grouped under **Standard** (Kokoro, Qwen3-TTS Base 0.6B/1.7B,
Qwen3-TTS VoiceDesign), **Optional add-ons** (Coqui XTTS v2), **Analyzer
models (Ollama)**, and **Speech recognition (ASR)**. Each row shows:

- **Disk size + path** — read straight off the model files on disk, not a
  cached estimate.
- **Status badges** — `Not installed`, `Weights missing` / `Needs repair`
  (present but broken — offers a **Repair** action instead of Load),
  `Installed`, or `Loaded`, plus `Default` / `Fallback` tags for the
  engines that hold those roles, and an integrity chip (`verified` /
  `mismatch` / `unpinned`) for fixed-file models.
- **Load / Stop** — the same [Model Control Pill](The-Model-Control-Pill)
  used everywhere else in the app, when the row has a usable install.
- **Install / Update / Repair** — expands an inline installer under the
  row for engines that ship one (Kokoro, Coqui, Qwen Base, Whisper).
- **Remove** — deletes the model's weights from disk, gated by a confirm
  dialog that explains and blocks the three cases the server itself
  refuses: the model is currently loaded, it's the universal fallback
  engine, or it's your current default engine.

## Defaults for new books

![Defaults for new books](images/model-manager/03-defaults-for-new-books.png)

| Knob | What it does | Default | Range |
|---|---|---|---|
| Analysis model | Model used to analyze new books | `account.defaultAnalysisModel` | curated list ∪ live Ollama tags |
| Voice engine | Default TTS engine for new books | `account.defaultTtsEngine` | Kokoro / Qwen3-TTS / Coqui |
| Voice model | Default voice model, scoped to chosen engine | resolved `defaultTtsModelKey` | engine-dependent |

## Two-model analyzer split (advanced)

![Two-model analyzer split](images/model-manager/04-analyzer-split.png)

Splits analysis across two models so cast detection and sentence
attribution run concurrently on different free-tier rate-limit buckets.
**Off by default** — both phases use your default analysis model until you
opt in.

| Knob | What it does | Default | Range |
|---|---|---|---|
| Phase 0 model (cast detection) | Model used for cast detection | blank = server default | dropdown |
| Phase 1 model (attribution) | Model used for sentence attribution | blank = server default | dropdown |
| Phase 1 minimum chapter lag | Chapters Phase 0 must clear before Phase 1 starts | 10 (effective) | integer, 0–50 |

## Voice engine

![Voice engine settings](images/model-manager/05-voice-engine.png)

| Knob | What it does | Default | Range |
|---|---|---|---|
| Auto-start with server | Starts the TTS sidecar automatically with the server (needs server restart) | `true` | boolean |
| Keep both voice engines loaded | Dual-model mode — both engines resident at once | `false` | boolean |
| Generation workers | Chapters synthesized concurrently | 1 | integer, 1–4 |

## Server configuration

![Server configuration](images/model-manager/06-server-config.png)

| Knob | What it does | Default | Range |
|---|---|---|---|
| Voice engine URL | Base URL of the TTS sidecar | `http://localhost:9000` | string, private/loopback host only |
| Analyzer engine | Routes analysis through Gemini direct vs. local Ollama for THIS account | `gemini` | gemini / local |
| Ollama URL | Base URL of the local Ollama daemon | `http://localhost:11434` | string |
| Gemini API key | API key for Gemini analyzer/persona calls | (unset) | string |

> **Not the same knob as [Advanced Settings](Advanced-Settings)'s "Analyzer
> engine."** This one is your per-account preference (defaults to
> `gemini`, matching the free-tier-friendly out-of-the-box experience);
> Advanced Settings' `analyzer.engine` is the lower-level server/env
> config knob (defaults to `local`), used only when no per-account
> preference is set. Same English label, two different controls.

## Install / update analyzer (Ollama)

![Install / update analyzer](images/model-manager/07-install-ollama.png)

Install the Ollama daemon and pull analyzer model weights without dropping
to a terminal — pull-tag UI plus a live health probe. The voice-engine / ASR
models (Kokoro, Qwen, Coqui, Whisper) install from their own rows in
**Installed models** above, not here.

Next: [Advanced Settings](Advanced-Settings).
```

- [ ] **Step 3: Verify every image reference resolves**

Run this one-off Node check:

```bash
node -e "
const fs = require('fs');
const path = require('path');
const md = fs.readFileSync('docs/wiki/Model-Manager.md', 'utf8');
const refs = [...md.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(m => m[1]);
for (const ref of refs) {
  const p = path.join('docs/wiki', ref);
  if (!fs.existsSync(p)) throw new Error('missing image: ' + ref);
}
console.log('OK:', refs.length, 'image refs resolved');
"
```

Expected: `OK: 7 image refs resolved`

- [ ] **Step 4: Commit**

```bash
git add docs/wiki/Model-Manager.md docs/wiki/images/model-manager/
git commit -m "docs(docs): add Model-Manager.md wiki page with full knob detail"
```

---

## Task 4: `Admin.md` — split out from the old combined page

**Files:**
- Create: `docs/wiki/Admin.md`
- Create: `docs/wiki/images/admin/01-admin-overview.png` (copied, not re-shot)
- Read: `docs/wiki/Admin-and-Model-Manager.md` (source content; deleted in Task 7)

**Interfaces:** none (no code changes — pure content move).

- [ ] **Step 1: Copy the existing screenshot to its new location**

```bash
mkdir -p docs/wiki/images/admin
cp docs/wiki/images/admin-and-model-manager/01-admin-overview.png docs/wiki/images/admin/01-admin-overview.png
```

- [ ] **Step 2: Write `docs/wiki/Admin.md`**

```markdown
# Admin

**Admin** (`#/admin`) is a live watch console for the generation pipeline —
health checks and throughput at a glance, no logs required. It's reached
from the **Admin** pill in the top bar.

![Admin overview](images/admin/01-admin-overview.png)

The top of the page is three link-out cards — **About Castwright** (brand
story, tagline, app version), **Model Manager** (see
[Model Manager](Model-Manager)), and **Advanced configuration** (see
[Advanced Settings](Advanced-Settings)) — followed by the **LAN access**
card for pairing phones/tablets (see
[Mobile, Tablet & Companion App](Mobile-Tablet-and-Companion-App)).

Below that sits the actual console, three stacked sections:

- **Health** — one glanceable board covering GPU & VRAM, the voice engine,
  the analyzer, ASR, ffmpeg, and free disk, each as a green/amber/red dot
  with a plain-language label and a technical detail line. Re-checked every
  30 seconds; a failed refresh just leaves the last good board in place
  rather than blanking out.
- **Generation throughput** — per-chapter RTF (real-time factor: synth-wall
  time ÷ audio duration; under 1.0 means faster than real-time) for the
  current session, newest first, with an up/down arrow flagging whether a
  chapter ran slower or faster than the one before it.
- **Resource trends** — the same per-chapter history plotted as VRAM and
  wall-time alongside RTF, grouped by book, with a small inline sparkline —
  useful for spotting a slow VRAM climb before it turns into a spill or an
  out-of-memory recycle.

> Running the dev build (`npm run dev`) adds a fourth, dev-only
> **Worktrees** section listing every git worktree and a live port probe —
> it doesn't appear in a production build.

Next: [Model Manager](Model-Manager).
```

- [ ] **Step 3: Verify the image reference resolves**

```bash
node -e "
const fs = require('fs');
const md = fs.readFileSync('docs/wiki/Admin.md', 'utf8');
const refs = [...md.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(m => m[1]);
const path = require('path');
for (const ref of refs) if (!fs.existsSync(path.join('docs/wiki', ref))) throw new Error('missing: ' + ref);
console.log('OK:', refs.length);
"
```

Expected: `OK: 1`

- [ ] **Step 4: Commit**

```bash
git add docs/wiki/Admin.md docs/wiki/images/admin/
git commit -m "docs(docs): add Admin.md wiki page (split from Admin-and-Model-Manager)"
```

---

## Task 5: Advanced Settings scenes

**Files:**
- Modify: `e2e/marketing/scenes.ts:161-175` (rename `advanced-settings` scene) and append 10 new scenes

**Interfaces:**
- Consumes: `Scene.strict` (Task 1)
- Produces: 11 scene ids for Task 6 — `adv-tts-engine` (renamed), `adv-analyzer-sampling`, `adv-analyzer-chunking`, `adv-analyzer-prompts`, `adv-analyzer-models`, `adv-tts-batching`, `adv-qa-gates`, `adv-audio-loudness`, `adv-gpu-lifecycle`, `adv-rate-limits`, `adv-lan-access`.

Every knob label renders as visible text (`src/components/settings/override-row.tsx:212`,
`<span>{descriptor.label}</span>`), confirmed directly against source — so
`waitForAfterAction: 'text=<some knob label unique to this group>'` reliably
confirms the section actually expanded. **Critical ordering note: `waitFor`
runs BEFORE `action` in the harness, `waitForAfterAction` runs after** — every
scene below uses `waitForAfterAction` (not `waitFor`) for its post-click
confirmation, since the target only exists once the section is open.

- [ ] **Step 1: Rename the existing scene and add `strict`**

Change:

```ts
  {
    id: 'advanced-settings',
    hash: '#/advanced',
    viewports: ['desktop'],
    action: async (page) => {
      // "Voice engine & device" also renders as the accordion section's own
      // header button and (hidden on desktop) as a mobile <option> inside
      // the lg:hidden dropdown — scope to the left-rail <nav
      // aria-label="Settings sections"> so the match is unambiguous.
      await page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByText('Voice engine & device', { exact: true })
        .click({ timeout: 5000 });
    },
  },
```

to:

```ts
  {
    id: 'adv-tts-engine',
    hash: '#/advanced',
    viewports: ['desktop'],
    action: async (page) => {
      // "Voice engine & device" also renders as the accordion section's own
      // header button and (hidden on desktop) as a mobile <option> inside
      // the lg:hidden dropdown — scope to the left-rail <nav
      // aria-label="Settings sections"> so the match is unambiguous.
      await page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByText('Voice engine & device', { exact: true })
        .click({ timeout: 5000 });
    },
    waitForAfterAction: 'text=Accelerator profile',
    strict: true,
  },
```

- [ ] **Step 2: Add the 10 new Advanced Settings scenes**

Add immediately after the renamed scene. Each clicks its group's exact `label` string from `server/src/config/registry.ts`'s `GROUPS` array, then confirms via a knob label unique to that group's *inner content* (not the section's own title, which is also the always-visible nav/header text and would pass trivially whether or not the click worked):

```ts
  {
    id: 'adv-analyzer-sampling',
    hash: '#/advanced',
    viewports: ['desktop'],
    action: async (page) => {
      await page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByText('LLM sampling parameters', { exact: true })
        .click({ timeout: 5000 });
    },
    waitForAfterAction: 'text=Ollama temperature',
    strict: true,
  },
  {
    id: 'adv-analyzer-chunking',
    hash: '#/advanced',
    viewports: ['desktop'],
    action: async (page) => {
      await page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByText('Analyzer chunking & truncation guards', { exact: true })
        .click({ timeout: 5000 });
    },
    waitForAfterAction: 'text=Stage-2 chunk char budget',
    strict: true,
  },
  {
    id: 'adv-analyzer-prompts',
    hash: '#/advanced',
    viewports: ['desktop'],
    action: async (page) => {
      await page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByText('Analyzer prompts & skills', { exact: true })
        .click({ timeout: 5000 });
    },
    waitForAfterAction: 'text=Cast detection prompt',
    strict: true,
  },
  {
    id: 'adv-analyzer-models',
    hash: '#/advanced',
    viewports: ['desktop'],
    action: async (page) => {
      await page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByText('Analyzer models & endpoints', { exact: true })
        .click({ timeout: 5000 });
    },
    waitForAfterAction: 'text=Analyzer keep-alive',
    strict: true,
  },
  {
    id: 'adv-tts-batching',
    hash: '#/advanced',
    viewports: ['desktop'],
    action: async (page) => {
      await page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByText('Voice batching & throughput', { exact: true })
        .click({ timeout: 5000 });
    },
    waitForAfterAction: 'text=Qwen batch length bucketing',
    strict: true,
  },
  {
    id: 'adv-qa-gates',
    hash: '#/advanced',
    viewports: ['desktop'],
    action: async (page) => {
      await page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByText('Per-sentence QA gates', { exact: true })
        .click({ timeout: 5000 });
    },
    waitForAfterAction: 'text=Signal QA max re-records',
    strict: true,
  },
  {
    id: 'adv-audio-loudness',
    hash: '#/advanced',
    viewports: ['desktop'],
    action: async (page) => {
      await page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByText('Audio loudness targets', { exact: true })
        .click({ timeout: 5000 });
    },
    waitForAfterAction: 'text=Target LUFS',
    strict: true,
  },
  {
    id: 'adv-gpu-lifecycle',
    hash: '#/advanced',
    viewports: ['desktop'],
    action: async (page) => {
      await page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByText('GPU arbitration, memory & lifecycle', { exact: true })
        .click({ timeout: 5000 });
    },
    waitForAfterAction: 'text=GPU concurrency',
    strict: true,
  },
  {
    id: 'adv-rate-limits',
    hash: '#/advanced',
    viewports: ['desktop'],
    action: async (page) => {
      await page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByText('Gemini rate limits', { exact: true })
        .click({ timeout: 5000 });
    },
    waitForAfterAction: 'text=Gemma 4 31B RPM',
    strict: true,
  },
  {
    id: 'adv-lan-access',
    hash: '#/advanced',
    viewports: ['desktop'],
    action: async (page) => {
      await page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByText('LAN access & device tokens', { exact: true })
        .click({ timeout: 5000 });
    },
    waitForAfterAction: 'text=Device authorization lifetime',
    strict: true,
  },
```

> The 3 high-risk/collapsed-by-default groups (`adv-analyzer-prompts`,
> `adv-tts-engine`, `adv-gpu-lifecycle`) open from closed rather than
> re-triggering an already-open scroll — their `waitForAfterAction` targets
> content only visible once expanded, so `strict` mode correctly catches a
> click that didn't actually expand the section. All 11 knob-label strings
> above ("Ollama temperature", "Stage-2 chunk char budget", "Accelerator
> profile", etc.) were independently confirmed against
> `server/src/config/registry.ts` during this plan's own assumption-checker
> review, so they're accurate labels — just confirm each renders as expected
> in the live DOM if a capture fails.

- [ ] **Step 3: Capture all 11 scenes and confirm each passes strict mode**

Run `CAPTURE_SCENE=<id> npx playwright test --config=playwright.marketing.config.ts --project=desktop` for each of the 11 scene ids. Fix any selector mismatch against the live rendered label in `server/src/config/registry.ts`'s `GROUPS` array before proceeding.

- [ ] **Step 4: Commit**

```bash
git add e2e/marketing/scenes.ts
git commit -m "test(e2e): add Advanced Settings per-group scenes"
```

---

## Task 6: `Advanced-Settings.md` — full rewrite

**Files:**
- Create: `docs/wiki/images/advanced-settings/01-llm-sampling-parameters.png` through `11-lan-access-device-tokens.png` (renumbered; the existing accelerator-profile shot is re-shot as `05-voice-engine-device.png`)
- Modify: `docs/wiki/Advanced-Settings.md` (full rewrite)

**Interfaces:**
- Consumes: the 11 scene ids from Task 5.

- [ ] **Step 1: Capture and curate all 11 screenshots, renumbered in registry order**

```bash
npm run capture:marketing
cp mockups/marketing-screens/adv-analyzer-sampling.desktop.light.png docs/wiki/images/advanced-settings/01-llm-sampling-parameters.png
cp mockups/marketing-screens/adv-analyzer-chunking.desktop.light.png docs/wiki/images/advanced-settings/02-analyzer-chunking-truncation.png
cp mockups/marketing-screens/adv-analyzer-prompts.desktop.light.png docs/wiki/images/advanced-settings/03-analyzer-prompts-skills.png
cp mockups/marketing-screens/adv-analyzer-models.desktop.light.png docs/wiki/images/advanced-settings/04-analyzer-models-endpoints.png
cp mockups/marketing-screens/adv-tts-engine.desktop.light.png docs/wiki/images/advanced-settings/05-voice-engine-device.png
cp mockups/marketing-screens/adv-tts-batching.desktop.light.png docs/wiki/images/advanced-settings/06-voice-batching-throughput.png
cp mockups/marketing-screens/adv-qa-gates.desktop.light.png docs/wiki/images/advanced-settings/07-per-sentence-qa-gates.png
cp mockups/marketing-screens/adv-audio-loudness.desktop.light.png docs/wiki/images/advanced-settings/08-audio-loudness-targets.png
cp mockups/marketing-screens/adv-gpu-lifecycle.desktop.light.png docs/wiki/images/advanced-settings/09-gpu-arbitration-memory-lifecycle.png
cp mockups/marketing-screens/adv-rate-limits.desktop.light.png docs/wiki/images/advanced-settings/10-gemini-rate-limits.png
cp mockups/marketing-screens/adv-lan-access.desktop.light.png docs/wiki/images/advanced-settings/11-lan-access-device-tokens.png
git rm docs/wiki/images/advanced-settings/01-accelerator-profile.png
```

- [ ] **Step 2: Rewrite `docs/wiki/Advanced-Settings.md`**

Replace the entire file content with:

```markdown
# Advanced Settings

**Advanced configuration** (`#/advanced`) is where every tunable model,
generation, and QA knob lives — reached from Admin's **Advanced
configuration →** card or [Model Manager](Model-Manager)'s own pointer of
the same name. Everything here persists on disk and survives server
restarts; the page itself warns you're tuning "at your own risk."

The knobs are grouped into a collapsible, side-nav-indexed accordion:
LLM sampling parameters, analyzer chunking & truncation, analyzer prompts &
skills, analyzer models & endpoints, voice engine & device, voice batching &
throughput, per-sentence QA gates, audio loudness targets, GPU arbitration &
memory, Gemini rate limits, and LAN access & device tokens — 97 knobs
across 11 groups in total. High-risk groups (marked with a small warning
glyph) start collapsed; the rest start open.

- **Reset all** (top-right) and a per-section **Reset section** button
  (once that section has at least one overridden value) both revert to
  shipped defaults, no partial-reset trap.
- Prompt-shaped knobs (group 3, below) render as an **Edit** / **Revert to
  default** pair instead of a form control — editing forks the prompt to
  your own copy; a `Using your fork` vs. `Using shipped default` chip
  always shows which one is active.
- A **Restart sidecar** banner appears the moment a sidecar-scoped change is
  pending, and a plainer amber banner appears for changes that need a full
  app restart instead. If `CUDA_VISIBLE_DEVICES` / `CUDA_DEVICE_ORDER` is
  set in `server/.env`, a banner explains that env var overrides every
  per-engine device pin in group 5, with a link to switch to per-engine pins.

Apply-tag legend used in every table below: **live** (takes effect
immediately), **restart · sidecar** (needs the TTS sidecar restarted),
**restart · app** (needs the whole app restarted), **rebuilds env** (rebuilds
the Python virtual environment — not instant). A **.env** pill instead of any
of these means the value is locked by an environment variable and the field
is disabled.

## 1. LLM sampling parameters

![LLM sampling parameters](images/advanced-settings/01-llm-sampling-parameters.png)

| Knob | What it does | Default | Range | Apply | Risk |
|---|---|---|---|---|---|
| Ollama temperature | Sampling temperature for the first analysis attempt | 0.2 | 0–2, step 0.1 | live | medium |
| Ollama retry temperature | Temp used on invalid-JSON retries | 0.6 | 0–2, step 0.1 | live | medium |
| Ollama num_predict | Output-token cap for Ollama; -1 = predict until context fills | -1 | integer, min -1 | live | medium |
| Gemini max output tokens | Per-request output-token cap for Gemini | 8192 | 256–32768 | live | medium |
| Ollama num_ctx | Context-window size sent on every /api/chat call | 32768 | integer, min 0 | live | medium |
| Ollama num_gpu | GPU layers for Ollama (999 = all) | 999 | integer, min 0 | live | medium |

## 2. Analyzer chunking & truncation guards

![Analyzer chunking & truncation guards](images/advanced-settings/02-analyzer-chunking-truncation.png)

| Knob | What it does | Default | Range | Apply | Risk |
|---|---|---|---|---|---|
| Stage-2 chunk char budget | Max chars per stage-2 attribution chunk before pre-emptive split | 9000 | integer | live | medium |
| Stage-1 chunk char budget | Max chars per stage-1 cast-detection chunk before split | 24000 | integer | live | medium |
| Coverage min ratio | Attributed/source word-ratio floor → treated as truncated | 0.6 | 0–1, step 0.05 | live | medium |
| Coverage max ratio | Ratio ceiling → treated as a repeat-loop | 1.6 | 1–5, step 0.1 | live | medium |
| Ending tail words | Trailing source words required present for "ending found" | 8 | integer | live | medium |
| Min duplicated-sentence run | Smallest contiguous dup run flagged as repeat-loop | 4 | integer | live | medium |
| Coverage-guard retries | Re-runs when stage-2 coverage fails; 0 disables the guard | 2 | integer | live | medium |

## 3. Analyzer prompts & skills

![Analyzer prompts & skills](images/advanced-settings/03-analyzer-prompts-skills.png)

**High risk, starts collapsed.** All 6 rows are prompt-shaped — an Edit /
Revert-to-default pair, not a form control. Editing forks the prompt to
your own on-disk copy; nothing here changes until you explicitly edit.

| Knob | What it does | Default (shipped file) |
|---|---|---|
| Cast detection prompt | Phase-0 cast-detection skill sent to the model | `skills/audiobook-character-detection-per-chapter.md` |
| Sentence attribution prompt | Phase-1 sentence-attribution skill | `skills/audiobook-sentence-attribution.md` |
| Emotion annotation prompt | Per-quote emotion-annotation skill | `skills/audiobook-emotion-annotation.md` |
| Script review prompt | Per-chapter script-review ops skill | `skills/audiobook-script-review.md` |
| Instruct-annotation prompt | Delivery-direction / vocalization-flag skill | `skills/audiobook-instruct-annotation.md` |
| Voice-style prompt | Voice-persona-generation skill (one call/cast member) | `skills/audiobook-voice-style.md` |

## 4. Analyzer models & endpoints

![Analyzer models & endpoints](images/advanced-settings/04-analyzer-models-endpoints.png)

> **Not the same knob as [Model Manager](Model-Manager)'s "Analyzer
> engine."** This one is the server/env-level config knob (defaults to
> `local` — see `server/.env.example`); Model Manager's is your per-account
> preference (defaults to `gemini`), which takes precedence when set. Same
> English label, two different controls.

| Knob | What it does | Default | Range | Apply | Risk |
|---|---|---|---|---|---|
| Analyzer engine | "local" routes through Ollama (auto-falls back to Gemini when Ollama is unreachable and a key is set); "gemini" always goes direct | `local` | local / gemini | live | medium |
| Ollama URL | Base URL of the local Ollama daemon | `http://localhost:11434` | string | live | medium |
| Ollama model | Model tag for the /api/chat fallback | `qwen3.5:4b` | string | live | medium |
| Gemini analyzer model | Model used directly or as Ollama-unreachable fallback | `gemma-4-31b-it` | string | live | medium |
| Voice-style model | Model used to design each cast member's voice persona | `gemini-3.1-flash-lite` | string | live | medium |
| Persona generation engine | gemini (default, locked quality) vs local persona design | `gemini` | local / gemini | live | medium |
| Persona local model | Ollama tag when persona engine=local; blank inherits analyzer model | (blank) | string | live | low |
| Phase-0 model override | Drives cast detection with a distinct model | (blank) | string | live | medium |
| Phase-1 model override | Drives sentence attribution with a distinct model | (blank) | string | live | medium |
| Phase-1 minimum lag (chapters) | Min completed Phase-0 chapters before Phase-1 dispatch starts; 0 releases lag | 10 | integer, min 0 | live | medium |
| Analyzer keep-alive | How long Ollama holds the resident analyzer model warm | `5m` | string (Ollama keep_alive syntax) | live | medium |

## 5. Voice engine & device

![Voice engine & device](images/advanced-settings/05-voice-engine-device.png)

**High risk, starts collapsed.** The headline knob is **Accelerator
profile**: `auto` (default) detects your hardware and picks NVIDIA/CUDA,
AMD/ROCm-DirectML, Apple/Metal, or CPU; pinning overrides that detection.
Changing it rebuilds the Python virtual environment and restarts the
sidecar — not instant, but your books/cast/voices are untouched.

| Knob | What it does | Default | Range | Apply | Risk |
|---|---|---|---|---|---|
| Accelerator profile | Which GPU stack all voice engines install+run on | `auto` | auto / nvidia / amd / cpu | rebuilds env | high |
| Coqui device | Device for Coqui XTTS v2 | `auto` | device dropdown | restart · sidecar | high |
| Kokoro device | Device for Kokoro (onnxruntime) | `auto` | device dropdown | restart · sidecar | high |
| Qwen device | PyTorch device for Qwen3-TTS | `auto` | device dropdown | restart · sidecar | high |
| Qwen attention impl | sdpa (default) vs flash_attention_2 | `sdpa` | sdpa / flash_attention_2 | restart · sidecar | high |
| Preload Coqui at startup | Eager-load Coqui at boot (~3GB VRAM) | `false` | boolean | restart · sidecar | high |
| Preload Kokoro at startup | Eager-load Kokoro at boot (~1GB VRAM) | `true` | boolean | restart · sidecar | high |
| Preload Qwen at startup | Eager-load Qwen Base at boot (~1.2GB VRAM) | `false` | boolean | restart · sidecar | high |
| Preload Qwen 1.7B-Base at startup | Eager-load 1.7B-Base for anchored emotion variants (~3.4GB) | `false` | boolean | restart · sidecar | high |

A read-only **Analyzer (Ollama) device** row appears at the end of this
group when the local analyzer is active — Ollama's device isn't
app-pinnable, so it just reports what the daemon is currently doing.

## 6. Voice batching & throughput

![Voice batching & throughput](images/advanced-settings/06-voice-batching-throughput.png)

| Knob | What it does | Default | Range | Apply | Risk |
|---|---|---|---|---|---|
| Qwen batch size | Hard width cap for sentences packed per Qwen forward; 1 disables batching | 32 | integer, min 1 | restart · app | medium |
| Qwen batch token budget | Variable-width packing budget; 0 = fixed-width only | 3600 | integer, min 0 | restart · app | medium |
| Qwen 1.7B batch size | Hard width cap for the 1.7B Quality tier | 32 | integer, min 1 | restart · app | medium |
| Qwen 1.7B batch token budget | Packing budget for the 1.7B tier | 3600 | integer, min 0 | restart · app | medium |
| Qwen batch length bucketing | Sort batchable groups by length before slicing | `true` | boolean | restart · app | medium |
| Generation workers | Chapters synthesised concurrently by the generation queue | 1 | integer, 1–4 | restart · app | medium |

## 7. Per-sentence QA gates

![Per-sentence QA gates](images/advanced-settings/07-per-sentence-qa-gates.png)

Group risk is **low** overall, but 3 knobs in this group are individually
**medium** risk (Voice-QA device, Content-QA device, Auto-fix voice
mismatches) — the table's risk column shows each correctly.

| Knob | What it does | Default | Range | Apply | Risk |
|---|---|---|---|---|---|
| Signal QA max re-records | Re-record budget for a suspect sentence; 0 disables gate | 2 | integer | live | low |
| Silence RMS threshold | RMS at/below = dead/near-silent | 0.003 | 0–0.1, step 0.001 | live | low |
| Noise floor | Amplitude below which counted silent | 0.01 | 0–0.1, step 0.001 | live | low |
| Max internal silence (s) | Longest near-silent run → suspect | 1.5 | 0.1–10, step 0.1 | live | low |
| Duration min ratio | Duration/expected ratio below = truncated | 0.4 | 0–5, step 0.1 | live | low |
| Duration max ratio | Ratio above = runaway/garbled | 2.5 | 0–5, step 0.1 | live | low |
| Runaway absolute floor (s) | Min audio length before "runaway" can fire; 0 disables | 3.0 | 0–30, step 0.5 | live | low |
| ASR QA enabled | Enable Whisper-based content verification | `false` | boolean | live | low |
| ASR max re-records | Re-record budget for ASR drift; 0 = flag only | 2 | integer | live | low |
| ASR sample rate | Transcribe 1-in-N sentences | 1 | integer | live | low |
| ASR max WER | Word-error-rate threshold for drift | 0.4 | 0–1, step 0.05 | live | low |
| ASR max WER (Spanish) | Spanish-specific WER cap | 0.4 | 0–1, step 0.05 | live | low |
| ASR max WER (Russian) | Russian-specific WER cap | 0.4 | 0–1, step 0.05 | live | low |
| Render-integrity QA (voice match) | ECAPA speaker-embed match check per rendered line | `false` | boolean | live | low |
| Voice-QA device | cpu (0 VRAM) vs cuda for the ECAPA embed | `cpu` | string | restart · sidecar | **medium** |
| Content-QA (Whisper) device | cpu vs cuda for Whisper | `cpu` | string | restart · sidecar | **medium** |
| Auto-fix voice mismatches | Re-render+replace severe voice mismatches | `false` | boolean | live | **medium** |
| ASR max deletion run | Longest deletion run → truncation/drop drift | 4 | integer | live | low |
| ASR min chars | Sentences shorter than this aren't scored | 12 | integer | live | low |
| ASR min reference words | 2-word single-sub mismatches routed to inconclusive; 0 disables | 2 | 0–10 | live | low |
| ASR max compound-bridge run | Token-run length rejoined to one manuscript token | 3 | 2–4 | live | low |
| ASR 1-word homophone tolerance | 1-word single-edit substitution treated as spelling variant | `true` | boolean | live | low |
| ASR max compression ratio | Whisper compression_ratio above = loop/hallucination | 2.4 | 1–10, step 0.1 | live | low |
| ASR min avg log-prob | Below this, transcript untrustworthy | -1.0 | -5–0, step 0.1 | live | low |
| ASR max no-speech prob | Above this, transcript untrustworthy | 0.6 | 0–1, step 0.05 | live | low |

## 8. Audio loudness targets

![Audio loudness targets](images/advanced-settings/08-audio-loudness-targets.png)

| Knob | What it does | Default | Range | Apply | Risk |
|---|---|---|---|---|---|
| Loudnorm enabled | Enable EBU R128 two-pass loudness normalization | `true` | boolean | live | low |
| Target LUFS | Integrated loudness target (-16 = Audible/ACX spec) | -16 | number | live | low |
| Loudness range (LRA) | Target loudness range in LU (11 = audiobook standard) | 11 | number | live | low |
| True-peak ceiling (dBTP) | True-peak ceiling; leaves codec headroom | -1.5 | number | live | low |

## 9. GPU arbitration, memory & lifecycle

![GPU arbitration, memory & lifecycle](images/advanced-settings/09-gpu-arbitration-memory-lifecycle.png)

**High risk, starts collapsed.** One knob in this group is individually
**medium** risk (Per-card VRAM free floor) — everything else is high.

| Knob | What it does | Default | Range | Apply | Risk |
|---|---|---|---|---|---|
| GPU concurrency | Max concurrent GPU ops (fallback when VRAM budget unset) | 1 | integer, min 1 | restart · app | high |
| GPU VRAM token budget | Total token budget for the weighted semaphore; 0 disables | 0 | integer, min 0 | restart · app | high |
| GPU weight: Kokoro | VRAM token cost per Kokoro op | 1 | integer, min 0 | live | high |
| GPU weight: Qwen | VRAM token cost per Qwen op | 1 | integer, min 0 | live | high |
| GPU weight: Coqui | VRAM token cost per Coqui op | 3 | integer, min 0 | live | high |
| GPU weight: Analyzer | VRAM token cost per Ollama op | 4 | integer, min 0 | live | high |
| GPU weight: ASR (Whisper) | VRAM token cost per Whisper op (cuda only) | 1 | integer, min 0 | live | high |
| GPU weight: Speaker embed (ECAPA) | VRAM token cost per ECAPA op (cuda only) | 1 | integer, min 0 | live | high |
| Safe analyzer+TTS coexistence VRAM (MB) | Below this, evict resident Ollama before sidecar TTS load; 0 = always evict | 11000 | integer, min 0 | live | high |
| Qwen VoiceDesign idle TTL (s) | Idle secs before freeing transient VoiceDesign model (~4-5GB) | 120 | integer, min 0 | restart · sidecar | high |
| Qwen 1.7B-Base idle TTL (s) | Idle secs before freeing resident 1.7B-Base (~3.4GB) | 120 | integer, min 0 | restart · sidecar | high |
| ASR (Whisper) idle TTL (s) | Idle secs before freeing Whisper model | 120 | integer, min 0 | restart · sidecar | high |
| Speaker-embed (ECAPA) idle TTL (s) | Idle secs before freeing ECAPA model | 120 | integer, min 0 | restart · sidecar | high |
| Disable torch MKLDNN | Curb variable-shape CPU host-RAM leak; no-op on CUDA | `false` | boolean | restart · sidecar | high |
| Soft recycle threshold (MB committed RAM) | Clean chapter-boundary recycle trigger; 0 disables | 0 | integer, min 0 | restart · sidecar | high |
| Hard restart threshold (MB committed RAM) | Sidecar self-exits at this RAM; 0 = auto (70% of total) | 0 | integer, min 0 | restart · sidecar | high |
| Soft VRAM recycle threshold (MB reserved) | Recycle trigger; 0 = auto (90% of device VRAM) | 0 | integer, min 0 | restart · sidecar | high |
| Hard VRAM restart threshold (MB reserved) | Self-exits to reset CUDA context; 0 = auto (98% of VRAM) | 0 | integer, min 0 | restart · sidecar | high |
| Per-card VRAM free floor (MB) | Absolute free-VRAM floor before recycle | 1024 | integer, min 0 | restart · sidecar | **medium** |

## 10. Gemini rate limits

![Gemini rate limits](images/advanced-settings/10-gemini-rate-limits.png)

| Knob | What it does | Default | Range | Apply | Risk |
|---|---|---|---|---|---|
| Gemma 4 31B RPM | Requests-per-minute cap | 15 | integer, min 1 | restart · app | low |
| Gemma 4 31B TPM | Input-tokens-per-minute cap; 0 = unlimited sentinel | 0 | integer, min 0 | restart · app | low |
| Gemma 4 31B RPD | Requests-per-day cap | 1500 | integer, min 1 | restart · app | low |

## 11. LAN access & device tokens

![LAN access & device tokens](images/advanced-settings/11-lan-access-device-tokens.png)

| Knob | What it does | Default | Range | Apply | Risk |
|---|---|---|---|---|---|
| Device authorization lifetime (days) | How long a browser/device authorization stays valid before re-pairing | 30 | integer, min 1 | live | low |

Next: [Account & Settings](Account-and-Settings).
```

- [ ] **Step 3: Verify every image reference resolves**

```bash
node -e "
const fs = require('fs');
const path = require('path');
const md = fs.readFileSync('docs/wiki/Advanced-Settings.md', 'utf8');
const refs = [...md.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(m => m[1]);
for (const ref of refs) if (!fs.existsSync(path.join('docs/wiki', ref))) throw new Error('missing: ' + ref);
console.log('OK:', refs.length);
"
```

Expected: `OK: 11`

- [ ] **Step 4: Commit**

```bash
git add docs/wiki/Advanced-Settings.md docs/wiki/images/advanced-settings/
git commit -m "docs(docs): rewrite Advanced-Settings.md with full per-group detail"
```

---

## Task 7: Retire the old page, image reorg, and cross-link updates

**Files:**
- Delete: `docs/wiki/Admin-and-Model-Manager.md`, `docs/wiki/images/admin-and-model-manager/`
- Modify: `docs/wiki/_Sidebar.md`, `docs/wiki/Mobile-Tablet-and-Companion-App.md`, `docs/wiki/Account-and-Settings.md`

- [ ] **Step 1: Delete the old page and its (now-copied) image directory**

```bash
git rm docs/wiki/Admin-and-Model-Manager.md
git rm -r docs/wiki/images/admin-and-model-manager/
```

- [ ] **Step 2: Update `_Sidebar.md`**

Change:

```markdown
- [Admin & Model Manager](Admin-and-Model-Manager)
```

to:

```markdown
- [Admin](Admin)
- [Model Manager](Model-Manager)
```

- [ ] **Step 3: Update `Mobile-Tablet-and-Companion-App.md`**

Change line 16 (LAN access card reference):

```markdown
mode is running — see the LAN access card on the [Admin & Model
Manager](Admin-and-Model-Manager) page.
```

to:

```markdown
mode is running — see the LAN access card on the [Admin](Admin) page.
```

Change line 55 ("Next:"):

```markdown
Next: [Admin & Model Manager](Admin-and-Model-Manager).
```

to:

```markdown
Next: [Admin](Admin).
```

- [ ] **Step 4: Update `Account-and-Settings.md`**

Change both occurrences of:

```markdown
[Model Manager](Admin-and-Model-Manager)
```

to:

```markdown
[Model Manager](Model-Manager)
```

- [ ] **Step 5: Grep-verify no remaining references to the old page**

Run: `grep -rn "Admin-and-Model-Manager" docs/wiki/`
Expected: no output (empty).

- [ ] **Step 6: Commit**

```bash
git add docs/wiki/_Sidebar.md docs/wiki/Mobile-Tablet-and-Companion-App.md docs/wiki/Account-and-Settings.md
git commit -m "docs(docs): retire Admin-and-Model-Manager.md, fix cross-links"
```

---

## Task 8: #1318 Tier A scenes — simple clicks, no new fixture data

**Files:**
- Modify: `e2e/marketing/scenes.ts` (append 8 new scenes, add `action` to 2 existing scenes)
- Modify: `docs/wiki/Manuscript-Management.md`, `docs/wiki/Reviewing-Cast-and-Assigning-Voices.md`, `docs/wiki/Reviewing-Low-Confidence-Speaker-Tags.md`, `docs/wiki/Designing-a-Voice.md`, `docs/wiki/The-Model-Control-Pill.md`, `docs/wiki/Listening-and-Revising.md`, `docs/wiki/Exporting.md`, `docs/wiki/Mobile-Tablet-and-Companion-App.md`

**Interfaces:**
- Consumes: `Scene.strict` (Task 1)
- Produces: scene ids `manuscript-review-script`, `cast-ab-compare`, `voice-design-scope-picker`, `model-pill-idle`, `listen-share-clip`, `export-format-companion`, `mobile-lan-qr`, `mobile-pair-device`, `export-lan-qr`, plus an `action` added to the existing `coalfall-manuscript-low-confidence` scene.

All testids/button-names below were re-verified directly against source
during this plan's own assumption-checker review (round 1 caught several
wrong/invented ones — e.g. `script-review-diff`, `voice-compare-modal`,
`lan-access-qr`, `segment-inspector`, and an `"Export"` exact-name match
that doesn't exist, don't reuse those strings). Every scene with an
`action` uses `waitForAfterAction` (checked after the click, per Task 1),
never `waitFor` (checked before) — using `waitFor` here would make the
scene fail before the click even runs.

- [ ] **Step 1: Add the new scenes**

```ts
  {
    id: 'manuscript-review-script',
    hash: '#/books/coalfall-commission/manuscript?chapter=3',
    viewports: ['desktop'],
    action: async (page) => {
      await page.getByTestId('review-script-chapter').click({ timeout: 5000 });
    },
    waitForAfterAction: '[data-testid="apply-button"]',
    strict: true,
  },
  {
    id: 'cast-ab-compare',
    hash: '#/books/hollow-tide-2/cast?profile=insp-cray',
    viewports: ['desktop'],
    action: async (page) => {
      await page.getByRole('button', { name: /Design & compare/i }).first().click({ timeout: 5000 });
    },
    waitForAfterAction: '[data-testid="voice-compare-persona"]',
    strict: true,
  },
  {
    id: 'voice-design-scope-picker',
    hash: '#/books/hollow-tide-2/cast',
    viewports: ['desktop'],
    action: async (page) => {
      await page.getByRole('button', { name: 'Design full cast' }).click({ timeout: 5000 });
    },
    waitForAfterAction: '[data-testid="design-scope-picker"]',
    strict: true,
  },
  {
    id: 'model-pill-idle',
    hash: '#/models',
    viewports: ['desktop'],
    waitFor: '[data-testid="model-row-ollama:llama3.1:8b"]',
    scrollTo: '[data-testid="model-row-ollama:llama3.1:8b"]',
    strict: true,
  },
  {
    id: 'listen-share-clip',
    hash: '#/books/hollow-tide-1/listen',
    viewports: ['desktop'],
    action: async (page) => {
      await page.getByRole('button', { name: /Share clip of chapter/i }).first().click({ timeout: 5000 });
    },
    waitForAfterAction: '[data-testid="share-clip-modal"]',
    strict: true,
  },
  {
    id: 'export-format-companion',
    hash: '#/books/hollow-tide-1/listen',
    viewports: ['desktop'],
    waitFor: '[data-testid="companion-app-banner"]',
    scrollTo: '[data-testid="companion-app-banner"]',
    strict: true,
  },
  {
    id: 'mobile-lan-qr',
    hash: '#/admin',
    viewports: ['desktop'],
    action: async (page) => {
      await page.getByRole('button', { name: 'Authorize a device' }).click({ timeout: 5000 });
    },
    waitForAfterAction: '[data-testid="pair-qr-image"]',
    strict: true,
  },
  {
    id: 'mobile-pair-device',
    hash: '#/books/hollow-tide-1/listen',
    viewports: ['desktop'],
    action: async (page) => {
      await page.getByRole('button', { name: 'Pair a device with the Castwright Companion' }).click({ timeout: 5000 });
    },
    waitForAfterAction: '[data-testid="pair-device-modal"]',
    strict: true,
  },
  {
    id: 'export-lan-qr',
    hash: '#/books/hollow-tide-1/listen',
    viewports: ['desktop'],
    action: async (page) => {
      await page.getByRole('button', { name: 'Export audiobook', exact: true }).first().click({ timeout: 5000 });
      await page.getByRole('tab', { name: 'Download' }).click({ timeout: 5000 });
    },
    waitForAfterAction: '[data-testid="export-tab-download"]',
    strict: true,
  },
```

> **Fixed from an earlier draft of this plan**: `mobile-lan-qr`'s target was
> `lan-access-qr`, which doesn't exist — `lan-access-card.tsx` has no
> testids at all; it renders `<PairingQr />`, whose own QR image carries
> `data-testid="pair-qr-image"` (`pairing-qr.tsx:49`), used above instead.
> `export-lan-qr`'s button name was `'Export'` (doesn't match anything —
> the real control reads **"Export audiobook"**, `listen-header.tsx:289`),
> and its tab testid was `export-download-tab` (real: `export-tab-download`,
> built as `` `export-tab-${t.id}` `` at `export-audiobook.tsx:394`).
> `manuscript-review-script`'s target was `script-review-diff` (doesn't
> exist) — `apply-button` (`script-review-diff.tsx:538`) only renders when
> there's a real diff to apply, which chapter 3's queued ops guarantee.
> `cast-ab-compare`'s target was `voice-compare-modal` (the modal root has
> no testid) — `voice-compare-persona` (`voice-compare-modal.tsx:282`) is a
> real child element that only renders once the modal opens.

- [ ] **Step 2: Add a click to the existing `coalfall-manuscript-low-confidence` scene**

Change:

```ts
  {
    id: 'coalfall-manuscript-low-confidence',
    hash: '#/books/coalfall-commission/manuscript?chapter=3',
    viewports: ['desktop'],
  },
```

to:

```ts
  {
    id: 'coalfall-manuscript-low-confidence',
    hash: '#/books/coalfall-commission/manuscript?chapter=3',
    viewports: ['desktop'],
    action: async (page) => {
      await page.getByRole('button', { name: 'Next low-confidence sentence' }).click({ timeout: 5000 });
    },
    waitForAfterAction: '[aria-label="Close inspector"]',
    strict: true,
  },
```

> **Fixed from an earlier draft**: `segment-inspector` as a testid doesn't
> exist anywhere in the codebase — `SegmentInspector`
> (`src/views/manuscript.tsx:1750`) has no root testid. Its close button's
> `aria-label="Close inspector"` (`manuscript.tsx:~1808`) is a stable,
> always-present-when-open target instead.

- [ ] **Step 3: Capture and confirm each scene passes strict mode**

Run `CAPTURE_SCENE=<id>` for each of the 9 scenes (8 new + the 1 modified). Fix any selector that doesn't match the live DOM.

- [ ] **Step 4: Curate screenshots into their wiki pages**

```bash
mkdir -p docs/wiki/images/manuscript-management docs/wiki/images/reviewing-cast-and-assigning-voices docs/wiki/images/designing-a-voice docs/wiki/images/the-model-control-pill docs/wiki/images/listening-and-revising docs/wiki/images/exporting docs/wiki/images/mobile-tablet-and-companion-app docs/wiki/images/reviewing-low-confidence-speaker-tags
cp mockups/marketing-screens/manuscript-review-script.desktop.light.png docs/wiki/images/manuscript-management/review-script-diff.png
cp mockups/marketing-screens/cast-ab-compare.desktop.light.png docs/wiki/images/reviewing-cast-and-assigning-voices/ab-compare.png
cp mockups/marketing-screens/voice-design-scope-picker.desktop.light.png docs/wiki/images/designing-a-voice/full-cast-scope-picker.png
cp mockups/marketing-screens/model-pill-idle.desktop.light.png docs/wiki/images/the-model-control-pill/idle-state.png
cp mockups/marketing-screens/listen-share-clip.desktop.light.png docs/wiki/images/listening-and-revising/share-clip-picker.png
cp mockups/marketing-screens/export-format-companion.desktop.light.png docs/wiki/images/exporting/format-tiles-companion-banner.png
cp mockups/marketing-screens/mobile-lan-qr.desktop.light.png docs/wiki/images/mobile-tablet-and-companion-app/lan-access-qr.png
cp mockups/marketing-screens/mobile-pair-device.desktop.light.png docs/wiki/images/mobile-tablet-and-companion-app/pair-a-device-modal.png
cp mockups/marketing-screens/export-lan-qr.desktop.light.png docs/wiki/images/exporting/lan-qr-download-tab.png
cp mockups/marketing-screens/coalfall-manuscript-low-confidence.desktop.light.png docs/wiki/images/reviewing-low-confidence-speaker-tags/segment-inspector.png
```

- [ ] **Step 5: Update each wiki page**

In each of the 8 pages, find the inline "tracked as a follow-up" note matching the state now captured (per #1318's own body — e.g. "the Review Script diff view" on `Manuscript-Management.md`) and replace it with a real `![...](images/...)` reference plus one sentence of caption prose, following the existing prose style of that page. Do this for all 8 pages listed in the Files section above (one screenshot insertion each, two for `Exporting.md` and `Mobile-Tablet-and-Companion-App.md`).

- [ ] **Step 6: Verify all new image references resolve (run per touched page)**

```bash
for f in Manuscript-Management Reviewing-Cast-and-Assigning-Voices Reviewing-Low-Confidence-Speaker-Tags Designing-a-Voice The-Model-Control-Pill Listening-and-Revising Exporting Mobile-Tablet-and-Companion-App; do
  node -e "
    const fs = require('fs'); const path = require('path');
    const md = fs.readFileSync('docs/wiki/$f.md', 'utf8');
    const refs = [...md.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(m => m[1]);
    for (const ref of refs) if (!fs.existsSync(path.join('docs/wiki', ref))) throw new Error('$f missing: ' + ref);
    console.log('$f OK:', refs.length);
  "
done
```

- [ ] **Step 7: Commit**

```bash
git add e2e/marketing/scenes.ts docs/wiki/
git commit -m "docs(docs): close 10 of 11318's Tier A screenshot items"
```

---

## Task 9: #1318 Tier B scenes — timing-sensitive captures

**Files:**
- Modify: `e2e/marketing/scenes.ts` (append 2 scenes)
- Modify: `docs/wiki/Designing-a-Voice.md`, `docs/wiki/The-Model-Control-Pill.md`

**Interfaces:**
- Consumes: `Scene.strict`
- Produces: `voice-design-in-progress`, `model-pill-loading`

These two scenes must screenshot a *transient* state (mid-design, mid-load) — `strict: true` here only guards that the click succeeded, not that the timing lands exactly right, so budget a few manual re-runs.

- [ ] **Step 1: Add the two scenes**

```ts
  {
    id: 'voice-design-in-progress',
    hash: '#/books/hollow-tide-2/cast',
    viewports: ['desktop'],
    action: async (page) => {
      await page.getByRole('button', { name: 'Design full cast' }).click({ timeout: 5000 });
      await page.getByRole('button', { name: /Confirm|Start design/i }).click({ timeout: 5000 });
    },
    waitForAfterAction: '[data-testid="design-waveform"]',
    strict: true,
  },
  {
    id: 'model-pill-loading',
    hash: '#/models',
    viewports: ['desktop'],
    action: async (page) => {
      await page.getByRole('button', { name: 'Load model' }).first().click({ timeout: 5000 });
    },
    waitForAfterAction: 'text=Loading…',
    strict: true,
  },
```

> **Fixed from an earlier draft**: `design-progress` as a root testid
> doesn't exist — the component (`src/components/design-progress.tsx`)
> only has child testids (`design-waveform` at line 80, `design-fill`,
> `design-elapsed`, `design-eta`); `design-waveform` is used above.
> `model-pill-loading` had no testid anywhere — `ModelControlPill.tsx`'s
> `actionFor()` (lines 124-139) returns `{ label: 'Loading…', disabled: true
> }` for the loading state, rendered as button text and folded into its
> `aria-label`, so `text=Loading…` is the real signal, confirmed directly
> against source. Since these capture a transient state, this
> `waitForAfterAction` is what makes it reliable — the screenshot fires
> once the loading text appears, not on a fixed timeout.

- [ ] **Step 2: Capture both scenes, re-running if the timing doesn't land**

Run `CAPTURE_SCENE=voice-design-in-progress` and `CAPTURE_SCENE=model-pill-loading`. If the screenshot shows the *completed* state instead of loading, the mock design/load call may be resolving faster than the screenshot's 300ms settle window (`capture.spec.ts`'s post-action `waitForTimeout(300)`) — check the mock's own artificial delay (`await wait(...)`) is long enough to be caught, or reduce the settle window for this scene specifically.

- [ ] **Step 3: Curate into wiki pages**

```bash
cp mockups/marketing-screens/voice-design-in-progress.desktop.light.png docs/wiki/images/designing-a-voice/design-in-progress.png
cp mockups/marketing-screens/model-pill-loading.desktop.light.png docs/wiki/images/the-model-control-pill/loading-state.png
```

Update `Designing-a-Voice.md` and `The-Model-Control-Pill.md` to reference these, replacing the relevant "tracked as a follow-up" notes.

- [ ] **Step 4: Verify image references and commit**

```bash
git add e2e/marketing/scenes.ts docs/wiki/
git commit -m "docs(docs): close 1318's Tier B timing-sensitive screenshots"
```

---

## Task 10: #1318 Tier C scene — boundary-drag simulation

**Files:**
- Modify: `e2e/marketing/scenes.ts` (append 1 scene)
- Modify: `docs/wiki/Manuscript-Management.md`

**Interfaces:**
- Consumes: `Scene.strict`
- Produces: `manuscript-boundary-drag`

- [ ] **Step 1: Add the scene, using Playwright mouse events (not `action`'s click helpers) to simulate the drag**

```ts
  {
    id: 'manuscript-boundary-drag',
    hash: '#/books/coalfall-commission/manuscript?chapter=3',
    viewports: ['desktop'],
    waitFor: '[data-tour-id="chapter-boundary"]',
    action: async (page) => {
      const handle = page.locator('[data-tour-id="chapter-boundary"]');
      const box = await handle.boundingBox();
      if (!box) throw new Error('boundary handle not found');
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y + 40, { steps: 10 });
      // Deliberately no mouse.up() — the screenshot must land mid-drag.
    },
    strict: true,
  },
```

> `data-tour-id="chapter-boundary"` is only emitted for the first boundary
> handle (`boundaryIdx === 1`, `src/views/manuscript.tsx:1663`) — fine here,
> since the scene just needs *a* boundary to drag, not a specific one.

- [ ] **Step 2: Capture and confirm the screenshot shows a mid-drag visual state**

Run: `CAPTURE_SCENE=manuscript-boundary-drag npx playwright test --config=playwright.marketing.config.ts --project=desktop`
Then open `mockups/marketing-screens/manuscript-boundary-drag.desktop.light.png` and confirm it visually shows the drag-in-progress affordance (not the static boundary). If it looks static, the drag distance/steps may need adjusting, or the manuscript view may need a `pointermove`-based simulation instead of `mouse.move` (check whether `src/views/manuscript.tsx`'s boundary handler listens for `pointermove` specifically rather than mouse events — Playwright's `page.mouse` dispatches real OS-level mouse events which most `pointermove` listeners also receive, but verify).

- [ ] **Step 3: Curate and update the wiki page**

```bash
cp mockups/marketing-screens/manuscript-boundary-drag.desktop.light.png docs/wiki/images/manuscript-management/boundary-drag.png
```

Update `Manuscript-Management.md`, replacing its "tracked as a follow-up" note for the boundary-drag interaction.

- [ ] **Step 4: Commit**

```bash
git add e2e/marketing/scenes.ts docs/wiki/
git commit -m "docs(docs): close 1318's Tier C boundary-drag screenshot"
```

---

## Task 11: #1318 Tier D — new marketing-only fixture data

**Files:**
- Modify: `src/mocks/marketing/hollow-tide.ts` (add an undesigned character, a new `HOLLOW_TIDE_LISTEN_PROGRESS` map with markers, and Russian + German books)
- Modify: `src/lib/api.ts` (add a `DEMO_CAPTURE` branch to `mockGetListenProgress`, ~line 1200)
- Modify: `e2e/marketing/scenes.ts` (append 5 scenes)
- Modify: `docs/wiki/Generating-Audio.md`, `docs/wiki/Listening-and-Revising.md`, `docs/wiki/Exporting.md`, `docs/wiki/Multi-language-Support.md`

**Interfaces:**
- Consumes: `Character`, `BookStateResponse`, `LibraryResponse`, `ListenProgress`, `ListenProgressMarker` types (`src/lib/types.ts` / `src/lib/api.ts`), the existing `HOLLOW_TIDE_BOOK_STATES` Map and `HOLLOW_TIDE_LIBRARY` object in `hollow-tide.ts`, and the existing `EXPORT_QUEUE` fixture (`src/data/export-queue.ts`, unmodified — already has an in-progress row).
- Produces: scene ids `generating-voice-readiness`, `listen-markers-rerecord`, `export-queue`, `language-detect-russian`, `language-cast-confirm-german`; new export `HOLLOW_TIDE_LISTEN_PROGRESS` from `hollow-tide.ts`.

- [ ] **Step 1: Add an undesigned Qwen-engine character**

The gate fires only for a character where `resolveVoiceStatus(...).lifecycle?.label === 'Needs voice'` **and** `lines > 0` (`src/store/voice-readiness-selectors.ts:26-40` — a 0-line undesigned character can never trigger it). Per `src/lib/voice-status.ts:94-112`, "Needs voice" requires the character to be Qwen-effective (`ttsEngine: 'qwen'`) with `!c.overrideTtsVoices?.qwen?.name` and no matched library voice — i.e. `voiceId`/`voiceState` should be **omitted entirely**, not set to a placeholder value.

**Corrected from an earlier draft of this plan**, which used `voiceId: null` and `voiceState: 'unassigned'` — both are type errors: the generated `Character` schema (`src/lib/api-types.ts:3533,3537`) declares `voiceId?: string` (not nullable) and `voiceState?: "generated" | "tuned" | "reused" | "locked"` (no `'unassigned'` member). Omitting both fields is the type-correct way to represent "not yet designed":

```ts
const undesignedExtra = (): Character => ({
  id: 'harbor-clerk',
  name: 'Harbor Clerk',
  role: 'Minor',
  color: '#9C8B6A',
  lines: 12,
  tone: { warmth: 0.5, pace: 0.5, authority: 0.3, emotion: 0.3 },
  description: 'Brief dockside functionary, one scene.',
  ttsEngine: 'qwen',
});
```

Add `undesignedExtra()` to whichever book's cast array is used by the `generating` scene (`hollow-tide-2`, per `scenes.ts:56`) — find that book's cast array in `HOLLOW_TIDE_BOOK_STATES` and append this character to it.

- [ ] **Step 2: Seed markers and a re-record marker**

`mockGetListenProgress` (`src/lib/api.ts:1200-1211`) has **no `DEMO_CAPTURE` branch today** — it only checks a runtime `MOCK_LISTEN_PROGRESS` map (empty in marketing capture mode) and an e2e-only `globalThis.__SEED_LISTEN_PROGRESS__` seam, then returns `null`. So markers need a real (small, additive) code change, not just a data addition to a book entry.

In `src/mocks/marketing/hollow-tide.ts`, add a new exported map using the real `ListenProgress`/`ListenProgressMarker` types (`src/lib/api.ts:2113-2131` — note `chapterId` is a `number` and `kind` is `'note' | 'rerecord'`, not the guessed shape from an earlier draft of this plan):

```ts
import type { ListenProgress } from '../../lib/api';

export const HOLLOW_TIDE_LISTEN_PROGRESS = new Map<string, ListenProgress>([
  [
    'hollow-tide-1',
    {
      chapterId: 1,
      currentSec: 83.5,
      updatedAt: '2026-07-01T10:00:00.000Z',
      markers: [
        {
          id: 'mk-1',
          chapterId: 1,
          sec: 42,
          label: 'Great line reading',
          kind: 'note',
          createdAt: '2026-07-01T09:55:00.000Z',
        },
        {
          id: 'mk-2',
          chapterId: 1,
          sec: 118,
          label: 'Mispronounced name — needs a re-record',
          kind: 'rerecord',
          createdAt: '2026-07-01T09:58:00.000Z',
        },
      ],
    },
  ],
]);
```

In `src/lib/api.ts`, add a `DEMO_CAPTURE` branch to `mockGetListenProgress` (following the exact same early-return pattern already used at lines 673, 695, 1168, 1309 for other DEMO_CAPTURE-gated mocks):

```ts
export async function mockGetListenProgress(bookId: string): Promise<ListenProgress | null> {
  await wait(15);
  if (DEMO_CAPTURE) return HOLLOW_TIDE_LISTEN_PROGRESS.get(bookId) ?? null;
  const fromMap = MOCK_LISTEN_PROGRESS.get(bookId);
  ...
```

(Add the `HOLLOW_TIDE_LISTEN_PROGRESS` import alongside the existing `HOLLOW_TIDE_LIBRARY`/`HOLLOW_TIDE_BOOK_STATES` imports at the top of `api.ts`.)

- [ ] **Step 3: Confirm the export queue's in-progress row is already present (no fixture change needed)**

`src/views/listen.tsx:133-136` falls back to the static `EXPORT_QUEUE` fixture (`src/data/export-queue.ts`) whenever `VITE_USE_MOCKS === 'true'` and there are no live jobs — true for marketing capture mode. That fixture already has an `in_progress` row (`ex3`, `progress: 0.42`). **No code or fixture change is needed for this item** — Task 11's `export-queue` scene (Step 5 below) just needs to land on the existing row.

- [ ] **Step 4: Add Russian and German books**

Follow the exact pattern of `COALFALL_CHAPTERS`/`HOLLOW_TIDE_BOOK_STATES`/`HOLLOW_TIDE_LIBRARY` (lines 261-445) to add two new minimal books — one Russian-language (port a chapter from `server/src/__fixtures__/the-coalfall-commission.ru.md`), one German-language (author one short chapter, following the same length/shape as the Coalfall fixture). Each needs: a `BookStateResponse` entry in `HOLLOW_TIDE_BOOK_STATES`, a matching `LibraryResponse` book entry in `HOLLOW_TIDE_LIBRARY`, and at least one character in its cast with a name in that language. Set each book's language field to `'ru'` / `'de'` per whatever field `src/lib/types.ts`'s `BookStateResponse`/`LibraryResponse` uses for language (check before writing — likely `language` on the book-meta shape).

- [ ] **Step 5: Add the 5 scenes**

```ts
  {
    id: 'generating-voice-readiness',
    hash: '#/books/hollow-tide-2/generate',
    viewports: ['desktop'],
    waitFor: '[data-testid="voice-readiness-gate"]',
    strict: true,
  },
  {
    id: 'listen-markers-rerecord',
    hash: '#/books/hollow-tide-1/listen',
    viewports: ['desktop'],
    waitFor: '[data-testid="listen-markers-panel"]',
    scrollTo: '[data-testid="listen-markers-panel"]',
    strict: true,
  },
  {
    id: 'export-queue',
    hash: '#/books/hollow-tide-1/listen',
    viewports: ['desktop'],
    waitFor: '[data-testid="export-queue-rail"]',
    scrollTo: '[data-testid="export-queue-rail"]',
    strict: true,
  },
  {
    id: 'language-detect-russian',
    hash: '#/books/<russian-book-id>/analysing',
    viewports: ['desktop'],
    waitFor: 'text=Detecting language',
    strict: true,
  },
  {
    id: 'language-cast-confirm-german',
    hash: '#/books/<german-book-id>/confirm',
    viewports: ['desktop'],
    waitFor: '[data-testid^="cast-row-"]',
    strict: true,
  },
```

(Replace `<russian-book-id>`/`<german-book-id>` with the actual ids chosen in Step 4.)

> **Fixed from an earlier draft**: `markers-panel` and `export-queue-row`
> were both invented testids. The real ones, confirmed against source:
> `listen-markers-panel` (`src/components/listen/listen-player-region.tsx:552`)
> and `export-queue-rail` (`src/components/listen/listen-download-section.tsx:342`).
> `voice-readiness-gate` was already correct (`src/modals/voice-readiness-gate.tsx:85`).
> None of these 5 scenes has an `action`, so `waitFor` (pre-navigation-settle)
> is the right field here — there's no click whose effect needs confirming.

- [ ] **Step 6: Run typecheck, then capture all 5 scenes**

Run: `npm run typecheck` (confirms the new `Character`/book entries match their types), then `CAPTURE_SCENE=<id>` for each of the 5.

- [ ] **Step 7: Curate and update the 4 wiki pages**

```bash
mkdir -p docs/wiki/images/generating-audio docs/wiki/images/multi-language-support
cp mockups/marketing-screens/generating-voice-readiness.desktop.light.png docs/wiki/images/generating-audio/voice-readiness-gate.png
cp mockups/marketing-screens/listen-markers-rerecord.desktop.light.png docs/wiki/images/listening-and-revising/markers-and-rerecord.png
cp mockups/marketing-screens/export-queue.desktop.light.png docs/wiki/images/exporting/export-queue.png
cp mockups/marketing-screens/language-detect-russian.desktop.light.png docs/wiki/images/multi-language-support/language-detection.png
cp mockups/marketing-screens/language-cast-confirm-german.desktop.light.png docs/wiki/images/multi-language-support/non-english-cast-confirmation.png
```

Update `Generating-Audio.md`, `Listening-and-Revising.md`, `Exporting.md`, and `Multi-language-Support.md`, replacing their relevant "tracked as a follow-up" notes.

- [ ] **Step 8: Verify image references, run frontend tests, commit**

```bash
npm run test
```

Expected: green — the new fixture data is additive to `hollow-tide.ts` (touches no existing spec per that file's own header comment), and the `mockGetListenProgress` change is a pure additive `if (DEMO_CAPTURE)` early-return that can't affect any non-DEMO_CAPTURE test.

```bash
git add src/mocks/marketing/hollow-tide.ts src/lib/api.ts e2e/marketing/scenes.ts docs/wiki/
git commit -m "docs(docs): close 1318's Tier D screenshots (new fixture data)"
```

---

## Task 12: #1318 Tier E — Voice Engines mock flip + e2e fix

**Files:**
- Modify: `src/lib/api.ts:6636` (qwen-base), `src/lib/api.ts:6658-6673` (coqui)
- Modify: `e2e/model-manager-health.spec.ts`, `e2e/model-manager-inventory.spec.ts`, `e2e/model-manager-models.spec.ts`, `e2e/model-manager-ollama-load.spec.ts`, `e2e/model-manager-dual-model.spec.ts`, `e2e/kokoro-stop-pill.spec.ts` (fix the assertions this flip breaks in whichever of these actually reference the pre-flip Coqui/Qwen-base state)
- Modify: `e2e/marketing/scenes.ts` (append 2 scenes)
- Modify: `docs/wiki/Voice-Engines.md`

**Interfaces:** none beyond the existing `ModelInventoryItem` shape — this only changes field values, not types.

This is the one change with regression risk beyond the marketing harness — `mockGetModelInventory` is shared by every mock consumer, not just `model-manager-health.spec.ts`. **This plan's own assumption-checker review found the blast radius was under-scoped in an earlier draft**: six e2e specs reference `model-row-coqui`/`model-row-qwen-base`, not one — `model-manager-health`, `model-manager-inventory`, `model-manager-models`, `model-manager-ollama-load`, `model-manager-dual-model`, and `kokoro-stop-pill`. `model-manager-dual-model.spec.ts` is confirmed to specifically open the Coqui and Qwen-base installers from their not-installed/package-missing rows — both premised on the exact state this flip removes. (`src/views/model-manager.test.tsx`'s own unit tests are unaffected — they use a fully local `INVENTORY` fixture with the whole `api` module mocked, not the real `mockGetModelInventory`.)

- [ ] **Step 1: Read all 6 e2e specs in full to understand exactly what each pins**

Run: read `e2e/model-manager-health.spec.ts`, `e2e/model-manager-inventory.spec.ts`, `e2e/model-manager-models.spec.ts`, `e2e/model-manager-ollama-load.spec.ts`, `e2e/model-manager-dual-model.spec.ts`, and `e2e/kokoro-stop-pill.spec.ts`. Note every assertion referencing Coqui's "Not installed"/"Install" state and Qwen-base's "Needs repair"/"Repair"/no-Load-pill state — you will need to update these in Step 4. Pay particular attention to `model-manager-dual-model.spec.ts`'s installer-opening tests (they click into the Coqui/Qwen-base installer specifically because those rows are not-yet-installed today).

- [ ] **Step 2: Flip the Qwen-base install state**

In `src/lib/api.ts`, change:

```ts
      /* package-missing exercises the Needs-repair / Repair / no-Load-pill
           health states that model-manager-health.spec.ts pins (Task 12).
           installState resolves back to 'loaded' when the user loads it. */
      installState: MOCK_SIDECAR_QWEN_LOADED ? 'loaded' : 'package-missing',
```

to:

```ts
      installState: MOCK_SIDECAR_QWEN_LOADED ? 'loaded' : 'ready',
```

- [ ] **Step 3: Flip the Coqui entry to installed**

In `src/lib/api.ts`, change the `coqui` entry (currently `present: false`, `installState: 'not-installed'`) to:

```ts
    {
      id: 'coqui',
      kind: 'tts',
      label: 'Coqui XTTS v2',
      present: true,
      sizeBytes: 2_952_790_016,
      diskPath:
        'server/tts-sidecar/voices/coqui/tts/tts_models--multilingual--multi-dataset--xtts_v2',
      loaded: false,
      installState: 'ready',
      tier: 'secondary',
      isDefaultEngine: false,
      isFallbackEngine: false,
      removable: true,
      updatable: true,
    },
```

- [ ] **Step 4: Fix all 6 e2e specs' broken assertions**

Update every assertion from Step 1 (across all 6 files) that expected Coqui "Not installed"/"Install" or Qwen "Needs repair"/"Repair"/no-Load-pill — these should now assert the "ready"/installed state with a Load pill for both rows. For `model-manager-dual-model.spec.ts` specifically, its installer-opening tests need to either target a still-genuinely-uninstalled model instead (if one exists in the inventory after this flip) or be rewritten to open the installer from a different entry point — read that spec's actual test bodies at implementation time to decide which. Write the exact assertion changes based on what Step 1 found (this plan can't predict the exact line numbers without re-reading each file at implementation time, but the change is mechanical: swap the expected badge/button text for the new state).

- [ ] **Step 5: Add the 2 new scenes**

```ts
  {
    id: 'voice-engines-coqui',
    hash: '#/models',
    viewports: ['desktop'],
    waitFor: '[data-testid="model-row-coqui"]',
    scrollTo: '[data-testid="model-row-coqui"]',
    strict: true,
  },
  {
    id: 'voice-engines-qwen',
    hash: '#/models',
    viewports: ['desktop'],
    waitFor: '[data-testid="model-row-qwen-base"]',
    scrollTo: '[data-testid="model-row-qwen-base"]',
    strict: true,
  },
```

- [ ] **Step 6: Run all 6 affected e2e specs and confirm they're green after your fixes**

Run: `npx playwright test e2e/model-manager-health.spec.ts e2e/model-manager-inventory.spec.ts e2e/model-manager-models.spec.ts e2e/model-manager-ollama-load.spec.ts e2e/model-manager-dual-model.spec.ts e2e/kokoro-stop-pill.spec.ts`
Expected: PASS (after Step 4's fixes). Don't declare this task done on `model-manager-health.spec.ts` alone — that was an earlier draft's mistake, caught by this plan's own assumption-checker review.

- [ ] **Step 7: Run the frontend unit suite to confirm nothing else broke**

Run: `npm run test`
Expected: PASS — if anything else asserted the old Coqui/Qwen-base state, fix it here too (not skip).

- [ ] **Step 8: Capture the 2 new scenes and curate**

```bash
CAPTURE_SCENE=voice-engines-coqui npx playwright test --config=playwright.marketing.config.ts --project=desktop
CAPTURE_SCENE=voice-engines-qwen npx playwright test --config=playwright.marketing.config.ts --project=desktop
mkdir -p docs/wiki/images/voice-engines
cp mockups/marketing-screens/voice-engines-coqui.desktop.light.png docs/wiki/images/voice-engines/coqui-row.png
cp mockups/marketing-screens/voice-engines-qwen.desktop.light.png docs/wiki/images/voice-engines/qwen-row.png
```

Update `Voice-Engines.md`, replacing its "tracked as a follow-up" note.

- [ ] **Step 9: Commit**

```bash
git add src/lib/api.ts e2e/model-manager-health.spec.ts e2e/model-manager-inventory.spec.ts e2e/model-manager-models.spec.ts e2e/model-manager-ollama-load.spec.ts e2e/model-manager-dual-model.spec.ts e2e/kokoro-stop-pill.spec.ts e2e/marketing/scenes.ts docs/wiki/
git commit -m "fix(e2e): flip Coqui/Qwen-base mock inventory to installed for Voice Engines wiki screenshots"
```

---

## Task 13: #1318 Tier F — revision diff player (hardest)

**Files:**
- Modify: `src/mocks/marketing/hollow-tide.ts` (mock stream wiring for a mid-preview-regen state, if not already covered by Task 11's fixture additions)
- Modify: `e2e/marketing/scenes.ts` (append 1 scene)
- Modify: `docs/wiki/Generating-Audio.md`

**Interfaces:**
- Consumes: `uiActions.setPreviewRegen` (check exact action name/shape in `src/store/ui-slice.ts` before writing the scene's `action()`).

- [ ] **Step 1: Read how the mock `chapter_complete` stream event is produced**

Find where the marketing/mock generating stream posts `chapter_complete` (check `src/lib/api.ts`'s mock generation-stream implementation, referenced by the `generating` scene). Confirm whether it's timer-based or promise-based, since the scene's `waitFor` needs to land after that event but before the diff player auto-closes.

- [ ] **Step 2: Add the scene**

```ts
  {
    id: 'generating-revision-diff',
    hash: '#/books/hollow-tide-2/generate',
    viewports: ['desktop'],
    action: async (page) => {
      // Trigger a preview-mode regenerate on an already-generated chapter,
      // then wait for the mock chapter_complete stream event before the
      // diff player would auto-close. Exact trigger button/testid to
      // confirm against src/views/revision-diff.tsx and layout.tsx's
      // dispatch(uiActions.setPreviewRegen(...)) call site.
      await page.getByRole('button', { name: 'Regenerate this chapter' }).first().click({ timeout: 5000 });
      await page.getByRole('checkbox', { name: /preview/i }).check({ timeout: 5000 }).catch(() => {});
      await page.getByRole('button', { name: /Confirm|Regenerate/i }).last().click({ timeout: 5000 });
    },
    waitForAfterAction: '[data-testid="revision-diff-player"]',
    strict: true,
  },
```

> `revision-diff-player` is confirmed correct (`src/views/revision-diff.tsx:197`).
> Uses `waitForAfterAction`, not `waitFor` — the player only exists once the
> action's click sequence completes (per Task 1's ordering fix); using
> `waitFor` here would fail before the clicks ever ran.

- [ ] **Step 3: Capture and iterate on timing**

Run: `CAPTURE_SCENE=generating-revision-diff npx playwright test --config=playwright.marketing.config.ts --project=desktop`

This is explicitly the hardest scene in the plan — budget several iterations. If `waitForAfterAction` times out, add an explicit `page.waitForTimeout()` inside the `action` function itself (after the click sequence, matching the mock stream's known delay from Step 1) before returning, or adjust the action's exact click sequence against the real component.

- [ ] **Step 4: Curate and update the wiki page**

```bash
cp mockups/marketing-screens/generating-revision-diff.desktop.light.png docs/wiki/images/generating-audio/preview-ab-revision-player.png
```

Update `Generating-Audio.md`, replacing its "tracked as a follow-up" note for the preview + A/B revision player.

- [ ] **Step 5: Commit**

```bash
git add src/mocks/marketing/hollow-tide.ts e2e/marketing/scenes.ts docs/wiki/
git commit -m "docs(docs): close 1318's Tier F revision-diff-player screenshot"
```

---

## Task 14: Final verification and PR prep

**Files:** none new — this task only runs checks across everything the prior 13 tasks touched.

- [ ] **Step 1: Full marketing capture, confirm every scene in the plan passes strict**

Run: `npm run capture:marketing`
Expected: all scenes pass, including every `strict: true` scene added across Tasks 2, 3, 5, 8, 9, 10, 11, 12, 13.

- [ ] **Step 2: Wiki-wide image-reference check**

```bash
node -e "
const fs = require('fs');
const path = require('path');
const glob = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? glob(path.join(dir, e.name)) : (e.name.endsWith('.md') ? [path.join(dir, e.name)] : []));
let total = 0;
for (const file of glob('docs/wiki')) {
  const md = fs.readFileSync(file, 'utf8');
  const refs = [...md.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(m => m[1]);
  for (const ref of refs) {
    const p = path.join(path.dirname(file), ref);
    if (!fs.existsSync(p)) throw new Error(file + ' -> missing: ' + ref);
    total++;
  }
}
console.log('All wiki image refs resolved:', total);
"
```

- [ ] **Step 3: Orphan-image check**

```bash
node -e "
const fs = require('fs');
const path = require('path');
const glob = (dir, ext) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? glob(path.join(dir, e.name), ext) : (e.name.endsWith(ext) ? [path.join(dir, e.name)] : []));
const mdFiles = glob('docs/wiki', '.md');
const referenced = new Set();
for (const file of mdFiles) {
  const md = fs.readFileSync(file, 'utf8');
  for (const m of md.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) referenced.add(path.resolve(path.dirname(file), m[1]));
}
const images = glob('docs/wiki/images', '.png');
const orphans = images.filter(img => !referenced.has(path.resolve(img)));
if (orphans.length) throw new Error('orphaned images:\\n' + orphans.join('\\n'));
console.log('No orphaned images.');
"
```

- [ ] **Step 4: Run the full verify battery**

Run: `npm run verify`
Expected: PASS (typecheck + all tests + e2e + build). This is required — the PR is not docs-only (touches `e2e/marketing/scenes.ts`).

- [ ] **Step 5: Update `docs/BACKLOG.md` / issue state per CLAUDE.md's before-shipping checklist**

Confirm #1319 and #1318's `area:`/`moscow:` labels still reflect reality; no `docs/BACKLOG.md` row exists for either (docs-wiki work isn't backlog-tracked per the project's own convention) — skip that step explicitly.

- [ ] **Step 6: Update release notes**

Append an entry to `docs/release-notes-next.md` and a matching brand-voice line to the in-progress version section of `RELEASE_NOTES.md`, per CLAUDE.md's before-shipping checklist item 4.

- [ ] **Step 7: Open the PR**

```bash
gh pr create --title "docs(docs): split Admin/Model Manager, rewrite Advanced Settings, close #1318 screenshots" --body "$(cat <<'EOF'
## Summary
- Splits docs/wiki/Admin-and-Model-Manager.md into Admin.md + Model-Manager.md, with full per-knob detail on Model Manager's settings sections.
- Rewrites Advanced-Settings.md so all 11 knob groups (97 knobs) get per-section screenshots + full tables, not just 1.
- Closes all 11 items in #1318 — the remaining interaction-state screenshots across the wiki.
- Adds a `strict` mode to the marketing screenshot harness so new scenes fail loudly on a missed interaction instead of silently shipping the wrong screenshot.

Scope grew from a single page split (#1319) to a 3-page rewrite plus 11 additional screenshot fixes — see docs/superpowers/specs/2026-07-05-admin-model-manager-advanced-settings-wiki-design.md for the full design and its 3-round assumption-checker review.

Closes #1319
Closes #1318

## Test plan
- [ ] `npm run capture:marketing` — all scenes green, including every new `strict: true` scene
- [ ] Wiki-wide image-reference + orphan-image checks pass
- [ ] `npx playwright test e2e/model-manager-health.spec.ts` — green after the Coqui/Qwen-base mock flip
- [ ] `npm run verify` — full battery green
EOF
)"
```

- [ ] **Step 8: Run the mandatory high-effort `code-review` pass**

Per CLAUDE.md's model-routing skill (multi-scope PR: docs + test/fixture code + one shared-mock change → `high` effort), once the PR is fully staged and pushed.
