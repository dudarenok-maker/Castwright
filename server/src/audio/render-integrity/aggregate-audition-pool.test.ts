/* srv-36 audition-centroid redesign: scoreBook must (a) thread cast.json's
   evidence onto the Option-B AuditionCharacter as `hint` (previously always
   undefined in production — every real invocation silently used the canned
   fallback line, never a character's actual evidence), and (b) split
   existingAnchors by WHY the fallback triggered — too-thin passes the real
   anchor vectors in; bimodal passes none (they're the untrustworthy data
   causing the split). */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { auditionSpy } = vi.hoisted(() => ({
  auditionSpy: vi.fn(async (_character: unknown, _opts?: unknown) => null),
}));
vi.mock('./audition-centroid.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./audition-centroid.js')>()),
  auditionCentroid: auditionSpy,
}));

import { scoreBook } from './aggregate.js';
import { writeEmbeddings, EMBEDDINGS_VERSION } from './embeddings-io.js';

// A unit vector in a given axis direction, dim=8, tiny deterministic jitter.
function axisVec(axis: number, i: number, dim = 8): number[] {
  const dir = new Array(dim).fill(0);
  dir[axis] = 1;
  dir[(axis + 1) % dim] = (i % 3) * 0.005;
  let norm = 0;
  for (const v of dir) norm += v * v;
  norm = Math.sqrt(norm);
  return dir.map((v) => v / norm);
}
const vec = (axis: number, i: number) => Float32Array.from(axisVec(axis, i));

function writeThuridFixture(dir: string, anchorCount: number) {
  mkdirSync(join(dir, 'audio'), { recursive: true });
  const rows = Array.from({ length: anchorCount }, (_, i) => ({
    characterId: 'thurid',
    sentenceIds: [i],
    vec: vec(0, i),
  }));
  writeFileSync(
    join(dir, 'audio', 'ch1.segments.json'),
    JSON.stringify({
      chapterId: 1,
      modelKey: 'qwen3-tts-1.7b',
      segments: rows.map((r) => ({
        characterId: 'thurid',
        sentenceIds: r.sentenceIds,
        renderedFallbackEngine: null,
      })),
      characterSnapshots: { thurid: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-thurid' } },
    }),
  );
  return writeEmbeddings(join(dir, 'audio', 'ch1.embeddings.json'), rows, EMBEDDINGS_VERSION);
}

function writeCastJson(dir: string, characters: Array<Record<string, unknown>>) {
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(join(dir, '.audiobook', 'cast.json'), JSON.stringify({ characters }));
}

describe('scoreBook — cast.json evidence threading + anchor blending (srv-36 redesign)', () => {
  beforeEach(() => auditionSpy.mockClear());

  it('threads buildHintFromCast onto the AuditionCharacter when cast.json has a matching character', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-pool-hint-match-'));
    await writeThuridFixture(dir, 3); // below CENTROID_MIN_N=10 → too-thin
    writeCastJson(dir, [
      { id: 'thurid', evidence: [{ quote: 'A real line Thurid actually says.' }] },
    ]);

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);

    expect(auditionSpy).toHaveBeenCalledTimes(1);
    const [character] = auditionSpy.mock.calls[0] as unknown as [{ hint?: { evidence?: string[] } }];
    expect(character.hint?.evidence).toEqual(['A real line Thurid actually says.']);
  });

  it('leaves hint undefined when cast.json exists but has no matching character id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-pool-hint-nomatch-'));
    await writeThuridFixture(dir, 3);
    writeCastJson(dir, [{ id: 'some-other-character', evidence: [{ quote: 'Not Thurid.' }] }]);

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);

    expect(auditionSpy).toHaveBeenCalledTimes(1);
    const [character] = auditionSpy.mock.calls[0] as unknown as [{ hint?: unknown }];
    expect(character.hint).toBeUndefined();
  });

  it('does not throw and leaves hint undefined when cast.json is entirely missing (best-effort read)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-pool-hint-missing-'));
    await writeThuridFixture(dir, 3); // no .audiobook dir written at all

    await expect(scoreBook(dir, [{ id: 1, slug: 'ch1' }])).resolves.toBeUndefined();

    expect(auditionSpy).toHaveBeenCalledTimes(1);
    const [character] = auditionSpy.mock.calls[0] as unknown as [{ hint?: unknown }];
    expect(character.hint).toBeUndefined();
  });

  it('passes the real anchor vectors as existingAnchors for a too-thin character', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-pool-anchors-toothin-'));
    await writeThuridFixture(dir, 3); // 3 < CENTROID_MIN_N=10 → too-thin

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);

    expect(auditionSpy).toHaveBeenCalledTimes(1);
    const [, opts] = auditionSpy.mock.calls[0] as unknown as [unknown, { existingAnchors?: Float32Array[] }];
    expect(opts?.existingAnchors?.length).toBe(3);
  });

  it('passes NO anchors (empty array) for a bimodal character', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-pool-anchors-bimodal-'));
    mkdirSync(join(dir, 'audio'), { recursive: true });
    // 10 anchors split 3-and-7 across orthogonal axes — clears CENTROID_MIN_N
    // (10) and trips centroid.ts's own bimodal detection. Deliberately
    // ASYMMETRIC (not 5-and-5): an even split can leave the weighted
    // centroid equidistant from both clusters, producing near-identical
    // cosines-to-centroid on both sides and no detectable gap.
    const rows = [
      ...Array.from({ length: 3 }, (_, i) => ({ characterId: 'thurid', sentenceIds: [i], vec: vec(0, i) })),
      ...Array.from({ length: 7 }, (_, i) => ({ characterId: 'thurid', sentenceIds: [3 + i], vec: vec(1, i) })),
    ];
    await writeEmbeddings(join(dir, 'audio', 'ch1.embeddings.json'), rows, EMBEDDINGS_VERSION);
    writeFileSync(
      join(dir, 'audio', 'ch1.segments.json'),
      JSON.stringify({
        chapterId: 1,
        modelKey: 'qwen3-tts-1.7b',
        segments: rows.map((r) => ({
          characterId: 'thurid',
          sentenceIds: r.sentenceIds,
          renderedFallbackEngine: null,
        })),
        characterSnapshots: { thurid: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-thurid' } },
      }),
    );

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);

    expect(auditionSpy).toHaveBeenCalledTimes(1);
    const [, opts] = auditionSpy.mock.calls[0] as unknown as [unknown, { existingAnchors?: Float32Array[] }];
    expect(opts?.existingAnchors ?? []).toEqual([]);
  });
});
