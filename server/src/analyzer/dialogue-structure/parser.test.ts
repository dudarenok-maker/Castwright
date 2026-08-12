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

  it('every paragraph with at least one run keeps at least one run', () => {
    const bodies = [
      '‘I don’t know,’ she said.',
      '‘’Tis nothing,’ he said.',
      '‘Give ’em back,’ she said.',
      '‘He said “hi” to O’Brien.',
      '“ ‘Ping Wing, the Pieman’s son,',
    ];
    for (const body of bodies) expect(speechOf(body).length).toBeGreaterThan(0);
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

  it('NOT FIXED: same-glyph nesting lets an inner closer end the outer turn early', () => {
    // The inner closing `’` of nested `‘dare’` has a letter before it ('e')
    // and a space after it — none of isRealCloser's three clauses fires, so
    // it is accepted as the OUTER run's closer, truncating the turn before
    // "leave,". The scan is single-glyph and non-stacking, so it cannot
    // disambiguate an inner same-glyph pair from the outer one regardless of
    // the rule. Pre-existing, and STRICTLY IMPROVED by Task 2: the old code
    // stopped at the very first `’` (the one in "Don’t"), an even shorter
    // capture — this is not a regression. Desired output is
    // ['Don’t you ‘dare’ leave,']; flip this test if nested nesting is ever
    // disambiguated (would need a stacking scan, out of scope for #2288).
    expect(speechOf('‘Don’t you ‘dare’ leave,’ she said.')).toEqual(['Don’t you ‘dare']);
  });
});
