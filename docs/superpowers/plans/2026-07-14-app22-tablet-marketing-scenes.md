# app-22 Tablet/Foldable Marketing Scenes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the shipped Play-screenshot harness to produce tablet (7"/10") and foldable large-screen marketing assets showing the app-21 two-pane adaptive UI, in light + dark, without changing the phone pipeline's output.

**Architecture:** Three additive changes threaded through the existing three-stage pipeline (capture → drive → frame). Stage 1 (`capture-companion.mjs` + `marketing_capture_test.dart`) gains surface/orientation/scene-subset controls plus fail-loud layout guards. Stage 3 (`frame-play-screenshots.mjs`) is modularized into a config + templates dir with pure, unit-tested helpers so tablet/fold surfaces are data, not new scripts. The phone path moves across byte-for-byte unchanged.

**Tech Stack:** Node ESM (`node:test`), Playwright chromium + sharp (framing), Flutter integration_test + `flutter drive` (capture), adb (rotation/posture).

## Global Constraints

- **Extend, do not fork.** The phone capture + framing path stays behaviourally identical; tablet/fold is added as new surfaces/config. No second pipeline. (Spec "Principle".)
- **Node tests** live at `scripts/tests/*.test.mjs`, run via `npm run test:hooks` (globs + `node --test`). A single file: `node --test scripts/tests/<name>.test.mjs`.
- **Commit convention:** `<type>(<scope>): <subject>`; scopes include `scripts`, `app`, `docs`. Multi-scope: `type(a,b): …`. Branch: `chore/scripts-app22-tablet-marketing` (already cut).
- **Play dimensions:** every framed output must be 320–3840 px per side, ratio ≤ 2:1. Tablet landscape = **2560×1600**, tablet portrait = **1600×2560** (both 1.6:1). Phone = **1764×3136** (unchanged), feature graphic = **1024×500** (unchanged).
- **Window size classes** (`apps/android/lib/src/domain/window_size.dart`): `<600` compact, `<840` medium, `≥840` expanded (two-pane). Landscape tablet/fold clears 840 → two-pane; portrait tablet is `medium` → single-column. Do not change these.
- **`brand/` and `mockups/` are git-ignored** — captured raws and framed outputs are never committed. Only scripts/tests/docs are committed.
- **Fold half-open state index is box-specific** — never hardcode; derive by name from `adb shell cmd device_state print-states`, fall back to a `FOLD_HALF_OPEN_STATE` env override.
- **Design of record:** `docs/superpowers/specs/2026-07-14-app22-tablet-marketing-scenes-design.md`.

---

## File Structure

**Created:**
- `scripts/lib/play-frames/templates.mjs` — pure HTML template fns + shared render helpers (fonts, gradient stage, caption, `shoot`).
- `scripts/lib/play-frames/surfaces.mjs` — the `SURFACES` config (per-scene orientation) + `dimsForTemplate`.
- `scripts/tests/frame-play-screenshots.test.mjs` — unit test over the framing config/helpers.
- `scripts/tests/capture-companion.test.mjs` — unit test over the capture arg/adb helpers.

**Modified:**
- `scripts/frame-play-screenshots.mjs` — becomes a thin runner over `SURFACES`.
- `scripts/capture-companion.mjs` — gains `--surface/--orient/--scenes`, adb rotation, fold posture; exports pure helpers.
- `apps/android/integration_test/marketing_capture_test.dart` — scene filter, surface-prefixed screenshot name, fail-loud layout/fold guards.
- `apps/android/integration_test/marketing/README.md` — tablet/fold passes, 7" AVD recipe, adb rotation/posture.
- `package.json` — `capture:companion:tablet7|tablet10|fold` scripts.
- `docs/release-notes-next.md` — one-line tooling entry.

---

## Task 1: Modularize the framing script (phone output preserved)

Pure refactor: extract the phone framing into a config + templates module, leave `npm run frame:play` producing identical phone + feature output. This creates the testable seam the later tablet work extends.

**Files:**
- Create: `scripts/lib/play-frames/templates.mjs`, `scripts/lib/play-frames/surfaces.mjs`
- Modify: `scripts/frame-play-screenshots.mjs`
- Test: `scripts/tests/frame-play-screenshots.test.mjs`

**Interfaces:**
- Produces (templates.mjs): `FONTS` (string), `b64(path)`, `shoot(page, html, {w,h}, outPath)` → `"WxH"`, `phoneHtml({rawDataUri, caption})`, `featureHtml()`, `captionSpans(caption)`.
- Produces (surfaces.mjs): `DIMS` (`{phone,feature,tabletLandscape,tabletPortrait}`), `dimsForTemplate(name)` → `{w,h}`, `SURFACES` (array).

