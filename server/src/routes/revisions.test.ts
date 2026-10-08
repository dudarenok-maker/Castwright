/* Integration tests for the revisions/drift detector.

   Covers:
     - Empty workspace → no segments → empty pending + drift.
     - Cast matches every snapshot → no drift.
     - voiceId change → severe drift event, factor 'voice', stable id.
     - Tone-metric delta thresholds: < 25 → nothing; 25-39 → moderate; ≥ 40 → severe.
     - Dismissed-id filter: an id present in revisions.json#dismissed never
       surfaces in the response, even when the underlying signal still holds.
   - Pending read through the store (plan 285): revisions.json#pending is
     normalised by workspace/revisions-store.ts (stale legacy entries
     dropped) and surfaced by both the single-book route (whole
     RevisionsState + drift, even with an empty cast) and the bulk
     GET /api/revisions ({ pending, drift }); a non-array value falls back
     to []; a corrupt file 500s (raw parse error); a lock timeout 500s with the curated contention message.


   Workspace tempdir + supertest pattern matches book-state.reparse.test.ts. */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { retireCharacterId } from '../store/cast-id-history.js';

/* Plan 285 — passthrough spy on the store read so a test can inject a lock
   timeout and pin the curated 500. */
vi.mock('../workspace/revisions-store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../workspace/revisions-store.js')>();
  return { ...real, readRevisions: vi.fn(real.readRevisions) };
});

const AUTHOR = 'Drift Test';
const SERIES = 'Standalones';
const TITLE = 'Drift Detector Book';

let workspaceRoot: string;
let bookDir: string;
let audioRoot: string;
let app: Express;
let bookId: string;

interface DriftEventOut {
  id: string;
  characterId: string;
  chapterId: number;
  chapterTitle: string;
  severity: 'mild' | 'moderate' | 'severe';
  factor: string;
  autoQueueable?: boolean;
  snapshot?: CharacterSnapshot;
  current?: {
    name?: string;
    voiceId?: string;
    gender?: 'male' | 'female' | 'neutral';
    ageRange?: 'child' | 'teen' | 'adult' | 'elderly';
    tone?: { warmth?: number; pace?: number; authority?: number; emotion?: number };
    attributes?: string[];
  };
}

interface CharacterSnapshot {
  tone?: { warmth?: number; pace?: number; authority?: number; emotion?: number };
  gender?: 'male' | 'female' | 'neutral';
  ageRange?: 'child' | 'teen' | 'adult' | 'elderly';
  voiceId?: string;
  voiceEngine?: string;
  resolvedVoiceName?: string;
  attributes?: string[];
}

