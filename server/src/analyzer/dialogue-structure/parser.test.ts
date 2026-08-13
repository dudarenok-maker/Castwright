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

describe('A1 — weak tag strength (beat-only quote gaps)', () => {
  const enIdx = () =>
    buildNameIndex([{ id: 'anton', name: 'Anton' }], conventionsFor('en')!);

  const firstSpeaker = (paras: ReturnType<typeof parseChapterStructure>) =>
    paras.flatMap((p) => p.spans).find((s) => s.kind === 'speech' && s.speaker)?.speaker;

  it('a beat-only quote-gap tag is marked strength: weak', () => {
    const paras = parseChapterStructure('"Stop." Anton frowned.', enIdx());
    expect(firstSpeaker(paras)).toMatchObject({ characterId: 'anton', source: 'tag-name', strength: 'weak' });
  });

  it('a speech-verb quote tag stays strong (no strength field)', () => {
    const paras = parseChapterStructure('"Hi," Anton said.', enIdx());
    const sp = firstSpeaker(paras);
    expect(sp).toMatchObject({ characterId: 'anton', source: 'tag-name' });
    expect(sp?.strength).toBeUndefined();
  });

  it('a dash-interior beat tag stays strong (Russian кивнул path)', () => {
    const ruIdx = buildNameIndex([{ id: 'anton', name: 'Антон' }], conventionsFor('ru')!);
    const paras = parseChapterStructure('— Да, — кивнул Антон.', ruIdx);
    const sp = firstSpeaker(paras);
    expect(sp).toMatchObject({ characterId: 'anton', source: 'tag-name' });
    expect(sp?.strength).toBeUndefined();
  });
});

describe('applyTag — addressee/bystander gate (opt-in languages)', () => {
  const en = conventionsFor('en')!;
  const speech = (body: string, nameIdx: ReturnType<typeof buildNameIndex>) =>
    parseChapterStructure(body, nameIdx)[0].spans.find((s) => s.kind === 'speech');

  it('addressee name does not become a tag-name speaker (en)', () => {
    const idx = buildNameIndex(
      [
        { id: 'skulduggery', name: 'Skulduggery' },
        { id: 'valkyrie', name: 'Valkyrie' },
      ],
      en,
    );
    const sp = speech('“Fireball,” he said to Valkyrie.', idx);
    expect(sp?.speaker).toBeUndefined(); // not force-anchored to Valkyrie
    expect((sp as any)?.pendingPronoun).toBe('male'); // falls through to pronoun `he`
  });

  it('subject name still anchors strong (en)', () => {
    const idx = buildNameIndex([{ id: 'sanguine', name: 'Sanguine', aliases: ['Sanguine'] }], en);
    const sp = speech('“Curse you,” Sanguine said.', idx);
    expect(sp?.speaker).toEqual({ characterId: 'sanguine', source: 'tag-name' });
  });

  it('opt-in gate: a convention lacking addresseePrepositions stays on the legacy findRosterName route (byte-identical for unsupported languages)', () => {
    const stub = { ...en, addresseePrepositions: undefined, tagClauseConjunctions: undefined };
    const idx = buildNameIndex(
      [
        { id: 'skulduggery', name: 'Skulduggery' },
        { id: 'valkyrie', name: 'Valkyrie' },
      ],
      stub,
    );
    const sp = speech('“Fireball,” he said to Valkyrie.', idx);
    expect(sp?.speaker).toEqual({ characterId: 'valkyrie', source: 'tag-name' });
  });
});

