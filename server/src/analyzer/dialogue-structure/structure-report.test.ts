import { describe, expect, it } from 'vitest';
import { conventionsFor } from './lang/index.js';
import { assessParagraphStructure } from './structure-report.js';

const ru = conventionsFor('ru')!;

describe('structure-report — assessParagraphStructure', () => {
  it('clean chapter: no hidden dashes, low long-para share', () => {
    const body = [
      '— Привет, — сказал Антон.',
      '',
      'Он сел на стул.',
      '',
      '— Здравствуй, — ответила Ольга.',
    ].join('\n');
    const r = assessParagraphStructure(body, ru);
    expect(r.paragraphCount).toBe(3);
    expect(r.hiddenDashes).toBe(0);
    expect(r.hiddenFraction).toBe(0);
    expect(r.paraInitialDashes).toBe(2);
  });

  it('degraded chapter: dashes hidden inside narration-open paragraph are counted', () => {
    const mergedBlock =
      'Он вошёл. — Привет, — сказал Антон. Он сел. — Здравствуй, — ответила Ольга. Так продолжалось.';
    const body = ['Он вышел.', '', mergedBlock].join('\n');
    const r = assessParagraphStructure(body, ru);
    // the block does not open with a dash → its two turn dashes are hidden
    expect(r.paragraphCount).toBe(2);
    expect(r.paraInitialDashes).toBe(0);
    expect(r.hiddenDashes).toBeGreaterThanOrEqual(2);
    expect(r.hiddenTurnCandidates).toBeGreaterThanOrEqual(2);
    expect(r.hiddenFraction).toBeGreaterThan(0);
    expect(r.hiddenFraction).toBeLessThanOrEqual(1);
  });

  it('reports long-paragraph share and largest paragraph', () => {
    const longPara = 'Слово '.repeat(200); // >500 chars
    const body = ['— Привет.', '', longPara].join('\n');
    const r = assessParagraphStructure(body, ru);
    expect(r.largestParagraphChars).toBeGreaterThan(500);
    expect(r.pctCharsInLongParas).toBeGreaterThan(0);
  });
});