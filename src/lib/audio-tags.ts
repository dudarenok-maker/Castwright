/* Mirrors `server/src/parsers/audio-tags.ts:AUDIO_TAGS`. Kept in sync by hand
   — the vocabulary changes rarely and a runtime fetch would be heavier than
   the duplication. */

export const AUDIO_TAGS = ['emphatic', 'shouting', 'whispers', 'laughs', 'sighs'] as const;
export type AudioTag = typeof AUDIO_TAGS[number];

const AUDIO_TAG_SET: ReadonlySet<string> = new Set(AUDIO_TAGS);

/* Match `[token]` runs where token is letters only — keeps the regex from
   eating footnote markers like `[1]` or page refs like `[p.42]`. The token
   is validated against AUDIO_TAGS at render time, so an unknown `[bracket]`
   falls through as literal text. */
const TAG_RE = /\[([a-z]+)\]/gi;

export interface TagSpan {
  kind: 'tag';
  tag: AudioTag;
  raw: string;
}
export interface TextSpan {
  kind: 'text';
  text: string;
}
export type Span = TagSpan | TextSpan;

/* Split a sentence string into a sequence of text + tag spans. Unknown
   bracket tokens stay in their surrounding text span. */
export function splitAudioTagSpans(text: string): Span[] {
  const spans: Span[] = [];
  let lastEnd = 0;
  for (const match of text.matchAll(TAG_RE)) {
    const token = match[1].toLowerCase();
    if (!AUDIO_TAG_SET.has(token)) continue;
    const start = match.index ?? 0;
    if (start > lastEnd) {
      spans.push({ kind: 'text', text: text.slice(lastEnd, start) });
    }
    spans.push({ kind: 'tag', tag: token as AudioTag, raw: match[0] });
    lastEnd = start + match[0].length;
  }
  if (lastEnd < text.length) {
    spans.push({ kind: 'text', text: text.slice(lastEnd) });
  }
  return spans;
}
