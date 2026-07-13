# app-21 — Tablet & large-screen adaptive UI for the companion app

**Status:** active — implemented 2026-07-13 on `feat/app-tablet-adaptive-ui` (10-task plan,
417/417 Dart tests green). Design approved 2026-07-13, revised after adversarial
assumption-check (persistent-pane view-state reload, `switchBook` metadata fix,
save→push→switch order, early idempotency guard) and reconciled with PR #1581's player
cover header + Play screenshot harness.
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

- No qualifying hinge → `leftWidth = size.width * defaultLeftFraction`
  (clamped to a sane min/max, ~360–440 dp), `gutter = 0`.
- A qualifying hinge → align `leftWidth` to the hinge's left edge and set `gutter` to
  the hinge's width, so neither pane renders *under* the hinge.
- **"Qualifying" is precisely defined:** `feature.type` is `hinge` or `fold`, `state`
  is `postureHalfOpened` **or** `postureFlat` (a fully-flat fold with a seam still wants
  the split), and the bounds are **vertical** (`bounds.width < bounds.height`, i.e. a
  left/right divide, not a top/bottom one). Anything else falls through to the no-hinge
  branch.
- Takes `List<DisplayFeature>` as a plain argument (not `BuildContext`) so it is a pure
  function. On iOS the caller passes an empty list → identical to the no-hinge branch.
  Unit-tested with synthesized `DisplayFeature`s (vertical hinge, horizontal hinge,
  empty).

### Component 3 — `activateBook` (audio orchestration only) + a `switchBook` fix

**A clean split, surfaced by the assumption-check.** `PlayerScreen._prepare` today
mixes two concerns that must be separated for a persistent pane:

- **Audio orchestration** (book-level, once per activation) → a new runtime method
  `activateBook`.
- **View state** (chapter list, finished-ticks, cover-art header, waveform peaks,
  scroll position, stream subscriptions, speed label) → stays in the widget,
  reloaded whenever the active book changes (Component 4).

`CompanionRuntime.activateBook(String bookId, {required String title, String? artPath})`:

0. **Early idempotency guard (precondition):** if `player.currentBookId == bookId`,
   return immediately — no `markPlayed`, no `syncBook`, no reopen. Re-selecting the
   open book is a true no-op, never a restart.
1. `sync.ensureDetail(bookId)` — load the chapter detail (required before the pane can
   read `sync.chaptersOf`).
2. resolve the cover thumbnail path (`library.coverThumbPath`) if not supplied.
3. **If a different book is currently active**, hand it off *fresh*: `player.saveNow()`
   (persist the live outgoing position — **not** the ≤10 s-old autosave) → best-effort
   `resumeSync.syncBook(outgoingBookId)` → `player.switchBook(bookId, bookTitle: title,
   artPath: art)`. **If no book is active**, `player.openBook(bookId, bookTitle: title,
   artPath: art)`.
4. `library.markPlayed(bookId, now)` — drives Continue-listening + LRU eviction.
5. best-effort `resumeSync.syncBook(bookId)` — reconcile the newly-active book with the
   server (offline-safe). `resumeSync.syncBook` is **bidirectional** — one call pushes
   the local position *and* pulls the server's, LWW-by-`listenedAt`
   (`ResumeSyncService`, companion_runtime.dart:115-116). "Push outgoing / pull incoming"
   is shorthand for two reconcile calls, not two directions.

**Required `PlayerController.switchBook` change (app-side, no server impact).** Today
`switchBook(bookId)` calls `openBook(bookId)` with the **default empty `bookTitle` and
null `artPath`** (player_controller.dart:451 → :216-217), which would blank the
lock-screen / Android-Auto / notification title + cover on every switch after the
first. Add `{String bookTitle = '', String? artPath}` to `switchBook` and thread them
into its `openBook` call; `activateBook` passes the resolved title + cover on **every**
switch. `switchBook` has **no production callers today** (two-pane is its first use), so
this is a safe extension, covered by extending `player_controller_test`.

A small `ActiveBook extends ChangeNotifier { String? bookId; String title; }` lives on
the shell and is the single source of truth both panes read.

**Resume-push relocation.** Today the server push happens on `PlayerScreen.dispose`. In
two-pane there is no per-book dispose, so pushes come from (a) `activateBook`'s
save→push→switch handoff above and (b) a new app-lifecycle observer
(`WidgetsBindingObserver.didChangeAppLifecycleState`; there is **none** in the app
today — grep-confirmed) on `AppLifecycleState.paused` → `player.saveNow()` + best-effort
`resumeSync.syncBook(currentBookId)`. This overlaps `AutoSyncService`'s
connectivity-triggered all-books flush (companion_runtime.dart:209-228) and the compact
`PlayerScreen.dispose` push, but all three are idempotent — `srv-34`'s guarded
compare-and-set tolerates the redundant PUT.

