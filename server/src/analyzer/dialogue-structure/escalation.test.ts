import { describe, expect, it, vi } from 'vitest';
import { conventionsFor } from './lang/index.js';
import { buildNameIndex } from './name-matcher.js';
import { parseChapterStructure } from './parser.js';
import { resolveWindows } from './windows.js';
import { crossExamine } from './cross-examine.js';
import { alignSentences } from './aligner.js';
import { escalateFlaggedWindows } from './escalation.js';
import type { Analyzer, StageCall } from '../index.js';
import type { EscalationOutput } from '../../handoff/schemas.js';
import type { SentenceOutput } from '../../handoff/schemas.js';
import { MALE_BUCKET_ID, FEMALE_BUCKET_ID } from '../fold-minor-cast.js';

/* srv-59 Task 9b. escalateFlaggedWindows groups the flagged dialogue lines
   crossExamine (Task 7) left unresolved into their conversation window,
   queries a small plain-text prompt through the escalation analyzer
   primitive (Task 9), and applies an accepted answer back onto
   `sentences` — subject to the hard invariant: never override a
   `tag-name`-anchored line, no matter what the model returns.

   Fixture: a real parser/windows pipeline (not synthetic AlignedSentence
   fixtures) — escalateFlaggedWindows re-derives alignment itself from
   `paras`/`body`, so the window-grouping and marker-placement logic needs
   real paragraph offsets, not hand-rolled ones.

     0: "He waited quietly."            narration, short (preceding context)
     1: '"Ready?" said Anton.'          dialogue, tag-name: anton
     2: '"Ready," said Olga.'           dialogue, tag-name: olga
     3: '"Confirmed," said Boris.'      dialogue, tag-name: boris
        (3 anchored speakers -> windows.ts's alternation fill never engages,
        so the next two turns stay genuinely `unanchored`, not guessed)
     4: '"Then let\'s go."'             dialogue, UNANCHORED -> flagged
     5: '"After you."'                  dialogue, UNANCHORED -> flagged
     6: "She smiled and walked ahead."  narration, short (following context)
*/

const ROSTER = ['anton', 'olga', 'boris', 'narrator'];

function buildFixture() {
  const enIdx = buildNameIndex(
    [
      { id: 'anton', name: 'Anton' },
      { id: 'olga', name: 'Olga' },
      { id: 'boris', name: 'Boris' },
    ],
    conventionsFor('en')!,
  );
  const body = [
    'He waited quietly.',
    '"Ready?" said Anton.',
    '"Ready," said Olga.',
    '"Confirmed," said Boris.',
    '"Then let\'s go."',
    '"After you."',
    'She smiled and walked ahead.',
  ].join('\n');

  const paras = parseChapterStructure(body, enIdx);
  resolveWindows(paras, { anton: 'male', olga: 'female', boris: 'male' }, null);

  const sentences: SentenceOutput[] = [
    { id: 1, chapterId: 1, characterId: 'anton', text: 'Ready?' },
    { id: 2, chapterId: 1, characterId: 'olga', text: 'Ready,' },
    { id: 3, chapterId: 1, characterId: 'boris', text: 'Confirmed,' },
    { id: 4, chapterId: 1, characterId: 'narrator', text: "Then let's go." },
    { id: 5, chapterId: 1, characterId: 'narrator', text: 'After you.' },
  ];

  const alignment = alignSentences(sentences, paras, body);
  const examined = crossExamine(alignment, {
    rosterIds: new Set(ROSTER),
    unknownBucketIds: new Set([MALE_BUCKET_ID, FEMALE_BUCKET_ID]),
    alignmentFloorPct: 80,
  });
  // Sanity-check the fixture's shape before it's used as the input to every test.
  expect(examined.flags).toEqual([
    { index: 3, reason: 'unanchored-narrator' },
    { index: 4, reason: 'unanchored-narrator' },
  ]);
  return { body, paras, sentences: examined.sentences, flags: examined.flags };
}

/** Same shape as buildFixture, but EVERY core-dialogue paragraph (all 5,
    including both flagged unanchored lines) is padded well past its
    equal-share of MAX_WINDOW_CHARS (1500) — the window's core dialogue
    alone exceeds the cap before any short-narration context is even
    considered, exercising the hard-slice fallback branch. Padding all 5
    (not just one) means per-paragraph truncation fires on every paragraph,
    which is what exercises the join-separator budget: with N=5 paragraphs
    joined by 4 '\n' separators, the old `floor(1500/N)` calc let each
    paragraph fill its FULL share and then added the separators on top,
    landing the joined text at 1504 chars (4 over cap) — see srv-59 Minor. */
