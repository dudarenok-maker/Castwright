/* Pre-flight text normalizer for the TTS path.

   XTTS v2 (and to a lesser extent the Gemini TTS models) reliably mishandle
   a handful of patterns we hit in published prose. Each transform here is
   anchored to an observed failure mode:

   - Long all-caps runs are spelled letter-by-letter or trigger hallucinations
     / repetition loops. Chapter 1 of the Keeper book opens with the literal
     word "ONE" and the model emits "oh — en — ee" in 1.15 s. Chapter 2 opens
     with "THE NEXT SECOND WAS A BLUR." and the model emitted ~60 s of garbled
     audio in front of the real narration.
   - Em-dashes (U+2014) and en-dashes (U+2013) sometimes send the autoregressive
     decoder into a loop, especially when wedged between lowercase words
     (e.g. `right—missing Wren by inches—then`).
   - Zero-width / format characters (U+200B–U+200F, U+202A–U+202E, U+2060,
     U+FEFF) survive copy-paste from PDFs and HTML scrapers. XTTS's tokenizer
     can produce out-of-vocab embedding indices on these, which surfaces as a
     CUDA `device-side assert triggered` mid-chapter that poisons the CUDA
     context for the rest of the process.
   - Control characters (C0/C1, U+0000–U+001F except \\t and \\n, plus
     U+007F–U+009F) come from raw .txt manuscripts converted with stale
     codec assumptions. Same XTTS tokenizer failure mode as zero-widths.
   - Unpaired surrogates (U+D800–U+DFFF outside a valid pair) are pure noise
     from broken UTF-16 round-trips; they have no defensible audio mapping
     and crash the tokenizer the same way.
   - Decomposed Unicode (NFD) diacritics — "é" as U+0065 + U+0301 — confuse
     the tokenizer on edge cases; composed (NFC) is the safe canonical form.

   The fix is to compose all of these in `normaliseForTts`, the single entry
   point used by `synthesiseChapter`. Each transform is exported so a future
   refactor can pin which half regressed.

   All transforms are idempotent and order-independent.

   Audio tags (plan 70d). Inline bracketed tags like `[empathic]` /
   `[shouting]` ride along inside sentence.text from the analyzer. No
   current TTS engine in this app (Kokoro v1, Coqui XTTS v2, Gemini TTS)
   interprets bracket markup as prosody — they all read it literally
   ("open bracket empathic close bracket"). Strip the known-vocabulary
   tag tokens at the TTS boundary so the audio never contains the
   bracket characters. The original `sentence.text` is untouched so the
   UI caption / manuscript diff still sees the tag for analyst review. */

import { AUDIO_TAGS } from '../parsers/audio-tags.js';

