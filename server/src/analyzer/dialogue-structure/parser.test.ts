import { describe, expect, it } from 'vitest';
import { stripHtml } from '../../parsers/html-utils.js';
import { conventionsFor } from './lang/index.js';
import { buildNameIndex } from './name-matcher.js';
import { anchorSpansFromTags, parseChapterStructure } from './parser.js';
import type { LanguageConventions, SpanEvidence } from './types.js';

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

/* #2279 — the added quote pairs, on the STRUCTURE-ENGINE path.

   `narrator-default.test.ts`'s #2279 blocks exercise `isSpokenLine`, which is
   unreachable at default settings, and every one of its positive assertions is
   satisfied by the leading-opener check alone. `findQuoteRuns` is entirely
   CLOSER-driven, so these cases put each added pair in embedded position —
   opener mid-paragraph, closer required — which is the only shape that can
   catch a wrong closer glyph. Missing coverage here is what let #2288 through
   the first time. */
describe('parser — #2279 added quote pairs (closer-driven)', () => {
  const spoken = (body: string, lang: string) =>
    spansOf(parseChapterStructure(body, buildNameIndex([], conventionsFor(lang)!)))
      .filter((s) => s.kind === 'speech')
      .map((s) => body.slice(s.start, s.end));

  it('es: straight "…" forms a quote run in embedded position', () => {
    expect(spoken('Él dijo "Ven aquí" y se fue.', 'es')).toEqual(['Ven aquí']);
  });
  it('fr: straight "…" and curly “…” both form quote runs', () => {
    expect(spoken('Il a dit "Viens ici" et il est parti.', 'fr')).toEqual(['Viens ici']);
    expect(spoken('Il a dit “Viens ici” et il est parti.', 'fr')).toEqual(['Viens ici']);
  });
  it('ru: smart-single ‘…’ forms a quote run in embedded position', () => {
    expect(spoken('Он сказал ‘Иди сюда’ и ушёл.', 'ru')).toEqual(['Иди сюда']);
  });
  it('en: guillemets «…» form a quote run in embedded position', () => {
    expect(spoken('He said «come here» and left.', 'en')).toEqual(['come here']);
  });
  it('zh: straight "…" and nested ‘…’ both form quote runs', () => {
    expect(spoken('他说 "你好" 然后走了。', 'zh')).toEqual(['你好']);
    expect(spoken('他说 ‘你好’ 然后走了。', 'zh')).toEqual(['你好']);
  });
  it('ja/zh: curly “…” and straight "…" both form quote runs — the zh/ja asymmetry is closed', () => {
    expect(spoken('彼は “おはよう” と言った。', 'ja')).toEqual(['おはよう']);
    expect(spoken('彼は "おはよう" と言った。', 'ja')).toEqual(['おはよう']);
    expect(spoken('他说 “你好” 然后走了。', 'zh')).toEqual(['你好']); // same line, same answer now
  });
  // #2286 (2026-08-14 re-measure) — de's added pairs live in the SECONDARY
  // tier, unlike es/fr/ru/en/zh/ja above (all primary), because de.quotePairs
  // stays closed per de.ts's comment. One closer-driven case per candidate.
  it('de: straight "…" forms a quote run in embedded position', () => {
    expect(spoken('Sie sagte "Komm her" und ging.', 'de')).toEqual(['Komm her']);
  });
  it('de: curly “…” forms a quote run in embedded position', () => {
    expect(spoken('Sie sagte “Komm her” und ging.', 'de')).toEqual(['Komm her']);
  });
  it('de: Swiss «…» forms a quote run in embedded position', () => {
    expect(spoken('Sie sagte «Komm her» und ging.', 'de')).toEqual(['Komm her']);
  });

  /* Multi-run interaction, the hazard class this block exists for. A single
     quoted run per paragraph cannot see it — #1601 and #2288 are both about a
     run extending past the NEXT turn's opener — so every added pair gets a
     two-turn case with a quoted term between the turns. */
  it('es: two turns around a quoted term stay three separate runs', () => {
    const body = '"Hola", dijo. El cartel decía "Cerrado". "Adiós", dijo ella.';
    expect(spoken(body, 'es')).toEqual(['Hola', 'Cerrado', 'Adiós']);
  });
  it('fr: two turns around a quoted term stay three separate runs', () => {
    const body = '«Bonjour», dit-il. Le panneau disait “Fermé”. «Au revoir», dit-elle.';
    expect(spoken(body, 'fr')).toEqual(['Bonjour', 'Fermé', 'Au revoir']);
  });
  it('ru: two turns around a quoted term stay three separate runs', () => {
    const body = '«Privet», skazal on. Znak glasil ‘Zakryto’. «Poka», skazala ona.';
    expect(spoken(body, 'ru')).toEqual(['Privet', 'Zakryto', 'Poka']);
  });
  it('zh: two turns around a quoted term stay three separate runs', () => {
    const body = '「你好」他说。牌子写着‘停’。「再见」她说。';
    expect(spoken(body, 'zh')).toEqual(['你好', '停', '再见']);
  });
  it('ja: two turns around a quoted term stay three separate runs', () => {
    const body = '「おはよう」彼は言った。看板には “Closed” とあった。「さようなら」彼女は言った。';
    expect(spoken(body, 'ja')).toEqual(['おはよう', 'Closed', 'さようなら']);
  });
  // The exact shape the old de.ts comment feared: a genuine two-turn German
  // paragraph (primary „…") with a quoted sign in the gap between them, using
  // the SECONDARY Swiss pair («…»). This works because there is exactly ONE
  // «…» in the paragraph — not because the reverse polarity (« opens/» closes
  // here, vs. »…« for primary) makes it safe in general. That same reverse
  // polarity is exactly what breaks a SECOND «…» turn in the same paragraph:
  // a `»` that closes one Swiss turn is also a valid PRIMARY opener (German's
  // `quotePairs` carries `['»','«']`), so it can seed a primary run that
  // swallows the attribution between two Swiss turns — see #2352, pinned
  // below as a known gap.
  // #2346: `dort: «Zu»` is the only shipped fixture with a colon before a
  // secondary candidate, so it is the one place the new colon rule and the
  // pre-existing `hasStem` test overlap. It was green before the rule and is
  // green after it — but for DIFFERENT reasons (no verb stem, then the colon),
  // which is a coincidence, not a guarantee. It cannot detect a regression in
  // either mechanism; the `#2346 defect B` describe below is what pins the rule.

  it('de: two genuine „…" turns survive a secondary-Swiss-quoted sign in the gap between them', () => {
    const body = '„Guten Tag", sagte er. Das Schild dort: «Zu». „Und du?", fragte sie.';
    expect(spoken(body, 'de')).toEqual(['Guten Tag', 'Zu', 'Und du?']);
  });
  // #2352 — KNOWN GAP, not desired behaviour: TWO Swiss `«…»` turns in one
  // paragraph collide with German's PRIMARY `['»','«']` pair. The `»` that
  // closes turn 1 (as the secondary opener's closer) is also a valid PRIMARY
  // opener, so `findQuoteRuns` seeds a primary run there and extends it to
  // the next `«` — turn 2's opener — swallowing the attribution between them
  // and reading BOTH real turns as narration. Measured 2026-08-14 over the
  // 40-book German corpus: this collision BLOCKS the Swiss secondary entry
  // in 4,926 of 63,941 paragraphs (4,903 with two or more «) — the entry
  // works cleanly in only 16 of the 63,941 (see de.ts). #2352 is filed
  // to fix this — it needs a design pass (per-paragraph convention detection
  // or positional disambiguation, either of which touches PRIMARY-tier
  // behaviour) — so this test pins CURRENT (wrong) behaviour, derived from a
  // real run of this exact body, to keep a future change from silently
  // moving it.
  it('#2352: de — TWO Swiss «…» turns in one paragraph mis-read as narration (known gap, not desired)', () => {
    const body = '«Guten Morgen», sagte Anton. «Hast du gut geschlafen?»';
    const spans = spansOf(parseChapterStructure(body, buildNameIndex([], conventionsFor('de')!)));
    expect(spans.map((s) => ({ kind: s.kind, text: body.slice(s.start, s.end) }))).toEqual([
      { kind: 'narration', text: '«Guten Morgen' },
      { kind: 'speech', text: ', sagte Anton. ' },
      { kind: 'narration', text: 'Hast du gut geschlafen?»' },
    ]);
  });

  /* #2288 — the regressions this block exists to prevent, and the reason `de`
     gains nothing in the PRIMARY table (`quotePairs`) from #2279. `spoken`
     below always runs against the REAL shipped `de` table, so these three
     bodies double as a guard: if a future change ever moves one of the three
     candidates into `de.quotePairs`, German pairs `„` with three closers
     while any new PRIMARY opener carries one, so its run runs on past the
     next turn's opener and one of these redden. #2286 widened German's
     SECONDARY tier instead (`de.secondaryQuotePairs`, see de.ts's comment) —
     a different mechanism the gap-tier rule makes safe, covered by the
     "#2279 added quote pairs (closer-driven)" de cases above and by
     #2315's guard-with-real-secondaryQuotePairs block below. */
  it('#2288: de + [\'"\',\'"\'] — a turn pair around an ASCII-quoted sign keeps BOTH turns', () => {
    const body = '„Guten Tag", sagte er. Das Schild sagte "Zu". „Und du?", fragte sie.';
    expect(spoken(body, 'de')).toEqual(['Guten Tag', 'Und du?']);
  });
  it('#2288: de + curly — a `„…”` turn pair around a `“`-opened sign keeps BOTH turns', () => {
    const body = '„Guten Tag”, sagte er. Das Schild sagte “Zu". „Und du?”, fragte sie.';
    expect(spoken(body, 'de')).toEqual(['Guten Tag', 'Und du?']);
  });
  it('#2288: de + Swiss — a `„…“` / `»…«` turn pair around a `«`-opened sign keeps BOTH turns', () => {
    const body = '„Guten Tag“, sagte er. Das Schild sagte «Zu". »Und du?«, fragte sie.';
    expect(spoken(body, 'de')).toEqual(['Guten Tag', 'Und du?']);
  });
  it('#2288: `de` carries no opener beyond `„` and `»` — the exclusion IS the fix', () => {
    expect(new Set(conventionsFor('de')!.quotePairs.map(([o]) => o))).toEqual(new Set(['„', '»']));
  });
});

