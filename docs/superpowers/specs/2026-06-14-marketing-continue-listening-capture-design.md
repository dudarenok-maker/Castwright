# Marketing capture: Continue Listening rail

- **Status:** draft
- **Date:** 2026-06-14
- **Area:** frontend / marketing capture harness
- **Branch:** `feat/frontend-marketing-continue-listening`

## Problem

The cross-book **Continue Listening** rail (fs-15, `src/components/library/continue-listening-rail.tsx`)
ships on the front (library) screen but has never appeared in a marketing
screenshot. Cause: the rail renders `null` when it has no items
(`continue-listening-rail.tsx:29`), and its data comes from
`api.getContinueListening()`, whose mock (`api.ts:1230`) only returns whatever is
in `globalThis.__SEED_CONTINUE__`. The demo-capture path
(`VITE_DEMO_CAPTURE=1`) never seeds it, so under `npm run capture:marketing` the
call returns `[]` and the rail silently disappears — even though the posed stats
say "In Progress 2". The committed `library-shelf.*.png` jumps straight from the
stats/filters to the book grid.

## Goal

Make the Continue Listening rail appear in the marketing set, populated with our
own manuscripts, with real covers and varied progress — so the captured images
honestly represent the product.

## Non-goals

- No change to the rail component, the real backend, or normal mock mode.
- No change to the `formatDuration` output format (see Decision D1).
- No companion (Android) marketing capture work — that path is separate.

## Design

### 1. Posed fixture

Add a `HOLLOW_TIDE_CONTINUE: ContinueListeningItem[]` export to
`src/mocks/marketing/hollow-tide.ts` (type imported from `../../lib/types`).
Three items, array order = on-screen order (the slice's `hydrate` does **not**
sort — `continue-listening-slice.ts:29`), `updatedAt` descending to also match
the OpenAPI ordering contract:

| # | bookId | title | chapterId | completionPct | remainingSec | renders as |
|---|---|---|---|---|---|---|
| 1 | `hollow-tide-1` | The Drowning Bell | 11 | 0.92 | 2040 | `Ch 11 · 34:00 left` |
| 2 | `coalfall-commission` | The Coalfall Commission | 3 | 0.28 | 6960 | `Ch 3 · 01:56:00 left` |
| 3 | `hollow-tide-2` | Saltgrave | 2 | 0.15 | 19260 | `Ch 2 · 05:21:00 left` |

`currentSec` set to plausible in-chapter offsets (display-irrelevant but
required by the schema). The set excludes `hollow-tide-3` (The Tidewatcher's
Oath) because it is only *analysing* — no generated audio, so a listen-resume
entry would misrepresent the feature. The 92% first card tells the
"started the next book before finishing the first" story.

Covers come free: the rail's `covers` prop is `coversByBookId`
(`book-library.tsx:253`), built from `allBooks` → `coverImageUrl`, and all three
books set `coverImageUrl` in `HOLLOW_TIDE_LIBRARY`.

### 2. Mock wiring

Add a `DEMO_CAPTURE` branch at the top of `mockGetContinueListening`
(`api.ts:1230`), returning a **fresh copy** so Immer's freeze of the `hydrate`
payload can't poison a re-fetch:

```ts
export async function mockGetContinueListening() {
  await wait(15);
  if (DEMO_CAPTURE) return HOLLOW_TIDE_CONTINUE.map((x) => ({ ...x }));
  const seeded = (globalThis as ...).__SEED_CONTINUE__;
  return seeded ?? [];
}
```

`HOLLOW_TIDE_CONTINUE` joins the existing marketing-fixture import block
(`api.ts:60`). The `__SEED_CONTINUE__` path is untouched, so the existing
`api.test.ts` seed tests stay green (the branch only fires under capture).

### 3. Scene registry + harness

Extend `Scene` (`e2e/marketing/scenes.ts`) with two optional fields:

- `scrollTo?: string` — selector to `scrollIntoView({ block: 'center' })` before
  the shot (viewport stays the frame, but the target is centred).
- `fullPage?: boolean` — per-scene full-page capture.

In `capture.spec.ts`: after the `waitFor` block and before the theme loop, if
`scene.scrollTo` is set, `await page.locator(scene.scrollTo).evaluate(el =>
el.scrollIntoView({ block: 'center' }))`. Change the screenshot's `fullPage` to
`scene.fullPage ?? process.env.CAPTURE_FULLPAGE === '1'`. Both fields are
optional, so every existing scene captures byte-identically.

### 4. New scenes

Two new rows in `SCENES`; the existing `library-shelf` brand hero is left
untouched.

```ts
{
  id: 'continue-listening',
  hash: '#/',
  viewports: ['desktop', 'phone', 'tablet'],
  waitFor: 'section[aria-label="Continue listening"]',
  scrollTo: 'section[aria-label="Continue listening"]',
},
{
  id: 'library-shelf-full',
  hash: '#/',
  viewports: ['desktop'],
  waitFor: 'section[aria-label="Continue listening"]',
  fullPage: true,
},
```

- `continue-listening` — the rail as a real product screen with app chrome
  above/below, across all three widths (phone/tablet prove the snap-scroll
  shelf). 6 PNGs (3 viewports × light/dark).
- `library-shelf-full` — the honest full front screen, desktop only (full-page
  phone/tablet would be absurdly tall). 2 PNGs. This is what literally closes
  the original "front screen has no rail" complaint.

Output (all to git-ignored `mockups/marketing-screens/`):
`continue-listening.{desktop,phone,tablet}.{light,dark}.png`,
`library-shelf-full.desktop.{light,dark}.png`.

Run: `CAPTURE_SCENE=continue-listening npm run capture:marketing` (add
`--project=phone --project=tablet` for the small widths) and
`CAPTURE_SCENE=library-shelf-full npm run capture:marketing`.

## Testing

Add a case to `src/mocks/marketing/hollow-tide.test.ts` asserting on the
exported `HOLLOW_TIDE_CONTINUE` constant directly (the `api.ts` `DEMO_CAPTURE`
branch can't be exercised through the api function under vitest, since the
module const reads `import.meta.env.VITE_DEMO_CAPTURE`, which isn't `'1'` in the
test env):

- exactly 3 items;
- each is shape-valid against `ContinueListeningItem` (required keys present);
- every `bookId` exists in `HOLLOW_TIDE_BOOK_STATES`;
- none is `hollow-tide-3` (no audio);
- `updatedAt` is strictly descending;
- the first item's `completionPct` is `0.92`.

The capture spec's inline registry guard already covers the two new scenes'
`#/`-prefixed, unique-id rows. The marketing capture is not a regression gate,
so no e2e baseline is added.

## Decisions / risks

- **D1 — remaining-time format accepted as-is.** `formatDuration` renders
  `MM:SS` / `HH:MM:SS`. The 92% first card is under an hour so it shows `34:00`
  while the others show `HH:MM:SS` — mildly inconsistent for the hero card, and
  "34:00" is slightly ambiguous in isolation, but the 92% progress bar carries
  the meaning. Changing the format would mean editing the rail component
  (out of scope), so we accept it.
- **D2 — Saltgrave `completionPct` is of the full book.** 0.15 of 6h18m while
  only 7/11 chapters have audio; "05:21:00 left" implies the whole book. Fine
  for a posed shot (you're in Ch 2, inside the generated range).
- **D3 — existing `library-shelf.png` left stale.** Not re-captured, so it keeps
  its rail-less top-of-page frame. A future full `capture:marketing` run would
  re-render it with the rail near the fold; harmless, since these are
  git-ignored working artifacts, not regression baselines.