- [ ] **Step 1: Write the failing test** — `scripts/tests/frame-play-screenshots.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SURFACES, dimsForTemplate, DIMS } from '../lib/play-frames/surfaces.mjs';

const PLAY_MIN = 320, PLAY_MAX = 3840, PLAY_MAX_RATIO = 2;

test('every framed output dimension is Play-valid', () => {
  for (const surface of SURFACES) {
    for (const scene of surface.scenes) {
      const { w, h } = dimsForTemplate(scene.template ?? surface.template);
      const lo = Math.min(w, h), hi = Math.max(w, h);
      assert.ok(lo >= PLAY_MIN && hi <= PLAY_MAX, `${surface.id}/${scene.id} out of px range`);
      assert.ok(hi / lo <= PLAY_MAX_RATIO, `${surface.id}/${scene.id} ratio > 2:1`);
    }
  }
});

test('phone surface config is unchanged (6 scenes, portrait, captioned)', () => {
  const phone = SURFACES.find((s) => s.id === 'phone');
  assert.equal(phone.scenes.length, 6);
  assert.deepEqual(
    phone.scenes.map((s) => s.id),
    ['library-home', 'player', 'book-detail', 'library-offline', 'pairing', 'settings'],
  );
  assert.deepEqual(dimsForTemplate('phone'), DIMS.phone);
});

test('every scene has a non-empty caption', () => {
  for (const surface of SURFACES) {
    for (const scene of surface.scenes) {
      assert.ok(scene.caption && scene.caption.trim().length > 0, `${surface.id}/${scene.id} caption`);
    }
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/tests/frame-play-screenshots.test.mjs`
Expected: FAIL — cannot find module `../lib/play-frames/surfaces.mjs`.

- [ ] **Step 3: Create `scripts/lib/play-frames/templates.mjs`**

Move verbatim from the current `scripts/frame-play-screenshots.mjs`: the palette consts (`INK`/`PURPLE_DEEP`/`MAGENTA`/`PEACH`/`CREAM`, current lines ~34-38), `b64` + `fontFace` + `FONTS` (lines ~51-61), `phoneHtml` (lines ~63-91), `featureHtml` (lines ~93-117), and `shoot` (lines ~119-129). Add `export` to each of `FONTS`, `b64`, `shoot`, `phoneHtml`, `featureHtml`. Factor the caption-splitting used by `phoneHtml` into a shared export so tablet templates reuse it:

```js
export const captionSpans = (caption) =>
  caption.split('\n').map((l) => `<span>${l}</span>`).join('');
```

Replace `phoneHtml`'s inline caption map with `captionSpans(caption)`. `PHONE`/`FEATURE` dimensions move to `surfaces.mjs` (below) and are imported here for `featureHtml`/`phoneHtml` — import `DIMS` from `./surfaces.mjs` and use `DIMS.phone`/`DIMS.feature`.

**Module-scope resolution (review fix B1 — no gate catches this if wrong):** `templates.mjs` needs `FONT_DIR` (for `FONTS`) AND `OUT_DIR` (dereferenced by `featureHtml` at `resolve(OUT_DIR, 'castwright-play-header.svg')`). Resolve BOTH inside `templates.mjs` from `import.meta.url` — do not leave `OUT_DIR` only in the runner or `featureHtml()` throws `ReferenceError` at call time (the unit test never imports `templates.mjs`, and `node --check` only parses, so this ships green if missed):

```js
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const FONT_DIR = resolve(HERE, '../../../public/fonts');
const OUT_DIR = resolve(HERE, '../../../brand/go-to-market/play-store');
```

The runner keeps its own `OUT_DIR`/`RAW_DIR` for output paths and raw reads — that copy stays.

- [ ] **Step 4: Create `scripts/lib/play-frames/surfaces.mjs`**

```js
export const DIMS = {
  phone: { w: 1764, h: 3136 },
  feature: { w: 1024, h: 500 },
  tabletLandscape: { w: 2560, h: 1600 },
  tabletPortrait: { w: 1600, h: 2560 },
};

/** Canvas dims for a template name. */
export function dimsForTemplate(template) {
  switch (template) {
    case 'phone': return DIMS.phone;
    case 'tabletPortrait': return DIMS.tabletPortrait;
    case 'tabletLandscape':
    case 'foldBezel': return DIMS.tabletLandscape;
    default: throw new Error(`unknown template: ${template}`);
  }
}

// Curated, ORDERED phone set — captions moved verbatim from the old SCENES array.
const PHONE_SCENES = [
  { id: 'library-home', caption: 'Your whole library,\nin one place.' },
  { id: 'player', caption: 'Every character,\ntheir own voice.' },
  { id: 'book-detail', caption: 'Every chapter,\nbeautifully in order.' },
  { id: 'library-offline', caption: 'Downloaded once.\nYours to hear offline.' },
  { id: 'pairing', caption: 'Pairs to your own server —\nnothing leaves your LAN.' },
  { id: 'settings', caption: 'Tuned exactly\nto how you listen.' },
];

export const SURFACES = [
  {
    id: 'phone',
    template: 'phone',
    rawSubdir: '', // flat — unchanged phone raw location
    outDir: 'screenshots/phone',
    scenes: PHONE_SCENES,
  },
];
```