/* #2286 residual — the OWNER'S 2026-08-13 decision, recorded in
   docs/superpowers/specs/2026-08-13-gap-seeded-straddle-design.md: the gap
   tier's binding acceptance criterion is ZERO DESTROYED TURNS. LOST/MERGED/
   SPLIT are guaranteed, not measured, for any change confined to
   `secondaryQuotePairs`: `findQuoteRuns` seeds `out = [...primaryRuns]` and
   only ever appends (parser.ts:468-470's "cannot delete a primary run…by
   construction, not by measurement"), so the candidate set is always a
   superset of the baseline's. What the F1/F2/F3 sweeps + the 331-book corpus
   replay actually establish, by measurement, is the SIZE and DISTRIBUTION of
   the gain — the structural guarantee doesn't extend to it. A spurious
   narration-read-as-speech span is the ACCEPTED lesser harm: a primary-
   convention scan is a run detector, not a convention detector, so a
   secondary-tier quotation appearing in narration
   (a sign, a title, a scare quote) with NO primary run anywhere nearby still
   forms its own quote run and reads as spoken — nothing is destroyed, but
   the narration line is misclassified. These three pin CURRENT behaviour
   (not desired), one per representative language, so a future change to the
   tier or the scan cannot silently narrow OR widen this residual without a
   test going red either way. */
describe('parser — #2286 residual: accepted spurious spans under the gap tier (owner decision 2026-08-13)', () => {
  const spoken = (body: string, lang: string) =>
    spansOf(parseChapterStructure(body, buildNameIndex([], conventionsFor(lang)!)))
      .filter((s) => s.kind === 'speech')
      .map((s) => body.slice(s.start, s.end));

  it('es: a sign quoted with the secondary "…" pair, alone in narration, still reads as spoken', () => {
    expect(spoken('El cartel decía "Cerrado".', 'es')).toEqual(['Cerrado']);
  });
  it('en: a title quoted with the secondary «…» pair, alone in narration, still reads as spoken', () => {
    expect(spoken('He read «Faust» on the cover.', 'en')).toEqual(['Faust']);
  });
  it('ru: a sign quoted with the secondary ‘…’ pair, alone in narration, still reads as spoken', () => {
    expect(spoken('Знак гласил ‘Закрыто’.', 'ru')).toEqual(['Закрыто']);
  });
});

/* The #2315 guard `cutsATagClause` declines a secondary-tier quote-run when a
   primary-tier turn precedes it and the clause between them carries a
   speech/beat verb stem — preventing a secondary run from truncating an
   attribution tag. On `main`, `secondaryQuotePairs` is empty for every
   language, so this is the first change under which the guard is reachable
   from the real shipped tables. Without the guard, a secondary run would cut
   the tag at the quoted name, leaving the turn with its text but no speaker.
   Since #2427 the guard also returns EARLY, declining nothing, when a colon
   immediately precedes the candidate (whitespace stripped) — a leading tag
   introduces its turn rather than attributing one. The cases in this block all
   use trailing tags, so none of them exercise that path; the `#2346 defect B`
   describe does. */
