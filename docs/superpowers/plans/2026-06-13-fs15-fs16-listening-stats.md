# fs-15 + fs-16 — Continue Listening + Listening Stats — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a cross-book "Continue listening" rail (fs-15) and a `#/stats` listening-stats dashboard (fs-16), backed by a new server-side wall-clock play-time store that the web player and the Android companion both report to.

**Architecture:** A new per-book `listen-stats.json` holds absolute wall-clock seconds keyed per `(date, sessionId)`; the server **sums** sessions (never overwrites — `max()` upsert under a per-book mutex). Two aggregation endpoints feed the UI; date-relative figures (streak/last-7) are computed client-side against the viewer's local "today." The web mini-player runs a checkpoint accumulator; the companion is report-only.

**Tech Stack:** Server — Node 20 + Express + Vitest. Frontend — Vite + React 18 + TS + Redux Toolkit + Vitest/RTL + Playwright. Contract — `openapi.yaml` → `openapi-typescript`. Companion — Flutter/Dart + drift.

**Spec:** `docs/superpowers/specs/2026-06-13-fs15-fs16-listening-stats-design.md` (read it — all decisions D1–D14, S1–S7, P1–P5 live there).

**Branch:** `feat/listening-stats-fs15-fs16` (already cut).

## Brand consistency (REQUIRED for all UI — Waves E & F)

Both new surfaces are user-facing and MUST read as Castwright, not as a bolt-on. The Tufte rules and the brand are compatible — the single accent and quiet scaffolding are exactly Tufte's "use color to signal, not decorate."

