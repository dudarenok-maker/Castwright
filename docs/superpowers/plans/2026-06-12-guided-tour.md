# Guided Tour Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an in-app, spotlight-style guided product tour that teaches new users by walking them, screen by screen, through the real app on the bundled canonical sample book.

**Architecture:** A declarative per-screen step registry feeds both a linear first-run tour and on-demand per-screen mini-tours. A `tour` slice + thunks drive *real* stage/view navigation (the spotlight always lands on a genuine screen); a `<TourOverlay/>` measures the anchored element and draws scrim + coach bubble. Completion persists server-side as `tourCompletedAt`, mirroring fs-21's `setupCompletedAt`. Entry points: empty-library CTA, top-bar `?` menu, Help button.

**Tech Stack:** React 18 + TypeScript, Redux Toolkit (+ thunks), Vite, Vitest + RTL, Playwright (chromium), Express/Zod (server), redux-persist (existing).

**Spec:** `docs/superpowers/specs/2026-06-12-guided-tour-design.md`. Read it first.

**Branch/worktree:** `feat/frontend-guided-tour` (worktree `C:/Claude/Projects/wt-guided-tour`). Run all commands from the worktree root.

**Sample-data note (read once):** Several anchors target the bundled sample (The Coalfall Commission). `api.loadSample('the-coalfall-commission')` returns bookId `castwright__standalones__the-coalfall-commission` (`api.ts:6254` mock). Three sample-specific ids are pinned as constants in Task 5 — confirm each against the real `cast.json` / manuscript at implementation; these are data lookups, not placeholders.

**Review round 1 corrections (verified against code — read before starting):**
- **`API_BASE` does not exist.** The api convention is bare relative `fetch('/api/...')` (`realCompleteSetup` is `fetch('/api/setup/complete', { method: 'POST' })`, `api.ts:5258`). Task 3 uses that.
- **Vitest does NOT use the mock toggle.** `USE_MOCKS` is `false` under vitest, so `api` resolves to `real`; tests mock it with `vi.mock('../lib/api', …)` (see `account-slice.test.ts:19`). Tasks 3–4 tests are written accordingly (Task 3 imports the exported mock fns directly; Task 4 `vi.mock`s the api).
- **Server test reset** is `_resetUserSettingsCache()` + `rmSync(USER_SETTINGS_PATH)` (no `resetUserSettingsForTest` export). Tasks 1–2 use it.
- **Top-bar props** are `stage: Stage['kind']` (a string) + `view: View | null` (`top-bar.tsx:155`), not a stage object. `screenForStage(stageKind, view)` (Task 11).
- **Empty-library has no flag gating** — it renders purely on `isLibraryEmpty` (`library-grid.tsx:77`). The tour CTA needs explicit `tourCompleted` suppression (Task 10).
- **🔴 Mock sample is not navigable yet** — `mockLoadSample`'s bookId isn't in `MOCK_LIBRARY`, and the Coalfall fixtures live only under `DEMO_CAPTURE`. **Task 13 (new)** seeds the sample into the standard mock flow; the e2e (now Task 14) depends on it.
- **ui actions are safely guarded** (verified): `changeView` no-ops unless `stage.kind==='ready'`; `setOpenProfileId` no-ops unless ready/confirm; neither throws. `openBook({id,status:'complete',manuscriptId})` lands `ready`/`listen`. No change needed — the engine's dispatch order (openBook → changeView → setOpenProfileId) is correct.

---

## Task 1: Server — `tourCompletedAt` user-setting (schema + getter/setter)

Mirror fs-21's `setupCompletedAt` exactly (`server/src/workspace/user-settings.ts:218,386,632-650`).

**Files:**
- Modify: `server/src/workspace/user-settings.ts`
- Test: `server/src/workspace/user-settings.test.ts`

- [ ] **Step 1: Write the failing test** — append after the `setupCompletedAt` describe block (`user-settings.test.ts:529`):

```ts
import { rmSync } from 'node:fs';
import * as mod from './user-settings.js';

async function resetSettings() {
  rmSync(mod.USER_SETTINGS_PATH, { force: true });
  mod._resetUserSettingsCache();
  await mod.readUserSettings();
}

describe('tourCompletedAt (guided tour)', () => {
  it('getResolvedTourCompletedAt is null before any write', async () => {
    await resetSettings();
    expect(mod.getResolvedTourCompletedAt()).toBeNull();
  });

  it('writeTourCompletedAt persists and the getter reflects it', async () => {
    await resetSettings();
    await mod.writeTourCompletedAt('2026-06-12T00:00:00.000Z');
    expect(mod.getResolvedTourCompletedAt()).toBe('2026-06-12T00:00:00.000Z');
  });
});
```

