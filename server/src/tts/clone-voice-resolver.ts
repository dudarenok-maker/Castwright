/* fs-38 Wave 3b2 — the cloned-voice resolver. T4 lays the module's
   foundation: the `BrokenClonedVoice` shape and `UnresolvableClonedVoiceError`
   (moved here from synthesise-chapter.ts, which re-exports it, to avoid an
   import cycle — synthesiseChapter will import this module's resolver, and
   the resolver needs this error). T5 adds the classifier + async
   orchestrator (`resolveClonedVoicesForChapter`) on top. */

/* Why a cloned voice can't be used this run. `engine-unavailable` is the
   coarse 3b1 reason (Qwen unreachable) preserved for the legacy single-name
   constructor; the finer-grained reasons are for T5's classifier. */
export interface BrokenClonedVoice {
  name: string;
  reason: 'revoked' | 'missing-master' | 'engine-unavailable' | 'derive-failed' | 'misconfigured';
}

/* fs-38 Wave 3b1 (C1) — a cloned-provenance Qwen group must never be silently
   substituted. When Qwen is unavailable this run, applyQwenFallback raises this
   instead of rerouting to Kokoro/Coqui — a real person's voice is never swapped
   for another. 3b2's resolver reuses this same typed error, now carrying a
   structured `broken` list so a multi-character resolver pre-pass (T5) can
   report every unresolvable voice in one throw instead of failing character
   by character. */
export class UnresolvableClonedVoiceError extends Error {
  readonly broken: BrokenClonedVoice[];

  constructor(characterName: string, detail?: string) {
    super(
      `Cloned voice for "${characterName}" is unavailable — the Qwen engine is not available this ` +
        `run, and a cloned voice must never be substituted with another. Re-enable Qwen or reassign ` +
        `the character.` +
        (detail ? ` ${detail}` : ''),
    );
    this.name = 'UnresolvableClonedVoiceError';
    this.broken = [{ name: characterName, reason: 'engine-unavailable' }];
  }

  /* Pre-pass entry point (T5): build one error from the full set of
     characters whose cloned voice couldn't be resolved this run. */
  static fromList(broken: BrokenClonedVoice[]): UnresolvableClonedVoiceError {
    const message =
      broken.length === 0
        ? 'Cloned voice(s) unavailable — a cloned voice must never be substituted with another.'
        : `Cloned voice(s) unavailable — a cloned voice must never be substituted with another: ` +
          broken.map((b) => `"${b.name}" (${b.reason})`).join(', ') +
          `. Re-enable Qwen, restore the missing voice(s), or reassign the character(s).`;
    const e = new UnresolvableClonedVoiceError(broken[0]?.name ?? '');
    return Object.assign(e, { message, broken: [...broken] });
  }
}
