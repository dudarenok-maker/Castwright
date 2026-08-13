import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBookLanguage, loadMeasurementInputs, resolveAttributionState } from './attribution-health-io.js';
import { putManuscript, removeManuscript, type ManuscriptRecord } from './manuscripts.js';
import { saveAnalysisCache, clearAnalysisCache } from './analysis-cache.js';
import { writeAnalysisState } from './analysis-state.js';
import type { SentenceOutput } from '../handoff/schemas.js';

/* #1984 Task 2 — resolveBookLanguage. state.json's `language` field must be
   read RAW: the in-tree accessor `bookStateLanguage` defaults an absent
   value to 'en', which would make detection (step 2) never run at all for
   the 7 live books with no declared language (R-5M3). */

const dirs: string[] = [];

function dirWith(stateFields: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'attribution-health-io-'));
  dirs.push(dir);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(join(dir, '.audiobook', 'state.json'), JSON.stringify(stateFields), 'utf8');
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A real (long, unambiguous) Russian chapter body — well over the 150-word
// front-matter floor so selectBodyChapters keeps it in the voting pool.
const RU_SENTENCE =
  'Егор засунул руки в карманы и пошёл вдоль тёмной улицы, мимо закрытых лавок и молчаливых окон. ';
const russianChapters = [{ id: 1, title: 'Глава первая', body: RU_SENTENCE.repeat(40) }];

describe('resolveBookLanguage', () => {
  it('reads state.language raw, and does NOT default an absent one to en', async () => {
    const declared = await resolveBookLanguage(dirWith({ language: 'ru' }), russianChapters);
    expect(declared).toEqual({ language: 'ru', languageSource: 'declared' });

    const undeclared = await resolveBookLanguage(dirWith({}), russianChapters);
    expect(undeclared.languageSource).toBe('detected'); // NOT 'declared'
    expect(undeclared.language).toBe('ru'); // NOT 'en'
  });

  it('a missing state.json is treated the same as an absent language field', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'attribution-health-io-'));
    dirs.push(dir); // no .audiobook/state.json written at all
    const r = await resolveBookLanguage(dir, russianChapters);
    expect(r).toEqual({ language: 'ru', languageSource: 'detected' });
  });

  it('a declared language wins even when the body would detect as something else', async () => {
    const r = await resolveBookLanguage(dirWith({ language: 'en' }), russianChapters);
    expect(r).toEqual({ language: 'en', languageSource: 'declared' });
  });

  // #2246 — this spec CONSUMES DetectionResult.fallback; a regression in it
  // is a regression here. Both surrender branches must resolve 'unknown',
  // never a confidently-wrong 'en'.
  it('a sample with no letters at all (pure punctuation/numerals) surrenders to unknown, not en', async () => {
    const numerals = [{ id: 1, title: 'Chapter', body: '1234 5678 91011 -- ... !!! '.repeat(20) }];
    const r = await resolveBookLanguage(dirWith({}), numerals);
    expect(r).toEqual({ language: null, languageSource: 'unknown' });
  });

  it('franc finding no Latin match also surrenders to unknown, not en', async () => {
    // Short, ambiguous, punctuation-heavy text starves franc below its
    // confidence floor — the exact fixture detect-language.test.ts uses for
    // the same surrender branch. A single short candidate chapter fails
    // selectBodyChapters's 150-word floor, so detectManuscriptLanguageFromChapters
    // falls back to the full (one-chapter) list rather than an empty one.
    const ambiguous = [{ id: 1, title: 'Chapter', body: '. . . ? ! -- ok yes no' }];
    const r = await resolveBookLanguage(dirWith({}), ambiguous);
    expect(r).toEqual({ language: null, languageSource: 'unknown' });
  });
});

/* #1984 Task 7 — loadMeasurementInputs / resolveAttributionState. The nine-
   row fixture table (spec §Testing), adapted to Wave 1's three shipped
   states (ok / missing / unmeasurable — 4d/5/6 are Wave 2, no threshold
   exists yet). */

let bookCounter = 0;
const manuscriptIdsToClean: string[] = [];

const RU_NARRATION =
  'Она шла вдоль дороги и думала о доме, о запахе хлеба и о тишине вечера, пока не стемнело. ';
const RU_DIALOGUE_BODY = '— Ничего нет, — сказал Егор.\n— Значит, ищем дальше.\n';

