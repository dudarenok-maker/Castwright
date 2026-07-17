import { describe, expect, it } from 'vitest';
import { conventionsFor } from './lang/index.js';
import { buildNameIndex } from './name-matcher.js';
import { parseChapterStructure } from './parser.js';
import { alignSentences, locateSentenceOffsets } from './aligner.js';
import type { SentenceOutput } from '../../handoff/schemas.js';

const mkSentence = (id: number, characterId: string, text: string): SentenceOutput => ({
  id,
  chapterId: 1,
  characterId,
  text,
});

describe('alignSentences', () => {
  it('(a) exact-copy sentences align to their spans', () => {
    const enIdx = buildNameIndex([{ id: 'halloran', name: 'Halloran' }], conventionsFor('en')!);
    const body = '“Hard to starboard,” Halloran said.';
    const paras = parseChapterStructure(body, enIdx);
    const speechSpan = paras.flatMap((p) => p.spans).find((s) => s.kind === 'speech')!;
    const tagSpan = paras.flatMap((p) => p.spans).find((s) => s.kind === 'tag')!;

    const sentences = [mkSentence(1, 'halloran', 'Hard to starboard,')];
    const result = alignSentences(sentences, paras, body);

    expect(result.aligned).toHaveLength(1);
    expect(result.aligned[0].spans).toEqual([speechSpan]);
    expect(result.aligned[0].spans).not.toContainEqual(tagSpan);
    expect(result.aligned[0].lumped).toBe(false);
    expect(result.alignedPct).toBe(100);
  });

  it('(b) glyph drift (straight quotes / "--" for em dash / collapsed whitespace) still aligns via normalization', () => {
    const ruIdx = buildNameIndex([{ id: 'anton', name: 'Антон' }], conventionsFor('ru')!);
    // Raw speech span text is "Сумрак — это   не место," (em dash, triple space).
    const body = '— Сумрак — это   не место,\nа состояние.';
    const paras = parseChapterStructure(body, ruIdx);
    const speechSpan = paras.flatMap((p) => p.spans).find((s) => s.kind === 'speech')!;
    expect(body.slice(speechSpan.start, speechSpan.end)).toBe('Сумрак — это   не место,');

    // Model drift: "--" instead of the em dash, single spaces instead of the triple gap.
    const driftedText = 'Сумрак -- это не место,';
    const sentences = [mkSentence(1, 'anton', driftedText)];
    const result = alignSentences(sentences, paras, body);

    expect(result.aligned).toHaveLength(1);
    expect(result.aligned[0].spans).toEqual([speechSpan]);
    expect(result.alignedPct).toBe(100);
  });

  it('(c) a model entry covering quote + tag reports lumped:true', () => {
    const enIdx = buildNameIndex([{ id: 'halloran', name: 'Halloran' }], conventionsFor('en')!);
    const body = '“Hard to starboard,” Halloran said.';
    const paras = parseChapterStructure(body, enIdx);
    const allSpans = paras.flatMap((p) => p.spans);
    const speechSpan = allSpans.find((s) => s.kind === 'speech')!;
    const tagSpan = allSpans.find((s) => s.kind === 'tag')!;

    // Covers the closing-quote-delimiter gap too: spans continuously from the
    // start of the speech span to the end of the tag span.
    const combinedText = body.slice(speechSpan.start, tagSpan.end);
    const sentences = [mkSentence(1, 'halloran', combinedText)];
    const result = alignSentences(sentences, paras, body);

    expect(result.aligned).toHaveLength(1);
    expect(result.aligned[0].spans).toEqual(expect.arrayContaining([speechSpan, tagSpan]));
    expect(result.aligned[0].lumped).toBe(true);
  });

  it('(d) duplicate model spans align the FIRST occurrence and mark the duplicate unaligned, without desyncing later sentences', () => {
    const enIdx = buildNameIndex([{ id: 'halloran', name: 'Halloran' }], conventionsFor('en')!);
    const body = '“Hard to starboard,” Halloran said.';
    const paras = parseChapterStructure(body, enIdx);
    const allSpans = paras.flatMap((p) => p.spans);
    const speechSpan = allSpans.find((s) => s.kind === 'speech')!;
    const tagSpan = allSpans.find((s) => s.kind === 'tag')!;

    const sentences = [
      mkSentence(1, 'halloran', 'Hard to starboard,'),
      mkSentence(2, 'halloran', 'Hard to starboard,'), // duplicate (stage-2 loop-and-truncate bug)
      mkSentence(3, 'halloran', 'Halloran said.'),
    ];
    const result = alignSentences(sentences, paras, body);

    expect(result.aligned).toHaveLength(3);
    expect(result.aligned[0].spans).toEqual([speechSpan]);
    expect(result.aligned[1].spans).toEqual([]); // duplicate: unaligned
    expect(result.aligned[2].spans).toEqual([tagSpan]); // NOT desynced by the duplicate
  });

  it('(e) alignedPct reflects the unaligned count', () => {
    const enIdx = buildNameIndex([{ id: 'halloran', name: 'Halloran' }], conventionsFor('en')!);
    const body = '“Hard to starboard,” Halloran said.';
    const paras = parseChapterStructure(body, enIdx);

    const sentences = [
      mkSentence(1, 'halloran', 'Hard to starboard,'),
      mkSentence(2, 'halloran', 'Hard to starboard,'), // duplicate: unaligned
      mkSentence(3, 'halloran', 'Halloran said.'),
    ];
    const result = alignSentences(sentences, paras, body);

    expect(result.alignedPct).toBeCloseTo((2 / 3) * 100, 5);
  });

  it('(f) ellipsis expansion (…→...) keeps the offset map accurate — the crux path', () => {
    const enIdx = buildNameIndex([{ id: 'halloran', name: 'Halloran' }], conventionsFor('en')!);
    // Raw speech span text contains a literal single-glyph ellipsis: "Wait… go,".
    const body = '“Wait… go,” Halloran said.';
    const paras = parseChapterStructure(body, enIdx);
    const speechSpan = paras.flatMap((p) => p.spans).find((s) => s.kind === 'speech')!;
    expect(body.slice(speechSpan.start, speechSpan.end)).toBe('Wait… go,');

    // Model expands the single ellipsis glyph to three ASCII dots — normalize()
    // expands the raw "…" the same way, so the needle matches, but the match
    // spans the +2-char-longer normalized region; translating matchStart/matchEnd
    // back through rawStart/rawEnd must still land on the ORIGINAL raw span.
    const sentences = [mkSentence(1, 'halloran', 'Wait... go,')];
    const result = alignSentences(sentences, paras, body);

    expect(result.aligned).toHaveLength(1);
    expect(result.aligned[0].spans).toEqual([speechSpan]);
    expect(result.alignedPct).toBe(100);
  });

  it('(g) curly-apostrophe drift (’ vs \') still aligns via normalization', () => {
    const enIdx = buildNameIndex([{ id: 'halloran', name: 'Halloran' }], conventionsFor('en')!);
    // Raw speech span uses the curly (typographic) apostrophe.
    const body = '“Don’t stop,” Halloran said.';
    const paras = parseChapterStructure(body, enIdx);
    const speechSpan = paras.flatMap((p) => p.spans).find((s) => s.kind === 'speech')!;
    expect(body.slice(speechSpan.start, speechSpan.end)).toBe('Don’t stop,');

    // Model drift: straight apostrophe instead of the curly one.
    const sentences = [mkSentence(1, 'halloran', "Don't stop,")];
    const result = alignSentences(sentences, paras, body);

    expect(result.aligned).toHaveLength(1);
    expect(result.aligned[0].spans).toEqual([speechSpan]);
    expect(result.alignedPct).toBe(100);
  });
});

