import { describe, expect, it } from 'vitest';
import { buildNameIndex } from './name-matcher.js';
import { conventionsFor } from './lang/index.js';
import { parseChapterStructure } from './parser.js';
import { splitEvidencedInteriorTurns } from './paragraph-recovery.js';

const ru = conventionsFor('ru')!;
const idx = buildNameIndex([{ id: 'anton', name: 'Антон' }, { id: 'olga', name: 'Ольга' }], ru);
const spansOf = (paras: ReturnType<typeof parseChapterStructure>) => paras.flatMap((p) => p.spans);
const speechOf = (paras: ReturnType<typeof parseChapterStructure>) =>
  spansOf(paras).filter((s) => s.kind === 'speech');

describe('paragraph-recovery — splitEvidencedInteriorTurns (opt-in, conservative)', () => {
  it('splits a genuine interior turn that carries a verb tag', () => {
    const body = 'Он вошёл. — Привет, — сказал Антон.';
    const out = splitEvidencedInteriorTurns(body, idx);
    expect(out).toBe('Он вошёл.\n— Привет, — сказал Антон.');
  });

  it('does NOT split a narration tail prefixed by a dash (no tag → no evidence)', () => {
    const body = 'Выну… — Толик отличался запасливостью, выработанной за долгие годы.';
    const out = splitEvidencedInteriorTurns(body, idx);
    expect(out).toBe(body); // unchanged: no fabrication
  });

  it('does NOT split an apposition dash (no sentence end before it)', () => {
    const body = 'Сумрак — это не место, а состояние.';
    const out = splitEvidencedInteriorTurns(body, idx);
    expect(out).toBe(body);
  });

  it('is a no-op on already-dialogue lines (nothing hidden)', () => {
    const body = '— Привет, — сказал Антон. Он вошёл.';
    const out = splitEvidencedInteriorTurns(body, idx);
    expect(out).toBe(body);
  });

  it('recovery path surfaces the interior turn as a dialogue paragraph with speaker', () => {
    const body = 'Он вошёл. — Привет, — сказал Антон. Он сел.';
    const without = parseChapterStructure(body, idx);
    // default: the whole narration-open line stays one narration paragraph
    expect(without.map((p) => p.kind)).toEqual(['narration']);
    expect(spansOf(without).filter((s) => s.kind === 'speech')).toHaveLength(0);

    const withRecovery = parseChapterStructure(body, idx, { recoverMidParagraphTurns: true });
    const speech = speechOf(withRecovery);
    expect(speech).toHaveLength(1);
    expect(speech[0].speaker).toEqual({ characterId: 'anton', source: 'tag-name' });
  });

  it('does NOT fabricate a speech span from a narration tail even in recovery mode', () => {
    const body = 'Выну… — Толик отличался запасливостью за долгие годы. Он сел.';
    const paras = parseChapterStructure(body, idx, { recoverMidParagraphTurns: true });
    const speech = speechOf(paras);
    expect(speech).toHaveLength(0); // narration stays narration
    expect(paras[0].kind).toBe('narration');
  });

  it('recovers TWO interior turns when each carries a verb tag', () => {
    const body = 'Он вошёл. — Привет, — сказал Антон. — Здравствуй, — ответила Ольга. Он сел.';
    const paras = parseChapterStructure(body, idx, { recoverMidParagraphTurns: true });
    const speech = speechOf(paras);
    expect(speech).toHaveLength(2);
    expect(speech[0].speaker).toEqual({ characterId: 'anton', source: 'tag-name' });
    expect(speech[1].speaker?.characterId).toBe('olga');
  });

  it('standalone transform: inserts a line break at BOTH evidenced turns (asserts the intermediate body)', () => {
    const body = 'Он вошёл. — Привет, — сказал Антон. — Здравствуй, — ответила Ольга. Он сел.';
    const out = splitEvidencedInteriorTurns(body, idx);
    expect(out).toBe('Он вошёл.\n— Привет, — сказал Антон.\n— Здравствуй, — ответила Ольга. Он сел.');
  });

  it('rejects a candidate whose tag lacks a speech/beat verb (no split, no fabrication)', () => {
    const body = 'Он вошёл. — Привет, — Ольга насмешливо посмотрела в окно.';
    const paras = parseChapterStructure(body, idx, { recoverMidParagraphTurns: true });
    // the interior segment has a tag but no verb → must NOT be promoted to speech
    expect(speechOf(paras)).toHaveLength(0);
  });

  it('does NOT promote a narration prefix that precedes a later verb-tagged turn (blocking regression)', () => {
    const body = 'Он вошёл. — Толик молчал, глядя в окно. — Привет, — сказал Антон.';
    const paras = parseChapterStructure(body, idx, { recoverMidParagraphTurns: true });
    const speech = speechOf(paras);
    // the narration prefix "Толик молчал…" must NOT become speech; only the
    // later verb-tagged turn recovers
    expect(speech).toHaveLength(1);
    expect(speech[0].speaker).toEqual({ characterId: 'anton', source: 'tag-name' });
    // slice the TRANSFORMED body (recovery re-keys offsets), not the original —
    // robust when the pre-dash whitespace width differs from a single space.
    const transformed = splitEvidencedInteriorTurns(body, idx);
    expect(transformed.slice(speech[0].start, speech[0].end)).toContain('Привет');
  });

  it('does NOT fabricate speech from a beat-verb narration interruption (interior beat, no speaker anchor)', () => {
    // "Thrift is a distinguishing trait. He nodded — and continued." is narration;
    // the ", — и продолжил" beat-verb tag alone must NOT promote the leading narration.
    const body = 'Он замер. — Запасливость — отличительная черта. Он кивнул, — и продолжил.';
    const paras = parseChapterStructure(body, idx, { recoverMidParagraphTurns: true });
    expect(speechOf(paras)).toHaveLength(0);
  });

  it('does NOT fabricate speech from a participial narration clause (tag is not named/first-person)', () => {
    const body = 'Он посмотрел на неё. — Увидев слёзы, — он покачал головой и ушёл.';
    const paras = parseChapterStructure(body, idx, { recoverMidParagraphTurns: true });
    expect(speechOf(paras)).toHaveLength(0);
  });

  it('does NOT fabricate speech when the tag is a mentally-qualified pronoun beat (no name/я)', () => {
    const body = 'Он вошёл. — Картина, — воскликнул он мысленно, глядя на холст, — висела криво.';
    const paras = parseChapterStructure(body, idx, { recoverMidParagraphTurns: true });
    expect(speechOf(paras)).toHaveLength(0);
  });

  it('recovers a FIRST-PERSON turn (tag anchors я → the narrator)', () => {
    const body = 'Он подошёл. — Возьми, — сказал я. Он взял диск.';
    const paras = parseChapterStructure(body, idx, { recoverMidParagraphTurns: true });
    const speech = speechOf(paras);
    expect(speech).toHaveLength(1);
  });

  it('clean chapter (fine-grained, all lines dash-open) recovers +0 spans', () => {
    const body = [
      '— Привет, — сказал Антон.',
      'Он сел на стул.',
      '— Здравствуй, — ответила Ольга. Как дела?',
      'Она улыбнулась.',
    ].join('\n');
    const without = spansOf(parseChapterStructure(body, idx)).filter((s) => s.kind === 'speech').length;
    const withRecovery = spansOf(parseChapterStructure(body, idx, { recoverMidParagraphTurns: true })).filter(
      (s) => s.kind === 'speech',
    ).length;
    expect(withRecovery).toBe(without); // zero fabrication/regression on intact structure
  });
});