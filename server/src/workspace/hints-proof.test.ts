/* checkParseHintsPairing (#3837, plan 290): does a same-count parse fallback
 * still pair with state.json, judged by the saved sentences? Hand-built
 * fixtures, not real books. Each block names the plan mutation it catches
 * (plan 290 "Mutations"); the M3, M4, M5, M21 and M29 verdicts were measured
 * on the calibration probes before the fixtures were written. */

import { describe, it, expect } from 'vitest';
import {
  checkParseHintsPairing,
  normaliseForProof,
  normaliseSentenceForProof,
  PROOF_EVIDENCE_MIN_LEN,
  PROOF_MARGIN,
  PROOF_OWN_MIN_DEN,
  PROOF_OWN_MIN_NUM,
  DISPLACED_BLOCK_LEN,
  type PairingInput,
} from './hints-proof.js';
import { normaliseForMatch } from '../util/text-match.js';

type Sentence = PairingInput['sentences'][number];

/** A distinct >= 24-character line for chapter `c`, item `k`. */
const own = (c: number, k: number) => `Chapter ${c} own evidence sentence number ${k} here.`;
/** A >= 24-character line no piece holds. */
const nowhere = (k: number) => `This absent sentence ${k} is in no chapter at all.`;
/** A >= 24-character line the fixture places in another chapter's piece. */
const moved = (k: number) => `The moved line number ${k} sits in another chapter.`;

const says = (chapterId: number, texts: string[]): Sentence[] => texts.map((text) => ({ chapterId, text }));

/** State chapters 1..n whose titles equal the parse titles, so only the
    sentence rule decides unless a test drifts a title on purpose. */
function input(
  bodies: string[],
  sentences: Sentence[],
  opts: {
    evidenceLess?: PairingInput['evidenceLess'];
    stateTitles?: string[];
    parseTitles?: Array<string | null>;
  } = {},
): PairingInput {
  const parseTitles = opts.parseTitles ?? bodies.map((_, i) => `Heading ${i + 1}`);
  const stateTitles = opts.stateTitles ?? parseTitles.map((t, i) => t ?? `Chapter ${i + 1}`);
  return {
    stateChapters: bodies.map((_, i) => ({ id: i + 1, title: stateTitles[i]! })),
    sentences,
    parse: bodies.map((body, i) => ({ title: parseTitles[i]!, body })),
    evidenceLess: opts.evidenceLess ?? 'count-id',
  };
}

const range = (n: number) => Array.from({ length: n }, (_, k) => k);
const ownLines = (c: number, n: number) => range(n).map((k) => own(c, k));
const body = (lines: string[]) => ['It began.', ...lines, 'It ended.'].join('\n');

describe('constants', () => {
  it('are the calibrated values', () => {
    expect([PROOF_OWN_MIN_NUM, PROOF_OWN_MIN_DEN, PROOF_MARGIN, PROOF_EVIDENCE_MIN_LEN, DISPLACED_BLOCK_LEN]).toEqual([
      2, 5, 4, 24, 3,
    ]);
  });
});

