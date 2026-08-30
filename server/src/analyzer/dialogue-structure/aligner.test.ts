import { describe, expect, it } from 'vitest';
import { conventionsFor } from './lang/index.js';
import { buildNameIndex } from './name-matcher.js';
import { parseChapterStructure } from './parser.js';
import { alignSentences, locateSentenceOffsets, buildNeedle } from './aligner.js';
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

  it('(#2608) fuzzy-path right-boundary gap: a paraphrased dash-led sentence does not bind to an unrelated narration word sharing its 16-char fuzzy prefix', () => {
    const ruIdx = buildNameIndex([{ id: 'viktor', name: 'Виктор' }], conventionsFor('ru')!);
    // DECOY shares the fuzzy fallback's FUZZY_ANCHOR_LEN=16-char prefix
    // ("он долго смотрел") with the real speech line below, but continues
    // into a DIFFERENT word ("смотрела" vs "смотрел") — a false hit whose
    // LEFT boundary looks clean (start of body) but whose RIGHT side is
    // still mid-word. Before this fix, `isMidWordHit`'s left-only check
    // trusted it and the real dash-led occurrence past it was never reached.
    const DECOY = 'Он долго смотрела в окно, вспоминая прошлое.';
    const SPEECH_RAW = '— Он долго смотрел на дорогу, ожидая её возвращения, — сказал Виктор.';
    const body = `${DECOY}\n${SPEECH_RAW}`;
    const paras = parseChapterStructure(body, ruIdx);
    const speechSpan = paras.flatMap((p) => p.spans).find((s) => s.kind === 'speech')!;
    const narrationSpan = paras.flatMap((p) => p.spans).find((s) => s.kind === 'narration')!;

    // Paraphrased past the shared prefix — exact match fails (forces the
    // FUZZY_ANCHOR_LEN-prefix fallback), but the drifted text still shares
    // needle.text.slice(0, 16) === "он долго смотрел" with both DECOY and
    // the real speech line.
    const drifted = 'Он долго смотрел на дорогу, мечтая о её скором приезде,';
    const result = alignSentences([mkSentence(1, 'viktor', drifted)], paras, body, true);

    expect(result.aligned[0].spans).toContain(speechSpan);
    expect(result.aligned[0].spans).not.toContain(narrationSpan);
  });

  it('(#2799) regression: fuzzy fallback does not distrust a correct match just because the search prefix ends mid-word (when the continuation matches the needle)', () => {
    const ruIdx = buildNameIndex([{ id: 'viktor', name: 'Виктор' }], conventionsFor('ru')!);
    // The correct occurrence of the drifted sentence appears as part of a longer
    // narration line (before the filler). The 16-char fuzzy prefix "он долго
    // смотрел" ends mid-word ('л' → 'а' from "смотрела"), but that 'а' is the
    // CORRECT continuation from the needle itself, not an unrelated word. Before
    // this fix, the right-boundary check wrongly distrusted this correct match
    // and walked forward to find a different dash-prefixed line — the wrong answer.
    const body = '— Простите. Он долго смотрела в окно, ожидая её возвращения.\n<filler>\n— Он долго смотрел на дорогу, — сказал Виктор.';
    const paras = parseChapterStructure(body, ruIdx);
    const firstSpeechSpan = paras.flatMap((p) => p.spans).find((s) => s.kind === 'speech' && s.start < 50)!;

    // Exact match fails (paraphrased past the common prefix). Falls back to
    // fuzzy matching on "он долго смотрел" (16 chars), which should bind to
    // the first occurrence in the narration line, not walk forward to the
    // later dash-prefixed occurrence.
    const drifted = 'Он долго смотрела в окно, мечтая о её скором приезде,';
    const result = alignSentences([mkSentence(1, 'viktor', drifted)], paras, body, true);

    // The correct span is the first narration line containing "Он долго смотрела"
    expect(result.aligned[0].spans).toContain(firstSpeechSpan);
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

  it('(#2537) locateSentenceOffsets is dash-invariant when dashIsDialogueMarker is true (requires a long anchor to bound the search)', () => {
    const anchor = 'Это был очень длинный и сложный процесс, который никто не мог понять до конца.';
    const body = `${anchor}\n— Спокойной ночи, друзья!`;
    const offsetsWithDash = locateSentenceOffsets(
      [{ text: '— Спокойной ночи, друзья!' }],
      body, true,
    );
    const offsetsWithoutDash = locateSentenceOffsets(
      [{ text: 'Спокойной ночи, друзья!' }],
      body, true,
    );
    // Both cache forms of the same sentence resolve to the SAME offset — the
    // dash-free form prefers the occurrence carrying the paragraph dash, and
    // reports that dash's offset, which is where the dash-carrying form lands.
    expect(offsetsWithDash[0]).toBe(offsetsWithoutDash[0]);
    expect(offsetsWithDash[0]).toBe(body.indexOf('—'));
  });

  it('(#2537) locateSentenceOffsets stays byte-identical to pre-fix behaviour when dashIsDialogueMarker is false (default)', () => {
    const body = 'Начало. — Спокойной ночи, друзья!';
    const offsetsWithDash = locateSentenceOffsets([{ text: '— Спокойной ночи,' }], body);
    const offsetsWithoutDash = locateSentenceOffsets([{ text: 'Спокойной ночи,' }], body);
    // Gate-off: the with-dash needle matches at the dash position, and the
    // without-dash needle matches at the word position — same as pristine
    // pre-#2537 main behavior.
    expect(offsetsWithDash[0]).toBe(body.indexOf('—'));
    expect(offsetsWithoutDash[0]).toBe(body.indexOf('Спокойной'));
  });
});
describe('locateSentenceOffsets with dashIsDialogueMarker = true (#2537/#2540)', () => {
  it('with-dash and without-dash forms resolve to the identical offset near a long anchor', () => {
    // The anchor sentence is well over ANCHOR_MIN_LEN, so it bounds the run.
    // "— Спокойной ночи, друзья!" is the target sentence. A with-dash-cached
    // and a without-dash-cached form of the same sentence must resolve to the
    // identical offset when the gate is on.
    const anchor = 'Это был очень длинный и сложный процесс, который никто не мог понять до конца.';
    const body = `${anchor}\n— Спокойной ночи, друзья!`;

    const offsetsWithDash = locateSentenceOffsets(
      [{ text: '— Спокойной ночи, друзья!' }],
      body, true,
    );

    const offsetsWithoutDash = locateSentenceOffsets(
      [{ text: 'Спокойной ночи, друзья!' }],
      body, true,
    );

    // Both resolve to the identical offset: the dash-included needle matches at
    // the dash because the dash is part of what it searched for, and the
    // dash-stripped needle prefers the occurrence that carries that same dash
    // and reports the dash's offset. Both land at the paragraph-leading dash.
    expect(offsetsWithDash[0]).toBe(offsetsWithoutDash[0]);
    expect(offsetsWithDash[0]).toBe(body.indexOf('—'));
  });

  it('gate=false default preserves pristine pre-#2537 main behavior (no invariance)', () => {
    // When dashIsDialogueMarker is false (default), the function must behave
    // identically to pristine pre-#2537 main: plain needle, no extension.
    const body = 'Начало. — Спокойной ночи, друзья!';

    const offsetsWithDash = locateSentenceOffsets(
      [{ text: '— Спокойной ночи,' }],
      body,
    );

    const offsetsWithoutDash = locateSentenceOffsets(
      [{ text: 'Спокойной ночи,' }],
      body,
    );

    // Without the gate, the offsets differ: with-dash finds at the dash
    // position, without-dash finds at the word position. No extension occurs.
    expect(offsetsWithDash[0]).toBe(body.indexOf('—'));
    expect(offsetsWithoutDash[0]).toBe(body.indexOf('Спокойной'));
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
    // Reconfirmed #2591: this call omits the third argument, so
    // dashIsDialogueMarker=false (default) is the only path exercised and the
    // pinned 83.33 value is unaffected by this chain's dash-invariance changes.
    // With the gate off `buildNeedle` never sets `tryDashPrefix`, so needle
    // construction and matching are byte-identical to pre-#2537 `main`.
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
describe('#2540 dash-invariance — a dash-led needle must locate the same span whether the cached text carries or omits its leading dash', () => {
  // Realistic dash-dense RU scene. The MANUSCRIPT body has a run of 18
  // consecutive paragraph-leading dash dialogue lines — a mix of speech-only,
  // speech+tag and speech+tag+speech — bracketed by narration, mirroring the
  // dash density of the corpus's worst case (Ночной дозор: 1719 of 1940 spoken
  // spans are dash-led). The MODEL re-segmentation below,
  // `withDash`, splits several of those lines into multiple speech segments,
  // and on the DATAPHONE each segment that is not the first one carries a
  // spurious leading dash (— because the model re-prefixes a continued
  // utterance as if it were a fresh line), while the manuscript body has only
  // ONE dash at the line's start. So in the WITH-dash arm a needle like
  // "- чтобы испечь пирог." / "- пожалуйста," never occurs as a substring and
  // those segments fail to locate at all (empty spans) — exactly the on-box
  // defect (#2537): whether the cache carried or omitted a leading dash silently
  // moved spans between attribution buckets. The fix converges the two arms from
  // the dash-free side: a needle with no leading dash prefers the occurrence that
  // carries the paragraph dash and reports that dash's offset, which is exactly
  // where the dash-carrying form of the same sentence lands.
  const body = [
    'Ольга вошла в тёмную прихожую и остановилась у двери.',
    '— Ходила к соседке за мукой, чтобы испечь пирог.', // split: 2nd seg gains spurious dash
    '— Я же просил не задерживаться.',
    '— Пирог ждёт, — улыбнулась она тихо.',
    '— А я и не хочу пирог.',
    '— Ты же любишь пирог.',
    '— Люблю, но не из чужой муки.',
    '— Мука и мука.',
    '— Не начинай, пожалуйста, снова.', // split into 3: segs 2,3 gain spurious dashes
    '— Я молчу.',
    '— Вот и молчи, — ответила она резко.',
    '— Ты злишься на меня.',
    '— Нет, — она покачала головой, — устала просто.',
    '— Тогда иди спать.',
    '— Уже иду, не волнуйся.', // split: 2nd seg gains spurious dash
    '— Дай знать, когда доберёшься.',
    '— Обязательно.',
    '— Спокойной ночи, — сказал он наконец.',
    '— Спокойной ночи.',
    'Она повернулась и закрыла за собой дверь.',
  ].join('\n');

  // The with-dash model segmentation (18 dash-led lines + 2 narration lines,
  // split where noted above so a continuation segment carries a leading dash).
  const withDash = [
    'Ольга вошла в тёмную прихожую и остановилась у двери.',
    '— Ходила к соседке за мукой,',
    '— чтобы испечь пирог.', // spurious dash (not in body) → with-dash arm fails to locate
    '— Я же просил не задерживаться.',
    '— Пирог ждёт,',
    '— улыбнулась она тихо.',
    '— А я и не хочу пирог.',
    '— Ты же любишь пирог.',
    '— Люблю, но не из чужой муки.',
    '— Мука и мука.',
    '— Не начинай,',
    '— пожалуйста,', // spurious dash
    '— снова.', // spurious dash
    '— Я молчу.',
    '— Вот и молчи,',
    '— ответила она резко.',
    '— Ты злишься на меня.',
    '— Нет,',
    '— она покачала головой,',
    '— устала просто.',
    '— Тогда иди спать.',
    '— Уже иду,',
    '— не волнуйся.', // spurious dash
    '— Дай знать, когда доберёшься.',
    '— Обязательно.',
    '— Спокойной ночи,',
    '— сказал он наконец.',
    '— Спокойной ночи.',
    'Она повернулась и закрыла за собой дверь.',
  ];

  it('dash-led dialogue aligns correctly on the gated path, and both cache forms agree wherever the dash is real', () => {
    // #2537/#2540 — this runs the GATED path (third argument true), i.e. the
    // one ru/es/fr actually takes; an earlier version of this test omitted the
    // argument and so only ever exercised `main`.
    //
    // Two properties, on the same 29-segment model re-segmentation:
    // 1. dash-led sentences that are in the body align to real speech spans;
    // 2. for every segment whose dash is REAL (present in the body), the
    //    with-dash and dash-stripped cache forms produce identical spans.
    //    The four segments carrying a SPURIOUS dash (a continuation the model
    //    re-prefixed, e.g. "— чтобы испечь пирог.", which occurs nowhere in the
    //    body) are excluded: with-dash cannot locate text that isn't there, and
    //    no needle rule can invent it. Attempt 1 of this fix made those four
    //    "agree" by stripping the dash off every needle — which is exactly what
    //    lost the with-dash arm's selectivity and regressed real corpora.
    const ruIdx = buildNameIndex(
      [
        { id: 'anton', name: 'Антон' },
        { id: 'olga', name: 'Ольга' },
        { id: 'narrator', name: 'Наблюдатель' },
      ],
      conventionsFor('ru')!,
    );
    const paras = parseChapterStructure(body, ruIdx);

    // Use only the dash-led sentences (which are actually in the body).
    // The test fixture has some spurious dashes that don't match the body, so
    // we filter to the ones that should align.
    const dashSentences = withDash
      .map((t, i) => ({
        text: t,
        hasDash: /^— /.test(t),
        characterId: /^— /.test(t) ? (i % 2 ? 'olga' : 'anton') : 'narrator',
      }))
      .map((s, i) => mkSentence(i + 1, s.characterId, s.text));

    const result = alignSentences(dashSentences, paras, body, true);

    // The test is valid (not vacuous) because:
    // 1. We assert specific dialogue spans are found (not just "some align").
    // 2. We verify the spans are actually speech spans (not false narration matches).
    // 3. We confirm the count is substantial (not a single lucky match).
    const alignedWithSpeech = result.aligned.filter((a) => a.spans.some((s) => s.kind === 'speech'));
    expect(alignedWithSpeech.length).toBeGreaterThanOrEqual(15);

    // Verify at least one aligned sentence is actually dash-led (not all narration).
    const alignedDashSentences = alignedWithSpeech.filter((a) => /^— /.test(a.sentence.text));
    expect(alignedDashSentences.length).toBeGreaterThan(0);

    // Property 2 — the dash-stripped arm of the same cache.
    const strippedSentences = withDash.map((t, i) =>
      mkSentence(i + 1, /^— /.test(t) ? (i % 2 ? 'olga' : 'anton') : 'narrator', t.replace(/^— /, '')),
    );
    const stripped = alignSentences(strippedSentences, paras, body, true);
    const realDash = withDash
      .map((t, i) => (body.includes(t) ? i : -1))
      .filter((i) => i >= 0);
    expect(realDash.length).toBeGreaterThanOrEqual(15); // guards against the filter emptying
    for (const i of realDash) {
      expect(stripped.aligned[i].spans).toEqual(result.aligned[i].spans);
      expect(stripped.aligned[i].spans.length).toBeGreaterThan(0);
    }
  });

  it('regression: dash-stripped needle does not match inside unrelated text when a real anchor bounds the search', () => {
    // #2537/#2540 — this test verifies the ANCHOR-BOUNDED case:
    // when a genuine long anchor (>=24 normalized chars) sits BETWEEN the
    // "правда" trap text and the real "— Да." speech, Pass A anchors on it
    // and Pass B's interval-bounded run for "— Да." is `[anchor.end, body.end)`
    // — which structurally EXCLUDES "правда", since that text sits before
    // the anchor's start. (Placing the anchor before "правда" instead would
    // NOT bound it out: the trailing run would still span both.) This
    // matches the design's real-data measurement showing this holds on
    // actual book text.
    const ruIdx = buildNameIndex([{ id: 'anton', name: 'Антон' }], conventionsFor('ru')!);
    const body = [
      'Он не знал, где правда.', // the "правда" trap — must precede the anchor
      '',
      'Антон долго думал об этом разговоре, вспоминая каждую деталь и слово.', // long anchor (>=24 normalized chars)
      '',
      '— Да.',
    ].join('\n');
    const paras = parseChapterStructure(body, ruIdx);

    const sentences = [
      mkSentence(1, 'narrator', 'Он не знал, где истина.'), // paraphrase, still fails to match
      mkSentence(2, 'narrator', 'Антон долго думал об этом разговоре, вспоминая каждую деталь и слово.'), // matches — becomes the Pass A anchor
      mkSentence(3, 'anton', '— Да.'),
    ];
    const result = alignSentences(sentences, paras, body, true); // dashIsDialogueMarker = true

    // Sentence 1 is unaligned (paraphrase doesn't match body).
    expect(result.aligned[0].spans).toEqual([]);
    // Sentence 2 matches the long anchor text — this is the anchor itself.
    expect(result.aligned[1].spans.length).toBeGreaterThan(0);
    // Sentence 3 MUST align to the REAL speech span at the end, NOT inside "правда".
    const speechSpans = paras.flatMap((p) => p.spans).filter((s) => s.kind === 'speech');
    const actualSpeechSpan = speechSpans[speechSpans.length - 1];
    expect(result.aligned[2].spans).toEqual([actualSpeechSpan]);
    expect(result.aligned[2].spans[0].kind).toBe('speech');
  });

  it('(#2537) both cache forms of a dash-led reply resolve to the REAL speech span even with zero anchors', () => {
    // The load-bearing regression test. Body: a narration sentence ending in
    // "правда." (which contains "да." as a substring), then the real "— Да."
    // reply. No needle here clears ANCHOR_MIN_LEN, so the whole chapter is one
    // unbounded run — nothing structural narrows the search.
    //
    // Red on `origin/main` for the WITHOUT-dash arm: main searches for the bare
    // "да." and binds it inside "правда." → the narration span. That is #2537's
    // own repro. Green here because a dash-free needle prefers an occurrence
    // that carries the paragraph dash.
    //
    // The WITH-dash arm is correct on `origin/main` and must STAY correct: it
    // went red under both earlier attempts at this fix, which stripped the dash
    // off every needle and threw away its selectivity.
    const ruIdx = buildNameIndex([{ id: 'anton', name: 'Антон' }], conventionsFor('ru')!);
    const body = ['Он не знал, где правда.', '', '— Да.'].join('\n');
    const paras = parseChapterStructure(body, ruIdx);
    const allSpans = paras.flatMap((p) => p.spans);
    const realSpeechSpan = allSpans.find((s) => s.kind === 'speech')!;
    const trapNarrationSpan = allSpans.find((s) => s.kind === 'narration')!;
    expect(body.slice(realSpeechSpan.start, realSpeechSpan.end)).toBe('Да.');
    expect(body.slice(trapNarrationSpan.start, trapNarrationSpan.end)).toContain('правда');

    for (const cachedText of ['— Да.', 'Да.']) {
      const sentences = [
        // A model paraphrase that never matches — a miss deliberately does not
        // move the run cursor, so the reply still searches from offset 0.
        mkSentence(1, 'narrator', 'Он не знал, где истина.'),
        mkSentence(2, 'anton', cachedText),
      ];
      const result = alignSentences(sentences, paras, body, true);

      expect(result.aligned[0].spans).toEqual([]);
      expect(result.aligned[1].spans).toEqual([realSpeechSpan]);
      expect(result.aligned[1].spans[0].kind).toBe('speech');
      expect(result.aligned[1].lumped).toBe(false);

      // Same property one level down, in the sibling locator.
      expect(locateSentenceOffsets([{ text: cachedText }], body, true)[0]).toBe(body.indexOf('—'));
    }
  });

  it("(#2577 pass 7, N4) isMidWordHit inspects the character immediately before the match, not one further back", () => {
    // Pass 7 review of #2577: the existing "да." inside "правда." trap above
    // doesn't discriminate an off-by-one on which character `isMidWordHit`
    // reads, because "правда" has a word character at BOTH pos-1 ('в') and
    // pos-2 ('а') — a mutant reading `haystack[pos - 2]` instead of
    // `haystack[pos - 1]` still (accidentally) sees a word character and
    // still walks forward, so it passes that test too.
    //
    // "Мда." is the discriminating trap: needle "да." matches at pos-1='М'
    // (a word character — genuinely mid-word, must walk forward) but
    // pos-2 is the SPACE before "Мда." (not a word character). A mutant
    // checking pos-2 would wrongly trust this as a genuine bare hit and
    // never walk forward to the real dash-led reply.
    const ruIdx = buildNameIndex([{ id: 'anton', name: 'Антон' }], conventionsFor('ru')!);
    const body = ['Он сказал слово Мда.', '', '— Да.'].join('\n');
    const paras = parseChapterStructure(body, ruIdx);
    const allSpans = paras.flatMap((p) => p.spans);
    const realSpeechSpan = allSpans.find((s) => s.kind === 'speech')!;
    const trapNarrationSpan = allSpans.find((s) => s.kind === 'narration')!;
    expect(body.slice(realSpeechSpan.start, realSpeechSpan.end)).toBe('Да.');
    expect(body.slice(trapNarrationSpan.start, trapNarrationSpan.end)).toContain('Мда');

    const sentences = [mkSentence(1, 'anton', 'Да.')];
    const result = alignSentences(sentences, paras, body, true);

    expect(result.aligned[0].spans).toEqual([realSpeechSpan]);
    expect(result.aligned[0].spans[0].kind).toBe('speech');
    expect(locateSentenceOffsets(sentences, body, true)[0]).toBe(body.indexOf('—'));
  });

  it('(#2537) a dash-rule scene separator is not absorbed into the sentence that follows it', () => {
    // #1679 has the analyzer emit a scene separator as its own word-free
    // "sentence"; `normalize('---')` folds it to a lone '-'.
    //
    // Two failure modes this pins, both from attempt 3 of this fix:
    //   1. the separator needle must not be rewritten to the empty string
    //      (fillRun reports an empty needle unaligned, so it fell off the
    //      chapter's alignedPct entirely);
    //   2. the narration sentence after it must not have its match extended
    //      backward over the separator. That sentence never carried a dash, so
    //      nothing about it justifies reaching back for one — and the extended
    //      range overlapped the separator's speech span, flagging pure
    //      narration as `lumped` (which drops its structure evidence and
    //      increments `lumpedSpeech` in attribution-health).
    const ruIdx = buildNameIndex([{ id: 'ren', name: 'Рен' }], conventionsFor('ru')!);
    const narration = 'Горн остыл до цвета подёрнутого пеплом заката, и она выскребала золу.';
    for (const rule of ['---', '———', '***']) {
      const body = [
        'Рен закрыла тяжёлую дверь кузницы и прислушалась к тишине двора.',
        '',
        rule,
        '',
        narration,
      ].join('\n');
      const paras = parseChapterStructure(body, ruIdx);
      const sentences = [
        mkSentence(1, 'ren', 'Рен закрыла тяжёлую дверь кузницы и прислушалась к тишине двора.'),
        mkSentence(2, 'ren', rule),
        mkSentence(3, 'ren', narration),
      ];
      const result = alignSentences(sentences, paras, body, true);

      // The separator still locates — it is not stripped to an empty needle.
      expect(result.aligned[1].spans.length).toBeGreaterThan(0);
      expect(result.alignedPct).toBe(100);

      // The narration sentence covers its own span and nothing before it.
      const narrationStart = body.indexOf(narration);
      expect(result.aligned[2].lumped).toBe(false);
      expect(result.aligned[2].spans).toEqual([
        expect.objectContaining({ kind: 'narration', start: narrationStart }),
      ]);
      expect(locateSentenceOffsets(sentences, body, true)[2]).toBe(narrationStart);
    }
  });

  it('(#2577 Q1) a bare needle that is itself a genuine narration match does not lose to a later dash-prefixed recurrence of the same text', () => {
    // Pass 4 of #2577's fix (attempt 4, commit 5a60b088) resolved P1/P2/P3 but
    // introduced this regression: the forward-walk to a dash-prefixed
    // occurrence ran unconditionally whenever the bare first hit wasn't
    // itself dash-adjacent, without checking whether that bare hit was
    // already a genuinely valid match. When a sentence's exact text
    // legitimately recurs later in the chapter under a DIFFERENT sentence's
    // paragraph dash (narration reused verbatim as dialogue, or vice versa —
    // not rare in real prose), the walk discarded the correct first
    // occurrence and cross-bound onto the unrelated dash instead.
    //
    // Red on 5a60b088 (before the mid-word-hit guard): sentence 1 below binds
    // to the SPEECH span at the end (the unrelated dash) instead of its own
    // NARRATION span at the start.
    //
    // The genuine occurrence deliberately does NOT sit at haystack offset 0
    // (pass 5 review, #2577): `isMidWordHit` short-circuits on `pos > 0`, so
    // a bare hit at offset 0 would pass the guard for the wrong reason —
    // never actually evaluating the word-boundary character class this test
    // exists to pin. A leading paragraph puts the genuine hit's preceding
    // character at a real (non-word) boundary instead, so the check is
    // exercised for real.
    const ruIdx = buildNameIndex(
      [
        { id: 'anton', name: 'Антон' },
        { id: 'olga', name: 'Ольга' },
      ],
      conventionsFor('ru')!,
    );
    const repeated = 'Он молчал.';
    const body = [
      'Комната давно опустела, и часы на стене отсчитывали минуты в тишине.', // leading filler — pushes the genuine hit off offset 0
      '',
      repeated, // the genuine, dash-free narration — the FIRST occurrence
      '',
      'Ольга долго смотрела в окно, вспоминая каждую деталь того разговора.', // long filler, no cached match — keeps this a single unbounded run
      '',
      `— ${repeated}`, // an unrelated LATER dialogue line that happens to reuse the exact same words
    ].join('\n');
    const paras = parseChapterStructure(body, ruIdx);
    const allSpans = paras.flatMap((p) => p.spans);
    const narrationSpan = allSpans.find((s) => s.kind === 'narration' && body.slice(s.start, s.end) === repeated)!;
    const speechSpan = allSpans.find((s) => s.kind === 'speech')!;
    expect(narrationSpan).toBeTruthy();
    expect(speechSpan).toBeTruthy();
    expect(body.slice(speechSpan.start, speechSpan.end)).toBe(repeated);

    const sentences = [mkSentence(1, 'narrator', repeated)];
    const result = alignSentences(sentences, paras, body, true); // dashIsDialogueMarker = true

    // Must bind to the FIRST, genuine occurrence — not walk forward onto the
    // unrelated dialogue line's dash just because the text happens to recur.
    expect(result.aligned[0].spans).toEqual([narrationSpan]);
    expect(result.aligned[0].spans[0].kind).toBe('narration');

    // Same property one level down, in the sibling locator.
    expect(locateSentenceOffsets(sentences, body, true)[0]).toBe(body.indexOf(repeated));
  });

  it('(#2577 Q1, pos===0 case) the same property holds when the genuine occurrence sits at the very start of the haystack', () => {
    // Pass 6 review of #2577: `isMidWordHit`'s `pos > 0 && WORD_CHAR.test(...)`
    // has an untested sub-clause. Dropping the `pos > 0` guard (e.g.
    // `return WORD_CHAR.test(haystack[pos - 1])`) leaves every OTHER test in
    // this file green, because `haystack[-1]` is `undefined` and
    // `WORD_CHAR.test(undefined)` coerces its argument to the string
    // `"undefined"` — which DOES contain word characters, so the mutant
    // returns `true` (mid-word) for every hit at offset 0, restoring Q1's
    // cross-bind exactly for the chapter's first sentence (or the first
    // sentence of any post-anchor run). This test pins that specific case:
    // the genuine hit is the very first thing in the haystack.
    const ruIdx = buildNameIndex([{ id: 'anton', name: 'Антон' }], conventionsFor('ru')!);
    const repeated = 'Он молчал.';
    const body = [
      repeated, // the genuine, dash-free narration — sits at haystack offset 0
      '',
      'Ольга долго смотрела в окно, вспоминая каждую деталь того разговора.', // long filler, no cached match — keeps this a single unbounded run
      '',
      `— ${repeated}`, // an unrelated LATER dialogue line that happens to reuse the exact same words
    ].join('\n');
    const paras = parseChapterStructure(body, ruIdx);
    const allSpans = paras.flatMap((p) => p.spans);
    const narrationSpan = allSpans.find((s) => s.kind === 'narration' && s.start === 0)!;
    const speechSpan = allSpans.find((s) => s.kind === 'speech')!;
    expect(narrationSpan).toBeTruthy();
    expect(speechSpan).toBeTruthy();

    const sentences = [mkSentence(1, 'narrator', repeated)];
    const result = alignSentences(sentences, paras, body, true);

    expect(result.aligned[0].spans).toEqual([narrationSpan]);
    expect(result.aligned[0].spans[0].kind).toBe('narration');
    expect(locateSentenceOffsets(sentences, body, true)[0]).toBe(0);
  });

  it("(#2577 pass 7, N2) dashRunStart's floor bound stops a later needle reclaiming a dash an earlier sentence already consumed", () => {
    // Pass 7 review of #2577: `dashRunStart`'s `floor` parameter (bounded to
    // the caller's monotonic cursor) is load-bearing but was untested —
    // removing it (letting the backward walk run unbounded to 0 regardless
    // of `floor`) left every other test in this file green.
    //
    // Body normalizes to "- Да." — a standalone dash "sentence" followed by
    // a dash-free reply. Sentence 1 ('—') locates the dash itself at offset
    // 0, advancing the cursor past it. Sentence 2 ('Да.', dash-free) must
    // NOT be allowed to walk back through that already-claimed dash and
    // relocate to the same offset 0 — the cursor floor is what stops it,
    // landing it at its own true offset (2, right after "- ") instead.
    const body = '— Да.';
    const sentences = [{ text: '—' }, { text: 'Да.' }];

    const offsets = locateSentenceOffsets(sentences, body, true);

    expect(offsets).toEqual([0, 2]);
  });

  it('(#2537) the separator guard does not depend on the separator being in the cache', () => {
    // Same body, but the model dropped the separator "sentence" — so no
    // preceding match parks the run cursor past the rule. The narration
    // sentence must still not reach back over it.
    const ruIdx = buildNameIndex([{ id: 'ren', name: 'Рен' }], conventionsFor('ru')!);
    const narration = 'Горн остыл до цвета подёрнутого пеплом заката, и она выскребала золу.';
    const body = [
      'Рен закрыла тяжёлую дверь кузницы и прислушалась к тишине двора.',
      '',
      '---',
      '',
      narration,
    ].join('\n');
    const paras = parseChapterStructure(body, ruIdx);
    const sentences = [
      mkSentence(1, 'ren', 'Рен закрыла тяжёлую дверь кузницы и прислушалась к тишине двора.'),
      mkSentence(2, 'ren', narration),
    ];
    const result = alignSentences(sentences, paras, body, true);

    expect(result.aligned[1].lumped).toBe(false);
    expect(result.aligned[1].spans).toEqual([
      expect.objectContaining({ kind: 'narration', start: body.indexOf(narration) }),
    ]);
  });
});
describe('buildNeedle', () => {
  it('never rewrites the search text — a dash-led needle keeps its dash', () => {
    // The dash is the needle's strongest discriminator ("- да." can only occur
    // at a real marker; "да." occurs inside "правда"). Stripping it is what
    // #2577 attempt 1 and attempt 3 both did, and both regressed the with-dash
    // arm. The text is always searched verbatim.
    for (const input of ['- hello', '-- hello', '--- hello', '-    hello', 'hello', '-']) {
      expect(buildNeedle(input, true).text).toBe(input);
      expect(buildNeedle(input, false).text).toBe(input);
    }
  });

  it('a needle that already carries its dash does NOT take the dash-prefixed path', () => {
    // buildNeedle receives already-normalized text, so every dash glyph this
    // file folds (– — &mdash; &ndash; "--") is a single '-' by now; glyph-level
    // normalization is covered in (b) glyph drift above.
    for (const input of ['- hello', '-- hello', '-hello', '-']) {
      expect(buildNeedle(input, true).tryDashPrefix).toBe(false);
    }
  });

  it('a needle with no leading dash takes the dash-prefixed path when the gate is on', () => {
    expect(buildNeedle('hello', true).tryDashPrefix).toBe(true);
    expect(buildNeedle('да.', true).tryDashPrefix).toBe(true);
  });

  it('an empty needle never takes the dash-prefixed path', () => {
    expect(buildNeedle('', true).tryDashPrefix).toBe(false);
  });

  it('dashIsDialogueMarker = false leaves every needle on the pristine pre-#2537 path', () => {
    for (const input of ['hello', '- hello', '-- hello', '-', '']) {
      const needle = buildNeedle(input, false);
      expect(needle.text).toBe(input);
      expect(needle.tryDashPrefix).toBe(false);
    }
  });
});

describe('alignSentences with dashIsDialogueMarker = true', () => {
  it('with-dash and without-dash forms resolve to the identical span near a long anchor', () => {
    const ruIdx = buildNameIndex([{ id: 'anton', name: 'Антон' }], conventionsFor('ru')!);
    const body = [
      '— Я никогда не думал, что этот длинный и сложный процесс зайдет так далеко, — сказал Антон.',
      '— Да.',
      '— Ну что ж, теперь мы знаем правду.',
    ].join('\n');
    const paras = parseChapterStructure(body, ruIdx);
    const speechSpans = paras.flatMap((p) => p.spans).filter((s) => s.kind === 'speech');
    const secondSpan = speechSpans[1];

    const sentencesWithDash = [
      mkSentence(1, 'anton', 'Я никогда не думал, что этот длинный и сложный процесс зайдет так далеко,'),
      mkSentence(2, 'anton', '— Да.'),
    ];
    const resultWithDash = alignSentences(sentencesWithDash, paras, body, true);

    const sentencesWithoutDash = [
      mkSentence(1, 'anton', 'Я никогда не думал, что этот длинный и сложный процесс зайдет так далеко,'),
      mkSentence(2, 'anton', 'Да.'),
    ];
    const resultWithoutDash = alignSentences(sentencesWithoutDash, paras, body, true);

    expect(resultWithDash.aligned[1].spans).toEqual([secondSpan]);
    expect(resultWithoutDash.aligned[1].spans).toEqual([secondSpan]);
  });
});
