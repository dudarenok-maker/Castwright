/* fs-38 Wave 3b2 (T4) — UnresolvableClonedVoiceError now lives here (moved
   from synthesise-chapter.ts to avoid an import cycle with the resolver) and
   carries a structured `broken: BrokenClonedVoice[]` list. The legacy
   single-name constructor is the 3b1 applyQwenFallback backstop and must
   keep producing byte-identical messages — this pins that contract before
   T5 adds the classifier/orchestrator on top. */
import { describe, it, expect } from 'vitest';
import { UnresolvableClonedVoiceError } from './clone-voice-resolver.js';

describe('UnresolvableClonedVoiceError', () => {
  it('fromList carries the structured broken voices and a readable message', () => {
    const e = UnresolvableClonedVoiceError.fromList([
      { name: 'Marlow', reason: 'revoked' },
      { name: 'Reeve', reason: 'missing-master' },
    ]);
    expect(e).toBeInstanceOf(UnresolvableClonedVoiceError);
    expect(e.broken).toHaveLength(2);
    expect(e.message).toContain('Marlow');
    expect(e.message).toContain('Reeve');
    expect(e.message).toContain('revoked');
    expect(e.message).toContain('missing-master');
    expect(e.name).toBe('UnresolvableClonedVoiceError');
  });

  it('the legacy single-name constructor still works (3b1 backstop)', () => {
    const e = new UnresolvableClonedVoiceError('Marlow');
    expect(e.broken).toEqual([{ name: 'Marlow', reason: 'engine-unavailable' }]);
    expect(e.message).toBe(
      `Cloned voice for "Marlow" is unavailable — the Qwen engine is not available this ` +
        `run, and a cloned voice must never be substituted with another. Re-enable Qwen or reassign ` +
        `the character.`,
    );
  });

  it('the legacy constructor still supports an optional detail suffix', () => {
    const e = new UnresolvableClonedVoiceError('Marlow', 'sidecar offline');
    expect(e.message).toBe(
      `Cloned voice for "Marlow" is unavailable — the Qwen engine is not available this ` +
        `run, and a cloned voice must never be substituted with another. Re-enable Qwen or reassign ` +
        `the character. sidecar offline`,
    );
  });
});
