/* Stage-1 roster coverage guard.

   The per-chapter character-detection model (Phase 0a) occasionally drops a
   speaker from a chapter's roster even though the chapter clearly quotes them.
   A known case (2026-06-05, The Drowning Bell ch19): "Lessom" speaks 10+ times
   (`"…," Lessom repeated.`, `"Fine," Lessom agreed.`) yet never made the
   roster — so stage-2 attribution, which is constrained to roster ids, dumped
   every one of his lines on the narrator and he never entered the cast.

   The stage-1 prompt was strengthened to make a dialogue tag binding, but a
   prompt can't GUARANTEE an LLM never slips. This guard is the code-level net:

     - `validateRosterCoverage` scans a chapter's prose for `<Name> <speech-verb>`
       dialogue tags whose Name is not on the supplied roster (names + aliases),
       and reports the missing speakers.
     - `runStage1WithRosterGuard` runs the stage-1 call, validates coverage, and
       on a miss retries once, then AUTO-ADDS the still-missing speakers to the
       roster (favoring a harmless false add — folded back out later if it gets
       no lines — over a silent drop, which is the actual bug).

   False-positive bounding (a capitalised word before a speech verb is not always
   a character — `"…" the Council agreed`, sentence-initial `She said`):
     - a STOPWORD set kills pronouns / articles / common sentence openers,
     - possessives (`Wren's`) are normalised away,
     - a single-hit candidate must be QUOTE-ADJACENT (a real tag sits next to a
       `"…"`); a candidate with ≥2 tags passes without that gate,
     - `ROSTER_GUARD_IGNORE_NAMES` (comma-separated) is a per-deploy escape hatch.

   Purity: no I/O, no model calls (the stage-1 call is injected). Mirrors the
   env-override + injected-`call` shape of stage2-coverage.ts. */

import { safeId } from '../util/safe-id.js';
import { grammarFor, tagScanRegexesFor } from './tag-grammar.js';
import { normaliseBookLanguage } from '../tts/language.js';

export interface RosterCoverageThresholds {
  /** A candidate with fewer than this many tags must be quote-adjacent to count. */
  minHitsWithoutQuote: number;
  /** Window (chars) around a tag in which a `"` family quote marks it adjacent. */
  quoteProximityChars: number;
}

export const DEFAULT_ROSTER_COVERAGE_THRESHOLDS: RosterCoverageThresholds = {
  minHitsWithoutQuote: 2,
  quoteProximityChars: 60,
};

export interface MissingSpeaker {
  /** Display name as it appeared in the prose (possessive stripped). */
  name: string;
  /** Kebab id derived from the name (matches the analyzer id convention). */
  id: string;
  /** How many `<Name> <verb>` tags were seen in this chapter. */
  tagCount: number;
  /** A representative tag, for logs / change-log notes. */
  sampleTag: string;
  /** Whether any of the tags sat next to a quotation mark. */
  quoteAdjacent: boolean;
}

export interface RosterCoverageVerdict {
  ok: boolean;
  missingSpeakers: MissingSpeaker[];
  issues: string[];
}

/* Pronouns, articles, conjunctions, and common sentence-openers that are
   capitalised at sentence start and would otherwise look like `<Name> <verb>`
   ("She said", "They agreed", "Then he asked"). Lowercased. */