describe('normalisation', () => {
  it('decodes named and numeric entities', () => {
    expect(normaliseForProof('It&rsquo;s &ldquo;fine&rdquo; &mdash; &hellip; &amp; &#39;x&#x27; &lt;y&gt;')).toBe(
      `it's "fine" - ... & 'x' <y>`,
    );
    expect(normaliseForProof('a&nbsp;b &apos;c&quot; &lsquo;d&rsquo; e&ndash;f')).toBe(`a b 'c" 'd' e-f`);
  });

  it('leaves an unknown named entity and an out-of-range code point alone', () => {
    expect(normaliseForProof('a &bogus; b')).toBe('a &bogus; b');
    expect(normaliseForProof('a &#99999999; &#x110000; b')).toBe('a &#99999999; &#x110000; b');
  });

  it('applies NFC', () => {
    expect(normaliseForProof('Cafe\u0301')).toBe('caf\u00e9');
  });

  it('folds curly quotes, guillemets, the dash set and the ellipsis', () => {
    expect(normaliseForProof('‘a’ ‚b‛ ‹c› d′')).toBe("'a' 'b' 'c' d'");
    expect(normaliseForProof('“a” „b‟ «c» d″')).toBe('"a" "b" "c" d"');
    expect(normaliseForProof('a‐b‑c‒d–e—f―g−h')).toBe('a-b-c-d-e-f-g-h');
    expect(normaliseForProof('Wait…')).toBe('wait...');
  });

  it('folds ё to е and lower-cases', () => {
    expect(normaliseForProof('Ёлка ЕЩЁ')).toBe('елка еще');
  });

  it('collapses whitespace runs, NBSP included, and trims', () => {
    expect(normaliseForProof('  a \t\n b\u00a0\u00a0c  ')).toBe('a b c');
  });

  it('removes the analyzer tag vocabulary anywhere, both sides (M5)', () => {
    expect(normaliseForProof('[excited] x')).toBe('x');
    expect(normaliseSentenceForProof('"[excited] x"')).toBe('x');
    expect(normaliseSentenceForProof('He said, "[excited] Go!"')).toBe('he said, "go!');
    expect(normaliseForProof('He said, "[excited] Go!"')).toBe(normaliseForProof('He said, "Go!"'));
    expect(normaliseForProof('She turned and [whispers] said it.')).toBe('she turned and said it.');
    expect(normaliseForProof('[Shouting] Out!')).toBe('out!');
  });

  it('keeps manuscript text in brackets', () => {
    expect(normaliseForProof('[FILE INACCESSIBLE] x')).toBe('[file inaccessible] x');
    expect(normaliseForProof('[AND NOW…]')).toBe('[and now...]');
  });

  it('the sentence side strips a leading and trailing run of whitespace and quotes (M6)', () => {
    expect(normaliseSentenceForProof(' "\'`Hello there`\'" ')).toBe('hello there');
    expect(normaliseForProof(' "Hello" ')).toBe('"hello"');
  });

  it('does not change normaliseForMatch', () => {
    expect(normaliseForMatch('[excited] x')).toBe('[excited] x');
    expect(normaliseForMatch('It&rsquo;s')).toBe('it&rsquo;s');
    expect(normaliseForMatch('Ёлка')).toBe('ёлка');
    expect(normaliseForMatch('“Wait…” — ‘no’')).toBe('wait..." - \'no');
  });
});

describe('the per-chapter rule', () => {
  /* Chapter 1 has E = 10 (or 11) items: `o` in its own piece, `a` only in piece 2, the
     rest nowhere. Chapter 2 has no evidence. */
  function scored(o: number, a: number, e = 10) {
    const items = [...ownLines(1, o), ...range(a).map(moved), ...range(e - o - a).map(nowhere)];
    return checkParseHintsPairing(
      input([body(ownLines(1, o)), body(range(a).map(moved))], says(1, items)),
    );
  }

  it('40% floor (M1): own = 4 of 10 pairs, own = 3 of 10 does not', () => {
    expect(scored(4, 0)).toEqual({ paired: true, evidenceChapters: 1 });
    expect(scored(3, 0)).toEqual({
      paired: false,
      evidenceChapters: 1,
      reason: 'score',
      chapterId: 1,
      own: 3,
      alt: 0,
      evidence: 10,
    });
  });

  it('4x margin (M2): own = 8, alt = 2 pairs; own = 6, alt = 2 does not; own = 9, alt = 2 pairs', () => {
    expect(scored(8, 2).paired).toBe(true);
    expect(scored(6, 2)).toMatchObject({ paired: false, reason: 'score', own: 6, alt: 2, evidence: 10 });
    /* own + alt cannot exceed E, so the own = 9 case needs E = 11. */
    expect(scored(9, 2, 11).paired).toBe(true);
  });

  it('alt counts only items absent from the own piece: a recap chapter pairs (M13)', () => {
    const recap = ownLines(1, 5);
    const r = checkParseHintsPairing(
      input([body(recap), body([...recap, ...ownLines(2, 5)])], [...says(1, recap), ...says(2, ownLines(2, 5))]),
    );
    expect(r).toEqual({ paired: true, evidenceChapters: 2 });
  });
});