describe('parser — findQuoteRuns candidate scan (characterisation, #2288 Task 1)', () => {
  const enIdx = buildNameIndex([{ id: 'mary', name: 'Mary' }], conventionsFor('en')!);
  const deIdx = buildNameIndex([{ id: 'anna', name: 'Anna' }], conventionsFor('de')!);
  const zhIdx = buildNameIndex([{ id: 'li', name: '李' }], conventionsFor('zh')!);
  const speechOf = (body: string, idx: ReturnType<typeof buildNameIndex>) =>
    parseChapterStructure(body, idx)
      .flatMap((p) => p.spans)
      .filter((s) => s.kind === 'speech')
      .map((s) => body.slice(s.start, s.end));

  it('de: a `„` run ends at the NEAREST of its closers, per turn (#1601)', () => {
    expect(speechOf('„Hallo", rief sie. „Nein", sagte er.', deIdx)).toEqual(['Hallo', 'Nein']);
  });
  it('de: a differently-classed nested run stays inside its outer run', () => {
    expect(speechOf('„Er sagte »hallo« zu mir“, berichtete sie.', deIdx)).toEqual([
      'Er sagte »hallo« zu mir',
    ]);
  });
  it('en: nesting resolves to the OUTER run', () => {
    expect(speechOf('“He said ‘hi’ to me,” she reported.', enIdx)).toEqual(['He said ‘hi’ to me,']);
  });
  it('en: a same-glyph pair still pairs', () => {
    expect(speechOf('He said "nothing at all" and left.', enIdx)).toEqual(['nothing at all']);
  });
  it('zh: nesting resolves to the OUTER run', () => {
    expect(speechOf('“他说‘你好’然后走了”', zhIdx)).toEqual(['他说‘你好’然后走了']);
  });
});

describe('parser — #2288 an apostrophe is not a closing quote (en)', () => {
  const idx = buildNameIndex([{ id: 'mary', name: 'Mary' }], conventionsFor('en')!);
  const speechOf = (body: string) =>
    parseChapterStructure(body, idx)
      .flatMap((p) => p.spans)
      .filter((s) => s.kind === 'speech')
      .map((s) => body.slice(s.start, s.end));

  // (1) a cased letter on BOTH sides — the contraction and the name
  it('a contraction does not end a single-quoted turn', () => {
    expect(speechOf('‘I don’t know,’ she said.')).toEqual(['I don’t know,']);
  });
  it('two single-quoted turns each survive their contraction', () => {
    expect(speechOf('‘We can’t go back,’ said Mary. ‘It isn’t safe.’')).toEqual([
      'We can’t go back,',
      'It isn’t safe.',
    ]);
  });
  it('an apostrophe inside a name does not end the turn', () => {
    expect(speechOf('‘Ask O’Brien,’ she said.')).toEqual(['Ask O’Brien,']);
  });

  // (1b) same shape as above, but NFD-decomposed: the base letter before the
  // apostrophe and its combining mark are separate code points, so `\p{L}`
  // alone (pre-round-2) misses the mark and reads "not a letter" — the
  // original #2288 bug, unfixed, for any manuscript that arrives decomposed
  // (this path has no NFC-normalisation guarantee). Built with `.normalize`
  // rather than typed pre-composed so an editor can't silently re-compose it.
  it('a contraction survives even when the manuscript is NFD-decomposed (combining marks)', () => {
    const body = '‘I saw André’s car,’ she said.'.normalize('NFD');
    expect(speechOf(body)).toEqual(['I saw André’s car,'.normalize('NFD')]);
  });

  // (2) whitespace-then-letter — elision that OPENS a word
  it('a leading-elision apostrophe does not end the turn', () => {
    expect(speechOf('‘Give ’em back,’ she said, ‘’cause they’re mine.’')).toEqual([
      'Give ’em back,',
      '’cause they’re mine.',
    ]);
  });

  // (3) opener-then-letter — turn-initial elision, which would otherwise
  //     close on an EMPTY interior and produce no speech span at all
  it('a turn-initial elision does not destroy the turn', () => {
    expect(speechOf('‘’Tis nothing,’ he said.')).toEqual(['’Tis nothing,']);
  });

  // controls — each input has exactly one closer-glyph occurrence per
  // opener, so the never-delete fallback restores that same closer even if
  // isRealCloser were mutated to reject unconditionally: these two tests
  // pass either way and do NOT discriminate accept from reject. What they
  // DO guard: a broken opener set, a broken sort/cursor loop, or the wrong
  // glyphs entering APOSTROPHE_SHAPED. The five tests above are the ones
  // that actually distinguish "closer accepted" from "closer rejected".
  it('CONTROL: single-quoted turns with no apostrophe are unchanged', () => {
    expect(speechOf('‘Hello,’ he said. ‘Goodbye,’ she said.')).toEqual(['Hello,', 'Goodbye,']);
  });
  it('CONTROL: a double-quoted turn containing a contraction is unchanged', () => {
    expect(speechOf('“I don’t know,” she said.')).toEqual(['I don’t know,']);
  });
});