### Component 4 — `PlayerPane` extraction, keyed by the active book (`lib/src/ui/`)

Extract the chapter-list + transport body of `PlayerScreen` into a reusable
`PlayerPane` widget (`lib/src/ui/player_pane.dart`). **It owns the per-book view state**
that `activateBook` deliberately does not: on `initState` (and thus on every keyed
rebuild) it loads `sync.chaptersOf`, `library.finishedChapterUuids`, the
**cover-art header** path (the `_coverArtPath` + `_coverHeader()` that PR #1581 added to
`player_screen.dart`), the current chapter's waveform peaks, the post-frame
scroll-to-current, and subscribes the `runtime.player` streams (`playingStream`,
`nowPlayingStream`, `positionStream`, `chapterCompletedStream`). The transport internals
(`waveform_bar.dart`, speed cycle, boost sheet) move across — **except** the speed
label, which must be **seeded from `runtime.player.speed`** (or `settings.defaultSpeed`)
instead of the current hardcoded `1.0` (player_screen.dart:403), a latent bug the
persistent pane would otherwise amplify across switches.

**How the pane reloads on book switch — the crux the persistent design must answer.**
The pane is given `key: ValueKey(activeBookId)`. When selection flips the `ActiveBook`,
the shell rebuilds and Flutter tears down + recreates `PlayerPane` with the new key,
re-running `initState` → a fresh per-book view load. **The audio engine is untouched**
(it lives on `runtime.player`, driven by `activateBook`), so playback is seamless — only
the *widget* reloads, which is correct and cheap. This also makes rotation safe: the
audio never stops; the pane's transient widget state (peaks/scroll) simply re-derives
from the same active book. Empty state ("Select a book to start listening") renders when
`activeBookId == null` (two-pane only).

`PlayerScreen` becomes a thin **compact host**: `AppBar(title)` + `PlayerPane`, pushed as
a route exactly as today, preserving the existing route, back navigation, and the current
widget tests. **Widget keys (`Key('chapter-<uuid>')`, `Key('player-*')`, `Key('book-<id>')`)
are preserved verbatim** through the extraction so the wired `marketing_capture_test.dart`
(which taps `book-…` then `chapter-…` at a **phone-sized** surface and expects a
PlayerScreen push) stays green.

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

**Widget tests** (force the surface via `tester.view.physicalSize` **and**
`tester.view.devicePixelRatio` together — LayoutBuilder sees logical dp = physical ÷
DPR — and **reset both** via `addTearDown(tester.view.resetPhysicalSize)` +
`resetDevicePixelRatio` so the forced surface can't leak into sibling tests):
- shell renders **two-pane at ≥840 dp** and **single-pane below**;
- selecting a book in two-pane fills the `PlayerPane` **without** a route push — assert
  via a `NavigatorObserver` spy (no `didPush` after the first) that stack depth is
  unchanged;
- `PlayerPane` empty state before any selection;
- compact path still pushes `PlayerScreen` (existing behaviour green);
- `PlayerPane` widget tests run against the demo `DemoAudioEngine`/`runtimeOverride`
  (no real `just_audio`), as the existing `player_screen_test` does.

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
  listing needs **new large-screen promotional screenshots** — the two-pane library, the
  persistent player pane, and a foldable-unfolded shot, in light + dark. Google Play has
  a dedicated 7"/10" tablet-screenshots slot, so these are a real listing asset.
  **Reconcile, don't rebuild:** PR #1581 already shipped the Play screenshot pipeline —
  `integration_test/marketing/scenes.dart` (wired scenes) → `marketing_capture_test.dart`
  (raw-surface capture) → `scripts/frame-play-screenshots.mjs` (`npm run frame:play`,
  frames raws into 1764×3136 **phone** shots + a feature graphic). The follow-up **extends
  that harness**: add expanded-width (and foldable-unfolded) scenes captured at a
  tablet/foldable AVD surface, and add Play's **tablet output dimensions** to the framing
  script — it does **not** introduce a second harness. Depends on this `app-21` UI
  landing. Gets a thin `docs/BACKLOG.md` row + `area:app` label at landing.

## Open questions folded into decisions

- **Nav rail?** No — YAGNI with two destinations; revisit only when a third
  top-level surface appears.
- **Settings on large screens?** App-bar action opening a **dialog**, not a pane.
- **Medium (tablet portrait)?** Single-pane **grid** with a pushed player; true
  two-pane only at expanded (≥840 dp).