describe('every saved sentence counts (M21)', () => {
  it('a refrain saved 8 times plus 2 other lines, all in the own piece, pairs', () => {
    const refrain = 'And still the river kept on running past.';
    const lines = [...Array(8).fill(refrain), own(1, 0), own(1, 1)];
    const r = checkParseHintsPairing(input([body([refrain, own(1, 0), own(1, 1)]), body(['Other.'])], says(1, lines)));
    expect(r).toEqual({ paired: true, evidenceChapters: 1 });
  });

  it('12 own items plus a line saved 3 times that only the next piece holds is refused displaced-block', () => {
    const dup = 'The refrain only ever appears in chapter two.';
    const r = checkParseHintsPairing(
      input(
        [body(ownLines(1, 12)), body([...ownLines(2, 5), dup])],
        [...says(1, [...ownLines(1, 12), dup, dup, dup]), ...says(2, ownLines(2, 5))],
      ),
    );
    expect(r).toEqual({ paired: false, evidenceChapters: 2, reason: 'displaced-block', chapterId: 1, intoChapterId: 2 });
  });
});

describe('the evidence floor', () => {
  it('M3: short (20-23 char) lines displaced into the next piece are not evidence', () => {
    const L = (c: number, k: number) =>
      `Chapter ${['one', 'two', 'three'][c]} unique line number ${['a', 'b', 'c', 'd'][k]} here.`;
    const short = ['The lamp flickered out.', 'Nobody answered at all.', 'Rain hit the window.'];
    expect(short.map((s) => normaliseSentenceForProof(s).length)).toEqual([23, 23, 20]);
    const bodies = [0, 1, 2].map((c) => body([...range(4).map((k) => L(c, k)), ...(c === 1 ? short : [])]));
    const sentences = [
      ...[0, 1, 2].flatMap((c) => says(c + 1, range(4).map((k) => L(c, k)))),
      ...says(1, short),
    ];
    expect(checkParseHintsPairing(input(bodies, sentences))).toEqual({ paired: true, evidenceChapters: 3 });
  });

  /* A same-count reorder whose only evidence is mid-body lines of the given text,
     checked under count-id so the title rule cannot mask a floor mutant. */
  function swapped(mid: string[]) {
    return checkParseHintsPairing(
      input(
        mid.map((t) => body([t])),
        [...says(1, [mid[1]!]), ...says(2, [mid[0]!]), ...says(3, [mid[2]!])],
        { evidenceLess: 'count-id' },
      ),
    );
  }

  it('M4: a reorder whose evidence is 25-26 chars is refused', () => {
    const mid = ['The bells rang out twice.', 'A grey gull stole the bun.', 'The ferry left without us.'];
    expect(mid.map((s) => normaliseSentenceForProof(s).length)).toEqual([25, 26, 26]);
    expect(swapped(mid)).toMatchObject({ paired: false, reason: 'score', chapterId: 1, own: 0, alt: 1, evidence: 1 });
  });

  it('M29: a reorder whose evidence is exactly 24 chars is refused (>= 24, not > 24)', () => {
    const mid = ['The bells rang out at 9.', 'A gull stole a bun at 7.', 'The ferry left us at 10.'];
    expect(mid.map((s) => normaliseSentenceForProof(s).length)).toEqual([24, 24, 24]);
    expect(swapped(mid)).toMatchObject({ paired: false, reason: 'score', chapterId: 1, own: 0, alt: 1, evidence: 1 });
  });
});

describe('audio tags (M5)', () => {
  it('a chapter whose evidence carries mid-sentence tags pairs', () => {
    const plain = range(4).map((k) => `She turned to the door number ${k} and said it.`);
    const tagged = range(4).map((k) => `She turned to the door number ${k} and [whispers] said it.`);
    const r = checkParseHintsPairing(
      input([body([...plain, own(1, 0)]), body(['Other.'])], says(1, [...tagged, own(1, 0)])),
    );
    expect(r).toEqual({ paired: true, evidenceChapters: 1 });
  });

  it('12 own plain items plus 3 tagged lines the parse holds only in the next piece is refused displaced-block', () => {
    const lines = [0, 1, 2].map(moved);
    const r = checkParseHintsPairing(
      input(
        [body(ownLines(1, 12)), body([...ownLines(2, 5), ...lines])],
        [...says(1, [...ownLines(1, 12), ...lines.map((t) => `[excited] ${t}`)]), ...says(2, ownLines(2, 5))],
      ),
    );
    expect(r).toEqual({ paired: false, evidenceChapters: 2, reason: 'displaced-block', chapterId: 1, intoChapterId: 2 });
  });

  it('a content-side tag in the manuscript body does not break a match', () => {
    const r = checkParseHintsPairing(
      input(
        [body(['He said, "[excited] Go now, before the lights fail!"']), body(['Other.'])],
        says(1, ['He said, "Go now, before the lights fail!"']),
      ),
    );
    expect(r).toEqual({ paired: true, evidenceChapters: 1 });
  });
});

