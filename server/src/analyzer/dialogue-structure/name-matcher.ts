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

/** Han/Kana script — signals CJK text with no inter-word spacing, where the
    whitespace/letter-boundary tokenizer below never splits a tag clause into
    separate words (see findRosterName's CJK branch). */
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** First unique roster match among the text's word tokens, or null. */
export function findRosterName(text: string, index: NameIndex): string | null {
  if (CJK_RE.test(text)) {
    // CJK has no inter-word spacing, so `と田中は言った` is one token under
    // the tokenizer below and never matches. Fall back to substring
    // containment against the indexed stems, preferring the longest match
    // (so "田中太郎" wins over "田中" when both are roster stems). Guard out
    // 1-char stems -- too short to anchor without false-positive risk.
    let bestId: string | null = null;
    let bestLen = 0;
    for (const [stem, id] of index.stems) {
      // `stem.length < 2` is UTF-16 code units, not codepoints: a lone
      // supplementary-plane Han char (CJK Ext-B+, U+20000+) is one glyph but
      // length 2, so it slips this guard. Accepted — obscure beyond-BMP names
      // are out of the contemporary zh/ja fiction scope (fs-59 W3).
      // `!CJK_RE.test(stem)` skips Latin/Cyrillic stems: in a mixed clause with
      // a stray Han glyph we enter this branch, and substring-matching a short
      // romanized stem here would be a cross-script false positive.
      if (stem.length < 2 || !CJK_RE.test(stem)) continue;
      if (stem.length > bestLen && text.includes(stem)) {
        bestId = id;
        bestLen = stem.length;
      }
    }
    return bestId;
  }
  for (const tok of text.toLowerCase().split(/[^\p{L}]+/u)) {
    if (!tok) continue;
    const stem = index.conventions.nameStemmer(tok);
    if (stem.length < index.conventions.minStemLength) continue;
    const id = index.stems.get(stem);
    if (id) return id;
  }
  return null;
}

/** Lowercased word tokens with their start offsets in `text`. */
function tokenizeWithOffsets(text: string): Array<{ tok: string; start: number }> {
  const out: Array<{ tok: string; start: number }> = [];
  const re = /\p{L}+/gu;
  const lower = text.toLowerCase();
  for (let m = re.exec(lower); m; m = re.exec(lower)) out.push({ tok: m[0], start: m.index });
  return out;
}

/** A token is a speech/beat verb when a convention stem is its PREFIX (stems are
    word-initial). Prefix, not substring — `essay`.startsWith('say') is false.
    Known limitation: a roster NAME sharing a verb-stem prefix (`Addison`⊃`add`,
    `Rita`⊃`rit`) counts as both a verb and a name; acceptable — such a name in a
    tag clause is rare, and the eval no-regression gate backstops it. */
function isVerbToken(tok: string, index: NameIndex): boolean {
  const { speechVerbStems, beatVerbStems } = index.conventions;
  return [...speechVerbStems, ...beatVerbStems].some((s) => tok.startsWith(s));
}

function rosterIdOf(tok: string, index: NameIndex): string | null {
  const stem = index.conventions.nameStemmer(tok);
  if (stem.length < index.conventions.minStemLength) return null;
  return index.stems.get(stem) ?? null;
}

/** A subject pronoun (per the language's `pronouns` regexes) — used to detect
    that an after-verb name is NOT the inverted subject (`сказал он Валери`,
    `sagte er zu X`, `dit-il à X`). The regexes want boundary context, so test
    the token wrapped in spaces. */
function isPronounToken(tok: string, index: NameIndex): boolean {
  const p = index.conventions.pronouns;
  const w = ` ${tok} `;
  return [p.firstPerson, p.male, p.female].some((re) => re != null && re.test(w));
}

/** The subject-positioned roster name of a tag clause, or null when the only
    roster match is an addressee (after an addressee preposition or the subject
    pronoun) or a bystander (after a clause conjunction). Language-general:
    keyed on per-language markers + the shared pronouns. Non-CJK opt-in path. */
export function findSubjectName(text: string, index: NameIndex): { id: string; tokenStart: number } | null {
  const toks = tokenizeWithOffsets(text);
  const nameHits = toks
    .map((t) => ({ start: t.start, id: rosterIdOf(t.tok, index) }))
    .filter((t): t is { start: number; id: string } => t.id !== null);
  if (nameHits.length === 0) return null;

  const verbIdx = toks.findIndex((t) => isVerbToken(t.tok, index));
  if (verbIdx < 0) return { id: nameHits[0].id, tokenStart: nameHits[0].start }; // no verb → legacy first-match parity
  const verbStart = toks[verbIdx].start;

  const before = nameHits.filter((n) => n.start < verbStart);
  if (before.length) {
    const nearest = before[before.length - 1]; // token order → last before the verb
    return { id: nearest.id, tokenStart: nearest.start };
  }

  const cand = nameHits.find((n) => n.start > verbStart);
  if (!cand) return null;
  const between = toks.filter((t) => t.start > verbStart && t.start < cand.start);
  const preps = new Set(index.conventions.addresseePrepositions ?? []);
  const conjs = new Set(index.conventions.tagClauseConjunctions ?? []);
  // addressee (preposition), bystander (conjunction), OR a subject pronoun between
  // the verb and the name (caseless-dative addressee) → the name is not the subject.
  if (between.some((t) => preps.has(t.tok) || conjs.has(t.tok) || isPronounToken(t.tok, index))) return null;
  return { id: cand.id, tokenStart: cand.start };
}