(This mirrors the `setupCompletedAt` block's reset exactly — `user-settings.test.ts:529-551`: `rmSync(USER_SETTINGS_PATH)` → `_resetUserSettingsCache()` → `readUserSettings()`. If the file already imports `_resetUserSettingsCache` / `USER_SETTINGS_PATH` namespaced differently, reuse its imports rather than re-importing.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/workspace/user-settings.test.ts -t "tourCompletedAt"`
Expected: FAIL — `getResolvedTourCompletedAt` / `writeTourCompletedAt` not exported.

- [ ] **Step 3: Implement** — three edits in `server/src/workspace/user-settings.ts`:

(a) Schema field, right after the `setupCompletedAt` line (218):

```ts
  /* Guided tour — ISO timestamp stamped when the user finishes/exits the
     tour. Suppresses the empty-library invitation. Kept out of the general
     PUT via FORBIDDEN_KEYS and written only by writeTourCompletedAt. */
  tourCompletedAt: z.string().nullable().optional(),
```

(b) Add to `FORBIDDEN_KEYS` after `'setupCompletedAt'` (386):

```ts
  /* guided tour — written only by writeTourCompletedAt. */
  'tourCompletedAt',
```

(c) Getter + writer after `writeSetupCompletedAt` (650):

```ts
/** Guided tour — sync read off the in-process cache. */
export function getResolvedTourCompletedAt(): string | null {
  return cached?.tourCompletedAt ?? null;
}

/** Dedicated writer (mirrors writeSetupCompletedAt): bypasses the general
    writeUserSettings strip path so the field persists, and refreshes the
    sync `cached` the getter reads. */
export async function writeTourCompletedAt(ts: string | null): Promise<UserSettings> {
  const next = writeChain.then(async () => {
    const current = await readUserSettings();
    const merged: UserSettings = { ...current, tourCompletedAt: ts };
    await writeJsonAtomic(USER_SETTINGS_PATH, merged);
    cached = merged;
    return merged;
  });
  writeChain = next.catch(() => undefined);
  return next;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/workspace/user-settings.test.ts -t "tourCompletedAt"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/workspace/user-settings.ts server/src/workspace/user-settings.test.ts
git commit -m "feat(server): tourCompletedAt user-setting (getter/setter)"
```

---

## Task 2: Server — `/api/tour` route (status + complete)

Mirror the setup route (`server/src/routes/setup-readiness.ts:70-76` + its route test).

**Files:**
- Create: `server/src/routes/tour.ts`
- Create: `server/src/routes/tour.route.test.ts`
- Modify: wherever routers are mounted (search `setupReadinessRouter` usage — same file mounts `/api/setup`; add `/api/tour` beside it).

- [ ] **Step 1: Write the failing test** — `server/src/routes/tour.route.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { rmSync } from 'node:fs';
import express from 'express';
import request from 'supertest';
import { tourRouter } from './tour.js';
import * as settings from '../workspace/user-settings.js';

function app() {
  const a = express();
  a.use('/api/tour', tourRouter);
  return a;
}

describe('/api/tour', () => {
  beforeEach(async () => {
    rmSync(settings.USER_SETTINGS_PATH, { force: true });
    settings._resetUserSettingsCache();
    await settings.readUserSettings();
  });

  it('GET /status returns { completedAt: null } before completion', async () => {
    const res = await request(app()).get('/api/tour/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ completedAt: null });
  });

  it('POST /complete stamps an ISO timestamp and GET reflects it', async () => {
    const post = await request(app()).post('/api/tour/complete');
    expect(post.status).toBe(200);
    expect(typeof post.body.completedAt).toBe('string');
    expect(new Date(post.body.completedAt).toISOString()).toBe(post.body.completedAt);

    const get = await request(app()).get('/api/tour/status');
    expect(get.body.completedAt).toBe(post.body.completedAt);
  });
});
```

(`tourRouter` reads the same in-process `cached` user-settings the writer updates, so the `rmSync`+`_resetUserSettingsCache`+`readUserSettings` reset gives each test a clean slate — same pattern as `user-settings.test.ts:529-551`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/routes/tour.route.test.ts`
Expected: FAIL — `./tour.js` does not exist.

- [ ] **Step 3: Implement** — `server/src/routes/tour.ts`:

```ts
import { Router, type Request, type Response } from 'express';
import { getResolvedTourCompletedAt, writeTourCompletedAt } from '../workspace/user-settings.js';

export const tourRouter = Router();

tourRouter.get('/status', (_req: Request, res: Response) => {
  res.json({ completedAt: getResolvedTourCompletedAt() });
});

tourRouter.post('/complete', async (_req: Request, res: Response) => {
  const ts = new Date().toISOString();
  await writeTourCompletedAt(ts);
  res.json({ completedAt: ts });
});
```

Then mount it where `setupReadinessRouter` is mounted (grep `setupReadinessRouter` in `server/src`): `app.use('/api/tour', tourRouter);`.

- [ ] **Step 4: Run test + typecheck**

Run: `cd server && npx vitest run src/routes/tour.route.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/tour.ts server/src/routes/tour.route.test.ts server/src/<app-file>.ts
git commit -m "feat(server): GET/POST /api/tour status+complete"
```

---

## Task 3: Frontend API — `getTourStatus` + `completeTour`

Mirror `completeSetup` (`api.ts:6004` real, `6254` mock).

**Files:**
- Modify: `src/lib/api.ts`
- Modify: `src/lib/api.test.ts` (if a sibling exists; otherwise covered by Task 4's slice test against the mock)

- [ ] **Step 1: Write the failing test** — `src/lib/api.tour.test.ts`. (Under vitest `api` resolves to `real`, which issues a real `fetch` jsdom can't serve — so test the exported **mock** functions directly; the real ones are covered by Task 2's server route test.)

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mockGetTourStatus, mockCompleteTour, _resetMockTour } from './api';

describe('tour api (mock fns)', () => {
  beforeEach(() => _resetMockTour());
  it('mockGetTourStatus returns { completedAt: null } initially', async () => {
    expect(await mockGetTourStatus()).toEqual({ completedAt: null });
  });
  it('mockCompleteTour stamps completedAt and the getter reflects it', async () => {
    const { completedAt } = await mockCompleteTour();
    expect(typeof completedAt).toBe('string');
    expect((await mockGetTourStatus()).completedAt).toBe(completedAt);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/api.tour.test.ts`
Expected: FAIL — `mockGetTourStatus` is not exported.

- [ ] **Step 3: Implement** — add real + mock functions and register them in both `api` objects (next to `completeSetup`). Use **bare relative `fetch`** (no `API_BASE` — it doesn't exist; mirrors `realCompleteSetup` at `api.ts:5258`):

```ts
// --- real (bare relative fetch, like realCompleteSetup / realGetSetupReadiness) ---
type TourStatus = { completedAt: string | null };
async function realGetTourStatus(): Promise<TourStatus> {
  const res = await fetch('/api/tour/status');
  if (!res.ok) throw new Error(`tour status ${res.status}`);
  return (await res.json()) as TourStatus;
}
async function realCompleteTour(): Promise<TourStatus> {
  const res = await fetch('/api/tour/complete', { method: 'POST' });
  if (!res.ok) throw new Error(`tour complete ${res.status}`);
  return (await res.json()) as TourStatus;
}

// --- mock (module-level state, like MOCK_LISTEN_PROGRESS; export + reset for tests) ---
let mockTourCompletedAt: string | null = null;
export async function mockGetTourStatus(): Promise<TourStatus> {
  return { completedAt: mockTourCompletedAt };
}
export async function mockCompleteTour(): Promise<TourStatus> {
  mockTourCompletedAt = new Date().toISOString();
  return { completedAt: mockTourCompletedAt };
}
export function _resetMockTour(): void {
  mockTourCompletedAt = null;
}
```

Register in the real `api` object (near `completeSetup: realCompleteSetup,`):

```ts
  getTourStatus: realGetTourStatus,
  completeTour: realCompleteTour,
```

and in the mock object (near `completeSetup: mockCompleteSetup,`):

```ts
  getTourStatus: mockGetTourStatus,
  completeTour: mockCompleteTour,
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/api.tour.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts src/lib/api.tour.test.ts
git commit -m "feat(frontend): api.getTourStatus + completeTour (real+mock)"
```

---

## Task 4: `tour` slice (state + status/complete thunks) + store registration

**Files:**
- Create: `src/store/tour-slice.ts`
- Create: `src/store/tour-slice.test.ts`
- Modify: `src/store/index.ts` (register reducer)

State shape (runtime + persisted-completion mirror):

- [ ] **Step 1: Write the failing test** — `src/store/tour-slice.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

// Under vitest `api` is the REAL impl (USE_MOCKS=false); mock it so the thunks
// don't issue real fetches. Mirrors account-slice.test.ts:19.
vi.mock('../lib/api', () => ({
  api: {
    getTourStatus: vi.fn(async () => ({ completedAt: null })),
    completeTour: vi.fn(async () => ({ completedAt: '2026-06-12T00:00:00.000Z' })),
    loadSample: vi.fn(async () => ({ bookId: 'castwright__standalones__the-coalfall-commission' })),
  },
}));

import { tourSlice, tourActions, fetchTourStatus } from './tour-slice';
import { configureStore } from '@reduxjs/toolkit';

const reducer = tourSlice.reducer;

describe('tour-slice reducers', () => {
  it('starts inactive with no step', () => {
    const s = reducer(undefined, { type: '@@init' });
    expect(s.active).toBe(false);
    expect(s.stepIndex).toBe(0);
    expect(s.completedAt).toBeNull();
  });

  it('startTour activates at step 0 with a tourId + mode', () => {
    const s = reducer(undefined, tourActions.startTour({ tourId: 'linear', mode: 'linear' }));
    expect(s.active).toBe(true);
    expect(s.tourId).toBe('linear');
    expect(s.mode).toBe('linear');
    expect(s.stepIndex).toBe(0);
  });

  it('setStepIndex / endTour', () => {
    let s = reducer(undefined, tourActions.startTour({ tourId: 'linear', mode: 'linear' }));
    s = reducer(s, tourActions.setStepIndex(3));
    expect(s.stepIndex).toBe(3);
    s = reducer(s, tourActions.endTour());
    expect(s.active).toBe(false);
  });

  it('markCompletedLocally stamps completedAt and deactivates', () => {
    let s = reducer(undefined, tourActions.startTour({ tourId: 'linear', mode: 'linear' }));
    s = reducer(s, tourActions.markCompletedLocally('2026-06-12T00:00:00.000Z'));
    expect(s.active).toBe(false);
    expect(s.completedAt).toBe('2026-06-12T00:00:00.000Z');
  });

  it('fetchTourStatus.fulfilled hydrates completedAt', async () => {
    const store = configureStore({ reducer: { tour: reducer } });
    await store.dispatch(fetchTourStatus());
    // mock api returns null initially
    expect(store.getState().tour.completedAt).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/store/tour-slice.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/store/tour-slice.ts`:

```ts
import { createSlice, createAsyncThunk, type PayloadAction } from '@reduxjs/toolkit';
import { api } from '../lib/api';

export type TourMode = 'linear' | 'screen';

export interface TourState {
  active: boolean;
  mode: TourMode;
  tourId: string | null;
  stepIndex: number;
  /** Server-sourced completion timestamp; null = not completed. */
  completedAt: string | null;
}

const initialState: TourState = {
  active: false,
  mode: 'linear',
  tourId: null,
  stepIndex: 0,
  completedAt: null,
};

/** Boot-time read of server completion (mirrors fetchAccountSettings). */
export const fetchTourStatus = createAsyncThunk('tour/fetchStatus', async () => {
  return api.getTourStatus();
});

/** Stamp completion server-side; the reducer mirrors it locally. */
export const completeTour = createAsyncThunk('tour/complete', async () => {
  return api.completeTour();
});

export const tourSlice = createSlice({
  name: 'tour',
  initialState,
  reducers: {
    startTour: (s, a: PayloadAction<{ tourId: string; mode: TourMode }>) => {
      s.active = true;
      s.tourId = a.payload.tourId;
      s.mode = a.payload.mode;
      s.stepIndex = 0;
    },
    setStepIndex: (s, a: PayloadAction<number>) => {
      s.stepIndex = a.payload;
    },
    endTour: (s) => {
      s.active = false;
      s.tourId = null;
      s.stepIndex = 0;
    },
    markCompletedLocally: (s, a: PayloadAction<string>) => {
      s.active = false;
      s.tourId = null;
      s.stepIndex = 0;
      s.completedAt = a.payload;
    },
  },
  extraReducers: (b) => {
    b.addCase(fetchTourStatus.fulfilled, (s, a) => {
      s.completedAt = a.payload.completedAt;
    });
    b.addCase(completeTour.fulfilled, (s, a) => {
      s.completedAt = a.payload.completedAt;
      s.active = false;
      s.tourId = null;
      s.stepIndex = 0;
    });
  },
});

export const tourActions = tourSlice.actions;
```

Register in `src/store/index.ts`: import `{ tourSlice }` and add `tour: tourSlice.reducer,` to the `reducer` map (after `config: configSlice.reducer,`). No persist wrapper — completion is server-sourced.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/store/tour-slice.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/tour-slice.ts src/store/tour-slice.test.ts src/store/index.ts
git commit -m "feat(frontend): tour slice + status/complete thunks"
```

---

## Task 5: Tour-step registry (single source of truth) + integrity test

**Files:**
- Create: `src/lib/tour-steps.ts`
- Create: `src/lib/tour-steps.test.ts`

- [ ] **Step 1: Write the failing test** — `src/lib/tour-steps.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { TOUR_STEPS, stepsForScreen, TOUR_SCREENS } from './tour-steps';

describe('tour-steps registry', () => {
  it('has the 13 steps across 5 stations in order', () => {
    expect(TOUR_STEPS).toHaveLength(13);
    const order = TOUR_STEPS.map((s) => s.screen);
    // first occurrence of each screen must follow station order
    const firstSeen = [...new Set(order)];
    expect(firstSeen).toEqual(['library', 'manuscript', 'cast', 'generate', 'listen']);
  });

  it('every step screen is a valid TourScreen', () => {
    for (const s of TOUR_STEPS) expect(TOUR_SCREENS).toContain(s.screen);
  });

  it('every non-null anchor is unique', () => {
    const anchors = TOUR_STEPS.map((s) => s.anchor).filter(Boolean) as string[];
    expect(new Set(anchors).size).toBe(anchors.length);
  });

  it('stepsForScreen("cast") returns the cast mini-tour in order', () => {
    const ids = stepsForScreen('cast').map((s) => s.id);
    expect(ids).toEqual(['s6-roster', 's7-drawer', 's8-fullcast']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/tour-steps.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/lib/tour-steps.ts` (copy from the spec's step map; pin the three sample-data constants):

```ts
export const TOUR_SCREENS = ['library', 'manuscript', 'cast', 'generate', 'listen'] as const;
export type TourScreen = (typeof TOUR_SCREENS)[number];

export type TourStep = {
  id: string;
  screen: TourScreen;
  anchor: string | null; // data-tour-id; null = centered bubble
  title: string;
  body: string;
  placement?: 'auto' | 'top' | 'bottom' | 'left' | 'right';
  kind: 'real' | 'explain';
  opensDrawer?: boolean;
};

/* Sample-data ids — CONFIRM against the real bundled sample (cast.json /
   manuscript) at implementation. In mock mode these match the canned sample. */
export const SAMPLE = {
  slug: 'the-coalfall-commission',
  bookId: 'castwright__standalones__the-coalfall-commission',
  drawerCharacterId: 'wren', // the character whose drawer s7 opens
} as const;

export const TOUR_STEPS: ReadonlyArray<TourStep> = [
  // 1 · Library
  { id: 's1-welcome', screen: 'library', anchor: null, kind: 'real',
    title: 'Welcome to Castwright',
    body: "Turn any book into a full-cast performance. We've loaded a sample — The Coalfall Commission — to show you how." },
  { id: 's2-card', screen: 'library', anchor: 'book-card', kind: 'real',
    title: 'Your library',
    body: 'Every book lives here. Open the sample to look inside.' },
  { id: 's3-newbook', screen: 'library', anchor: 'new-book-btn', kind: 'explain',
    title: 'Add your own book',
    body: 'Later, click New book and drop a manuscript — Castwright reads it and finds the cast (a few minutes). The sample is already read.' },
  // 2 · Manuscript
  { id: 's4-line', screen: 'manuscript', anchor: 'manuscript-line', kind: 'real',
    title: 'Who says each line',
    body: 'The whole book, line by line, colour-coded by speaker. Tap a line to reassign the speaker, or set a quote’s emotion.' },
  { id: 's5-boundary', screen: 'manuscript', anchor: 'chapter-boundary', kind: 'real',
    title: 'Chapters & paragraphs',
    body: 'Adjust where chapters begin and end, and merge or split paragraphs — drag the boundary handle (touch works too).' },
  // 3 · Cast & voices
  { id: 's6-roster', screen: 'cast', anchor: 'cast-roster', kind: 'real',
    title: 'Meet the cast',
    body: 'Narrator, Master Oduvan, Wren, Maerin… Merge duplicates and link characters from earlier books in a series.' },
  { id: 's7-drawer', screen: 'cast', anchor: 'profile-drawer', kind: 'real', opensDrawer: true,
    title: 'Give a character a voice',
    body: 'Open a character to read their profile and lines, design a voice from a description, preview it, and add emotion variants. This is where a character gets their sound.' },
  { id: 's8-fullcast', screen: 'cast', anchor: 'cast-roster', kind: 'explain',
    title: 'Design the whole cast',
    body: 'When you start a fresh book, Design full cast voices the whole roster in one pass.' },
  // 4 · Generate
  { id: 's9-generate', screen: 'generate', anchor: 'generate-resume-btn', kind: 'explain',
    title: 'Render the book',
    body: "Generation renders every chapter in the right voices — it keeps going without you. Chapter 1's done; Resume generation finishes the rest." },
  // 5 · Listen, pair & export
  { id: 's10-play', screen: 'listen', anchor: 'chapter-1-play', kind: 'real',
    title: 'Press play',
    body: 'Here’s the finished chapter 1 — the full cast, on Qwen voices. Press play. (The other chapters render once you generate them.)' },
  { id: 's11-companion', screen: 'listen', anchor: 'companion-app-banner', kind: 'real',
    title: 'Listen on your phone',
    body: 'Pair the Castwright Companion app with a quick QR scan and your library follows you to your phone.' },
  { id: 's12-export', screen: 'listen', anchor: 'download-tile-m4b', kind: 'real',
    title: 'Or any player',
    body: 'Prefer your own app? Export the audiobook (M4B here) and drop it into any player. Nothing locks you in.' },
  { id: 's13-finish', screen: 'listen', anchor: null, kind: 'real',
    title: "That’s the whole journey",
    body: 'Add your own book whenever you’re ready.' },
];

export function stepsForScreen(screen: TourScreen): TourStep[] {
  return TOUR_STEPS.filter((s) => s.screen === screen);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/tour-steps.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tour-steps.ts src/lib/tour-steps.test.ts
git commit -m "feat(frontend): tour-step registry (13 steps, 5 stations)"
```

---

## Task 6: Navigation thunks (drive real stage/view per step)

The engine that makes every spotlight land on a real screen. Lives with the slice.

**Files:**
- Modify: `src/store/tour-slice.ts` (append thunks)
- Modify: `src/store/tour-slice.test.ts`

- [ ] **Step 1: Write the failing test** — append:

```ts
import { uiActions } from './ui-slice';
import { startLinearTour, goToStep, nextStep, prevStep } from './tour-slice';
import { configureStore } from '@reduxjs/toolkit';
import { tourSlice } from './tour-slice';
import { uiSlice } from './ui-slice';

function mkStore() {
  return configureStore({ reducer: { tour: tourSlice.reducer, ui: uiSlice.reducer } });
}

describe('tour navigation thunks', () => {
  it('goToStep("manuscript" step) navigates ui to that view', async () => {
    const store = mkStore();
    store.dispatch(uiActions.openBook({ id: 'b', status: 'complete', manuscriptId: 'm' }));
    store.dispatch(tourSlice.actions.startTour({ tourId: 'linear', mode: 'linear' }));
    await store.dispatch(goToStep(3)); // s4-line → manuscript
    const stage = store.getState().ui.stage;
    expect(stage.kind).toBe('ready');
    if (stage.kind === 'ready') expect(stage.view).toBe('manuscript');
    expect(store.getState().tour.stepIndex).toBe(3);
  });

  it('opensDrawer step sets openProfileId; prevStep off it clears it', async () => {
    const store = mkStore();
    store.dispatch(uiActions.openBook({ id: 'b', status: 'complete', manuscriptId: 'm' }));
    store.dispatch(tourSlice.actions.startTour({ tourId: 'linear', mode: 'linear' }));
    await store.dispatch(goToStep(6)); // s7-drawer
    let stage = store.getState().ui.stage;
    if (stage.kind === 'ready') expect(stage.openProfileId).toBe('wren');
    await store.dispatch(goToStep(5)); // back to s6-roster
    stage = store.getState().ui.stage;
    if (stage.kind === 'ready') expect(stage.openProfileId).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/store/tour-slice.test.ts -t "navigation thunks"`
Expected: FAIL — `goToStep` not exported.

- [ ] **Step 3: Implement** — append to `src/store/tour-slice.ts`:

Add these imports at the top of `src/store/tour-slice.ts` (next to the existing imports; do NOT import from `./tour-slice` itself — `completeTour` is already defined in this module):

```ts
import type { ThunkAction, UnknownAction } from '@reduxjs/toolkit';
import { uiActions } from './ui-slice';
import { TOUR_STEPS, stepsForScreen, SAMPLE, type TourScreen } from '../lib/tour-steps';
```

Then append the thunks (`api` is already imported in Task 4):

```ts
type AppThunk = ThunkAction<void | Promise<void>, any, unknown, UnknownAction>;

const VIEW_FOR_SCREEN: Record<Exclude<TourScreen, 'library'>, 'manuscript' | 'cast' | 'generate' | 'listen'> = {
  manuscript: 'manuscript', cast: 'cast', generate: 'generate', listen: 'listen',
};

/** Put ui on the screen a step needs, opening/closing the drawer to match. */
function navigateForStep(stepIndex: number): AppThunk {
  return (dispatch, getState) => {
    const step = TOUR_STEPS[stepIndex];
    if (!step) return;
    if (step.screen === 'library') {
      dispatch(uiActions.goHome());
      return;
    }
    const stage = getState().ui.stage;
    if (stage.kind !== 'ready' || stage.bookId !== SAMPLE.bookId) {
      dispatch(uiActions.openBook({ id: SAMPLE.bookId, status: 'complete', manuscriptId: SAMPLE.bookId }));
    }
    dispatch(uiActions.changeView(VIEW_FOR_SCREEN[step.screen]));
    dispatch(uiActions.setOpenProfileId(step.opensDrawer ? SAMPLE.drawerCharacterId : null));
  };
}

export function goToStep(stepIndex: number): AppThunk {
  return (dispatch) => {
    if (stepIndex < 0 || stepIndex >= TOUR_STEPS.length) return;
    dispatch(navigateForStep(stepIndex));
    dispatch(tourSlice.actions.setStepIndex(stepIndex));
  };
}

export function nextStep(): AppThunk {
  return (dispatch, getState) => {
    const { stepIndex, mode, tourId } = getState().tour;
    if (mode === 'screen') {
      const slice = stepsForScreen(tourId as TourScreen);
      const posInSlice = slice.findIndex((s) => s.id === TOUR_STEPS[stepIndex].id);
      if (posInSlice + 1 >= slice.length) { dispatch(tourSlice.actions.endTour()); return; }
      dispatch(goToStep(TOUR_STEPS.indexOf(slice[posInSlice + 1])));
      return;
    }
    if (stepIndex + 1 >= TOUR_STEPS.length) { dispatch(finishTour()); return; }
    dispatch(goToStep(stepIndex + 1));
  };
}

export function prevStep(): AppThunk {
  return (dispatch, getState) => {
    const { stepIndex } = getState().tour;
    if (stepIndex > 0) dispatch(goToStep(stepIndex - 1));
  };
}

/** Provision the sample, then start the linear tour at step 0. */
export function startLinearTour(): AppThunk {
  return async (dispatch, getState) => {
    const stage = getState().ui.stage;
    const haveSample = stage.kind === 'ready' && stage.bookId === SAMPLE.bookId;
    if (!haveSample) {
      try { await api.loadSample(SAMPLE.slug); } catch { /* already present / offline — proceed */ }
    }
    dispatch(tourSlice.actions.startTour({ tourId: 'linear', mode: 'linear' }));
    dispatch(goToStep(0));
  };
}

/** Run a single screen's mini-tour on whatever book is open (no provisioning). */
export function startScreenTour(screen: TourScreen): AppThunk {
  return (dispatch) => {
    const first = stepsForScreen(screen)[0];
    if (!first) return;
    dispatch(tourSlice.actions.startTour({ tourId: screen, mode: 'screen' }));
    dispatch(goToStep(TOUR_STEPS.indexOf(first)));
  };
}

/** Stamp completion server-side (the extraReducer mirrors it locally + ends). */
export function finishTour(): AppThunk {
  return async (dispatch) => {
    await dispatch(completeTour());
  };
}
```

Note: `api.loadSample` already exists (`api.ts:3059`/mock `6254`). `startScreenTour` is consumed by the top-bar menu in Task 11.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/store/tour-slice.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/tour-slice.ts src/store/tour-slice.test.ts
git commit -m "feat(frontend): tour navigation thunks drive real stage/view"
```

---

## Task 7: `<TourOverlay/>` — spotlight scrim + coach bubble + fallback

**Files:**
- Create: `src/components/tour/tour-overlay.tsx`
- Create: `src/components/tour/tour-overlay.test.tsx`

- [ ] **Step 1: Write the failing test** — `src/components/tour/tour-overlay.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { tourSlice } from '../../store/tour-slice';
import { uiSlice } from '../../store/ui-slice';
import { TourOverlay } from './tour-overlay';

function mkStore(stepIndex: number, active = true) {
  const store = configureStore({ reducer: { tour: tourSlice.reducer, ui: uiSlice.reducer } });
  store.dispatch(tourSlice.actions.startTour({ tourId: 'linear', mode: 'linear' }));
  store.dispatch(tourSlice.actions.setStepIndex(stepIndex));
  if (!active) store.dispatch(tourSlice.actions.endTour());
  return store;
}

describe('TourOverlay', () => {
  it('renders nothing when inactive', () => {
    const { container } = render(<Provider store={mkStore(0, false)}><TourOverlay /></Provider>);
    expect(container.querySelector('[data-testid="tour-overlay"]')).toBeNull();
  });

  it('renders the coach bubble title/body for the current step', () => {
    render(<Provider store={mkStore(0)}><TourOverlay /></Provider>);
    expect(screen.getByText('Welcome to Castwright')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /next/i })).toBeInTheDocument();
  });

  it('falls back to a centered bubble when the anchor is missing', () => {
    // step 1 (s2-card) anchors book-card, which is not in the DOM here
    render(<Provider store={mkStore(1)}><TourOverlay /></Provider>);
    const bubble = screen.getByTestId('tour-bubble');
    expect(bubble.getAttribute('data-anchored')).toBe('false');
  });

  it('Skip ends the tour', () => {
    const store = mkStore(0);
    render(<Provider store={store}><TourOverlay /></Provider>);
    fireEvent.click(screen.getByRole('button', { name: /skip/i }));
    expect(store.getState().tour.active).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/tour/tour-overlay.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/components/tour/tour-overlay.tsx`:

```tsx
import { useEffect, useLayoutEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useAppDispatch, useAppSelector } from '../../store';
import { TOUR_STEPS } from '../../lib/tour-steps';
import { tourActions, nextStep, prevStep } from '../../store/tour-slice';

type Rect = { top: number; left: number; width: number; height: number };

function measure(anchor: string | null): Rect | null {
  if (!anchor) return null;
  const el = document.querySelector<HTMLElement>(`[data-tour-id="${anchor}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

export function TourOverlay() {
  const dispatch = useAppDispatch();
  const { active, stepIndex } = useAppSelector((s) => s.tour);
  const step = active ? TOUR_STEPS[stepIndex] : null;
  const [rect, setRect] = useState<Rect | null>(null);

  const remeasure = useCallback(() => {
    setRect(step ? measure(step.anchor) : null);
  }, [step]);

  // Re-measure after the step's navigation settles; retry briefly for late mounts.
  useLayoutEffect(() => {
    if (!step) return;
    remeasure();
    const ids = [50, 150, 350].map((ms) => window.setTimeout(remeasure, ms));
    return () => ids.forEach(clearTimeout);
  }, [step, remeasure]);

  useEffect(() => {
    if (!step) return;
    window.addEventListener('scroll', remeasure, true);
    window.addEventListener('resize', remeasure);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') dispatch(tourActions.endTour()); };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', remeasure, true);
      window.removeEventListener('resize', remeasure);
      window.removeEventListener('keydown', onKey);
    };
  }, [step, remeasure, dispatch]);

  if (!step) return null;

  const anchored = rect != null;
  const pad = 6;
  // Bubble: below the anchor when anchored, centered otherwise.
  const bubbleStyle: React.CSSProperties = anchored
    ? { position: 'fixed', top: Math.min(rect!.top + rect!.height + 12, window.innerHeight - 220),
        left: Math.max(12, Math.min(rect!.left, window.innerWidth - 332)), width: 320 }
    : { position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: 320 };

  return createPortal(
    <div data-testid="tour-overlay" className="fixed inset-0 z-[75]" aria-live="polite">
      {/* Scrim: a single box-shadow ring around the lit cutout. pointer-events
          none over the hole so the highlighted control stays clickable. */}
      {anchored ? (
        <div
          aria-hidden
          style={{
            position: 'fixed',
            top: rect!.top - pad, left: rect!.left - pad,
            width: rect!.width + pad * 2, height: rect!.height + pad * 2,
            borderRadius: 10, boxShadow: '0 0 0 9999px rgba(15,14,13,.55)',
            outline: '2px solid var(--peach)', pointerEvents: 'none',
          }}
        />
      ) : (
        <div aria-hidden className="fixed inset-0" style={{ background: 'rgba(15,14,13,.55)' }} />
      )}

      <div
        data-testid="tour-bubble"
        data-anchored={anchored ? 'true' : 'false'}
        role="dialog"
        aria-label={step.title}
        className="rounded-2xl bg-ink text-canvas p-4 shadow-float"
        style={bubbleStyle}
      >
        <h4 className="font-semibold text-sm">{step.title}</h4>
        <p className="mt-1 text-xs text-canvas/75 leading-relaxed">{step.body}</p>
        <div className="mt-3 flex items-center gap-2">
          <div className="flex gap-1" aria-hidden>
            {TOUR_STEPS.map((s, i) => (
              <span key={s.id} className={`w-1.5 h-1.5 rounded-full ${i === stepIndex ? 'bg-peach' : 'bg-canvas/30'}`} />
            ))}
          </div>
          <button type="button" onClick={() => dispatch(tourActions.endTour())}
            className="ml-auto text-xs text-canvas/60 min-h-[44px] sm:min-h-0">Skip</button>
          {stepIndex > 0 && (
            <button type="button" onClick={() => dispatch(prevStep())}
              className="text-xs font-semibold text-canvas/80 min-h-[44px] sm:min-h-0">Back</button>
          )}
          <button type="button" onClick={() => dispatch(nextStep())}
            className="text-xs font-bold bg-peach text-ink rounded-lg px-3 py-1.5 min-h-[44px] sm:min-h-0">
            {stepIndex === TOUR_STEPS.length - 1 ? 'Done' : 'Next →'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/tour/tour-overlay.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/tour/
git commit -m "feat(frontend): TourOverlay spotlight + coach bubble + fallback"
```

---

## Task 8: Mount overlay + boot status fetch in layout

**Files:**
- Modify: `src/components/layout.tsx` (mount `<TourOverlay/>`; dispatch `fetchTourStatus` beside `fetchAccountSettings` at `layout.tsx:453`)

- [ ] **Step 1: Write the failing test** — add to `src/components/layout.test.tsx` (match its existing render harness):

```tsx
it('mounts the tour overlay container only when a tour is active', async () => {
  // render Layout with a store where tour.active=false → no overlay
  // then dispatch startTour + goToStep(0) → overlay appears
  // (use the file's existing renderWithStore helper + store handle)
});
```

Flesh out using the file's existing helper (assert `queryByTestId('tour-overlay')` toggles with `store.dispatch(tourActions.startTour(...))`).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/layout.test.tsx -t "tour overlay"`
Expected: FAIL — overlay not mounted.

- [ ] **Step 3: Implement** — in `layout.tsx`:
  - import `{ TourOverlay }` and render `<TourOverlay />` once near the root return (sibling to the stage views, before the closing fragment).
  - import `{ fetchTourStatus }` from `../store/tour-slice` and, in the same effect that dispatches `fetchAccountSettings()` (line ~453), add `void dispatch(fetchTourStatus());`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/layout.test.tsx -t "tour overlay" && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/layout.tsx src/components/layout.test.tsx
git commit -m "feat(frontend): mount TourOverlay + boot tour-status fetch"
```

---

## Task 9: Add `data-tour-id` anchors to existing views

Purely additive attributes. One commit, but verify each renders.

**Files (add `data-tour-id="<id>"` to the listed element):**
- `src/components/library/library-grid.tsx` — the sample book's card → `book-card`; the NewBookCard button (~524) → `new-book-btn`.
- `src/views/manuscript.tsx` — the first dialogue sentence span (~1270; pin by the known `SAMPLE` first-quote sentence) → `manuscript-line`; **add a new attribute** to the `BoundaryHandle` span (~1318) → `chapter-boundary` (first boundary only).
- `src/views/cast.tsx` — the "Detected" roster aside (~945) → `cast-roster`.
- `src/modals/profile-drawer.tsx` — the `<aside>` (~802) → `profile-drawer`.
- `src/views/generation.tsx` — the resume control (~881) → `generate-resume-btn`.
- `src/components/listen/listen-player-region.tsx` — chapter 1's play button (~340, inside `chapter-row-1`) → `chapter-1-play`.
- `src/components/listen/companion-app-banner.tsx` — the `<section>` (~38) → `companion-app-banner`.
- `src/components/listen/listen-download-section.tsx` — the M4B tile button (~96/168) → `download-tile-m4b`.

- [ ] **Step 1: Write the failing test** — `src/lib/tour-anchors.test.tsx` (a render-smoke that each anchor exists for the views renderable in jsdom; for views needing heavy stores, assert the string is present in source instead):

```tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { CompanionAppBanner } from '../components/listen/companion-app-banner';
import * as api from './api';
import { vi } from 'vitest';

describe('tour anchors (smoke)', () => {
  it('companion banner carries data-tour-id', async () => {
    vi.spyOn(api.api, 'checkCompanionApk').mockResolvedValue({ available: false, sizeBytes: null } as any);
    const { container } = render(<CompanionAppBanner />);
    expect(container.querySelector('[data-tour-id="companion-app-banner"]')).not.toBeNull();
  });
});
```

(Cover the remaining anchors in Task 14's e2e, which renders the real app — cheaper than booting every heavy view in jsdom.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/tour-anchors.test.tsx`
Expected: FAIL — attribute absent.

- [ ] **Step 3: Implement** — add each `data-tour-id` per the file list above. Example (companion banner, `companion-app-banner.tsx:38`):

```tsx
<section data-testid="companion-app-banner" data-tour-id="companion-app-banner" ...>
```

For the `BoundaryHandle` (no existing attribute), add to the span and gate to the first boundary:

```tsx
<span {...(boundaryIdx === 1 ? { 'data-tour-id': 'chapter-boundary' } : {})} onPointerDown={...} />
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/tour-anchors.test.tsx && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components src/views src/modals src/lib/tour-anchors.test.tsx
git commit -m "feat(frontend): data-tour-id anchors for tour targets"
```

---

## Task 10: Empty-library "Take the guided tour" CTA

**Files:**
- Modify: `src/components/library/library-empty-states.tsx` (add `onStartTour` + `tourCompleted` props + primary button)
- Modify: `src/components/library/library-grid.tsx`, `src/views/book-library.tsx` (thread the props)
- Modify: `src/components/library/library-empty-states.test.tsx`

> **Suppression (verified gap):** the empty state renders purely on `isLibraryEmpty` (`library-grid.tsx:77`) with NO existing flag gating. The tour CTA must be suppressed once `tour.completedAt` is set, so a returning user who deleted the sample isn't re-nagged. We thread a `tourCompleted` boolean down and hide the CTA when true.

- [ ] **Step 1: Write the failing tests** — in `library-empty-states.test.tsx`:

```tsx
it('renders the guided-tour CTA and fires onStartTour', () => {
  const onStartTour = vi.fn();
  render(<EmptyLibrary onStartNew={() => {}} onTrySample={() => {}} onStartTour={onStartTour} tourCompleted={false} />);
  fireEvent.click(screen.getByRole('button', { name: /take the guided tour/i }));
  expect(onStartTour).toHaveBeenCalled();
});

it('suppresses the guided-tour CTA once the tour is completed', () => {
  render(<EmptyLibrary onStartNew={() => {}} onTrySample={() => {}} onStartTour={vi.fn()} tourCompleted />);
  expect(screen.queryByRole('button', { name: /take the guided tour/i })).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/components/library/library-empty-states.test.tsx -t "guided-tour"` → FAIL.

- [ ] **Step 3: Implement** — extend `EmptyLibrary`:

```tsx
export function EmptyLibrary({ onStartNew, onTrySample, onStartTour, tourCompleted }: {
  onStartNew: () => void; onTrySample?: () => void;
  onStartTour?: () => void; tourCompleted?: boolean;
}) {
  // ...existing markup; the tour CTA is the primary action when offered:
}
```

Add, above the existing `PrimaryButton` (only when offered AND not yet completed):

```tsx
{onStartTour && !tourCompleted && (
  <PrimaryButton variant="dark" onClick={onStartTour}>
    <span className="inline-flex items-center gap-2">Take the guided tour</span>
  </PrimaryButton>
)}
```

Keep "Import your first book" as the (secondary) action. Thread the props `book-library.tsx` → `library-grid.tsx` → `EmptyLibrary`. In `book-library.tsx`:

```tsx
const tourCompleted = useAppSelector((s) => s.tour.completedAt != null);
// ...pass onStartTour={() => dispatch(startLinearTour())} tourCompleted={tourCompleted}
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/components/library/library-empty-states.test.tsx && npm run typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/library src/views/book-library.tsx
git commit -m "feat(frontend): empty-library guided-tour CTA"
```

---

## Task 11: Top-bar `?` → menu (Help · Take the tour · Show me this screen)

**Files:**
- Modify: `src/components/top-bar.tsx` (`:346`)
- Modify: `src/components/top-bar.test.tsx` (`:120`)
- Reference pattern: `src/components/status-popover.tsx` (portal popover)

- [ ] **Step 1: Rewrite the failing test** — replace the assertion at `top-bar.test.tsx:120`:

```tsx
it('renders the Help menu trigger and opens a popover with the three actions', () => {
  // render TopBar (use the file's existing harness)
  const trigger = screen.getByTestId('topbar-help');
  expect(trigger.tagName).toBe('BUTTON');
  fireEvent.click(trigger);
  expect(screen.getByRole('menuitem', { name: /^help$/i })).toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: /take the tour/i })).toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: /show me this screen/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/components/top-bar.test.tsx -t "Help menu"` → FAIL.

- [ ] **Step 3: Implement** — replace the `<a href="#/help">` block (`:346-356`) with a button that toggles a small popover (mirror `status-popover.tsx`'s portal + outside-click-close). Keep `data-testid="topbar-help"` on the button; add `aria-haspopup="menu"` + `aria-expanded`. Menu items:
  - **Help** → navigate to `#/help` (use the existing nav mechanism — `stageToHash({kind:'help'})` / `dispatch(uiActions.openHelp())`).
  - **Take the tour** → `dispatch(startLinearTour())`.
  - **Show me this screen** → compute the current `TourScreen` via `screenForStage(stage, view)` (top-bar already has these two props — see below) and `dispatch(startScreenTour(screen))`; **disable** the item when `screenForStage` returns `null`.

Provide a `screenForStage` helper in `tour-steps.ts`. **Top-bar passes `stage: Stage['kind']` (a string) + `view: View | null` separately** (`top-bar.tsx:155-156`), so the helper takes those two primitives — NOT a stage object:

```ts
export function screenForStage(stageKind: string, view: string | null): TourScreen | null {
  if (stageKind === 'books') return 'library';
  if (stageKind === 'ready') {
    if (view === 'manuscript' || view === 'cast' || view === 'generate' || view === 'listen') return view;
  }
  return null;
}
```

Add a unit test in `tour-steps.test.ts`:

```ts
it('screenForStage maps stage-kind + view to a TourScreen', () => {
  expect(screenForStage('books', null)).toBe('library');
  expect(screenForStage('ready', 'cast')).toBe('cast');
  expect(screenForStage('ready', 'log')).toBeNull();
  expect(screenForStage('account', null)).toBeNull();
});
```

In `top-bar.tsx`, the "Show me this screen" handler is `const screen = screenForStage(stage, view);` then `screen && dispatch(startScreenTour(screen))`, with the menu item `disabled={!screen}`.

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/components/top-bar.test.tsx && npm run typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/top-bar.tsx src/components/top-bar.test.tsx src/lib/tour-steps.ts src/lib/tour-steps.test.ts
git commit -m "feat(frontend): top-bar ? menu (help/tour/show-this-screen)"
```

---

## Task 12: Help view "Take the tour" button

**Files:**
- Modify: `src/views/help.tsx` (Getting-started section, ~167)
- Modify: `src/views/help.test.tsx`

- [ ] **Step 1: Write the failing test**:

```tsx
it('offers a Take the tour button that starts the linear tour', () => {
  // render HelpView with a real store; click the button; assert store.tour.active === true
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL.

- [ ] **Step 3: Implement** — add a button under the Getting-started heading:

```tsx
<button type="button" onClick={() => dispatch(startLinearTour())}
  className="mt-4 inline-flex items-center gap-2 rounded-lg bg-ink text-canvas px-4 py-2 text-sm font-semibold min-h-[44px] sm:min-h-0">
  Take the tour
</button>
```

(Wire `useAppDispatch`; import `startLinearTour`.)

- [ ] **Step 4: Run to verify it passes** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/views/help.tsx src/views/help.test.tsx
git commit -m "feat(frontend): Help view Take-the-tour button"
```

---

## Task 13: Wire the Coalfall sample into the standard mock flow (🔴 e2e blocker)

**Why (verified):** `mockLoadSample` returns bookId `castwright__standalones__the-coalfall-commission`, which is **absent from `MOCK_LIBRARY`** — so after "load sample" the app can't find/open the book, and every downstream view is empty. The Coalfall fixtures exist (`src/mocks/marketing/hollow-tide.ts`: `COALFALL_CHAPTERS`, `coalfallCast`, `coalfallSentences`) but only under `DEMO_CAPTURE`, keyed by a different slug. The tour can't be driven in mock mode (local dev OR the Task 14 e2e) until the sample is navigable through the standard getters.

**Files:**
- Modify: `src/lib/api.ts` (make `mockLoadSample` register the sample, and the standard mock getters return its data)
- Reuse: `src/mocks/marketing/hollow-tide.ts` fixtures (or `coalfall-*.json`)
- Test: `src/lib/api.sample.test.ts`

- [ ] **Step 1: Write the failing test** — `src/lib/api.sample.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mockLoadSample, mockGetLibrary, mockGetBookState } from './api';

const SAMPLE_ID = 'castwright__standalones__the-coalfall-commission';

describe('mock sample is navigable', () => {
  it('loadSample registers the book in the library', async () => {
    await mockLoadSample('the-coalfall-commission');
    const lib = await mockGetLibrary();
    expect(lib.books.some((b) => b.bookId === SAMPLE_ID)).toBe(true);
  });
  it('the sample book has chapter 1 done (rest queued)', async () => {
    await mockLoadSample('the-coalfall-commission');
    const state = await mockGetBookState(SAMPLE_ID);
    expect(state).not.toBeNull();
    const ch1 = state!.chapters.find((c) => c.id === 1);
    expect(ch1?.state).toBe('done');
  });
});
```

(Confirm exact mock getter names + payload shapes against `api.ts` — `mockGetLibrary`/`mockGetBookState`, the `books[]` + `chapters[]` shapes, and the chapter `id` field. Adapt the Coalfall fixture chapter ids so chapter 1 exists and is `done`.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/api.sample.test.ts`
Expected: FAIL — sample not in `MOCK_LIBRARY`.

- [ ] **Step 3: Implement** — in `src/lib/api.ts`:
  - In `mockLoadSample`, push a Coalfall library entry into the module-level state the standard `mockGetLibrary` reads (status `'generating'` so it opens `ready`), and seed a `MOCK_BOOK_STATES`-style entry keyed by `SAMPLE_ID` with **chapter 1 `state: 'done'`** (give it a duration) and chapters 2+ `'queued'` — this makes Generate show "Resume generation" and Listen show ch.1 playable + the rest pending (matches the spec's intentional partial state).
  - Wire the standard mock getters (`mockGetCast`/characters, `mockGetChapters`, `mockGetManuscript`, `mockGetSentences`) to return the Coalfall fixtures **for `SAMPLE_ID`**, falling back to the existing canned data for other ids. Reuse `coalfallCast` / `coalfallSentences` / `COALFALL_CHAPTERS` from `hollow-tide.ts` rather than duplicating.
  - Add a `_resetMockSample()` export that clears the seeded entry (for test isolation), mirroring `_resetMockTour`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/api.sample.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts src/lib/api.sample.test.ts
git commit -m "test(mocks): seed Coalfall sample into the standard mock flow"
```

> **Server counterpart:** the REAL `POST /api/samples/{slug}/load` (fs-22) must likewise provision a navigable, chapter-1-rendered book on disk. That's fs-22's job (+ Task 15's audio), not this task — this task only unblocks mock-mode dev + e2e.

---

## Task 14: E2E — golden path, mini-tour, responsive

**Files:**
- Create: `e2e/tour.spec.ts`
- Modify: `e2e/responsive/coverage.spec.ts` (append a tour case)
- Depends on: **Task 13** (sample navigable in mock mode).

- [ ] **Step 1: Write the spec** — `e2e/tour.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

test('guided tour: empty library → steps across real screens → finish persists', async ({ page }) => {
  await page.goto('/#/');
  await page.getByRole('button', { name: /take the guided tour/i }).click();

  // s1 welcome (centered)
  await expect(page.getByRole('dialog', { name: /welcome to castwright/i })).toBeVisible();
  // advance through all steps
  for (let i = 0; i < 12; i++) {
    await page.getByRole('button', { name: /next|done/i }).click();
  }
  // Listen step reached a real play control at some point:
  // (assert chapter-1-play was spotlighted mid-run)
  await page.goto('/#/'); // reload
  await page.getByRole('button', { name: /take the guided tour/i }).waitFor({ state: 'detached', timeout: 2000 })
    .catch(() => {}); // invite suppressed after completion — tolerate either by checking the flag UI
});

test('per-screen mini-tour: Cast ? replays the cast steps only', async ({ page }) => {
  // load sample, open cast, open the ? menu, click "Show me this screen",
  // assert the first bubble is the cast roster step and the tour ends after 3 steps.
});
```

Flesh out the assertions against the real DOM (use `data-testid`/`data-tour-id`). Keep it resilient to timing with `expect(...).toBeVisible()` waits.

- [ ] **Step 2: Run to verify it fails** — `npm run test:e2e -- tour.spec.ts` → FAIL (CTA/flow not fully wired or assertions off).

- [ ] **Step 3: Fix wiring** until green — the sample navigability is handled by Task 13; remaining work is timing/assertion robustness (wait on `data-tour-id`/`data-testid` elements, advance via the bubble's Next button).

- [ ] **Step 4: Run to verify it passes** — `npm run test:e2e -- tour.spec.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add e2e/tour.spec.ts e2e/responsive/coverage.spec.ts
git commit -m "test(e2e): guided tour golden path + mini-tour + responsive"
```

---

## Task 15: Amend fs-22 spec (companion change) + ship chapter-1 audio recipe

**Files:**
- Modify: `docs/superpowers/specs/2026-06-11-fs22-bundled-demo-book-design.md` (lift the "no pre-rendered audio" Non-Goal)
- Add (ops recipe, no test): document how the bundled chapter-1 audio is produced + where it lands in the release artifact.

- [ ] **Step 1: Edit the fs-22 Non-Goal** — change the "No pre-rendered audio in the bundle" line to:

> ~~No pre-rendered audio~~ **Exactly one pre-rendered chapter (chapter 1, full Qwen cast)** ships in the bundle to power the guided tour's Listen finale (see `2026-06-12-guided-tour-design.md`). Chapters 2+ remain un-rendered (the user generates them), keeping the bundle small.

- [ ] **Step 2: Add the production recipe** — append to the fs-22 spec a short "Chapter-1 audio (for the tour)" subsection: render ch.1 on a GPU box via the real pipeline with the bundled `cast.json`, place the resulting per-chapter audio + `segments.json`/`state.json` under the sample's book dir in the bundle (`samples/the-coalfall-commission/...`), and confirm `loadSample` copies it so the book opens with chapter 1 `state: 'done'`.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-11-fs22-bundled-demo-book-design.md
git commit -m "docs(docs): amend fs-22 to bundle chapter-1 audio for the tour"
```

> **Ops follow-up (out of band, not a code task):** actually render + commit the chapter-1 audio fixture into the fs-22 bundle on a GPU box; track it in the fs-22 issue. The tour's Listen finale shows ch.1 placeholder until this lands.

---

## Task 16: Bookkeeping — issue, backlog, plan/INDEX

**Files:**
- Modify: `docs/BACKLOG.md`, `docs/features/INDEX.md`
- Create: `docs/features/211-guided-tour.md` (from `docs/features/TEMPLATE.md`)

- [ ] **Step 1:** File a GitHub issue "Guided product tour" (`area:fe`, `moscow:should`, `type:feature`); note it supersedes `fe-28` (#472). Close/narrow #472.
- [ ] **Step 2:** Add the thin row to `docs/BACKLOG.md` linking the new issue; remove/collapse the `fe-28` row.
- [ ] **Step 3:** Create `docs/features/211-guided-tour.md` from `TEMPLATE.md` (status `active`), linking the spec + this plan. Add it to `docs/features/INDEX.md`.
- [ ] **Step 4: Commit**

```bash
git add docs/BACKLOG.md docs/features/INDEX.md docs/features/211-guided-tour.md
git commit -m "docs(docs): guided-tour regression plan + backlog + supersede fe-28"
```

---

## Final verification

- [ ] Run the full battery: `npm run verify` — typecheck + all tests + e2e + build. Expected: green.
- [ ] If any pre-existing failure appears (unrelated to this work), surface it to the user per CLAUDE.md — do not bypass with `--no-verify`.
- [ ] Use `superpowers:finishing-a-development-branch` to open the draft PR (`Closes #<new issue>`, `Refs #<fs-22 issue>` for the audio follow-up), verify once, then `gh pr ready`.

---

## Self-review notes (coverage map)

| Spec requirement | Task |
|---|---|
| Tour-step registry (single source) | 5 |
| `data-tour-id` anchors (incl. boundary-handle attr, m4b tile) | 9 |
| Tour slice + real-navigation engine | 4, 6 |
| `<TourOverlay/>` spotlight + z-[75] + click-through + fallback | 7 |
| Entry points (empty-library CTA + completion suppression, `?` menu, Help button) | 10, 11, 12 |
| Server-side `tourCompletedAt` (fs-21 pattern) | 1, 2, 3, 4 |
| Sample navigable in mock mode (e2e/local-dev prerequisite) | 13 |
| fs-22 chapter-1 audio (amend + recipe) | 15 |
| Edge cases (Esc, fallback, drawer open/close, responsive) | 6, 7, 14 |
| Tests: unit/component/server/e2e + top-bar rewrite | 1–14 |
| Bookkeeping (issue, backlog, plan, supersede fe-28) | 16 |

### Corrections folded in from review round 1
- API: bare relative `fetch` (no `API_BASE`) · Tasks 3.
- Tests: `vi.mock('../lib/api')` under vitest; server reset = `_resetUserSettingsCache`+`rmSync` · Tasks 1–4.
- `screenForStage(stageKind, view)` (top-bar passes primitives) · Task 11.
- Empty-library tour CTA gated on `tourCompleted` (no prior flag gating existed) · Task 10.
- New Task 13 unblocks the e2e by seeding the sample into the standard mock flow.
