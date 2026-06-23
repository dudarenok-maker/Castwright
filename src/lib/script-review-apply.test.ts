import { configureStore } from '@reduxjs/toolkit';
import { vi } from 'vitest';
import {
  resolveAnchorOffset,
  planApply,
  dispatchAcceptedOps,
  rpdWarningFor,
  type ReviewOp,
} from './script-review-apply';
import { manuscriptSlice } from '../store/manuscript-slice';
import { start } from '../store/manuscript-slice.test-helpers';

describe('resolveAnchorOffset', () => {
  it('returns the EXACT original offset across quote/dash normalization', () => {
    const text = 'He paused—then ran. "Stop," she said.';
    const off = resolveAnchorOffset(text, 'ran. "Stop,"'); // anchor uses straight quotes
    expect(off).not.toBeNull();
    expect(text.slice(off!)).toBe(' she said.'); // exact, not toContain
  });
  it('null when not unique', () => expect(resolveAnchorOffset('he said, he said', 'he said')).toBeNull());
  it('null when absent (TOCTOU edit)', () => expect(resolveAnchorOffset('totally different', 'ran.')).toBeNull());
});

describe('planApply', () => {
  const live = [
    { id: 5, chapterId: 3, text: 'The hall was dark.', characterId: 'narrator' },
    { id: 6, chapterId: 3, text: 'Dust hung in the air.', characterId: 'narrator' },
    { id: 7, chapterId: 3, text: 'He sighed. "At last," she said. He left.', characterId: 'narrator' },
  ];
  it('rejects a field edit whose id a structural op consumed', () => {
    const r = planApply([
      { id: 6, op: 'merge', mergeIds: [5, 6], rationale: 'over-split' },
      { id: 6, op: 'strip_tag', newText: 'x', rationale: 'tag' },
    ], live);
    expect(r.appliable.map((o) => o.op)).toEqual(['merge']);
    expect(r.unappliable[0].reason).toMatch(/consumed/);
  });
  it('rejects a non-adjacent / cross-character merge', () => {
    const r = planApply([{ id: 5, op: 'merge', mergeIds: [5, 7], rationale: 'x' }], live);
    expect(r.appliable).toHaveLength(0);
    expect(r.unappliable[0].reason).toMatch(/adjacent|character/);
  });
  it('TOCTOU: a structural op whose anchor no longer resolves is unappliable', () => {
    const r = planApply([{ id: 5, op: 'split', anchor: 'no such text', pieceCharacterIds: ['narrator', 'maerin'], rationale: 'x' }], live);
    expect(r.appliable).toHaveLength(0);
    expect(r.unappliable[0].reason).toMatch(/anchor/);
  });
  it('rejects fix_emotion to an invalid enum', () => {
    const r = planApply([{ id: 5, op: 'fix_emotion', emotion: 'furious', rationale: 'x' }], live);
    expect(r.appliable).toHaveLength(0);
    expect(r.unappliable[0].reason).toMatch(/emotion/);
  });

  // IP-1 regression: merge guard must check ALL member ids, not just mergeIds[0]
  it('IP-1: rejects second merge whose non-primary member overlaps a prior merge', () => {
    const liveLong = [
      { id: 3, chapterId: 1, text: 'Sentence three.', characterId: 'narrator' },
      { id: 4, chapterId: 1, text: 'Sentence four.', characterId: 'narrator' },
      { id: 5, chapterId: 1, text: 'Sentence five.', characterId: 'narrator' },
    ];
    // merge [4,5] claims ids 4 and 5; merge [3,4] has primary=3 (unclaimed) but member 4 is claimed
    const r = planApply([
      { id: 4, op: 'merge', mergeIds: [4, 5], rationale: 'x' },
      { id: 3, op: 'merge', mergeIds: [3, 4], rationale: 'y' },
    ], liveLong);
    expect(r.appliable).toHaveLength(1);
    expect(r.appliable[0].mergeIds).toEqual([4, 5]);
    expect(r.unappliable).toHaveLength(1);
    expect(r.unappliable[0].reason).toMatch(/same id|consumed|structural/i);
  });

  // M-3 extract_dialogue green path: both anchor and anchorEnd resolve
  it('extract_dialogue is appliable when both anchor and anchorEnd resolve uniquely', () => {
    const r = planApply([{
      id: 7,
      op: 'extract_dialogue',
      anchor: '"At last,"',
      anchorEnd: 'He left.',
      pieceCharacterIds: ['narrator', 'maerin'],
      rationale: 'dialogue extract',
    }], live);
    expect(r.appliable).toHaveLength(1);
    expect(r.appliable[0].op).toBe('extract_dialogue');
    expect(r.unappliable).toHaveLength(0);
  });

  // M-3 extract_dialogue rejection: anchorEnd does not resolve
  it('extract_dialogue is unappliable when anchorEnd does not resolve', () => {
    const r = planApply([{
      id: 7,
      op: 'extract_dialogue',
      anchor: '"At last,"',
      anchorEnd: 'no such text in sentence',
      pieceCharacterIds: ['narrator', 'maerin'],
      rationale: 'dialogue extract',
    }], live);
    expect(r.appliable).toHaveLength(0);
    expect(r.unappliable[0].reason).toMatch(/anchorEnd|extract|anchor/i);
  });
});