describe('model re-splitting (M6)', () => {
  it('a quotation re-split into pieces, each re-wrapped in quotes, pairs', () => {
    const r = checkParseHintsPairing(
      input(
        [
          body(['"I will go down to the market today, and then I will come home quickly, before dark," she said.']),
          body(['Other.']),
        ],
        says(1, ['"I will go down to the market today,"', '"and then I will come home quickly,"', '"before dark," she said.']),
      ),
    );
    expect(r).toEqual({ paired: true, evidenceChapters: 1 });
  });
});

describe('vocalizations and orphans', () => {
  it('vocalization sentences are not evidence (M7)', () => {
    const vocal: Sentence[] = range(6).map((k) => ({
      chapterId: 1,
      text: `Mmm, a long thoughtful hum number ${k} here.`,
      vocalization: true,
    }));
    const r = checkParseHintsPairing(
      input([body(ownLines(1, 2)), body(['Other.'])], [...vocal, ...says(1, ownLines(1, 2))]),
    );
    expect(r).toEqual({ paired: true, evidenceChapters: 1 });
  });

  it('orphan sentences are ignored, even when their text is in another piece (M8)', () => {
    const r = checkParseHintsPairing(
      input(
        [body(ownLines(1, 3)), body(ownLines(2, 3))],
        [...says(1, ownLines(1, 3)), ...says(2, ownLines(2, 3)), ...says(99, [...ownLines(2, 3), nowhere(0)])],
      ),
    );
    expect(r).toEqual({ paired: true, evidenceChapters: 2 });
  });

  it('excludeFromSynthesis sentences are manuscript residue and count', () => {
    const sentences: Sentence[] = [
      { chapterId: 1, text: own(2, 0), excludeFromSynthesis: true } as Sentence,
      ...says(2, [own(1, 0)]),
    ];
    const r = checkParseHintsPairing(input([body([own(1, 0)]), body([own(2, 0)])], sentences));
    expect(r).toMatchObject({ paired: false, reason: 'score', chapterId: 1 });
  });

  it('a non-string or empty text is not evidence', () => {
    const sentences: Sentence[] = [
      { chapterId: 1, text: 42 },
      { chapterId: 1 },
      { chapterId: 1, text: '   ' },
      ...says(1, [own(1, 0)]),
    ];
    expect(checkParseHintsPairing(input([body([own(1, 0)]), body(['Other.'])], sentences))).toEqual({
      paired: true,
      evidenceChapters: 1,
    });
  });
});

describe('A5: file order is not used', () => {
  it('a chapter whose split-sentence pieces sit at the end of file order still pairs', () => {
    const lines = ownLines(1, 6);
    const r = checkParseHintsPairing(
      input([body(lines), body(ownLines(2, 2))], [...says(1, lines.slice(2)), ...says(2, ownLines(2, 2)), ...says(1, lines.slice(0, 2))]),
    );
    expect(r).toEqual({ paired: true, evidenceChapters: 2 });
  });
});

