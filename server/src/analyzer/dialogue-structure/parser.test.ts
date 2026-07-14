import { describe, expect, it } from 'vitest';
import { conventionsFor } from './lang/index.js';
import { buildNameIndex } from './name-matcher.js';
import { anchorSpansFromTags, parseChapterStructure } from './parser.js';
import type { SpanEvidence } from './types.js';

const ru = conventionsFor('ru')!;
const idx = buildNameIndex([{ id: 'anton', name: 'Антон' }, { id: 'olga', name: 'Ольга' }], ru);
const spansOf = (paras: ReturnType<typeof parseChapterStructure>) => paras.flatMap((p) => p.spans);

describe('parser — ru dash-dialogue', () => {
  it('dash-dialogue: paragraph-leading dash opens speech; plain paragraph is narration', () => {
    const paras = parseChapterStructure('— Привет.\nОн вошёл в комнату.', idx);
    expect(paras[0].kind).toBe('dialogue');
    expect(paras[1].kind).toBe('narration');
  });
  it('dash-dialogue: ", — сказал Антон." closes speech, opens tag, anchors speaker', () => {
    const paras = parseChapterStructure('— Привет, — сказал Антон.', idx);
    const spans = spansOf(paras);
    expect(spans.map((s) => s.kind)).toEqual(['speech', 'tag']);
    expect(spans[0].speaker).toEqual({ characterId: 'anton', source: 'tag-name' });
  });
  it('dash-dialogue: ". — Речь" after a tag resumes speech with the SAME speaker (continuation)', () => {
    const paras = parseChapterStructure('— Привет, — сказал Антон. — Как дела?', idx);
    const spans = spansOf(paras);
    expect(spans.map((s) => s.kind)).toEqual(['speech', 'tag', 'speech']);
    expect(spans[2].speaker?.characterId).toBe('anton');
  });
  it('dash-dialogue: two dash-tag cycles for DIFFERENT speakers never cross-anchor (regression)', () => {
    const paras = parseChapterStructure('— A, — сказал Антон. — B, — сказала Ольга.', idx);
    const speech = spansOf(paras).filter((s) => s.kind === 'speech');
    expect(speech).toHaveLength(2);
    expect(speech[0].speaker).toEqual({ characterId: 'anton', source: 'tag-name' });
    expect(speech[1].speaker).toEqual({ characterId: 'olga', source: 'tag-name' });
  });
  it('dash-dialogue: multi-sentence speech stays ONE speech span (no dash on 2nd sentence)', () => {
    const paras = parseChapterStructure('— Привет. Давно не виделись.', idx);
    expect(spansOf(paras).map((s) => s.kind)).toEqual(['speech']);
  });
  it('dash-dialogue: interior punctuation dash does NOT toggle (X — это Y)', () => {
    const paras = parseChapterStructure('— Сумрак — это не место, а состояние.', idx);
    expect(spansOf(paras).map((s) => s.kind)).toEqual(['speech']);
  });
  it('dash-dialogue: candidate tag clause with NO verb match → remainder unanchored, never split', () => {
    const paras = parseChapterStructure('— Привет, — Ольга насмешливо посмотрела в окно.', idx);
    const speech = spansOf(paras).filter((s) => s.kind === 'speech');
    expect(speech[0].speaker?.source ?? 'unanchored').toBe('unanchored');
  });
  it('dash-dialogue: beat verb also anchors ("— Да, — кивнула Ольга.")', () => {
    const paras = parseChapterStructure('— Да, — кивнула Ольга.', idx);
    expect(spansOf(paras)[0].speaker).toEqual({ characterId: 'olga', source: 'tag-name' });
  });
  it('dash-dialogue: TAG_OPEN fires (lowercase after dash) but clause has no speech/beat verb → downgrade to one unanchored span', () => {
    const paras = parseChapterStructure('— Привет, — тихо посмотрела Ольга в окно.', idx);
    const spans = spansOf(paras);
    expect(spans).toHaveLength(1);
    expect(spans[0].kind).toBe('speech');
    expect(spans[0].speaker).toBeUndefined();
  });
  it('dash-dialogue: pronoun-only tag sets pendingPronoun, not speaker ("— Привет, — ответила она.")', () => {
    const paras = parseChapterStructure('— Привет, — ответила она.', idx);
    const speech = spansOf(paras).filter((s) => s.kind === 'speech');
    expect(speech[0].speaker).toBeUndefined();
    expect((speech[0] as SpanEvidence & { pendingPronoun?: string }).pendingPronoun).toBe('female');
  });
  it('dash-dialogue: a later pronoun-only tag\'s span is NOT clobbered by an earlier named tag\'s forward-fill (regression)', () => {
    const paras = parseChapterStructure('— A, — сказал Антон. — B, — сказала она.', idx);
    const speech = spansOf(paras).filter((s) => s.kind === 'speech');
    expect(speech).toHaveLength(2);
    expect(speech[0].speaker).toEqual({ characterId: 'anton', source: 'tag-name' });
    expect(speech[1].speaker).toBeUndefined();
    expect((speech[1] as SpanEvidence & { pendingPronoun?: string }).pendingPronoun).toBe('female');
  });
  it('dash-dialogue: &mdash; entity leakage treated as a dash', () => {
    const paras = parseChapterStructure('&mdash; Привет.', idx);
    expect(paras[0].kind).toBe('dialogue');
  });
  it('offsets are absolute into the body and spans tile the paragraph', () => {
    const body = 'Он вошёл.\n— Привет, — сказал Антон.';
    const paras = parseChapterStructure(body, idx);
    for (const p of paras) for (const s of p.spans) {
      expect(s.start).toBeGreaterThanOrEqual(p.start);
      expect(s.end).toBeLessThanOrEqual(p.end);
    }
    expect(body.slice(paras[1].spans[0].start, paras[1].spans[0].end)).toContain('Привет');
  });
});

