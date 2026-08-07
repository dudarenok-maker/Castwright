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

  it('(RC2) folds ё↔е so a model ё/е swap still aligns', () => {
    const ruIdx = buildNameIndex([{ id: 'anton', name: 'Антон' }], conventionsFor('ru')!);
    // Body uses ё in both "Ещё" and "всё".
    const body = '— Ещё не всё, — сказал Антон.';
    const paras = parseChapterStructure(body, ruIdx);
    const speechSpan = paras.flatMap((p) => p.spans).find((s) => s.kind === 'speech')!;
    expect(body.slice(speechSpan.start, speechSpan.end)).toBe('Ещё не всё,');

    // Model returned the same line with е instead of ё (the classic RU drift).
    const sentences = [mkSentence(1, 'anton', 'Еще не все,')];
    const result = alignSentences(sentences, paras, body);

    // Assert on membership + alignedPct, NOT strict array-equality: the overlap
    // filter (aligner.ts:161) can graze the adjacent tag span depending on the
    // comma-boundary offset, and that's not what this test is about.
    expect(result.aligned[0].spans).toContain(speechSpan);
    expect(result.alignedPct).toBe(100);
  });

  it('(RC2) aligns across composed vs decomposed ё (combining diaeresis)', () => {
    const ruIdx = buildNameIndex([{ id: 'anton', name: 'Антон' }], conventionsFor('ru')!);
    const body = '— Ещё раз, — сказал Антон.'; // composed ё
    const paras = parseChapterStructure(body, ruIdx);
    const speechSpan = paras.flatMap((p) => p.spans).find((s) => s.kind === 'speech')!;
    const decomposed = 'Ещё раз,'.normalize('NFD'); // е + U+0308
    const result = alignSentences([mkSentence(1, 'anton', decomposed)], paras, body);
    expect(result.aligned[0].spans).toContain(speechSpan);
    expect(result.alignedPct).toBe(100);
  });

  it('(RC2) prefix-anchored fuzzy fallback aligns a paraphrased long sentence to its paragraph', () => {
    const ruIdx = buildNameIndex([{ id: 'anton', name: 'Антон' }], conventionsFor('ru')!);
    const body = '— Я упустил вампиршу вчера ночью возле старого парка, — сказал Антон.';
    const paras = parseChapterStructure(body, ruIdx);
    const speechSpan = paras.flatMap((p) => p.spans).find((s) => s.kind === 'speech')!;
    const drifted = 'Я упустил вампиршу вчера возле тёмного парка,'; // middle words changed/dropped
    const result = alignSentences([mkSentence(1, 'anton', drifted)], paras, body);
    expect(result.aligned[0].spans).toContain(speechSpan);
    expect(result.alignedPct).toBe(100);
  });

  it('(RC2) does NOT fuzzy-match a short needle (avoids false anchors)', () => {
    const ruIdx = buildNameIndex([{ id: 'anton', name: 'Антон' }], conventionsFor('ru')!);
    const body = '— Да, конечно, я помню тот давний день очень хорошо, — кивнул Антон.';
    const paras = parseChapterStructure(body, ruIdx);
    const result = alignSentences([mkSentence(1, 'anton', 'Нет.')], paras, body); // <24 chars, absent
    expect(result.aligned[0].spans).toEqual([]);
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

/* #2187 — anchor-first, two-pass, interval-bounded alignment regression coverage.
   Root cause: the pre-fix single monotonic cursor + first-hit-then-unbounded-
   fallback search let an ultra-common short sentence ("- Да.") bind to a
   duplicate occurrence far downstream once cursor had legitimately advanced
   past its true position (e.g. because an earlier duplicate turn consumed it) —
   every sentence after that wrong bind was then stranded, since it could only
   match at/after the now-bogus cursor.

   Fixture shape: two long, unique narration sentences (L1, L2) bound a short
   "true" dash-dialogue exchange ("Да." / "Нет, со взрослыми." / "Мама далеко,
   позвать?"). An EARLIER duplicate "Да." turn legitimately consumes the one
   true "Да." occurrence first (a real stage-2 loop-and-truncate style
   duplicate, same mechanism as test (d) above) — so the sentence under test
   has no true occurrence of ITS OWN left to find. Beyond L2 sits >4096 chars
   of padding, then an unrelated DECOY "Да." occurrence for some other, later
   turn not represented in `sentences` at all.

   Pre-fix: the duplicate's search from the post-L1 cursor finds the true "Да."
   (correct). The sentence under test then searches forward from THAT cursor,
   misses everything in the window, and its unbounded fallback walks all the
   way to the far DECOY — binding wrongly. Cursor then sits past L2 entirely,
   so "Нет, со взрослыми." / "Мама далеко, позвать?" / L2 itself can never be
   found afterward: exactly the reported "flagged sentence located far
   downstream; everything after it fails to locate" pattern.

   Post-fix: L1 and L2 are the only anchors (both well over ANCHOR_MIN_LEN;
   every dash-dialogue line is well under it). The run between them is bounded
   to `[L1.end, L2.start)` — the decoy sits entirely outside that interval, so
   it is structurally unreachable. The duplicate still consumes the true "Да."
   within the run (unavoidable — it's a genuine ambiguity, same as test (d));
   the sentence under test safely comes back null instead of the wrong far
   bind; but because the run boundary is L2 (not "wherever the decoy happens to
   sit"), the FOLLOWING sentences — unlike pre-fix — still locate correctly. */
describe('#2187 anchor-first interval-bounded alignment', () => {
  const L1 = 'Дозорные собрались у старых ворот перед самым рассветом.';
  const L2 = 'Тишина в переулке стала совсем густой и почти осязаемой.';
  const TRUE_DA = '— Да.';
  const FOLLOW1 = '— Нет, со взрослыми.';
  const FOLLOW2 = '— Мама далеко, позвать?';
  // >4096 chars (WINDOW), plain ASCII so it can never collide with a Cyrillic
  // needle post-normalization (Cyrillic д and Latin d are different code points).
  const PADDING = 'The quiet hallway stretched on without end, indifferent to the hour. '.repeat(80);
  const DECOY_DA = '— Да.'; // unrelated later turn — NOT represented in `sentences`

  function buildFixture() {
    const body = [L1, TRUE_DA, FOLLOW1, FOLLOW2, L2, PADDING, DECOY_DA].join('\n');
    const sentences = [
      mkSentence(1, 'narrator', L1),
      mkSentence(2, 'olga', 'Да.'), // duplicate turn — legitimately consumes the true occurrence
      mkSentence(3, 'anton', 'Да.'), // sentence under test
      mkSentence(4, 'anton', 'Нет, со взрослыми.'),
      mkSentence(5, 'marina', 'Мама далеко, позвать?'),
      mkSentence(6, 'narrator', L2),
    ];
    expect(PADDING.length).toBeGreaterThan(4096);
    return { body, sentences };
  }

  it('locates the duplicate at its true (earlier) position and leaves the ambiguous sentence unaligned WITHOUT binding it to the far decoy', () => {
    const { body, sentences } = buildFixture();
    const trueDaPos = body.indexOf('Да.');
    const decoyPos = body.indexOf('Да.', trueDaPos + 1);
    // The decoy must be out of WINDOW reach, and WINDOW applies in NORMALIZED
    // space — so measure the gap there, not in raw offsets. Measuring raw
    // would silently stay green if PADDING ever gained whitespace runs, `…`
    // or `&mdash;` (all of which shrink under normalization), even though the
    // property this guard exists to pin would be gone.
    const normGapChars = body.slice(trueDaPos, decoyPos).replace(/\s+/gu, ' ').length;
    expect(normGapChars).toBeGreaterThan(4096);

    const offsets = locateSentenceOffsets(
      sentences.map((s) => ({ text: s.text })),
      body,
    );

    expect(offsets[1]).toBe(trueDaPos); // the duplicate correctly claims the true, earlier occurrence
    expect(offsets[2]).toBeNull(); // sentence under test: safe fail, not a wrong bind
  });

  it('sentences AFTER the ambiguous one still locate — the old bug\'s "everything after it is stranded" symptom', () => {
    const { body, sentences } = buildFixture();
    const offsets = locateSentenceOffsets(
      sentences.map((s) => ({ text: s.text })),
      body,
    );

    expect(offsets[3]).toBe(body.indexOf('Нет, со взрослыми.'));
    expect(offsets[4]).toBe(body.indexOf('Мама далеко, позвать?'));
    expect(offsets[5]).toBe(body.indexOf(L2));
  });

  it('alignment rate on this fixture is materially higher than the pre-#2187 single-cursor scheme', () => {
    const enIdx = buildNameIndex(
      [
        { id: 'narrator', name: 'Наблюдатель' },
        { id: 'olga', name: 'Ольга' },
        { id: 'anton', name: 'Антон' },
        { id: 'marina', name: 'Марина' },
      ],
      conventionsFor('ru')!,
    );
    const { body, sentences } = buildFixture();
    const paras = parseChapterStructure(body, enIdx);
    const result = alignSentences(sentences, paras, body);

    // Pre-#2187, this exact fixture aligned only L1/duplicate/wrong-decoy-bind
    // (3 of 6 = 50%) — see the mutation-tested red-phase proof in the PR/report.
    // Pinned to the exact post-fix value, not just `> 50`: a partial regression
    // that still cleared 50 would otherwise pass a test whose name promises
    // "materially higher".
    expect(result.alignedPct).toBeCloseTo(83.33, 1);
    expect(result.aligned[2].spans).toEqual([]); // the ambiguous sentence: unaligned, not corrupted
  });

  it('a paraphrased/unmatched RU sentence yields empty spans without desyncing its neighbours in alignSentences', () => {
    const ruIdx = buildNameIndex([{ id: 'anton', name: 'Антон' }], conventionsFor('ru')!);
    const body = [
      '— Тише, — сказал Антон.',
      '— Смотри туда, — добавил он.',
      '— Уходим быстро, — прошептал Антон.',
    ].join('\n');
    const paras = parseChapterStructure(body, ruIdx);
    const sentences = [
      mkSentence(1, 'anton', 'Тише,'),
      // Genuinely unrelated text — a model paraphrase/drift bad enough to never
      // locate at all (well over ANCHOR_MIN_LEN, so it's even attempted as a
      // Pass A anchor and correctly rejected — no exact match anywhere).
      mkSentence(2, 'anton', 'Совершенно другой текст, никак не связанный с этой книгой вообще'),
      mkSentence(3, 'anton', 'Уходим быстро,'),
    ];
    const result = alignSentences(sentences, paras, body);

    expect(result.aligned[0].spans.length).toBeGreaterThan(0);
    expect(result.aligned[1].spans).toEqual([]); // unmatched: empty, not corrupted
    expect(result.aligned[2].spans.length).toBeGreaterThan(0); // neighbour NOT desynced
  });
});