interface BuildBookOpts {
  language?: string;
  castCharacters?: Array<{ id: string; name: string; role: string; color: string }>;
  chapters?: Array<{ id: number; title: string; body: string; excluded?: boolean }>;
  cacheChapters?: Record<number, SentenceOutput[]>;
  skipManuscript?: boolean;
  skipCache?: boolean;
}

async function buildBook(opts: BuildBookOpts): Promise<{ bookDir: string; manuscriptId: string }> {
  bookCounter += 1;
  const manuscriptId = `test-1984-io-${Date.now()}-${bookCounter}`;
  const bookDir = mkdtempSync(join(tmpdir(), 'attribution-health-io-book-'));
  dirs.push(bookDir);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });

  const chapters = opts.chapters ?? [];
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: 'test-book',
      manuscriptId,
      title: 'Test Book',
      author: 'Test Author',
      series: '',
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.md',
      castConfirmed: true,
      chapters: chapters.map((c) => ({
        id: c.id,
        title: c.title,
        slug: `ch-${c.id}`,
        excluded: c.excluded,
      })),
      ...(opts.language !== undefined ? { language: opts.language } : {}),
    }),
    'utf8',
  );
  writeFileSync(
    join(bookDir, '.audiobook', 'cast.json'),
    JSON.stringify({ characters: opts.castCharacters ?? [] }),
    'utf8',
  );

  if (!opts.skipManuscript) {
    const record: ManuscriptRecord = {
      manuscriptId,
      format: 'markdown',
      title: 'Test Book',
      wordCount: 1000,
      byteSize: 1000,
      uploadedAt: new Date().toISOString(),
      sourceText: chapters.map((c) => c.body).join('\n\n'),
      chapterHints: chapters.map((c) => ({ id: c.id, title: c.title, body: c.body, excluded: c.excluded })),
      bookId: 'test-book',
      bookDir,
    };
    putManuscript(record);
    manuscriptIdsToClean.push(manuscriptId);
  }

  if (!opts.skipCache) {
    await saveAnalysisCache(manuscriptId, { chapters: opts.cacheChapters ?? {} });
    manuscriptIdsToClean.push(manuscriptId);
  }

  return { bookDir, manuscriptId };
}

afterEach(async () => {
  for (const id of manuscriptIdsToClean.splice(0)) {
    removeManuscript(id);
    await clearAnalysisCache(id);
  }
});

let nextSentId = 1;
const s = (characterId: string, text: string, chapterId = 1): SentenceOutput =>
  ({ id: nextSentId++, chapterId, characterId, text }) as SentenceOutput;