describe('parser — #2288 a rule may move a run boundary, never delete a run', () => {
  const idx = buildNameIndex([{ id: 'mary', name: 'Mary' }], conventionsFor('en')!);
  const speechOf = (body: string) =>
    parseChapterStructure(body, idx)
      .flatMap((p) => p.spans)
      .filter((s) => s.kind === 'speech')
      .map((s) => body.slice(s.start, s.end));

  // All three bodies below are REAL corpus paragraphs from
  // se/anne-parrish_the-perennial-bachelor.epub. Each is an inner quotation
  // whose ONLY `’` is a contraction, so every closer is rejected and the run
  // vanishes unless the fallback restores it. Verified: each returns [] under
  // the Step 3 mutation.
  it('a quotation whose only closer is a contraction keeps its (truncated) turn', () => {
    expect(speechOf('“ ‘Shoo fly! Don’t bother me!')).toEqual(['Shoo fly! Don']);
  });

  it('the same, for a possessive', () => {
    expect(speechOf('“ ‘Ping Wing, the Pieman’s son,')).toEqual(['Ping Wing, the Pieman']);
  });

  it('the same, for a dialect elision', () => {
    expect(speechOf('“ ‘The strife is o’er, the battle done;')).toEqual(['The strife is o']);
  });

  it('a turn whose only closer is an apostrophe is truncated, never dropped', () => {
    // `’` in O’Brien is the sole `’`; the fallback restores it as the closer.
    // Without the fallback the outer run vanishes and the NESTED “hi” is
    // promoted to a top-level turn — a silent, wrong speaker change.
    expect(speechOf('‘He said “hi” to O’Brien.')).toEqual(['He said “hi” to O']);
  });

  it('the same, for a leading-elision-only paragraph', () => {
    expect(speechOf('‘He said “hi” ’cause he was late.')).toEqual(['He said “hi” ']);
  });

  // Each body's every `’` is a contraction/possessive/dialect-elision — no
  // later `’` sits after punctuation — so each individually goes to `[]`
  // under the Step 3 mutation. Asserted as exact arrays, not lengths: a
  // length check alone would still pass on a wrongly-promoted nested run
  // (same speaker-changed silently, same run count) — see the two tests
  // above, which is exactly why that shape is asserted there instead.
  // Two similarly-shaped candidates were tried and rejected here: `‘’Twas
  // raining hard…` and `‘’Cause nobody asked…`. Both have their sole `’`
  // immediately after the opener, so the run interior is empty and the
  // span-builder drops it — they return `[]` with AND without the Step 3
  // fallback, discriminating nothing between the two.
  it.each([
    ['‘She wouldn’t say why.', ['She wouldn']],
    ['‘That is Sam’s coat.', ['That is Sam']],
    ['‘We shall ne’er surrender.', ['We shall ne']],
    ['‘Don’t you dare say it.', ['Don']],
    ['‘It wasn’t my fault, he claimed.', ['It wasn']],
  ] as const)('a paragraph whose only closer is rejected keeps its truncated turn: %s', (body, expected) => {
    expect(speechOf(body)).toEqual(expected);
  });
});

