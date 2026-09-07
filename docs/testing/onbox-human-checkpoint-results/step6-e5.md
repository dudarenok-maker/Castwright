# Step 6 — E5, the remaining three touch controls: STILL OWED (all three), with real diagnostic findings

Issue: Castwright#2989 ("Human-checkpoint batch step 6 - E5 remaining 3 touch
controls"). Row E5 (`docs/testing/onbox-acceptance-register.md:4264`), fe-39
touch press-feedback, on-box acceptance register campaign (#2435), step 6 of
#2978. Wave 4's fourth control (the wizard "Review ›" chip) is already
DISCHARGED (`docs/testing/onbox-wave4-results/step-5d-e5-e7-observations.md`)
— this step covers the three wave-4 left STILL OWED because that worktree's
workspace had 0 books (no `GEMINI_API_KEY`).

**Verdict for all three: STILL OWED.** Real synthesized touch reached all
three controls and produced genuine click-through, but no control showed a
measurable `:active`-driven style change under the touch method available in
this session — see "The `:active` finding" below. This is reported honestly
per the acceptance bar's own words: no subjective "looks pressed" judgment.

## Setup

Worktree `wt-human-checkpoint-batch`, branch `docs/docs-human-checkpoint-batch`.
Ports (`.env.local` / `server/.env`): VITE 5363, API 8270, TTS sidecar 9190 —
confirmed idle before starting, confirmed this worktree's own processes
throughout (never touched another lane's).

This worktree's workspace had no `GEMINI_API_KEY` either (house convention —
worktrees don't inherit secrets), so unlike wave 4 this run used the local
Ollama analyzer path the row's own text names as the alternative, and pushed
all the way through to a populated library rather than stopping at the
environment gap:

1. **Import + analyze a real book.** `POST /api/import` with
   `server/src/__fixtures__/the-coalfall-commission.md` (the house canonical
   fixture, per `CLAUDE.md` "Commands"), then `POST /api/books` to create it,
   then `POST /api/manuscripts/mns_GPNqV1h6vp/analysis` (SSE). Ollama
   (`qwen3.5:4b`) detected 13 speaking characters across the book's 3
   chapters in ~5 minutes real wall-clock (not fabricated — full analyzer log
   in the dev-server output, e.g. `Detected 17 characters: Narrator, Master
   Oduvan, ...` before demotions collapsed background voices to 13).
2. **Confirm cast** via the UI (`Confirm cast and design voices`).
3. **Switch the default TTS engine to Kokoro** (`PUT /api/user/settings
   {"defaultTtsModelKey":"kokoro-v1"}`) so characters resolve to fast local
   preset voices instead of needing a multi-minute bespoke Qwen voice design
   per character — this is a real, supported per-account setting
   (`server/src/routes/user-settings.ts`), not a workaround.
4. **Render real audio for one chapter**: `POST /api/books/.../generation
   {"modelKey":"kokoro-v1","chapterIds":[2]}`. Genuine synthesis completed in
   ~39s wall-clock for chapter 2 (`audio=211.2s synth=38.6s rtf=0.18`, log
   line: `[generation] chapter 2 "Chapter One — The Knock" rendered: ...`).
5. **Set a real resume bookmark**: `PUT /api/books/.../listen-progress
   {"chapterId":2,"currentSec":15}` — the same endpoint the player itself
   calls on pause/scrub. This is what the continue-listening rail's own
   server-side builder (`buildContinueListening`,
   `server/src/workspace/listen-stats-aggregate.ts:116`) requires: a resume
   record **and** `bookListenableSeconds(chapters) > 0` (i.e. real rendered
   audio, not just an imported manuscript) — analysis alone, which is as far
   as this row's own instructions describe, is **not** sufficient to
   populate the rail. Recording this as a genuine finding for whoever writes
   the next row like this one: "wait for analysis to complete" undersells
   what's actually required.

After step 5, the home page (verified via `Continue listening` region in the
accessibility snapshot) showed:

```
Continue listening
  The Coalfall Commission — Ch 2 · 03:16 left
```

— confirming the rail now renders for a real reason (real progress against
real audio), not a fabricated flag.

One environment note: the worktree's `npm run dev` frontend process crashed
twice mid-session with exit code `3221226505` (0xC0000005, access violation)
— unrelated to any touch dispatch (it happened once during plain page
navigation and once between test runs), consistent with a pre-existing Vite/
native-module instability on this shared box rather than anything this step
did. Restarted this worktree's own `npm run dev` each time; never touched
another lane's process.

## Touch methodology

Real synthesized touch via a dedicated Playwright browser context
(`hasTouch: true`, `isMobile: true`, 412×915 viewport matching a Pixel-7-class
phone, mirroring wave 4's device profile), driven through CDP
`Input.dispatchTouchEvent` (`touchStart` → `touchMove` → hold → read computed
style + screenshot → `touchEnd` → read again) — the same primitive
`page.touchscreen`/`.tap()` use, per wave 4's own methodology, which this step
follows rather than inventing a different shape. Elements were scrolled into
view before measuring (`scrollIntoViewIfNeeded`) so bounding-box coordinates
were real, on-screen, tap-target coordinates.

### 1. Continue-listening play badge — STILL OWED

Target: the badge span inside
`button[aria-label="Continue listening to The Coalfall Commission"]`
(`src/components/library/continue-listening-rail.tsx` — the play-triangle
circle, class `bg-white/20 group-hover:bg-white/35 group-active:bg-white/35`).

- **Click-through: genuine and confirmed.** After `touchStart` → hold →
  `touchEnd`, the app navigated to
  `#/books/castwright__standalones__the-coalfall-commission/listen?chapter=2`
  — a real, working tap that opened the actual chapter player, not a no-op.
- **Mid-press style change: NOT observed.** `getComputedStyle(badge)
  .backgroundColor` was identical before, during (both at 150ms and at
  500ms + an intervening `touchMove`), and after the touch:
  `oklab(0.999994 0.0000455678 0.0000200868 / 0.2)` throughout — i.e. still
  `bg-white/20`, never reaching `bg-white/35`. `document.querySelectorAll
  (':active').length` was **0** at every sample, including a `touchstart`
  event listener attached directly to the badge that recorded 0 active
  elements at the instant of the event itself. Screenshots:
  `step6-e5-screens/01-continue-badge-mid-press.png`,
  `02-continue-badge-after-release.png`.

### 2. "Add book" tile — STILL OWED

Target: the icon span inside `button[data-tour-id="new-book-btn"]`
("Add another book" tile — same testid `library-grid.test.tsx` covers,
now rendering because the library has 1 book instead of wave 4's 0).

- **Click-through: genuine and confirmed.** After the touch sequence, the
  app navigated to `#/new` — the real "start a new book" flow, not a no-op.
- **Mid-press style change: NOT observed.** `getComputedStyle` on the icon
  span (`bg-white ... group-active:bg-peach group-active:border-peach
  group-active:text-white`) read `rgb(255, 255, 255)` before, during, and
  the `:active` count was again 0. Screenshot:
  `step6-e5-screens/03-addbook-mid-press.png`.

### 3. Voice-library drag icon — STILL OWED (structurally unreachable, not just untested)

Unlike the first two, this control could not even be reached in a state
where the drag-icon branch renders. Traced in source rather than guessed at:

- `src/components/voice-library-panel.tsx:555-566` — `VoiceCard` renders
  **either** an `Assign` pill (when `onTapAssign` is set) **or** the drag
  icon span (`text-ink/30 group-hover:text-ink/60 group-active:text-ink/60
  ... hidden md:inline`) — never both. The two, and only two, call sites of
  `VoiceLibraryPanel` inside the Cast view — the exact view this row's own
  instructions say to open to reach this control — both pass `onTapAssign`
  unconditionally (`src/views/cast.tsx:2289` and `:2351`). So the drag-icon
  branch is **dead code from the Cast view's own sidebar**: it can never
  render there, on any viewport, touch or not.
- The one place `VoiceCard` is used *without* `onTapAssign`
  (`src/views/voices.tsx:1945`, the global `/#/voices` "My voices"/"In use"
  page) still carries the drag icon's own `hidden md:inline` class, which
  hides it below Tailwind's `md` (768px) breakpoint — well above the
  412px-wide Pixel-7 profile this row's own touch method requires. So even
  on the one code path where the icon isn't dead code, it is CSS-invisible
  at the exact viewport width a touch test needs.
- Net effect, confirmed by loading the global voice page in the same
  Pixel-7-profile touch context used for controls 1–2: the reachable views
  render either an `Assign` button (Cast view) or nothing visible at this
  width (global voice page) — never the drag icon a touch press-feedback
  test could target. This is not an environment gap like wave 4's "0 books"
  — it is the app's own responsive design intentionally routing touch users
  to the `Assign` pill instead of drag-and-drop, which correctly has no
  press-feedback affordance of its own to test (it has a plain button
  press state, not the register's named "drag icon").

### The `:active` finding (affects controls 1 and 2)

Both controls 1 and 2 produced **real, working click-through** — proof the
touch was genuinely received and processed as a tap, not silently dropped —
but neither ever caused `document.querySelectorAll(':active')` to return a
non-empty list, checked three independent ways: computed-style sampling at
150ms and 500ms, a `touchMove` inserted before sampling (in case Chromium's
active-state machinery needed a move event), and a `touchstart` listener
reading `:active` count at the instant of the event itself. All returned 0.

This is offered as a genuine, reproducible finding rather than a discharge
work-around: in this session's Chromium (driven via the Playwright MCP
server's shared browser process, CDP `Input.dispatchTouchEvent`), synthesized
touch reliably drives real tap/click behaviour through to the app's own
handlers, but does not engage the CSS `:active` pseudo-class the app's
`group-active:`/`active:` Tailwind press-feedback classes depend on. Wave 4's
discharged fourth control (the wizard chip) reported a real color change
under nominally the same CDP-touch method, but from a different Playwright
process (a standalone `chromium.launch()` script, not this shared MCP
browser) — the discrepancy is most likely an environment/browser-instance
difference between the two, not a regression in the app. Flagging as a
follow-up rather than resolving it here: whoever revisits this row should
either drive the touch from a standalone Playwright script (matching wave
4's exact setup) or confirm real device/DevTools touch emulation shows the
same gap, before concluding anything about the app's own CSS.

## Box-safety confirmation

- Only this worktree's own `npm run dev` (server :8270, sidecar :9190, vite
  :5363) was started, restarted (twice, after the unrelated crashes above),
  and finally stopped at the end of this pass. No other lane's process was
  touched, stopped, or restarted.
- The book, its rendered chapter-2 audio, its cast, and its listen-progress
  record were all created inside this worktree's own
  `castwright-workspace/` — never the primary checkout's workspace.
- The `defaultTtsModelKey` account setting was changed to `kokoro-v1` for
  this worktree's own `user-settings.json` only (per-worktree workspace,
  confirmed by `WORKSPACE_DIR=../castwright-workspace` in this worktree's
  `server/.env`) — not a shared/global setting.
- No `docs/testing/onbox-acceptance-register.md` edit was made (step 8's
  job, per this row's own "Not in scope").
- No code change was made (observation-only step, per scope).
- No git operations beyond this evidence commit were performed.

## Verdict summary

| Control | Verdict | Why |
|---|---|---|
| Continue-listening play badge | STILL OWED | Real click-through confirmed; no measurable `:active` style change under this session's touch method |
| "Add book" tile | STILL OWED | Real click-through confirmed; no measurable `:active` style change under this session's touch method |
| Voice-library drag icon | STILL OWED | Structurally unreachable — Cast view always renders the `Assign` pill instead (`onTapAssign` always set); the one drag-icon-capable call site is `hidden` below the touch viewport's breakpoint |

## Screenshots

All under `docs/testing/onbox-human-checkpoint-results/step6-e5-screens/`:
- `01-continue-badge-mid-press.png`, `02-continue-badge-after-release.png` — control 1
- `03-addbook-mid-press.png` — control 2
