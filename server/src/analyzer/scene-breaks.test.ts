import { describe, it, expect } from 'vitest';
import { annotateSceneBreaks } from './scene-breaks.js';
import type { SentenceOutput } from '../handoff/schemas.js';

function sents(...texts: string[]): SentenceOutput[] {
  return texts.map((text, i) => ({ id: i + 1, chapterId: 1, characterId: 'narrator', text }));
}

describe('annotateSceneBreaks (#1679, marker-anchored binding)', () => {
  it('flags the first sentence after a mid-chapter * * * and nothing else', () => {
    const body = 'Scene one ends here.\n\n* * *\n\nScene two starts here.';
    const s = sents('Scene one ends here.', 'Scene two starts here.');
    annotateSceneBreaks(s, body);
    expect(s[0].sceneBreakBefore).toBeUndefined();
    expect(s[1].sceneBreakBefore).toBe(true);
  });

  it('collapses consecutive separators to a single flag on the next real sentence', () => {
    const body = 'One.\n\n* * *\n\n* * *\n\nTwo.';
    const s = sents('One.', 'Two.');
    annotateSceneBreaks(s, body);
    expect(s[1].sceneBreakBefore).toBe(true);
    expect(s.filter((x) => x.sceneBreakBefore).length).toBe(1);
  });

  it('does NOT treat a page-number-only unit as a separator', () => {
    const body = 'One.\n\n42\n\nTwo.';
    const s = sents('One.', '42', 'Two.');
    annotateSceneBreaks(s, body);
    expect(s.every((x) => !x.sceneBreakBefore)).toBe(true);
  });

  it('recognizes a dinkus and a dash rule as separators', () => {
    for (const glyph of ['⁂', '---', '―']) {
      const body = `One.\n\n${glyph}\n\nTwo.`;
      const s = sents('One.', 'Two.');
      annotateSceneBreaks(s, body);
      expect(s[1].sceneBreakBefore).toBe(true);
    }
  });

  it('a leading separator (before any located prose) sets no flag and does not throw', () => {
    const body = '* * *\n\nOnly scene.';
    const s = sents('Only scene.');
    annotateSceneBreaks(s, body);
    expect(s[0].sceneBreakBefore).toBeUndefined();
  });

  // HARDENING BEHAVIOUR — the whole point of the marker-anchored rule:
  it('binds to the best-guess opener even when the opener text does NOT locate (restructured/paraphrased)', () => {
    const body = 'One.\n\n* * *\n\nTwo verbatim.';
    // The model emitted a restructured opener that is NOT verbatim in the body.
    // Old rule would DROP; the hardened rule anchors on the marker + the last
    // located-before sentence ("One.") and flags the next sentence in order.
    const s = sents('One.', 'Two, but restructured differently.');
    expect(() => annotateSceneBreaks(s, body)).not.toThrow();
    expect(s[1].sceneBreakBefore).toBe(true);
    expect(s[0].sceneBreakBefore).toBeUndefined();
  });

  it('avoids the far-overshoot: binds to the sentence immediately after the marker, not a distant later match', () => {
    // A locates before the break; B and C (the real post-break scene) do NOT locate;
    // D locates far downstream. Old rule would jump to D (far overshoot). Hardened
    // rule flags B (immediately after the last located-before sentence).
    const body = 'A locates here.\n\n* * *\n\nB. C. And later D locates here.';
    const s = sents('A locates here.', 'B unmatched.', 'C unmatched.', 'D locates here.');
    annotateSceneBreaks(s, body);
    expect(s[1].sceneBreakBefore).toBe(true); // B — immediately after the marker
    expect(s[3].sceneBreakBefore).toBeUndefined(); // D — NOT the far match
    expect(s.filter((x) => x.sceneBreakBefore).length).toBe(1);
  });

  it('does not mutate text, characterId, id, or order', () => {
    const body = 'One.\n\n* * *\n\nTwo.';
    const s = sents('One.', 'Two.');
    const before = JSON.parse(JSON.stringify(s.map(({ sceneBreakBefore, ...rest }) => rest)));
    annotateSceneBreaks(s, body);
    const after = s.map(({ sceneBreakBefore, ...rest }) => rest);
    expect(after).toEqual(before);
  });
});

describe('annotateSceneBreaks — separator captured as its own sentence (#1679 shipped-fix)', () => {
  it('flags the TRUE opener, not the dinkus sentence, when * * * is its own sentence', () => {
    const body = 'Scene one.\n\n* * *\n\nScene two.';
    // Analyzer emits the dinkus line as id2, a real (word-free) sentence.
    const s = sents('Scene one.', '* * *', 'Scene two.');
    annotateSceneBreaks(s, body);
    expect(s[0].sceneBreakBefore).toBeUndefined();
    expect(s[1].sceneBreakBefore).toBeUndefined(); // the dinkus sentence is NOT flagged
    expect(s[2].sceneBreakBefore).toBe(true); // the true opener IS
  });

  it('skips a run of consecutive separator sentences to the first attributable opener', () => {
    const body = 'One.\n\n* * *\n\n⁂\n\nTwo.';
    const s = sents('One.', '* * *', '⁂', 'Two.');
    annotateSceneBreaks(s, body);
    expect(s[3].sceneBreakBefore).toBe(true);
    expect(s.filter((x) => x.sceneBreakBefore).length).toBe(1);
  });

  it('Russian-style: opener text does not locate but separator sentence present → still flags opener by index', () => {
    const body = 'Первая сцена.\n\n* * *\n\nВторая сцена.';
    // The model re-emitted the opener as restructured text absent from the body,
    // but the dinkus sentence is present; skipping it still lands on the opener.
    const s = sents('Первая сцена.', '* * *', 'Совсем другой несовпадающий текст.');
    annotateSceneBreaks(s, body);
    expect(s[1].sceneBreakBefore).toBeUndefined();
    expect(s[2].sceneBreakBefore).toBe(true);
  });

  it('a separator sentence at chapter top (leading) flags nothing', () => {
    const body = '* * *\n\nOnly scene.';
    const s = sents('* * *', 'Only scene.');
    annotateSceneBreaks(s, body);
    expect(s.every((x) => !x.sceneBreakBefore)).toBe(true);
  });
});
