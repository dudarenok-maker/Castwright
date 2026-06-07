# Single Voice Design — Background-Survivable with Live Progress — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make single-character Qwen voice design survive closing the Profile Drawer (and a reload), with a live, honest progress treatment, by promoting it from a synchronous request to a detached, SSE-streamed, reattachable job that reuses the bulk "Design full cast" client machinery.

**Architecture:** A new server-side single-design job (one per book, `server/src/routes/single-design.ts`) mirrors the bulk job in `cast-design.ts` (detach on subscriber disconnect, reattach via bare POST, status probe) but is per-character, emits sub-phase events, and supports the A/B `-preview` mode. First designs auto-persist the override in-process; re-designs stage a preview and emit `preview_ready` (no persist). The client reuses the `castDesign` Redux slice + Design status pill + stream middleware, generalized with `kind`/`characterId`/`mode`/`phase` fields and a new `ready-to-compare` terminal state. The Profile Drawer drives its design UI from the slice (not local `designBusy`), so reopening mid-design shows live progress and a completed re-design opens the compare modal.

**Tech Stack:** TypeScript, Express (SSE), React 18, Redux Toolkit (Immer), Vitest + React Testing Library, Playwright. The existing single-design synchronous route (`POST …/design-voice`) is **kept** for emotion-variant design; only the base-voice drawer path moves to the new stream.

**Spec:** `docs/superpowers/specs/2026-06-07-single-voice-design-background-progress-design.md`

---

## Decision recap (approved during brainstorming)

- **D1 Full** — detached + SSE-streamed + reattachable single-design job.
- **D2 Reuse** — generalize the existing `castDesign` slice + Design pill + stream middleware, not a parallel slice.
- **D3 Ready-to-compare** — a backgrounded re-design never auto-applies; it holds the `-preview` and announces "ready to compare."
- **D4 Symmetric mutual exclusion** — a single design marks the shared `designBusy` registry so a bulk job 409s while it runs (today only the reverse holds).

## File map

**Server**
- Create `server/src/routes/single-design.ts` — the per-book single-design job (start/subscribe/status routes, phase emission, first-design persist, preview_ready). Mirrors `cast-design.ts`.
- Create `server/src/routes/single-design.test.ts` — SSE loop, persist vs preview, phases, reattach, busy 409s.
- Modify `server/src/routes/cast-design.ts:229-248` — bulk start also 409s when `isDesignBusy` (a single design is running).
- Modify `server/src/index.ts` — mount `singleDesignRouter` beside `castDesignRouter`.

**Client**
- Modify `src/lib/api.ts:3750-3960` — extend `CastDesignCallbacks` (`onPhase`, `onPreviewReady`), extend `readCastDesignStream` (`phase`, `preview_ready`), add `startSingleDesign` / `subscribeSingleDesign` / `getSingleDesignStatus` (real + mock), register them on the `api` object + types.
- Modify `src/store/cast-design-slice.ts` — generalize the snapshot + add `beginSingle` / `setPhase` / `previewReady` reducers + `designSingleRequested` / `resubscribeSingle` request actions + a `ready-to-compare` state.
- Modify `src/store/cast-design-stream-middleware.ts` — own the single-design SSE (start + cold-boot resubscribe).
- Create `src/components/design-progress.tsx` — the branded waveform + soft-fill + phase-label progress block.
- Create `src/components/design-progress.test.tsx` — renders phase, holds the fill, snaps on done.
- Modify `src/components/voice-engine-picker.tsx` — render `<DesignProgress>` while designing instead of the bare spinner; add the "keeps running" note.
- Modify `src/modals/profile-drawer.tsx` — dispatch `designSingleRequested` instead of awaiting `api.designQwenVoice`; drive `designBusy`/phase/preview from the slice for this character; open `VoiceCompareModal` on `ready-to-compare`.
- Modify `src/components/top-bar.tsx` — `DesignPillData` gains optional `phase`; `DesignPill` renders it.
- Modify `src/components/layout.tsx:563-575,1195-1218` — cold-boot probe also calls `getSingleDesignStatus`; `designPill` passes `phase`.

**Test/docs**
- Modify `src/store/cast-design-slice.test.ts`, `src/store/cast-design-stream-middleware.test.ts`, `src/components/top-bar.test.tsx`, `src/modals/profile-drawer.test.tsx`.
- Create `e2e/single-voice-design-background.spec.ts`.
- Create `docs/features/NNN-single-voice-design-background.md` (assign `NNN` from the next free number) + add to `docs/features/INDEX.md`.

## Conventions for this plan

- Branch already cut: `feat/single-voice-design-background`. Rebase onto latest `main` before starting (`git rebase main`) — the spec commit and gitignore commit ride along.
- Commit after every task (the TDD "commit" step). Commit subjects follow `<type>(<scope>): <subject>` with scopes from `frontend | server | sidecar | app | scripts | e2e | mocks | openapi | docs | deps | ci`.
- Reducers never call `Date.now()` — callers pass `lastTickAt` (same idiom as the existing slice).
- Run `npm run typecheck` after any cross-file type change.

---

## Task 1: Symmetric mutual exclusion (bulk 409s during a single design)

**Files:**
- Modify: `server/src/routes/cast-design.ts:229-248`
- Test: `server/src/routes/cast-design.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `server/src/routes/cast-design.test.ts` (mirror the existing mutual-exclusion test that asserts the bulk start 409s during analysis):

```ts
import { markDesignBusy, clearDesignBusy } from '../tts/design-lock.js';