describe('parser — #2315 guard `cutsATagClause` with real secondaryQuotePairs (#2286)', () => {
  const assertSpansOf = (body: string, lang: string, roster: Array<{ id: string; name: string }>) => {
    const conv = conventionsFor(lang)!;
    const idx = buildNameIndex(roster, conv);
    const paras = parseChapterStructure(body, idx);
    const spans = spansOf(paras);
    expect(spans.filter((s) => s.kind === 'speech')).toHaveLength(1);
    expect(spans.filter((s) => s.kind === 'tag')).toHaveLength(1);
    const speech = spans.find((s) => s.kind === 'speech')!;
    const tag = spans.find((s) => s.kind === 'tag')!;
    return {
      speechText: body.slice(speech.start, speech.end),
      tagText: body.slice(tag.start, tag.end),
    };
  };

  it('ru: secondary single-quotes do not cut the tag — Антон remains in the attribution', () => {
    const body = '«Привет», сказал ‘Антон’.';
    const { speechText, tagText } = assertSpansOf(body, 'ru', [{ id: 'anton', name: 'Антон' }]);
    expect(speechText).toBe('Привет');
    expect(tagText).toBe(', сказал ‘Антон’.');
  });

  it('es: secondary straight-quotes do not cut the tag — Antonio remains in the attribution', () => {
    const body = '«Hola», dijo "Antonio".';
    const { speechText, tagText } = assertSpansOf(body, 'es', [{ id: 'antonio', name: 'Antonio' }]);
    expect(speechText).toBe('Hola');
    expect(tagText).toBe(', dijo "Antonio".');
  });

  it('en: secondary guillemets do not cut the tag — Anton remains in the attribution', () => {
    const body = '"Hi," said «Anton».';
    const { speechText, tagText } = assertSpansOf(body, 'en', [{ id: 'anton', name: 'Anton' }]);
    expect(speechText).toBe('Hi,');
    expect(tagText).toBe(' said «Anton».');
  });
});
/* #2346 defect B (#2427) — the guard fires on a LEADING tag and deletes the turn
   it introduces. A colon immediately before the candidate means the verb
   INTRODUCES what follows (`sagte er …: «…»`, the Latin analogue of CJK's `：`);
   the guard's remaining tests all assume the verb ATTRIBUTES something already
   parsed.

   The body is the REAL paragraph from Gutenberg 63460, not a reduced shape.
   The reduction is what hides the bug: the trigger is the unrelated
   `»Tick-Tack ... Tick-Tack«` clock earlier in the same paragraph, which sets
   `precededByPrimaryRun` for a candidate it has nothing to do with. Shorten the
   body and the test passes for the wrong reason.

   This is a SEGMENTATION assertion, not an attribution one — the recovered turn
   has no speaker, and this suite is documented as blind to attribution. */
