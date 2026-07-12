/* Frontend mirror of the audio-tag vocabulary + the TTS-boundary strip, kept in
   lock-step with server/src/parsers/audio-tags.ts (AUDIO_TAGS) and
   server/src/tts/text-normalize.ts (stripAudioTags).

   Inline bracketed tags like `[emphatic]` / `[shouting]` ride along inside
   `sentence.text` from the analyzer. No local TTS engine speaks the bracket
   markup — the synth path strips it before synthesis, so the audio (and the
   render-time `textHash` stamped over the SPOKEN text) never contains the tag.
   The UI keeps the raw tag for analyst review, which is why the staleness diff
   (`stale-chapters.ts`) must strip audio tags before hashing: otherwise a
   tagged sentence's live text never matches its render-time hash and the
   chapter reads permanently — and un-clearably — "stale". */

/* MUST equal server/src/parsers/audio-tags.ts AUDIO_TAGS. A shared strip vector
   is pinned in this file's test AND text-normalize.test.ts so a drift on either
   side fails loudly. */
export const AUDIO_TAGS = [
  'emphatic',
  'shouting',
  'whispers',
  'laughs',
  'sighs',
  'excited',
  'hesitant',
] as const;
export type AudioTag = (typeof AUDIO_TAGS)[number];

/* Byte-for-byte behaviour match with server stripAudioTags: replace each
   known-vocabulary `[tag]` (plus surrounding whitespace) with a single space,
   collapse runs, then trim — so "She said [emphatic] hello." → "She said hello."
   rather than leaving a doubled space. Only the closed vocabulary is removed, so
   arbitrary bracketed prose ("[Citation Needed]") is preserved. */
const AUDIO_TAG_RUN = new RegExp(`\\s*\\[(?:${AUDIO_TAGS.join('|')})\\]\\s*`, 'gi');

/** Strip the analyzer's bracketed audio-tag vocabulary — the mirror of
    server/src/tts/text-normalize.ts stripAudioTags. */
export function stripAudioTags(text: string): string {
  return text.replace(AUDIO_TAG_RUN, ' ').replace(/\s+/g, ' ').trim();
}