function buildOversizedFixture() {
  const enIdx = buildNameIndex(
    [
      { id: 'anton', name: 'Anton' },
      { id: 'olga', name: 'Olga' },
      { id: 'boris', name: 'Boris' },
    ],
    conventionsFor('en')!,
  );
  const filler = 'lorem '.repeat(60); // ~360 chars — over any 5-way equal share of 1500
  const body = [
    'He waited quietly.',
    `"Ready? ${filler}" said Anton.`,
    `"Ready, ${filler}" said Olga.`,
    `"Confirmed, ${filler}" said Boris.`,
    `"Then let's go. ${filler}"`,
    `"After you. ${filler}"`,
    'She smiled and walked ahead.',
  ].join('\n');

  const paras = parseChapterStructure(body, enIdx);
  resolveWindows(paras, { anton: 'male', olga: 'female', boris: 'male' }, null);

  const sentences: SentenceOutput[] = [
    { id: 1, chapterId: 1, characterId: 'anton', text: `Ready? ${filler}` },
    { id: 2, chapterId: 1, characterId: 'olga', text: `Ready, ${filler}` },
    { id: 3, chapterId: 1, characterId: 'boris', text: `Confirmed, ${filler}` },
    { id: 4, chapterId: 1, characterId: 'narrator', text: `Then let's go. ${filler}` },
    { id: 5, chapterId: 1, characterId: 'narrator', text: `After you. ${filler}` },
  ];

  const alignment = alignSentences(sentences, paras, body);
  const examined = crossExamine(alignment, {
    rosterIds: new Set(ROSTER),
    unknownBucketIds: new Set([MALE_BUCKET_ID, FEMALE_BUCKET_ID]),
    alignmentFloorPct: 80,
  });
  expect(examined.flags).toEqual([
    { index: 3, reason: 'unanchored-narrator' },
    { index: 4, reason: 'unanchored-narrator' },
  ]);
  return { body, paras, sentences: examined.sentences, flags: examined.flags };
}

/** Same body/paras as buildFixture, but sentence id 4 (index 3) carries a
    NAMED model id ('anton') on its unanchored line → crossExamine flags it
    `unanchored-named:anton`. Sentence id 5 stays 'narrator' →
    `unanchored-narrator`. Lets us pin E-core: the named line is protected,
    the placeholder line is filled. */
function buildNamedFixture() {
  const enIdx = buildNameIndex(
    [
      { id: 'anton', name: 'Anton' },
      { id: 'olga', name: 'Olga' },
      { id: 'boris', name: 'Boris' },
    ],
    conventionsFor('en')!,
  );
  const body = [
    'He waited quietly.',
    '"Ready?" said Anton.',
    '"Ready," said Olga.',
    '"Confirmed," said Boris.',
    '"Then let\'s go."',
    '"After you."',
    'She smiled and walked ahead.',
  ].join('\n');
  const paras = parseChapterStructure(body, enIdx);
  resolveWindows(paras, { anton: 'male', olga: 'female', boris: 'male' }, null);
  const sentences: SentenceOutput[] = [
    { id: 1, chapterId: 1, characterId: 'anton', text: 'Ready?' },
    { id: 2, chapterId: 1, characterId: 'olga', text: 'Ready,' },
    { id: 3, chapterId: 1, characterId: 'boris', text: 'Confirmed,' },
    { id: 4, chapterId: 1, characterId: 'anton', text: "Then let's go." }, // NAMED guess
    { id: 5, chapterId: 1, characterId: 'narrator', text: 'After you.' }, // placeholder
  ];
  const alignment = alignSentences(sentences, paras, body);
  const examined = crossExamine(alignment, {
    rosterIds: new Set(ROSTER),
    unknownBucketIds: new Set([MALE_BUCKET_ID, FEMALE_BUCKET_ID]),
    alignmentFloorPct: 80,
  });
  expect(examined.flags).toEqual([
    { index: 3, reason: 'unanchored-named:anton' },
    { index: 4, reason: 'unanchored-narrator' },
  ]);
  return { body, paras, sentences: examined.sentences, flags: examined.flags };
}

