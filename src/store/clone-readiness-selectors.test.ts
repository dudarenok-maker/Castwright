/* Plan 276 (fs-cast-readiness), Decision 5 — the adapter is where the real
   wrong-slot / wrong-helper bugs live (rev 1's fatal bug was exactly this:
   `characterHasSlot` wired to the library slot instead of the CHARACTER's
   own cast slot). Every case here is mutation-verified against the
   producer (`clone-readiness-selectors.ts`) — see the commit message for
   the mutation table; never mutate an assertion to "prove" a case. */

import { describe, it, expect } from 'vitest';
import {
  selectCloneReadinessVerdicts,
  castNeedsCloneCheck,
  characterNeedsCloneCheck,
} from './clone-readiness-selectors';
import type { Character } from '../lib/types';
import type { VoiceLibraryEntry } from './voice-library-slice';
import type { RootState } from './index';

function char(over: Partial<Character>): Character {
  return { id: 'c1', name: 'Character One', ...over } as Character;
}

function entry(over: Partial<VoiceLibraryEntry>): VoiceLibraryEntry {
  return {
    voiceUuid: 'v1',
    name: 'Voice One',
    provenance: 'cloned',
    tags: [],
    pinned: false,
    engines: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  } as VoiceLibraryEntry;
}

function healthyMaster() {
  return { transcript: 'a transcript', transcriptSource: 'whisper' } as VoiceLibraryEntry['master'];
}

function state(
  characters: Character[],
  entries: VoiceLibraryEntry[],
  ttsModelKey = 'coqui-xtts-v2',
): RootState {
  return {
    ui: { ttsModelKey },
    cast: { characters },
    voiceLibrary: { entries },
  } as unknown as RootState;
}

