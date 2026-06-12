#!/usr/bin/env node
/* KotLC → Coalfall/Hollow Tide scrub codemod (plan 2026-06-12-keefe-scrub).
   UNAMBIGUOUS map only — common English/code words (Exile/Unlocked/Legacy/
   Flashback/Foster-the-verb) are EXCLUDED and handled by the reviewed manual
   passes. `_`/`-`-aware boundaries (so slug compounds like kotlc__everblaze and
   mock-book-stellarlune are caught — and so is the gate grep); case-preserving;
   slug-aware (lowercase identifier next to `_`/`-` → kebab); manuscript paths
   first so "Keefe" inside the path isn't pre-renamed.
   NOTE: Keefe→Marlow and Tam(Song)→Pell — "Tam" is itself a KotLC name, so it
   cannot be a target. Exports scrubText(s); `--write <files...>` rewrites in place. */
import { readFileSync, writeFileSync } from 'node:fs';

/** Literal (non-boundary) replacements, applied BEFORE the name map. */
const LITERALS = [
  ['C:\\Users\\dudar\\Downloads\\Bonus Keefe Story.txt',
    'server/src/__fixtures__/the-coalfall-commission.md'],
  ['~/Downloads/Bonus Keefe Story.txt',
    'server/src/__fixtures__/the-coalfall-commission.md'],
  ['Bonus Keefe Story', 'the Coalfall Commission'],
  // Series acronym (unambiguous) — literal so it isn't case-mangled.
  ['KOTLC', 'the Hollow Tide'],
  ['KotLC', 'the Hollow Tide'],
  ['kotlc', 'the Hollow Tide'],
];

/** UNAMBIGUOUS character + book/series map. Multi-word matched longest-first. */
const MAP = [
  // multi-word (titles keep the rank, swap the surname)
  ['Sophie Foster', 'Wren Sparrow'],
  ['Keefe Sencen', 'Marlow Halden'],
  ['Tam Song', 'Pell Marsh'],
  ['Lord Hunkyhair', 'Sir Singe'],
  ['Lord Cassius', 'Lord Vane'],
  ['Lady Galvin', 'Lady Wick'],
  ['Lady Alexine', 'Lady Thorne'],
  ['Dame Alina', 'Dame Linnet'],
  ['Councillor Alina', 'Councillor Linnet'],
  ['Councillor Terik', 'Councillor Brask'],
  ['Councillor Emery', 'Councillor Reld'],
  ['Keeper of the Lost Cities', 'The Hollow Tide'],
  // single-token characters
  ['Sophie', 'Wren'],
  ['Keefe', 'Marlow'],
  ['Sencen', 'Halden'],
  ['Tam', 'Pell'],
  ['Elwin', 'Oduvan'],
  ['Fitz', 'Brann'],
  ['Biana', 'Maerin'],
  ['Dex', 'Hart'],
  ['Sandor', 'Garrow'],
  ['Prentice', 'Lessom'],
  ['Forkle', 'Casper'],
  ['Alina', 'Linnet'],
  ['Cassius', 'Vane'],
  ['Grizel', 'Sela'],
  ['Maruca', 'Berrin'],
  ['Marella', 'Edda'],
  ['Grady', 'Corvin'],
  ['Edaline', 'Hespa'],
  ['Brant', 'Bram'],
  ['Terik', 'Brask'],
  ['Emery', 'Reld'],
  ['Alexine', 'Thorne'],
  ['Galvin', 'Wick'],
  ['Hunkyhair', 'Singe'],
  // long-tail minor characters
  ['Sweeney', 'Marrow'],
  ['Bronte', 'Castor'],
  ['Kenric', 'Aldous'],
  ['Gisela', 'Renna'],
  ['Alden', 'Maelor'],
  ['Vespera', 'Wraythe'],
  ['Flori', 'Wisp'],
  ['Blur', 'Haze'],
  ['Trix', 'Quill'],
  ['Vika', 'Senna'],
  // NOTE: Blur/Ro/Bo are KotLC chars but ALSO common words (the `blur` DOM
  // event, `ro`/`bo` abbreviations) — context-only, handled by a manual pass,
  // NEVER blanket-renamed.
  // unambiguous books
  ['Stellarlune', 'The Drowning Bell'],
  ['Everblaze', 'The Tidewatcher’s Oath'], // curly ’ — safe in single-quoted JS strings
  ['Neverseen', 'Saltgrave'],
];

const kebab = (s) => s.toLowerCase().replace(/['’']/g, '').replace(/\s+/g, '-');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Expand with kebab patterns for multi-word names (single-token slugs handled
// by the hyphen/underscore context check in the replacer).
const PATTERNS = [];
for (const [from, to] of MAP) {
  PATTERNS.push([from, to, false]);
  if (from.includes(' ')) PATTERNS.push([kebab(from), kebab(to), true]);
}
PATTERNS.sort((a, b) => b[0].length - a[0].length);

function applyCase(match, repl) {
  if (match === match.toUpperCase() && match !== match.toLowerCase())
    return repl.toUpperCase();
  if (match === match.toLowerCase()) return repl.toLowerCase();
  return repl; // canonical (Title/Mixed)
}

export function scrubText(input) {
  let out = input;
  for (const [from, to] of LITERALS) out = out.split(from).join(to);
  for (const [from, to, isKebab] of PATTERNS) {
    // Boundaries treat `_` and `-` as separators (so slug compounds are caught).
    const re = new RegExp(`(?<![A-Za-z0-9])${escapeRe(from)}(?![A-Za-z0-9])`, 'gi');
    out = out.replace(re, (m, offset, str) => {
      const before = str[offset - 1] || '';
      const after = str[offset + m.length] || '';
      // Slug (lowercase-kebab) only for real identifiers: an explicit kebab
      // pattern, OR a hyphen/underscore-adjacent match that is itself lowercase.
      // A Capitalised match next to a hyphen is prose (e.g. "Keefe-as-Lady-X").
      const slug =
        isKebab ||
        ((/[-_]/.test(before) || /[-_]/.test(after)) && m === m.toLowerCase());
      return slug ? kebab(to) : applyCase(m, to);
    });
  }
  // camelCase / PascalCase prefixes in identifiers (test var names):
  // sophieFoster → wrenFoster, keefeRow → marlowRow, BianaCall → MaerinCall.
  // Single-token names only; the trailing word (Foster/Row/…) is left as-is.
  // The following char MUST be a genuine uppercase A-Z (the case-INSENSITIVE
  // `gi` flag would make `(?=[A-Z])` match any letter — turning `dexter` into
  // `hartter` and `tamper` into `pellper`). So flex only the first letter via
  // an explicit alternation and keep the regex case-SENSITIVE.
  for (const [from, to] of MAP) {
    if (from.includes(' ')) continue;
    const single = to.replace(/[^A-Za-z]/g, ''); // single-word owned target
    const head = from[0];
    const tail = from.slice(1);
    const re = new RegExp(
      `(?<![A-Za-z0-9])[${head.toUpperCase()}${head.toLowerCase()}]${escapeRe(tail)}(?=[A-Z])`,
      'g');
    out = out.replace(re, (m) =>
      m[0] === m[0].toLowerCase() ? single.toLowerCase() : single);
  }
  return out;
}

// --- CLI: --write <files...> ------------------------------------------------
const args = process.argv.slice(2);
if (args[0] === '--write') {
  for (const file of args.slice(1)) {
    const before = readFileSync(file, 'utf8');
    const after = scrubText(before);
    if (after !== before) {
      writeFileSync(file, after);
      console.log(`scrubbed ${file}`);
    }
  }
}