/* Plan 285 — the poll now answers RevisionsState + drift. */
const emptyPoll = () => ({
  bookId,
  fileId: null,
  rev: 0,
  pending: [],
  dismissed: [],
  acceptedSelections: {},
  timeline: {},
  drift: [],
});

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-revisions-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  /* Sequential, not `Promise.all` — this file carries a hoisted async-factory
     `vi.mock` (revisions-store.js, plan 285), which a `Promise.all` of dynamic
     imports races (#2083). */
  const { revisionsRouter, revisionsBulkRouter } = await import('./revisions.js');
  const { makeBookId } = await import('../workspace/paths.js');
  bookId = makeBookId(AUTHOR, SERIES, TITLE);

  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  audioRoot = join(bookDir, 'audio');
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  mkdirSync(audioRoot, { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.md'), '# Chapter One\nbody.');

  app = express();
  app.use(express.json());
  app.use('/api/books', revisionsRouter);
  app.use('/api', revisionsBulkRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(() => {
  // Reset state.json + audio dir between cases so chapter ids / segments
  // files don't leak across tests.
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: 'm_drift_test',
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.md',
      castConfirmed: true,
      chapters: [{ id: 1, title: 'Chapter One', slug: '01-chapter-one' }],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  for (const f of ['cast.json', 'revisions.json']) {
    const p = join(bookDir, '.audiobook', f);
    if (existsSync(p)) rmSync(p, { force: true });
  }
  rmSync(audioRoot, { recursive: true, force: true });
  mkdirSync(audioRoot, { recursive: true });
});

interface SeedOpts {
  /** Snapshot of the cast at synthesis time (lives in <slug>.segments.json). */
  snapshots: Record<string, CharacterSnapshot>;
  /** Current cast.json (what the user has now). */
  cast: Array<{
    id: string;
    tone?: { warmth?: number; pace?: number; authority?: number; emotion?: number };
    gender?: 'male' | 'female' | 'neutral';
    ageRange?: 'child' | 'teen' | 'adult' | 'elderly';
    voiceId?: string;
    attributes?: string[];
    ttsEngine?: string;
    overrideTtsVoices?: Record<string, { name: string }>;
  }>;
  dismissed?: string[];
  /** Override the default single-segment fixture (per-line voice stamps). */
  segments?: Array<Record<string, unknown>>;
}

function seed({ snapshots, cast, dismissed, segments }: SeedOpts): void {
  writeFileSync(
    join(audioRoot, '01-chapter-one.segments.json'),
    JSON.stringify({
      bookId,
      chapterId: 1,
      chapterTitle: 'Chapter One',
      durationSec: 12,
      sampleRate: 24000,
      modelKey: 'coqui-xtts-v2',
      synthesizedAt: '2026-01-01T12:00:00.000Z',
      segments: segments ?? [
        {
          groupIndex: 0,
          characterId: Object.keys(snapshots)[0] ?? 'narrator',
          sentenceIds: [1],
          startSec: 0,
          endSec: 12,
        },
      ],
      characterSnapshots: snapshots,
    }),
  );
  writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify({ characters: cast }));
  if (dismissed) {
    writeFileSync(join(bookDir, '.audiobook', 'revisions.json'), JSON.stringify({ dismissed }));
  }
}

describe('GET /api/books/:bookId/revisions — basic shape', () => {
  it('returns empty pending + drift when there is no cast yet', async () => {
    const res = await request(app).get(`/api/books/${bookId}/revisions`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(emptyPoll());
  });

  it('returns empty drift when no segments files exist', async () => {
    writeFileSync(
      join(bookDir, '.audiobook', 'cast.json'),
      JSON.stringify({
        characters: [{ id: 'eliza', voiceId: 'v1' }],
      }),
    );
    const res = await request(app).get(`/api/books/${bookId}/revisions`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(emptyPoll());
  });

  it('returns empty drift when current cast matches every snapshot exactly', async () => {
    seed({
      snapshots: { eliza: { voiceId: 'v1', voiceEngine: 'coqui', tone: { warmth: 60, pace: 50 } } },
      cast: [{ id: 'eliza', voiceId: 'v1', tone: { warmth: 60, pace: 50 } }],
    });
    const res = await request(app).get(`/api/books/${bookId}/revisions`);
    expect(res.status).toBe(200);
    expect(res.body.drift).toEqual([]);
  });

  it('404s when the book does not exist', async () => {
    const res = await request(app).get('/api/books/nope__nope__nope/revisions');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/books/:bookId/revisions — hard-signal drift (always severe)', () => {
  it('emits a severe voice drift with a stable id when voiceId changes', async () => {
    seed({
      snapshots: { eliza: { voiceId: 'old', voiceEngine: 'coqui' } },
      cast: [{ id: 'eliza', voiceId: 'new' }],
    });
    const res = await request(app).get(`/api/books/${bookId}/revisions`);
    expect(res.status).toBe(200);
    const drift = res.body.drift as DriftEventOut[];
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({
      id: `drift:${bookId}:1:eliza:voice`,
      bookId,
      severity: 'severe',
      factor: 'voice',
      characterId: 'eliza',
      chapterId: 1,
    });
  });

  it('emits separate drift events for gender and ageRange changes', async () => {
    seed({
      snapshots: { eliza: { gender: 'female', ageRange: 'adult' } },
      cast: [{ id: 'eliza', gender: 'male', ageRange: 'elderly' }],
    });
    const res = await request(app).get(`/api/books/${bookId}/revisions`);
    expect(res.status).toBe(200);
    const drift = res.body.drift as DriftEventOut[];
    const factors = drift.map((d) => d.factor).sort();
    expect(factors).toEqual(['ageRange', 'gender']);
    expect(drift.every((d) => d.severity === 'severe')).toBe(true);
  });

  it('does not emit drift when a snapshot field is missing on one side', async () => {
    /* No gender in snapshot — synthesis ran before that field was captured.
       Can't fairly diff, so the detector stays quiet. */
    seed({
      snapshots: { eliza: { voiceId: 'v1' } }, // gender absent
      cast: [{ id: 'eliza', voiceId: 'v1', gender: 'female' }], // gender present
    });
    const res = await request(app).get(`/api/books/${bookId}/revisions`);
    expect(res.status).toBe(200);
    expect(res.body.drift).toEqual([]);
  });
});

describe('GET /api/books/:bookId/revisions — tone-metric thresholds', () => {
  it('emits no drift when tone delta is below 25', async () => {
    seed({
      snapshots: { eliza: { tone: { warmth: 50 } } },
      cast: [{ id: 'eliza', tone: { warmth: 70 } }], // delta 20
    });
    const res = await request(app).get(`/api/books/${bookId}/revisions`);
    expect(res.body.drift).toEqual([]);
  });

  it('emits moderate drift when delta is 25-39', async () => {
    seed({
      snapshots: { eliza: { tone: { pace: 40 } } },
      cast: [{ id: 'eliza', tone: { pace: 70 } }], // delta 30
    });
    const res = await request(app).get(`/api/books/${bookId}/revisions`);
    const drift = res.body.drift as DriftEventOut[];
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ severity: 'moderate', factor: 'pace' });
  });

  it('emits severe drift when delta is ≥ 40', async () => {
    seed({
      snapshots: { eliza: { tone: { authority: 20 } } },
      cast: [{ id: 'eliza', tone: { authority: 70 } }], // delta 50
    });
    const res = await request(app).get(`/api/books/${bookId}/revisions`);
    const drift = res.body.drift as DriftEventOut[];
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ severity: 'severe', factor: 'authority' });
  });

  it('emits one drift event per tone key when several have drifted', async () => {
    seed({
      snapshots: { eliza: { tone: { warmth: 30, pace: 30, emotion: 30 } } },
      cast: [{ id: 'eliza', tone: { warmth: 60, pace: 80, emotion: 30 } }], // 30, 50, 0
    });
    const res = await request(app).get(`/api/books/${bookId}/revisions`);
    const drift = res.body.drift as DriftEventOut[];
    const factors = drift.map((d) => d.factor).sort();
    expect(factors).toEqual(['pace', 'warmth']); // emotion delta=0, no event
  });
});

describe('GET /api/books/:bookId/revisions — attribute drift (set-symmetric-difference)', () => {
  it('emits a moderate drift event when an attribute is added since synthesis', async () => {
    /* This is the library-cast override case: a future book pushes its
       richer profile (eccentric, reassuring, humorous) back onto the
       novella's library record. The novella's already-rendered audio
       was bound to a leaner attribute set; we want the drift report to
       surface that change so the user can decide whether to regenerate. */
    seed({
      snapshots: { oduvan: { attributes: ['kind'] } },
      cast: [{ id: 'oduvan', attributes: ['eccentric', 'kind', 'reassuring'] }],
    });
    const res = await request(app).get(`/api/books/${bookId}/revisions`);
    expect(res.status).toBe(200);
    const drift = res.body.drift as DriftEventOut[];
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({
      id: `drift:${bookId}:1:oduvan:attributes`,
      bookId,
      severity: 'moderate',
      factor: 'attributes',
      characterId: 'oduvan',
      chapterId: 1,
    });
    expect(drift[0]).toHaveProperty('description');
    /* The description names the added attributes verbatim so the user can
       judge whether the change matters for audio. */
    expect((drift[0] as unknown as { description: string }).description).toMatch(/eccentric/);
    expect((drift[0] as unknown as { description: string }).description).toMatch(/reassuring/);
  });

  it('emits a moderate drift event when an attribute is removed since synthesis', async () => {
    seed({
      snapshots: { oduvan: { attributes: ['eccentric', 'kind', 'reassuring'] } },
      cast: [{ id: 'oduvan', attributes: ['kind'] }],
    });
    const res = await request(app).get(`/api/books/${bookId}/revisions`);
    const drift = res.body.drift as DriftEventOut[];
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ severity: 'moderate', factor: 'attributes' });
    expect((drift[0] as unknown as { description: string }).description).toMatch(/eccentric/);
    expect((drift[0] as unknown as { description: string }).description).toMatch(/reassuring/);
  });

  it('does not emit drift when the only difference is attribute order', async () => {
    /* Stable comparison: order is a normalisation artefact, not a real
       drift signal. */
    seed({
      snapshots: { oduvan: { attributes: ['eccentric', 'kind', 'reassuring'] } },
      cast: [{ id: 'oduvan', attributes: ['reassuring', 'eccentric', 'kind'] }],
    });
    const res = await request(app).get(`/api/books/${bookId}/revisions`);
    expect(res.body.drift).toEqual([]);
  });

  it('does not emit drift when the only difference is letter case', async () => {
    /* Case-insensitive set comparison — the analyzer doesn't always
       normalise casing, and the drift report would look noisy otherwise. */
    seed({
      snapshots: { oduvan: { attributes: ['Kind'] } },
      cast: [{ id: 'oduvan', attributes: ['kind'] }],
    });
    const res = await request(app).get(`/api/books/${bookId}/revisions`);
    expect(res.body.drift).toEqual([]);
  });

  it('does not emit drift when either side is missing an attributes field', async () => {
    /* Older segments file (pre-attributes-snapshot) → no signal to compare
       against. Detector stays quiet rather than treating "added everything"
       as drift on every previously-rendered character. */
    seed({
      snapshots: { oduvan: { voiceId: 'v1' } }, // no attributes captured
      cast: [{ id: 'oduvan', voiceId: 'v1', attributes: ['kind'] }],
    });
    const res = await request(app).get(`/api/books/${bookId}/revisions`);
    expect(res.body.drift).toEqual([]);
  });

  it('respects the dismissed filter for the attribute factor', async () => {
    seed({
      snapshots: { oduvan: { attributes: ['kind'] } },
      cast: [{ id: 'oduvan', attributes: ['eccentric', 'kind'] }],
      dismissed: [`drift:${bookId}:1:oduvan:attributes`],
    });
    const res = await request(app).get(`/api/books/${bookId}/revisions`);
    expect(res.body.drift).toEqual([]);
  });
});