describe('selectCloneReadinessVerdicts', () => {
  it('rule 7 silence: a real coqui CAST slot stays silent even though the library entry has no xtts slot yet (characterHasSlot must read the CAST slot, never the library slot)', () => {
    const c = char({
      ttsEngine: 'coqui',
      overrideTtsVoices: { coqui: { name: 'v1', libraryUuid: 'v1', provenance: 'cloned' } },
    });
    const e = entry({ engines: { qwen: { status: 'ready', baseModel: 'x' } }, master: healthyMaster() });
    expect(selectCloneReadinessVerdicts(state([c], [e]), 'b1')).toEqual([]);
  });

  it('a character cloned ONLY on qwen but routed to Coqui with NO coqui cast slot must report wrong-engine — characterHasSlot must NOT be the engine-agnostic characterHasClonedSlot, or this reads as silently healthy (the CTA-hidden trap)', () => {
    const c = char({
      ttsEngine: 'coqui',
      overrideTtsVoices: { qwen: { name: 'v1', libraryUuid: 'v1', provenance: 'cloned' } },
    });
    const e = entry({ engines: { qwen: { status: 'ready', baseModel: 'x' } }, master: healthyMaster() });
    const verdicts = selectCloneReadinessVerdicts(state([c], [e]), 'b1');
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({ characterId: 'c1', engine: 'coqui', reason: 'wrong-engine' });
  });

  it('C1 regression: a slot served as {status:"failed"} — the shape GET /api/voice-library sends post the withComputedStaleness fix — still yields derive-failed (slotStatus is used exactly as received, never re-derived)', () => {
    const c = char({
      ttsEngine: 'qwen',
      overrideTtsVoices: { qwen: { name: 'v1', libraryUuid: 'v1', provenance: 'cloned' } },
    });
    const e = entry({
      engines: { qwen: { status: 'failed', baseModel: 'old' } },
      master: healthyMaster(),
    });
    const verdicts = selectCloneReadinessVerdicts(state([c], [e]), 'b1');
    expect(verdicts).toEqual([expect.objectContaining({ reason: 'derive-failed' })]);
  });

  it('reads the COQUI slot via the xtts manifest key, never a raw entry.engines.coqui index — a failed xtts slot on a coqui-cloned, coqui-routed character reports derive-failed', () => {
    const c = char({
      ttsEngine: 'coqui',
      overrideTtsVoices: { coqui: { name: 'v1', libraryUuid: 'v1', provenance: 'cloned' } },
    });
    const e = entry({
      engines: { xtts: { status: 'failed', coquiVersion: 'old' } },
      master: healthyMaster(),
    });
    const verdicts = selectCloneReadinessVerdicts(state([c], [e]), 'b1');
    expect(verdicts).toEqual([expect.objectContaining({ reason: 'derive-failed' })]);
  });

  it('rule 7 silence: a qwen-cloned voice on a coqui-routed character with BOTH cast slots present (post-#1933 assign) does not fire', () => {
    const c = char({
      ttsEngine: 'coqui',
      overrideTtsVoices: {
        qwen: { name: 'v1', libraryUuid: 'v1', provenance: 'cloned' },
        coqui: { name: 'v1', libraryUuid: 'v1', provenance: 'cloned' },
      },
    });
    const e = entry({ engines: { qwen: { status: 'ready', baseModel: 'x' } }, master: healthyMaster() });
    expect(selectCloneReadinessVerdicts(state([c], [e]), 'b1')).toEqual([]);
  });

  it('fires for a character routed to Kokoro with a qwen-only cloned slot, and otherEngineOk is true because the qwen slot is healthy', () => {
    const c = char({
      ttsEngine: 'kokoro',
      overrideTtsVoices: { qwen: { name: 'v1', libraryUuid: 'v1', provenance: 'cloned' } },
    });
    const e = entry({ engines: { qwen: { status: 'ready', baseModel: 'x' } }, master: healthyMaster() });
    const verdicts = selectCloneReadinessVerdicts(state([c], [e]), 'b1');
    expect(verdicts).toEqual([
      expect.objectContaining({
        characterId: 'c1',
        engine: 'kokoro',
        reason: 'wrong-engine',
        otherEngineOk: true,
      }),
    ]);
  });

  it('otherEngineOk is false, not vacuously true, when the character has no qwen slot at all — a coqui-only clone routed to Kokoro (mutation: drop the second argument off `hasClonedProvenance` -> `characterHasClonedSlot(character)`, which is true for ANY cloned character regardless of which engine)', () => {
    const c = char({
      ttsEngine: 'kokoro',
      overrideTtsVoices: { coqui: { name: 'v1', libraryUuid: 'v1', provenance: 'cloned' } },
    });
    const e = entry({ engines: { xtts: { status: 'ready', coquiVersion: 'x' } }, master: healthyMaster() });
    const verdicts = selectCloneReadinessVerdicts(state([c], [e]), 'b1');
    expect(verdicts).toEqual([
      expect.objectContaining({ reason: 'wrong-engine', otherEngineOk: false }),
    ]);
  });

  it('a plain, non-cloned cast produces no verdicts at all', () => {
    const c = char({ ttsEngine: 'kokoro' });
    expect(selectCloneReadinessVerdicts(state([c], []), 'b1')).toEqual([]);
  });

  describe('legacy bare-uuid qwen slot (#1891) — a qwen libraryUuid with NO provenance field', () => {
    it('is entered by the entry condition despite carrying no provenance, and is healthy when routed to qwen', () => {
      const c = char({ ttsEngine: 'qwen', overrideTtsVoices: { qwen: { name: 'v1', libraryUuid: 'v1' } } });
      const e = entry({ engines: { qwen: { status: 'ready', baseModel: 'x' } }, master: healthyMaster() });
      expect(selectCloneReadinessVerdicts(state([c], [e]), 'b1')).toEqual([]);
    });

    it('reports wrong-engine when routed off qwen, with otherEngineOk false — the legacy shape carries no `provenance` on ANY engine, so `hasClonedProvenance` (the ONLY correct otherEngineOk helper, arity 2) is false for it everywhere; a mutation dropping its second argument (`characterHasClonedSlot(character)`, always true for any cloned character) would read otherEngineOk as true here', () => {
      const c = char({
        ttsEngine: 'coqui',
        overrideTtsVoices: { qwen: { name: 'v1', libraryUuid: 'v1' } },
      });
      const e = entry({ engines: { qwen: { status: 'ready', baseModel: 'x' } }, master: healthyMaster() });
      const verdicts = selectCloneReadinessVerdicts(state([c], [e]), 'b1');
      expect(verdicts).toEqual([
        expect.objectContaining({ reason: 'wrong-engine', otherEngineOk: false }),
      ]);
    });
  });
});

describe('characterNeedsCloneCheck / castNeedsCloneCheck — Decision 5 entry condition', () => {
  it('is true for a character carrying a real cloned cast slot', () => {
    const c = char({ overrideTtsVoices: { qwen: { name: 'v1', libraryUuid: 'v1', provenance: 'cloned' } } });
    expect(characterNeedsCloneCheck(c)).toBe(true);
    expect(castNeedsCloneCheck([c])).toBe(true);
  });

  it('is true for the legacy bare-uuid shape (#1891)', () => {
    const c = char({ overrideTtsVoices: { qwen: { name: 'v1', libraryUuid: 'v1' } } });
    expect(characterNeedsCloneCheck(c)).toBe(true);
  });

  it('is false for a plain character with no cloned or legacy slot', () => {
    const c = char({ overrideTtsVoices: { qwen: { name: 'v1' } } });
    expect(characterNeedsCloneCheck(c)).toBe(false);
    expect(castNeedsCloneCheck([c])).toBe(false);
  });
});
