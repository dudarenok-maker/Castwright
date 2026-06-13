/* Stable cache scope for a character's voice sample.

   The voice-sample cache filename is `<scope>-<modelKey>-<hash>.mp3`. A
   designed Qwen audition is pre-rendered into that cache at DESIGN time
   (server `qwen-voice.ts`), and the "Play 12s" player reads it back later —
   so the scope MUST be identical at both moments or the player misses the
   cache and re-synthesises the same line.

   The bug this fixes: the old derivation was `voice ? voice.id : char-<id>`,
   where `voice` is the library entry resolved from the character's voiceId.
   That resolution is timing-dependent — at design time the voice often
   isn't in the loaded library yet (scope `char-corvin`), but by play time it
   is (scope `corvin`) — so the two diverged and the audition never got reused.

   Keying on the persisted `character.voiceId` (the identity a matched voice
   resolves to anyway) removes the timing dependency: design-time and
   play-time agree by construction. The `char-<id>` namespace is the fallback
   for characters with no voiceId, keeping their per-character samples distinct
   from library-voice samples.

   It deliberately does NOT consult the resolved library `voice`: the earlier
   "`voice?.id ?? character.voiceId ?? …`" form still flipped for a character
   with NO `voiceId` (e.g. a freshly-designed Qwen voice), because
   `findVoiceForCharacter` resolves a same-id library entry by play-time but
   not by design-time — so the audition cached under `char-wren` was re-synth-
   ised under `wren`. When `voiceId` IS set it equals the matched `voice.id`
   anyway, so dropping `voice` loses nothing and makes the scope stable for
   both cases. */
export function sampleScopeFor(character: { id: string; voiceId?: string | null }): string {
  return character.voiceId ?? `char-${character.id}`;
}

/* The server names cached sample files as
   /audio/voices/{voiceId}-{modelKey}-{paramHash}.mp3 (see
   server/src/routes/voice-sample.ts). We don't know the hash client-side, so
   "this voice's sample is currently playing" is detected by prefix match —
   stable across attribute edits and the cache-busting hash. Shared by the
   profile drawer, the compare modal, and the A/B audition hook. */
export function sampleUrlPrefix(voiceId: string, modelKey: string): string {
  return `/audio/voices/${encodeURIComponent(voiceId)}-${modelKey}`;
}