describe('GET /api/books/:bookId/revisions — autoQueueable flag (plan 20 C1+C2)', () => {
  it('marks severe hard-signal drift events as autoQueueable=true', async () => {
    seed({
      snapshots: { eliza: { voiceId: 'old' } },
      cast: [{ id: 'eliza', voiceId: 'new' }],
    });
    const res = await request(app).get(`/api/books/${bookId}/revisions`);
    const drift = res.body.drift as DriftEventOut[];
    expect(drift).toHaveLength(1);
    expect(drift[0].severity).toBe('severe');
    expect(drift[0].autoQueueable).toBe(true);
  });

  it('marks severe tone drift (≥40 delta) as autoQueueable=true', async () => {
    seed({
      snapshots: { eliza: { tone: { authority: 20 } } },
      cast: [{ id: 'eliza', tone: { authority: 70 } }], // delta 50
    });
    const res = await request(app).get(`/api/books/${bookId}/revisions`);
    const drift = res.body.drift as DriftEventOut[];
    expect(drift).toHaveLength(1);
    expect(drift[0].severity).toBe('severe');
    expect(drift[0].autoQueueable).toBe(true);
  });

  it('leaves moderate tone drift (25-39) without the autoQueueable flag', async () => {
    seed({
      snapshots: { eliza: { tone: { pace: 40 } } },
      cast: [{ id: 'eliza', tone: { pace: 70 } }], // delta 30
    });
    const res = await request(app).get(`/api/books/${bookId}/revisions`);
    const drift = res.body.drift as DriftEventOut[];
    expect(drift).toHaveLength(1);
    expect(drift[0].severity).toBe('moderate');
    expect(drift[0].autoQueueable).toBeUndefined();
  });

  it('leaves moderate attribute drift without the autoQueueable flag', async () => {
    /* Attribute drift is always moderate (existing audio remains bound to
       the recorded voiceId; the override just changes prebuilt-voice
       selection on future regenerations). One-click auto-queue isn't
       warranted — the user should look at the diff first. */
    seed({
      snapshots: { oduvan: { attributes: ['kind'] } },
      cast: [{ id: 'oduvan', attributes: ['eccentric', 'kind'] }],
    });
    const res = await request(app).get(`/api/books/${bookId}/revisions`);
    const drift = res.body.drift as DriftEventOut[];
    expect(drift).toHaveLength(1);
    expect(drift[0].severity).toBe('moderate');
    expect(drift[0].autoQueueable).toBeUndefined();
  });
});

