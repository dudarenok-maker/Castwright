/* Integration tests for the revisions/drift detector.

   Covers:
     - Empty workspace → no segments → empty pending + drift.
     - Cast matches every snapshot → no drift.
     - voiceId change → severe drift event, factor 'voice', stable id.
     - Tone-metric delta thresholds: < 25 → nothing; 25-39 → moderate; ≥ 40 → severe.
     - Dismissed-id filter: an id present in revisions.json#dismissed never
       surfaces in the response, even when the underlying signal still holds.

   Workspace tempdir + supertest pattern matches book-state.reparse.test.ts. */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

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

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-revisions-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ revisionsRouter }, { makeBookId }] = await Promise.all([
    import('./revisions.js'),
    import('../workspace/paths.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, TITLE);

  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  audioRoot = join(bookDir, 'audio');
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  mkdirSync(audioRoot, { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.md'), '# Chapter One\nbody.');

  app = express();
  app.use(express.json());
  app.use('/api/books', revisionsRouter);
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
}

function seed({ snapshots, cast, dismissed }: SeedOpts): void {
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
      segments: [
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
    expect(res.body).toEqual({ pending: [], drift: [] });
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
    expect(res.body).toEqual({ pending: [], drift: [] });
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
