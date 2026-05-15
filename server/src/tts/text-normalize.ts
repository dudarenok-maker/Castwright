/* Pre-flight text normalizer for the TTS path.

   XTTS v2 (and to a lesser extent the Gemini TTS models) reliably mishandle
   two patterns we hit constantly in published prose:

   - Long all-caps runs are spelled letter-by-letter or trigger hallucinations
     / repetition loops. Chapter 1 of the Keeper book opens with the literal
     word "ONE" and the model emits "oh — en — ee" in 1.15 s. Chapter 2 opens
     with "THE NEXT SECOND WAS A BLUR." and the model emitted ~60 s of garbled
     audio in front of the real narration.
   - Em-dashes (U+2014) and en-dashes (U+2013) sometimes send the autoregressive
     decoder into a loop, especially when wedged between lowercase words
     (e.g. `right—missing Sophie by inches—then`).

   The fix is to scrub both before handing the text to the provider:

   - `denormaliseAllCaps` title-cases any run of >=3 capital letters (apostrophes
     count, so "SWEENEY'S" → "Sweeney's"). Two-letter runs like "OK" or "MR"
     stay intact — XTTS handles those fine and we don't want to corrupt valid
     abbreviations.
   - `softenDashes` replaces em/en-dashes (with their surrounding whitespace)
     by a single `, ` so the decoder sees a normal clause break.

   Both transforms are idempotent and order-independent. Audio tags like
   `[shouting]` are lowercase inside the brackets and are not touched. */

const ALL_CAPS_RUN = /([A-Z])([A-Z']{2,})/g;
const DASH_RUN = /\s*[—–]\s*/g;

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

/** Compose the TTS-bound transforms. Apply this immediately before handing
    text to a TTS provider — do NOT mutate the underlying SentenceOutput,
    since the original text still drives UI segment captions, manuscript
    diffing, and quote audit. */
export function normaliseForTts(text: string): string {
  return softenDashes(denormaliseAllCaps(text));
}