describe('GET /api/books/:bookId/revisions — comparison payload (plan: drift-report-fidelity)', () => {
  it('embeds chapterTitle on every emitted drift event', async () => {
    seed({
      snapshots: { eliza: { voiceId: 'old' } },
      cast: [{ id: 'eliza', voiceId: 'new' }],
    });
    const res = await request(app).get(`/api/books/${bookId}/revisions`);
    const drift = res.body.drift as DriftEventOut[];
    expect(drift).toHaveLength(1);
    /* Title pulled from segments.json#chapterTitle ("Chapter One"). The seed
       writes that key, so we should NOT see the "Chapter N" fallback. */
    expect(drift[0].chapterTitle).toBe('Chapter One');
  });

  it('falls back to the chapter-scan title when segments.json omits chapterTitle', async () => {
    /* Simulate an older segments file that pre-dates the chapterTitle field.
       Detector should fall back to state.chapters[].title, not "Chapter N". */
    writeFileSync(
      join(audioRoot, '01-chapter-one.segments.json'),
      JSON.stringify({
        bookId,
        chapterId: 1,
        durationSec: 12,
        sampleRate: 24000,
        modelKey: 'coqui-xtts-v2',
        synthesizedAt: '2026-01-01T12:00:00.000Z',
        segments: [
          { groupIndex: 0, characterId: 'eliza', sentenceIds: [1], startSec: 0, endSec: 12 },
        ],
        characterSnapshots: { eliza: { voiceId: 'old' } },
      }),
    );
    writeFileSync(
      join(bookDir, '.audiobook', 'cast.json'),
      JSON.stringify({ characters: [{ id: 'eliza', voiceId: 'new' }] }),
    );
    const res = await request(app).get(`/api/books/${bookId}/revisions`);
    const drift = res.body.drift as DriftEventOut[];
    expect(drift).toHaveLength(1);
    expect(drift[0].chapterTitle).toBe('Chapter One');
  });

  it('embeds before-snapshot and current cast profile on each hard-drift event', async () => {
    seed({
      snapshots: { eliza: { voiceId: 'old', gender: 'female', tone: { warmth: 60 } } },
      cast: [{ id: 'eliza', voiceId: 'new', gender: 'female', tone: { warmth: 60 } }],
    });
    const res = await request(app).get(`/api/books/${bookId}/revisions`);
    const drift = res.body.drift as DriftEventOut[];
    expect(drift).toHaveLength(1);
    /* `snapshot` mirrors the pre-render CharacterSnapshot; `current` mirrors
       the live cast entry. Both are needed so the modal renders a self-
       sufficient comparison card without re-querying the server. */
    expect(drift[0].snapshot).toMatchObject({ voiceId: 'old', gender: 'female' });
    expect(drift[0].current).toMatchObject({ voiceId: 'new', gender: 'female' });
  });

  it('embeds before-snapshot and current on tone-drift events', async () => {
    seed({
      snapshots: { eliza: { tone: { warmth: 30 } } },
      cast: [{ id: 'eliza', tone: { warmth: 70 } }], // delta 40 → severe
    });
    const res = await request(app).get(`/api/books/${bookId}/revisions`);
    const drift = res.body.drift as DriftEventOut[];
    expect(drift).toHaveLength(1);
    expect(drift[0].snapshot?.tone?.warmth).toBe(30);
    expect(drift[0].current?.tone?.warmth).toBe(70);
  });

  it('embeds before-snapshot and current on attribute-drift events', async () => {
    seed({
      snapshots: { oduvan: { attributes: ['kind'] } },
      cast: [{ id: 'oduvan', attributes: ['eccentric', 'kind'] }],
    });
    const res = await request(app).get(`/api/books/${bookId}/revisions`);
    const drift = res.body.drift as DriftEventOut[];
    expect(drift).toHaveLength(1);
    expect(drift[0].snapshot?.attributes).toEqual(['kind']);
    expect(drift[0].current?.attributes).toEqual(['eccentric', 'kind']);
  });
});

