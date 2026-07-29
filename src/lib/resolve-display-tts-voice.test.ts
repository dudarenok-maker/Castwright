import { describe, it, expect } from 'vitest';
import { resolveDisplayTtsVoice, COQUI_PROFILE_VOICES } from './tts-voice-mapping';

/* Build minimal Character/Voice values off the function's own parameter types
   so this unit test needs no fixture/type imports. */
type C = Parameters<typeof resolveDisplayTtsVoice>[0];
type V = NonNullable<Parameters<typeof resolveDisplayTtsVoice>[1]>;

const ch = (o: Partial<C> = {}): C => ({ id: 'c1', name: 'Test', ...o }) as C;
const vx = (o: Partial<V> = {}): V =>
  ({ id: 'v1', ttsVoice: { provider: 'coqui', name: 'Damien Black', description: '' }, ...o }) as V;

describe('resolveDisplayTtsVoice', () => {
  it('uses the character qwen override when present', () => {
    const r = resolveDisplayTtsVoice(
      ch({ ttsEngine: 'qwen', overrideTtsVoices: { qwen: { name: 'qwen-wren' } } }),
      undefined,
      'kokoro',
    );
    expect(r).toEqual({ provider: 'qwen', name: 'qwen-wren', description: 'Designed voice' });
  });

  it('falls back to the matched qwen Voice for a reused row with no override', () => {
    /* Regression: reused qwen characters carry the designed voice on the matched
       library Voice (override empty). The row must show that voice, not the
       "No voice designed yet" stub. */
    const r = resolveDisplayTtsVoice(
      ch({ ttsEngine: 'qwen' }),
      vx({ ttsVoice: { provider: 'qwen', name: 'qwen-lord-vane', description: 'Designed voice' } }),
      'kokoro',
    );
    expect(r).toEqual({ provider: 'qwen', name: 'qwen-lord-vane', description: 'Designed voice' });
  });

  it('returns the empty qwen stub when neither override nor a named qwen Voice resolves', () => {
    const r = resolveDisplayTtsVoice(ch({ ttsEngine: 'qwen' }), undefined, 'kokoro');
    expect(r).toEqual({ provider: 'qwen', name: '', description: 'No voice designed yet' });
  });

  it('does not borrow a non-qwen matched Voice for a qwen character', () => {
    const r = resolveDisplayTtsVoice(
      ch({ ttsEngine: 'qwen' }),
      vx({ ttsVoice: { provider: 'kokoro', name: 'af_bella', description: '' } }),
      'kokoro',
    );
    expect(r.name).toBe('');
  });

  it('preset engine still shows the matched library voice', () => {
    const r = resolveDisplayTtsVoice(ch(), vx(), 'coqui');
    expect(r).toEqual({ provider: 'coqui', name: 'Damien Black', description: '' });
  });
});

describe('resolveDisplayTtsVoice — coqui clone resolution (fs-38 Wave 3c Task 25 [ADV-H1])', () => {
  /* No matched library Voice in any of these — forces the fallback stub
     (resolveTtsVoiceForCharacter) so the coqui branch under test actually
     runs, mirroring the server's pickVoiceForEngine isCloneEngine branch. */
  const COQUI_CATALOG_NAMES = new Set(Object.values(COQUI_PROFILE_VOICES).flat());

  it('resolves a cloned coqui slot to its storage key, not a human name', () => {
    const r = resolveDisplayTtsVoice(
      ch({
        overrideTtsVoices: {
          coqui: { name: 'Aunt Marta', libraryUuid: 'lib-uuid-1', provenance: 'cloned' },
        },
      }),
      undefined,
      'coqui',
    );
    expect(r).toEqual({ provider: 'coqui', name: 'xtts-lib-uuid-1', description: 'Local voice' });
  });

  it('resolves a designed (not yet cloned) coqui library slot the same way', () => {
    const r = resolveDisplayTtsVoice(
      ch({
        overrideTtsVoices: {
          coqui: { name: 'Designed Voice', libraryUuid: 'lib-uuid-2', provenance: 'designed' },
        },
      }),
      undefined,
      'coqui',
    );
    expect(r.name).toBe('xtts-lib-uuid-2');
  });

  it('does not treat an imported coqui slot as a clone — falls through to a real catalog name', () => {
    const r = resolveDisplayTtsVoice(
      ch({
        overrideTtsVoices: {
          coqui: { name: 'Imported Name', libraryUuid: 'lib-uuid-3', provenance: 'imported' },
        },
      }),
      undefined,
      'coqui',
    );
    /* Assert on a real catalog membership, not just "!== the storage key" —
       an arbitrary placeholder name would also satisfy the weaker
       inequality without proving the fallthrough actually reached the
       catalog lookup (Task 16's server-side M-1 finding, mirrored here). */
    expect(COQUI_CATALOG_NAMES.has(r.name)).toBe(true);
  });

  it('a slot with a libraryUuid but no provenance (legacy drift) falls through to the catalog', () => {
    const r = resolveDisplayTtsVoice(
      ch({ overrideTtsVoices: { coqui: { name: 'Legacy Slot', libraryUuid: 'lib-uuid-4' } } }),
      undefined,
      'coqui',
    );
    expect(COQUI_CATALOG_NAMES.has(r.name)).toBe(true);
  });

  it('a slot with a name but no libraryUuid falls through to the catalog — the client resolver has no generic name-slot read', () => {
    /* Unlike the server's pickVoiceForEngine (which reads
       overrideTtsVoices[engine].name generically for any engine),
       resolveTtsVoiceForCharacter's non-qwen branch only knows the clone
       shortcut above; a plain name-only slot with no libraryUuid still
       falls through to the stableHash catalog pick client-side. */
    const r = resolveDisplayTtsVoice(
      ch({ overrideTtsVoices: { coqui: { name: 'Plain Pick', provenance: 'cloned' } } }),
      undefined,
      'coqui',
    );
    expect(COQUI_CATALOG_NAMES.has(r.name)).toBe(true);
  });
});