const ALL_CAPS_RUN = /([A-Z])([A-Z']{2,})/g;
const DASH_RUN = /\s*[–—]\s*/g;
/* `[empathic]` / `[shouting]` / etc — only the analyzer-vocabulary tags.
   Matching the closed set keeps proper-noun-in-brackets ("[Citation Needed]")
   from being silently swallowed. Case-insensitive because the analyzer
   has emitted mixed casing in some fixtures. The trailing whitespace is
   collapsed so "She said [emphatic] hello." → "She said hello." rather
   than "She said  hello." (note doubled space). */
const AUDIO_TAG_RUN = new RegExp(`\\s*\\[(?:${AUDIO_TAGS.join('|')})\\]\\s*`, 'gi');

/* Zero-width + bidi format chars. Codepoints (all written as \u escapes so
   the source is auditable — these glyphs are invisible in a normal editor):
   - U+200B ZERO WIDTH SPACE
   - U+200C ZERO WIDTH NON-JOINER
   - U+200D ZERO WIDTH JOINER
   - U+200E LEFT-TO-RIGHT MARK
   - U+200F RIGHT-TO-LEFT MARK
   - U+202A–U+202E bidi embedding/override controls
   - U+2060 WORD JOINER
   - U+FEFF ZERO WIDTH NO-BREAK SPACE / BOM */
const ZERO_WIDTH_AND_BIDI = new RegExp('[\\u200B-\\u200F\\u202A-\\u202E\\u2060\\uFEFF]', 'g');

/* C0 control chars (U+0000–U+001F) MINUS the two readable ones we want to
   preserve (U+0009 TAB, U+000A LF) plus C1 (U+007F–U+009F). XTTS treats
   any of these as opaque tokens; \\r is mapped to nothing because mixed
   line endings just produce duplicate breaks. */
const CONTROL_CHARS = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g;

/* Lone surrogate code units. A valid surrogate pair (high U+D800–U+DBFF
   followed by low U+DC00–U+DFFF) renders correctly in JS strings; this
   regex matches halves that are *not* paired by walking forwards from a
   high surrogate and accepting only when the next code unit is a valid low
   surrogate (and vice versa). Anything that matches is junk from a busted
   UTF-16 round-trip. */
const UNPAIRED_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Title-case runs of >=3 consecutive capital letters (apostrophes allowed
    inside the run). Single capitals and 2-letter caps (initials, "OK", "MR")
    are left alone. */
export function denormaliseAllCaps(text: string): string {
  return text.replace(ALL_CAPS_RUN, (_m, head: string, tail: string) => head + tail.toLowerCase());
}

/** Replace em-dash (U+2014) and en-dash (U+2013) with a comma so the TTS
    decoder treats the parenthetical break like any other clause boundary.
    Surrounding whitespace is collapsed so `right—missing` and `right — missing`
    both become `right, missing`. */
export function softenDashes(text: string): string {
  return text.replace(DASH_RUN, ', ');
}

/** Strip every codepoint that can poison the XTTS tokenizer with no defensible
    audio mapping: zero-width / bidi format characters, C0/C1 control chars
    (except TAB and LF), and unpaired UTF-16 surrogates. Also runs Unicode NFC
    normalization so decomposed diacritics ("é" as e + ́) collapse to the
    composed form the tokenizer was trained on.

    Why all of these in one pass: each pattern has produced a CUDA `device-side
    assert triggered` end-to-end with XTTS v2 (the model raises an out-of-bounds
    embedding-lookup kernel error and the CUDA context is then corrupted for
    the rest of the process). Composing them at the boundary keeps the bad
    bytes out of the model entirely. */
export function stripUnsafeForTts(text: string): string {
  return text
    .normalize('NFC')
    .replace(ZERO_WIDTH_AND_BIDI, '')
    .replace(CONTROL_CHARS, '')
    .replace(UNPAIRED_SURROGATE, '');
}

/** Strip the analyzer's bracketed audio-tag vocabulary so the TTS engine
    doesn't read "open bracket empathic close bracket" aloud. Plan 70d.
    Only the closed vocabulary in AUDIO_TAGS is removed — arbitrary
    bracketed prose is preserved. Trailing whitespace is collapsed so we
    don't leave a doubled space where the tag used to sit. */
export function stripAudioTags(text: string): string {
  return text.replace(AUDIO_TAG_RUN, ' ').replace(/\s+/g, ' ').trim();
}

/** Compose the TTS-bound transforms. Apply this immediately before handing
    text to a TTS provider — do NOT mutate the underlying SentenceOutput,
    since the original text still drives UI segment captions, manuscript
    diffing, and quote audit. Order matters: strip first (so all-caps + dash
    transforms operate on clean ASCII), then humanise the casing/dashes,
    then drop audio tags (last so the bracket characters are still present
    while the all-caps detector runs — `[SHOUTING]` is excluded from the
    all-caps fold by the closed-vocabulary check, so order is academic,
    but keeping the strip last keeps the contract obvious). */
export function normaliseForTts(text: string): string {
  return stripAudioTags(softenDashes(denormaliseAllCaps(stripUnsafeForTts(text))));
}
