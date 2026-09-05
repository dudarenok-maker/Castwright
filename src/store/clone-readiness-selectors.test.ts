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

  it('fires for a character routed to Kokoro with a qwen-only cloned slot, and castOnEngine is qwen because the qwen slot is healthy', () => {
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
        castOnEngine: 'qwen',
      }),
    ]);
  });

  it('a coqui-only clone routed to Kokoro yields castOnEngine "coqui" (regression: the old blind `engine === "qwen" ? "coqui" : "qwen"` swap landed on qwen for ANY non-qwen routed engine, including Kokoro, so a coqui-only clone was reported as unfixable with no CTA at all)', () => {
    const c = char({
      ttsEngine: 'kokoro',
      overrideTtsVoices: { coqui: { name: 'v1', libraryUuid: 'v1', provenance: 'cloned' } },
    });
    const e = entry({ engines: { xtts: { status: 'ready', coquiVersion: 'x' } }, master: healthyMaster() });
    const verdicts = selectCloneReadinessVerdicts(state([c], [e]), 'b1');
    expect(verdicts).toEqual([
      expect.objectContaining({ reason: 'wrong-engine', castOnEngine: 'coqui' }),
    ]);
  });

  it('a qwen-routed character with a healthy coqui cast slot (no qwen cast slot at all) yields castOnEngine "coqui" — the pre-existing binary case, unchanged by the CLONE_ENGINE_LIST iteration', () => {
    const c = char({
      ttsEngine: 'qwen',
      overrideTtsVoices: { coqui: { name: 'v1', libraryUuid: 'v1', provenance: 'cloned' } },
    });
    const e = entry({ engines: { xtts: { status: 'ready', coquiVersion: 'x' } }, master: healthyMaster() });
    const verdicts = selectCloneReadinessVerdicts(state([c], [e]), 'b1');
    expect(verdicts).toEqual([
      expect.objectContaining({ engine: 'qwen', reason: 'wrong-engine', castOnEngine: 'coqui' }),
    ]);
  });

  it('a character routed to Kokoro with BOTH clone-capable cast slots healthy yields the CLONE_ENGINE_LIST-first candidate ("qwen"), deterministically — neither slot is excluded by routing since Kokoro is not clone-capable', () => {
    const c = char({
      ttsEngine: 'kokoro',
      overrideTtsVoices: {
        qwen: { name: 'v1', libraryUuid: 'v1', provenance: 'cloned' },
        coqui: { name: 'v2', libraryUuid: 'v2', provenance: 'cloned' },
      },
    });
    const e1 = entry({ voiceUuid: 'v1', engines: { qwen: { status: 'ready', baseModel: 'x' } }, master: healthyMaster() });
    const e2 = entry({ voiceUuid: 'v2', engines: { xtts: { status: 'ready', coquiVersion: 'x' } }, master: healthyMaster() });
    const verdicts = selectCloneReadinessVerdicts(state([c], [e1, e2]), 'b1');
    expect(verdicts).toEqual([
      expect.objectContaining({ engine: 'kokoro', reason: 'wrong-engine', castOnEngine: 'qwen' }),
    ]);
  });

  it('the routed engine is excluded from candidacy: a qwen-routed character with NO qwen cast slot (so qwen is never a real candidate) and a healthy coqui slot must not offer "Cast on qwen" — pins that the loop never re-suggests the character\'s own routed engine as its own fix', () => {
    const c = char({
      ttsEngine: 'qwen',
      overrideTtsVoices: { coqui: { name: 'v1', libraryUuid: 'v1', provenance: 'cloned' } },
    });
    const e = entry({ engines: { xtts: { status: 'ready', coquiVersion: 'x' } }, master: healthyMaster() });
    const verdicts = selectCloneReadinessVerdicts(state([c], [e]), 'b1');
    expect(verdicts).toEqual([
      expect.objectContaining({ engine: 'qwen', reason: 'wrong-engine', castOnEngine: 'coqui' }),
    ]);
    expect(verdicts[0].castOnEngine).not.toBe('qwen');
  });

  it('a plain, non-cloned cast produces no verdicts at all', () => {
    const c = char({ ttsEngine: 'kokoro' });
    expect(selectCloneReadinessVerdicts(state([c], []), 'b1')).toEqual([]);
  });

  describe('unresolvable-uuid (#2054) — a cloned slot whose libraryUuid cannot be resolved', () => {
    it('a cloned slot with NO libraryUuid at all is named by the gate, not silently dropped — mutation 1 target: restoring buildInput\'s old `undefined` return for this case must turn this test red', () => {
      const c = char({
        ttsEngine: 'qwen',
        overrideTtsVoices: { qwen: { name: 'v1', provenance: 'cloned' } },
      });
      const verdicts = selectCloneReadinessVerdicts(state([c], []), 'b1');
      expect(verdicts).toEqual([
        expect.objectContaining({ characterId: 'c1', reason: 'unresolvable-uuid', castOnEngine: null }),
      ]);
    });

    it('a cloned slot with an empty-string libraryUuid also reports unresolvable-uuid', () => {
      const c = char({
        ttsEngine: 'qwen',
        overrideTtsVoices: { qwen: { name: 'v1', libraryUuid: '', provenance: 'cloned' } },
      });
      const verdicts = selectCloneReadinessVerdicts(state([c], []), 'b1');
      expect(verdicts).toEqual([expect.objectContaining({ reason: 'unresolvable-uuid' })]);
    });

    it('a cloned slot with a malformed (non-string) libraryUuid also reports unresolvable-uuid', () => {
      const c = char({
        ttsEngine: 'qwen',
        overrideTtsVoices: {
          qwen: { name: 'v1', libraryUuid: 12345 as unknown as string, provenance: 'cloned' },
        },
      });
      const verdicts = selectCloneReadinessVerdicts(state([c], []), 'b1');
      expect(verdicts).toEqual([expect.objectContaining({ reason: 'unresolvable-uuid' })]);
    });

    it('mutation 2 control: a non-cloned (designed) slot with no libraryUuid at all still produces no gate, whatever its uuid field looks like — must stay green when unresolvable-uuid is wired correctly, and go red if that branch is widened to also fire on non-cloned slots', () => {
      const c = char({ ttsEngine: 'qwen', overrideTtsVoices: { qwen: { name: 'v1' } } });
      expect(selectCloneReadinessVerdicts(state([c], []), 'b1')).toEqual([]);
    });
  });

  describe('legacy bare-uuid qwen slot (#1891) — a qwen libraryUuid with NO provenance field', () => {
    it('is entered by the entry condition despite carrying no provenance, and is healthy when routed to qwen', () => {
      const c = char({ ttsEngine: 'qwen', overrideTtsVoices: { qwen: { name: 'v1', libraryUuid: 'v1' } } });
      const e = entry({ engines: { qwen: { status: 'ready', baseModel: 'x' } }, master: healthyMaster() });
      expect(selectCloneReadinessVerdicts(state([c], [e]), 'b1')).toEqual([]);
    });

    it('reports wrong-engine when routed off qwen, and offers "Cast on Qwen" — `buildInput` already computes the legacy-aware `characterHasSlot` (engine === \'qwen\') correctly for the qwen candidate; overwriting it with the bare, provenance-requiring `hasClonedProvenance(character, candidate)` (always false for this shape, which carries no `provenance` field at all) self-rejects every candidate and was the #5 regression this pins against', () => {
      const c = char({
        ttsEngine: 'coqui',
        overrideTtsVoices: { qwen: { name: 'v1', libraryUuid: 'v1' } },
      });
      const e = entry({ engines: { qwen: { status: 'ready', baseModel: 'x' } }, master: healthyMaster() });
      const verdicts = selectCloneReadinessVerdicts(state([c], [e]), 'b1');
      expect(verdicts).toEqual([
        expect.objectContaining({ reason: 'wrong-engine', castOnEngine: 'qwen' }),
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