- [ ] **Step 5: Rewrite `scripts/frame-play-screenshots.mjs` as a thin runner**

Keep the file header comment, `repoRoot`, `RAW_DIR`, `OUT_DIR`. Import `{ b64, shoot, phoneHtml, featureHtml }` from `./lib/play-frames/templates.mjs` (do NOT import `FONTS` into the runner — it's used only inside the templates now; review note N4) and `{ SURFACES, dimsForTemplate }` from `./lib/play-frames/surfaces.mjs`. Replace the theme×SCENES loop with a surface-driven loop that, for the phone surface, reproduces today's behaviour exactly (light → `screenshots/phone`, dark → `screenshots/phone/dark`, `NN-<id>.png`, feature graphic once). Template dispatch by name:

```js
const TEMPLATES = { phone: (raw) => phoneHtml(raw) /* tablet/fold added in Task 2 */ };

for (const surface of SURFACES) {
  for (const theme of ['light', 'dark']) {
    const outBase = theme === 'light'
      ? resolve(OUT_DIR, surface.outDir)
      : resolve(OUT_DIR, surface.outDir, 'dark');
    mkdirSync(outBase, { recursive: true });
    let n = 0;
    for (const scene of surface.scenes) {
      const template = scene.template ?? surface.template;
      const raw = resolve(RAW_DIR, surface.rawSubdir, `${scene.rawId ?? scene.id}.${theme}.png`);
      if (!existsSync(raw)) { missing.push(`${surface.id}/${scene.id}.${theme}`); continue; }
      n += 1;
      const nn = String(n).padStart(2, '0');
      const out = resolve(outBase, `${nn}-${scene.id}.png`);
      const html = TEMPLATES[template]({ rawDataUri: `data:image/png;base64,${b64(raw)}`, caption: scene.caption });
      const dims = await shoot(page, html, dimsForTemplate(template), out);
      made.push(`${surface.id} ${theme}/${nn}-${scene.id}.png (${dims})`);
    }
  }
}
// feature graphic unchanged — emit once after the surface loop.
```

Preserve the `try/finally` browser lifecycle and the final `made`/`missing` logging exactly as today.

- [ ] **Step 6: Run the framing test — expect PASS**

Run: `node --test scripts/tests/frame-play-screenshots.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 7: Behaviour-preservation check**

Run: `node --check scripts/frame-play-screenshots.mjs && node --check scripts/lib/play-frames/templates.mjs && node --check scripts/lib/play-frames/surfaces.mjs`
Expected: no output (all parse). If phone raws exist under `mockups/marketing-screens/companion/`, optionally run `npm run frame:play` and confirm the same `screenshots/phone/**` + `feature-graphic.png` are produced at their prior dimensions. (Raws are git-ignored; skip the live run if absent — the unit test locks the config.)

- [ ] **Step 8: Commit**

```bash
git add scripts/lib/play-frames/ scripts/frame-play-screenshots.mjs scripts/tests/frame-play-screenshots.test.mjs
git commit -m "refactor(scripts): modularize play-frames into config + templates"
```

---

## Task 2: Add tablet + fold framing surfaces

Add the three new templates and the tablet7/tablet10/fold surface config. Pure/data change over Task 1's seam.

**Files:**
- Modify: `scripts/lib/play-frames/templates.mjs`, `scripts/lib/play-frames/surfaces.mjs`, `scripts/frame-play-screenshots.mjs`
- Test: `scripts/tests/frame-play-screenshots.test.mjs` (extend)

**Interfaces:**
- Consumes: `captionSpans`, `FONTS`, `b64` (Task 1).
- Produces: `tabletLandscapeHtml({rawDataUri, caption})`, `tabletPortraitHtml({rawDataUri, caption})`, `foldBezelHtml({rawDataUri, caption})`.

- [ ] **Step 1: Extend the test with the new surfaces**

Append to `scripts/tests/frame-play-screenshots.test.mjs`:

```js
test('tablet + fold surfaces present with expected scene sets', () => {
  const byId = Object.fromEntries(SURFACES.map((s) => [s.id, s]));
  for (const id of ['tablet7', 'tablet10', 'fold']) {
    assert.ok(byId[id], `missing surface ${id}`);
  }
  const two = ['library-home', 'player', 'book-detail', 'library-offline'];
  for (const id of ['tablet7', 'tablet10']) {
    const scenes = byId[id].scenes;
    for (const s of scenes.filter((x) => two.includes(x.id))) assert.equal(s.orientation, 'landscape');
    for (const s of scenes.filter((x) => ['settings', 'pairing'].includes(x.id))) assert.equal(s.orientation, 'portrait');
  }
  // Fold: 4 unfolded (reuse tablet10 raws) + 1 half-open seam (own raw).
  const seam = byId.fold.scenes.find((s) => s.id === 'library-home-seam');
  assert.ok(seam && seam.rawSubdir === 'fold' && seam.rawId === 'library-home');
  const unfolded = byId.fold.scenes.find((s) => s.id === 'library-home');
  assert.equal(unfolded.rawSubdir, 'tablet10');
});

test('no two scenes in one surface collide on output stem', () => {
  for (const surface of SURFACES) {
    const ids = surface.scenes.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, `${surface.id} has duplicate scene ids`);
  }
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `node --test scripts/tests/frame-play-screenshots.test.mjs`
Expected: FAIL — `missing surface tablet7`.

- [ ] **Step 3: Add the three templates to `templates.mjs`**

The tablet templates mirror `phoneHtml` (same gradient stage, `FONTS`, `captionSpans`) but land the device in a landscape/portrait bezel with the caption placed to fit. Templates keep the `({ rawDataUri, caption })` signature and read dims **internally** from `DIMS` — there is no circular import (`surfaces.mjs` imports nothing; `templates.mjs → surfaces.mjs` is a one-way edge), so do NOT change signatures to accept `w,h`.

**Review fix S1:** the `import { DIMS } from './surfaces.mjs'` line below **already exists** from Task 1 Step 3 — do NOT re-add it (a second `import { DIMS }` is a `SyntaxError`). Append only `STAGE_BG` and the three new functions. The `import { DIMS }` in the snippet is shown for context, not to be pasted twice.

Full code:

```js
// import { DIMS } from './surfaces.mjs';  // ALREADY PRESENT from Task 1 — do not duplicate

const STAGE_BG =
  `linear-gradient(180deg,${INK} 0%,${PURPLE_DEEP} 46%,${MAGENTA} 76%,${PEACH} 100%)`;

export function tabletLandscapeHtml({ rawDataUri, caption }) {
  const { w, h } = DIMS.tabletLandscape;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    ${FONTS}
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:${w}px;height:${h}px;overflow:hidden}
    .stage{width:${w}px;height:${h}px;background:${STAGE_BG};
      display:flex;flex-direction:row;align-items:center;gap:80px;padding:0 140px;
      font-family:'General Sans',system-ui,sans-serif}
    .caption{flex:0 0 40%;color:#fff;font-weight:600;font-size:96px;line-height:1.1;
      letter-spacing:-0.02em;display:flex;flex-direction:column;
      text-shadow:0 2px 24px rgba(0,0,0,.28)}
    .caption span:last-child{color:${CREAM}}
    .tablet{flex:1 1 auto;border-radius:44px;background:#0b0b0c;padding:18px;
      box-shadow:0 40px 90px rgba(0,0,0,.42),0 0 0 2px rgba(255,255,255,.06)}
    .tablet img{display:block;width:100%;border-radius:30px}
  </style></head><body>
    <div class="stage">
      <div class="caption">${captionSpans(caption)}</div>
      <div class="tablet"><img src="${rawDataUri}"/></div>
    </div>
  </body></html>`;
}

export function tabletPortraitHtml({ rawDataUri, caption }) {
  const { w, h } = DIMS.tabletPortrait;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    ${FONTS}
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:${w}px;height:${h}px;overflow:hidden}
    .stage{width:${w}px;height:${h}px;background:${STAGE_BG};
      display:flex;flex-direction:column;align-items:center;
      font-family:'General Sans',system-ui,sans-serif}
    .caption{margin-top:130px;padding:0 140px;text-align:center;color:#fff;
      font-weight:600;font-size:82px;line-height:1.12;letter-spacing:-0.02em;
      display:flex;flex-direction:column;text-shadow:0 2px 24px rgba(0,0,0,.28)}
    .caption span:last-child{color:${CREAM}}
    .tablet{margin-top:90px;width:1120px;border-radius:44px;background:#0b0b0c;
      padding:18px;box-shadow:0 40px 90px rgba(0,0,0,.42),0 0 0 2px rgba(255,255,255,.06)}
    .tablet img{display:block;width:100%;border-radius:30px}
  </style></head><body>
    <div class="stage">
      <div class="caption">${captionSpans(caption)}</div>
      <div class="tablet"><img src="${rawDataUri}"/></div>
    </div>
  </body></html>`;
}

// Fold: landscape bezel with a subtle centre crease line over the device.
export function foldBezelHtml({ rawDataUri, caption }) {
  const { w, h } = DIMS.tabletLandscape;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    ${FONTS}
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:${w}px;height:${h}px;overflow:hidden}
    .stage{width:${w}px;height:${h}px;background:${STAGE_BG};
      display:flex;flex-direction:row;align-items:center;gap:80px;padding:0 140px;
      font-family:'General Sans',system-ui,sans-serif}
    .caption{flex:0 0 40%;color:#fff;font-weight:600;font-size:96px;line-height:1.1;
      letter-spacing:-0.02em;display:flex;flex-direction:column;
      text-shadow:0 2px 24px rgba(0,0,0,.28)}
    .caption span:last-child{color:${CREAM}}
    .fold{flex:1 1 auto;position:relative;border-radius:36px;background:#0b0b0c;
      padding:20px;box-shadow:0 40px 90px rgba(0,0,0,.42),0 0 0 2px rgba(255,255,255,.06)}
    .fold img{display:block;width:100%;border-radius:22px}
    .crease{position:absolute;top:20px;bottom:20px;left:50%;width:2px;
      background:linear-gradient(180deg,transparent,rgba(255,255,255,.12),transparent)}
  </style></head><body>
    <div class="stage">
      <div class="caption">${captionSpans(caption)}</div>
      <div class="fold"><img src="${rawDataUri}"/><div class="crease"></div></div>
    </div>
  </body></html>`;
}
```

(Each template reads its own dims from `DIMS` internally, exactly as shown. The runner passes dims to `shoot()` separately — it does NOT spread dims into the template call. This is the single, consistent contract; there is no `w,h` template parameter.)

- [ ] **Step 4: Add the tablet + fold surfaces to `surfaces.mjs`**

```js
const TABLET_SCENES = [
  { id: 'library-home', orientation: 'landscape', template: 'tabletLandscape',
    caption: 'Your library and\nwhat’s playing — side by side.' },
  { id: 'player', orientation: 'landscape', template: 'tabletLandscape',
    caption: 'Keep listening while\nyou browse the shelf.' },
  { id: 'book-detail', orientation: 'landscape', template: 'tabletLandscape',
    caption: 'Every chapter, open\nbeside your library.' },
  { id: 'library-offline', orientation: 'landscape', template: 'tabletLandscape',
    caption: 'Downloaded once.\nYours to hear offline.' },
  { id: 'settings', orientation: 'portrait', template: 'tabletPortrait',
    caption: 'Tuned exactly\nto how you listen.' },
  { id: 'pairing', orientation: 'portrait', template: 'tabletPortrait',
    caption: 'Pairs to your own server —\nnothing leaves your LAN.' },
];

SURFACES.push(
  { id: 'tablet7', rawSubdir: 'tablet7', outDir: 'screenshots/tablet-7', scenes: TABLET_SCENES },
  { id: 'tablet10', rawSubdir: 'tablet10', outDir: 'screenshots/tablet-10', scenes: TABLET_SCENES },
  {
    id: 'fold',
    outDir: 'screenshots/fold',
    scenes: [
      // Unfolded: reuse tablet10 landscape raws inside a fold bezel.
      { id: 'library-home', rawSubdir: 'tablet10', orientation: 'landscape', template: 'foldBezel',
        caption: 'Unfold into\nyour whole library.' },
      { id: 'player', rawSubdir: 'tablet10', orientation: 'landscape', template: 'foldBezel',
        caption: 'A full-cast performance,\nunfolded.' },
      { id: 'book-detail', rawSubdir: 'tablet10', orientation: 'landscape', template: 'foldBezel',
        caption: 'Every chapter,\non the big screen.' },
      { id: 'library-offline', rawSubdir: 'tablet10', orientation: 'landscape', template: 'foldBezel',
        caption: 'Downloaded once.\nYours to hear offline.' },
      // Half-open seam: own capture; crease bisects library ∣ player.
      { id: 'library-home-seam', rawSubdir: 'fold', rawId: 'library-home', orientation: 'landscape',
        template: 'foldBezel', caption: 'Made for the\nhalf-open fold.' },
    ],
  },
);
```

Note `SURFACES` must be declared `const SURFACES = [ …phone… ]` in Task 1 and mutated with `.push` here (or, cleaner, define all entries in one literal — either is fine; the test only reads `SURFACES`). If reusing `TABLET_SCENES` across tablet7/tablet10, they share caption text (acceptable — same layout at both sizes).

- [ ] **Step 5: Wire the new templates into the runner's dispatch**

In `scripts/frame-play-screenshots.mjs` extend `TEMPLATES`:

```js
import { phoneHtml, tabletLandscapeHtml, tabletPortraitHtml, foldBezelHtml } from './lib/play-frames/templates.mjs';
const TEMPLATES = {
  phone: phoneHtml,
  tabletLandscape: tabletLandscapeHtml,
  tabletPortrait: tabletPortraitHtml,
  foldBezel: foldBezelHtml,
};
```

The template call is unchanged from Task 1 — `TEMPLATES[template]({ rawDataUri, caption: scene.caption })` — because every template reads dims internally. `dimsForTemplate(template)` is passed only to `shoot()` (the third arg), as in Task 1 Step 5. Do NOT spread dims into the template call. (For consistency, Task 1's `TEMPLATES = { phone: (raw) => phoneHtml(raw) }` and this task's `{ phone: phoneHtml, … }` are equivalent — either is fine; `phoneHtml` reads `DIMS.phone` internally and its output stays byte-identical.)

- [ ] **Step 6: Run the test — expect PASS**

Run: `node --test scripts/tests/frame-play-screenshots.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 7: Parse check**

Run: `node --check scripts/frame-play-screenshots.mjs && node --check scripts/lib/play-frames/templates.mjs && node --check scripts/lib/play-frames/surfaces.mjs`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add scripts/lib/play-frames/ scripts/frame-play-screenshots.mjs scripts/tests/frame-play-screenshots.test.mjs
git commit -m "feat(scripts): add tablet + fold framing surfaces to play-frames"
```

---

## Task 3: Extend `capture-companion.mjs` (surface/orient/scene flags, adb rotation + fold posture)

**Files:**
- Modify: `scripts/capture-companion.mjs`, `package.json`
- Test: `scripts/tests/capture-companion.test.mjs`

**Interfaces:**
- Produces: `parseArgs(argv)` → `{surface, passes}`; `rotationValue(orient)` → `0|1`; `buildDartDefines({surface, orient, scenes})` → `string[]`; `parseHalfOpenedState(printStatesOutput)` → `number|null`; `SURFACE_PASSES` (const map).

- [ ] **Step 1: Write the failing test** — `scripts/tests/capture-companion.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rotationValue, buildDartDefines, parseHalfOpenedState, SURFACE_PASSES,
} from '../capture-companion.mjs';

test('rotationValue: landscape=1, portrait=0', () => {
  assert.equal(rotationValue('landscape'), 1);
  assert.equal(rotationValue('portrait'), 0);
  assert.equal(rotationValue('seam'), 0); // fold half-open captured in natural rotation
});

test('buildDartDefines threads surface/orient and omits scenes when absent', () => {
  assert.deepEqual(buildDartDefines({ surface: 'tablet7', orient: 'landscape', scenes: ['a', 'b'] }),
    ['--dart-define=surface=tablet7', '--dart-define=orient=landscape', '--dart-define=scenes=a,b']);
  assert.deepEqual(buildDartDefines({ surface: 'phone', orient: 'portrait', scenes: null }),
    ['--dart-define=surface=phone', '--dart-define=orient=portrait']);
});

test('SURFACE_PASSES: tablet has landscape+portrait, fold has seam only', () => {
  assert.equal(SURFACE_PASSES.tablet7.length, 2);
  assert.deepEqual(SURFACE_PASSES.tablet7.map((p) => p.orient), ['landscape', 'portrait']);
  assert.deepEqual(SURFACE_PASSES.fold, [{ orient: 'seam', scenes: ['library-home'] }]);
});

test('parseHalfOpenedState finds the index by name in either field order', () => {
  const out = `Supported states: [
    DeviceState{identifier=0, name='CLOSED'},
    DeviceState{identifier=1, name='HALF_OPENED'},
    DeviceState{identifier=2, name='OPENED'},
  ]`;
  assert.equal(parseHalfOpenedState(out), 1);
  assert.equal(parseHalfOpenedState("name='HALF_OPENED', identifier=3"), 3);
  assert.equal(parseHalfOpenedState('no folds here'), null);
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `node --test scripts/tests/capture-companion.test.mjs`
Expected: FAIL — exports not found.

- [ ] **Step 3: Add the pure helpers + pass map to `capture-companion.mjs`**

Insert near the top (after imports), and `export` them:

```js
export const SURFACE_PASSES = {
  phone: [{ orient: 'portrait', scenes: null }],
  tablet7: [
    { orient: 'landscape', scenes: ['library-home', 'player', 'book-detail', 'library-offline'] },
    { orient: 'portrait', scenes: ['settings', 'pairing'] },
  ],
  tablet10: [
    { orient: 'landscape', scenes: ['library-home', 'player', 'book-detail', 'library-offline'] },
    { orient: 'portrait', scenes: ['settings', 'pairing'] },
  ],
  fold: [{ orient: 'seam', scenes: ['library-home'] }],
};

export const rotationValue = (orient) => (orient === 'landscape' ? 1 : 0);

export function buildDartDefines({ surface, orient, scenes }) {
  const defs = [`--dart-define=surface=${surface}`, `--dart-define=orient=${orient}`];
  if (scenes && scenes.length) defs.push(`--dart-define=scenes=${scenes.join(',')}`);
  return defs;
}

export function parseHalfOpenedState(printStatesOutput) {
  const m = printStatesOutput.match(/identifier=(\d+)[^}]*?name='?HALF_OPENED'?/i)
    || printStatesOutput.match(/name='?HALF_OPENED'?[^}]*?identifier=(\d+)/i);
  return m ? Number(m[1]) : null;
}
```

- [ ] **Step 4: Guard the script body so importing the module does not run capture**

Wrap the existing top-level capture body in `async function main() { … }` and call it only when run directly:

```js
import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
```

`main(argv)` parses `--surface`/`--orient`/`--scenes` (default `surface=phone`, no scenes → today's behaviour). For each pass in `SURFACE_PASSES[surface]` (or the CLI-supplied single orient/scenes): set rotation (`adb shell settings put system accelerometer_rotation 0`, then `adb shell settings put system user_rotation <rotationValue(orient)>`); for `orient === 'seam'`, resolve the half-open index via `FOLD_HALF_OPEN_STATE` env else `parseHalfOpenedState(adb shell cmd device_state print-states)`, erroring loudly if null, then `adb shell cmd device_state state <idx>`; run flutter drive by spreading the defines into the existing `sh('flutter', […])` args array (review note N3): `sh('flutter', ['drive', '--driver=test_driver/integration_test.dart', '--target=integration_test/marketing_capture_test.dart', ...buildDartDefines(pass)], { cwd: androidDir })` — `shell:true` on Windows passes `--dart-define=scenes=a,b` fine unquoted. Keep the existing device-online + cover-push preamble (run once, before the passes). After a `seam`/rotation run, reset with `adb shell settings put system accelerometer_rotation 1` and `adb shell cmd device_state state reset` in a `finally`.

- [ ] **Step 5: Run the test — expect PASS**

Run: `node --test scripts/tests/capture-companion.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 6: Add npm scripts** — in `package.json` after `"capture:companion"`:

```json
"capture:companion:tablet7": "node scripts/capture-companion.mjs --surface=tablet7",
"capture:companion:tablet10": "node scripts/capture-companion.mjs --surface=tablet10",
"capture:companion:fold": "node scripts/capture-companion.mjs --surface=fold",
```

- [ ] **Step 7: Parse + hooks check**

Run: `node --check scripts/capture-companion.mjs && node --test scripts/tests/capture-companion.test.mjs`
Expected: clean + PASS.

- [ ] **Step 8: Commit**

```bash
git add scripts/capture-companion.mjs scripts/tests/capture-companion.test.mjs package.json
git commit -m "feat(scripts): surface/orient/scene flags + adb rotation/posture for tablet capture"
```

---

## Task 4: Extend `marketing_capture_test.dart` (scene filter, surface prefix, fail-loud guards)

**Files:**
- Modify: `apps/android/integration_test/marketing_capture_test.dart`

**Interfaces:**
- Consumes: dart-defines `surface` (default `''`), `orient` (default `''`), `scenes` (default `''` → all) from Task 3's `buildDartDefines`.

- [ ] **Step 1: Read the dart-defines and filter scenes**

At the top of the `testWidgets` body, before the theme loop:

```dart
const surface = String.fromEnvironment('surface');
const orient = String.fromEnvironment('orient');
const scenesCsv = String.fromEnvironment('scenes');
final wanted = scenesCsv.isEmpty ? null : scenesCsv.split(',').toSet();
final scenes = wanted == null
    ? marketingScenes
    : marketingScenes.where((s) => wanted.contains(s.id)).toList();
```

Replace `for (final scene in marketingScenes)` with `for (final scene in scenes)`.

- [ ] **Step 2: Prefix the screenshot name with the surface**

Change the capture call to:

```dart
final namePrefix = surface.isEmpty ? '' : '$surface/';
await binding.takeScreenshot('$namePrefix${scene.id}.$themeName');
```

(No driver change — `test_driver/integration_test.dart` already does `create(recursive: true)`.)

- [ ] **Step 3: Add the fail-loud landscape guard**

After the first `pumpAndSettle()` for a scene when `orient == 'landscape'`, assert the app actually laid out expanded (catches a rotation that did not take):

```dart
if (orient == 'landscape') {
  final w = tester.view.physicalSize.width / tester.view.devicePixelRatio;
  expect(windowSizeClassFor(w), WindowSizeClass.expanded,
      reason: 'surface=$surface expected landscape/expanded but width=$w dp — '
          'did adb user_rotation take? Refusing to capture single-pane into a two-pane slot.');
}
```

Add the import: `import 'package:castwright/src/domain/window_size.dart';`.

- [ ] **Step 4: Add the fold seam guard**

When `orient == 'seam'`, assert a vertical fold `DisplayFeature` is present before capturing (catches a mis-set posture that yields no crease):

```dart
if (orient == 'seam') {
  // Read posture from the platform view, not tester.view — matches how the app
  // itself reads it (MediaQuery.displayFeatures), and is the more robust source
  // for the real on-device fold (review note N2).
  final features =
      WidgetsBinding.instance.platformDispatcher.views.first.displayFeatures;
  final hasVerticalFold = features.any((f) =>
      (f.type == DisplayFeatureType.fold || f.type == DisplayFeatureType.hinge) &&
      f.bounds.width < f.bounds.height);
  expect(hasVerticalFold, isTrue,
      reason: 'surface=fold expected a vertical fold/hinge DisplayFeature (half-open) '
          'but found none — check `adb cmd device_state state <HALF_OPENED idx>`.');
}
```

Add the fold-type imports mirroring the established codebase pattern at
`apps/android/lib/src/domain/pane_split.dart:1` (review note N1):
`import 'dart:ui' show DisplayFeature, DisplayFeatureType;`.

- [ ] **Step 5: Analyze the changed file**

Run: `cd apps/android && flutter analyze integration_test/marketing_capture_test.dart`
Expected: `No issues found!` (If `flutter` needs deps first: `flutter pub get` once.) The `app.yml` CI workflow is the backstop — it runs `flutter analyze`/`test` on any `apps/android/**` change.

- [ ] **Step 6: Commit**

```bash
git add apps/android/integration_test/marketing_capture_test.dart
git commit -m "feat(app): scene filter, surface-prefixed shots, fail-loud layout guards in marketing capture"
```

---

## Task 5: Docs + release notes

**Files:**
- Modify: `apps/android/integration_test/marketing/README.md`, `docs/release-notes-next.md`

- [ ] **Step 1: Extend the README**

Add a "Tablet & foldable surfaces (app-22)" section documenting: the three capture scripts (`npm run capture:companion:tablet7|tablet10|fold`); that the operator boots the matching AVD before each (7" Nexus-7 profile, Pixel Tablet, PixelFold); the **7" AVD creation recipe** (mirror the app-21 PixelFold `avdmanager create` recipe — `JAVA_HOME` = Android Studio JBR/JDK21); the adb rotation the scripts issue (`accelerometer_rotation 0` + `user_rotation 1|0`); the **fold posture** step — run `adb shell cmd device_state print-states`, note the `HALF_OPENED` identifier for this box, and either let the script auto-detect it or set `FOLD_HALF_OPEN_STATE=<idx>`; the mixed-orientation scene split (4 landscape two-pane + settings/pairing portrait); the output dirs (`screenshots/tablet-7`, `-10`, `fold`); and that framing (`npm run frame:play`) now emits all surfaces. Note the two fail-loud guards so an operator understands a hard test failure means "rotation/posture didn't take", not a code bug.

- [ ] **Step 2: Add the release-notes entry**

Append to `docs/release-notes-next.md` under the appropriate section (tooling/internal):

```markdown
- Marketing harness now produces tablet (7"/10") and foldable Play Store screenshots showing the two-pane adaptive companion UI, in light + dark (app-22, #1589).
```

(User-facing `RELEASE_NOTES.md` is intentionally skipped — this is local-only marketing tooling with no shipped app delta; stated in the PR body.)

- [ ] **Step 3: Commit**

```bash
git add apps/android/integration_test/marketing/README.md docs/release-notes-next.md
git commit -m "docs(app): document tablet/foldable marketing capture + release note"
```

---

## Self-Review

**Spec coverage:**
- Extend-not-fork principle → Tasks 1–2 modularize in place; phone preserved (Task 1 Step 7). ✓
- Mixed orientation, all 6 → `TABLET_SCENES` (Task 2 Step 4) + `SURFACE_PASSES` (Task 3 Step 3). ✓
- Distinct 7"/10" capture → separate `capture:companion:tablet7|tablet10` + separate `tablet7`/`tablet10` raw subdirs + `screenshots/tablet-7|-10` (Tasks 2–3). ✓
- Fold unfolded reframed + half-open seam captured → `fold` surface reuses `tablet10` raws + `library-home-seam` from `fold` raws (Task 2 Step 4); posture handling (Task 3 Step 4). ✓
- Amendment #3 (fail-loud rotation) → Task 4 Step 3. ✓
- Amendment #5 (fold state by name, README record) → `parseHalfOpenedState` + `FOLD_HALF_OPEN_STATE` (Task 3), README (Task 5). ✓
- Amendment #7 (per-scene orientation/dims) → `orientation`/`template` per scene, `dimsForTemplate` (Tasks 1–2). ✓
- Paired automated tests → `frame-play-screenshots.test.mjs` + `capture-companion.test.mjs` (Tasks 1–3), auto-run via `test:hooks`. ✓
- Docs + release notes → Task 5. ✓

**Placeholder scan:** No TBD/TODO; every code step carries real code. The README step describes content rather than pasting the full markdown — acceptable (prose doc, not code), with the exact commands/values enumerated.

**Type consistency:** `SURFACES`/`dimsForTemplate`/`DIMS` names match across Tasks 1–2; `buildDartDefines`/`rotationValue`/`parseHalfOpenedState`/`SURFACE_PASSES` match across Task 3 test + impl; dart-define names (`surface`/`orient`/`scenes`) match between Task 3 (`buildDartDefines`) and Task 4 (`String.fromEnvironment`). ✓