function fakeAnalyzer(impl: (prompt: string) => EscalationOutput | null): Analyzer {
  return {
    runStage1: () => Promise.reject(new Error('not used')),
    runStage1Chapter: () => Promise.reject(new Error('not used')),
    runStage2Chapter: () => Promise.reject(new Error('not used')),
    runEmotionChapter: () => Promise.reject(new Error('not used')),
    runScriptReviewChapter: () => Promise.reject(new Error('not used')),
    runStage3Chapter: () => Promise.reject(new Error('not used')),
    runAttributionEscalation: (_m, _c, _w, prompt) => Promise.resolve(impl(prompt)),
  };
}

const STAGE_CALL: StageCall = {};
const baseOpts = () => ({
  manuscriptId: 'ms-1',
  chapterId: 1,
  stageCall: STAGE_CALL,
  rosterIds: new Set(ROSTER),
  maxWindowsPerChapter: 120,
  budget: { remainingWindows: 600 },
});

describe('escalateFlaggedWindows', () => {
  it('(a) groups flagged sentences per conversation window, window text <= 1500 chars incl. +-2 short narration paragraphs of context', async () => {
    const { body, paras, sentences, flags } = buildFixture();
    let capturedPrompt = '';
    const analyzer = fakeAnalyzer((prompt) => {
      capturedPrompt = prompt;
      return { assignments: [] };
    });

    const outcome = await escalateFlaggedWindows({
      ...baseOpts(),
      sentences,
      flags,
      paras,
      body,
      analyzer,
    });

    expect(outcome.attempted).toBe(1); // both flags share one window -> one query
    const windowText = capturedPrompt.split('Text (>>N<< marks the lines to resolve):\n')[1];
    expect(windowText.length).toBeLessThanOrEqual(1500);
    // context paragraphs present
    expect(windowText).toContain('He waited quietly');
    expect(windowText).toContain('She smiled and walked ahead');
    // core dialogue present
    expect(windowText).toContain("Then let's go");
    expect(windowText).toContain('After you');
  });

  it('(a2) hard-slice fallback: core dialogue alone > 1500 chars still caps the text AND keeps both flagged-line markers', async () => {
    const { body, paras, sentences, flags } = buildOversizedFixture();
    let capturedPrompt = '';
    const analyzer = fakeAnalyzer((prompt) => {
      capturedPrompt = prompt;
      return { assignments: [] };
    });

    const outcome = await escalateFlaggedWindows({
      ...baseOpts(),
      sentences,
      flags,
      paras,
      body,
      analyzer,
    });

    expect(outcome.attempted).toBe(1);
    const windowText = capturedPrompt.split('Text (>>N<< marks the lines to resolve):\n')[1];
    expect(windowText.length).toBeLessThanOrEqual(1500);
    // both flagged-line markers must survive truncation, not just the cap itself
    expect(windowText).toContain('>>4<<');
    expect(windowText).toContain('>>5<<');
  });

  it('(b) prompt contains window text, flagged-line markers, participant candidates, and the JSON-shape ask', async () => {
    const { body, paras, sentences, flags } = buildFixture();
    let capturedPrompt = '';
    const analyzer = fakeAnalyzer((prompt) => {
      capturedPrompt = prompt;
      return { assignments: [] };
    });

    await escalateFlaggedWindows({ ...baseOpts(), sentences, flags, paras, body, analyzer });

    expect(capturedPrompt).toContain('>>4<<');
    expect(capturedPrompt).toContain('>>5<<');
    expect(capturedPrompt).toContain('anton');
    expect(capturedPrompt).toContain('olga');
    expect(capturedPrompt).toContain('boris');
    expect(capturedPrompt).toContain('{"assignments":[{"line":<number>,"characterId":"<roster id>"}]}');
    expect(capturedPrompt).toContain('2 marked dialogue lines');
  });

  it('(b2) `narrator` is excluded from the presented "Characters present" candidate list, but stays on the answerable roster (#1483)', async () => {
    const { body, paras, sentences, flags } = buildFixture();
    let capturedPrompt = '';
    const analyzer = fakeAnalyzer((prompt) => {
      capturedPrompt = prompt;
      return { assignments: [] };
    });

    await escalateFlaggedWindows({ ...baseOpts(), sentences, flags, paras, body, analyzer });

    // Both flagged lines currently sit on 'narrator' (buildFixture's
    // unanchored placeholder), so without the filter it would leak in here.
    const presentedCandidates = capturedPrompt.split(' — full roster ids:')[0];
    expect(presentedCandidates).toContain('anton');
    expect(presentedCandidates).not.toContain('narrator');
    // ...but the model can still legitimately answer 'narrator' — it's not
    // dropped from the roster the reply is validated against.
    expect(capturedPrompt).toContain('full roster ids: anton, olga, boris, narrator');
  });

  it('windowId is passed through to the analyzer as the escalation windowIndex (#1483)', async () => {
    const { body, paras, sentences, flags } = buildFixture();
    const runFn = vi.fn(() => Promise.resolve<EscalationOutput | null>({ assignments: [] }));
    const analyzer: Analyzer = { ...fakeAnalyzer(() => null), runAttributionEscalation: runFn };

    await escalateFlaggedWindows({ ...baseOpts(), sentences, flags, paras, body, analyzer });

    expect(runFn).toHaveBeenCalledWith('ms-1', 1, 0, expect.any(String), STAGE_CALL);
  });

  it('(c) accepted only when characterId is on the roster AND the line has no tag-name evidence -> applied at 0.8, flag cleared', async () => {
    const { body, paras, sentences, flags } = buildFixture();
    const analyzer = fakeAnalyzer(() => ({
      assignments: [
        { line: 4, characterId: 'anton' },
        { line: 5, characterId: 'olga' },
      ],
    }));

    const outcome = await escalateFlaggedWindows({ ...baseOpts(), sentences, flags, paras, body, analyzer });

    expect(outcome.applied).toBe(2);
    expect(sentences.find((s) => s.id === 4)).toMatchObject({ characterId: 'anton', confidence: 0.8 });
    expect(sentences.find((s) => s.id === 5)).toMatchObject({ characterId: 'olga', confidence: 0.8 });
    expect(flags).toEqual([]);
  });

  it('rejects an assignment whose characterId is NOT on the roster', async () => {
    const { body, paras, sentences, flags } = buildFixture();
    const analyzer = fakeAnalyzer(() => ({
      assignments: [{ line: 4, characterId: 'someone-not-on-roster' }],
    }));

    const outcome = await escalateFlaggedWindows({ ...baseOpts(), sentences, flags, paras, body, analyzer });

    expect(outcome.applied).toBe(0);
    expect(sentences.find((s) => s.id === 4)).toMatchObject({ characterId: 'narrator' });
    expect(flags).toContainEqual({ index: 3, reason: 'unanchored-narrator' });
  });

  it('(d) a line WITH tag-name evidence is NEVER overridden even if the model returns a different id', async () => {
    const { body, paras, sentences, flags } = buildFixture();
    // Adversarially claim Anton's tag-confirmed line (sentence id 1, index 0)
    // is also "flagged", and have the model try to reassign it to Olga.
    const adversarialFlags = [{ index: 0, reason: 'synthetic-adversarial-flag' }, ...flags];
    const analyzer = fakeAnalyzer(() => ({
      assignments: [
        { line: 1, characterId: 'olga' }, // Anton's tag-anchored line: must NEVER apply
        { line: 4, characterId: 'anton' },
        { line: 5, characterId: 'olga' },
      ],
    }));

    const outcome = await escalateFlaggedWindows({
      ...baseOpts(),
      sentences,
      flags: adversarialFlags,
      paras,
      body,
      analyzer,
    });

    expect(sentences.find((s) => s.id === 1)).toMatchObject({ characterId: 'anton', confidence: 0.95 });
    expect(adversarialFlags).toContainEqual({ index: 0, reason: 'synthetic-adversarial-flag' });
    // the two genuine flags in the same window still resolve normally
    expect(outcome.applied).toBe(2);
    expect(sentences.find((s) => s.id === 4)).toMatchObject({ characterId: 'anton' });
    expect(sentences.find((s) => s.id === 5)).toMatchObject({ characterId: 'olga' });
  });

  it('(e) a null result (empty/blocked reply) skips the window: flags stay intact, nothing applied', async () => {
    const { body, paras, sentences, flags } = buildFixture();
    const analyzer = fakeAnalyzer(() => null);

    const outcome = await escalateFlaggedWindows({ ...baseOpts(), sentences, flags, paras, body, analyzer });

    expect(outcome.attempted).toBe(1);
    expect(outcome.applied).toBe(0);
    expect(flags).toEqual([
      { index: 3, reason: 'unanchored-narrator' },
      { index: 4, reason: 'unanchored-narrator' },
    ]);
    expect(sentences.find((s) => s.id === 4)).toMatchObject({ characterId: 'narrator' });
  });

  it('(f) the per-chapter budget stops further queries once it hits 0', async () => {
    const { body, paras, sentences, flags } = buildFixture();
    const runFn = vi.fn(() => Promise.resolve<EscalationOutput | null>({ assignments: [] }));
    const analyzer: Analyzer = { ...fakeAnalyzer(() => null), runAttributionEscalation: runFn };

    const outcome = await escalateFlaggedWindows({
      ...baseOpts(),
      sentences,
      flags,
      paras,
      body,
      analyzer,
      maxWindowsPerChapter: 0,
    });

    expect(runFn).not.toHaveBeenCalled();
    expect(outcome.attempted).toBe(0);
    expect(flags).toHaveLength(2);
  });

  it('(f) the per-book budget stops further queries once it hits 0, independent of the per-chapter cap', async () => {
    const { body, paras, sentences, flags } = buildFixture();
    const runFn = vi.fn(() => Promise.resolve<EscalationOutput | null>({ assignments: [] }));
    const analyzer: Analyzer = { ...fakeAnalyzer(() => null), runAttributionEscalation: runFn };
    const budget = { remainingWindows: 0 };

    const outcome = await escalateFlaggedWindows({
      ...baseOpts(),
      sentences,
      flags,
      paras,
      body,
      analyzer,
      budget,
      maxWindowsPerChapter: 120,
    });

    expect(runFn).not.toHaveBeenCalled();
    expect(outcome.attempted).toBe(0);
    expect(budget.remainingWindows).toBe(0);
  });

  it('(f) budget decrements by exactly one window query, shared across the caller-owned object', async () => {
    const { body, paras, sentences, flags } = buildFixture();
    const analyzer = fakeAnalyzer(() => ({ assignments: [] }));
    const budget = { remainingWindows: 5 };

    await escalateFlaggedWindows({ ...baseOpts(), sentences, flags, paras, body, analyzer, budget });

    expect(budget.remainingWindows).toBe(4); // one window queried, one decrement
  });

  it('a duplicated `line` in one reply is applied once, not double-counted', async () => {
    const { body, paras, sentences, flags } = buildFixture();
    const analyzer = fakeAnalyzer(() => ({
      assignments: [
        { line: 4, characterId: 'anton' },
        { line: 4, characterId: 'olga' }, // duplicate line entry -> must be a no-op
        { line: 5, characterId: 'olga' },
      ],
    }));

    const outcome = await escalateFlaggedWindows({ ...baseOpts(), sentences, flags, paras, body, analyzer });

    expect(outcome.applied).toBe(2); // 2 distinct lines, not 3 assignment entries
    // first-seen assignment for line 4 wins; the duplicate never re-applies
    expect(sentences.find((s) => s.id === 4)).toMatchObject({ characterId: 'anton', confidence: 0.8 });
    expect(sentences.find((s) => s.id === 5)).toMatchObject({ characterId: 'olga', confidence: 0.8 });
    expect(flags).toEqual([]);
  });

  it('no flags -> returns a zero outcome without calling the analyzer', async () => {
    const { body, paras, sentences } = buildFixture();
    const runFn = vi.fn();
    const analyzer: Analyzer = { ...fakeAnalyzer(() => null), runAttributionEscalation: runFn };

    const outcome = await escalateFlaggedWindows({ ...baseOpts(), sentences, flags: [], paras, body, analyzer });

    expect(outcome).toEqual({ attempted: 0, applied: 0 });
    expect(runFn).not.toHaveBeenCalled();
  });
});

describe('escalateFlaggedWindows — E-core (resolve, not override)', () => {
  it('NEVER overwrites a named answer (unanchored-named) but DOES fill a placeholder (unanchored-narrator)', async () => {
    const { body, paras, sentences, flags } = buildNamedFixture();
    const analyzer = fakeAnalyzer(() => ({
      assignments: [
        { line: 4, characterId: 'olga' }, // tries to overwrite the NAMED 'anton' → must be REJECTED
        { line: 5, characterId: 'boris' }, // fills the placeholder → applied
      ],
    }));

    const outcome = await escalateFlaggedWindows({ ...baseOpts(), sentences, flags, paras, body, analyzer });

    expect(outcome.applied).toBe(1);
    expect(sentences.find((s) => s.id === 4)).toMatchObject({ characterId: 'anton' }); // untouched
    expect(sentences.find((s) => s.id === 5)).toMatchObject({ characterId: 'boris', confidence: 0.8 });
    // the protected named line's flag stays; the filled placeholder's flag is cleared
    expect(flags).toEqual([{ index: 3, reason: 'unanchored-named:anton' }]);
  });
});
