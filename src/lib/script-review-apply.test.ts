import { resolveAnchorOffset, planApply } from './script-review-apply';

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
