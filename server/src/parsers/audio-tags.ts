/* Shared audio-tag vocabulary + parser-side detectors. Inline bracketed tags
   like `[whispers]` ride along inside `sentence.text` from analysis through to
   the TTS provider. This file is the single source of truth for the parser
   layer; `src/lib/audio-tags.ts` mirrors AUDIO_TAGS for the UI. */

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

/* Dialogue-wrapping quotes across English + Latin-script + Cyrillic books.
   A monolingual manuscript contains only its own pair, so the union is safe.
   Opens: “ (straight) “ (smart) « (ES/FR/RU guillemet) „ (DE low-9).
   Closes: “ (straight) “ (smart) » (guillemet) “ (DE high-6 = also EN open;
   safe for monolingual — the scanner closes on the first closer after an open). */
const QUOTE_OPENS = '"“«„';
const QUOTE_CLOSES = '"”»“';

/* Already-tagged-at-the-start check. Lets every detector be idempotent and
   keeps later detectors from stacking a second tag onto something an
   earlier detector already labelled (`[shouting] HELP!` shouldn't also
   pick up `[excited]`). */
const LEADING_TAG_RE = /^\s*\[[a-z]+\]/i;

/* A run is "all caps" if it has at least 2 consecutive uppercase letters
   and either:
   - ≥ 4 letters total (catches multi-word shouts: "HELP ME!", "GET OUT!"), or
   - ≥ 2 letters total AND contains a `!` (catches short shouts: "NO!", "GO!").
   Without the `!` guard, two-letter all-caps words like "OK" or initialisms
   like "AC" would false-trigger. */
function isShoutingRun(s: string): boolean {
  const letters = s.replace(/[^\p{L}]/gu, '');
  if (letters.length < 2) return false;
  if (letters !== letters.toUpperCase()) return false;
  if (!/\p{Lu}{2,}/u.test(s)) return false;
  if (letters.length >= 4) return true;
  return s.includes('!');
}

/* Title-case a shouted run so the TTS engine reads it as words, not letters.
   Preserves punctuation and whitespace; only lowercases run-internal letters
   after the first letter of each word. */
function denormaliseShouting(s: string): string {
  return s.replace(/(\p{Lu})([\p{Lu}']+)/gu, (_m, head, tail) => head + tail.toLowerCase());
}

/* Walk a string and call `transform(inner)` for each quote span. The
   transform returns the (possibly rewritten) inner contents; everything
   between quotes — and the quote characters themselves — is preserved
   verbatim. Used by all three quote-aware detectors so they share the
   same scanner behaviour (unterminated quotes, smart vs straight quotes,
   nested punctuation). */
function rewriteQuoteSpans(text: string, transform: (inner: string) => string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (!QUOTE_OPENS.includes(ch)) {
      out += ch;
      i++;
      continue;
    }
    let j = i + 1;
    while (j < text.length && !QUOTE_CLOSES.includes(text[j])) j++;
    const inner = text.slice(i + 1, j);
    const closer = j < text.length ? text[j] : '';
    out += ch + (inner ? transform(inner) : inner) + closer;
    i = j < text.length ? j + 1 : j;
  }
  return out;
}

/* Scan a string for dialogue spans (text between matched quote characters)
   that are entirely uppercase, and prepend `[shouting]` inside the quote.
   The transform is idempotent — a quote already starting with any audio
   tag is left alone. Returns the rewritten string. */
export function tagShoutingDialog(text: string): string {
  return rewriteQuoteSpans(text, (inner) => {
    if (LEADING_TAG_RE.test(inner)) return inner;
    if (!isShoutingRun(inner)) return inner;
    return '[shouting] ' + denormaliseShouting(inner);
  });
}

/* Tag quoted dialog with `[excited]` when it contains one or more `!`
   characters. Skips lines already tagged (idempotent) and skips lines
   that are shouting (precedence: shouting > excited — a full-caps shout
   wins over a generic exclamation cue). */
export function tagExcitedDialog(text: string): string {
  return rewriteQuoteSpans(text, (inner) => {
    if (LEADING_TAG_RE.test(inner)) return inner;
    if (!inner.includes('!')) return inner;
    if (isShoutingRun(inner)) return inner;
    return '[excited] ' + inner;
  });
}

/* Tag quoted dialog with `[hesitant]` when it starts or ends with an
   ellipsis (Unicode `…` or 2+ consecutive dots). Skips lines already
   tagged. Excitement takes precedence — a line with both `!` and `…`
   stays excited, not hesitant. */
const HESITATION_LEADING_RE = /^\s*(?:…|\.{2,})/;
const HESITATION_TRAILING_RE = /(?:…|\.{2,})\s*["”»“]?\s*$/;

export function tagHesitantDialog(text: string): string {
  return rewriteQuoteSpans(text, (inner) => {
    if (LEADING_TAG_RE.test(inner)) return inner;
    if (!HESITATION_LEADING_RE.test(inner) && !HESITATION_TRAILING_RE.test(inner)) return inner;
    return '[hesitant] ' + inner;
  });
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
    body.trim() ? `[emphatic] ${body}` : _m,
  );
  out = out.replace(/__([^_\n]+?)__/g, (_m, body: string) =>
    body.trim() ? `[emphatic] ${body}` : _m,
  );
  out = out.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, (_m, lead: string, body: string) =>
    body.trim() ? `${lead}[emphatic] ${body}` : _m,
  );
  out = out.replace(/(^|[^_\w])_([^_\n]+?)_(?!_)/g, (_m, lead: string, body: string) =>
    body.trim() ? `${lead}[emphatic] ${body}` : _m,
  );
  return out;
}

/* Convert HTML emphasis tags (`<em>`, `<i>`, `<strong>`, `<b>`) to
   `[emphatic] …` inline. Run BEFORE general HTML stripping so the
   tag boundaries are still visible. */
export function tagHtmlEmphasis(html: string): string {
  return html.replace(/<(em|i|strong|b)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, _tag, body: string) =>
    body.trim() ? `[emphatic] ${body}` : body,
  );
}