describe('parser — #2288 known limits (asserted at CURRENT behaviour, not desired)', () => {
  const idx = buildNameIndex([{ id: 'mary', name: 'Mary' }], conventionsFor('en')!);
  const speechOf = (body: string) =>
    parseChapterStructure(body, idx)
      .flatMap((p) => p.spans)
      .filter((s) => s.kind === 'speech')
      .map((s) => body.slice(s.start, s.end));

  it('NOT FIXED: a possessive-plural apostrophe still ends the turn early', () => {
    // `boys’` has a letter before and a SPACE after, so none of the three
    // shapes in isRealCloser fires. Locally indistinguishable from a real
    // closer. Desired output is ['It was the boys’ fault,']; flip this test
    // when that is fixed.
    expect(speechOf('‘It was the boys’ fault,’ she said.')).toEqual(['It was the boys']);
  });

  it('NOT FIXED: German »…« emphasis glued to a word still forms a run', () => {
    // `»` immediately followed by `Frühstücks` and closed by `«` glued to
    // `schiff` reads as one quote run around the emphasised compound.
    // Desired output is [] (no speech span at all — this is emphasis, not
    // dialogue); flip this test when that is fixed.
    const deIdx = buildNameIndex([{ id: 'anna', name: 'Anna' }], conventionsFor('de')!);
    const body = 'Woher aber der Name »Frühstücks«schiff?';
    const speech = parseChapterStructure(body, deIdx)
      .flatMap((p) => p.spans)
      .filter((s) => s.kind === 'speech')
      .map((s) => body.slice(s.start, s.end));
    expect(speech).toEqual(['Frühstücks']);
  });

  it('NOT FIXED: same-glyph nesting splits into two truncated fragments, not one long turn', () => {
    // The inner `‘dare’` is a second occurrence of the SAME opener/closer
    // glyphs as the outer run, so the rejected-closer resumed-skip bound
    // (#2288 Critical: a rejected closer's resumed skip stops at the next
    // opener of any class) treats the second `‘` as the boundary of the
    // outer run's search. The
    // outer run's only closer candidate before that boundary is the rejected
    // `Don’t` apostrophe, so NEVER-DELETE falls back to it, truncating to
    // "Don". The second `‘` then starts its OWN run, whose first closer
    // (`dare’` — letter before, space after, no isRealCloser clause fires)
    // is accepted immediately, yielding "dare" as a separate turn. The scan
    // is single-glyph and non-stacking, so it cannot disambiguate an inner
    // same-glyph pair from the outer one regardless of the rule — no turn is
    // destroyed, but "leave," is lost from both fragments. Desired output is
    // ['Don’t you ‘dare’ leave,']; flip this test if same-glyph nesting is
    // ever disambiguated (would need a stacking scan, out of scope for #2288).
    expect(speechOf('‘Don’t you ‘dare’ leave,’ she said.')).toEqual(['Don', 'dare']);
  });

  it('NOT FIXED (under-repair, not regression): a dash-preceded elision apostrophe still ends the turn early', () => {
    // Real corpus paragraph, `se/joseph-conrad_chance.epub`, hand-adjudicated
    // as the bound's nearest miss. `’pon`'s apostrophe is preceded by an em
    // dash, which is neither a cased letter (clause 1) nor whitespace/bracket
    // (clause 2), so `isRealCloser` accepts it as a genuine closer and the
    // scan stops there — one apostrophe short of the turn's real end.
    //
    // This is an UNDER-repair, not a regression: `main` truncates this
    // paragraph to ['It'], this rule gives ['It’s like being in jail—'] —
    // strictly longer, still entirely speech, never narration, never a lost
    // turn. Desired output is ['It’s like being in jail—’pon my word. I
    // suppose that man is out there waiting for you. Head jailer! Ough!'];
    // flip this test when that is fixed.
    //
    // A widened elision clause (treating a dash before the apostrophe the
    // same as whitespace) was implemented and measured against this exact
    // shape: corpus-identical apart from repairing this one paragraph, but a
    // synthetic interrupted-turn probe reproduces the same
    // narration-swallowing over-run through a dash-preceded glued closer, and
    // well-typeset public-domain prose systematically lacks the
    // missing-space-after-closer defect that would exercise the new
    // rejection branch — so a corpus zero cannot clear it. Rejected.
    expect(
      speechOf(
        '‘It’s like being in jail—’pon my word. I suppose that man is out there waiting for you. Head jailer! Ough!’',
      ),
    ).toEqual(['It’s like being in jail—']);
  });

  it('NOT FIXED: an inch mark between the elided contraction and the closer still caps the scan', () => {
    // Neither anchor (an interior-start-anchored bound or the shipped
    // at-rejection-anchored bound) fixes this: `nearestOpenerAtOrAfter`
    // (parser.ts) computes the bound from the raw opener set —
    // `conventionsFor('en').quotePairs`'s openers — with no validity check of
    // its own, and `en`'s table carries `"` as an opener (it pairs with
    // itself), so the `"` in `6"` caps the search exactly like a real opener
    // would, regardless of where the bound is anchored. Desired output is
    // ["It’s 6" long,"]; flip this test when that is fixed. A unit-mark
    // opener rule (rejecting `"`/`'`/`’` as an opener when digit-preceded)
    // was measured and rejected earlier in this design: 0 repairs, 4 losses.
    expect(speechOf('‘It’s 6" long,’ he said.')).toEqual(['It']);
  });
});

