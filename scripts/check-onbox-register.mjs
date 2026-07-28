// Mechanical consistency check over docs/testing/onbox-acceptance-register.md
// (ops-43, issue #1907). Pure arithmetic over the file's own structure — not
// a "should this PR have added a row?" check (that shape is deferred, see
// the issue). It exists because the register's own summary drifted
// silently: on 2026-07-28 the glance table read `E = 5` against a body with
// 7 rows, and `31 owed` against a body totalling 35 — under-reporting
// outstanding debt by four rows for weeks. See the register's own header
// and CLAUDE.md Before-shipping checklist step 3.

import { readFileSync } from 'node:fs';

// Deliberately out of scope: the "Blocked" and "Unconfirmed" sections. They
// use a different structure (one uses `###` headings, the other a bullet
// list) and their rows are not part of the owed total — the glance table
// itself marks them with `—` instead of a letter, which this parser treats
// as "not a group" rather than special-casing two sections whose rows would
// buy little coverage for a lot of parser fragility.

// Splits the document into `## `-level sections: { title, body } from just
// after each `## Heading` line to just before the next one. Row headings use
// `### ` (three `#`s), so a regex requiring the space directly after exactly
// two `#`s does not also match them.
function splitSections(text) {
  const headingRegex = /^## (.+)$/gm;
  const matches = [...text.matchAll(headingRegex)];
  const sections = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    sections.push({ title: matches[i][1].trim(), body: text.slice(start, end) });
  }
  return sections;
}

// Parses the "At a glance" table body. A table row is any `| a | b | c |`
// line — matched cell-by-cell via `[^|\n]`, which (unlike `\s*`) cannot
// cross a newline, so a non-matching line (the separator row) can't bleed
// into the next one and swallow it. A row only counts when its last cell is
// a bare integer, which alone excludes the header row (`Rows`) and the
// separator row (`---`) without special-casing them. Only rows whose Group
// cell is a bolded single letter (`**A**`) count as a group; the `—` used
// for the Blocked/Unconfirmed rows is skipped, per the deliberate exclusion
// above.
function parseGlanceTable(sectionBody) {
  const groups = new Map();
  const rowRegex = /^\|([^|\n]*)\|([^|\n]*)\|([^|\n]*)\|\s*$/gm;
  for (const match of sectionBody.matchAll(rowRegex)) {
    const groupCell = match[1].trim();
    const countCell = match[3].trim();
    if (!/^\d+$/.test(countCell)) continue; // header row or separator row
    const letterMatch = groupCell.match(/^\*\*([A-Z])\*\*$/);
    if (!letterMatch) continue;
    groups.set(letterMatch[1], Number(countCell));
  }
  const totalMatch = sectionBody.match(/\*\*(\d+)\s+owed\.\*\*/);
  const total = totalMatch ? Number(totalMatch[1]) : null;
  return { groups, total };
}

// For each `## Group <Letter> — ...` section, collects the row numbers found
// in its `### <Letter><N> · ...` headings. The number-then-word-boundary
// match (rather than requiring the literal `·` separator) sidesteps writing
// a non-ASCII character into this file at all.
function parseBodyGroups(sections) {
  const groups = new Map();
  for (const section of sections) {
    const titleMatch = section.title.match(/^Group ([A-Z]) — /);
    if (!titleMatch) continue;
    const letter = titleMatch[1];
    const rowRegex = new RegExp(`^### ${letter}(\\d+)\\b`, 'gm');
    const numbers = [...section.body.matchAll(rowRegex)].map((m) => Number(m[1]));
    groups.set(letter, numbers);
  }
  return groups;
}

// Formats a group's found row numbers for an error message: "E1–E7" when
// contiguous from 1 (the common case), otherwise a plain list — a gap or
// duplicate is already named explicitly by the contiguity check below.
function formatRowList(letter, numbers) {
  if (numbers.length === 0) return 'no rows';
  const sorted = [...numbers].sort((a, b) => a - b);
  const isContiguousFromOne =
    new Set(sorted).size === sorted.length && sorted.every((n, i) => n === i + 1);
  if (isContiguousFromOne) return `${letter}${sorted[0]}–${letter}${sorted[sorted.length - 1]}`;
  return sorted.map((n) => `${letter}${n}`).join(', ');
}

// Runs all four checks and returns a list of human-readable error strings —
// empty when the register is internally coherent.
export function checkRegister(text) {
  const sections = splitSections(text);
  const glanceSection = sections.find((s) => s.title === 'At a glance');
  if (!glanceSection) {
    return ['No "## At a glance" section found — cannot check the register.'];
  }

  const { groups: tableGroups, total } = parseGlanceTable(glanceSection.body);
  const bodyGroups = parseBodyGroups(sections);
  const tableLetters = new Set(tableGroups.keys());
  const bodyLetters = new Set(bodyGroups.keys());
  const errors = [];

  // Check 3: every group in the table has a body section, and vice versa.
  for (const letter of tableLetters) {
    if (!bodyLetters.has(letter)) {
      errors.push(
        `Group ${letter} appears in the "At a glance" table but has no "## Group ${letter} — ..." section in the body. Add the section or remove the table row.`,
      );
    }
  }
  for (const letter of bodyLetters) {
    if (!tableLetters.has(letter)) {
      errors.push(
        `Body has a "## Group ${letter} — ..." section but Group ${letter} is missing from the "At a glance" table. Add the table row or remove the section.`,
      );
    }
  }

  // Check 1: per-group counts (only for groups present on both sides —
  // a group missing from one side is already reported by check 3 above).
  for (const letter of tableLetters) {
    if (!bodyLetters.has(letter)) continue;
    const tableCount = tableGroups.get(letter);
    const bodyNumbers = bodyGroups.get(letter);
    if (tableCount !== bodyNumbers.length) {
      errors.push(
        `Group ${letter}: glance table says ${tableCount}, body has ${bodyNumbers.length} rows (${formatRowList(letter, bodyNumbers)}). Update the table or the body.`,
      );
    }
  }

  // Check 2: the stated total equals the sum of the glance table's own
  // per-group counts.
  if (total === null) {
    errors.push('No "**NN owed.**" total line found in the "At a glance" section.');
  } else {
    const tableSum = [...tableGroups.values()].reduce((a, b) => a + b, 0);
    if (total !== tableSum) {
      errors.push(
        `Total says ${total} owed but the glance table's group counts sum to ${tableSum}. Update the total or the table.`,
      );
    }
  }

  // Check 4: row numbers within a group are contiguous from 1, no gaps or
  // duplicates.
  for (const [letter, numbers] of bodyGroups) {
    if (numbers.length === 0) continue;
    const sorted = [...numbers].sort((a, b) => a - b);
    const isContiguous =
      new Set(sorted).size === sorted.length && sorted.every((n, i) => n === i + 1);
    if (!isContiguous) {
      errors.push(
        `Group ${letter} row numbers are not contiguous from 1: found ${sorted.map((n) => `${letter}${n}`).join(', ')}. Fix a gap or duplicate in the ${letter} row headings.`,
      );
    }
  }

  return errors;
}

// CLI mode: `node scripts/check-onbox-register.mjs`
const invokedAsCli =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  process.argv[1].replace(/\\/g, '/').endsWith('scripts/check-onbox-register.mjs');

if (invokedAsCli) {
  const registerPath = new URL('../docs/testing/onbox-acceptance-register.md', import.meta.url);
  const text = readFileSync(registerPath, 'utf8');
  const errors = checkRegister(text);
  if (errors.length > 0) {
    console.error('docs/testing/onbox-acceptance-register.md is not internally consistent:\n');
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }
  process.exit(0);
}