describe('loadMeasurementInputs', () => {
  it('reports cacheCorrupt (not a throw) for a malformed cache — the load fails, not the metric', async () => {
    const { bookDir, manuscriptId } = await buildBook({
      language: 'ru',
      castCharacters: [{ id: 'narrator', name: 'Narrator', role: 'narrator', color: '#000' }],
      chapters: [{ id: 1, title: 'Ch1', body: RU_DIALOGUE_BODY }],
      skipCache: true,
    });
    // A malformed cache: chapters keyed by index-object rather than an array.
    const { cachePath } = await import('./analysis-cache.js');
    const fs = await import('node:fs/promises');
    await fs.mkdir(join(bookDir, '..'), { recursive: true }).catch(() => {});
    await fs.writeFile(cachePath(manuscriptId), JSON.stringify({ chapters: { 1: { bad: 'shape' } } }), 'utf8');
    manuscriptIdsToClean.push(manuscriptId);

    const inputs = await loadMeasurementInputs(bookDir);
    expect(inputs.cacheCorrupt).toBe(true);
  });

  it('drops excluded chapters from BOTH bodies and sentences', async () => {
    const { bookDir } = await buildBook({
      language: 'ru',
      castCharacters: [{ id: 'narrator', name: 'Narrator', role: 'narrator', color: '#000' }],
      chapters: [
        { id: 1, title: 'Ch1', body: RU_DIALOGUE_BODY },
        { id: 2, title: 'Ch2 (excluded)', body: RU_DIALOGUE_BODY, excluded: true },
      ],
      cacheChapters: { 1: [s('narrator', '— Ничего нет,')], 2: [s('narrator', '— Ничего нет,', 2)] },
    });
    const inputs = await loadMeasurementInputs(bookDir);
    expect(Object.keys(inputs.bodies)).toEqual(['1']);
    expect(inputs.sentences.every((sent) => sent.chapterId === 1)).toBe(true);
  });

  it('drops excludeFromSynthesis sentences but keeps the chapter body', async () => {
    const { bookDir } = await buildBook({
      language: 'ru',
      castCharacters: [{ id: 'narrator', name: 'Narrator', role: 'narrator', color: '#000' }],
      chapters: [{ id: 1, title: 'Ch1', body: RU_DIALOGUE_BODY }],
      cacheChapters: {
        1: [
          s('narrator', '— Ничего нет,'),
          { ...s('narrator', '— Значит,'), excludeFromSynthesis: true } as SentenceOutput,
        ],
      },
    });
    const inputs = await loadMeasurementInputs(bookDir);
    expect(inputs.bodies[1]).toBe(RU_DIALOGUE_BODY);
    expect(inputs.sentences).toHaveLength(1);
  });

  // #1984 Wave 1 review, finding 4 — cacheHasOriginFieldEvidence is the SOLE
  // switch between modelNarrator and unknownOriginNarrator in the pure
  // module, and had no direct test either direction (both "always true" and
  // "always false" mutants survived the suite). Tested here through the
  // public loadMeasurementInputs, which is the only way callers observe it.
  it('cacheHasOriginField is true when ANY sentence anywhere in the cache carries priorCharacterId (finding 4)', async () => {
    const { bookDir } = await buildBook({
      language: 'ru',
      castCharacters: [{ id: 'narrator', name: 'Narrator', role: 'narrator', color: '#000' }],
      chapters: [{ id: 1, title: 'Ch1', body: RU_DIALOGUE_BODY }],
      cacheChapters: {
        1: [
          s('narrator', '— Ничего нет,'),
          { ...s('egor', '— Значит,'), priorCharacterId: 'anton' } as SentenceOutput,
        ],
      },
    });
    const inputs = await loadMeasurementInputs(bookDir);
    expect(inputs.cacheHasOriginField).toBe(true);
  });

  it('cacheHasOriginField is false when no sentence anywhere in the cache carries priorCharacterId (finding 4)', async () => {
    const { bookDir } = await buildBook({
      language: 'ru',
      castCharacters: [{ id: 'narrator', name: 'Narrator', role: 'narrator', color: '#000' }],
      chapters: [{ id: 1, title: 'Ch1', body: RU_DIALOGUE_BODY }],
      cacheChapters: {
        1: [s('narrator', '— Ничего нет,'), s('egor', '— Значит,')],
      },
    });
    const inputs = await loadMeasurementInputs(bookDir);
    expect(inputs.cacheHasOriginField).toBe(false);
  });
});