const STOPWORDS = new Set([
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'them',
  'us', 'who', 'whom', 'someone', 'everyone', 'anyone', 'somebody', 'everybody',
  'nobody', 'one', 'none', 'all', 'both', 'each', 'either', 'neither',
  'that', 'this', 'these', 'those', 'which', 'what', 'whoever', 'whatever',
  'the', 'a', 'an', 'and', 'but', 'or', 'so', 'then', 'yet', 'for', 'nor',
  'because', 'although', 'though', 'while', 'when', 'where', 'why', 'how', 'if',
  'as', 'at', 'in', 'on', 'to', 'of', 'with', 'by', 'from',
  'well', 'oh', 'no', 'yes', 'maybe', 'perhaps', 'finally', 'suddenly',
  'instead', 'still', 'again', 'now', 'here', 'there', 'everything',
  'something', 'nothing', 'anything', 'his', 'their', 'its', 'our', 'your',
  // generic titles / role nouns that appear capitalised before a speech verb
  // ("the Council agreed", a bare "Mentor said") but aren't character names —
  // a real titled character ("Lord Vane said") is captured by the name
  // token ("Vane"), not the title.
  'mr', 'mrs', 'ms', 'dr', 'lord', 'lady', 'sir', 'madam', 'miss', 'king',
  'queen', 'prince', 'princess', 'captain', 'professor', 'master', 'mentor',
  'council', 'father', 'mother', 'mom', 'dad', 'uncle', 'aunt',
  // collective / role / generic nouns that read as `<Noun> <verb>` ("the
  // Councillors agreed", "Coaches shouted") but are groups, not a character.
  // Plurals are also matched by the de-pluralised check in isStopword(), so the
  // singular base is enough here (councillor → councillors, coach → coaches).
  'councillor', 'coach', 'guard', 'soldier', 'teacher', 'student', 'kid',
  'boy', 'girl', 'man', 'woman', 'person', 'people', 'child', 'twin', 'other',
  'everyone', 'someone', 'crowd', 'group', 'voice', 'whisper', 'telepath',
  'empath', 'pyrokinetic', 'hydrokinetic', 'elf', 'goblin', 'ogre', 'gnome',
  'dwarf', 'troll', 'mine',
  // irregular plurals the -s/-es strip can't reach
  'elves', 'dwarves', 'men', 'women', 'children',
]);

/** A word is a stopword if it (or its de-pluralised form) is in STOPWORDS — so
    "Councillors"/"Coaches" are caught by the "councillor"/"coach" entries. */
function isStopword(key: string): boolean {
  if (STOPWORDS.has(key)) return true;
  if (key.endsWith('es') && STOPWORDS.has(key.slice(0, -2))) return true;
  if (key.endsWith('s') && STOPWORDS.has(key.slice(0, -1))) return true;
  return false;
}

