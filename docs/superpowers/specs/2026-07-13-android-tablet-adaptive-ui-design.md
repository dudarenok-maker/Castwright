# app-21 — Tablet & large-screen adaptive UI for the companion app

**Status:** design approved (2026-07-13), pending adversarial assumption-check
**Issue:** _to be filed at backlog-landing_ (`app-21`; see ID note below)
**Umbrella:** [plan 188 — Android companion app](../../features/188-android-companion-app.md)
**Scope:** `apps/android/` (Flutter companion) only. **No server changes, no OpenAPI changes.**

> **ID note:** `app-20` is already the untracked on-device-demo design in the working
> tree, so this work takes the next free ID, **`app-21`**. IDs are permanent per
> CLAUDE.md "The backlog".

## Problem

The companion app is built **phone-first and single-column throughout**, with no
responsive breakpoints anywhere in the UI layer:

- **`LibraryHomeScreen`** (`lib/src/ui/library_home_screen.dart`) is one `ListView`:
  a search field, a horizontal "Continue listening" rail of 100-dp cards, then an
  author→series→book tree of full-width `ListTile`s with 44×60-dp leading covers. On
  a 10" tablet the tiles stretch edge-to-edge and the cover art stays postage-stamp
  sized — a lot of wasted horizontal space and tiny artwork.
- **`PlayerScreen`** (`lib/src/ui/player_screen.dart`) is pushed as a **full-screen
  route**. On a tablet it swallows the whole display when it could sit beside the
  library. The screen's `initState`/`dispose` currently own playback *orchestration*
  (`ensureDetail` → pull-resume → `markPlayed` → `player.openBook`, and push-resume
  on exit).
- **Settings / pairing / QR-scan** are also full-screen pushed routes.
- There is **no `LayoutBuilder`, no window-size-class logic, no navigation rail, no
  master-detail, and no orientation/foldable handling** anywhere in `lib/src/ui/`.

The app runs fine on a tablet — it just looks like a blown-up phone. The ask is to
make it **feel native on large screens** (tablet + foldable, both orientations),
without regressing the phone experience and **without building anything we'd have to
tear out when the iOS/iPad target (`app-12`) wakes**.

## Goal

On large screens, present a **two-pane list-detail layout** — the library on the
left, the open book's player in a **persistent right pane** — with cover-forward
browsing, correct behaviour across rotation and foldable postures, and a persistent
live player that is never torn down by a layout change. On phones, behaviour is
**unchanged**. Every layout decision is **platform-neutral Flutter framework code**,
so the same UI serves iPad for free when `app-12` ships.

**Non-goals (YAGNI):**
- No change to phone (compact) behaviour.
- No new top-level navigation destinations and **no `NavigationRail`** — with only
  Library + Settings, a rail is nav we would later restructure. Settings stays an
  app-bar action (opening as a dialog on large screens).