describe('parser — #2288 round 2: a rejected closer\'s skip is bounded to the next opener (Critical)', () => {
  const idx = buildNameIndex([{ id: 'mary', name: 'Mary' }, { id: 'tom', name: 'Tom' }], conventionsFor('en')!);
  const speechOf = (body: string) =>
    parseChapterStructure(body, idx)
      .flatMap((p) => p.spans)
      .filter((s) => s.kind === 'speech')
      .map((s) => body.slice(s.start, s.end));

  // Both bodies are the known-bug inputs from the #2288 review. Without a
  // bound, a rejected apostrophe-shaped closer's search for a later
  // occurrence of the same glyph wanders past intervening turns with no stop
  // condition — landing on a plausible-looking closer several turns away and
  // destroying everything in between. Expected arrays below are MEASURED
  // (`parseChapterStructure` run against these exact bodies), not predicted:
  // they are what `main` produces today, which the bound must reproduce.
  it('a stray apostrophe between turns does not swallow the turns that follow', () => {
    const body =
      'Tom said the ‘phone wasn’t working. “I agree,” said Mary. It was the boys’ fault.';
    // Without the bound: ["phone wasn’t working. “I agree,” said Mary. It was the boys"]
    // — Mary's whole turn destroyed, walking past “I agree,” to accept the
    // later "boys’" apostrophe as if it closed the ‘phone run.
    expect(speechOf(body)).toEqual(['phone wasn', 'I agree,']);
  });

  it('a rejected closer immediately after an opener does not reach past the next turn', () => {
    const body = '‘Yes’said Tom. “No,” said Mary. ‘Maybe,’ said Tom.';
    // Without the bound the ‘Yes’said run's rejected "Yes’said" apostrophe
    // would skip all the way to the later "Maybe,’" closer, merging three
    // turns (and two speakers) into one.
    expect(speechOf(body)).toEqual(['Yes', 'No,', 'Maybe,']);
  });
});

describe('parser — #2288 round 3: the bound is anchored at the rejection, not the interior start', () => {
  const idx = buildNameIndex([{ id: 'mary', name: 'Mary' }, { id: 'tom', name: 'Tom' }], conventionsFor('en')!);
  const speechOf = (body: string) =>
    parseChapterStructure(body, idx)
      .flatMap((p) => p.spans)
      .filter((s) => s.kind === 'speech')
      .map((s) => body.slice(s.start, s.end));

  // Expected arrays below are MEASURED (`parseChapterStructure` run against
  // these exact bodies), not predicted.
  it('the standard British shape — a single-quoted turn nesting a double-quoted one — is now repaired', () => {
    const body = '‘He said “yes,” but I don’t believe him,’ she said.';
    // Anchoring at the opening quote's INTERIOR START (the round-2 bound)
    // caps the search at the nested “ — which belongs to THIS turn, not a
    // following one — leaving this identical to `main`: ["He said “yes,”
    // but I don"]. Anchoring at the REJECTED closer's own index instead lets
    // the search pass that nested opener, because nothing after it is a
    // different turn's opener either.
    expect(speechOf(body)).toEqual(['He said “yes,” but I don’t believe him,']);
  });

  // Both bodies are round 2's known-bug fixtures, re-asserted here because
  // moving the anchor is exactly the kind of change that could silently
  // re-open them — see the round-2 describe block above for what the
  // un-bounded scan does to each.
  it('known-bug 1 stays identical under the new anchor', () => {
    const body =
      'Tom said the ‘phone wasn’t working. “I agree,” said Mary. It was the boys’ fault.';
    expect(speechOf(body)).toEqual(['phone wasn', 'I agree,']);
  });

  it('known-bug 2 stays identical under the new anchor', () => {
    const body = '‘Yes’said Tom. “No,” said Mary. ‘Maybe,’ said Tom.';
    expect(speechOf(body)).toEqual(['Yes', 'No,', 'Maybe,']);
  });

  it('nesting stays unharmed (no rejection occurs, so the anchor never comes into play)', () => {
    expect(speechOf('“He said ‘hi’ to me,” she reported.')).toEqual(['He said ‘hi’ to me,']);
  });
});