describe('GET /api/books/:bookId/revisions — dismissed filter', () => {
  it('drops a drift event whose id is in revisions.json#dismissed', async () => {
    seed({
      snapshots: { eliza: { voiceId: 'old' } },
      cast: [{ id: 'eliza', voiceId: 'new' }],
      dismissed: [`drift:${bookId}:1:eliza:voice`],
    });
    const res = await request(app).get(`/api/books/${bookId}/revisions`);
    expect(res.body.drift).toEqual([]);
  });

  it('still surfaces other drift events when only one is dismissed', async () => {
    seed({
      snapshots: { eliza: { voiceId: 'old', gender: 'female' } },
      cast: [{ id: 'eliza', voiceId: 'new', gender: 'male' }],
      dismissed: [`drift:${bookId}:1:eliza:voice`],
    });
    const res = await request(app).get(`/api/books/${bookId}/revisions`);
    const factors = (res.body.drift as DriftEventOut[]).map((d) => d.factor);
    expect(factors).toEqual(['gender']);
  });
});
describe('GET /api/books/:bookId/revisions — pending read through the store (plan 285)', () => {
  const revisionsPath = () => join(bookDir, '.audiobook', 'revisions.json');
  const serverEntry = {
    id: 'revision:1:1000',
    chapterId: 1,
    characterId: 'eliza',
    playable: true,
    hasPreviousAudio: true,
    segments: [],
    origin: 'server',
  };
  /* A legacy entry on a chapter with no slug in state.json — normalisation
     drops it (no .previous can exist). */
  const staleLegacy = { id: 'rev-stale', chapterId: 2, characterId: 'x', segments: [] };
  const matchingCast = () =>
    seed({ snapshots: { eliza: { voiceId: 'v1' } }, cast: [{ id: 'eliza', voiceId: 'v1' }] });

  it('returns pending even when the cast is EMPTY (D8)', async () => {
    writeFileSync(revisionsPath(), JSON.stringify({ schema: 1, fileId: 'f-1', rev: 2, pending: [serverEntry] }));
    const res = await request(app).get(`/api/books/${bookId}/revisions`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ bookId, fileId: 'f-1', rev: 2, pending: [serverEntry], drift: [] });
  });

  it('surfaces a legacy entry only while its .previous.mp3 exists', async () => {
    seed({ snapshots: { eliza: { voiceId: 'old' } }, cast: [{ id: 'eliza', voiceId: 'new' }] });
    const legacy = { id: 'rev-1', chapterId: 1, characterId: 'x', segments: [] };
    writeFileSync(revisionsPath(), JSON.stringify({ pending: [legacy] }));
    let res = await request(app).get(`/api/books/${bookId}/revisions`);
    expect(res.body.pending).toEqual([]);
    writeFileSync(join(audioRoot, '01-chapter-one.previous.mp3'), 'PREV');
    res = await request(app).get(`/api/books/${bookId}/revisions`);
    expect(res.body.pending).toEqual([{ ...legacy, playable: true, hasPreviousAudio: true }]);
    expect((res.body.drift as DriftEventOut[]).map((d) => d.factor)).toEqual(['voice']);
  });

  it('falls back to [] when persisted pending is not an array', async () => {
    matchingCast();
    writeFileSync(revisionsPath(), JSON.stringify({ pending: 'garbage' }));
    const res = await request(app).get(`/api/books/${bookId}/revisions`);
    expect(res.status).toBe(200);
    expect(res.body.pending).toEqual([]);
    expect(res.body.drift).toEqual([]);
  });

  it('a corrupt revisions.json answers 500, as on main', async () => {
    matchingCast();
    writeFileSync(revisionsPath(), '{"pending": [');
    const res = await request(app).get(`/api/books/${bookId}/revisions`);
    expect(res.status).toBe(500);
  });

  it('bulk GET /api/revisions answers exactly { pending, drift } per book, pending normalised', async () => {
    matchingCast();
    writeFileSync(
      revisionsPath(),
      JSON.stringify({ schema: 1, fileId: 'f-1', rev: 2, pending: [serverEntry, staleLegacy] }),
    );
    const res = await request(app).get(`/api/revisions?bookIds=${bookId}`);
    expect(res.status).toBe(200);
    expect(res.body.byBookId[bookId]).toEqual({ pending: [serverEntry], drift: [] });
  });

  it('a lock timeout answers the curated 500 on the single poll and a fixed per-book error on the bulk poll', async () => {
    const store = await import('../workspace/revisions-store.js');
    const { LockAcquisitionTimeoutError, LOCK_CONTENTION_REQUEST_ERROR } = await import('../workspace/file-lock.js');
    const err = () => new LockAcquisitionTimeoutError('revisions:C:/SECRET-WORKSPACE/book', 10_000);
    vi.mocked(store.readRevisions).mockRejectedValueOnce(err());
    const single = await request(app).get(`/api/books/${bookId}/revisions`);
    expect(single.status).toBe(500);
    expect(single.body).toEqual({ error: LOCK_CONTENTION_REQUEST_ERROR });
    vi.mocked(store.readRevisions).mockRejectedValueOnce(err());
    const bulk = await request(app).get(`/api/revisions?bookIds=${bookId}`);
    expect(bulk.status).toBe(200);
    expect(bulk.body.errors).toEqual({ [bookId]: "Couldn't read this book's review state." });
    expect(bulk.text).not.toContain('SECRET-WORKSPACE');
  });
});