describe('resolveAttributionState — the nine-row fixture table (Wave 1 states only)', () => {
  it('row 1: pure-narration non-fiction (castCount 0, spokenTotal 0, no analysis-state) -> ok', async () => {
    const { bookDir } = await buildBook({
      language: 'ru',
      castCharacters: [{ id: 'narrator', name: 'Narrator', role: 'narrator', color: '#000' }],
      chapters: [{ id: 1, title: 'Ch1', body: RU_NARRATION.repeat(3) }],
      cacheChapters: { 1: [s('narrator', RU_NARRATION.trim())] },
    });
    const r = await resolveAttributionState(bookDir);
    expect(r.state).toBe('ok');
  });

  it('row 2: cast built, narration present, no dialogue, run abandoned (absent analysis-state) -> missing', async () => {
    const { bookDir } = await buildBook({
      language: 'ru',
      castCharacters: [{ id: 'egor', name: 'Егор', role: 'Boy', color: '#111' }],
      chapters: [{ id: 1, title: 'Ch1', body: RU_NARRATION.repeat(3) }],
      cacheChapters: { 1: [s('narrator', RU_NARRATION.trim())] },
    });
    const r = await resolveAttributionState(bookDir);
    expect(r.state).toBe('missing');
  });

  it('row 3: cast built, nothing attributed, run PAUSED -> ok (the pill owns it)', async () => {
    const { bookDir, manuscriptId } = await buildBook({
      language: 'ru',
      castCharacters: [{ id: 'egor', name: 'Егор', role: 'Boy', color: '#111' }],
      chapters: [{ id: 1, title: 'Ch1', body: RU_NARRATION.repeat(3) }],
      cacheChapters: { 1: [s('narrator', RU_NARRATION.trim())] },
    });
    await writeAnalysisState(bookDir, {
      manuscriptId,
      phaseId: 1,
      phaseLabel: 'Attributing dialogue',
      phaseProgress: 0.4,
      state: 'paused',
      lastTickAt: Date.now(),
    });
    const r = await resolveAttributionState(bookDir);
    expect(r.state).toBe('ok');
  });

  it('row 4: book never analysed, no cache at all -> ok, reported "not analysed"', async () => {
    const { bookDir } = await buildBook({
      language: 'ru',
      castCharacters: [],
      chapters: [{ id: 1, title: 'Ch1', body: RU_DIALOGUE_BODY }],
      skipCache: true,
    });
    const r = await resolveAttributionState(bookDir);
    expect(r.state).toBe('ok');
    expect(r.reason).toBe('not analysed');
  });

  it('rows 5/6: a healthy book with real dialogue -> ok', async () => {
    const { bookDir } = await buildBook({
      language: 'ru',
      castCharacters: [
        { id: 'narrator', name: 'Narrator', role: 'narrator', color: '#000' },
        { id: 'egor', name: 'Егор', role: 'Boy', color: '#111' },
      ],
      chapters: [{ id: 1, title: 'Ch1', body: RU_DIALOGUE_BODY }],
      cacheChapters: {
        1: [s('egor', '— Ничего нет,'), s('narrator', '— сказал Егор.'), s('egor', '— Значит, ищем дальше.')],
      },
    });
    const r = await resolveAttributionState(bookDir);
    expect(r.state).toBe('ok');
    expect(r.measurement?.spokenTotal).toBeGreaterThan(0);
  });

  it('row 7: en-declared book whose text is not English -> unmeasurable (corroboration disagrees)', async () => {
    const { bookDir } = await buildBook({
      language: 'en',
      castCharacters: [{ id: 'egor', name: 'Egor', role: 'Boy', color: '#111' }],
      chapters: [{ id: 1, title: 'Ch1', body: RU_NARRATION.repeat(3) }],
      cacheChapters: { 1: [s('narrator', RU_NARRATION.repeat(3).trim())] },
    });
    const r = await resolveAttributionState(bookDir);
    expect(r.state).toBe('unmeasurable');
  });

  it('row 8: sentences present but unidentifiable (pure punctuation/numerals) -> unmeasurable', async () => {
    const { bookDir } = await buildBook({
      language: 'en',
      castCharacters: [{ id: 'egor', name: 'Egor', role: 'Boy', color: '#111' }],
      chapters: [{ id: 1, title: 'Ch1', body: '1234 5678 91011 -- ... !!! '.repeat(30) }],
      cacheChapters: { 1: [s('narrator', '1234 5678 91011 -- ... !!!'.repeat(30))] },
    });
    const r = await resolveAttributionState(bookDir);
    expect(r.state).toBe('unmeasurable');
  });

  it('row 9: cast built, cache holds ZERO sentences (Night Watch shape) -> missing, corroboration SKIPPED', async () => {
    // Same spokenTotal===0 (narration-only) body as row 2 — the discriminator
    // between the two rows is cacheHasSentences, not the body. Row 2 has a
    // narration sentence in the cache; row 9 (the Night Watch abandoned-run
    // shape) has literally none, so corroboration must not even run — it
    // would sample the empty string, surrender (letters === 0), and silently
    // downgrade this exact `missing` case to `unmeasurable` (spec R-7C2).
    const { bookDir } = await buildBook({
      language: 'ru',
      castCharacters: [{ id: 'egor', name: 'Егор', role: 'Boy', color: '#111' }],
      chapters: [{ id: 1, title: 'Ch1', body: RU_NARRATION.repeat(3) }],
      cacheChapters: { 1: [] }, // literally zero sentences — corroboration would surrender on an empty sample
    });
    const r = await resolveAttributionState(bookDir);
    expect(r.state).toBe('missing');
  });
});

describe('resolveAttributionState — the manuscript-absent row (D14 new producer)', () => {
  it('a cache exists but the manuscript record is gone -> unmeasurable, "no manuscript"', async () => {
    const { bookDir } = await buildBook({
      language: 'ru',
      castCharacters: [{ id: 'egor', name: 'Егор', role: 'Boy', color: '#111' }],
      chapters: [{ id: 1, title: 'Ch1', body: RU_DIALOGUE_BODY }],
      cacheChapters: { 1: [s('egor', '— Ничего нет,')] },
      skipManuscript: true, // findBookByManuscriptId will not find this test id in the real workspace
    });
    const r = await resolveAttributionState(bookDir);
    expect(r.state).toBe('unmeasurable');
    expect(r.reason).toBe('no manuscript');
  });
});