// Salvaged from blocked PR #2286 (source commit b5e7a365): only the cases that
// pass against the SHIPPED lang tables, with no table change of any kind. That
// PR widens several languages' quotePairs; those widened-table cases stay
// there and are NOT reproduced here. `de` is the one language #2286 concluded
// should gain nothing from its table widening — every candidate opener it
// tried (ASCII same-glyph, curly, Swiss) let a „ run extend past the next
// turn's opener and swallow it, per #1601 — so these three pin the shipped,
// unwidened `de` table against exactly the counter-examples that sank the
// widening attempt.
describe('parser — #2288 de gains no opener from #2279 (counter-examples, PR #2286 salvage)', () => {
  const deIdx = buildNameIndex([{ id: 'anna', name: 'Anna' }], conventionsFor('de')!);
  const speechOf = (body: string) =>
    parseChapterStructure(body, deIdx)
      .flatMap((p) => p.spans)
      .filter((s) => s.kind === 'speech')
      .map((s) => body.slice(s.start, s.end));

  it('#2288: de + ASCII-quoted sign — a turn pair around it keeps BOTH turns', () => {
    const body = '„Guten Tag", sagte er. Das Schild sagte "Zu". „Und du?", fragte sie.';
    expect(speechOf(body)).toEqual(['Guten Tag', 'Und du?']);
  });
  it('#2288: de + curly-opened sign — a „…” turn pair around a “-opened sign keeps BOTH turns', () => {
    const body = '„Guten Tag”, sagte er. Das Schild sagte “Zu". „Und du?”, fragte sie.';
    expect(speechOf(body)).toEqual(['Guten Tag', 'Und du?']);
  });
  it('#2288: de + Swiss-opened sign — a „…“ / »…« turn pair around a «-opened sign keeps BOTH turns', () => {
    const body = '„Guten Tag“, sagte er. Das Schild sagte «Zu". »Und du?«, fragte sie.';
    expect(speechOf(body)).toEqual(['Guten Tag', 'Und du?']);
  });
  it('#2288: de carries no opener beyond „ and » — the exclusion IS the fix', () => {
    expect(new Set(conventionsFor('de')!.quotePairs.map(([o]) => o))).toEqual(new Set(['„', '»']));
  });
});

describe('parser — #2288 deep nesting stays one turn (design-alternative pin)', () => {
  // This is the shape that killed the rejected convention-election design
  // alternative during the #2288 design pass — it collapsed into four
  // fragments instead of one turn. The shipped design (an apostrophe is not a
  // closing quote, plus never-delete-a-run) cannot regress it, which is
  // exactly why it is worth pinning now, ahead of the next attempt at #2286.
  it('an outer double-quoted turn containing THREE inner single-quoted phrases stays one turn', () => {
    const idx = buildNameIndex([{ id: 'mary', name: 'Mary' }], conventionsFor('en')!);
    const body = '“He said ‘hi’ and ‘bye’ and ‘hi’ to me,” she reported.';
    const speech = parseChapterStructure(body, idx)
      .flatMap((p) => p.spans)
      .filter((s) => s.kind === 'speech')
      .map((s) => body.slice(s.start, s.end));
    expect(speech).toEqual(['He said ‘hi’ and ‘bye’ and ‘hi’ to me,']);
  });
});

