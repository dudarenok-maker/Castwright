# app-22 — Tablet/foldable marketing scenes — Design

- **Issue:** #1589 (`area:app`, `moscow:could`, `type:chore`)
- **Depends on:** app-21 (#1588, MERGED #1590) — the two-pane adaptive companion UI
- **Extends:** #1581's Play screenshot pipeline (`scenes.dart` → `marketing_capture_test.dart` → `frame-play-screenshots.mjs`)
- **Status:** draft

## Problem

The Google Play listing has dedicated 7"/10" tablet screenshot slots that are
currently empty. app-21 shipped a real large-screen companion UI (two-pane
list-detail on ≥840 dp: library + persistent player pane, plus foldable posture
handling), but the marketing harness only produces **phone** shots. We need
large-screen promotional screenshots — the two-pane library, the persistent
player pane, and a foldable shot — in light + dark, so the tablet slots showcase
the adaptive layout.

## Principle: extend the harness, never fork it

The issue is explicit: this **extends** #1581's three-stage pipeline; it does not
add a second one. The phone path stays byte-for-byte identical. Tablet/fold is
added as **new surfaces** threaded through the same three stages. The framing
stage is modularized (it now carries four HTML templates instead of one), but the
phone template moves across unchanged.

The one irreducible manual input stays manual, exactly as today: an operator
boots the correct AVD and supplies the git-ignored brand covers. Everything
downstream is scripted and reproducible.

## Decisions (locked in brainstorming)

1. **Scope: comprehensive.** All six scenes get tablet treatment; both the
   foldable-unfolded and foldable-half-open (seam) shots are produced.
2. **Mixed orientation.** The four two-pane-meaningful scenes
   (`library-home`, `player`, `book-detail`, `library-offline`) are captured
   **landscape** (the ≥840 dp two-pane trigger requires it); `settings` and
   `pairing` are single-column forms captured **portrait** (they look sparse
   stretched wide). Google Play permits mixed orientation within one slot.
3. **Distinct capture per tablet size.** A real 7" AVD and a real 10" AVD are
   each captured, so the 7" shots show their genuinely narrower two-pane. Output
   canvases share dimensions; the difference lives in the embedded content.
4. **Foldable-unfolded is reframed, not recaptured.** An unfolded Fold is one
   continuous wide surface — pixel-equivalent to the tablet landscape shot — so
   the unfolded Fold assets **reuse the 10" landscape raws** inside a foldable
   device bezel. Only the **half-open seam** shot needs a live PixelFold capture.
5. **Half-open seam is produced but optional at upload.** The harness generates
   it; because a mid-screen seam can read as a rendering glitch to casual Play
   browsers, upload curation stays a manual per-slot choice (as it already is —
   `brand/` is git-ignored and hand-uploaded).

## dp math (why the orientation split is natural, not forced)

The `expanded` window-size class (two-pane) triggers at ≥840 dp width.

| AVD | Landscape width | Portrait width |
|---|---|---|
| 7" (Nexus-7 profile) | ~960 dp → **expanded** (two-pane) | ~600 dp → medium (single-column) |
| 10" (Pixel Tablet) | ~1280 dp → **expanded** (two-pane) | ~800 dp → medium (single-column) |
| PixelFold unfolded | ≥840 dp → **expanded** (continuous surface, default split) | n/a |

Both tablets show two-pane in landscape and single-column in portrait — so the
mixed-orientation scene split maps 1:1 onto the layout the app naturally renders.

## Architecture

### Stage 1 — Capture (`scripts/capture-companion.mjs` + `marketing_capture_test.dart`)

The current capture is AVD-agnostic and writes every scene to one flat dir. Three
changes, all additive (no-flag invocation = today's phone behaviour):

1. **`capture-companion.mjs` gains three flags** —
   `--surface=<phone|tablet7|tablet10|fold>`, `--orient=<landscape|portrait>`,
   `--scenes=<csv>`. It:
   - sets device rotation: `adb shell settings put system accelerometer_rotation 0`
     then `adb shell settings put system user_rotation <1=landscape|0=portrait>`;
   - for `--surface=fold`, sets the posture:
     `adb shell cmd device_state state <2 = HALF_OPENED>` (per the app-21 fold
     recipe — half-open emits `DisplayFeatureType.fold` / `postureFlat`, the
     vertical centre seam);
   - passes `surface`/`orient`/`scenes` to `flutter drive` as `--dart-define`s;
   - the driver already writes `<name>.png` with `create(recursive: true)`, so
     output routing needs **no driver change** — the test prepends `<surface>/`
     to the screenshot name → `mockups/marketing-screens/companion/<surface>/`.

2. **`marketing_capture_test.dart` reads the dart-defines** — filters
   `marketingScenes` to the `--scenes` list (default: all, preserving phone
   behaviour) and prepends `<surface>/` to `takeScreenshot('<surface>/<id>.<theme>')`.
   With no `surface` define, the name is unprefixed → identical phone output.

3. **New npm scripts** wrap the passes so an operator runs one line per surface:
   - `capture:companion` — unchanged (phone).
   - `capture:companion:tablet7` — landscape pass (4 scenes) then portrait pass
     (2 scenes) against the booted 7" AVD.
   - `capture:companion:tablet10` — same against the Pixel Tablet.
   - `capture:companion:fold` — the half-open seam pass against the PixelFold.

**AVDs.** Pixel Tablet (10") and PixelFold already exist on the box (app-21). The
**7" AVD is created** in this work via the same `avdmanager` recipe app-21 used
for PixelFold (`JAVA_HOME` = Android Studio JBR/JDK21; documented in the README).

### Stage 2 — Scene / surface config

Per-surface capture list (every row × light + dark):

| Surface | Landscape pass | Portrait pass | Seam pass |
|---|---|---|---|
| phone | *(unchanged: all 6, portrait)* | — | — |
| tablet7 | library-home · player · book-detail · library-offline | settings · pairing | — |
| tablet10 | library-home · player · book-detail · library-offline | settings · pairing | — |
| fold | *(reuses tablet10 landscape raws)* | — | library-home |

`library-home` is chosen for the half-open seam shot because `paneSplitForHinge`
aligns the pane divider to the crease: the fold seam falls exactly between the
library pane and the "Select a book to start listening" detail pane, reading as
intentional rather than as a glitch.

### Stage 3 — Framing (refactor of `frame-play-screenshots.mjs`)

The single 180-line script splits into a small module dir with pure,
unit-testable helpers. The phone template and all shared machinery (`shoot()`,
font-inlining, gradient stage, sharp dimension-assertion) move across unchanged
and are reused by every template — no duplication.

```
scripts/lib/play-frames/
  templates.mjs   — phoneHtml (moved as-is) · tabletLandscapeHtml ·
                    tabletPortraitHtml · foldBezelHtml + shared helpers
                    (FONTS, gradient stage, captionHtml)
  surfaces.mjs    — SURFACES config: [{ id, sceneList, captions, orientation,
                    dims, outDir, bezel }]
scripts/frame-play-screenshots.mjs — thin runner: for each surface → pick
                    template → shoot() → assert dims; phone path preserved
scripts/tests/frame-play-screenshots.test.mjs — Node unit test over the pure
                    helpers (dims, caption coverage, config consistency)
```

Templates differ only in bezel art and caption placement (caption **beside** the
device on wide landscape, **above** on portrait — matching the phone template's
spirit). The fold bezel is the landscape frame with a foldable device mockup and
a subtle centre crease line.

**Output canvases** (all within Play's 320–3840 px, ≤2:1 ratio limits; written to
the git-ignored `brand/go-to-market/play-store/`):

| Output dir | Landscape dims | Portrait dims | Fed by |
|---|---|---|---|
| `screenshots/tablet-7/{light,dark}/NN-<id>.png` | 2560×1600 | 1600×2560 | tablet7 raws |
| `screenshots/tablet-10/{light,dark}/NN-<id>.png` | 2560×1600 | 1600×2560 | tablet10 raws |
| `screenshots/fold/{light,dark}/NN-<id>.png` | 2560×1600 (bezel + crease) | — | tablet10 landscape raws + fold half-open raw |

7" and 10" share canvas dimensions but differ in embedded content (7" renders a
narrower two-pane) — that is the "distinct capture" payoff. Every output's
dimensions are re-opened with sharp and asserted before the run reports green,
exactly as today. The phone outputs (`screenshots/phone/…`, `feature-graphic.png`)
are unchanged.

## Testing & acceptance

- **Paired automated test** (satisfies the CLAUDE.md test gate):
  `scripts/tests/frame-play-screenshots.test.mjs` — Node test over the pure
  `play-frames` helpers. Asserts: (a) each surface's configured output dimensions
  are Play-valid and match the template; (b) every configured scene has a caption;
  (c) the SURFACES config is internally consistent (every scene id maps to a
  raw-name rule; no orphan captions). Mirrors the `build-companion-apk.test.mjs`
  precedent. The on-device captures themselves stay manual/on-box — like the
  existing phone harness, they are not in CI.
- **Docs:** extend `apps/android/integration_test/marketing/README.md` with the
  tablet/fold passes, the 7" AVD-creation recipe, and the rotation/posture adb
  commands. No new regression-plan doc under `docs/features/` — this extends an
  existing pipeline whose spec is that README; the PR notes this explicitly.
- **Manual acceptance owed** (on-box, tracked in memory): boot each AVD, run the
  three capture scripts + `npm run frame:play`, eyeball the 7"/10"/fold framed
  sets in light + dark.
- **Release notes:** local-only brand/tooling change with no shipped app delta →
  `docs/release-notes-next.md` gets a one-line tooling entry; user-facing
  `RELEASE_NOTES.md` is skipped as no-user-delta, called out in the PR.

## Out of scope

- Any change to the app's adaptive UI (app-21 shipped that).
- Play Console upload automation (assets stay hand-uploaded, as today).
- New demo content (`lib/src/demo/` reused as-is).
- Phone-pipeline behaviour or output (byte-for-byte preserved).
