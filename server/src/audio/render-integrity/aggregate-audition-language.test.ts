/* #1951 review fix (M4, seam 2) — the Option-B audition centroid must render
   the reference under the SAME language the chapter's audio was rendered in.

   `auditionCentroid` builds the reference the speaker-drift detector compares
   every chapter segment against. Before this fix it passed neither `language`
   nor `cloned`, so a cloned Qwen voice rendered its reference from the clone's
   (permanently "English") manifest while the chapter itself rendered in the
   book's language — a brand-new source of FALSE drift flags on cloned voices in
   non-English books. Same shape as the tier fix in
   aggregate-audition-tier.test.ts: the audition has to match the render, or the
   comparison is meaningless.

   The book language is read from `.audiobook/state.json` (the one place a
   book's language lives). Absent/unreadable → NO language is passed. Never an
   English default — that is the bug #1951 exists to fix. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { auditionSpy } = vi.hoisted(() => ({
  auditionSpy: vi.fn(async (_character: { modelKey: string }) => null),
}));
vi.mock('./audition-centroid.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./audition-centroid.js')>()),
  auditionCentroid: auditionSpy,
}));

import { scoreBook } from './aggregate.js';
import { writeEmbeddings, EMBEDDINGS_VERSION } from './embeddings-io.js';

const vec = (θ: number) => Float32Array.from([Math.cos(θ), Math.sin(θ), 0, 0, 0, 0, 0, 0]);

/** A book whose single character is too-thin (3 anchors < CENTROID_MIN_N), so
 *  scoreBook falls through to the audition path. `state` / `cast` are written
 *  only when supplied, so the "no state.json" case is reachable. */
async function makeBook(opts: {
  state?: unknown;
  cast?: unknown;
  voiceEngine?: string;
  resolvedVoiceName?: string;
}): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'spk-audition-lang-'));
  mkdirSync(join(dir, 'audio'), { recursive: true });
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  const rows = Array.from({ length: 3 }, (_, i) => ({
    characterId: 'thurid',
    sentenceIds: [i],
    vec: vec(0.02 * i),
  }));
  await writeEmbeddings(join(dir, 'audio', 'ch1.embeddings.json'), rows, EMBEDDINGS_VERSION);
  writeFileSync(
    join(dir, 'audio', 'ch1.segments.json'),
    JSON.stringify({
      chapterId: 1,
      modelKey: 'qwen3-tts-0.6b',
      segments: rows.map((r) => ({
        characterId: 'thurid',
        sentenceIds: r.sentenceIds,
        renderedFallbackEngine: null,
      })),
      characterSnapshots: {
        thurid: {
          voiceEngine: opts.voiceEngine ?? 'qwen',
          resolvedVoiceName: opts.resolvedVoiceName ?? 'qwen-thurid',
        },
      },
    }),
  );
  if (opts.state !== undefined) {
    writeFileSync(join(dir, '.audiobook', 'state.json'), JSON.stringify(opts.state));
  }
  if (opts.cast !== undefined) {
    writeFileSync(join(dir, '.audiobook', 'cast.json'), JSON.stringify(opts.cast));
  }
  return dir;
}

function auditionArg(): { language?: string; cloned?: boolean } {
  return auditionSpy.mock.calls[0][0] as unknown as { language?: string; cloned?: boolean };
}

describe("scoreBook — the audition renders in the book's language", () => {
  beforeEach(() => auditionSpy.mockClear());

  it('passes the book language AND cloned:true for a cloned Qwen character', async () => {
    const dir = await makeBook({
      state: { language: 'de' },
      cast: {
        characters: [
          {
            id: 'thurid',
            name: 'Thurid',
            overrideTtsVoices: { qwen: { name: 'qwen-lib1', libraryUuid: 'lib1', provenance: 'cloned' } },
          },
        ],
      },
    });

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);

    expect(auditionSpy).toHaveBeenCalledTimes(1);
    expect(auditionArg().language).toBe('de');
    expect(auditionArg().cloned).toBe(true);
  });

  /* A DESIGNED voice's manifest language is already forced to match the book by
     `clearMismatchedDesignedVoices`, so it must keep sending no `cloned` flag —
     `resolveWireLanguage` then puts nothing on the wire for Qwen, byte-identical
     to pre-#1951 behaviour. The book language still travels (Coqui needs it
     unconditionally); it is the flag that gates the Qwen mapping. */
  it('passes cloned:false for a designed Qwen character', async () => {
    const dir = await makeBook({
      state: { language: 'de' },
      cast: {
        characters: [
          {
            id: 'thurid',
            name: 'Thurid',
            overrideTtsVoices: { qwen: { name: 'qwen-lib1', libraryUuid: 'lib1', provenance: 'designed' } },
          },
        ],
      },
    });

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);

    expect(auditionArg().language).toBe('de');
    expect(auditionArg().cloned).toBe(false);
  });

  /* Provenance lives on the CHARACTER's own engine slot. A coqui-cloned
     character must read its cloned-ness from the `coqui` slot, not `qwen`. */
  it('reads provenance from the snapshot engine, not a hardcoded qwen', async () => {
    const dir = await makeBook({
      voiceEngine: 'coqui',
      resolvedVoiceName: 'xtts-lib1',
      state: { language: 'de' },
      cast: {
        characters: [
          {
            id: 'thurid',
            name: 'Thurid',
            overrideTtsVoices: { coqui: { name: 'xtts-lib1', libraryUuid: 'lib1', provenance: 'cloned' } },
          },
        ],
      },
    });

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);

    expect(auditionArg().language).toBe('de');
    expect(auditionArg().cloned).toBe(true);
  });

  /* NEVER an English default. An unreadable state.json means "unknown", and
     unknown must degrade to today's behaviour (no language on the wire → the
     voice's own manifest language), not to a guess. */
  it('passes no language at all when the book has no state.json', async () => {
    const dir = await makeBook({
      cast: {
        characters: [
          {
            id: 'thurid',
            name: 'Thurid',
            overrideTtsVoices: { qwen: { name: 'qwen-lib1', libraryUuid: 'lib1', provenance: 'cloned' } },
          },
        ],
      },
    });

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);

    expect(auditionArg().language).toBeUndefined();
    expect(auditionArg().cloned).toBe(true);
  });
});