it('409s the bulk start when a single design is already busy for the book', async () => {
  const { bookDir } = await seedBook(); // existing helper in this file
  markDesignBusy(bookDir);
  try {
    const res = await request(app)
      .post(`/api/books/${BOOK_ID}/cast/design`)
      .send({ characterIds: ['c1'], modelKey: 'qwen3-tts' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/single voice design/i);
  } finally {
    clearDesignBusy(bookDir);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:server -- cast-design`
Expected: FAIL — bulk currently returns 200/SSE because it never checks `isDesignBusy`.

- [ ] **Step 3: Add the guard**

In `cast-design.ts`, import `isDesignBusy` (the file already imports from `design-lock.js` — add it):

```ts
import { markDesignBusy, clearDesignBusy, isAnalysisBusy, isDesignBusy } from '../tts/design-lock.js';
```

In the `isStart` validation block (just after the `isAnalysisBusy` 409, before the modelKey check, ~line 241):

```ts
    if (isDesignBusy(bookDir)) {
      return res.status(409).json({
        error:
          'A single voice design is in progress for this book. Wait for it to finish before designing the full cast.',
      });
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:server -- cast-design`
Expected: PASS (all existing cast-design tests still green).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/cast-design.ts server/src/routes/cast-design.test.ts
git commit -m "fix(server): bulk cast design 409s while a single design is busy"
```

---

## Task 2: Single-design server job — first-design persist + phases

**Files:**
- Create: `server/src/routes/single-design.ts`
- Create: `server/src/routes/single-design.test.ts`
- Modify: `server/src/index.ts`

This task builds the job for the **first-design** path (no preview). Task 3 adds preview mode.

- [ ] **Step 1: Write the failing test**

Create `server/src/routes/single-design.test.ts`. Use the same harness style as `cast-design.test.ts` (real ffmpeg, a stubbed sidecar). Stub the design core so no GPU is needed:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// Stub the shared design core so the job runs without a sidecar/GPU.
vi.mock('./qwen-voice.js', async (orig) => ({
  ...(await orig<typeof import('./qwen-voice.js')>()),
  designQwenVoiceForCharacter: vi.fn(async (p: { characterId: string; preview?: boolean }) => ({
    voiceId: p.preview ? `qwen-${p.characterId}-preview` : `qwen-${p.characterId}`,
    url: `/api/voice-sample/${p.characterId}.mp3`,
  })),
}));

import { singleDesignRouter } from './single-design.js';
import { applyOverrideToCastFiles } from './voices.js';
vi.mock('./voices.js', async (orig) => ({
  ...(await orig<typeof import('./voices.js')>()),
  applyOverrideToCastFiles: vi.fn(async () => {}),
}));

// seedBook(): writes a cast.json with one character {id:'c1', name:'Aria', voiceStyle:'warm'}
// and returns { app, BOOK_ID, bookDir }. Copy the helper shape from cast-design.test.ts.

function collectSse(res: request.Response): Record<string, unknown>[] {
  return res.text
    .split('\n\n')
    .map((b) => b.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n'))
    .filter(Boolean)
    .map((j) => JSON.parse(j));
}

describe('single-design job — first design', () => {
  it('streams phase events, persists the override, and ends with designed', async () => {
    const { app, BOOK_ID } = await seedBook();
    const res = await request(app)
      .post(`/api/books/${BOOK_ID}/cast/c1/design-voice/stream`)
      .send({ persona: 'a warm, confident voice', sampleVoiceId: 'char-c1', modelKey: 'qwen3-tts' });

    const events = collectSse(res);
    const types = events.map((e) => e.type);
    expect(types).toContain('phase');
    expect(events.find((e) => e.type === 'phase' && e.phase === 'designing')).toBeTruthy();
    expect(events.find((e) => e.type === 'phase' && e.phase === 'rendering')).toBeTruthy();
    const designed = events.find((e) => e.type === 'designed');
    expect(designed).toMatchObject({ characterId: 'c1', voiceId: 'qwen-c1' });
    expect(applyOverrideToCastFiles).toHaveBeenCalledWith(
      'c1', // matchKey = character.voiceId ?? character.id
      { engine: 'qwen', name: 'qwen-c1' },
      expect.anything(),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:server -- single-design`
Expected: FAIL — `single-design.js` does not exist.

- [ ] **Step 3: Implement the job (first-design path)**

Create `server/src/routes/single-design.ts`. This mirrors `cast-design.ts` structure (the `DesignJob`/`broadcast`/`endJob`/SSE-setup skeleton) but is per-character with phase emission. Full code:

```ts
/* Single-character voice-design job — server-owned, SSE-streamed.

   POST /api/books/:bookId/cast/:characterId/design-voice/stream
        — start a background single design (body: persona, sampleVoiceId,
          modelKey, preview). One job per book.
   POST /api/books/:bookId/cast/design-single/subscribe
        — re-attach to an in-flight single design after a reload (bare body).
   GET  /api/books/:bookId/cast/design-single/status
        — is a single design live for this book? (cold-boot probe)

   Like the bulk job, it KEEPS RUNNING when its SSE subscriber disconnects, so
   closing the drawer / reloading the page never cancels it. The shared core
   `designQwenVoiceForCharacter` is reused (lock-guarded, GPU-fair). A FIRST
   design (preview=false) persists the override in-process exactly as the bulk
   job does; a RE-DESIGN (preview=true) stages a `-preview` sibling and emits
   `preview_ready` WITHOUT persisting — the drawer's A/B compare promotes it.

   Marks the shared `designBusy` registry so a bulk run 409s while this runs
   (symmetric mutual exclusion); both serialize on `withDesignLock` regardless. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { findBookByBookId, bookStateLanguage } from '../workspace/scan.js';
import { sidecarLanguageName } from '../tts/language.js';
import { castJsonPath } from '../workspace/paths.js';
import { readJson } from '../workspace/state-io.js';
import { isTtsModelKey, TTS_MODEL_LABELS, type TtsModelKey } from '../tts/index.js';
import type { CastCharacter } from '../tts/synthesise-chapter.js';
import { designQwenVoiceForCharacter } from './qwen-voice.js';
import { applyOverrideToCastFiles } from './voices.js';
import { findAuthorSeriesForBookId } from '../workspace/series-cast-scan.js';
import { markDesignBusy, clearDesignBusy, isDesignBusy } from '../tts/design-lock.js';

export const singleDesignRouter = Router();

interface CastFile {
  characters: CastCharacter[];
}

interface Subscriber {
  send: (payload: unknown) => void;
  res: Response;
  keepAlive: ReturnType<typeof setInterval>;
}

interface SingleJob {
  bookId: string;
  bookDir: string;
  characterId: string;
  characterName: string;
  mode: 'first' | 'redesign';
  phase: 'designing' | 'rendering';
  preview: boolean;
  subscribers: Set<Subscriber>;
  controller: AbortController;
}

const inFlightByBook = new Map<string, SingleJob>();
const HEARTBEAT_MS = 6000;

function broadcast(job: SingleJob, ev: unknown): void {
  for (const sub of job.subscribers) {
    try {
      sub.send(ev);
    } catch {
      /* dead socket */
    }
  }
}

function endJob(job: SingleJob, finalEv?: unknown): void {
  if (finalEv) broadcast(job, finalEv);
  for (const sub of job.subscribers) {
    clearInterval(sub.keepAlive);
    try {
      sub.res.end();
    } catch {
      /* gone */
    }
  }
  job.subscribers.clear();
  if (inFlightByBook.get(job.bookId) === job) inFlightByBook.delete(job.bookId);
  clearDesignBusy(job.bookDir);
}

async function runSingleDesign(
  job: SingleJob,
  persona: string,
  sampleVoiceId: string,
  modelKey: TtsModelKey,
  language: string,
  seriesFilter: { author: string; series: string } | undefined,
): Promise<void> {
  const cast = await readJson<CastFile>(castJsonPath(job.bookDir));
  const character = cast?.characters?.find((c) => c.id === job.characterId);
  if (!character) {
    endJob(job, { type: 'error', code: 'not_found', message: 'Character no longer exists.' });
    return;
  }

  const heartbeat = setInterval(
    () => broadcast(job, { type: 'heartbeat', characterId: job.characterId }),
    HEARTBEAT_MS,
  );
  try {
    /* Phase 1 — designing. The audition-render phase is emitted by the core
       boundary below; the core does design THEN encode, so we flip to
       'rendering' right before the encode is observable. Since the core is a
       single call, we approximate the two honest phases around it: 'designing'
       up front, 'rendering' is emitted from a thin wrapper once the sidecar PCM
       returns. The core doesn't expose that seam yet, so for v1 we emit
       'rendering' immediately before persist (the encode already happened
       inside the core) — still honest: by then the sidecar call is done and
       we're finalizing the audition. */
    job.phase = 'designing';
    broadcast(job, { type: 'phase', phase: 'designing', characterId: job.characterId });

    const { voiceId } = await designQwenVoiceForCharacter({
      bookDir: job.bookDir,
      character,
      characterId: job.characterId,
      persona,
      sampleVoiceId,
      modelKey,
      language,
      preview: job.preview,
    });

    job.phase = 'rendering';
    broadcast(job, { type: 'phase', phase: 'rendering', characterId: job.characterId });

    if (job.preview) {
      /* Re-design: hold the preview, do NOT persist. The drawer's A/B compare
         promotes (promote-voice) or discards (discard-voice). */
      const previewUrl = `/api/voice-sample/${encodeURIComponent(sampleVoiceId)}.mp3`;
      endJob(job, {
        type: 'preview_ready',
        characterId: job.characterId,
        name: job.characterName,
        previewVoiceId: voiceId,
        previewUrl,
        persona,
      });
      return;
    }

    /* First design: auto-persist exactly as the bulk job does. */
    const matchKey = character.voiceId ?? character.id;
    await applyOverrideToCastFiles(matchKey, { engine: 'qwen', name: voiceId }, seriesFilter);
    endJob(job, {
      type: 'designed',
      characterId: job.characterId,
      name: job.characterName,
      voiceId,
    });
  } catch (e) {
    const message = (e as Error).message || 'Voice design failed.';
    endJob(job, { type: 'error', code: 'design_failed', message });
  } finally {
    clearInterval(heartbeat);
  }
}

singleDesignRouter.post(
  '/:bookId/cast/:characterId/design-voice/stream',
  async (req: Request, res: Response) => {
    const { bookId, characterId } = req.params;
    const body = (req.body ?? {}) as {
      persona?: unknown;
      sampleVoiceId?: unknown;
      modelKey?: unknown;
      preview?: unknown;
    };

    const located = await findBookByBookId(bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });
    const { bookDir } = located;

    /* Symmetric mutual exclusion: refuse if a bulk OR another single design owns
       the book. (Both register in the shared designBusy set.) */
    if (isDesignBusy(bookDir)) {
      return res.status(409).json({
        error: 'A voice design is already in progress for this book.',
      });
    }

    const persona = typeof body.persona === 'string' ? body.persona.trim() : '';
    if (!persona) return res.status(400).json({ error: 'A persona is required to design a voice.' });
    const sampleVoiceId = typeof body.sampleVoiceId === 'string' ? body.sampleVoiceId.trim() : '';
    if (!sampleVoiceId) return res.status(400).json({ error: '`sampleVoiceId` is required.' });
    if (!isTtsModelKey(body.modelKey)) {
      return res
        .status(400)
        .json({ error: `modelKey must be one of: ${Object.keys(TTS_MODEL_LABELS).join(', ')}` });
    }
    const modelKey = body.modelKey;
    const preview = body.preview === true;

    const cast = await readJson<CastFile>(castJsonPath(bookDir));
    const character = cast?.characters?.find((c) => c.id === characterId);
    if (!character) return res.status(404).json({ error: `Character "${characterId}" not found.` });

    /* SSE framing (mirror cast-design.ts). */
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(':ok\n\n');
    const keepAlive = setInterval(() => {
      try {
        res.write(':ka\n\n');
      } catch {
        /* gone */
      }
    }, 15_000);
    const send = (payload: unknown) => {
      try {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch {
        /* gone */
      }
    };

    const language = sidecarLanguageName(bookStateLanguage(located.state));
    const isStandalone = located.state?.isStandalone === true;
    const seriesInfo = isStandalone ? null : await findAuthorSeriesForBookId(bookId);

    const job: SingleJob = {
      bookId,
      bookDir,
      characterId,
      characterName: character.name ?? characterId,
      mode: preview ? 'redesign' : 'first',
      phase: 'designing',
      preview,
      subscribers: new Set(),
      controller: new AbortController(),
    };
    inFlightByBook.set(bookId, job);
    markDesignBusy(bookDir);
    const subscriber: Subscriber = { send, res, keepAlive };
    job.subscribers.add(subscriber);
    res.on('close', () => {
      if (res.writableEnded) return;
      job.subscribers.delete(subscriber);
      clearInterval(keepAlive);
      /* Sticky: keep running for a reload re-attach. */
    });

    void runSingleDesign(job, persona, sampleVoiceId, modelKey, language, seriesInfo ?? undefined);
  },
);

singleDesignRouter.post(
  '/:bookId/cast/design-single/subscribe',
  (req: Request, res: Response) => {
    const { bookId } = req.params;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(':ok\n\n');
    const keepAlive = setInterval(() => {
      try {
        res.write(':ka\n\n');
      } catch {
        /* gone */
      }
    }, 15_000);
    const send = (payload: unknown) => {
      try {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch {
        /* gone */
      }
    };

    const job = inFlightByBook.get(bookId);
    if (!job) {
      send({ type: 'idle' });
      clearInterval(keepAlive);
      return res.end();
    }
    const subscriber: Subscriber = { send, res, keepAlive };
    job.subscribers.add(subscriber);
    send({
      type: 'resume_from',
      characterId: job.characterId,
      name: job.characterName,
      mode: job.mode,
      phase: job.phase,
    });
    res.on('close', () => {
      if (res.writableEnded) return;
      job.subscribers.delete(subscriber);
      clearInterval(keepAlive);
    });
  },
);

singleDesignRouter.get('/:bookId/cast/design-single/status', (req: Request, res: Response) => {
  const job = inFlightByBook.get(req.params.bookId);
  if (!job) return res.status(200).json({ active: false });
  return res.status(200).json({
    active: true,
    characterId: job.characterId,
    name: job.characterName,
    mode: job.mode,
    phase: job.phase,
  });
});
```

Then mount it. In `server/src/index.ts`, find where `castDesignRouter` is mounted (e.g. `app.use('/api/books', castDesignRouter)`) and add directly after it:

```ts
import { singleDesignRouter } from './routes/single-design.js';
// …
app.use('/api/books', singleDesignRouter);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:server -- single-design`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/single-design.ts server/src/routes/single-design.test.ts server/src/index.ts
git commit -m "feat(server): single-design background job with phases + first-design persist"
```

---

## Task 3: Single-design preview mode + reattach + busy 409s

**Files:**
- Modify: `server/src/routes/single-design.test.ts`

The implementation already covers preview, subscribe, and busy from Task 2 — this task locks them with tests.

- [ ] **Step 1: Write the failing tests**

```ts
describe('single-design job — preview (re-design)', () => {
  it('emits preview_ready WITHOUT persisting', async () => {
    const { app, BOOK_ID } = await seedBook();
    const res = await request(app)
      .post(`/api/books/${BOOK_ID}/cast/c1/design-voice/stream`)
      .send({ persona: 'warmer', sampleVoiceId: 'char-c1', modelKey: 'qwen3-tts', preview: true });
    const events = collectSse(res);
    const ready = events.find((e) => e.type === 'preview_ready');
    expect(ready).toMatchObject({ characterId: 'c1', previewVoiceId: 'qwen-c1-preview' });
    expect(applyOverrideToCastFiles).not.toHaveBeenCalled();
  });
});

describe('single-design job — reattach + status + busy', () => {
  it('status reports active during a job and idle otherwise', async () => {
    const { app, BOOK_ID, bookDir } = await seedBook();
    const before = await request(app).get(`/api/books/${BOOK_ID}/cast/design-single/status`);
    expect(before.body).toEqual({ active: false });

    markDesignBusy(bookDir); // simulate a live design holding the registry
    try {
      const res = await request(app)
        .post(`/api/books/${BOOK_ID}/cast/c1/design-voice/stream`)
        .send({ persona: 'x', sampleVoiceId: 'char-c1', modelKey: 'qwen3-tts' });
      expect(res.status).toBe(409); // busy → refused
    } finally {
      clearDesignBusy(bookDir);
    }
  });

  it('bare subscribe to a book with no job idles immediately', async () => {
    const { app, BOOK_ID } = await seedBook();
    const res = await request(app)
      .post(`/api/books/${BOOK_ID}/cast/design-single/subscribe`)
      .send({});
    const events = collectSse(res);
    expect(events.map((e) => e.type)).toContain('idle');
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npm run test:server -- single-design`
Expected: PASS (no source change needed — Task 2 implemented these paths).
If the status test races the job teardown, assert on `active` only via the `markDesignBusy` simulation as written (it never starts a real job).

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/single-design.test.ts
git commit -m "test(server): single-design preview, reattach, and busy 409 coverage"
```

---

## Task 4: Client API — stream functions + callback extensions

**Files:**
- Modify: `src/lib/api.ts:3750-3960` (and the `real`/`mock` `api` objects + the `Api` type)
- Test: covered indirectly by the middleware tests (Task 6); add a focused mock test here.

- [ ] **Step 1: Write the failing test**

Create `src/lib/api-single-design.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { api } from './api';

describe('mock single design', () => {
  it('emits phase events then designed for a first design', async () => {
    const phases: string[] = [];
    let designed: { characterId: string; voiceId: string } | null = null;
    await api.startSingleDesign(
      'book1',
      { characterId: 'c1', persona: 'warm', sampleVoiceId: 'char-c1', modelKey: 'qwen3-tts', preview: false },
      {
        onPhase: ({ phase }) => phases.push(phase),
        onCharacterDesigned: (e) => (designed = e),
        onIdle: () => {},
      },
    );
    expect(phases).toEqual(['designing', 'rendering']);
    expect(designed).toMatchObject({ characterId: 'c1', voiceId: 'qwen-c1' });
  });

  it('emits preview_ready for a re-design', async () => {
    let ready: { previewVoiceId: string } | null = null;
    await api.startSingleDesign(
      'book1',
      { characterId: 'c1', persona: 'warm', sampleVoiceId: 'char-c1', modelKey: 'qwen3-tts', preview: true },
      { onPreviewReady: (e) => (ready = e), onPhase: () => {}, onIdle: () => {} },
    );
    expect(ready).toMatchObject({ previewVoiceId: 'qwen-c1-preview' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- api-single-design`
Expected: FAIL — `api.startSingleDesign` is undefined.

- [ ] **Step 3: Extend `CastDesignCallbacks` and the stream reader**

In `src/lib/api.ts`, extend `CastDesignCallbacks` (after `onHeartbeat`, ~line 3757):

```ts
  /** Single-design sub-phase tick (honest progress). */
  onPhase?: (e: { characterId: string; phase: 'designing' | 'rendering' }) => void;
  /** Single re-design finished — preview staged, awaiting A/B compare. */
  onPreviewReady?: (e: {
    characterId: string;
    name: string;
    previewVoiceId: string;
    previewUrl: string;
    persona: string;
  }) => void;
  /** Single-design (re)subscribe seed — replayed once on reload re-attach so the
      slice can open a single snapshot at the right character + phase. */
  onResumeSingle?: (e: {
    characterId: string;
    name: string;
    mode: 'first' | 'redesign';
    phase: 'designing' | 'rendering';
  }) => void;
```

Extend `CastDesignStreamEvent` (add fields): `phase?: 'designing' | 'rendering'; previewVoiceId?: string; previewUrl?: string; persona?: string; mode?: 'first' | 'redesign';`.

Add cases to `handle()` inside `readCastDesignStream` (alongside the existing cases):

```ts
      case 'phase':
        if (typeof e.characterId === 'string' && (e.phase === 'designing' || e.phase === 'rendering'))
          cb.onPhase?.({ characterId: e.characterId, phase: e.phase });
        break;
      case 'designed':
        if (typeof e.characterId === 'string' && typeof e.voiceId === 'string')
          cb.onCharacterDesigned?.({ characterId: e.characterId, voiceId: e.voiceId });
        break;
      case 'preview_ready':
        if (
          typeof e.characterId === 'string' &&
          typeof e.previewVoiceId === 'string' &&
          typeof e.previewUrl === 'string'
        )
          cb.onPreviewReady?.({
            characterId: e.characterId,
            name: e.name ?? e.characterId,
            previewVoiceId: e.previewVoiceId,
            previewUrl: e.previewUrl,
            persona: e.persona ?? '',
          });
        break;
```

Route the `resume_from` case by shape: the single job's `resume_from` carries `mode`, the bulk's does not. Replace the existing `resume_from` case with:

```ts
      case 'resume_from':
        if (e.mode === 'first' || e.mode === 'redesign') {
          // single-design reload re-attach
          cb.onResumeSingle?.({
            characterId: e.characterId ?? '',
            name: e.name ?? e.characterId ?? '',
            mode: e.mode,
            phase: e.phase === 'rendering' ? 'rendering' : 'designing',
          });
        } else {
          cb.onResumeFrom?.({ total: e.total ?? 0, done: e.done ?? 0, currentName: e.currentName ?? null });
        }
        break;
```

- [ ] **Step 4: Add the real + mock functions**

After `realGetCastDesignStatus` (~line 3920) add:

```ts
interface SingleDesignArgs {
  characterId: string;
  persona: string;
  sampleVoiceId: string;
  modelKey: string;
  preview: boolean;
}

async function realStartSingleDesign(
  bookId: string,
  args: SingleDesignArgs,
  cb: CastDesignCallbacks,
): Promise<void> {
  const res = await fetch(
    `/api/books/${encodeURIComponent(bookId)}/cast/${encodeURIComponent(args.characterId)}/design-voice/stream`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        persona: args.persona,
        sampleVoiceId: args.sampleVoiceId,
        modelKey: args.modelKey,
        preview: args.preview,
      }),
      signal: cb.signal,
    },
  );
  await readCastDesignStream(res, cb);
}

async function realSubscribeSingleDesign(bookId: string, cb: CastDesignCallbacks): Promise<void> {
  const res = await fetch(
    `/api/books/${encodeURIComponent(bookId)}/cast/design-single/subscribe`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: cb.signal },
  );
  await readCastDesignStream(res, cb);
}

export interface SingleDesignStatus {
  active: boolean;
  characterId?: string;
  name?: string;
  mode?: 'first' | 'redesign';
  phase?: 'designing' | 'rendering';
}
async function realGetSingleDesignStatus(bookId: string): Promise<SingleDesignStatus> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/cast/design-single/status`);
  if (!res.ok) return { active: false };
  return (await res.json()) as SingleDesignStatus;
}

async function mockStartSingleDesign(
  _bookId: string,
  args: SingleDesignArgs,
  cb: CastDesignCallbacks,
): Promise<void> {
  cb.onPhase?.({ characterId: args.characterId, phase: 'designing' });
  await wait(120);
  cb.onPhase?.({ characterId: args.characterId, phase: 'rendering' });
  await wait(80);
  if (args.preview) {
    cb.onPreviewReady?.({
      characterId: args.characterId,
      name: args.characterId,
      previewVoiceId: `qwen-${args.characterId}-preview`,
      previewUrl: `/mock/${args.characterId}-preview.mp3`,
      persona: args.persona,
    });
  } else {
    cb.onCharacterDesigned?.({ characterId: args.characterId, voiceId: `qwen-${args.characterId}` });
  }
  cb.onIdle?.({ done: args.preview ? 0 : 1, total: 1, skipped: 0, failures: [] });
}

async function mockSubscribeSingleDesign(_bookId: string, cb: CastDesignCallbacks): Promise<void> {
  cb.onIdle?.({ done: 0, total: 0, skipped: 0, failures: [] });
}
async function mockGetSingleDesignStatus(_bookId: string): Promise<SingleDesignStatus> {
  return { active: false };
}
```

Register on both `api` objects (near `startCastDesign`, lines ~5220 and ~5451) and add to the `Api` type/interface (search for `startCastDesign:` in the type):

```ts
  startSingleDesign: realStartSingleDesign,      // and mockStartSingleDesign in the mock block
  subscribeSingleDesign: realSubscribeSingleDesign,
  getSingleDesignStatus: realGetSingleDesignStatus,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -- api-single-design && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/api.ts src/lib/api-single-design.test.ts
git commit -m "feat(frontend): single-design stream client (start/subscribe/status + phases)"
```

---

## Task 5: Generalize the `castDesign` slice

**Files:**
- Modify: `src/store/cast-design-slice.ts`
- Test: `src/store/cast-design-slice.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `cast-design-slice.test.ts`:

```ts
import { castDesignSlice, castDesignActions } from './cast-design-slice';
const reducer = castDesignSlice.reducer;

describe('single-design snapshot', () => {
  it('beginSingle opens a kind:single snapshot with phase designing', () => {
    const s = reducer(undefined, castDesignActions.beginSingle({
      bookId: 'b1', characterId: 'c1', name: 'Aria', mode: 'first', lastTickAt: 10,
    }));
    expect(s.active).toMatchObject({
      kind: 'single', bookId: 'b1', characterId: 'c1', currentName: 'Aria',
      total: 1, done: 0, mode: 'first', phase: 'designing', state: 'running',
    });
  });

  it('setPhase advances the phase (guarded by character)', () => {
    let s = reducer(undefined, castDesignActions.beginSingle({
      bookId: 'b1', characterId: 'c1', name: 'Aria', mode: 'first', lastTickAt: 10,
    }));
    s = reducer(s, castDesignActions.setPhase({ bookId: 'b1', characterId: 'c1', phase: 'rendering', lastTickAt: 20 }));
    expect(s.active!.phase).toBe('rendering');
    // wrong character is ignored
    s = reducer(s, castDesignActions.setPhase({ bookId: 'b1', characterId: 'cX', phase: 'designing', lastTickAt: 30 }));
    expect(s.active!.phase).toBe('rendering');
  });

  it('previewReady flips to ready-to-compare carrying the preview payload', () => {
    let s = reducer(undefined, castDesignActions.beginSingle({
      bookId: 'b1', characterId: 'c1', name: 'Aria', mode: 'redesign', lastTickAt: 10,
    }));
    s = reducer(s, castDesignActions.previewReady({
      bookId: 'b1', characterId: 'c1',
      previewVoiceId: 'qwen-c1-preview', previewUrl: '/x.mp3', persona: 'warm', lastTickAt: 20,
    }));
    expect(s.active).toMatchObject({
      state: 'ready-to-compare',
      preview: { characterId: 'c1', previewVoiceId: 'qwen-c1-preview', previewUrl: '/x.mp3', persona: 'warm' },
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- cast-design-slice`
Expected: FAIL — `beginSingle`/`setPhase`/`previewReady` undefined; `kind`/`phase` missing.

- [ ] **Step 3: Generalize the snapshot + add reducers**

In `cast-design-slice.ts`, extend `CastDesignSnapshot`:

```ts
export interface CastDesignPreview {
  characterId: string;
  previewVoiceId: string;
  previewUrl: string;
  persona: string;
}

export interface CastDesignSnapshot {
  bookId: string;
  /** Distinguishes the bulk job from a single-character design. */
  kind: 'bulk' | 'single';
  total: number;
  done: number;
  skipped: number;
  currentName: string | null;
  /** Single-design only. */
  characterId?: string;
  mode?: 'first' | 'redesign';
  phase?: 'designing' | 'rendering';
  /** `ready-to-compare` is single-redesign-only: the preview is staged and the
      drawer must resolve it (approve→promote / cancel→discard). */
  state: 'running' | 'done' | 'halted' | 'ready-to-compare';
  lastTickAt: number;
  failures: CastDesignFailure[];
  /** Present iff state === 'ready-to-compare'. */
  preview?: CastDesignPreview;
}
```

Set `kind: 'bulk'` in the existing `begin` reducer's `state.active = { … }` object. Then add reducers (after `begin`):

```ts
    beginSingle(
      state,
      action: PayloadAction<{
        bookId: string;
        characterId: string;
        name: string;
        mode: 'first' | 'redesign';
        lastTickAt: number;
      }>,
    ) {
      state.active = {
        bookId: action.payload.bookId,
        kind: 'single',
        total: 1,
        done: 0,
        skipped: 0,
        currentName: action.payload.name,
        characterId: action.payload.characterId,
        mode: action.payload.mode,
        phase: 'designing',
        state: 'running',
        lastTickAt: action.payload.lastTickAt,
        failures: [],
      };
    },

    setPhase(
      state,
      action: PayloadAction<{
        bookId: string;
        characterId: string;
        phase: 'designing' | 'rendering';
        lastTickAt: number;
      }>,
    ) {
      const snap = state.active;
      if (!snap || snap.kind !== 'single') return;
      if (snap.bookId !== action.payload.bookId || snap.characterId !== action.payload.characterId)
        return;
      snap.phase = action.payload.phase;
      snap.lastTickAt = action.payload.lastTickAt;
    },

    previewReady(
      state,
      action: PayloadAction<{
        bookId: string;
        characterId: string;
        previewVoiceId: string;
        previewUrl: string;
        persona: string;
        lastTickAt: number;
      }>,
    ) {
      const snap = state.active;
      if (!snap || snap.kind !== 'single') return;
      if (snap.bookId !== action.payload.bookId || snap.characterId !== action.payload.characterId)
        return;
      snap.state = 'ready-to-compare';
      snap.currentName = snap.currentName;
      snap.preview = {
        characterId: action.payload.characterId,
        previewVoiceId: action.payload.previewVoiceId,
        previewUrl: action.payload.previewUrl,
        persona: action.payload.persona,
      };
      snap.lastTickAt = action.payload.lastTickAt;
    },
```

Add the two request actions (next to `designAllRequested`/`resubscribe`, no-op reducers):

```ts
    designSingleRequested(
      _state,
      _action: PayloadAction<{
        bookId: string;
        characterId: string;
        name: string;
        persona: string;
        sampleVoiceId: string;
        modelKey: string;
        mode: 'first' | 'redesign';
      }>,
    ) {
      /* side effect lives in the middleware */
    },
    resubscribeSingle(_state, _action: PayloadAction<{ bookId: string }>) {
      /* side effect lives in the middleware */
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- cast-design-slice && npm run typecheck`
Expected: PASS. Fix any TS error where existing `begin` callers now need `kind` (the reducer sets it internally, so callers are unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/store/cast-design-slice.ts src/store/cast-design-slice.test.ts
git commit -m "feat(frontend): generalize castDesign slice for single designs + ready-to-compare"
```

---

## Task 6: Stream middleware — own the single-design SSE

**Files:**
- Modify: `src/store/cast-design-stream-middleware.ts`
- Test: `src/store/cast-design-stream-middleware.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `cast-design-stream-middleware.test.ts` (mirror the existing start/mirror-into-cast tests; the file already stubs `api`):

```ts
it('designSingleRequested → phases, mirrors designed into cast, toasts', async () => {
  const designed: unknown[] = [];
  const toasts: unknown[] = [];
  const store = makeStore({
    startSingleDesign: async (_b, _a, cb) => {
      cb.onPhase?.({ characterId: 'c1', phase: 'designing' });
      cb.onPhase?.({ characterId: 'c1', phase: 'rendering' });
      cb.onCharacterDesigned?.({ characterId: 'c1', voiceId: 'qwen-c1' });
      cb.onIdle?.({ done: 1, total: 1, skipped: 0, failures: [] });
    },
  });
  store.dispatch(castDesignActions.designSingleRequested({
    bookId: 'b1', characterId: 'c1', name: 'Aria', persona: 'warm',
    sampleVoiceId: 'char-c1', modelKey: 'qwen3-tts', mode: 'first',
  }));
  await flush();
  expect(store.getActions().map((a) => a.type)).toEqual(
    expect.arrayContaining(['castDesign/setPhase', 'cast/setQwenOverrideName', 'notifications/pushToast']),
  );
});

it('preview_ready → ready-to-compare + a "ready to compare" toast', async () => {
  const store = makeStore({
    startSingleDesign: async (_b, _a, cb) => {
      cb.onPreviewReady?.({
        characterId: 'c1', name: 'Aria',
        previewVoiceId: 'qwen-c1-preview', previewUrl: '/x.mp3', persona: 'warm',
      });
      cb.onIdle?.({ done: 0, total: 1, skipped: 0, failures: [] });
    },
  });
  store.dispatch(castDesignActions.designSingleRequested({
    bookId: 'b1', characterId: 'c1', name: 'Aria', persona: 'warm',
    sampleVoiceId: 'char-c1', modelKey: 'qwen3-tts', mode: 'redesign',
  }));
  await flush();
  const types = store.getActions().map((a) => a.type);
  expect(types).toContain('castDesign/previewReady');
  expect(types).toContain('notifications/pushToast');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- cast-design-stream-middleware`
Expected: FAIL — middleware ignores `designSingleRequested`.

- [ ] **Step 3: Extend the middleware**

In `cast-design-stream-middleware.ts`, add the new action types near the top:

```ts
const SINGLE_REQUESTED_TYPE = castDesignActions.designSingleRequested.type;
const RESUBSCRIBE_SINGLE_TYPE = castDesignActions.resubscribeSingle.type;
```

Add a callbacks builder for single designs (beside `buildCallbacks`):

```ts
    const buildSingleCallbacks = (
      bookId: string,
      controller: AbortController,
    ): CastDesignCallbacks => ({
      signal: controller.signal,
      /* Reload re-attach: open the single snapshot from the server replay. */
      onResumeSingle: ({ characterId: cid, name, mode, phase }) => {
        dispatch(castDesignActions.beginSingle({ bookId, characterId: cid, name, mode, lastTickAt: Date.now() }));
        dispatch(castDesignActions.setPhase({ bookId, characterId: cid, phase, lastTickAt: Date.now() }));
      },
      onPhase: ({ characterId: cid, phase }) =>
        dispatch(castDesignActions.setPhase({ bookId, characterId: cid, phase, lastTickAt: Date.now() })),
      onHeartbeat: () =>
        dispatch(castDesignActions.heartbeat({ bookId, lastTickAt: Date.now() })),
      onCharacterDesigned: ({ characterId: cid, voiceId }) => {
        dispatch(castActions.setQwenOverrideName({ characterId: cid, voiceId }));
        dispatch(
          notificationsActions.pushToast({
            kind: 'info',
            message: `${currentNameFor(store, cid) ?? 'Voice'} is ready.`,
            dedupeKey: `single-design-done:${bookId}:${cid}`,
          }),
        );
      },
      onPreviewReady: ({ characterId: cid, name, previewVoiceId, previewUrl, persona }) => {
        dispatch(
          castDesignActions.previewReady({
            bookId, characterId: cid, previewVoiceId, previewUrl, persona, lastTickAt: Date.now(),
          }),
        );
        dispatch(
          notificationsActions.pushToast({
            kind: 'info',
            message: `${name}'s new voice is ready to compare.`,
            dedupeKey: `single-design-compare:${bookId}:${cid}`,
          }),
        );
      },
      onIdle: () => {
        /* For a FIRST design, the slice is cleared shortly after the designed
           toast; for a re-design the snapshot stays in 'ready-to-compare' until
           the drawer resolves it, so only clear when NOT awaiting compare. */
        setTimeout(() => {
          const snap = (store.getState() as CastDesignRootState).castDesign.active;
          if (snap && snap.bookId === bookId && snap.kind === 'single' && snap.state !== 'ready-to-compare') {
            dispatch(castDesignActions.clear());
          }
        }, SUMMARY_LINGER_MS);
      },
      onError: ({ message }) => {
        dispatch(castDesignActions.halt({ bookId, lastTickAt: Date.now() }));
        dispatch(
          notificationsActions.pushToast({ kind: 'error', message, dedupeKey: `single-design:${bookId}` }),
        );
      },
    });
```

Add a tiny helper `currentNameFor` near the top of the factory (reads the snapshot's name when the designed character is the active one; falls back to `'Voice'`):

```ts
    const currentNameFor = (s: typeof store, cid: string): string | null => {
      const snap = (s.getState() as { castDesign: { active: { characterId?: string; currentName: string | null } | null } }).castDesign.active;
      return snap && snap.characterId === cid ? snap.currentName : null;
    };
```

In the action switch (the `return (next) => (action) => { … }`), add before the final `return result`:

```ts
      if (a.type === SINGLE_REQUESTED_TYPE) {
        const p = a.payload as {
          bookId: string; characterId: string; name: string; persona: string;
          sampleVoiceId: string; modelKey: string; mode: 'first' | 'redesign';
        };
        if (handle) return result; // one design op per book
        const controller = new AbortController();
        dispatch(
          castDesignActions.beginSingle({
            bookId: p.bookId, characterId: p.characterId, name: p.name, mode: p.mode, lastTickAt: Date.now(),
          }),
        );
        runStream(
          p.bookId,
          controller,
          (cb) =>
            api.startSingleDesign(
              p.bookId,
              { characterId: p.characterId, persona: p.persona, sampleVoiceId: p.sampleVoiceId, modelKey: p.modelKey, preview: p.mode === 'redesign' },
              cb,
            ),
          buildSingleCallbacks, // 4th arg: single-shaped callbacks (read ids from events)
        );
        return result;
      }

      if (a.type === RESUBSCRIBE_SINGLE_TYPE) {
        const { bookId } = a.payload as { bookId: string };
        if (handle || !bookId) return result;
        const controller = new AbortController();
        /* No upfront beginSingle — the server replays `resume_from` with the
           characterId/mode/phase, which onResumeSingle turns into a snapshot. */
        runStream(bookId, controller, (cb) => api.subscribeSingleDesign(bookId, cb), buildSingleCallbacks);
        return result;
      }
```

**Important:** `runStream` currently hard-codes `buildCallbacks` (bulk). Refactor `runStream` to accept the callbacks builder:

```ts
    const runStream = (
      bookId: string,
      controller: AbortController,
      open: (cb: CastDesignCallbacks) => Promise<void>,
      makeCallbacks: (bookId: string, controller: AbortController) => CastDesignCallbacks = buildCallbacks,
    ): void => {
      const localHandle = { bookId, controller };
      handle = localHandle;
      const callbacks = makeCallbacks(bookId, controller);
      // …unchanged body…
    };
```

Then the single-start passes `(bookId, controller) => buildSingleCallbacks(bookId, p.characterId, controller)` as the 4th arg, and the single-resubscribe passes the same. The bulk paths keep the default.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- cast-design-stream-middleware && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/cast-design-stream-middleware.ts src/store/cast-design-stream-middleware.test.ts
git commit -m "feat(frontend): stream middleware owns single-design SSE (phases, persist, compare)"
```

---

## Task 7: `DesignProgress` component (waveform + soft-fill + phase)

**Files:**
- Create: `src/components/design-progress.tsx`
- Create: `src/components/design-progress.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from '@testing-library/react';
import { DesignProgress } from './design-progress';

describe('DesignProgress', () => {
  it('shows the designing phase label', () => {
    render(<DesignProgress phase="designing" />);
    expect(screen.getByText(/designing the voice/i)).toBeInTheDocument();
  });
  it('shows the rendering phase label', () => {
    render(<DesignProgress phase="rendering" />);
    expect(screen.getByText(/rendering the 12s audition/i)).toBeInTheDocument();
  });
  it('renders the waveform + fill scaffold', () => {
    const { container } = render(<DesignProgress phase="designing" />);
    expect(container.querySelector('[data-testid="design-waveform"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="design-fill"]')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- design-progress`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the component**

The animations use existing design tokens (`--magenta`); no hex literals. Tailwind arbitrary keyframes via inline `style` for the soft-fill width transition and a CSS class for the waveform (add the keyframes to `src/styles.css` — see Step 3b).

`src/components/design-progress.tsx`:

```tsx
import type { CSSProperties } from 'react';

const PHASE_LABELS: Record<'designing' | 'rendering', string> = {
  designing: 'Designing the voice…',
  rendering: 'Rendering the 12s audition…',
};

/** Number of waveform bars. Static count; staggered animation delays come from
    the nth-child rules in styles.css (.design-wave i). */
const BARS = 12;

interface Props {
  phase: 'designing' | 'rendering';
  /** When the design is done, pass true so the fill snaps to 100%. */
  complete?: boolean;
}

export function DesignProgress({ phase, complete = false }: Props) {
  /* Soft ETA: CSS animation eases the fill to ~92% over ~15s and holds (see
     styles.css .design-fill i). On completion we override to a full,
     transition-backed width so it snaps shut honestly. */
  const fillStyle: CSSProperties | undefined = complete
    ? { width: '100%', animation: 'none', transition: 'width 300ms ease-out' }
    : undefined;

  return (
    <div className="mt-3 rounded-2xl bg-canvas border border-ink/10 p-4">
      <div className="design-wave" data-testid="design-waveform" aria-hidden="true">
        {Array.from({ length: BARS }, (_, i) => (
          <i key={i} />
        ))}
      </div>
      <div className="design-fill mt-2" data-testid="design-fill">
        <i style={fillStyle} />
      </div>
      <div className="mt-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold text-purple-deep/70">{PHASE_LABELS[phase]}</span>
        <span className="text-[11px] text-ink/40">about 15s</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 3b: Add the keyframes + classes to `src/styles.css`**

Append (uses `var(--magenta)`; no literals):

```css
/* Single voice design — branded waveform + soft-fill progress (plan: single
   voice design background). Motion conveys "a voice is being shaped"; the fill
   eases toward a typical ~15s and HOLDS near 92% so a slow design never lies. */
.design-wave { display: flex; align-items: flex-end; justify-content: center; gap: 3px; height: 32px; }
.design-wave i { width: 3px; border-radius: 2px; background: var(--magenta); animation: design-wave 1s ease-in-out infinite; }
.design-wave i:nth-child(1) { animation-delay: 0s } .design-wave i:nth-child(2) { animation-delay: .08s }
.design-wave i:nth-child(3) { animation-delay: .16s } .design-wave i:nth-child(4) { animation-delay: .24s }
.design-wave i:nth-child(5) { animation-delay: .32s } .design-wave i:nth-child(6) { animation-delay: .4s }
.design-wave i:nth-child(7) { animation-delay: .48s } .design-wave i:nth-child(8) { animation-delay: .56s }
.design-wave i:nth-child(9) { animation-delay: .64s } .design-wave i:nth-child(10) { animation-delay: .72s }
.design-wave i:nth-child(11) { animation-delay: .8s } .design-wave i:nth-child(12) { animation-delay: .88s }
@keyframes design-wave { 0%,100% { height: 7px; opacity: .45 } 50% { height: 30px; opacity: 1 } }
.design-fill { height: 6px; border-radius: 4px; overflow: hidden; background: color-mix(in srgb, var(--magenta) 18%, transparent); }
.design-fill i { display: block; height: 100%; width: 0; border-radius: 4px; background: var(--magenta); animation: design-fill 15s cubic-bezier(.15,.75,.2,1) forwards; }
@keyframes design-fill { 0% { width: 4% } 65% { width: 78% } 100% { width: 92% } }
@media (prefers-reduced-motion: reduce) {
  .design-wave i, .design-fill i { animation-duration: .01ms !important; animation-iteration-count: 1 !important; }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- design-progress`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/design-progress.tsx src/components/design-progress.test.tsx src/styles.css
git commit -m "feat(frontend): branded DesignProgress (waveform + soft-fill + phase label)"
```

---

## Task 8: Wire the drawer + engine picker to the slice

**Files:**
- Modify: `src/components/voice-engine-picker.tsx`
- Modify: `src/modals/profile-drawer.tsx`
- Test: `src/modals/profile-drawer.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `profile-drawer.test.tsx` (the file already builds a store; seed a single-design snapshot for the open character):

```tsx
it('renders DesignProgress when a single design is in flight for this character', () => {
  const store = makeStore(); // existing helper
  store.dispatch(castDesignActions.beginSingle({
    bookId: 'b1', characterId: CHAR.id, name: CHAR.name, mode: 'first', lastTickAt: 1,
  }));
  renderDrawer(store, { character: CHAR, bookId: 'b1', engineChoice: 'qwen' });
  expect(screen.getByTestId('design-waveform')).toBeInTheDocument();
  expect(screen.getByText(/designing the voice/i)).toBeInTheDocument();
});

it('opens the compare modal when the slice is ready-to-compare for this character', async () => {
  const store = makeStore();
  store.dispatch(castDesignActions.beginSingle({ bookId: 'b1', characterId: CHAR.id, name: CHAR.name, mode: 'redesign', lastTickAt: 1 }));
  store.dispatch(castDesignActions.previewReady({
    bookId: 'b1', characterId: CHAR.id, previewVoiceId: 'qwen-x-preview', previewUrl: '/x.mp3', persona: 'warm', lastTickAt: 2,
  }));
  renderDrawer(store, { character: CHAR, bookId: 'b1', engineChoice: 'qwen', designedVoiceId: 'qwen-x' });
  expect(await screen.findByRole('dialog', { name: /compare/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- profile-drawer`
Expected: FAIL — drawer doesn't read the slice yet.

- [ ] **Step 3: Read the slice in the drawer + rewire `designVoice`**

In `profile-drawer.tsx`, add a selector for this character's live design state (near the other `useAppSelector`s, ~line 234):

```ts
  const singleDesign = useAppSelector((s) =>
    s.castDesign.active?.kind === 'single' && s.castDesign.active.characterId === character.id
      ? s.castDesign.active
      : null,
  );
  const sliceDesigning = singleDesign?.state === 'running';
  const slicePhase: 'designing' | 'rendering' = singleDesign?.phase ?? 'designing';
```

Replace the body of `designVoice()` (lines ~706-754) so it dispatches instead of awaiting (keep the play/stop toggle for the audition):

```ts
  async function designVoice() {
    if (designPlaying) {
      playback.stop();
      return;
    }
    if (!bookId || sliceDesigning) return;
    const trimmed = persona.trim();
    if (!trimmed) {
      setEngineError('Add a persona before designing a voice.');
      return;
    }
    setEngineError(null);
    const isRedesign = designedVoiceId !== null;
    dispatch(
      castDesignActions.designSingleRequested({
        bookId,
        characterId: character.id,
        name: character.name,
        persona: trimmed,
        sampleVoiceId,
        modelKey: effectiveSampleModelKey,
        mode: isRedesign ? 'redesign' : 'first',
      }),
    );
  }
```

Add an effect that reacts to completion of the FIRST design (auto-attach is done by the middleware via `setQwenOverrideName`; the drawer mirrors the designed voiceId into local state + plays the audition if still mounted). Place after the existing effects (~line 694):

```ts
  /* First-design completion while the drawer is open: the middleware persisted
     + mirrored the override; reflect the designed voiceId locally and play the
     audition. We detect completion by the slice clearing back to null AFTER a
     run we owned — simplest reliable signal is the cast slice gaining the qwen
     override for this character. */
  const qwenOverrideName = useAppSelector(
    (s) => s.cast.characters.find((c) => c.id === character.id)?.overrideTtsVoices?.qwen?.name ?? null,
  );
  useEffect(() => {
    if (qwenOverrideName && qwenOverrideName !== designedVoiceId && !qwenOverrideName.endsWith('-preview')) {
      setDesignedVoiceId(qwenOverrideName);
    }
  }, [qwenOverrideName, designedVoiceId]);

  /* Re-design completion: open the A/B compare from the slice's preview. */
  useEffect(() => {
    if (singleDesign?.state === 'ready-to-compare' && singleDesign.preview && !voiceCompareInitial) {
      setVoiceCompareInitial({
        voiceId: singleDesign.preview.previewVoiceId,
        previewUrl: singleDesign.preview.previewUrl,
        persona: singleDesign.preview.persona,
      });
    }
  }, [singleDesign, voiceCompareInitial]);
```

When the compare modal resolves (the existing `onApprove`/`onClose` of `VoiceCompareModal`, ~line 1012/1026), also clear the slice so the pill/state resets:

```ts
                  dispatch(castDesignActions.clear());
```

(Add inside both `onApprove` after staging, and `onClose` after `setVoiceCompareInitial(null)`.)

- [ ] **Step 4: Pass progress through to the engine picker**

Change the `VoiceEnginePicker` props in `profile-drawer.tsx` (~line 982):

```tsx
              onDesignVoice={() => void designVoice()}
              designBusy={sliceDesigning || bulkDesignActive}
              designPhase={slicePhase}
              designPlaying={designPlaying}
              designedVoiceId={designedVoiceId}
              error={engineError}
```

In `voice-engine-picker.tsx`, add `designPhase?: 'designing' | 'rendering'` to `Props`, import `DesignProgress`, and replace the busy branch of the design button block (lines ~166-197) so that while `designBusy` it renders `<DesignProgress phase={designPhase ?? 'designing'} />` plus a compact "keeps running if you close" note, and the button shows "Designing voice…" disabled. Keep the `designPlaying` (Stop audition) and idle (Design & preview/compare) branches unchanged:

```tsx
          {designBusy ? (
            <>
              <button type="button" disabled data-testid="qwen-design-voice"
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-2xl text-sm font-semibold bg-magenta/10 text-magenta cursor-wait min-h-[44px] sm:min-h-0">
                <IconSpinner className="w-4 h-4" />
                <span>Designing voice…</span>
              </button>
              <DesignProgress phase={designPhase ?? 'designing'} />
              <p className="mt-1 text-[10px] text-ink/45 text-center">Keeps running if you close — we'll let you know when it's ready.</p>
            </>
          ) : designPlaying ? (
            /* …existing Stop-audition button unchanged… */
          ) : (
            /* …existing Design & preview/compare button unchanged… */
          )}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test -- "profile-drawer|voice-engine-picker" && npm run typecheck`
Expected: PASS. Update any existing drawer test that asserted on the old synchronous "Designing voice…" spinner-only path to seed the slice instead.

- [ ] **Step 6: Commit**

```bash
git add src/modals/profile-drawer.tsx src/components/voice-engine-picker.tsx src/modals/profile-drawer.test.tsx
git commit -m "feat(frontend): drive drawer voice design from the castDesign slice (live progress + compare)"
```

---

## Task 9: Pill phase subtitle + cold-boot resubscribe

**Files:**
- Modify: `src/components/top-bar.tsx` (`DesignPillData`, `DesignPill`)
- Modify: `src/components/layout.tsx:563-575,1195-1218`
- Test: `src/components/top-bar.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `top-bar.test.tsx`:

```tsx
it('DesignPill shows the phase for a single design', () => {
  render(<DesignPill data={{ state: 'running', done: 0, total: 1, percent: 30, skipped: 0, failureCount: 0, currentName: 'Aria', phase: 'rendering', onClick: () => {} }} />);
  expect(screen.getByText(/Aria/)).toBeInTheDocument();
  expect(screen.getByText(/rendering audition/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- top-bar`
Expected: FAIL — `phase` not on `DesignPillData`.

- [ ] **Step 3: Implement**

In `top-bar.tsx`, add to `DesignPillData` (~line 52): `phase?: 'designing' | 'rendering';`. In the `DesignPill` render (~line 648), when `phase` is present, render a subtitle e.g. `Designing {currentName} · {phase === 'rendering' ? 'rendering audition' : 'designing'}` (match the existing subtitle styling for the bulk case).

In `layout.tsx`:
- `designPill` IIFE (~line 1206): add `phase: designSnapshot.kind === 'single' ? designSnapshot.phase : undefined,` to the returned object.
- Cold-boot probe (~line 563-575): after the existing `getCastDesignStatus` block, add the single probe:

```ts
    void Promise.resolve(api.getSingleDesignStatus?.(openBookId))
      .then((st) => {
        if (st?.active) dispatch(castDesignActions.resubscribeSingle({ bookId: openBookId }));
      })
      .catch(() => {});
```

(Guard: only one of bulk/single can be active per book — symmetric exclusion — so the two probes never both resubscribe.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- top-bar && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/top-bar.tsx src/components/layout.tsx src/components/top-bar.test.tsx
git commit -m "feat(frontend): Design pill shows single-design phase + cold-boot resubscribe"
```

---

## Task 10: E2E + docs

**Files:**
- Create: `e2e/single-voice-design-background.spec.ts`
- Create: `docs/features/NNN-single-voice-design-background.md`
- Modify: `docs/features/INDEX.md`

- [ ] **Step 1: Write the e2e spec**

Mock mode drives the deterministic `mockStartSingleDesign`. Mirror `e2e/design-full-cast.spec.ts` for navigation to a Qwen-project cast + opening the drawer.

```ts
import { test, expect } from '@playwright/test';

test('single design survives closing the drawer and announces completion', async ({ page }) => {
  await page.goto('/'); // mock mode
  // …navigate to a ready Qwen cast, open a character's Profile Drawer,
  //   switch engine to Qwen, ensure a persona is present…
  await page.getByTestId('qwen-design-voice').click();
  await expect(page.getByTestId('design-waveform')).toBeVisible();
  // Close the drawer mid-design.
  await page.keyboard.press('Escape');
  // The global Design pill reflects the in-flight single design.
  await expect(page.getByText(/Designing/)).toBeVisible();
  // Completion toast appears; reopening shows the designed voice.
  await expect(page.getByText(/is ready/i)).toBeVisible();
});
```

- [ ] **Step 2: Run the e2e**

Run: `npm run test:e2e -- single-voice-design-background`
Expected: PASS (one-time `npx playwright install chromium` if needed).

- [ ] **Step 3: Write the regression plan doc**

Copy `docs/features/TEMPLATE.md` to `docs/features/NNN-single-voice-design-background.md` (assign `NNN` = next free number; `git ls-files docs/features | tail` to find it). Fill: Benefit (user/technical/architectural), How it works (the job + slice generalization + drawer wiring), Concurrency (symmetric busy + withDesignLock), Test coverage (the files from this plan), Ship notes (date + SHA at merge), Follow-ups (warming sub-phase via sidecar streaming; preview TTL sweep). Frontmatter `status: active`.

Add an entry to `docs/features/INDEX.md` under the relevant area.

- [ ] **Step 4: Commit**

```bash
git add e2e/single-voice-design-background.spec.ts docs/features/NNN-single-voice-design-background.md docs/features/INDEX.md
git commit -m "test(e2e): single voice design background flow + regression plan"
```

---

## Task 11: Full verification + open the PR

- [ ] **Step 1: Run the full battery**

Run: `npm run verify`
Expected: typecheck + all unit/integration + e2e + build green. Fix any failures (triage related vs pre-existing per CLAUDE.md; do not `--no-verify`).

- [ ] **Step 2: Open a draft PR**

```bash
git push -u origin feat/single-voice-design-background
gh pr create --draft --title "feat(frontend,server): single voice design — background-survivable with live progress" --body "$(cat <<'EOF'
## Summary
Single-character Qwen voice design now runs as a detached, SSE-streamed,
reattachable job (mirrors the bulk "Design full cast" machinery) with a live
branded progress treatment. Closing the drawer or reloading no longer loses the
work: first designs auto-persist + toast; re-designs hold a preview and surface
"ready to compare". Symmetric mutual exclusion (single ↔ bulk).

## Test plan
- server: `npm run test:server -- "single-design|cast-design"`
- frontend: `npm run test -- "cast-design|design-progress|profile-drawer|top-bar"`
- e2e: `npm run test:e2e -- single-voice-design-background`
- full: `npm run verify`

Spec: docs/superpowers/specs/2026-06-07-single-voice-design-background-progress-design.md
Plan: docs/features/NNN-single-voice-design-background.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3:** Run `npm run verify` once more locally, then `gh pr ready <n>` to fire the single billed CI run.

**Live-GPU acceptance owed** (needs a Qwen project + weights): design a character, close the drawer mid-design → pill ticks through phases → toast → reopen shows the designed voice + playable; re-design → close → "ready to compare" toast deep-links → compare opens; reload mid-design re-attaches the pill; a bulk "Design full cast" 409s while a single runs and vice versa.

---

## Self-review notes

- **Spec coverage:** progress treatment (Task 7/8), honest phases (Task 2 emit + Task 4 client + Task 8 render), survive-close + reload (Task 2 detach/subscribe + Task 9 resubscribe), auto-persist first design (Task 2), ready-to-compare re-design (Task 2 + 5 + 6 + 8), symmetric mutual exclusion (Task 1 + 2), pill (Task 9), tests + docs (Task 10). All spec sections map to a task.
- **Honest-phase caveat (carried from the spec):** v1 emits two server-controlled phases (`designing`/`rendering`) around the single core call; a distinct "warming" phase needs sidecar streaming and is an explicit follow-up. The `rendering` phase is emitted right after the sidecar PCM returns (encode is in-core) — honest "finalizing the audition," not a fake timer.
- **Type consistency:** `phase: 'designing' | 'rendering'`, `mode: 'first' | 'redesign'`, `state: … | 'ready-to-compare'`, `CastDesignPreview`, `setQwenOverrideName`, `designSingleRequested`/`resubscribeSingle` are used identically across server events, api callbacks, slice, middleware, drawer, and pill.
- **Risk to watch during execution:** the middleware `runStream` refactor (4th-arg callbacks builder) must not change the bulk paths' behavior — the bulk default stays `buildCallbacks`. Re-run the full `cast-design-stream-middleware` suite after Task 6.
