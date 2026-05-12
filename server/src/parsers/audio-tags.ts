/* Shared audio-tag vocabulary + parser-side detectors. Inline bracketed tags
   like `[whispers]` ride along inside `sentence.text` from analysis through to
   the TTS provider. This file is the single source of truth for the parser
   layer; `src/lib/audio-tags.ts` mirrors AUDIO_TAGS for the UI. */

export const AUDIO_TAGS = ['emphatic', 'shouting', 'whispers', 'laughs', 'sighs'] as const;
export type AudioTag = typeof AUDIO_TAGS[number];

/* Smart and straight quote characters that wrap dialogue. */
const QUOTE_OPENS = '"“';   // " “
const QUOTE_CLOSES = '"”';  // " ”

/* A run is "all caps" if it has at least 2 consecutive uppercase letters and is
   ≥ 4 characters long once spaces and basic punctuation are stripped. Avoids
   triggering on initials ("J.R.R.") or one-word interjections ("OK"). */
function isShoutingRun(s: string): boolean {
  const letters = s.replace(/[^A-Za-z]/g, '');
  if (letters.length < 4) return false;
  if (letters !== letters.toUpperCase()) return false;
  return /[A-Z]{2,}/.test(s);
}

/* Title-case a shouted run so the TTS engine reads it as words, not letters.
   Preserves punctuation and whitespace; only lowercases run-internal letters
   after the first letter of each word. */
function denormaliseShouting(s: string): string {
  return s.replace(/([A-Z])([A-Z']+)/g, (_m, head, tail) => head + tail.toLowerCase());
}

/* Scan a string for dialogue spans (text between matched quote characters)
   that are entirely uppercase, and prepend `[shouting]` inside the quote.
   The transform is idempotent — a quote already starting with `[shouting]`
   is left alone. Returns the rewritten string. */
export function tagShoutingDialog(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const isOpen = QUOTE_OPENS.includes(ch);
    if (!isOpen) {
      out += ch;
      i++;
      continue;
    }
    let j = i + 1;
    while (j < text.length && !QUOTE_CLOSES.includes(text[j])) j++;
    const inner = text.slice(i + 1, j);
    const closer = j < text.length ? text[j] : '';
    if (inner && isShoutingRun(inner) && !/^\s*\[shouting\]/i.test(inner)) {
      out += ch + '[shouting] ' + denormaliseShouting(inner) + closer;
    } else {
      out += ch + inner + closer;
    }
    i = j < text.length ? j + 1 : j;
  }
  return out;
}

/* Convert markdown-style emphasis (`*foo*`, `_foo_`) to `[emphatic] foo`.
   - Skips `**bold**` and `__bold__` runs by treating them as a single
     emphasis (still `[emphatic]`, no separate tag).
   - Ignores stray asterisks/underscores without a closing partner.
   - Leaves bracketed tags alone if already present (idempotent). */
export function tagMarkdownEmphasis(text: string): string {
  // Order matters: handle **bold** and __bold__ first so the single-char
  // pass below doesn't half-consume them.
  let out = text.replace(/\*\*([^*\n]+?)\*\*/g, (_m, body: string) =>
    body.trim() ? `[emphatic] ${body}` : _m
  );
  out = out.replace(/__([^_\n]+?)__/g, (_m, body: string) =>
    body.trim() ? `[emphatic] ${body}` : _m
  );
  out = out.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, (_m, lead: string, body: string) =>
    body.trim() ? `${lead}[emphatic] ${body}` : _m
  );
  out = out.replace(/(^|[^_\w])_([^_\n]+?)_(?!_)/g, (_m, lead: string, body: string) =>
    body.trim() ? `${lead}[emphatic] ${body}` : _m
  );
  return out;
}

/* Convert HTML emphasis tags (`<em>`, `<i>`, `<strong>`, `<b>`) to
   `[emphatic] …` inline. Run BEFORE general HTML stripping so the
   tag boundaries are still visible. */
export function tagHtmlEmphasis(html: string): string {
  return html.replace(
    /<(em|i|strong|b)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi,
    (_m, _tag, body: string) => body.trim() ? `[emphatic] ${body}` : body
  );
}