describe('locateSentenceOffsets (#1679)', () => {
  it('returns each sentence start offset in body order', () => {
    const body = 'The door opened. A shadow fell across the floor.';
    const offsets = locateSentenceOffsets(
      [{ text: 'The door opened.' }, { text: 'A shadow fell across the floor.' }],
      body,
    );
    expect(offsets[0]).toBe(0);
    expect(offsets[1]).toBe(body.indexOf('A shadow'));
  });

  it('returns null for a sentence whose text is not in the body (paraphrase/drift)', () => {
    const body = 'The door opened.';
    const offsets = locateSentenceOffsets(
      [{ text: 'The door opened.' }, { text: 'Something else entirely.' }],
      body,
    );
    expect(offsets[0]).toBe(0);
    expect(offsets[1]).toBeNull();
  });

  it('a mid-sequence miss does not desync later matches (cursor unmoved on miss)', () => {
    const body = 'Alpha here. Beta here. Gamma here.';
    const offsets = locateSentenceOffsets(
      [{ text: 'Alpha here.' }, { text: 'nope.' }, { text: 'Gamma here.' }],
      body,
    );
    expect(offsets[0]).toBe(0);
    expect(offsets[1]).toBeNull();
    expect(offsets[2]).toBe(body.indexOf('Gamma'));
  });

  it('tolerates smart-quote / dash normalization drift', () => {
    const body = 'He said — quietly — nothing.'; // em dashes in body
    const offsets = locateSentenceOffsets([{ text: 'He said -- quietly -- nothing.' }], body);
    expect(offsets[0]).toBe(0);
  });
});