- No Cupertino widgets (the app is Material 3 throughout; introducing a second
  design language now is exactly the kind of iOS-specific rework we're avoiding).
- No server / OpenAPI / thumbnail-endpoint changes — covers already exist at
  ~250 px (`ThumbnailCache`), which is ample for a grid.
- No hand-rolled hinge geometry beyond what `MediaQuery.displayFeatures` gives us.

## Cross-platform (iOS-readiness) constraint — first-class

This is an explicit design driver, not an afterthought. It becomes **principle #6**
in plan 188's "Cross-cutting iOS-readiness principles" list.

- The entire adaptive layer uses **only the Flutter framework**: `MediaQuery` size +
  `MediaQuery.displayFeatures`, and Material 3 widgets. **No Android-only plugins**
  (no Jetpack WindowManager bindings, no `flutter_displaymode`, no `dual_screen`
  package).
- Window size classes are expressed in **logical dp**, which classify an iPad
  identically to an Android tablet.
- `displayFeatures` is a cross-platform API that is simply **empty on iOS** (iPads
  don't fold) — so the foldable-aware split code is inert on iPad with zero rework.
- Back handling uses **`PopScope`**, not Android-specific back idioms.
- Touch targets stay **≥48 dp** (Material default), which also satisfies the iOS HIG
  44 pt minimum.

**Net effect:** when `app-12` wakes, this tablet UI *is* the iPad UI. Nothing here is
Android-shaped.

## Chosen approach: homegrown adaptive shell (no new dependencies)

A thin, testable adaptive layer built on `LayoutBuilder` + pure decision functions,
in preference to `flutter_adaptive_scaffold`. Rationale: the package rebuilds its
`body`/`secondaryBody` on breakpoint/rotation changes (fighting the "persistent live
player" requirement), adds a dependency and its own idioms, and its layout logic is
not unit-testable — whereas a pure helper *is*, which is exactly how this codebase is
built (injectable IO, pure tested domain logic) and how we de-risk **emulator-only**
acceptance (prove the logic in CI, verify only pixels on the device).

### Component 1 — window size classes (pure, `lib/src/domain/`)

New pure module `window_size.dart`:

```
enum WindowSizeClass { compact, medium, expanded }
WindowSizeClass windowSizeClassFor(double widthDp);   // <600 / 600–839 / ≥840
enum LibraryLayout { singlePane, twoPane }
LibraryLayout libraryLayoutFor(WindowSizeClass c);    // expanded→twoPane, else singlePane
```

Material 3 breakpoints (600 / 840 dp). Fully unit-tested; no Flutter-widget
dependency.

### Component 2 — foldable split (pure, `lib/src/domain/`)

New pure module `pane_split.dart`:

```
class PaneSplit { final double leftWidth; final double gutter; }   // gutter straddles a hinge
PaneSplit paneSplitForHinge(Size size, List<DisplayFeature> features, {double defaultLeftFraction});
```

- No vertical hinge present → `leftWidth = size.width * defaultLeftFraction`
  (clamped to a sane min/max, ~360–440 dp), `gutter = 0`.
- A vertical hinge/fold present → align `leftWidth` to the hinge's left edge and set
  `gutter` to the hinge's width, so neither pane renders *under* the hinge.
- Takes `List<DisplayFeature>` as a plain argument (not `BuildContext`) so it is a
  pure function. On iOS the caller passes an empty list → identical to the
  no-hinge branch. Unit-tested with synthesized `DisplayFeature`s.

### Component 3 — `activateBook` lifecycle lift (`CompanionRuntime`)

The `PlayerController` is **already** a persistent, process-lifetime runtime object
(`runtime.player`) with `switchBook(bookId)` (saves the outgoing book's position
locally, restores the new book at its own resume point, keeps the audio engine
live). The only thing the *screen* owns today is orchestration. Extract it:

```
Future<void> CompanionRuntime.activateBook(String bookId, {required String title})
```

which performs, in order:

1. `sync.ensureDetail(bookId)` — load the chapter detail.
2. best-effort `resumeSync.syncBook(bookId)` (pull a newer server position; offline-safe).
3. `library.markPlayed(bookId, now)` — drives Continue-listening + LRU eviction.
4. resolve the cover thumbnail path (`library.coverThumbPath`).
5. when a different book is already active, best-effort **push the outgoing book's
   resume to the server** (`resumeSync.syncBook(outgoingBookId)`) then
   `player.switchBook(bookId)` — note `switchBook` itself only saves the outgoing
   position *locally* (`saveNow`) and restores the new book; the server push is this
   explicit call. On the first activation (no active book) call
   `player.openBook(bookId, bookTitle: title, artPath: art)`.
6. **Idempotent**: if `player.currentBookId == bookId`, return without reopening (so
   re-selecting the already-open book in the pane is a no-op, not a restart).

A small `ActiveBook extends ChangeNotifier { String? bookId; String title; }` lives
on the shell (or runtime) and is the single source of truth both panes read.

**Resume-push relocation:** today the server push happens on `PlayerScreen.dispose`.
In two-pane there is no per-book dispose, so the push moves to (a) `switchBook`'s
save path inside `activateBook` (outgoing book pushed before the swap) and (b) an
app-lifecycle observer (`AppLifecycleState.paused` → `player.saveNow()` +
best-effort `resumeSync.syncBook(currentBookId)`). The compact `PlayerScreen` keeps
its existing dispose-push too — it is idempotent, so no double-write hazard beyond a
redundant PUT the server already tolerates (guarded compare-and-set, `srv-34`).

### Component 4 — `PlayerPane` extraction (`lib/src/ui/`)

Extract the chapter-list + transport body of `PlayerScreen` into a reusable
`PlayerPane` widget (`lib/src/ui/player_pane.dart`) that:

- observes `runtime.player` streams (`playingStream`, `nowPlayingStream`,
  `positionStream`, `chapterCompletedStream`) and the `ActiveBook` notifier;
- renders the "Select a book to start listening" **empty state** when no book is
  active (only reachable in two-pane);
- carries **no** `openBook`/`dispose`-push lifecycle of its own — that now lives in
  `activateBook` and the lifecycle observer.

`PlayerScreen` becomes a thin **compact host**: an `AppBar(title)` + `PlayerPane`,
pushed as a route exactly as today. This preserves the existing route, back
navigation, and the current widget tests. The waveform/transport internals
(`waveform_bar.dart`, speed cycle, boost sheet) move verbatim into `PlayerPane`.

### Component 5 — `AdaptiveLibraryShell` (`lib/src/ui/`)

New `AdaptiveLibraryShell` wraps today's library content and switches on
`libraryLayoutFor(windowSizeClassFor(constraints.maxWidth))`:

- **Expanded** → a `Row`: `SizedBox(width: split.leftWidth, child: LibraryPane)` ·
  `VerticalDivider` (offset by `split.gutter` for a hinge) ·
  `Expanded(child: PlayerPane)`. Selecting a book calls
  `runtime.activateBook(...)` + updates `ActiveBook` — **no route push**; the engine
  stays live and the right pane updates in place.
- **Medium / compact** → the library full-width; selecting a book calls
  `activateBook(...)` then **pushes** `PlayerScreen` (current behaviour). Medium
  additionally uses the cover-grid library layout (Component 6).

The library content is refactored out of `LibraryHomeScreen` into a `LibraryPane`
widget (grouping tree, search, download actions, offline chip, settings action) so it
renders identically inside the two-pane `Row` and the single-pane `Scaffold`.
`LibraryHomeScreen` becomes the `Scaffold` host that owns `ActiveBook` and composes
`AdaptiveLibraryShell`.

### Component 6 — cover-forward library on wide screens

On medium/expanded, each author→series section renders its books as a **cover grid**
(`GridView`/`Wrap` of larger cover tiles from the cached thumbnails) instead of thin
`ListTile`s; the "Continue listening" cards scale up. On compact, the existing
`ListTile` tree is unchanged. The `library_tree.dart` grouping domain is **untouched**
— this is purely a presentational branch keyed off the size class.

### Component 7 — orientation & foldable behaviour

- **No orientation lock.** Layout is width-driven, so a portrait→landscape rotation
  just recomputes the size class (e.g. tablet portrait `medium` single-pane →
  landscape `expanded` two-pane). Because the player lives on the runtime, rotation
  **never tears it down** — audio keeps playing, position preserved.
- **Foldable** postures change the available width/`displayFeatures`; the shell
  recomputes via `LayoutBuilder` + `paneSplitForHinge`. Validated in the Pixel Fold
  AVD posture simulator (folded → likely `medium` single-pane; unfolded → `expanded`
  two-pane with the split aligned to the hinge).

## Testing

Per CLAUDE.md testing discipline — pure logic in unit tests, UI seams in widget tests.

**Pure unit tests (Dart VM, no device):**
- `window_size_test.dart` — boundary cases at 599/600/839/840 dp for both functions.
- `pane_split_test.dart` — no-hinge default fraction + clamps; vertical-hinge
  alignment + gutter; empty-features (iOS) path.
- `activate_book_test.dart` — orchestration ordering with fakes (mirrors existing
  `player_controller`/runtime test patterns): ensureDetail→pull→markPlayed→switch;
  idempotent no-op when already active; outgoing-book resume push on switch.

**Widget tests** (`tester.view.physicalSize`/`devicePixelRatio` to force surfaces):
- shell renders **two-pane at ≥840 dp** and **single-pane below**;
- selecting a book in two-pane fills the `PlayerPane` **without** a route push
  (assert navigator stack depth unchanged);
- `PlayerPane` empty state before any selection;
- compact path still pushes `PlayerScreen` (existing behaviour green).

**Marketing capture / demo runtime:** the `runtimeOverride`/demo posed scenes
(`integration_test/marketing/`, `lib/src/demo/`) are updated for the two-pane
surface, and the capture stays green (known constraint — the demo renders these
screens directly).

**Emulator acceptance (manual, this box):**
- **Pixel Tablet AVD** — portrait (single-pane grid) and landscape (two-pane);
  select a book → plays in the right pane; switch books → seamless, each resumes at
  its own point; rotate mid-playback → audio continues, layout flips, no reload.
- **Pixel Fold AVD** — folded (single-pane) and unfolded (two-pane, split aligned to
  the hinge); posture change mid-playback → no player teardown.
- **Pixel 10 Pro AVD** (phone regression) — behaviour identical to today.

## Delivery

One branch (`feat/app-tablet-adaptive-ui`), one PR, `Refs`/`Closes` the `app-21`
issue filed at landing. Subagent-driven-development is viable but the surface is
small and shares the library/player spine; a single-thread implementation with the
per-task review gate is the likely shape. Standard gates: `assumption-checker` on
this spec and on the plan (Premium), `flutter analyze` + `flutter test` green, the
`app.yml` CI lane, emulator acceptance, and a `code-review` pass before merge.

## Follow-up items (filed as separate tickets, not in this PR)

- **`app-NN` — Tablet/foldable marketing scenes for the store listing.** This PR keeps
  the *existing* marketing capture green (a regression obligation), but the Play Store
  listing needs **new large-screen promotional screenshots** — the two-pane library,
  the persistent player pane, and a foldable-unfolded shot, in both light and dark.
  Google Play has a dedicated tablet-screenshots slot, so these are a real listing
  asset, not a nicety. Filed as a follow-up so it isn't lost; instructions: add posed
  tablet + foldable scenes to `integration_test/marketing/scenes.dart` at
  expanded-width surfaces (reusing the `runtimeOverride` demo runtime), capture from a
  tablet/foldable AVD, and drop the images into the marketing archive for the listing.
  Depends on this `app-21` UI landing. Gets a thin `docs/BACKLOG.md` row + `area:app`
  label at landing.

## Open questions folded into decisions

- **Nav rail?** No — YAGNI with two destinations; revisit only when a third
  top-level surface appears.
- **Settings on large screens?** App-bar action opening a **dialog**, not a pane.
- **Medium (tablet portrait)?** Single-pane **grid** with a pushed player; true
  two-pane only at expanded (≥840 dp).