describe('parser — quote conventions', () => {
  const enIdx = buildNameIndex([{ id: 'halloran', name: 'Halloran' }, { id: 'marcus', name: 'Marcus' }], conventionsFor('en')!);
  it('en quotes: "…," he said splits quote → speech, tail → tag, anchored by name', () => {
    const paras = parseChapterStructure('“Hard to starboard,” Halloran said.', enIdx);
    const spans = paras[0].spans;
    expect(spans.map((s) => s.kind)).toEqual(['speech', 'tag']);
    expect(spans[0].speaker).toEqual({ characterId: 'halloran', source: 'tag-name' });
  });
  it('en quotes: multi-turn paragraph yields one speech span PER quoted run', () => {
    const paras = parseChapterStructure('Marcus turned. “Get below,” he muttered. “Now.” The deck pitched.', enIdx);
    const speech = paras[0].spans.filter((s) => s.kind === 'speech');
    expect(speech.length).toBe(2);
  });
  it('ru guillemet (coalfall.ru shape): «…, — сказал X. — …» inside a narration paragraph anchors', () => {
    const ruIdx = buildNameIndex([{ id: 'mairin', name: 'Майрин' }], conventionsFor('ru')!);
    const paras = parseChapterStructure('«Осторожнее, — сказала Майрин. — Здесь скользко».', ruIdx);
    const speech = paras[0].spans.filter((s) => s.kind === 'speech');
    expect(speech.length).toBe(2);
    expect(speech.every((s) => s.speaker?.characterId === 'mairin')).toBe(true);
  });
  it('quote-free narration paragraph is never mislabeled as tag (regression — the zero-quote-run whole-paragraph fallback span must never reclassify to `tag`, even when it contains a verb/beat stem like "smiled")', () => {
    const paras = parseChapterStructure('She smiled and walked away.', enIdx);
    expect(paras[0].kind).toBe('narration');
    expect(paras[0].spans).toHaveLength(1);
    expect(paras[0].spans[0].kind).toBe('narration');
  });

  /* #1598 — German „…" collapse. Our translated demo books open with U+201E „
     but CLOSE with an ASCII " (U+0022), not the typographic U+201C “. Before the
     de.ts quotePairs fix, `„…"` never formed a quote run, so every reply parsed
     as narration and the cross-examiner demoted the whole chapter to the
     narrator (~3% non-narrator coverage vs ~50% for en/fr/ru). These pin the
     ASCII-closer pairing; en must not regress (U+201C stays an OPENER there). */
  const deIdx = buildNameIndex(
    [{ id: 'oduvan', name: 'Oduvan' }, { id: 'maerin', name: 'Maerin' }],
    conventionsFor('de')!,
  );
  it('de quotes: „…" with an ASCII closer forms a speech run, tail → tag, anchored by name (#1598)', () => {
    const paras = parseChapterStructure('„Lass es", sagte Meister Oduvan.', deIdx);
    const spans = paras[0].spans;
    expect(paras[0].kind).toBe('dialogue');
    expect(spans.map((s) => s.kind)).toEqual(['speech', 'tag']);
    expect(spans[0].speaker).toEqual({ characterId: 'oduvan', source: 'tag-name' });
  });
  it('de quotes: multi-turn „…" paragraph yields one speech span PER quoted run (#1598)', () => {
    const paras = parseChapterStructure('„Nein, Kind." Maerin lächelte nicht. „Ein echter."', deIdx);
    const speech = paras[0].spans.filter((s) => s.kind === 'speech');
    expect(speech.length).toBe(2);
  });
  it('de quotes: typographic „…" (U+201C closer) still pairs (correct-typography German)', () => {
    const paras = parseChapterStructure('„Es könnte ein Kunde sein.“', deIdx);
    expect(paras[0].kind).toBe('dialogue');
    expect(paras[0].spans.some((s) => s.kind === 'speech')).toBe(true);
  });
  it('de quotes: MIXED closers in one paragraph (typographic “ then ASCII ") stay two runs — a „ run ends at the NEAREST closer of ANY glyph, not a same-glyph closer past it (#1601)', () => {
    const line = '„Nein.“ Maerin schwieg. „Ein echter."';
    const paras = parseChapterStructure(line, deIdx);
    const speech = paras[0].spans.filter((s) => s.kind === 'speech');
    expect(speech.map((s) => line.slice(s.start, s.end))).toEqual(['Nein.', 'Ein echter.']);
    // the beat between the turns survives — never swallowed into the first run
    expect(paras[0].spans.some((s) => line.slice(s.start, s.end).includes('Maerin schwieg'))).toBe(true);
  });
  it('de quotes: a stray ASCII " (inch-mark) after a typographic „…“ run does NOT extend the run into narration (#1601)', () => {
    const line = '„Hallo.“ Er war 5" groß.';
    const paras = parseChapterStructure(line, deIdx);
    const speech = paras[0].spans.filter((s) => s.kind === 'speech');
    expect(speech.map((s) => line.slice(s.start, s.end))).toEqual(['Hallo.']);
    // the narration after the run (incl. the stray inch-mark) is NOT part of speech
    expect(speech[0] && line.slice(speech[0].start, speech[0].end)).not.toContain('Er war');
  });
  it('en quotes: U+201C stays an OPENER — a bare ASCII " does NOT close a “…” run (de fix must not leak into en)', () => {
    // “Hello" — U+201C open, ASCII close. en's pairs are “…”, "…", ‘…’; no
    // „…" pair exists, and U+201C never closes anything in en. The paragraph
    // must remain a single narration span (no phantom speech run).
    const paras = parseChapterStructure('“Hello, world.', enIdx);
    expect(paras[0].spans.filter((s) => s.kind === 'speech')).toHaveLength(0);
  });
});

