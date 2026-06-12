#!/usr/bin/env node
/* KotLC → Coalfall/Hollow Tide scrub codemod (plan 2026-06-12-keefe-scrub).
   Applies the UNAMBIGUOUS mapping only — common English/code words
   (Exile/Unlocked/Legacy/Flashback/Foster-the-verb) are EXCLUDED and handled by
   the reviewed manual passes. Word-boundary + case-preserving; slug-aware
   (hyphen context → kebab replacement); manuscript paths replaced first so
   "Keefe" inside the path isn't pre-renamed. Exports scrubText(s); `--write
   <files...>` rewrites files in place. */
import { readFileSync, writeFileSync } from 'node:fs';

/** Literal (non-word-boundary) replacements, applied BEFORE the name map. */
const LITERALS = [
  ['C:\\Users\\dudar\\Downloads\\Bonus Keefe Story.txt',
    'server/src/__fixtures__/the-coalfall-commission.md'],
  ['~/Downloads/Bonus Keefe Story.txt',
    'server/src/__fixtures__/the-coalfall-commission.md'],
  ['Bonus Keefe Story', 'the Coalfall Commission'],
];

/** UNAMBIGUOUS character + book/series map. Multi-word entries are matched
    longest-first automatically. NO common-word book titles here. */
const MAP = [
  // multi-word (titles keep the rank, swap the surname)
  ['Sophie Foster', 'Wren Sparrow'],
  ['Keefe Sencen', 'Tam Hollis'],
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
  ['Keefe', 'Tam'],
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
  // unambiguous books
  ['Stellarlune', 'The Drowning Bell'],
  ['Everblaze', "The Tidewatcher's Oath"],
  ['Neverseen', 'Saltgrave'],
];

const kebab = (s) =>
  s.toLowerCase().replace(/['’']/g, '').replace(/\s+/g, '-');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Expand with kebab patterns for multi-word names (single-token slugs are
// handled by the hyphen-context check in the replacer).
const PATTERNS = [];
for (const [from, to] of MAP) {
  PATTERNS.push([from, to, false]);
  if (from.includes(' ')) PATTERNS.push([kebab(from), kebab(to), true]);
}
// Longest-first so compounds win over their single tokens.
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
    const re = new RegExp(`\\b${escapeRe(from)}\\b`, 'gi');
    out = out.replace(re, (m, offset, str) => {
      const before = str[offset - 1] || '';
      const after = str[offset + m.length] || '';
      const slug = isKebab || before === '-' || after === '-';
      return slug ? kebab(to) : applyCase(m, to);
    });
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
