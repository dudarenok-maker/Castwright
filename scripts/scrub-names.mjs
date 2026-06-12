#!/usr/bin/env node
/* the Hollow Tide → Coalfall/Hollow Tide scrub codemod (plan 2026-06-12-Marlow-scrub).
   Applies the UNAMBIGUOUS mapping only — common English/code words
   (Exile/Unlocked/Legacy/Flashback/Foster-the-verb) are EXCLUDED and handled by
   the reviewed manual passes. Word-boundary + case-preserving; slug-aware
   (hyphen context → kebab replacement); manuscript paths replaced first so
   "Marlow" inside the path isn't pre-renamed. Exports scrubText(s); `--write
   <files...>` rewrites files in place. */
import { readFileSync, writeFileSync } from 'node:fs';

/** Literal (non-word-boundary) replacements, applied BEFORE the name map. */
const LITERALS = [
  ['C:\\Users\\dudar\\Downloads\\the Coalfall Commission.txt',
    'server/src/__fixtures__/the-coalfall-commission.md'],
  ['~/Downloads/the Coalfall Commission.txt',
    'server/src/__fixtures__/the-coalfall-commission.md'],
  ['the Coalfall Commission', 'the Coalfall Commission'],
];

/** UNAMBIGUOUS character + book/series map. Multi-word entries are matched
    longest-first automatically. NO common-word book titles here. */
const MAP = [
  // multi-word (titles keep the rank, swap the surname)
  ['Wren Sparrow', 'Wren Sparrow'],
  ['Marlow Halden', 'Pell Hollis'],
  ['Sir Singe', 'Sir Singe'],
  ['Lord Vane', 'Lord Vane'],
  ['Lady Wick', 'Lady Wick'],
  ['Lady Thorne', 'Lady Thorne'],
  ['Dame Linnet', 'Dame Linnet'],
  ['Councillor Linnet', 'Councillor Linnet'],
  ['Councillor Brask', 'Councillor Brask'],
  ['Councillor Reld', 'Councillor Reld'],
  ['The Hollow Tide', 'The Hollow Tide'],
  // single-token characters
  ['Wren', 'Wren'],
  ['Marlow', 'Pell'],
  ['Oduvan', 'Oduvan'],
  ['Brann', 'Brann'],
  ['Maerin', 'Maerin'],
  ['Hart', 'Hart'],
  ['Garrow', 'Garrow'],
  ['Lessom', 'Lessom'],
  ['Casper', 'Casper'],
  ['Linnet', 'Linnet'],
  ['Vane', 'Vane'],
  ['Sela', 'Sela'],
  ['Berrin', 'Berrin'],
  ['Edda', 'Edda'],
  ['Corvin', 'Corvin'],
  ['Hespa', 'Hespa'],
  ['Bram', 'Bram'],
  ['Brask', 'Brask'],
  ['Reld', 'Reld'],
  ['Thorne', 'Thorne'],
  ['Wick', 'Wick'],
  ['Singe', 'Singe'],
  // unambiguous books
  ['The Drowning Bell', 'The Drowning Bell'],
  ['The Tidewatcher's Oath', "The Tidewatcher's Oath"],
  ['Saltgrave', 'Saltgrave'],
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