describe('the block check (M9, M10)', () => {
  /* Chapter 1: `nOwn` own lines plus the `displaced` lines, which only piece 2 holds. */
  function shifted(nOwn: number, displaced: string[]) {
    return checkParseHintsPairing(
      input(
        [body(ownLines(1, nOwn)), body([...ownLines(2, 5), ...displaced])],
        [...says(1, [...ownLines(1, nOwn), ...displaced]), ...says(2, ownLines(2, 5))],
      ),
    );
  }

  it('exactly 3 items displaced into one neighbour, score passing, are refused', () => {
    expect(shifted(12, [0, 1, 2].map(moved))).toEqual({
      paired: false,
      evidenceChapters: 2,
      reason: 'displaced-block',
      chapterId: 1,
      intoChapterId: 2,
    });
  });

  it('2 displaced items pair', () => {
    expect(shifted(12, [0, 1].map(moved))).toEqual({ paired: true, evidenceChapters: 2 });
  });

  it('3 items displaced into 3 different pieces pair', () => {
    const r = checkParseHintsPairing(
      input(
        [body(ownLines(1, 12)), body([moved(0)]), body([moved(1)]), body([moved(2)])],
        says(1, [...ownLines(1, 12), moved(0), moved(1), moved(2)]),
      ),
    );
    expect(r).toEqual({ paired: true, evidenceChapters: 1 });
  });

  it('a none-target item sorting between displaced items breaks the streak (blind spot 1)', () => {
    const common = 'A common line that two later chapters both hold.';
    const r = checkParseHintsPairing(
      input(
        [body(ownLines(1, 16)), body([moved(0), common, moved(1), moved(2)]), body([common])],
        says(1, [...ownLines(1, 16), moved(0), common, moved(1), moved(2)]),
      ),
    );
    expect(r).toEqual({ paired: true, evidenceChapters: 1 });
  });

  it('an item found nowhere neither breaks nor extends a streak', () => {
    const r = checkParseHintsPairing(
      input(
        [body(ownLines(1, 12)), body([moved(0), moved(1), moved(2)])],
        says(1, [...ownLines(1, 12), moved(0), nowhere(0), moved(1), moved(2)]),
      ),
    );
    expect(r).toMatchObject({ paired: false, reason: 'displaced-block', chapterId: 1, intoChapterId: 2 });
  });

  it('file order is not parse order: D1, O1, D2, O2, D3 in the edits is refused', () => {
    const O = ownLines(1, 12);
    const D = [0, 1, 2].map(moved);
    const r = checkParseHintsPairing(
      input([body(O), body(D)], says(1, [D[0]!, O[0]!, D[1]!, O[1]!, D[2]!, ...O.slice(2)])),
    );
    expect(r).toMatchObject({ paired: false, reason: 'displaced-block', chapterId: 1, intoChapterId: 2 });
  });
});

describe('evidence-less positions (M11, M12)', () => {
  const bodies = [body(ownLines(1, 3)), body(['Short.']), body(['Tiny.'])];
  const paused = input(bodies, says(1, ownLines(1, 3)), {
    parseTitles: ['One', 'Two', 'Three'],
    stateTitles: ['One', 'Old Two', 'Old Three'],
  });

  it('a paused book with drifted tail titles pairs under count-id', () => {
    expect(checkParseHintsPairing({ ...paused, evidenceLess: 'count-id' })).toEqual({ paired: true, evidenceChapters: 1 });
  });

  it('the same book is refused title under title', () => {
    expect(checkParseHintsPairing({ ...paused, evidenceLess: 'title' })).toEqual({
      paired: false,
      evidenceChapters: 1,
      reason: 'title',
      chapterId: 2,
    });
  });

  it('a book with no evidence and one disagreeing title: refused under title, pairs under count-id', () => {
    const none = input([body(['Short.']), body(['Tiny.'])], says(1, ['Yes.', 'Okay, fine.']), {
      parseTitles: ['One', 'Two'],
      stateTitles: ['One', 'Zwei'],
    });
    expect(checkParseHintsPairing({ ...none, evidenceLess: 'title' })).toEqual({
      paired: false,
      evidenceChapters: 0,
      reason: 'title',
      chapterId: 2,
    });
    expect(checkParseHintsPairing({ ...none, evidenceLess: 'count-id' })).toEqual({ paired: true, evidenceChapters: 0 });
  });

  it('evidence-less positions use titlePairsAt: null parse title and titleOverridden pair', () => {
    const r = checkParseHintsPairing({
      stateChapters: [
        { id: 1, title: 'Chapter 1' },
        { id: 2, title: 'Mine', titleOverridden: true },
      ],
      sentences: [],
      parse: [
        { title: null, body: 'x' },
        { title: 'Theirs', body: 'y' },
      ],
      evidenceLess: 'title',
    });
    expect(r).toEqual({ paired: true, evidenceChapters: 0 });
  });
});