describe('GET /api/revisions — per-book isolation (plan 286, D9)', () => {
  let goodId: string;
  let badId: string;
  beforeAll(async () => {
    const { makeBookId } = await import('../workspace/paths.js');
    for (const title of ['Bulk Good', 'Bulk Bad']) {
      const dir = join(workspaceRoot, 'books', 'Bulk Author', 'Standalones', title);
      mkdirSync(join(dir, '.audiobook'), { recursive: true });
      writeFileSync(join(dir, 'manuscript.txt'), 'x');
      const id = makeBookId('Bulk Author', 'Standalones', title);
      writeFileSync(
        join(dir, '.audiobook', 'state.json'),
        JSON.stringify({
          bookId: id,
          manuscriptId: `m_${title}`,
          title,
          author: 'Bulk Author',
          series: 'Standalones',
          seriesPosition: null,
          isStandalone: true,
          manuscriptFile: 'manuscript.txt',
          castConfirmed: true,
          chapters: [{ id: 1, title: 'One', slug: '01-one' }],
          coverGradient: ['#000', '#fff'],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      );
      if (title === 'Bulk Bad') writeFileSync(join(dir, '.audiobook', 'revisions.json'), '[]'); // non-object top level → store throws
      if (title === 'Bulk Good') goodId = id;
      else badId = id;
    }
  });
  it('returns the healthy books and lists the broken one in errors with a path-free sentence', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).get(`/api/revisions?bookIds=${goodId},${badId}`);
    err.mockRestore();
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.byBookId)).toEqual([goodId]);
    expect(res.body.errors).toEqual({ [badId]: "Couldn't read this book's review state." });
    expect(res.text).not.toContain(workspaceRoot);
  });
  it('omits errors when every book succeeds', async () => {
    const res = await request(app).get(`/api/revisions?bookIds=${goodId}`);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('errors');
  });
  it('a failure whose message embeds an absolute path never reaches the body', async () => {
    /* The '[]' fixture above throws a path-free SyntaxError, so it cannot prove
       path-freedom; this EPERM-style rejection embeds the path. readRevisions is
       already a vi.fn passthrough (the file's hoisted revisions-store mock). */
    const store = await import('../workspace/revisions-store.js');
    vi.mocked(store.readRevisions).mockRejectedValueOnce(
      Object.assign(new Error(`EPERM: operation not permitted, open '${join(workspaceRoot, 'books', 'SECRET', 'revisions.json')}'`), { code: 'EPERM' }),
    );
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).get(`/api/revisions?bookIds=${goodId}`);
    err.mockRestore();
    expect(res.status).toBe(200);
    expect(res.body.errors).toEqual({ [goodId]: "Couldn't read this book's review state." });
    expect(res.text).not.toContain(workspaceRoot);
    expect(res.text).not.toContain('SECRET');
  });
});


