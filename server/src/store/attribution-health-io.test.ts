import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBookLanguage } from './attribution-health-io.js';

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