describe('the title is part of candidate content (M14)', () => {
  it('a chapter whose only evidence is a subtitle line the parse now holds in its title pairs', () => {
    const r = checkParseHintsPairing(
      input([body(['Short.']), body(['Tiny.'])], says(1, ['The Long Road Through the Hills Again']), {
        parseTitles: ['The Long Road Through the Hills Again', 'Two'],
        stateTitles: ['Chapter One', 'Two'],
      }),
    );
    expect(r).toEqual({ paired: true, evidenceChapters: 1 });
  });
});

describe('known refusals and the renamed heading', () => {
  it('a same-count reorder of two evidence chapters is refused', () => {
    const bodies = [body(ownLines(1, 4)), body(ownLines(2, 4)), body(ownLines(3, 4))];
    /* State order is 1, 3, 2: its chapter 2 holds what the parse has third. */
    const r = checkParseHintsPairing(
      input(bodies, [...says(1, ownLines(1, 4)), ...says(2, ownLines(3, 4)), ...says(3, ownLines(2, 4))], {
        evidenceLess: 'title',
      }),
    );
    expect(r).toMatchObject({ paired: false, reason: 'score', chapterId: 2, own: 0, alt: 4, evidence: 4 });
  });

  it('the PR #3835 epigraph swap is refused', () => {
    const epigraph = '"All rivers run to the sea, yet the sea is not full."';
    const r = checkParseHintsPairing(
      input(
        [body([epigraph]), body(ownLines(1, 4)), body(ownLines(2, 4))],
        [...says(1, ownLines(1, 4)), ...says(2, [epigraph]), ...says(3, ownLines(2, 4))],
        { parseTitles: ['Epigraph', 'Chapter 1', 'Chapter 2'], stateTitles: ['Chapter 1', 'Epigraph', 'Chapter 2'] },
      ),
    );
    expect(r).toMatchObject({ paired: false, reason: 'score', chapterId: 1 });
  });

  it('the lead section swapped with "Chapter 2" is refused', () => {
    const r = checkParseHintsPairing(
      input(
        [body(ownLines(0, 4)), body(ownLines(1, 4)), body(ownLines(2, 4))],
        [...says(1, ownLines(2, 4)), ...says(2, ownLines(1, 4)), ...says(3, ownLines(0, 4))],
        { parseTitles: [null, 'Chapter 1', 'Chapter 2'], stateTitles: ['Chapter 2', 'Chapter 1', 'Chapter 3'] },
      ),
    );
    expect(r).toMatchObject({ paired: false, reason: 'score', chapterId: 1 });
  });

  it('a renamed "Chapter N" heading on an evidence chapter pairs, under title too', () => {
    const r = checkParseHintsPairing(
      input([body(ownLines(1, 4)), body(ownLines(2, 4))], [...says(1, ownLines(1, 4)), ...says(2, ownLines(2, 4))], {
        parseTitles: ['Chapter 1', 'Chapter Two: The Crossing'],
        stateTitles: ['Chapter 1', 'Chapter 2'],
        evidenceLess: 'title',
      }),
    );
    expect(r).toEqual({ paired: true, evidenceChapters: 2 });
  });
});

describe('guards and runtime', () => {
  it('a length mismatch throws', () => {
    const i = input([body(['a']), body(['b'])], []);
    expect(() => checkParseHintsPairing({ ...i, parse: i.parse.slice(1) })).toThrow();
  });

  it('a 90-chapter, 10,000-sentence book checks in under 2 s', () => {
    const n = 90;
    const per = Math.ceil(10_000 / n);
    /* Lines vary in their first 8 characters, as prose does. The index looks an
       item up by its first 8, so lines that all share them (like `own()`'s
       "chapter ") make every lookup a scan of the whole book. */
    const line = (c: number, k: number) => `${k} of chapter ${c}: a long synthetic evidence line.`;
    const lines = (c: number) => range(per).map((k) => line(c, k));
    const bodies = range(n).map((c) => body(lines(c + 1)));
    const sentences = range(n).flatMap((c) => says(c + 1, lines(c + 1)));
    expect(sentences.length).toBeGreaterThanOrEqual(10_000);
    const t0 = performance.now();
    const r = checkParseHintsPairing(input(bodies, sentences));
    const ms = performance.now() - t0;
    expect(r).toEqual({ paired: true, evidenceChapters: n });
    expect(ms).toBeLessThan(2000);
  });
});
