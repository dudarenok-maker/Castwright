import type { LanguageConventions } from './types.js';

export interface RosterEntry { id: string; name: string; aliases?: string[] }
export type NameIndex = { stems: Map<string, string>; conventions: LanguageConventions };

/** Index roster name+alias TOKENS by stem. Ambiguous stems (two characters
    sharing a stem) are dropped — a match must be unique to anchor. */
export function buildNameIndex(roster: RosterEntry[], conventions: LanguageConventions): NameIndex {
  const stems = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const c of roster) {
    if (c.id === 'narrator') continue;
    const tokens = [c.name, ...(c.aliases ?? [])].flatMap((n) => String(n).split(/[\s-]+/u));
    for (const tok of tokens) {
      const stem = conventions.nameStemmer(tok.toLowerCase());
      if (stem.length < conventions.minStemLength) continue;
      const prev = stems.get(stem);
      if (prev && prev !== c.id) ambiguous.add(stem);
      else stems.set(stem, c.id);
    }
  }
  for (const s of ambiguous) stems.delete(s);
  return { stems, conventions };
}

/** First unique roster match among the text's word tokens, or null. */
export function findRosterName(text: string, index: NameIndex): string | null {
  for (const tok of text.toLowerCase().split(/[^\p{L}]+/u)) {
    if (!tok) continue;
    const stem = index.conventions.nameStemmer(tok);
    if (stem.length < index.conventions.minStemLength) continue;
    const id = index.stems.get(stem);
    if (id) return id;
  }
  return null;
}