describe('parser — #2288 round 4: crossGlyphBound guards a multi-closer opener (forward-cover for #2286)', () => {
  // No shipped table pairs an apostrophe-shaped closer alongside a SIBLING
  // closer for the same opener (see the `crossGlyphBound` comment above
  // `nearestOpenerAtOrAfter` in parser.ts — de's `„` is the only shipped
  // multi-closer opener, and none of its closers is apostrophe-shaped), so
  // this `quotePairs` table is SYNTHETIC, not any shipped convention. It
  // exists only to reach the OPENER-OCCURRENCE-WIDE bound this branch
  // guards, which #2286's table widening (pairing `‘`/`’` alongside another
  // closer on one opener) would otherwise make reachable with no test
  // covering it — the same forward-cover shape as the zh nesting
  // characterisation above; this is not coverage of any shipped table.
  it("a sibling closer's un-rejected first occurrence cannot skip past a rejected apostrophe-shaped closer's bound", () => {
    const synth = {
      ...conventionsFor('en')!,
      quotePairs: [['«', '’'], ['«', '»'], ['“', '”']] as [string, string][],
    };
    const idx = buildNameIndex([{ id: 'tom', name: 'Tom' }], synth);
    const body = '«He said don’t go. “Stop,” said Tom. Later» he left.';
    const speech = parseChapterStructure(body, idx)
      .flatMap((p) => p.spans)
      .filter((s) => s.kind === 'speech')
      .map((s) => body.slice(s.start, s.end));
    // Measured against `parseChapterStructure`, not predicted. Without
    // `crossGlyphBound`, `»`'s un-rejected first occurrence would win `end`
    // past "Stop,"'s turn entirely, merging all three sentences into one run
    // and destroying Tom's line and its speaker attribution.
    expect(speech).toEqual(['He said don', 'Stop,']);
  });
});

// #2289 — es/fr.dialogueOpen carried &mdash; but not &ndash;, so an EPUB
// toolchain that left the entity literal in the body text (stripHtml only
// decodes a small named-entity set, per ru.ts's precedent comment) opened no
// dialogue paragraph at all: `&ndash; Un momento` parsed as narration while
// `&mdash; Un momento` — the exact same dash, just the other entity — parsed
// as dialogue. Exercised against `parseChapterStructure` itself (not
// `isSpokenLine`), since `dialogueOpen` drives the paragraph split there
// directly and `isSpokenLine` alone would not prove the fix reaches it.
describe('parser — #2289 es/fr dialogueOpen carries &ndash; alongside &mdash;', () => {
  const esIdx = buildNameIndex([{ id: 'ana', name: 'Ana' }], conventionsFor('es')!);
  const frIdx = buildNameIndex([{ id: 'anne', name: 'Anne' }], conventionsFor('fr')!);

  it('#2289: es — &ndash; opens a dialogue paragraph (was narration)', () => {
    const paras = parseChapterStructure('&ndash; Un momento — dijo él.', esIdx);
    expect(paras[0].kind).toBe('dialogue');
  });
  it('#2289: fr — &ndash; opens a dialogue paragraph (was narration)', () => {
    const paras = parseChapterStructure('&ndash; Un instant — dit-il.', frIdx);
    expect(paras[0].kind).toBe('dialogue');
  });
  it('#2289: positive control — &mdash; still opens dialogue in es and fr (proves the test is not vacuous)', () => {
    const esParas = parseChapterStructure('&mdash; Un momento — dijo él.', esIdx);
    const frParas = parseChapterStructure('&mdash; Un instant — dit-il.', frIdx);
    expect(esParas[0].kind).toBe('dialogue');
    expect(frParas[0].kind).toBe('dialogue');
  });
});