function envNum(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function resolveThresholds(override?: RosterCoverageThresholds): RosterCoverageThresholds {
  if (override) return override;
  return {
    minHitsWithoutQuote: envNum('ROSTER_MIN_HITS_NO_QUOTE', DEFAULT_ROSTER_COVERAGE_THRESHOLDS.minHitsWithoutQuote),
    quoteProximityChars: envNum('ROSTER_QUOTE_PROXIMITY', DEFAULT_ROSTER_COVERAGE_THRESHOLDS.quoteProximityChars),
  };
}

/** Names the operator has explicitly told the guard to ignore (place/org names
    that keep tripping it), from `ROSTER_GUARD_IGNORE_NAMES` (comma-separated). */
function ignoredNames(): Set<string> {
  const raw = process.env.ROSTER_GUARD_IGNORE_NAMES;
  if (!raw) return new Set();
  return new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

/** Kebab-case a display name into a stable id — matches the convention in
    scripts/recover-missing-character.mjs (toKebabId) so a later real Phase 0a
    detection merges cleanly onto the same id. Delegates to the shared `safeId`
    (plan 219): byte-identical for ASCII/accented-Latin names, but a non-Latin
    name (Cyrillic) is preserved instead of collapsing to an empty id. */
export function toKebabId(name: string): string {
  return safeId(name);
}

/** Strip a trailing possessive (`Wren's` → `Wren`). */
function stripPossessive(name: string): string {
  return name.replace(/['’]s$/i, '');
}

/** Build the set of tokens that count as "already on the roster": each name's
    full lowercased form PLUS every whitespace-delimited token of length ≥ 2.
    Dialogue tags overwhelmingly use a single name — usually the FIRST name
    ("Wren said" for a roster entry "Wren Sparrow"), sometimes the last
    ("Casper said" for "Mr. Casper") — so indexing every token (not just the
    last) is what keeps main cast from being mis-flagged as missing. */
function rosterTokenSet(rosterNames: Iterable<string>): Set<string> {
  const set = new Set<string>();
  for (const raw of rosterNames) {
    const n = stripPossessive((raw || '').trim()).toLowerCase();
    if (!n) continue;
    set.add(n);
    // Split on whitespace, dots, AND hyphens so a compound/disguise roster name
    // ("Marlow-as-Lady-Renna", "Mr. Casper") contributes each sub-token — a bare
    // "Renna said" / "Casper said" tag then resolves to the rostered character.
    for (const tok of n.split(/[\s.-]+/).filter((t) => t.length >= 2)) set.add(tok);
  }
  return set;
}

// Quote glyphs for the adjacency window, written as \u escapes so an editor
// can't silently flatten the curly/guillemet chars (P-1 regression guard).
// QUOTE_CHARS (en, narrow): straight " + curly open/close \u201C \u201D.
const QUOTE_CHARS = /[\u0022\u201C\u201D]/;
// QUOTE_CHARS_WIDE (es/ru/fr/de): + \u201E (German low), \u00AB \u00BB (guillemets), \u2014 \u2013 (dashes).
const QUOTE_CHARS_WIDE = /[\u0022\u201C\u201D\u201E\u00AB\u00BB\u2014\u2013]/;

/** A grammar's language sentence-opener stopwords as a Set (es/ru/fr/de). Empty
    for en (no g.stopwords) so the English path stays byte-identical — the loop
    still applies the existing isStopword() de-pluralization predicate first. */
function langStopwords(g: { stopwords?: readonly string[] }): Set<string> {
  return new Set<string>(g.stopwords ?? []);
}

/** Scan chapter prose for `<Name> <speech-verb>` tags whose Name is not on the
    roster. See the module header for the false-positive bounding. */
export function validateRosterCoverage(
  bodyText: string,
  rosterNames: Iterable<string>,
  thresholds?: RosterCoverageThresholds,
  language: string = 'en',
): RosterCoverageVerdict {
  const g = grammarFor(language);
  if (!g) return { ok: true, missingSpeakers: [], issues: [] }; // unmapped → gated
  const t = resolveThresholds(thresholds);
  const roster = rosterTokenSet(rosterNames);
  const ignore = ignoredNames();
  const langStops = langStopwords(g); // language sentence-opener stopwords (es/ru/fr/de)
  const tagRes = tagScanRegexesFor(g);
  // P-1: English keeps the historical NARROW quote set (byte-identity); es/ru/fr/de
  // use the wide set their dialogue marks require.
  const quoteChars = normaliseBookLanguage(language) === 'en' ? QUOTE_CHARS : QUOTE_CHARS_WIDE;

  const body = bodyText || '';
  interface Acc { name: string; tagCount: number; sampleTag: string; quoteAdjacent: boolean }
  const candidates = new Map<string, Acc>();
  const seenSpans = new Set<number>(); // R2-1: count each source span once

  for (const tagRe of tagRes) {
    for (let m = tagRe.exec(body); m; m = tagRe.exec(body)) {
      const nameIdx = m.index + m[0].indexOf(m[1]);
      if (seenSpans.has(nameIdx)) continue; // matched by another order already
      seenSpans.add(nameIdx);
      const rawName = stripPossessive(m[1]);
      const key = rawName.toLowerCase();
      // Disguise notation ("Marlow-as-Lady-Renna") — the underlying character is
      // already cast; the prose alias isn’t a new speaker.
      if (key.includes('-as-')) continue;
      // Contraction guard: "I’ve"/"You’ve"/"They’ll" → test the root before the
      // apostrophe against the stopword set so contracted pronouns don’t slip in.
      const root = key.split(/[‘’]/)[0];
      // English de-pluralization via isStopword (byte-identical); language
      // sentence-openers via langStops (finding J). en → langStops empty.
      if (isStopword(key) || isStopword(root) || langStops.has(key) || ignore.has(key)) continue;
      if (roster.has(key)) continue;
      const start = Math.max(0, m.index - t.quoteProximityChars);
      const end = Math.min(body.length, m.index + m[0].length + t.quoteProximityChars);
      const adjacent = quoteChars.test(body.slice(start, end));
      const prev = candidates.get(key);
      if (prev) {
        prev.tagCount += 1;
        prev.quoteAdjacent = prev.quoteAdjacent || adjacent;
      } else {
        candidates.set(key, {
          name: rawName,
          tagCount: 1,
          sampleTag: m[0].trim(),
          quoteAdjacent: adjacent,
        });
      }
    }
  }

  const missingSpeakers: MissingSpeaker[] = [];
  for (const c of candidates.values()) {
    // Bound false positives: a single-hit candidate must be quote-adjacent.
    if (c.tagCount < t.minHitsWithoutQuote && !c.quoteAdjacent) continue;
    missingSpeakers.push({
      name: c.name,
      id: toKebabId(c.name),
      tagCount: c.tagCount,
      sampleTag: c.sampleTag,
      quoteAdjacent: c.quoteAdjacent,
    });
  }
  // Most-tagged first — the most-confident misses lead.
  missingSpeakers.sort((a, b) => b.tagCount - a.tagCount);

  const issues = missingSpeakers.map(
    (s) => `Tagged speaker "${s.name}" (${s.tagCount} tag${s.tagCount === 1 ? '' : 's'}, e.g. ${s.sampleTag}) is missing from the roster.`,
  );

  return { ok: missingSpeakers.length === 0, missingSpeakers, issues };
}

/* ── Attribution coverage (#529) ─────────────────────────────────────────
   The roster-coverage check above answers "is every tagged speaker IN the
   roster?". It can't see the OTHER half-state: a speaker who IS in the roster
   (stage-1 added them) but whose stage-2 attribution never ran, so their
   dialogue still sits on `narrator` (0 attributed lines). After an interrupted
   re-analysis the name-only audit reports "clean" while the chapter is still
   broken. `validateAttributionCoverage` closes that gap: it resolves each
   prose dialogue tag to a ROSTERED character id and flags any rostered,
   prose-tagged speaker with 0 attributed lines in that chapter. */

export interface HalfStateSpeaker {
  /** Roster id the prose tag resolved to. */
  id: string;
  /** Display name as it appeared in the prose (possessive stripped). */
  name: string;
  /** How many `<Name> <verb>` tags resolved to this id in the chapter. */
  tagCount: number;
  /** A representative tag. */
  sampleTag: string;
  /** Whether any tag sat next to a quotation mark. */
  quoteAdjacent: boolean;
  /** Attributed lines for this id in the chapter (0 when flagged). */
  attributedLines: number;
  /** Lines on `narrator` in the chapter — context for the half-state. */
  narratorLines: number;
}

export interface AttributionCoverageVerdict {
  ok: boolean;
  halfStateSpeakers: HalfStateSpeaker[];
  issues: string[];
}

/** Map each roster name token → character id (first-wins on collision). Mirrors
    `rosterTokenSet` but keeps the id so a prose tag can resolve to the character
    whose attributed-line count we then check. */
function rosterTokenToId(
  roster: Iterable<{ id: string; name: string; aliases?: string[] }>,
): Map<string, string> {
  const map = new Map<string, string>();
  const add = (raw: string, id: string): void => {
    const n = stripPossessive((raw || '').trim()).toLowerCase();
    if (!n) return;
    if (!map.has(n)) map.set(n, id);
    for (const tok of n.split(/[\s.-]+/).filter((tk) => tk.length >= 2)) {
      if (!map.has(tok)) map.set(tok, id);
    }
  };
  for (const c of roster) {
    add(c.name, c.id);
    for (const a of c.aliases ?? []) add(a, c.id);
  }
  return map;
}

/** Flag rostered speakers who are prose-tagged in a chapter but have 0 attributed
    lines there (the interrupted-re-analysis half-state). `roster` carries id +
    name + aliases; `chapterSentences` are that chapter's attributed sentences
    (from manuscript-edits.json). `narrator` and the `unknown-*` buckets are never
    flagged — minor speakers fold into the buckets as aliases, whose ids DO carry
    lines, so they correctly pass. Same `<Name> <verb>` scan + false-positive
    bounding (stopwords, possessive strip, single-hit quote-adjacency) as
    `validateRosterCoverage`. Pure: no I/O, no model calls. */
export function validateAttributionCoverage(
  bodyText: string,
  roster: Iterable<{ id: string; name: string; aliases?: string[] }>,
  chapterSentences: Iterable<{ characterId: string }>,
  thresholds?: RosterCoverageThresholds,
  language: string = 'en',
): AttributionCoverageVerdict {
  const g = grammarFor(language);
  if (!g) return { ok: true, halfStateSpeakers: [], issues: [] }; // unmapped → gated
  const t = resolveThresholds(thresholds);
  const tokenToId = rosterTokenToId(roster);
  const ignore = ignoredNames();
  const langStops = langStopwords(g);
  const tagRes = tagScanRegexesFor(g);
  const quoteChars = normaliseBookLanguage(language) === 'en' ? QUOTE_CHARS : QUOTE_CHARS_WIDE;
  const body = bodyText || '';

  /* Attributed-line counts per character id for THIS chapter. */
  const linesById = new Map<string, number>();
  for (const s of chapterSentences) {
    linesById.set(s.characterId, (linesById.get(s.characterId) ?? 0) + 1);
  }
  const narratorLines = linesById.get('narrator') ?? 0;

  interface Acc {
    id: string;
    name: string;
    tagCount: number;
    sampleTag: string;
    quoteAdjacent: boolean;
  }
  const candidates = new Map<string, Acc>(); // keyed by character id
  const seenSpans = new Set<number>(); // R2-1

  for (const tagRe of tagRes) {
    for (let m = tagRe.exec(body); m; m = tagRe.exec(body)) {
      const nameIdx = m.index + m[0].indexOf(m[1]);
      if (seenSpans.has(nameIdx)) continue;
      seenSpans.add(nameIdx);
      const rawName = stripPossessive(m[1]);
      const key = rawName.toLowerCase();
      if (key.includes('-as-')) continue;
      const root = key.split(/[‘’]/)[0];
      if (isStopword(key) || isStopword(root) || langStops.has(key) || ignore.has(key)) continue;
      const id = tokenToId.get(key);
      if (!id) continue; // not a rostered speaker — that’s validateRosterCoverage's job
      if (id === 'narrator' || id.startsWith('unknown-')) continue; // buckets never flag
      const start = Math.max(0, m.index - t.quoteProximityChars);
      const end = Math.min(body.length, m.index + m[0].length + t.quoteProximityChars);
      const adjacent = quoteChars.test(body.slice(start, end));
      const prev = candidates.get(id);
      if (prev) {
        prev.tagCount += 1;
        prev.quoteAdjacent = prev.quoteAdjacent || adjacent;
      } else {
        candidates.set(id, {
          id,
          name: rawName,
          tagCount: 1,
          sampleTag: m[0].trim(),
          quoteAdjacent: adjacent,
        });
      }
    }
  }

  const halfStateSpeakers: HalfStateSpeaker[] = [];
  for (const c of candidates.values()) {
    // Same false-positive bound: a single-hit candidate must be quote-adjacent.
    if (c.tagCount < t.minHitsWithoutQuote && !c.quoteAdjacent) continue;
    const attributedLines = linesById.get(c.id) ?? 0;
    if (attributedLines > 0) continue; // has lines → not a half-state
    halfStateSpeakers.push({
      id: c.id,
      name: c.name,
      tagCount: c.tagCount,
      sampleTag: c.sampleTag,
      quoteAdjacent: c.quoteAdjacent,
      attributedLines,
      narratorLines,
    });
  }
  halfStateSpeakers.sort((a, b) => b.tagCount - a.tagCount);

  const issues = halfStateSpeakers.map(
    (s) =>
      `Rostered speaker "${s.name}" is prose-tagged ${s.tagCount}× (e.g. ${s.sampleTag}) but has 0 attributed lines in this chapter (narrator has ${s.narratorLines}).`,
  );

  return { ok: halfStateSpeakers.length === 0, halfStateSpeakers, issues };
}

/** Run a stage-1 detection call, validate roster coverage against the chapter
    prose, and remediate misses: retry the call up to `maxRetries`, then AUTO-ADD
    any still-missing tagged speaker via the injected `makeCharacter` factory.

    `rosterNamesFor(result)` returns the names+aliases to validate against for a
    given stage-1 result — the caller supplies the union of (this chapter's
    detected characters) and (the running roster) so a returning speaker isn't
    re-flagged. Pure except for the injected `call`. */
export async function runStage1WithRosterGuard<
  C extends { id: string; name: string },
  T extends { characters: C[] },
>(opts: {
  body: string;
  rosterNamesFor: (result: T) => Iterable<string>;
  call: () => Promise<T>;
  makeCharacter: (missing: MissingSpeaker) => C;
  maxRetries: number;
  thresholds?: RosterCoverageThresholds;
  language?: string;
  onRetry?: (attempt: number, verdict: RosterCoverageVerdict) => void;
  onAutoAdd?: (added: MissingSpeaker[]) => void;
}): Promise<{ result: T; verdict: RosterCoverageVerdict; attempts: number; autoAdded: MissingSpeaker[] }> {
  const lang = opts.language ?? 'en';
  let result = await opts.call();
  let verdict = validateRosterCoverage(opts.body, opts.rosterNamesFor(result), opts.thresholds, lang);
  let attempts = 1;
  while (!verdict.ok && attempts <= opts.maxRetries) {
    opts.onRetry?.(attempts + 1, verdict);
    const retry = await opts.call();
    const retryVerdict = validateRosterCoverage(opts.body, opts.rosterNamesFor(retry), opts.thresholds, lang);
    attempts += 1;
    // Keep the take with fewer missing speakers.
    if (retryVerdict.missingSpeakers.length < verdict.missingSpeakers.length) {
      result = retry;
      verdict = retryVerdict;
    }
    if (verdict.ok) break;
  }

  const autoAdded: MissingSpeaker[] = [];
  if (!verdict.ok) {
    const have = new Set(result.characters.map((c) => c.id));
    for (const miss of verdict.missingSpeakers) {
      if (have.has(miss.id)) continue;
      result.characters.push(opts.makeCharacter(miss));
      have.add(miss.id);
      autoAdded.push(miss);
    }
    if (autoAdded.length) opts.onAutoAdd?.(autoAdded);
  }

  return { result, verdict, attempts, autoAdded };
}

/* Per-chapter attribution-drift check — the secondary net. The book-wide
   `attributionDriftExceeded` (analysis.ts) dilutes a single damaged chapter
   below its 5% threshold (the Drowning Bell ch19 ~30 demotions vanished against a
   whole-book denominator). This flags a chapter whose demotion rate is high on
   its own. WARN-only at the call site — a narration-heavy chapter can
   legitimately demote a lot, so this informs rather than aborts. */
export function chapterDriftExceeded(
  demotedCount: number,
  chapterSentences: number,
  thresholdRatio = 0.15,
  minSentencesForCheck = 20,
): boolean {
  if (chapterSentences < minSentencesForCheck) return false;
  return demotedCount / chapterSentences > thresholdRatio;
}