describe('dispatchAcceptedOps', () => {
  // Seed sentences:
  //   ch=3, id=1 — strip_tag target: text has a tag [laughing]
  //   ch=3, id=2 — fix_emotion target
  //   ch=3, id=3 — split target: "Hello world. Goodbye world."
  //   ch=3, id=4 — extract_dialogue target: 'He said. "Come on," she urged. He left.'
  //   ch=3, id=5 — merge survivor
  //   ch=3, id=6 — merge secondary (adjacent, same characterId)
  const sentences = [
    { id: 1, chapterId: 3, characterId: 'narrator', text: '[laughing] The hall was dark.' },
    { id: 2, chapterId: 3, characterId: 'narrator', text: 'Dust hung in the air.' },
    { id: 3, chapterId: 3, characterId: 'narrator', text: 'Hello world. Goodbye world.' },
    { id: 4, chapterId: 3, characterId: 'narrator', text: 'He said. "Come on," she urged. He left.' },
    { id: 5, chapterId: 3, characterId: 'narrator', text: 'First piece.' },
    { id: 6, chapterId: 3, characterId: 'narrator', text: 'Second piece.' },
  ];

  // The live array dispatchAcceptedOps will use for anchor resolution
  const liveForDispatch = sentences.map((s) => ({ ...s }));

  const ops: ReviewOp[] = [
    // strip_tag: replace text of sentence 1
    { id: 1, op: 'strip_tag', newText: 'The hall was dark.', rationale: 'remove tag' },
    // fix_emotion: set emotion on sentence 2
    { id: 2, op: 'fix_emotion', emotion: 'sad', rationale: 'detected sadness' },
    // split: anchor = "Hello world." — ends at offset 12; pieces narrator+narrator
    { id: 3, op: 'split', anchor: 'Hello world.', pieceCharacterIds: ['narrator', 'narrator'], rationale: 'over-long sentence' },
    // extract_dialogue: anchor = '"Come on,"' (start), anchorEnd = 'she urged.' (end)
    // text = 'He said. "Come on," she urged. He left.'
    // anchor ends at offset 19 (' she urged. He left.' remains)
    // anchorEnd ends at offset 30 (' He left.' remains as third piece)
    { id: 4, op: 'extract_dialogue', anchor: '"Come on,"', anchorEnd: 'she urged.', pieceCharacterIds: ['narrator', 'maerin', 'narrator'], rationale: 'dialogue extraction' },
    // merge: join sentences 5 and 6
    { id: 5, op: 'merge', mergeIds: [5, 6], rationale: 'under-split' },
  ];

  it('applies all 5 op classes and fires onBoundaryMove once per op', () => {
    const store = configureStore({
      reducer: { manuscript: manuscriptSlice.reducer },
      preloadedState: { manuscript: start(sentences) },
    });

    const spy = vi.fn();
    dispatchAcceptedOps(store.dispatch, ops, liveForDispatch, { onBoundaryMove: spy });

    const state = store.getState().manuscript;

    // strip_tag: sentence 1 text replaced
    const s1 = state.sentences.find((x) => x.chapterId === 3 && x.id === 1);
    expect(s1?.text).toBe('The hall was dark.');

    // fix_emotion: sentence 2 emotion set to 'sad'
    const s2 = state.sentences.find((x) => x.chapterId === 3 && x.id === 2);
    expect(s2?.emotion).toBe('sad');

    // split: sentence 3 becomes 2 pieces; first keeps id=3, second gets maxId+1=7
    const s3first = state.sentences.find((x) => x.chapterId === 3 && x.id === 3);
    const s3second = state.sentences.find((x) => x.chapterId === 3 && x.id === 7);
    expect(s3first?.text).toBe('Hello world.');
    expect(s3second?.text).toBe(' Goodbye world.');

    // extract_dialogue: sentence 4 becomes 3 pieces; ids 4, 8, 9 (max before extract = 7 post-split)
    // After the split op, maxId = 7. extract produces 3 pieces: id=4, id=8, id=9
    // anchor '"Come on,"' ends at offset 19; anchorEnd 'she urged.' ends at offset 30
    // piece 0: 'He said. "Come on,"' (id=4, keeps original id)
    // piece 1: ' she urged.' (id=8, global max+1)
    // piece 2: ' He left.' (id=9, global max+2)
    const s4first = state.sentences.find((x) => x.chapterId === 3 && x.id === 4);
    const s4second = state.sentences.find((x) => x.chapterId === 3 && x.id === 8);
    const s4third = state.sentences.find((x) => x.chapterId === 3 && x.id === 9);
    expect(s4first).toBeDefined();
    expect(s4second).toBeDefined();
    expect(s4third).toBeDefined();
    // All 3 pieces together should reconstruct the original text
    const reconstructed = (s4first?.text ?? '') + (s4second?.text ?? '') + (s4third?.text ?? '');
    expect(reconstructed).toBe('He said. "Come on," she urged. He left.');

    // merge: sentences 5+6 → survivor id=5 with joined text; id=6 removed
    const s5 = state.sentences.find((x) => x.chapterId === 3 && x.id === 5);
    const s6 = state.sentences.find((x) => x.chapterId === 3 && x.id === 6);
    expect(s5?.text).toBe('First piece. Second piece.');
    expect(s6).toBeUndefined();

    // onBoundaryMove fired once per op (5 ops)
    expect(spy).toHaveBeenCalledTimes(5);
    expect(spy).toHaveBeenCalledWith(3); // chapterId = 3 for all ops
  });

  it('skips an op whose anchor does not resolve, WITHOUT firing onBoundaryMove', () => {
    const store = configureStore({
      reducer: { manuscript: manuscriptSlice.reducer },
      preloadedState: { manuscript: start(sentences) },
    });
    const spy = vi.fn();
    const badOp: ReviewOp = { id: 3, op: 'split', anchor: 'no such anchor text', pieceCharacterIds: ['narrator', 'narrator'], rationale: 'bad' };
    dispatchAcceptedOps(store.dispatch, [badOp], liveForDispatch, { onBoundaryMove: spy });
    // sentence 3 should be unchanged
    const s3 = store.getState().manuscript.sentences.find((x) => x.chapterId === 3 && x.id === 3);
    expect(s3?.text).toBe('Hello world. Goodbye world.');
    expect(spy).not.toHaveBeenCalled();
  });

  it('skips an op whose id is missing from live, WITHOUT firing onBoundaryMove', () => {
    const store = configureStore({
      reducer: { manuscript: manuscriptSlice.reducer },
      preloadedState: { manuscript: start(sentences) },
    });
    const spy = vi.fn();
    const missingOp: ReviewOp = { id: 999, op: 'strip_tag', newText: 'x', rationale: 'missing' };
    dispatchAcceptedOps(store.dispatch, [missingOp], liveForDispatch, { onBoundaryMove: spy });
    expect(spy).not.toHaveBeenCalled();
  });

  it('skips extract_dialogue when anchorEnd resolves before anchor (end <= start), WITHOUT firing onBoundaryMove', () => {
    const store = configureStore({
      reducer: { manuscript: manuscriptSlice.reducer },
      preloadedState: { manuscript: start(sentences) },
    });
    const spy = vi.fn();
    // sentence 4 text: 'He said. "Come on," she urged. He left.'
    // anchor = 'she urged.' ends at offset 29 (later in the sentence)
    // anchorEnd = '"Come on,"' ends at offset 19 (earlier in the sentence)
    // end (19) <= start (29), so the op should be skipped
    const badExtractionOp: ReviewOp = {
      id: 4,
      op: 'extract_dialogue',
      anchor: 'she urged.',
      anchorEnd: '"Come on,"',
      pieceCharacterIds: ['narrator', 'maerin', 'narrator'],
      rationale: 'invalid range',
    };
    dispatchAcceptedOps(store.dispatch, [badExtractionOp], liveForDispatch, { onBoundaryMove: spy });
    // sentence 4 should be unchanged
    const s4 = store.getState().manuscript.sentences.find((x) => x.chapterId === 3 && x.id === 4);
    expect(s4?.text).toBe('He said. "Come on," she urged. He left.');
    // onBoundaryMove should not have been called
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('rpdWarningFor', () => {
  it('warns when chapter count exceeds the model RPD cap', () => {
    const w = rpdWarningFor(30, 'gemini-2.5-flash'); // cap 20
    expect(w).not.toBeNull();
    expect(w!.chapterCount).toBe(30);
    expect(w!.rpd).toBe(20);
    expect(w!.model).toBe('gemini-2.5-flash');
  });

  it('stays quiet when chapter count is at or under the cap', () => {
    expect(rpdWarningFor(20, 'gemini-2.5-flash')).toBeNull(); // exactly at cap
    expect(rpdWarningFor(5, 'gemini-2.5-flash')).toBeNull();
    expect(rpdWarningFor(400, 'gemini-3.1-flash-lite')).toBeNull(); // cap 500
  });

  it('never warns for a local / unknown model (no daily cap)', () => {
    expect(rpdWarningFor(10_000, 'qwen3.5:9b')).toBeNull(); // local Ollama model
    expect(rpdWarningFor(10_000, undefined)).toBeNull(); // server default local
  });

  it('uses the per-model cap, not a shared one', () => {
    // gemma has a 1500/day cap → 30 chapters is fine
    expect(rpdWarningFor(30, 'gemma-4-31b-it')).toBeNull();
    // but flash preview only allows 20/day
    expect(rpdWarningFor(30, 'gemini-3-flash-preview')).not.toBeNull();
  });
});