describe('GET .../revisions — engine + resolved-voice drift (plan 108 R5)', () => {
  it('fires both engine drift AND voice drift when a character moves to a new engine + designed voice', async () => {
    seed({
      snapshots: {
        maerin: { voiceId: 'lib-maerin', voiceEngine: 'kokoro', resolvedVoiceName: 'af_bella' },
      },
      cast: [
        {
          id: 'maerin',
          voiceId: 'lib-maerin',
          ttsEngine: 'qwen',
          overrideTtsVoices: { qwen: { name: 'maerin-designed' } },
        },
      ],
    });
    const res = await request(app).get(`/api/books/${bookId}/revisions`);
    expect(res.status).toBe(200);
    const drift = res.body.drift as DriftEventOut[];
    const engineEvent = drift.find((d) => d.factor === 'engine');
    const voiceEvent = drift.find((d) => d.factor === 'voice');
    // Engine changed kokoro -> qwen.
    expect(engineEvent, 'expected an engine drift event').toBeTruthy();
    expect(engineEvent!.severity).toBe('severe');
    // Resolved voice name changed af_bella -> maerin-designed (the qwen override).
    expect(voiceEvent, 'expected a voice drift event').toBeTruthy();
    expect(voiceEvent!.severity).toBe('severe');
  });

  it('catches an override-ONLY voice change (same voiceId) via resolvedVoiceName, with no engine drift', async () => {
    seed({
      snapshots: {
        maerin: { voiceId: 'lib-maerin', voiceEngine: 'kokoro', resolvedVoiceName: 'af_bella' },
      },
      // voiceId unchanged; only the per-engine override flipped af_bella -> af_nicole.
      cast: [
        { id: 'maerin', voiceId: 'lib-maerin', overrideTtsVoices: { kokoro: { name: 'af_nicole' } } },
      ],
    });
    const res = await request(app).get(`/api/books/${bookId}/revisions`);
    const drift = res.body.drift as DriftEventOut[];
    const voiceEvent = drift.find((d) => d.factor === 'voice');
    expect(voiceEvent, 'override-only change must still fire voice drift').toBeTruthy();
    // Engine unchanged (still kokoro) → no engine drift.
    expect(drift.find((d) => d.factor === 'engine')).toBeFalsy();
  });

  it('pre-108 snapshot (no resolvedVoiceName) falls back to the voiceId comparison', async () => {
    seed({
      // No resolvedVoiceName — legacy segment. Same voiceId → no voice drift.
      snapshots: { maerin: { voiceId: 'lib-maerin', voiceEngine: 'kokoro' } },
      cast: [{ id: 'maerin', voiceId: 'lib-maerin' }],
    });
    const res = await request(app).get(`/api/books/${bookId}/revisions`);
    expect(res.body.drift).toEqual([]);
  });
});

/* #3362 (owner design C) — voice drift is derived PER LINE from the segments'
   own `voiceName`/`baseVoiceName` stamps, not from the per-character snapshot's
   single last-wins `resolvedVoiceName`. A voice change followed by a re-record
   of only SOME lines leaves the snapshot on the new voice while the rest of the
   chapter is still in the old one; the snapshot alone reads that as "up to
   date". */
