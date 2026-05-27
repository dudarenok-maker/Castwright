/* Stable cache scope for a character's voice sample.

   The voice-sample cache filename is `<scope>-<modelKey>-<hash>.mp3`. A
   designed Qwen audition is pre-rendered into that cache at DESIGN time
   (server `qwen-voice.ts`), and the "Play 12s" player reads it back later —
   so the scope MUST be identical at both moments or the player misses the
   cache and re-synthesises the same line.

   The bug this fixes: the old derivation was `voice ? voice.id : char-<id>`,
   where `voice` is the library entry resolved from the character's voiceId.
   That resolution is timing-dependent — at design time the voice often
   isn't in the loaded library yet (scope `char-Corvin`), but by play time it
   is (scope `Corvin`) — so the two diverged and the audition never got reused.

   Keying on the persisted `character.voiceId` (the identity a matched voice
   resolves to anyway) removes the timing dependency: design-time and
   play-time agree by construction. `voice?.id` stays first so an explicitly
   resolved voice still wins; the `char-<id>` namespace is the fallback for
   characters with no voiceId, keeping their per-character samples distinct
   from library-voice samples. Mirrors the `voice?.id ?? character.voiceId ??
   id` identity already used for the override API in profile-drawer.tsx. */
export function sampleScopeFor(
  character: { id: string; voiceId?: string | null },
  voice?: { id: string } | null,
): string {
  return voice?.id ?? character.voiceId ?? `char-${character.id}`;
}