describe('parser — ja quote conventions (CJK, fs-59 W3)', () => {
  const jaIdx = buildNameIndex([{ id: 'tanaka', name: '田中' }], conventionsFor('ja')!);
  it('ja quotes: 「気をつけて」と彼女は言った。 — quote run anchors as speech, "と…言った" reclassifies to tag, pronoun 彼女 sets pendingPronoun (speaker resolution is windows.ts\'s job, not the parser\'s — same contract as the ru pronoun-only-tag case above)', () => {
    const paras = parseChapterStructure('「気をつけて」と彼女は言った。', jaIdx);
    const spans = paras[0].spans;
    expect(spans.map((s) => s.kind)).toEqual(['speech', 'tag']);
    expect(spans[0].speaker).toBeUndefined();
    expect((spans[0] as SpanEvidence & { pendingPronoun?: string }).pendingPronoun).toBe('female');
  });

  // NOTE (independent-review, §2.1): 彼女 is a *pronoun* — it resolves via the
  // pronoun regex above and masks the fact that NAME-tag anchoring is broken
  // for CJK. findRosterName (name-matcher.ts) tokenizes on `[^\p{L}]+`, which
  // never splits contiguous CJK text with no inter-word spacing — the whole
  // "と田中は言った" reads as ONE token, never matching the roster's "田中"
  // stem. This case is the driver for Task 3.5 (CJK roster-name tag anchoring).
  it('ja quotes: roster NAME tag anchors 「わかった」と田中は言った。 → 田中', () => {
    const paras = parseChapterStructure('「わかった」と田中は言った。', jaIdx);
    const spans = paras[0].spans;
    expect(spans.map((s) => s.kind)).toEqual(['speech', 'tag']);
    expect(spans[0].speaker).toEqual({ characterId: 'tanaka', source: 'tag-name' });
  });
});

describe('anchorSpansFromTags — anchoring contract (Finding 3)', () => {
  it('a leading tag with no preceding speech never reaches forward past its own following-window to steal a later, legitimate tag\'s speech span (regression: the old lastSpeech-fallback tracker, removed in the anchorSpansFromTags extraction, would have let it)', () => {
    // Hand-built spans array (not derived from real text) so the shape is
    // pinned exactly: tagA has NO preceding speech AND nothing between it
    // and tagB (its following-window is empty), so under the current
    // backward-scan-only anchoring it can claim nothing. speechC sits right
    // after tagB and is tagB's own legitimate Phase-2 claim. The old
    // `?? lastSpeech` fallback (a single global "last speech pushed",
    // captured once after the whole span array was built) would have let
    // tagA reach forward across tagB and steal speechC for the wrong
    // speaker, since it never bounded the fallback to tagA's own window.
    const partA = 'Тут сказал Антон. ';
    const partB = 'Тут сказала Ольга. ';
    const partC = 'Привет, мир.';
    const line = partA + partB + partC;
    const tagA: SpanEvidence = { kind: 'tag', start: 0, end: partA.length };
    const tagB: SpanEvidence = { kind: 'tag', start: partA.length, end: partA.length + partB.length };
    const speechC: SpanEvidence = { kind: 'speech', start: partA.length + partB.length, end: line.length };
    const spans = [tagA, tagB, speechC];
    anchorSpansFromTags(spans, line, 0, idx);
    expect(speechC.speaker).toEqual({ characterId: 'olga', source: 'tag-name' });
  });
});