describe('GET .../revisions — per-line voice drift from segments (#3362)', () => {
  const kokoroCast = [
    { id: 'mairin', voiceId: 'lib-mairin', overrideTtsVoices: { kokoro: { name: 'af_nicole' } } },
  ];
  const line = (i: number, voice: string | undefined, extra: Record<string, unknown> = {}) => ({
    groupIndex: i,
    characterId: 'mairin',
    sentenceIds: [i],
    ...(voice ? { voiceName: voice, baseVoiceName: voice } : {}),
    ...extra,
  });

  it('flags a character whose voice changed when only line 11 of 12 was re-recorded (snapshot says new voice)', async () => {
    seed({
      // Last-wins snapshot: line 11 (the last) was re-recorded in the NEW voice.
      snapshots: { mairin: { voiceId: 'lib-mairin', voiceEngine: 'kokoro', resolvedVoiceName: 'af_nicole' } },
      cast: kokoroCast,
      segments: Array.from({ length: 12 }, (_, i) => line(i, i === 11 ? 'af_nicole' : 'af_bella')),
    });
    const res = await request(app).get(`/api/books/${bookId}/revisions`);
    const voiceEvent = (res.body.drift as DriftEventOut[]).find((d) => d.factor === 'voice');
    expect(voiceEvent, 'mixed-voice chapter must still read as drifted').toBeTruthy();
    // The card shows the stale voice, not the snapshot's new one.
    expect(voiceEvent!.snapshot?.resolvedVoiceName).toBe('af_bella');
  });

  it('reports no drift once every line has been re-recorded in the current voice', async () => {
    seed({
      snapshots: { mairin: { voiceId: 'lib-mairin', voiceEngine: 'kokoro', resolvedVoiceName: 'af_nicole' } },
      cast: kokoroCast,
      segments: Array.from({ length: 12 }, (_, i) => line(i, 'af_nicole')),
    });
    const res = await request(app).get(`/api/books/${bookId}/revisions`);
    expect(res.body.drift).toEqual([]);
  });

  it('falls back to the snapshot for a legacy chapter whose segments carry no voice stamp', async () => {
    seed({
      snapshots: { mairin: { voiceId: 'lib-mairin', voiceEngine: 'kokoro', resolvedVoiceName: 'af_bella' } },
      cast: kokoroCast,
      segments: [line(0, undefined), line(1, undefined)],
    });
    const stale = await request(app).get(`/api/books/${bookId}/revisions`);
    expect((stale.body.drift as DriftEventOut[]).some((d) => d.factor === 'voice')).toBe(true);

    seed({
      snapshots: { mairin: { voiceId: 'lib-mairin', voiceEngine: 'kokoro', resolvedVoiceName: 'af_nicole' } },
      cast: kokoroCast,
      segments: [line(0, undefined), line(1, undefined)],
    });
    const current = await request(app).get(`/api/books/${bookId}/revisions`);
    expect(current.body.drift).toEqual([]);
  });

  it('does not count a Kokoro-fallback line as a voice change', async () => {
    seed({
      snapshots: { mairin: { voiceId: 'lib-mairin', voiceEngine: 'kokoro', resolvedVoiceName: 'af_nicole' } },
      cast: kokoroCast,
      segments: [line(0, 'af_nicole'), line(1, 'am_adam', { renderedFallbackEngine: 'kokoro' })],
    });
    const res = await request(app).get(`/api/books/${bookId}/revisions`);
    expect(res.body.drift).toEqual([]);
  });

  it("joins a line to its snapshot key by the stamped id, ignoring other characters' lines", async () => {
    seed({
      snapshots: {
        mairin: { voiceId: 'lib-mairin', voiceEngine: 'kokoro', resolvedVoiceName: 'af_nicole' },
      },
      cast: kokoroCast,
      segments: [
        line(0, 'af_nicole'),
        // Drift-spelled raw id, stamped canonical: belongs to `mairin`, stale voice.
        { ...line(1, 'af_bella'), characterId: 'ma-irin', resolvedCharacterId: 'mairin' },
        // Someone else's line in a different voice must not count against `mairin`.
        { ...line(2, 'am_adam'), characterId: 'narrator' },
      ],
    });
    const res = await request(app).get(`/api/books/${bookId}/revisions`);
    const events = (res.body.drift as DriftEventOut[]).filter((d) => d.factor === 'voice');
    expect(events).toHaveLength(1);
    expect(events[0].snapshot?.resolvedVoiceName).toBe('af_bella');
  });
});

describe('GET .../revisions — resolves a snapshot keyed by a SUPERSEDED characterId (#2040)', () => {
  it('finds the renamed character via the real cast-id-history.json and still emits its drift, instead of silently `continue`-ing as "removed from cast"', async () => {
    /* `retireCharacterId` is the real writer (store/cast-id-history.ts) — not
       a hand-rolled JSON fixture — so this exercises the same on-disk shape
       production retirement actually produces. */
    await retireCharacterId(bookDir, 'old-eliza', 'eliza');
    seed({
      // The chapter was rendered under the OLD id; the cast has since been
      // renamed to 'eliza' via retireCharacterId above. Without resolving
      // through the history, `castById.get('old-eliza')` (pre-#2040) or a
      // resolver built on the default `{}` history finds nothing, and the
      // route's `if (!current) continue;` silently drops this snapshot —
      // the character's real voiceId drift never surfaces.
      snapshots: { 'old-eliza': { voiceId: 'old' } },
      cast: [{ id: 'eliza', voiceId: 'new' }],
    });
    const res = await request(app).get(`/api/books/${bookId}/revisions`);
    expect(res.status).toBe(200);
    const drift = res.body.drift as DriftEventOut[];
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({
      // The RAW snapshot key is preserved on the event (existing contract —
      // see synthesise-chapter.orphan-alias.test.ts's identical note), even
      // though resolution happened through the history to find `current`.
      id: `drift:${bookId}:1:old-eliza:voice`,
      characterId: 'old-eliza',
      factor: 'voice',
      severity: 'severe',
    });
    // The drift compares against the RESOLVED live cast row, not a blank —
    // proving `current` really is the 'eliza' cast entry, not a fallback.
    expect(drift[0].current).toMatchObject({ voiceId: 'new' });
  });
});
