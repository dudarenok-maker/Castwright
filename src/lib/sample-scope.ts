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
   both cases.

   bug #1411: the `char-<id>` fallback namespace is workspace-global, not
   per-book — the analyzer assigns the same literal id ('narrator',
   'unknown-male', 'unknown-female') to every book's narrator/auto-folded
   background character, so two unrelated books' voiceId-less characters
   shared one cache-file prefix and one book's "Sampled" badge bled onto the
   other's. `bookId` disambiguates the fallback the same way server/src/
   routes/voices.ts's `dedupKey` already disambiguates cross-book identity
   (#1410) — omitted only for the rare no-book-context caller (e.g. the
   Profile Drawer opened from the Voices Library with nothing open), which
   degrades to the old unscoped behaviour rather than losing the preview
   affordance entirely.

   Joined with `__` (not a plain hyphen) — `bookId` is itself hyphen-rich
   free text (`slug(author)__slug(series)__slug(title)`), so a hyphen join
   can still collide across two different (book, characterId) pairs (e.g.
   book "One-Two"'s `narrator` vs book "One"'s `two-narrator` both hyphen-
   join to the identical string). `::` (the separator voices.ts's `dedupKey`
   uses for the same disambiguation, #1410) is NOT safe here even though
   this value LOOKS like a plain string: it becomes part of an actual cache
   FILENAME (voiceSampleFileName -> asciiFileScope, voice-sample-cache.ts),
   and the read side (voices.ts's `hasCachedQwenSample`) matches that
   filename by a RAW prefix check on this same string — it does NOT run it
   through asciiFileScope first. A `::` would make asciiFileScope flatten
   the scope on write (colon isn't in its `[A-Za-z0-9_.-]` allow-list) while
   the read side keeps matching the unflattened string, breaking the
   Sampled badge for every voiceId-less character, not just the rare
   collision case. `__` stays inside that allow-list — `slug()` (bookId's
   own building block) and the character-id generator (`unicodeKebab`)
   both only ever collapse runs of non-alnum characters to a SINGLE hyphen,
   never `__`, so bookId always splits into exactly 3 segments on `__` and
   an appended id can't introduce a 4th ambiguously. Uses `??` (not a
   truthy check) for the voiceId branch, matching the server's
   `c.voiceId ?? …` — a truthy check would diverge from the server for the
   edge case of an empty-string `voiceId`. */
export function sampleScopeFor(
  character: { id: string; voiceId?: string | null },
  bookId?: string,
): string {
  return character.voiceId ?? (bookId ? `char-${bookId}__${character.id}` : `char-${character.id}`);
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