describe('parser — #2346 defect B: a colon-introduced turn is not eaten by the tag-clause guard', () => {
  const spoken = (body: string, lang: string) =>
    spansOf(parseChapterStructure(body, buildNameIndex([], conventionsFor(lang)!)))
      .filter((s) => s.kind === 'speech')
      .map((s) => body.slice(s.start, s.end));

  const DE_63460 =
    'Es war gruselig und dunkel auf der Stiege, aber dann zündete Ulebuhle sein Öllämpchen an, der Schlüssel ' +
    'drehte sich kreischend im Schloß, und knarrend öffnete sich die Turmtür, um uns einzulassen in den ' +
    'geheimnisvollen Raum. -- Da stand in der Mitte auf einer Säule ein großes Ding, wie eine Kanone, und so ' +
    'dick, daß die dünnsten von uns wohl hätten durch das Rohr hindurchkriechen können. Es blinkte daran von ' +
    'allerlei Schrauben und Griffen, von Stahl und Messing. Oben war ein großes Glas im Rohr, wohl wie ein ' +
    'Teller, und unten ein ganz winziges, durch das man hindurchschauen mußte. Und dann tickte da noch eine ' +
    'große Uhr in einem Glasgehäuse, mit einem langen Perpendikel, der mächtig vornehm und langsam hin und her ' +
    'schwang und unablässig ganz bedächtig sein »Tick-Tack ... Tick-Tack« sagte. -- Da waren auch noch allerlei ' +
    'Apparate in den Ecken und an den Wänden, und Bilder hingen da von Mond und Sternen, und dicke Bücher lagen ' +
    'in den Fächern. Aber wenn wir Ulebuhle nach all dem fragten, dann sagte er nur in seiner knurrigen ' +
    'Weise: «Schnickschnack und Finger davon! Das versteht ihr nicht!»';

  it('de: the colon-introduced turn survives as its own speech span (real paragraph)', () => {
    expect(spoken(DE_63460, 'de')).toEqual([
      'Tick-Tack ... Tick-Tack',
      'Schnickschnack und Finger davon! Das versteht ihr nicht!',
    ]);
  });

  it('de: a colon-introduced turn with NO whitespace before the quote also survives', () => {
    expect(spoken('„Guten Tag\", sagte er. Dann sagte er:«Hallo».', 'de')).toEqual(['Guten Tag', 'Hallo']);
  });

  /* The full-width `：` arm must use a SECONDARY zh pair. `“…”` is a zh PRIMARY
     pair, so `他说：“你好”。` never reaches the guard at all and already returns
     `['你好']` on shipped code — measured. A test written on that shape cannot
     fail, in either direction. `‘…’` is zh's secondary pair, and the leading
     `“早安”` supplies the primary run the guard requires before it will act. */
  it('zh: a full-width colon introduces the turn the same way', () => {
    expect(spoken('“早安”，他说。然后他说：‘你好’。', 'zh')).toEqual(['早安', '你好']);
  });

  it('zh: the same shape WITHOUT the colon is still declined', () => {
    expect(spoken('“早安”，他说。然后他说‘你好’。', 'zh')).toEqual(['早安']);
  });

  it('de: a TRAILING tag is still declined — the guard is not disabled generally', () => {
    expect(spoken('„Guten Tag\", sagte «Ulebuhle». Und dann ging er.', 'de')).toEqual(['Guten Tag']);
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
// there and are NOT reproduced here. `de` was, at the time this block was
// salvaged, the one language #2286 concluded should gain nothing from any
// table widening — every candidate opener tried, added to PRIMARY, let a „
// run extend past the next turn's opener and swallow it, per #1601. That
// conclusion held only for `quotePairs` (primary); #2286's later re-measure
// (2026-08-14, see de.ts's comment) widened `de.secondaryQuotePairs` instead,
// a mechanism the gap tier makes safe. These three still pin the shipped
// table against the counter-examples that sank the PRIMARY widening attempt
// — de's `quotePairs` is unchanged, so they still hold.
describe('parser — #2288 de gains no PRIMARY opener from #2279 (counter-examples, PR #2286 salvage)', () => {
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
  it('#2289: positive control — &mdash; still opens dialogue in es and fr', () => {
    const esParas = parseChapterStructure('&mdash; Un momento — dijo él.', esIdx);
    const frParas = parseChapterStructure('&mdash; Un instant — dit-il.', frIdx);
    expect(esParas[0].kind).toBe('dialogue');
    expect(frParas[0].kind).toBe('dialogue');
  });
  it('#2289: negative control — ordinary narration is not dialogue', () => {
    const paras = parseChapterStructure('Ana caminó por la calle.', esIdx);
    expect(paras[0].kind).toBe('narration');
  });
  it('#2289: negative control — an unrelated entity (&zzz;) does not open dialogue', () => {
    /* Guards against an over-broad fix such as a dialogueOpen pattern of the
       shape `^\s*(?:&\w+;|[-–—])\s*` (case/unicode flags), which would match
       any entity.

       #2310 swapped this fixture from `&hellip;` to `&zzz;`. `&hellip;` used to
       survive `stripHtml`, which is what made this control realistic body text;
       since #2310 the full named set decodes, so it no longer would. An
       UNKNOWN reference is left literal by `decodeHTMLStrict`, so `&zzz;` keeps
       the control realistic end-to-end rather than demoting it to a unit-level
       mutation guard. (`&nbsp;` was never a candidate — it was decoded even
       before #2310, which is the vacuous-fixture bug #2289 shipped and had to
       correct.) */
    const paras = parseChapterStructure('&zzz; Un momento — dijo él.', esIdx);
    expect(paras[0].kind).toBe('narration');
  });

  /* #2310 — once stripHtml decodes the entity, `dialogueOpen`'s entity branch
     stops firing on freshly-parsed text and the `[-–—]` character-class branch
     carries the load instead. Pin that the handover is real, so the shims can
     be retained as pure back-compat rather than silently doing the work. */
  it('#2310: the DECODED dash still opens dialogue in es and fr', () => {
    expect(parseChapterStructure(stripHtml('<p>&ndash; Un momento.</p>'), esIdx)[0].kind)
      .toBe('dialogue');
    expect(parseChapterStructure(stripHtml('<p>&mdash; Un instant.</p>'), frIdx)[0].kind)
      .toBe('dialogue');
  });
});

describe('parser — #2288 M2 Task 2: extracting the scan changes nothing', () => {
  const idx = buildNameIndex([{ id: 'mary', name: 'Mary' }], conventionsFor('en')!);
  const speechOf = (body: string) =>
    parseChapterStructure(body, idx)
      .flatMap((p) => p.spans)
      .filter((s) => s.kind === 'speech')
      .map((s) => body.slice(s.start, s.end));

  it('keeps every shape the shipped scan produces', () => {
    expect(speechOf('“He said ‘hi’ to me,” she reported.')).toEqual(['He said ‘hi’ to me,']);
    expect(speechOf('‘I don’t know,’ she said.')).toEqual(['I don’t know,']);
    expect(speechOf('“First turn,” he said. “Second turn,” she said.')).toEqual([
      'First turn,',
      'Second turn,',
    ]);
    expect(
      speechOf('Tom said the ‘phone wasn’t working. “I agree,” said Mary. It was the boys’ fault.'),
    ).toContain('I agree,');
  });
});

describe('parser — #2288 M2: a secondary pair fills gaps but never straddles a primary turn', () => {
  const ru = conventionsFor('ru')!;
  const tiered: LanguageConventions = { ...ru, secondaryQuotePairs: [['‘', '’']] };
  const flat: LanguageConventions = {
    ...ru, quotePairs: [...ru.quotePairs, ['‘', '’']], secondaryQuotePairs: [],
  };
  const speechOf = (body: string, conv: LanguageConventions) =>
    parseChapterStructure(body, buildNameIndex([], conv))
      .flatMap((p) => p.spans)
      .filter((s) => s.kind === 'speech')
      .map((s) => body.slice(s.start, s.end));

  const straddle = '«Привет», сказал он, глядя на ‘Фауста. «Пока», сказала она О’Брайену.';

  it('RED WITHOUT THE TIER: the pair as a PRIMARY destroys the second turn', () => {
    /* asserts the BUG, so the case below cannot pass vacuously */
    expect(speechOf(straddle, flat)).toEqual(['Привет', 'Фауста. «Пока», сказала она О']);
  });

  it('declared SECONDARY, both turns survive', () => {
    expect(speechOf(straddle, tiered)).toEqual(['Привет', 'Пока']);
  });

  it('a paragraph written WHOLLY in the secondary convention still parses', () => {
    expect(speechOf('‘Привет,’ сказал он. ‘Пока,’ сказала она.', tiered)).toEqual([
      'Привет,', 'Пока,',
    ]);
  });

  it('a secondary turn BESIDE a primary turn is kept — the gap tier’s whole point', () => {
    expect(speechOf('«Привет», сказал он. ‘Пока,’ сказала она.', tiered)).toEqual([
      'Привет', 'Пока,',
    ]);
  });

  it('#2286 — the shipped table now carries this exact pair in its secondary tier', () => {
    /* Before #2286 this pinned an EMPTY secondaryQuotePairs (`toEqual([])`) as
       proof the M2 field alone changed nothing. #2286 is the widening M2 was
       built to unblock, so the shipped table now equals `tiered` above —
       asserted structurally, not just behaviourally, so a future accidental
       reversion to an empty array reddens here even if some other case
       happens to still pass. */
    expect(ru.secondaryQuotePairs).toEqual([['‘', '’']]);
    expect(speechOf(straddle, ru)).toEqual(['Привет', 'Пока']);
  });

  it('a secondary candidate straddling an UNCLOSED primary opener is declined — isolates the straddle check from the overlap guard', () => {
    /* Unlike `straddle` above, the primary « here never closes (no » anywhere
       in the string), so scanQuoteRuns(pairs) produces NO primary run for it
       to overlap against — only the straddle check (not the disjointness
       guard `out.some(...)`) can catch this candidate. Disabling `straddles`
       accepts it and yields one wrong speech span instead of zero. */
    expect(speechOf('‘Он сказал «Привет и ушёл.’ Она молчала.', tiered)).toEqual([]);
  });
});

describe('parser — #2288 M2: invariants hold with a tier declared', () => {
  const enTier: LanguageConventions = {
    ...conventionsFor('en')!, secondaryQuotePairs: [['«', '»']],
  };
  const zhTier: LanguageConventions = {
    ...conventionsFor('zh')!, secondaryQuotePairs: [['‘', '’'], ['"', '"']],
  };
  const speechOf = (body: string, conv: LanguageConventions) =>
    parseChapterStructure(body, buildNameIndex([{ id: 'mary', name: 'Mary' }], conv))
      .flatMap((p) => p.spans)
      .filter((s) => s.kind === 'speech')
      .map((s) => body.slice(s.start, s.end));

  it('en: nesting resolves to the OUTER run (acceptance item 5)', () => {
    expect(speechOf('“He said ‘hi’ to me,” she reported.', enTier)).toEqual(['He said ‘hi’ to me,']);
  });
  it('zh: nesting resolves to the OUTER run (acceptance item 5)', () => {
    expect(speechOf('“他说‘你好’然后走了”', zhTier)).toEqual(['他说‘你好’然后走了']);
  });
  it('en: M1’s apostrophe repair survives', () => {
    expect(speechOf('‘I don’t know,’ she said.', enTier)).toEqual(['I don’t know,']);
  });
  it('en: M1’s rejection bound survives — Mary’s turn is not swallowed', () => {
    expect(
      speechOf('Tom said the ‘phone wasn’t working. “I agree,” said Mary. It was the boys’ fault.', enTier),
    ).toContain('I agree,');
  });
  it('en: the ticket’s « straddle counter-example keeps both turns', () => {
    expect(
      speechOf('“Hi,” he said, passing the «Faust poster. “Bye,” she said, near the «gallery».', enTier),
    ).toEqual(['Hi,', 'Bye,']);
  });
  it('de: #1601 nearest-closer split is untouched', () => {
    expect(speechOf('„Guten Tag“, sagte er. „Und du?", fragte sie.', conventionsFor('de')!)).toEqual([
      'Guten Tag', 'Und du?',
    ]);
  });
  it('runs stay disjoint under the tier', () => {
    const spans = parseChapterStructure(
      '«Привет», сказал он, глядя на ‘Фауста. «Пока», сказала она О’Брайену.',
      buildNameIndex([], { ...conventionsFor('ru')!, secondaryQuotePairs: [['‘', '’']] }),
    ).flatMap((p) => p.spans).sort((a, b) => a.start - b.start);
    for (let i = 1; i < spans.length; i++) expect(spans[i].start).toBeGreaterThanOrEqual(spans[i - 1].end);
  });
});

describe('parser — #2288 M2: a quoted TITLE in narration must not suppress dialogue', () => {
  /* THE case that disqualified the paragraph-scoped tier. A primary scan is an
     any-run detector, not a convention detector: under a paragraph verdict this
     paragraph lost BOTH turns, 21 of 21 such shapes across six languages.
     Guillemet and corner-bracket titles are routine in exactly the books
     typeset in the secondary convention. */
  const speechOf = (body: string, conv: LanguageConventions) =>
    parseChapterStructure(body, buildNameIndex([], conv))
      .flatMap((p) => p.spans)
      .filter((s) => s.kind === 'speech')
      .map((s) => body.slice(s.start, s.end));

  it('es: a «title» in narration leaves both "…" turns intact', () => {
    const es: LanguageConventions = { ...conventionsFor('es')!, secondaryQuotePairs: [['"', '"']] };
    expect(speechOf('Leía «Fausto» en la portada. "Hola", dijo él. "Adiós", dijo ella.', es)).toEqual([
      'Fausto', 'Hola', 'Adiós',
    ]);
  });
  it('ja: a 「title」 in narration leaves both “…” turns intact', () => {
    const ja: LanguageConventions = { ...conventionsFor('ja')!, secondaryQuotePairs: [['“', '”']] };
    expect(
      speechOf('彼は表紙の「ファウスト」を読んだ。“おはよう”と彼は言った。“さようなら”と彼女は言った。', ja),
    ).toEqual(['ファウスト', 'おはよう', 'さようなら']);
  });
});

describe('parser — #2288 M2: residuals accepted with rule B (design doc § Residuals)', () => {
  const speechOf = (body: string, conv: LanguageConventions) =>
    parseChapterStructure(body, buildNameIndex([], conv))
      .flatMap((p) => p.spans)
      .filter((s) => s.kind === 'speech')
      .map((s) => body.slice(s.start, s.end));

  it("residual 1: the straddle inside a language's own PRIMARY pairs is REPAIRED (#2315's own regression test; design doc M2 residual 1, INVERTED by the #2315 re-open bound)", () => {
    // M2 only added a tier BELOW primary; it never touched scanQuoteRuns or
    // the leftmost-accept loop, so this shape stayed merged under M2 alone.
    // #2315's re-open bound lives IN scanQuoteRuns: the unclosed « (no » after
    // "Hola") now ends the run at the re-open rather than swallowing turn 2's
    // own opening tag, so both turns come back clean. This inverts what this
    // test pinned before #2315 (a genuine two-run MERGE) — it now pins the
    // fix instead. Cross-referenced from #2315's own "the re-open bound"
    // describe block above (the 'es' worked example).
    const es = conventionsFor('es')!;
    const spoken = speechOf('«Hola, dijo él. «Adiós», dijo ella.', es);
    expect(spoken).toEqual(['Hola, dijo él. ', 'Adiós']);
  });

  it("residual 2: a spurious secondary run over VERB-BEARING narration is DECLINED by the #2315 tag-clause guard; both real turns stay intact (design doc M2 residual 2, REVISED by #2315 defect 2)", () => {
    // "Stop" sits in the gap between two real turns, framed by the secondary
    // «» pair, and contains no primary opener — the M2 gap tier alone would
    // accept it as a (spurious) third run, narration read as speech. But
    // "The sign said «Stop»." is a VERB-BEARING clause with no sentence break
    // before the candidate ("said" + no '.' before "«"), which is exactly the
    // shape the #2315 tag-clause guard cannot tell apart from a genuine tag
    // (design doc § "Defect 2 — the tag-cut cut", the 156-case residual: verb-
    // bearing narration the guard declines even though it names no speaker).
    // The guard has no roster to check "Stop" isn't a name, by design (design
    // doc's rejected-rules list: roster-aware admission fails on a bare-name
    // turn). What still matters — and is still true — is that BOTH real turns
    // ("Hi" and "Bye") survive untouched; only the spurious third run is gone.
    const enTier: LanguageConventions = { ...conventionsFor('en')!, secondaryQuotePairs: [['«', '»']] };
    const spans = speechOf('“Hi”, he said. The sign said «Stop». “Bye”, she said.', enTier);
    expect(spans).toEqual(['Hi', 'Bye']);
  });
});

describe('parser — #2315: the re-open bound', () => {
  const speechOf = (body: string, conv: LanguageConventions) =>
    parseChapterStructure(body, buildNameIndex([], conv))
      .flatMap((p) => p.spans)
      .filter((s) => s.kind === 'speech')
      .map((s) => body.slice(s.start, s.end));

  /* Case 1 — same-glyph re-open. `fr` has a single quote pair, so turn 2's
     opener is the same glyph as the stray. The per-opener scan resumes at the
     END of the accepted run, so turn 2 produces NO CANDIDATE AT ALL: no
     acceptance-order rule can reach this, which is why the fix is in the scan.
     Design § "Defect 1 — the mechanism", case 1. */
  it('fr: an unterminated « does not swallow the next turn', () => {
    expect(
      speechOf('«Bonjour», dit-il, regardant le «panneau de Faust. «Et toi», demanda-t-elle.', conventionsFor('fr')!),
    ).toEqual(['Bonjour', 'panneau de Faust. ', 'Et toi']);
  });
  // es: the design's worked example is pinned by "residual 1" in the M2
  // residuals describe block above — same input, same output, kept there
  // per the plan's explicit "do not delete" on that test (PR #2340 review
  // nit 3: this was a byte-for-byte duplicate of that assertion).
  /* The shape a real book produces when a CLOSING quote is typed as an OPENING
     one. `toEqual`, not `toContain`: a superset assertion cannot see a rule
     that ADDS a span, which is how an earlier candidate rule passed every
     anchor while inventing a spurious speech span. */
  it('en: a closing quote typed as an opening one keeps both turns', () => {
    expect(speechOf('“Hello,“ he said. “Goodbye,” she said.', conventionsFor('en')!)).toEqual([
      'Hello,', ' he said. ', 'Goodbye,',
    ]);
  });

  /* Case 3 — `ru`'s `“` closes turn 1 AND opens a pair, so the scan seeds a run
     there, that run is discarded for overlapping turn 1, and the cursor has by
     then passed turn 2's genuine `“`. Surfaced by the family instrument's own
     no-stray control, which exists to prove it does not cry wolf. */
  it('ru: turn 1’s own closing „…“ does not consume turn 2’s opener', () => {
    expect(speechOf('„Привет“, сказал он. “Пока”, сказала она.', conventionsFor('ru')!)).toEqual([
      'Привет', 'Пока',
    ]);
  });

  it('runs stay disjoint when a run is truncated at a re-open', () => {
    const body = '«Hola, dijo él. «Adiós», dijo ella.';
    const spans = parseChapterStructure(body, buildNameIndex([], conventionsFor('es')!))
      .flatMap((p) => p.spans)
      .sort((a, b) => a.start - b.start);
    for (let i = 1; i < spans.length; i++) expect(spans[i].start).toBeGreaterThanOrEqual(spans[i - 1].end);
  });

  it('a truncated run never produces an empty speech span', () => {
    /* `cut > interiorStart` guarantees this; the degenerate `««` input falls
       through to the shipped behaviour instead. */
    expect(speechOf('««Hola», dijo él.', conventionsFor('es')!).every((s) => s.length > 0)).toBe(true);
  });

  /* DEPTH 3 — the proviso's reason to exist. `main` already mis-parses these;
     the requirement is only that the fix does not make it worse by promoting a
     depth-3 quoted word to its own speech span, which the render then
     attributes and voices separately. Design § "Depth ≥ 3". */
  it.each([
    ['en', '“He told me, ‘She said “no” to him,’ and walked off,” Mary explained.', 'no'],
    ['zh', '「他说『她说「不」了』然后走了」她解释说。', '不'],
    ['ru', '«Он сказал „она сказала «нет» ему“ мне», объяснил он.', 'нет'],
    /* straight from the corpus: se/charlotte-perkins-gilman_moving-the-mountain */
    ['en', '“Mother had an old storybook,” Nellie remarked, “where somebody said, ‘You can’t always have your “druthers” ’—like home.”', 'druthers'],
  ])('%s: depth-3 nesting is not fragmented into a one-word span', (lang, body, fragment) => {
    expect(speechOf(body, conventionsFor(lang)!)).not.toContain(fragment);
  });

});

describe('parser — #2315 defect 2: a gained secondary run must not cut a tag clause', () => {
  const ru = conventionsFor('ru')!;
  const tiered = { ...ru, secondaryQuotePairs: [['‘', '’']] as Array<[string, string]> };
  const roster = [{ id: 'anton', name: 'Антон' }];
  const speakersOf = (body: string, conv: typeof ru) =>
    parseChapterStructure(body, buildNameIndex(roster as never, conv))
      .flatMap((p) => p.spans)
      .filter((s) => s.kind === 'speech')
      .map((s) => [body.slice(s.start, s.end), s.speaker?.characterId ?? null]);

  /* POSITIVE CONTROL, and it must come first: without it a zero below could
     mean "the metric cannot read a speaker at all". */
  it('control: with no secondary pair the turn is attributed', () => {
    expect(speakersOf('«Привет», сказал ‘Антон’.', ru)).toEqual([['Привет', 'anton']]);
  });

  it('the tag keeps its name when the tier is declared', () => {
    expect(speakersOf('«Привет», сказал ‘Антон’.', tiered)).toEqual([['Привет', 'anton']]);
  });

  /* MUST STILL WORK: a genuine secondary-convention SECOND TURN, which the
     guard must admit. The discriminator is the sentence boundary after the
     tag, not the verb. */
  it('a genuine secondary-convention second turn is still recovered', () => {
    expect(speakersOf('«Привет», сказал Антон. ‘Пока’, сказал Антон.', tiered)).toEqual([
      ['Привет', 'anton'], ['Пока', 'anton'],
    ]);
  });
});

describe('parser — #2315 PR #2340 review, finding 1: the guard is polarity-inverted for verb-before-quote languages', () => {
  const zhTier: LanguageConventions = { ...conventionsFor('zh')!, secondaryQuotePairs: [['‘', '’'], ['"', '"']] };
  const jaTier: LanguageConventions = { ...conventionsFor('ja')!, secondaryQuotePairs: [['"', '"']] };
  const speechOf = (body: string, conv: LanguageConventions) =>
    parseChapterStructure(body, buildNameIndex([], conv))
      .flatMap((p) => p.spans)
      .filter((s) => s.kind === 'speech')
      .map((s) => body.slice(s.start, s.end));
  const speakersOf = (body: string, conv: LanguageConventions, roster: Array<{ id: string; name: string }>) =>
    parseChapterStructure(body, buildNameIndex(roster as never, conv))
      .flatMap((p) => p.spans)
      .filter((s) => s.kind === 'speech')
      .map((s) => [body.slice(s.start, s.end), s.speaker?.characterId ?? null]);

  /* CONTROL, comes first: this exact shape has no false-cognate verb-stem
     substring nearby and already worked before this fix — proves the
     failures below are specifically about the polarity/substring bug, not
     about zh/ja parsing generally. */
  it('zh: control — no stray verb-stem substring nearby, the turn already survived', () => {
    expect(speechOf('他走在马路上，‘再见’，安东说。', zhTier)).toContain('再见');
  });

  /* zh/ja's canonical dialogue-tag order is VERB then quote ("他说，'你好'"),
     the mirror image of the Latin trailing-tag shape ("'Hi,' he said") the
     guard's clause-before-candidate model was built for. With NO primary run
     anywhere in the paragraph, there is no already-captured turn for a tag to
     be attributing — the candidate IS the turn, and the guard's verb check
     should never even run. Compounding: zh/ja verb stems are single
     characters with no word-boundary to stop a false match — 道 inside 道路
     ("road"), 道 inside 知道 ("know"), 笑 inside 微笑 ("smile", a genuine BEAT
     verb, but narration describing action BEFORE the quote, not a trailing
     name-tag AFTER it). Reproduced from PR #2340 review finding 1. */
  it.each([
    ['zh: 道 substring inside 道路 ("road")', '他走在道路上，‘再见’，安东说。', '再见'],
    ['zh: 道 substring inside 知道 ("know")', '他不知道，‘再见’，安东说。', '再见'],
    ['zh: 笑 — a real beat verb, but it is narration before the quote', '她微笑着，‘你好’，安东说。', '你好'],
  ])('%s: the turn is not swallowed', (_label, body, turn) => {
    expect(speechOf(body, zhTier)).toContain(turn);
  });

  it('ja: the mirror shape — 笑 inside 苦笑い ("smile ruefully")', () => {
    expect(speechOf('彼女は苦笑いして、"こんにちは"、アントンは言った。', jaTier)).toContain('こんにちは');
  });

  /* GENUINE TURN, END TO END: the leading clause ("安东说，") IS a real tag —
     it's just BEFORE the turn, not after it. Once the guard stops swallowing
     the candidate, the existing narration->tag reclassification (below, in
     parseQuoteParagraph) and anchorSpansFromTags already attribute it
     correctly; nothing else needs to change for this to work. */
  it('zh: a genuine leading-tag turn is admitted AND attributed to the name in front of it', () => {
    expect(speakersOf('安东说，‘你好’。', zhTier, [{ id: 'anton', name: '安东' }])).toEqual([['你好', 'anton']]);
  });

  /* MUST STILL DECLINE: the Latin-mimicking trailing-name-tag shape in zh
     glyphs, with a PRIMARY run already captured before the tag. The 42-case
     attribution family (reopen-sweep.test.ts) already covers this across all
     six languages including zh/ja; re-asserted narrowly here as the one
     shape this fix must NOT touch. */
  it('zh: a trailing name-tag AFTER an already-captured primary turn is still declined', () => {
    expect(speakersOf('「你好」，说道‘安东’。', zhTier, [{ id: 'anton', name: '安东' }])).toEqual([
      ['你好', 'anton'],
    ]);
  });
});

describe('parser — #2315 PR #2340 review, finding 2: a non-terminal . or ; must not defeat the guard', () => {
  const ruTier: LanguageConventions = { ...conventionsFor('ru')!, secondaryQuotePairs: [['‘', '’']] };
  const enTier: LanguageConventions = { ...conventionsFor('en')!, secondaryQuotePairs: [['«', '»']] };
  const speakersOf = (body: string, conv: LanguageConventions, roster: Array<{ id: string; name: string }>) =>
    parseChapterStructure(body, buildNameIndex(roster as never, conv))
      .flatMap((p) => p.spans)
      .filter((s) => s.kind === 'speech')
      .map((s) => [body.slice(s.start, s.end), s.speaker?.characterId ?? null]);

  it('ru: a decimal point in the tag clause does not reset the sentence-boundary scan', () => {
    expect(speakersOf('«Привет», сказал в 3.30 ‘Антон’.', ruTier, [{ id: 'anton', name: 'Антон' }])).toEqual([
      ['Привет', 'anton'],
    ]);
  });

  /* RESIDUAL, accepted (PR #2340 round 2 finding F1): an earlier revision
     excluded a period preceded by a short capitalised word ("Mr.", "Dr.")
     from counting as a sentence boundary, to keep this case declining. That
     exclusion is a NAME filter, not a title filter — a short capitalised
     name ("Ana.", "Jean.", "Иван.") matches the identical shape, and
     excluding it lost a genuine SECOND turn entirely in ALL 11 of 11
     second-turn shapes in the 22-case short-name attribution family (see
     reopen-sweep.test.ts) — a materially worse harm than this one. Corpus
     prevalence
     settled it: 0 of 726,385 real paragraphs exhibit the abbreviation shape
     at all, so the exclusion bought nothing measured. Pinned here as a
     known, accepted gap rather than silently reworked to keep passing. */
  it('en: an abbreviation period ("Mr.") in the tag clause is NOT specially handled — a known, accepted residual (PR #2340 F1)', () => {
    expect(speakersOf('“Hi,” said Mr. «Anton».', enTier, [{ id: 'anton', name: 'Anton' }])).toEqual([
      ['Hi,', null], ['Anton', null],
    ]);
  });

  it('ru: a semicolon in the tag clause does not terminate it — ; is not a sentence boundary', () => {
    // "вчера" (yesterday), not "он" — ru's addressee-disambiguation in
    // findSubjectName treats a subject PRONOUN between the verb and the name
    // as proof the name isn't the speaker (by design, unrelated to this
    // fix); an adverb there isn't a pronoun and doesn't trigger it.
    expect(speakersOf('«Привет», сказал вчера; ‘Антон’ кивнул.', ruTier, [{ id: 'anton', name: 'Антон' }])).toEqual([
      ['Привет', 'anton'],
    ]);
  });

  it('en: a mid-clause ellipsis does not terminate the scan', () => {
    expect(speakersOf('“Hi,” said… «Anton».', enTier, [{ id: 'anton', name: 'Anton' }])).toEqual([
      ['Hi,', 'anton'],
    ]);
  });

  /* MUST STILL WORK: a genuine sentence-ending period, short word or not
     ("он.", "Ana.") must still count as a real boundary — already covered by
     the existing "a genuine secondary-convention second turn is still
     recovered" test above (`он.`) and by the short-name attribution family
     in reopen-sweep.test.ts (`Ana.`/`Jean.`/`Иван.`/`Ann.`); not
     re-duplicated here. */
});

describe('parser — #2315 / #2346 known gap: the tag-clause guard is inert when no primary run precedes the candidate', () => {
  /* PR #2340 round 2 finding F2, title corrected in round 3 (finding C2):
     `precededByPrimaryRun` is set only for a primary run whose
     `end <= cand.start` — the real condition is "no primary run ENDS BEFORE
     this candidate", not "no primary run anywhere in the paragraph". A
     paragraph CAN carry a primary run and still be fully inert for a
     candidate that sits before it — the third case below (`Said «Anton»,
     "Hi there."`) is exactly that: `"…"` IS an `en` primary pair, so this
     paragraph has a primary run, just one that comes AFTER «Anton» rather
     than before it.

     The obvious repair (check `out`, i.e. primary + already-accepted
     secondary runs, instead of `primaryRuns` alone) fixes these three cases
     but re-declines 5,892 genuine spans in one real Chinese book
     (`pg/zh/23835.txt`) at corpus scale — reinstating round 1's MAJOR
     finding under a different trigger. The real fix needs a discriminator
     that separates "the verb belongs to the PRECEDING turn's trailing tag"
     (decline) from "the verb introduces the FOLLOWING turn" (admit) — a
     word-order typology question with more than one defensible encoding,
     which is why this is filed rather than guessed:
     https://github.com/dudarenok-maker/Castwright/issues/2346.

     Measured exposed population against #2286's actual tables: 2,202 real
     corpus paragraphs (paragraph-level; a run-level measurement — a primary
     run exists but doesn't precede — finds 2,221 paragraphs / 8,802 inert
     runs, confirming the paragraph-level figure is a conservative
     under-count, not an over-count). A RAW two-secondary-spans-around-a-tag
     proxy fires on 1,164 of the 2,202 — **but PR #2340 round 3 finding C1
     found that raw count overstates the harm by ~100×**: it fires on an
     ordinary correctly-parsed two-turn paragraph just as readily as on the
     harmful shape, and for 94% of its mass (the same one book) it is the
     former. Classified (generous upper bound: short, unpunctuated, <=3
     words / <=5 CJK characters), the true figure is <=21 of 1,164 (1.8%).
     **Do not target the raw 1,164 for reduction — #2346 has the full
     breakdown and says this explicitly.** Pinned here as a KNOWN, TRACKED
     gap — this test pins DEFECT A (the guard is INERT where no primary run
     precedes the candidate), which #2346's design accepted and priced rather
     than fixed; it is expected to keep passing. The shipped change is defect B
     (the guard FIRING on a leading tag, #2427), a disjoint population separated
     by `precededByPrimaryRun` — never average the two. Delete this test only if
     defect A is itself fixed, not adjusted to pass again. */
  const ruTier: LanguageConventions = { ...conventionsFor('ru')!, secondaryQuotePairs: [['‘', '’']] };
  const enTier: LanguageConventions = { ...conventionsFor('en')!, secondaryQuotePairs: [['«', '»']] };
  const speakersOf = (body: string, conv: LanguageConventions, roster: Array<{ id: string; name: string }>) =>
    parseChapterStructure(body, buildNameIndex(roster as never, conv))
      .flatMap((p) => p.spans)
      .filter((s) => s.kind === 'speech')
      .map((s) => [body.slice(s.start, s.end), s.speaker?.characterId ?? null]);

  it('ru: a whole paragraph in one secondary pair loses both speakers (#2346)', () => {
    expect(speakersOf('‘Привет’, сказал ‘Антон’.', ruTier, [{ id: 'anton', name: 'Антон' }])).toEqual([
      ['Привет', null], ['Антон', null],
    ]);
  });

  it('en: a whole paragraph in one secondary pair loses both speakers (#2346)', () => {
    expect(speakersOf('«Hi», said «Anton».', enTier, [{ id: 'anton', name: 'Anton' }])).toEqual([
      ['Hi', null], ['Anton', null],
    ]);
  });

  it('en: a leading-tag secondary-only turn loses its speaker too (#2346)', () => {
    expect(speakersOf('Said «Anton», "Hi there."', enTier, [{ id: 'anton', name: 'Anton' }])).toEqual([
      ['Anton', null], ['Hi there.', null],
    ]);
  });
});

describe('parser — #2315 residuals, accepted (design § Residuals)', () => {
  const speechOf = (body: string, conv: LanguageConventions) =>
    parseChapterStructure(body, buildNameIndex([], conv))
      .flatMap((p) => p.spans)
      .filter((s) => s.kind === 'speech')
      .map((s) => body.slice(s.start, s.end));

  /* 1a — the CROSS-GLYPH straddle. This interval geometry is byte-for-byte a
     legitimate nest, and it occurs in 5,267 of 239,725 real corpus paragraphs
     where it is overwhelmingly correct. Every rule that acts on it was
     measured: `R2` removes 601,392 characters of real speech; `R4` lets a
     quoted word in narration change how a later turn parses. */
  it('residual 1a: a cross-glyph straddle still swallows the next turn', () => {
    expect(
      speechOf('«Hola», dijo él, mirando el “cartel de Fausto. «Y tú», preguntó ella, cerca de la galería”.', conventionsFor('es')!),
    ).toEqual(['Hola', 'cartel de Fausto. «Y tú», preguntó ella, cerca de la galería']);
  });
  /* 1b — the SYMMETRIC delimiter. With `"` the opener and the closer are the
     same character, so an odd count means one is unpaired and nothing local can
     say which. Irreducible: even `R2`, the ceiling, leaves this class. */
  it('residual 1b: a stray ASCII " still swallows the next turn', () => {
    expect(
      speechOf('“Hi”, he said, passing the "Faust poster. "Bye", she said, near the gallery".', conventionsFor('en')!),
    ).toEqual(['Hi', 'Faust poster. ', ', she said, near the gallery']);
  });
  /* 3 — depth >= 3 nesting is STILL mis-parsed; `main` truncates at the
     depth-3 closer and this change leaves that untouched. Pinned so the
     pre-existing defect is visible rather than assumed fixed. */
  it('residual 3: depth-3 nesting is still truncated at the depth-3 closer', () => {
    expect(speechOf('“He told me, ‘She said “no” to him,’ and walked off,” Mary explained.', conventionsFor('en')!))
      .toEqual(['He told me, ‘She said “no']);
  });
});

describe('parser — #2315 PR #2340 review finding 3: the re-open bound is not quadratic', () => {
  /* Pre-fix, an accepted run advanced the scan past its own closer, so each
     opener occurrence cost one forward closer-scan. The re-open bound alone
     (`pos = cut`) resumes only two characters past a re-opened glyph, so a
     paragraph with N consecutive same-glyph re-opens and no real closer
     until the very end paid a full closer-scan N times: O(n^2). Measured
     pre-fix on this exact input: len 64,001 took 4,625ms (x10,381 over the
     pre-#2315 baseline). The REOPEN_CHAIN_LIMIT bound in scanQuoteRuns caps
     this to O(REOPEN_CHAIN_LIMIT * n) — linear in the input length. Every
     length gets a generous ceiling (not a tight one, to avoid flaking on a
     loaded CI runner) — the point is bounding catastrophic quadratic growth,
     not chasing a specific millisecond figure. */
  const en = conventionsFor('en')!;
  const idx = buildNameIndex([], en);

  it.each([8001, 16001, 32001, 64001])('len %i completes in well under a second', (n) => {
    const line = '“a'.repeat((n - 1) / 2) + '”';
    expect(line.length).toBe(n);
    const start = performance.now();
    parseChapterStructure(line, idx);
    const ms = performance.now() - start;
    expect(ms, `took ${ms.toFixed(1)}ms`).toBeLessThan(750);
  });
});