- **Fonts:** the app's self-hosted families only — **Lora** (serif) for the display lede / headline figures, **General Sans** (sans) for labels, %s, and body. No new font, no system fallback as the primary.
- **Every colour comes from the brand palette — no exceptions.** The brand guide + colour palette (`brand/` guidelines, local-only; the palette is encoded as the CSS custom properties in `src/styles.css` / `tailwind.config.ts`) is the *sole* source for every fill in these surfaces: text, backgrounds, progress-bar tracks **and** fills, sparkbar bars, the accent, borders/hairlines. **No hex literals, no off-palette shades, no ad-hoc opacity tints that land outside the palette** (CLAUDE.md convention). The mockup's literal hexes (`#fbf3ec`, `#8a7f76`, `#c8336a`) were illustrative ONLY — bind the real tokens. If a shade you want isn't in the palette, do **not** invent one: use the nearest defined token, or stop and raise it — adding a colour is a brand decision, not an implementation choice.
- **Single accent = the brand accent token** (`--magenta` or the palette's designated accent — confirm the exact token in `styles.css`), used only on the focal/peak datum. Everything else is `--ink` / a defined muted token from the palette.
- **Reuse existing surfaces, don't reinvent:** card/radii/spacing from `src/components/primitives` and the existing library-chrome / listen-view styling; the rail's book cards should match the existing book-card treatment (cover, title), not a bespoke shape.
- **A11y + brand together (resolves PL6):** body text and the % labels use AA-compliant `--ink`-family tokens (≥ 4.5:1). The "quiet contrast" treatment is reserved for **non-text only** — progress-bar tracks, sparkline fills, hairline rules. Never ship muted-gray *text* that fails the axe gate.
- **Copy is on-brand voice** — warm, plain, second-person (matches the existing empty-states / listener copy). The lede reads like a sentence, not a metrics label.
- **References:** brand design spec `docs/superpowers/specs/2026-06-07-castwright-brand-design.md`; brand guide in `brand/` (local-only); palette tokens in `src/styles.css`.
- **Acceptance gate (E2 + F3):** before either is "done," (1) `grep` the new component files for hex/`rgb(`/`hsl(` literals — must be zero; every colour is a `var(--…)` / Tailwind token mapping to the palette; (2) visually verify against the real app via the `run-app` skill that the surface matches the brand (fonts, peach ground, magenta accent only on the focal datum).

---

## File structure

**Server (create):**
- `server/src/workspace/file-lock.ts` — generic per-key promise-chain mutex (`withKeyLock(key, fn)`), extracted idiom from `design-lock.ts`.
- `server/src/workspace/listen-stats.ts` — pure domain: types, `mergeStatsDays()` (`max()` upsert), `validateStatsBody()`, `sumAllSeconds()`, `byDayTotals()`.
- `server/src/workspace/chapter-durations.ts` — pure: `parseDurationToSec()`, `bookListenableSeconds()`, `secondsBeforeChapter()`, `finalListenableChapter()`.
- `server/src/workspace/listen-stats-aggregate.ts` — pure: `completionPct()`, `isFinished()`, `buildLibraryStats()`, `buildContinueListening()`.

**Server (modify):**
- `server/src/workspace/paths.ts` — add `listenStatsJsonPath(bookDir)`.
- `server/src/routes/book-state.ts` — add `PUT /:bookId/listen-stats`.
- `server/src/routes/library.ts` (or the existing library router) — add `GET /api/library/stats` + `GET /api/library/continue-listening`.

**Contract / client:**
- `openapi.yaml` — 3 new operations + schemas.
- `src/lib/api-types.ts` — regenerated.
- `src/lib/api.ts` — `getLibraryStats`, `getContinueListening`, `putListenStats` (real + mock).

**Frontend (create):**
- `src/lib/listen-stats-reporter.ts` — pure `StatsAccumulator` class.
- `src/lib/listen-stats-math.ts` — pure `currentStreak()`, `longestStreak()`, `last7Days()`.
- `src/store/continue-listening-slice.ts` — rail data slice.
- `src/components/library/continue-listening-rail.tsx` — presentational rail.
- `src/views/stats.tsx` — the `#/stats` Reading-column view.

**Frontend (modify):**
- `src/components/mini-player.tsx` — drive the accumulator.
- `src/lib/types.ts` — add `Stage` kind `stats`.
- `src/lib/router.ts` — `parseHash` + `stageToHash` for `#/stats`.
- `src/App.tsx` — render `<StatsView/>` for `stage.kind === 'stats'`.
- `src/views/book-library.tsx` — mount the rail.
- `src/components/library/library-grid.tsx` + `library-table.tsx` — delete-book confirm warning line.
- `src/test/a11y.test.tsx` — add `#/stats` to the core-views list.
- `e2e/responsive/coverage.spec.ts` — add a `#/stats` case.

**Companion (Android) — report-only:**
- `apps/android/lib/.../listen_stats_reporter.dart` + drift table + flush wiring (final wave; splittable into its own PR).

**Docs:**
- `docs/features/<next>-fs15-fs16-listening-stats.md` (regression plan) + `INDEX.md` + `docs/BACKLOG.md` rows.

---

## Wave A — Server: stats store + write path

### Task A1: Generic per-key mutex + stats file path

**Files:**
- Create: `server/src/workspace/file-lock.ts`
- Test: `server/src/workspace/file-lock.test.ts`
- Modify: `server/src/workspace/paths.ts` (add `listenStatsJsonPath`)

- [ ] **Step 1: Write the failing test**

```ts
// server/src/workspace/file-lock.test.ts
import { describe, it, expect } from 'vitest';
import { withKeyLock } from './file-lock.js';

describe('withKeyLock', () => {
  it('serializes critical sections sharing a key', async () => {
    const order: string[] = [];
    const slow = withKeyLock('book-1', async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 30));
      order.push('a-end');
    });
    const fast = withKeyLock('book-1', async () => {
      order.push('b-start');
      order.push('b-end');
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('runs different keys concurrently', async () => {
    const order: string[] = [];
    const a = withKeyLock('book-1', async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 30));
      order.push('a-end');
    });
    const b = withKeyLock('book-2', async () => {
      order.push('b-start');
      order.push('b-end');
    });
    await Promise.all([a, b]);
    expect(order[0]).toBe('a-start');
    expect(order.indexOf('b-end')).toBeLessThan(order.indexOf('a-end'));
  });

  it('releases the lock when fn throws', async () => {
    await expect(withKeyLock('k', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    const ran = await withKeyLock('k', async () => 'ok');
    expect(ran).toBe('ok');
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd server && npx vitest run src/workspace/file-lock.test.ts`
Expected: FAIL — `withKeyLock` not exported.

- [ ] **Step 3: Implement (idiom copied from `design-lock.ts`)**

```ts
// server/src/workspace/file-lock.ts
/* Generic per-key promise-chain mutex. Same idiom as tts/design-lock.ts's
   withDesignLock, but keyed on an arbitrary string so callers (e.g. the
   listen-stats read-modify-write) get isolation without coupling to the
   voice-design busy registry. */
const chains = new Map<string, Promise<unknown>>();

export async function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = chains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  chains.set(key, prior.then(() => gate, () => gate));
  await prior.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (chains.get(key) === gate) chains.delete(key);
  }
}
```

- [ ] **Step 4: Add the path helper**

In `server/src/workspace/paths.ts`, directly after `listenProgressJsonPath` (line ~159):

```ts
/** fs-16 — per-book listening-stats sibling to listen-progress.json. */
export function listenStatsJsonPath(bookDir: string): string {
  return join(audiobookDir(bookDir), 'listen-stats.json');
}
```

(Match the exact `join(...)` form used by `listenProgressJsonPath` in that file — copy its body and rename the filename.)

- [ ] **Step 5: Run tests, verify pass**

Run: `cd server && npx vitest run src/workspace/file-lock.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add server/src/workspace/file-lock.ts server/src/workspace/file-lock.test.ts server/src/workspace/paths.ts
git commit -m "feat(server): add per-key mutex + listen-stats path (fs-16)"
```

---

### Task A2: Stats domain — types, validation, merge (`max()` upsert), aggregation helpers

**Files:**
- Create: `server/src/workspace/listen-stats.ts`
- Test: `server/src/workspace/listen-stats.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/workspace/listen-stats.test.ts
import { describe, it, expect } from 'vitest';
import {
  validateStatsBody, mergeStatsDays, sumAllSeconds, byDayTotals,
  type ListenStatsFile,
} from './listen-stats.js';

const NOW = Date.parse('2026-06-13T12:00:00Z');

describe('validateStatsBody', () => {
  const ok = { sessionId: 's1', days: [{ date: '2026-06-13', seconds: 120 }] };
  it('accepts a well-formed body', () => {
    expect(validateStatsBody(ok, NOW)).toBeNull();
  });
  it('rejects missing/empty sessionId', () => {
    expect(validateStatsBody({ ...ok, sessionId: '' }, NOW)).toMatch(/sessionId/);
  });
  it('rejects > 366 days', () => {
    const days = Array.from({ length: 367 }, (_, i) => ({ date: '2026-01-01', seconds: 1 }));
    expect(validateStatsBody({ sessionId: 's', days }, NOW)).toMatch(/366/);
  });
  it('rejects a non-ISO date', () => {
    expect(validateStatsBody({ sessionId: 's', days: [{ date: '13-06-2026', seconds: 1 }] }, NOW)).toMatch(/date/);
  });
  it('rejects a far-future date', () => {
    expect(validateStatsBody({ sessionId: 's', days: [{ date: '2099-01-01', seconds: 1 }] }, NOW)).toMatch(/future/);
  });
  it('rejects an absurd-past date (before 2020)', () => {
    expect(validateStatsBody({ sessionId: 's', days: [{ date: '1999-01-01', seconds: 1 }] }, NOW)).toMatch(/past/);
  });
  it('rejects seconds out of [0, 86400]', () => {
    expect(validateStatsBody({ sessionId: 's', days: [{ date: '2026-06-13', seconds: -1 }] }, NOW)).toMatch(/seconds/);
    expect(validateStatsBody({ sessionId: 's', days: [{ date: '2026-06-13', seconds: 90000 }] }, NOW)).toMatch(/seconds/);
  });
});

describe('mergeStatsDays', () => {
  const base: ListenStatsFile = {
    schema: 1,
    perDay: [{ date: '2026-06-13', sessions: [{ sessionId: 's1', seconds: 100 }] }],
  };
  it('adds a new session slot for the same day', () => {
    const out = mergeStatsDays(base, 's2', [{ date: '2026-06-13', seconds: 50 }]);
    const day = out.perDay.find((d) => d.date === '2026-06-13')!;
    expect(day.sessions).toHaveLength(2);
    expect(day.sessions.find((s) => s.sessionId === 's2')!.seconds).toBe(50);
  });
  it('upserts an existing slot with max() (never lowers)', () => {
    const grown = mergeStatsDays(base, 's1', [{ date: '2026-06-13', seconds: 250 }]);
    expect(grown.perDay[0].sessions[0].seconds).toBe(250);
    const stale = mergeStatsDays(grown, 's1', [{ date: '2026-06-13', seconds: 90 }]);
    expect(stale.perDay[0].sessions[0].seconds).toBe(250); // stale retry ignored
  });
  it('creates a new day entry', () => {
    const out = mergeStatsDays(base, 's1', [{ date: '2026-06-14', seconds: 10 }]);
    expect(out.perDay.map((d) => d.date).sort()).toEqual(['2026-06-13', '2026-06-14']);
  });
});

describe('sumAllSeconds / byDayTotals', () => {
  const file: ListenStatsFile = {
    schema: 1,
    perDay: [
      { date: '2026-06-12', sessions: [{ sessionId: 'a', seconds: 100 }, { sessionId: 'b', seconds: 40 }] },
      { date: '2026-06-13', sessions: [{ sessionId: 'a', seconds: 200 }] },
    ],
  };
  it('sums every session across every day', () => {
    expect(sumAllSeconds([file])).toBe(340);
  });
  it('produces per-date totals merged across files', () => {
    const totals = byDayTotals([file, file]); // same file twice → doubled
    expect(totals['2026-06-12']).toBe(280);
    expect(totals['2026-06-13']).toBe(400);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd server && npx vitest run src/workspace/listen-stats.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// server/src/workspace/listen-stats.ts
/* fs-16 — per-book listening-stats domain. Pure (no IO). The on-disk file
   stores ABSOLUTE wall-clock seconds keyed per (date, sessionId); the server
   SUMS sessions per day. Upserts take max() so an out-of-order/stale retry
   can't lower a higher stored absolute (a session's per-(book,date) total is
   monotonic). See the design spec, decisions D2/D3/S2. */

export interface StatsSessionSlot { sessionId: string; seconds: number; }
export interface StatsDay { date: string; sessions: StatsSessionSlot[]; }
export interface ListenStatsFile { schema: 1; perDay: StatsDay[]; }

export interface StatsDayInput { date: string; seconds: number; }
export interface StatsPutBody { sessionId: string; days: StatsDayInput[]; }

const MAX_DAYS_PER_PUT = 366;
const MAX_SECONDS_PER_DAY = 86400;
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const PAST_FLOOR_MS = Date.parse('2020-01-01T00:00:00Z');
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function emptyStatsFile(): ListenStatsFile {
  return { schema: 1, perDay: [] };
}

/** Returns null when valid, else a short reason for a 400. */
export function validateStatsBody(raw: unknown, now: number): string | null {
  if (!raw || typeof raw !== 'object') return 'body must be an object';
  const b = raw as Partial<StatsPutBody>;
  if (typeof b.sessionId !== 'string' || b.sessionId.length === 0) return 'sessionId must be a non-empty string';
  if (!Array.isArray(b.days)) return 'days must be an array';
  if (b.days.length > MAX_DAYS_PER_PUT) return `days must have at most ${MAX_DAYS_PER_PUT} entries`;
  for (const d of b.days) {
    if (!d || typeof d !== 'object') return 'each day must be an object';
    const day = d as Partial<StatsDayInput>;
    if (typeof day.date !== 'string' || !ISO_DATE.test(day.date) || Number.isNaN(Date.parse(day.date))) {
      return 'day.date must be an ISO YYYY-MM-DD string';
    }
    const t = Date.parse(day.date);
    if (t > now + FUTURE_SKEW_MS) return 'day.date is too far in the future';
    if (t < PAST_FLOOR_MS) return 'day.date is too far in the past';
    if (typeof day.seconds !== 'number' || !Number.isFinite(day.seconds) || day.seconds < 0 || day.seconds > MAX_SECONDS_PER_DAY) {
      return `day.seconds must be a finite number in [0, ${MAX_SECONDS_PER_DAY}]`;
    }
  }
  return null;
}

/** Pure merge: upsert each (date, sessionId) slot to max(existing, incoming).
    Returns a NEW file object (does not mutate input). */
export function mergeStatsDays(
  file: ListenStatsFile,
  sessionId: string,
  days: StatsDayInput[],
): ListenStatsFile {
  const byDate = new Map<string, StatsSessionSlot[]>();
  for (const d of file.perDay) byDate.set(d.date, d.sessions.map((s) => ({ ...s })));
  for (const { date, seconds } of days) {
    const slots = byDate.get(date) ?? [];
    const existing = slots.find((s) => s.sessionId === sessionId);
    if (existing) existing.seconds = Math.max(existing.seconds, seconds);
    else slots.push({ sessionId, seconds });
    byDate.set(date, slots);
  }
  return {
    schema: 1,
    perDay: [...byDate.entries()]
      .map(([date, sessions]) => ({ date, sessions }))
      .sort((a, b) => (a.date < b.date ? -1 : 1)),
  };
}

export function sumAllSeconds(files: ListenStatsFile[]): number {
  let total = 0;
  for (const f of files) for (const d of f.perDay) for (const s of d.sessions) total += s.seconds;
  return total;
}

/** date → summed seconds across every session in every supplied file. */
export function byDayTotals(files: ListenStatsFile[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of files) for (const d of f.perDay) {
    const daySum = d.sessions.reduce((n, s) => n + s.seconds, 0);
    out[d.date] = (out[d.date] ?? 0) + daySum;
  }
  return out;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cd server && npx vitest run src/workspace/listen-stats.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/workspace/listen-stats.ts server/src/workspace/listen-stats.test.ts
git commit -m "feat(server): listen-stats domain (validate, max-upsert merge, sums) (fs-16)"
```

---

### Task A3: `PUT /api/books/:bookId/listen-stats` route

**Files:**
- Modify: `server/src/routes/book-state.ts` (add the route near the listen-progress routes, ~line 1409)
- Test: `server/src/routes/book-state.test.ts` (append a describe block)

- [ ] **Step 1: Write the failing test** (append to `book-state.test.ts`; reuse the file's existing test-app + temp-workspace helpers — copy the setup pattern already used by the listen-progress tests in that file)

```ts
describe('PUT /:bookId/listen-stats', () => {
  it('writes a session slot and is idempotent + monotonic', async () => {
    const { app, bookId } = await makeBookFixture(); // existing helper pattern in this file
    let res = await request(app).put(`/api/books/${bookId}/listen-stats`)
      .send({ sessionId: 's1', days: [{ date: '2026-06-13', seconds: 120 }] });
    expect(res.status).toBe(200);
    // stale retry doesn't lower it
    res = await request(app).put(`/api/books/${bookId}/listen-stats`)
      .send({ sessionId: 's1', days: [{ date: '2026-06-13', seconds: 30 }] });
    expect(res.status).toBe(200);
    expect(res.body.perDay[0].sessions[0].seconds).toBe(120);
  });
  it('sums distinct sessions', async () => {
    const { app, bookId } = await makeBookFixture();
    await request(app).put(`/api/books/${bookId}/listen-stats`).send({ sessionId: 'a', days: [{ date: '2026-06-13', seconds: 100 }] });
    const res = await request(app).put(`/api/books/${bookId}/listen-stats`).send({ sessionId: 'b', days: [{ date: '2026-06-13', seconds: 50 }] });
    expect(res.body.perDay[0].sessions).toHaveLength(2);
  });
  it('400s on a bad body', async () => {
    const { app, bookId } = await makeBookFixture();
    const res = await request(app).put(`/api/books/${bookId}/listen-stats`).send({ sessionId: '', days: [] });
    expect(res.status).toBe(400);
  });
  it('404s on an unknown book', async () => {
    const { app } = await makeBookFixture();
    const res = await request(app).put(`/api/books/nope/listen-stats`).send({ sessionId: 's', days: [] });
    expect(res.status).toBe(404);
  });
});
```

> **PL3 — there is NO `makeBookFixture` helper.** `book-state.test.ts` sets fixtures up **inline** (verified): in `beforeAll`, `workspaceRoot = await mkdtemp(join(tmpdir(), 'audiobook-…-'))` → `process.env.WORKSPACE_DIR = workspaceRoot` → **deferred** `const [{ bookStateRouter }, { makeBookId }] = await Promise.all([import('./book-state.js'), import('../workspace/paths.js')])` (deferred so `paths.ts` reads the env) → `bookId = makeBookId(AUTHOR, SERIES, TITLE)` → `mkdirSync(join(bookDir,'.audiobook'),{recursive:true})` + `writeFileSync` a minimal `state.json` → mount `app = express().use(express.json()).use('/api/books', bookStateRouter)`. Treat `makeBookFixture()` in the snippets above as shorthand for "do that inline setup and expose `app` + `bookId`." Copy the exact preamble from the top of `book-state.test.ts`.

- [ ] **Step 2: Run, verify fail**

Run: `cd server && npx vitest run src/routes/book-state.test.ts -t "listen-stats"`
Expected: FAIL — 404 (route absent).

- [ ] **Step 3: Implement the route**

Add imports at the top of `book-state.ts`:
```ts
import { listenStatsJsonPath } from '../workspace/paths.js';
import { withKeyLock } from '../workspace/file-lock.js';
import {
  validateStatsBody, mergeStatsDays, emptyStatsFile, type ListenStatsFile, type StatsPutBody,
} from '../workspace/listen-stats.js';
```

Add the route alongside the listen-progress routes:
```ts
/* fs-16 — PUT per-book listening stats. Body { sessionId, days:[{date,seconds}] }.
   Read-modify-write under a per-book key lock; slots upsert via max(). */
bookStateRouter.put('/:bookId/listen-stats', async (req: Request, res: Response) => {
  try {
    const located = await findBookByBookId(req.params.bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });
    const reason = validateStatsBody(req.body, Date.now());
    if (reason) return res.status(400).json({ error: reason });
    const { sessionId, days } = req.body as StatsPutBody;
    const path = listenStatsJsonPath(located.bookDir);
    const written = await withKeyLock(`listen-stats:${located.bookDir}`, async () => {
      const current = (await readJson<ListenStatsFile>(path)) ?? emptyStatsFile();
      const next = mergeStatsDays(current, sessionId, days);
      await writeJsonAtomic(path, next);
      return next;
    });
    res.json(written);
  } catch (e) {
    console.error('[book-state] PUT listen-stats failed', e);
    res.status(500).json({ error: (e as Error).message || 'Failed to write listen-stats.' });
  }
});
```

- [ ] **Step 4: Run, verify pass**

Run: `cd server && npx vitest run src/routes/book-state.test.ts -t "listen-stats"`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/book-state.ts server/src/routes/book-state.test.ts
git commit -m "feat(server): PUT /books/:id/listen-stats write endpoint (fs-16)"
```

---

## Wave B — Server: aggregation

### Task B1: Chapter-duration helpers

**Files:**
- Create: `server/src/workspace/chapter-durations.ts`
- Test: `server/src/workspace/chapter-durations.test.ts`

A "chapter" here is the persisted `state.json` shape subset: `{ id, duration?, excluded?, held? }`. `duration` is a formatted string (`"12:34"` or `"1:02:03"`) absent on unrendered chapters.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/workspace/chapter-durations.test.ts
import { describe, it, expect } from 'vitest';
import {
  parseDurationToSec, bookListenableSeconds, secondsBeforeChapter, finalListenableChapter,
} from './chapter-durations.js';

const chapters = [
  { id: 1, duration: '10:00' },
  { id: 2, duration: '5:00' },
  { id: 3, duration: '20:00' },
  { id: 4, duration: '1:00', excluded: true }, // not listenable
];

describe('parseDurationToSec', () => {
  it('parses mm:ss and h:mm:ss', () => {
    expect(parseDurationToSec('12:34')).toBe(754);
    expect(parseDurationToSec('1:02:03')).toBe(3723);
  });
  it('returns 0 for missing/garbage', () => {
    expect(parseDurationToSec(undefined)).toBe(0);
    expect(parseDurationToSec('--')).toBe(0);
  });
});

describe('bookListenableSeconds', () => {
  it('sums durations of non-excluded, non-held, audio-bearing chapters', () => {
    expect(bookListenableSeconds(chapters)).toBe((10 + 5 + 20) * 60);
  });
});

describe('secondsBeforeChapter', () => {
  it('sums listenable durations before the resume chapter id', () => {
    expect(secondsBeforeChapter(chapters, 3)).toBe((10 + 5) * 60);
    expect(secondsBeforeChapter(chapters, 1)).toBe(0);
  });
});

describe('finalListenableChapter', () => {
  it('returns the last non-excluded/held chapter with audio', () => {
    expect(finalListenableChapter(chapters)?.id).toBe(3); // chapter 4 excluded
  });
  it('returns null when none are listenable', () => {
    expect(finalListenableChapter([{ id: 1 }])).toBeNull(); // no duration → no audio
  });
});
```

- [ ] **Step 2: Run, verify fail.** `cd server && npx vitest run src/workspace/chapter-durations.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
// server/src/workspace/chapter-durations.ts
/* fs-16 — pure helpers for completion math. A chapter is "listenable" when it
   is not excluded, not held, and has a duration string (i.e. has rendered
   audio). Unrendered chapters contribute nothing — see spec S1 / mid-gen caveat. */
export interface DurChapter { id: number; duration?: string; excluded?: boolean; held?: boolean; }

export function parseDurationToSec(d: string | undefined): number {
  if (!d) return 0;
  const parts = d.split(':').map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function isListenable(c: DurChapter): boolean {
  return !c.excluded && !c.held && !!c.duration && parseDurationToSec(c.duration) > 0;
}

export function bookListenableSeconds(chapters: DurChapter[]): number {
  return chapters.filter(isListenable).reduce((n, c) => n + parseDurationToSec(c.duration), 0);
}

export function secondsBeforeChapter(chapters: DurChapter[], resumeChapterId: number): number {
  let total = 0;
  for (const c of chapters) {
    if (c.id === resumeChapterId) break;
    if (isListenable(c)) total += parseDurationToSec(c.duration);
  }
  return total;
}

export function finalListenableChapter(chapters: DurChapter[]): DurChapter | null {
  for (let i = chapters.length - 1; i >= 0; i--) if (isListenable(chapters[i])) return chapters[i];
  return null;
}
```

- [ ] **Step 4: Run, verify pass.** PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/workspace/chapter-durations.ts server/src/workspace/chapter-durations.test.ts
git commit -m "feat(server): chapter-duration helpers for completion math (fs-16)"
```

---

### Task B2: Completion %, finished predicate, and library-stats/continue-listening builders

**Files:**
- Create: `server/src/workspace/listen-stats-aggregate.ts`
- Test: `server/src/workspace/listen-stats-aggregate.test.ts`

Define the per-book input the route layer will assemble (so these stay pure):

```ts
export interface BookStatsInput {
  bookId: string;
  title: string;
  series: string | null;
  isStandalone: boolean;
  chapters: DurChapter[];
  resume: { chapterId: number; currentSec: number; updatedAt: string } | null;
  statsFile: ListenStatsFile | null;
}
```

- [ ] **Step 1: Write the failing test**

```ts
// server/src/workspace/listen-stats-aggregate.test.ts
import { describe, it, expect } from 'vitest';
import { completionPct, isFinished, buildLibraryStats, buildContinueListening } from './listen-stats-aggregate.js';

const ch = [{ id: 1, duration: '10:00' }, { id: 2, duration: '10:00' }];

describe('completionPct', () => {
  it('is consumed / total listenable', () => {
    expect(completionPct(ch, { chapterId: 2, currentSec: 300, updatedAt: 'x' })).toBeCloseTo((600 + 300) / 1200);
  });
  it('guards divide-by-zero', () => {
    expect(completionPct([{ id: 1 }], { chapterId: 1, currentSec: 0, updatedAt: 'x' })).toBe(0);
  });
});

describe('isFinished', () => {
  it('true when in the final listenable chapter near its end', () => {
    expect(isFinished(ch, { chapterId: 2, currentSec: 600, updatedAt: 'x' })).toBe(true);   // at end
    expect(isFinished(ch, { chapterId: 2, currentSec: 595, updatedAt: 'x' })).toBe(true);   // within 30s
  });
  it('false mid-final-chapter and false when not in final chapter', () => {
    expect(isFinished(ch, { chapterId: 2, currentSec: 120, updatedAt: 'x' })).toBe(false);
    expect(isFinished(ch, { chapterId: 1, currentSec: 600, updatedAt: 'x' })).toBe(false);
  });
});

describe('buildLibraryStats', () => {
  it('aggregates totals, finished count, per-series, and byDay; empty = zeros not NaN', () => {
    const out = buildLibraryStats([]);
    expect(out).toEqual({ totalListenedSec: 0, booksFinished: 0, perBook: [], perSeries: [], byDay: [] });
  });
});

describe('buildContinueListening', () => {
  it('excludes finished + <=5s, sorts by updatedAt desc', () => {
    const books = [
      { bookId: 'a', title: 'A', series: null, isStandalone: true, chapters: ch,
        resume: { chapterId: 1, currentSec: 120, updatedAt: '2026-06-10T00:00:00Z' }, statsFile: null },
      { bookId: 'b', title: 'B', series: null, isStandalone: true, chapters: ch,
        resume: { chapterId: 1, currentSec: 300, updatedAt: '2026-06-13T00:00:00Z' }, statsFile: null },
      { bookId: 'c', title: 'C', series: null, isStandalone: true, chapters: ch,
        resume: { chapterId: 2, currentSec: 600, updatedAt: '2026-06-12T00:00:00Z' }, statsFile: null }, // finished
      { bookId: 'd', title: 'D', series: null, isStandalone: true, chapters: ch,
        resume: { chapterId: 1, currentSec: 3, updatedAt: '2026-06-13T00:00:00Z' }, statsFile: null }, // <5s
    ];
    const out = buildContinueListening(books);
    expect(out.map((x) => x.bookId)).toEqual(['b', 'a']); // c finished, d below floor; b newer than a
  });
});
```

- [ ] **Step 2: Run, verify fail.** FAIL.

- [ ] **Step 3: Implement**

```ts
// server/src/workspace/listen-stats-aggregate.ts
import {
  bookListenableSeconds, secondsBeforeChapter, finalListenableChapter, parseDurationToSec,
  type DurChapter,
} from './chapter-durations.js';
import { sumAllSeconds, byDayTotals, type ListenStatsFile } from './listen-stats.js';

const NOISE_FLOOR_SEC = 5;
const FINISH_TAIL_SEC = 30;
const FINISH_TAIL_FRAC = 0.02;

export interface ResumeInput { chapterId: number; currentSec: number; updatedAt: string; }
export interface BookStatsInput {
  bookId: string; title: string; series: string | null; isStandalone: boolean;
  chapters: DurChapter[]; resume: ResumeInput | null; statsFile: ListenStatsFile | null;
}

export function completionPct(chapters: DurChapter[], resume: ResumeInput | null): number {
  if (!resume) return 0;
  const total = bookListenableSeconds(chapters);
  if (total <= 0) return 0;
  const consumed = secondsBeforeChapter(chapters, resume.chapterId) + Math.max(0, resume.currentSec);
  return Math.min(1, consumed / total);
}

export function isFinished(chapters: DurChapter[], resume: ResumeInput | null): boolean {
  if (!resume) return false;
  const final = finalListenableChapter(chapters);
  if (!final || final.id !== resume.chapterId) return false;
  const finalSec = parseDurationToSec(final.duration);
  if (finalSec <= 0) return false;
  const tail = Math.max(FINISH_TAIL_SEC, finalSec * FINISH_TAIL_FRAC);
  return resume.currentSec >= finalSec - tail;
}

export interface LibraryStats {
  totalListenedSec: number;
  booksFinished: number;
  perBook: { bookId: string; title: string; completionPct: number; finished: boolean }[];
  perSeries: { series: string; finishedCount: number; importedCount: number }[];
  byDay: { date: string; seconds: number }[];
}

export function buildLibraryStats(books: BookStatsInput[]): LibraryStats {
  const files = books.map((b) => b.statsFile).filter((f): f is ListenStatsFile => !!f);
  const perBook = books.map((b) => ({
    bookId: b.bookId, title: b.title,
    completionPct: completionPct(b.chapters, b.resume),
    finished: isFinished(b.chapters, b.resume),
  })).sort((a, b) => b.completionPct - a.completionPct);

  const seriesMap = new Map<string, { finishedCount: number; importedCount: number }>();
  for (const b of books) {
    if (b.isStandalone || !b.series) continue;
    const e = seriesMap.get(b.series) ?? { finishedCount: 0, importedCount: 0 };
    e.importedCount += 1;
    if (isFinished(b.chapters, b.resume)) e.finishedCount += 1;
    seriesMap.set(b.series, e);
  }

  const totals = byDayTotals(files);
  return {
    totalListenedSec: sumAllSeconds(files),
    booksFinished: perBook.filter((p) => p.finished).length,
    perBook,
    perSeries: [...seriesMap.entries()].map(([series, v]) => ({ series, ...v })),
    byDay: Object.entries(totals).map(([date, seconds]) => ({ date, seconds }))
      .sort((a, b) => (a.date < b.date ? -1 : 1)),
  };
}

export interface ContinueItem {
  bookId: string; title: string; chapterId: number; currentSec: number;
  remainingSec: number; completionPct: number; updatedAt: string;
}

export function buildContinueListening(books: BookStatsInput[]): ContinueItem[] {
  return books
    .filter((b) => b.resume && b.resume.currentSec > NOISE_FLOOR_SEC && !isFinished(b.chapters, b.resume))
    .map((b) => {
      const total = bookListenableSeconds(b.chapters);
      const consumed = secondsBeforeChapter(b.chapters, b.resume!.chapterId) + b.resume!.currentSec;
      return {
        bookId: b.bookId, title: b.title,
        chapterId: b.resume!.chapterId, currentSec: b.resume!.currentSec,
        remainingSec: Math.max(0, total - consumed),
        completionPct: completionPct(b.chapters, b.resume),
        updatedAt: b.resume!.updatedAt,
      };
    })
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}
```

- [ ] **Step 4: Run, verify pass.** PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/workspace/listen-stats-aggregate.ts server/src/workspace/listen-stats-aggregate.test.ts
git commit -m "feat(server): completion/finished + library-stats aggregation (fs-16/fs-15)"
```

---

### Task B3: `GET /api/library/stats` + `GET /api/library/continue-listening` routes

**Files:**
- Modify: the existing library router (find it: `grep -rn "api/library" server/src/index.ts server/src/routes` — likely `server/src/routes/library*.ts`). If there is no general library router, add these two GETs to `book-state.ts` under a `/library` sub-path mounted in `index.ts`.
- Test: a new `server/src/routes/library-stats.test.ts`

**The route layer's only job:** enumerate books, read each book's `state.json` (chapters + series meta), `listen-progress.json` (resume), and `listen-stats.json`, assemble `BookStatsInput[]`, and call the pure builders. Reuse the existing workspace book-enumeration helper (the same one `getLibrary` / the sync-manifest uses — find it with `grep -rn "scanBook\|listBooks\|enumerate" server/src/workspace`).

- [ ] **Step 1: Write the failing integration test.** `makeWorkspaceWithBooks` is shorthand — copy the **inline** multi-book temp-workspace setup from `server/src/routes/library-sync-manifest.test.ts` (mkdtemp → `WORKSPACE_DIR` → deferred import of the library router → write each book's `state.json`/`listen-progress.json`), mount the router, and assert the GET shapes. **PL7:** this builds several temp books — if it proves timeout-prone under the default parallel fork pool, route it to `server/vitest.config.slow.ts` (the documented escape hatch, same as the real-`pdf-parse` test) and add it to the `test:server-slow` glob.

```ts
// server/src/routes/library-stats.test.ts (skeleton — fill fixtures from sync-manifest.test.ts)
import { describe, it, expect } from 'vitest';
// ... import the test-app + multi-book workspace fixture used by library-sync-manifest.test.ts

describe('GET /api/library/stats', () => {
  it('returns totals + perBook + byDay (zeros on a fresh workspace)', async () => {
    const { app } = await makeWorkspaceWithBooks([{ title: 'A' }]);
    const res = await request(app).get('/api/library/stats');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ totalListenedSec: 0, booksFinished: 0 });
    expect(Array.isArray(res.body.byDay)).toBe(true);
  });
});

describe('GET /api/library/continue-listening', () => {
  it('returns in-progress books sorted by updatedAt desc', async () => {
    const { app, bookId } = await makeWorkspaceWithBooks([{ title: 'A', rendered: true }]);
    await request(app).put(`/api/books/${bookId}/listen-progress`).send({ chapterId: 1, currentSec: 120 });
    const res = await request(app).get('/api/library/continue-listening');
    expect(res.status).toBe(200);
    expect(res.body.find((x: any) => x.bookId === bookId)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run, verify fail.** FAIL (routes absent).

- [ ] **Step 3: Implement the two routes** (assemble inputs, call builders):

```ts
// in the library router
import { readJson } from '../workspace/state-io.js';
import { listenProgressJsonPath, listenStatsJsonPath } from '../workspace/paths.js';
import { collectBooks } from '../workspace/scan.js';
import { buildLibraryStats, buildContinueListening, type BookStatsInput } from '../workspace/listen-stats-aggregate.js';

async function assembleBookInputs(): Promise<BookStatsInput[]> {
  // PL8 — reuse collectBooks() (server/src/workspace/scan.js), the SAME enumerator
  // the sync-manifest router uses. It returns [{ bookDir, state }] — state already
  // carries bookId/title/series/isStandalone/chapters, so no extra state.json read.
  const books = await collectBooks();
  return Promise.all(books.map(async ({ bookDir, state }) => {
    const bookId = state.bookId;
    const resume = await readJson<any>(listenProgressJsonPath(bookDir));
    const statsFile = await readJson<any>(listenStatsJsonPath(bookDir));
    const chapters = (state?.chapters ?? []).map((c: any) =>
      ({ id: c.id, uuid: c.uuid, duration: c.duration, excluded: c.excluded, held: c.held }));
    // PL1 — resolve the resume bookmark's chapterUuid → the chapter's CURRENT id
    // (mirror GET /listen-progress, book-state.ts:1295-1301). A restructure shifts
    // positional ids, so the raw stored chapterId can point at the wrong chapter.
    let resumeChapterId = resume?.chapterId;
    if (resume?.chapterUuid) {
      const match = chapters.find((c: any) => c.uuid === resume.chapterUuid);
      if (match) resumeChapterId = match.id;
    }
    return {
      bookId,
      title: state?.title ?? bookId,
      series: state?.series ?? null,
      isStandalone: state?.isStandalone ?? !state?.series,
      chapters: chapters.map(({ id, duration, excluded, held }: any) => ({ id, duration, excluded, held })),
      resume: resume ? { chapterId: resumeChapterId, currentSec: resume.currentSec, updatedAt: resume.updatedAt } : null,
      statsFile: statsFile ?? null,
    };
  }));
}

libraryRouter.get('/stats', async (_req, res) => {
  try { res.json(buildLibraryStats(await assembleBookInputs())); }
  catch (e) { console.error('[library] GET stats failed', e); res.status(500).json({ error: (e as Error).message }); }
});

libraryRouter.get('/continue-listening', async (_req, res) => {
  try { res.json(buildContinueListening(await assembleBookInputs())); }
  catch (e) { console.error('[library] GET continue-listening failed', e); res.status(500).json({ error: (e as Error).message }); }
});
```

> Resolved names (verified): add both GETs to `server/src/routes/library.ts` (already mounted at `/api/library` in `index.ts:204`); enumerate with `collectBooks()` from `../workspace/scan.js` (returns `{ bookDir, state }`); `state` carries `bookId`/`title`/`series`/`isStandalone`/`chapters`. Do not invent new enumeration logic.

- [ ] **Step 4: Run, verify pass.** PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/library-stats.test.ts server/src/routes/<library-router>.ts
git commit -m "feat(server): GET /library/stats + /library/continue-listening (fs-15/fs-16)"
```

---

## Wave C — Contract + client API

### Task C1: openapi.yaml + regenerate types

**Files:** Modify `openapi.yaml`; regenerate `src/lib/api-types.ts`.

- [ ] **Step 1:** Add schemas `ListenStatsPutBody` (`{ sessionId: string; days: [{ date: string(format date); seconds: number }] }`), `ListenStatsFile`, `LibraryStats`, `ContinueListeningItem`, and the three operations (`PUT /books/{bookId}/listen-stats`, `GET /library/stats`, `GET /library/continue-listening`) under the existing paths, matching the style of the existing `listen-progress` operation already in the file (find it: `grep -n "listen-progress" openapi.yaml`).
- [ ] **Step 2:** Run `npm run openapi:types`. Expected: `src/lib/api-types.ts` regenerates with the new types, no diff errors.
- [ ] **Step 3:** Run `npm run typecheck`. Expected: PASS.
- [ ] **Step 4: Commit**

```bash
git add openapi.yaml src/lib/api-types.ts
git commit -m "feat(openapi): listen-stats + library stats/continue endpoints (fs-15/fs-16)"
```

---

### Task C2: `api.ts` real + mock clients

**Files:** Modify `src/lib/api.ts`; Test: `src/lib/api.test.ts` (or co-located — match the file's existing test location).

- [ ] **Step 1: Write the failing test** (mock-path behaviour + e2e seed seam, mirroring `mockGetListenProgress`'s `__SEED_LISTEN_PROGRESS__`)

```ts
import { describe, it, expect } from 'vitest';
import { mockPutListenStats, mockGetLibraryStats, mockGetContinueListening } from './api';

describe('mock listen-stats client', () => {
  it('putListenStats merges and getLibraryStats reflects it', async () => {
    await mockPutListenStats('book-1', { sessionId: 's1', days: [{ date: '2026-06-13', seconds: 120 }] });
    const stats = await mockGetLibraryStats();
    expect(stats.totalListenedSec).toBeGreaterThanOrEqual(120);
  });
  it('getContinueListening reads a seeded bookmark', async () => {
    (globalThis as any).__SEED_CONTINUE__ = [{ bookId: 'b', title: 'B', chapterId: 1, currentSec: 90, remainingSec: 600, completionPct: 0.1, updatedAt: '2026-06-13T00:00:00Z' }];
    const out = await mockGetContinueListening();
    expect(out[0].bookId).toBe('b');
  });
});
```

- [ ] **Step 2: Run, verify fail.** FAIL.

- [ ] **Step 3: Implement** the real fns (mirror `realPutListenProgress`/`realGetListenProgress` exactly — `fetch`, `res.ok` guard, `res.json()`) and mock fns (in-memory `Map` like `MOCK_LISTEN_PROGRESS`, plus the `__SEED_CONTINUE__` / `__SEED_LIBRARY_STATS__` seam), then register all three in BOTH the `real = {…}` and `mock = {…}` objects (lines ~6122 and ~6399):

```ts
// types
export interface ListenStatsPutBody { sessionId: string; days: { date: string; seconds: number }[]; }
// real
async function realPutListenStats(bookId: string, body: ListenStatsPutBody) {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/listen-stats`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`listen-stats PUT failed (${res.status})`);
  return res.json();
}
async function realGetLibraryStats() {
  const res = await fetch('/api/library/stats');
  if (!res.ok) throw new Error(`library stats GET failed (${res.status})`);
  return res.json();
}
async function realGetContinueListening() {
  const res = await fetch('/api/library/continue-listening');
  if (!res.ok) throw new Error(`continue-listening GET failed (${res.status})`);
  return res.json();
}
```

Mock implementations keep a module-level `Map<bookId, ListenStatsFile>` and apply a max-merge so the mock behaves like the server. **PL5 — do NOT import `mergeStatsDays` from `server/src/…`**: the frontend build can't reach server modules (separate tsconfig/package). Duplicate the trivial max-upsert inline in the mock (it's ~8 lines). `mockGetLibraryStats`/`mockGetContinueListening` read the map + canned books + the seed seams (`__SEED_LIBRARY_STATS__` / `__SEED_CONTINUE__`).

- [ ] **Step 4: Run, verify pass.** PASS. Then `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts src/lib/api.test.ts
git commit -m "feat(frontend): api.ts listen-stats + library stats/continue clients (real+mock)"
```

---

## Wave D — Web reporting (mini-player accumulator)

### Task D1: Pure `StatsAccumulator`

**Files:** Create `src/lib/listen-stats-reporter.ts`; Test `src/lib/listen-stats-reporter.test.ts`.

The accumulator tracks wall-clock seconds per `(bookId, localDate)` for one session, fed by an injectable clock. It is **rate-independent** (no playbackRate), **seek-safe** (it never reads `currentTime`), and **book-switch aware**.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/listen-stats-reporter.test.ts
import { describe, it, expect } from 'vitest';
import { StatsAccumulator } from './listen-stats-reporter';

const day = (iso: string) => new Date(iso).getTime();

describe('StatsAccumulator', () => {
  it('accrues wall-clock while playing, ignores paused time', () => {
    let t = day('2026-06-13T10:00:00');
    const acc = new StatsAccumulator('book-1', () => t, () => '2026-06-13');
    acc.onPlay();           // t0
    t += 10_000;            // +10s playing
    acc.onPause();
    t += 60_000;            // +60s paused (ignored)
    acc.onPlay();
    t += 5_000;             // +5s playing
    const drained = acc.drain();
    expect(drained).toEqual({ sessionPresent: true, days: [{ date: '2026-06-13', seconds: 15 }] });
  });

  it('attributes to the active book and flushes prior book on switch', () => {
    let t = day('2026-06-13T10:00:00');
    let dateStr = '2026-06-13';
    const acc = new StatsAccumulator('book-1', () => t, () => dateStr);
    acc.onPlay();
    t += 20_000;
    const handoff = acc.switchBook('book-2'); // returns prior book's drain
    expect(handoff).toEqual({ bookId: 'book-1', days: [{ date: '2026-06-13', seconds: 20 }] });
    t += 10_000;
    expect(acc.drain().days).toEqual([{ date: '2026-06-13', seconds: 10 }]);
  });

  it('splits a play interval across local midnight', () => {
    let t = day('2026-06-13T23:59:50');
    let dateStr = '2026-06-13';
    const acc = new StatsAccumulator('b', () => t, () => dateStr);
    acc.onPlay();
    t += 10_000; dateStr = '2026-06-13'; acc.tick();   // 10s still on the 13th
    t += 10_000; dateStr = '2026-06-14'; acc.tick();   // next 10s on the 14th
    const d = acc.drain().days;
    expect(d).toContainEqual({ date: '2026-06-13', seconds: 10 });
    expect(d).toContainEqual({ date: '2026-06-14', seconds: 10 });
  });
});
```

- [ ] **Step 2: Run, verify fail.** FAIL.

- [ ] **Step 3: Implement**

```ts
// src/lib/listen-stats-reporter.ts
/* fs-16 — wall-clock listening accumulator for one player session. Rate- and
   seek-independent: it sums real elapsed time between play and pause/checkpoint
   using a clock, never the media currentTime. Buckets seconds by the injected
   local-date string, attributing to the active book; switching books flushes
   the prior book's tally. See spec D2/C5. */
export interface DrainedDays { date: string; seconds: number; }
type Clock = () => number;          // ms epoch
type LocalDate = () => string;      // 'YYYY-MM-DD' in the viewer's local tz

export class StatsAccumulator {
  private byDate = new Map<string, number>();
  private playing = false;
  private lastCheckpoint = 0;
  constructor(private bookId: string, private now: Clock, private localDate: LocalDate) {}

  private addElapsed(): void {
    if (!this.playing) return;
    const t = this.now();
    const secs = Math.max(0, (t - this.lastCheckpoint) / 1000);
    const date = this.localDate();
    this.byDate.set(date, (this.byDate.get(date) ?? 0) + secs);
    this.lastCheckpoint = t;
  }

  onPlay(): void { if (this.playing) return; this.playing = true; this.lastCheckpoint = this.now(); }
  onPause(): void { this.addElapsed(); this.playing = false; }
  tick(): void { this.addElapsed(); }   // periodic checkpoint (also handles midnight split)

  /** Snapshot the accumulated days (rounded to whole seconds) without clearing. */
  drain(): { sessionPresent: boolean; days: DrainedDays[] } {
    this.addElapsed();
    return {
      sessionPresent: this.byDate.size > 0 || this.playing,
      days: [...this.byDate.entries()].map(([date, s]) => ({ date, seconds: Math.round(s) })),
    };
  }

  /** Flush current book's tally and re-target. Returns prior book's days. */
  switchBook(nextBookId: string): { bookId: string; days: DrainedDays[] } {
    this.addElapsed();
    const prior = { bookId: this.bookId, days: [...this.byDate.entries()].map(([date, s]) => ({ date, seconds: Math.round(s) })) };
    this.byDate = new Map();
    this.bookId = nextBookId;
    if (this.playing) this.lastCheckpoint = this.now();
    return prior;
  }
}
```

- [ ] **Step 4: Run, verify pass.** PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/listen-stats-reporter.ts src/lib/listen-stats-reporter.test.ts
git commit -m "feat(frontend): pure wall-clock StatsAccumulator (fs-16)"
```

---

### Task D2: Wire the accumulator into the mini-player

**Files:** Modify `src/components/mini-player.tsx`; Test: extend `src/components/mini-player.test.tsx`.

Integration points (read the component first — the relevant lines from the spec/grep):
- `const [playing, setPlaying]` (~line 73) → call `acc.onPlay()` / `acc.onPause()` on transitions (in the `setPlaying` effect or alongside the existing play/pause wiring).
- `onTimeUpdate` (~line 800): **PL4 — place the stats flush INSIDE the existing once-per-5s `lastSavedAtRef` block** (the same gate that throttles the listen-progress PUT). `onTimeUpdate` fires ~4×/sec; without the gate, `flushStats` would PUT 4×/sec. Inside the 5s block: `accRef.current.tick(); flushStats(bookId, accRef.current.drain().days);`
- On book change (the existing per-book resume effect keyed on `bookId`) → `acc.switchBook(newBookId)` and flush the returned prior-book days.
- `onEnded` (~line 871) → `acc.onPause()` + flush.
- Mint a per-page-load `sessionId` once: `const sessionId = useRef(crypto.randomUUID()).current`.
- `localDate = () => new Date().toLocaleDateString('en-CA')` (en-CA → `YYYY-MM-DD`).

Flush helper (debounced with the existing save, fire-and-forget):
```ts
function flushStats(bookId: string, days: DrainedDays[]) {
  const nonzero = days.filter((d) => d.seconds > 0);
  if (!nonzero.length) return;
  void api.putListenStats(bookId, { sessionId, days: nonzero }).catch(() => {});
}
```

Final flush on unload (keepalive — survives `pagehide`, keeps PUT; spec m1):
```ts
useEffect(() => {
  const onHide = () => {
    const { days } = accRef.current.drain();
    const nz = days.filter((d) => d.seconds > 0);
    if (!nz.length) return;
    void fetch(`/api/books/${encodeURIComponent(bookId)}/listen-stats`, {
      method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, days: nz }),
    }).catch(() => {});
  };
  window.addEventListener('pagehide', onHide);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') onHide(); });
  return () => window.removeEventListener('pagehide', onHide);
}, [bookId, sessionId]);
```

**Scope guard (D13):** only this global book mini-player gets an accumulator. Do **not** add one to `use-sample-playback.ts`, `use-ab-playback.ts`, or clip-share previews.

- [ ] **Step 1: Write the failing test** — render the mini-player with a fake `api.putListenStats` spy, simulate play → advance fake timers → fire the `onTimeUpdate`/pause path → assert `putListenStats` called with `{ sessionId, days:[{date, seconds>0}] }`. (Use the existing mini-player test harness + `vi.useFakeTimers()`.)
- [ ] **Step 2: Run, verify fail.** FAIL (no call).
- [ ] **Step 3: Implement** the wiring above.
- [ ] **Step 4: Run, verify pass.** Then `npm run test -- mini-player`.
- [ ] **Step 5: Commit**

```bash
git add src/components/mini-player.tsx src/components/mini-player.test.tsx
git commit -m "feat(frontend): mini-player reports wall-clock listening (fs-16)"
```

---

## Wave E — fs-15: Continue-listening rail

### Task E1: Slice + rail component

**Files:** Create `src/store/continue-listening-slice.ts` (+ register in `src/store/index.ts`), `src/components/library/continue-listening-rail.tsx`; Tests co-located.

- [ ] **Step 1:** Slice test — `hydrate` stores items, selector returns them; render test — rail shows a card per item with title + "Ch N · M left" + a progress bar, hides when empty, each card is a button ≥44px that calls `onOpen(bookId, chapterId)`.
- [ ] **Step 2:** Verify fail.
- [ ] **Step 3:** Implement slice (`{ items: ContinueItem[] }`, `hydrate` reducer, `selectContinueListening`) + presentational `ContinueListeningRail({ items, onOpen })` using design tokens (`--peach`/`--ink`/`--magenta`), horizontal scroll, `min-h-[44px] sm:min-h-0`, `remainingSec` formatted via `src/lib/time.ts`.
- [ ] **Step 4:** Verify pass.
- [ ] **Step 5:** Commit `feat(frontend): continue-listening slice + rail component (fs-15)`.

### Task E2: Mount in the library + fetch

**Files:** Modify `src/views/book-library.tsx`.

- [ ] **Step 1:** Test — on mount the orchestrator calls `api.getContinueListening`, dispatches `hydrate`, renders the rail above the grid; tapping a card navigates to `#/books/:id/listen?chapter=N` (assert `stageToHash`/dispatch).
- [ ] **Step 2–4:** Implement: `useEffect` fetch on mount; render `<ContinueListeningRail items={…} onOpen={(bookId, chapterId) => dispatch(go to ready/listen)} />` above the existing grid region. The existing plan-47 on-mount resume-seek lands the position — no new seek code.
- [ ] **Step 5:** Commit `feat(frontend): mount continue-listening rail in library (fs-15)`.

---

## Wave F — fs-16: `#/stats` view

### Task F1: Pure client streak/last-7 math

**Files:** Create `src/lib/listen-stats-math.ts`; Test co-located.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { currentStreak, longestStreak, last7Days } from './listen-stats-math';

const byDay = (entries: [string, number][]) => entries.map(([date, seconds]) => ({ date, seconds }));

describe('currentStreak (grace = today or yesterday)', () => {
  it('counts consecutive days ending today', () => {
    expect(currentStreak(byDay([['2026-06-11', 60], ['2026-06-12', 60], ['2026-06-13', 60]]), '2026-06-13')).toBe(3);
  });
  it('still alive if last listen was yesterday', () => {
    expect(currentStreak(byDay([['2026-06-12', 60]]), '2026-06-13')).toBe(1);
  });
  it('zero if last listen was 2+ days ago', () => {
    expect(currentStreak(byDay([['2026-06-10', 60]]), '2026-06-13')).toBe(0);
  });
  it('ignores zero-second days', () => {
    expect(currentStreak(byDay([['2026-06-12', 0], ['2026-06-13', 60]]), '2026-06-13')).toBe(1);
  });
});

describe('longestStreak', () => {
  it('finds the longest run with gaps', () => {
    expect(longestStreak(byDay([['2026-06-01', 1], ['2026-06-02', 1], ['2026-06-05', 1], ['2026-06-06', 1], ['2026-06-07', 1]]))).toBe(3);
  });
});

describe('last7Days', () => {
  it('returns 7 entries ending today, zero-filled', () => {
    const out = last7Days(byDay([['2026-06-13', 300]]), '2026-06-13');
    expect(out).toHaveLength(7);
    expect(out[6]).toEqual({ date: '2026-06-13', seconds: 300 });
    expect(out[0].seconds).toBe(0);
  });
});
```

- [ ] **Step 2:** Verify fail.
- [ ] **Step 3:** Implement (date math on `YYYY-MM-DD` via `Date.UTC` parsing of the parts; treat days with `seconds > 0` as active; `currentStreak` walks back from today, allowing the most-recent active day to be today or yesterday, else 0; `last7Days` zero-fills the 7-day window ending on `today`).
- [ ] **Step 4:** Verify pass.
- [ ] **Step 5:** Commit `feat(frontend): client-side streak/last-7 math (fs-16)`.

### Task F2: Router seams for `#/stats`

**Files:** `src/lib/types.ts` (add `| { kind: 'stats' }` to `Stage`), `src/lib/router.ts` (`stageToHash` case → `#/stats`; `parseHash` inbound `#/stats` → `{ kind: 'stats' }`), `src/App.tsx` (render `<StatsView/>`), `src/test/a11y.test.tsx` (add `#/stats`). Test: extend `src/lib/router.test.ts` (round-trip `#/stats` ↔ `{ kind: 'stats' }`).

- [ ] **Step 1–4:** TDD the router round-trip first, then wire `types.ts`, `parseHash`, `App.tsx`, a11y list. `npm run typecheck` must pass.
- [ ] **Step 5:** Commit `feat(frontend): #/stats route seams (fs-16)`.

### Task F3: `StatsView` (Reading-column, Tufte)

**Files:** Create `src/views/stats.tsx`; add an entry link from Account/library (e.g. a "Listening stats" link in the library chrome or account view). Test co-located.

- [ ] **Step 1:** Render test with a seeded `getLibraryStats` payload — asserts the lede sentence with `totalListenedSec` formatted (use `src/lib/time.ts`), `booksFinished`, the streak sentence (from F1 math against the client's today), the 7-day sparkbars (7 bars, peak gets the accent), the sorted completion list, and the per-series rollup. First-run (all zeros) renders sensible copy, not NaN.
- [ ] **Step 2:** Verify fail.
- [ ] **Step 3:** Implement the Reading-column layout from the approved mockup (`.superpowers/brainstorm/.../dashboard-layout-v2.html`, Option A): single column, numbers-in-sentences lede, sparkbars, sorted completion rows with thin bars + right-aligned %, single accent on the focal/peak, by-series small table. **Brand palette tokens only — no hex literals (see the Brand-consistency section + its acceptance gate).** **PL2 — `today` is an injectable prop** (`today?: string`, defaulting to `new Date().toLocaleDateString('en-CA')`) so F1 streak/last-7 math is deterministic in the render test; the test passes a fixed `today` matching its seeded `byDay`. Fonts: Lora for the lede/figures, General Sans for labels/%s.
- [ ] **Step 4:** Verify pass + `npm run test -- stats`.
- [ ] **Step 5:** Commit `feat(frontend): #/stats Reading-column dashboard (fs-16)`.

### Task F4: e2e + visual snapshot

**Files:** `e2e/responsive/coverage.spec.ts` (append a `#/stats` case per the "adding a new view" convention); a stats e2e spec (rail appears → click resumes; `#/stats` renders from a seeded payload via `__SEED_*__`); a visual snapshot spec under `e2e/responsive/visual.spec.ts` for the dashboard.

- [ ] **Step 1–4:** Write the specs; seed via `page.addInitScript` setting `__SEED_CONTINUE__` / `__SEED_LIBRARY_STATS__`. Run `npm run test:e2e` (rail + stats render) and `npm run test:e2e:visual` (dashboard snapshot, `--workers=1` lane — spec m3). **PL9 — generate the baseline once with `--update-snapshots` and COMMIT the snapshot file**; CI's visual lane runs the *check*, never `--update-snapshots`. Eyeball the committed baseline for brand correctness before committing it.
- [ ] **Step 5:** Commit `test(e2e): continue-listening rail + #/stats coverage + visual (fs-15/fs-16)`.

---

## Wave G — Delete-book history warning

### Task G1

**Files:** `src/components/library/library-grid.tsx` + `library-table.tsx` (the delete affordance). Tests: the co-located `*.test.tsx`.

- [ ] **Step 1:** Test — the delete confirmation copy now includes a line that listening history/stats for the book will be removed too.
- [ ] **Step 2–4:** Add the sentence to the existing delete-confirm dialog (if delete is a bare action with no confirm, add a minimal confirm). No server change — `DELETE /api/books/:id` already removes the whole dir incl. `listen-stats.json`.
- [ ] **Step 5:** Commit `feat(frontend): warn that deleting a book clears its listening history (fs-16/D14)`.

---

## Wave H — Companion (Android) reporting — report-only

> **Splittable:** this wave can ship as its own follow-up PR after Waves A–C land (the server PUT must exist first). It adds no companion UI.

### Task H1: Dart accumulator + persisted offline buffer + flush

**Files (companion):** Create `apps/android/lib/.../listen_stats_reporter.dart` + a drift table for the offline buffer; wire into the app-5 `PlayerController` and the app-8 reconnect flush. Tests: `apps/android/test/listen_stats_reporter_test.dart`.

- [ ] **Step 1:** Dart unit tests — accumulator counts only `playing && processingState == ready` wall-clock (injectable clock); the offline buffer **persists `{sessionId, date→seconds}`** and survives a simulated relaunch; flush re-sends the absolute per `(sessionId, date)` and clears on a 200; idempotent on retry.
- [ ] **Step 2–4:** Implement the Dart `StatsAccumulator` (mirror the TS logic), a drift `StatsBuffer` table keyed by `(sessionId, date)`, and a flush that POSTs… `PUT /api/books/{bookId}/listen-stats` via the generated client (regenerate the Dart client from the updated `openapi.yaml`). Count `ready`-only (spec m7).
- [ ] **Step 5:** Commit `feat(app): report wall-clock listening to the server (fs-16, report-only)`.

---

## Wave I — Docs, regression plan, ship

### Task I1: Regression plan + index + backlog

**Files:** Create `docs/features/<next>-fs15-fs16-listening-stats.md` from `docs/features/TEMPLATE.md` (use the next free number — check `docs/features/INDEX.md` for the highest; ≈ 211). Add its `INDEX.md` entry. Update `docs/BACKLOG.md` (collapse/remove the fs-15 + fs-16 rows). Frontmatter `status: active`.

- [ ] Document invariants + the manual acceptance walkthrough (play on web → stats accrue; cross-book rail order; companion offline flush; deletion clears history). List the documented limitations (no backfill, finished-divergence, multi-device double-count, trust boundary).
- [ ] Commit `docs(docs): fs-15/fs-16 regression plan + backlog reconcile`.

### Task I2: Verify + PR

- [ ] Run `npm run verify` (full battery). All green.
- [ ] Open a **draft** PR: `gh pr create --draft`, body links the spec + plan + regression plan and `Closes #462` / `Closes #463`. Title: `feat(frontend,server): cross-book continue-listening + listening-stats dashboard (fs-15, fs-16)`.
- [ ] Run `npm run verify` once green → `gh pr ready`.

---

## Self-review (completed)

- **Spec coverage:** D1–D14 → Waves A–H; S1 (duration source) → B1; S2 (max-upsert) → A2; S3 (finished predicate) → B2; S4/S5 (bounds/past-floor) → A2; S6 (wire↔storage) → A2/A3; S7 (documented) → I1; P1/P2 (final listenable chapter + ε) → B1/B2; P3 (router seams) → F2; P4 (mock surface) → C2; P5 (single-process mutex) → A1/A3.
- **No placeholders:** logic-bearing tasks (A1–B2, C2, D1, F1) carry full code + tests. Route/UI/Dart tasks give exact integration points and representative code; the engineer reads the named files to match local helpers (called out explicitly where names must be confirmed).
- **Type consistency:** `ListenStatsFile`/`StatsDay`/`StatsSessionSlot`, `BookStatsInput`/`ResumeInput`, `StatsAccumulator.{onPlay,onPause,tick,drain,switchBook}`, `DrainedDays`, and `ListenStatsPutBody` are used consistently across server, client, and tests.
- **Adversarial pass on the plan folded in:** PL1 (B3 resolves `chapterUuid`→current id) · PL2 (F3 `today` injectable) · PL3 (real inline test-fixture pattern, A3/B3) · PL4 (D2 flush inside the 5s gate) · PL5 (mock duplicates the merge, no server import) · PL6 (resolved by the Brand-consistency a11y rule) · PL7 (B3 slow-tier fallback) · PL8 (real `scan.ts` enumeration) · PL9 (committed visual baseline).
- **Brand:** every UI colour binds a brand-palette token (zero hex literals — grep gate in E2/F3), Lora + General Sans, single accent on the focal datum, AA-compliant text; verified against the real app via `run-app`.
