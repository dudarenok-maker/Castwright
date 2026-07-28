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

// ops-44 (issue #1913) added two edge-case behaviours on top of the above: a
// row heading that looks row-shaped but isn't a strict `<Letter><N>` (e.g. a
// sub-lettered `### A19b`) is now rejected with a specific error rather than
// silently uncounted, and both heading scans below are fence-aware so an
// example `##`/`###` line inside a fenced code block can't be parsed as a
// real section or row.

// Blanks the contents of fenced code blocks (``` or ~~~) so neither the
// section split nor the row-heading scan below can mistake an example
// heading inside a fence for a real one. Toggling is per-delimiter — a line
// only closes a fence when it starts with the SAME delimiter that opened it,
// so a `~~~` line inside a ```-fenced block is just content, not a closer.
//
// Also reports whether a fence was left open at EOF, and the (1-based) line
// it opened on — an unterminated fence blanks everything after it, which
// must be surfaced as an error rather than silently validating a truncated
// document (ops-44, issue #1913 review finding: this previously made a
// stray fence line make the rest of the register invisible to every check
// below, reporting "no errors" over a truncated read).
//
// Residual limitation, deliberately not fixed here: two *balanced* stray
// fences bracketing a real row still hide that row without leaving anything
// open at EOF, so this check can't catch it — and the contiguity check (4)
// only surfaces it when the hidden row isn't the group's highest-numbered
// one (a hidden top row just looks like a smaller-but-still-contiguous
// group).
function stripFences(text) {
  const lines = text.split('\n');
  let openFence = null;
  let openFenceLine = null;
  const stripped = lines
    .map((line, i) => {
      const trimmed = line.trimStart();
      if (openFence) {
        if (trimmed.startsWith(openFence)) {
          openFence = null;
          openFenceLine = null;
        }
        return '';
      }
      if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
        openFence = trimmed.startsWith('```') ? '```' : '~~~';
        openFenceLine = i + 1;
        return '';
      }
      return line;
    })
    .join('\n');
  return { text: stripped, unterminatedFenceLine: openFenceLine };
}

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

// Parses the "At a glance" table body. Any `|...|` line is a candidate row —
// found first via a generic line match, then split cell-by-cell on `|`. A
// candidate only counts as a *group* row when its first cell is a bolded
// single letter (`**A**`); the `—` used for the Blocked/Unconfirmed rows,
// the header row, and the separator row (`---`) never match that and are
// skipped, without special-casing any of them. A group row is only valid
// when it has exactly three cells and the last is a bare integer — a group
// row that fails that (e.g. an extra column) is reported separately via
// `malformedLetters` rather than silently dropped, so it doesn't masquerade
// as "missing from the table" downstream.
function parseGlanceTable(sectionBody) {
  const groups = new Map();
  const duplicateLetters = new Set();
  const malformedLetters = [];
  const lineRegex = /^\|(.*)\|\s*$/gm;
  for (const match of sectionBody.matchAll(lineRegex)) {
    const cells = match[1].split('|').map((c) => c.trim());
    const letterMatch = cells[0].match(/^\*\*([A-Z])\*\*$/);
    if (!letterMatch) continue;
    const letter = letterMatch[1];
    const lastCell = cells[cells.length - 1];
    if (cells.length !== 3 || !/^\d+$/.test(lastCell)) {
      malformedLetters.push(letter);
      continue;
    }
    if (groups.has(letter)) duplicateLetters.add(letter);
    groups.set(letter, Number(lastCell));
  }
  const totalMatch = sectionBody.match(/\*\*(\d+)\s+owed\.\*\*/);
  const total = totalMatch ? Number(totalMatch[1]) : null;
  return { groups, total, duplicateLetters, malformedLetters };
}

// For each `## Group <Letter> ...` section, collects the row numbers found
// in its `### <Letter><N> · ...` headings. The section-title match only
// requires `Group <Letter>` followed by a word boundary — the separator
// after the letter (em dash, en dash, hyphen, or nothing) carries no
// information, so it isn't part of the match, mirroring the row-heading
// match below, which likewise doesn't require the literal `·` separator.
function parseBodyGroups(sections) {
  const groups = new Map();
  const duplicateLetters = new Set();
  const invalidRowHeadings = [];
  for (const section of sections) {
    const titleMatch = section.title.match(/^Group ([A-Z])\b/);
    if (!titleMatch) continue;
    const letter = titleMatch[1];
    if (groups.has(letter)) duplicateLetters.add(letter);
    // A row candidate is a `### ` heading whose text starts with this
    // section's own letter followed by a digit — anything else (e.g. a
    // `### Notes` subheading) isn't row-shaped and is never even looked at,
    // so group sections may legitimately gain non-row subheadings. A
    // candidate then either parses as a strict `<Letter><N>` (whitespace or
    // end-of-string right after the digits) or doesn't — e.g. a sub-lettered
    // `A19b`, or dotted sub-numbering like `A2.1` (`\b` alone would accept
    // both: a non-word character, including `.`, `-`, `(`, `/`, `'`, `+`,
    // satisfies a word boundary just as well as whitespace does) — and is
    // collected in `invalidRowHeadings` instead of being silently dropped.
    // `[^\r\n]*` (not `[^\n]*`) so a CRLF line ending doesn't leave a raw
    // `\r` inside the captured heading text. The trailing `\r?` (outside the
    // capture group, so it isn't included in `headingText`) absorbs a CRLF
    // line's `\r` before `$` — `$` in multiline mode only matches directly
    // before `\n`, so without it a CRLF line would fail to match at all.
    const candidateRegex = new RegExp(`^### (${letter}\\d[^\\r\\n]*)\\r?$`, 'gm');
    const rowRegex = new RegExp(`^${letter}(\\d+)(?=\\s|$)`);
    const numbers = [];
    for (const match of section.body.matchAll(candidateRegex)) {
      const headingText = match[1];
      const rowMatch = headingText.match(rowRegex);
      if (rowMatch) {
        numbers.push(Number(rowMatch[1]));
      } else {
        invalidRowHeadings.push({ letter, headingText });
      }
    }
    groups.set(letter, numbers);
  }
  return { groups, duplicateLetters, invalidRowHeadings };
}

// Formats a group's found row numbers for an error message: a single row is
// just "E1"; "E1–E7" when contiguous from 1 with more than one row (the
// common case); otherwise a plain list — a gap or duplicate is already named
// explicitly by the contiguity check below.
function formatRowList(letter, numbers) {
  if (numbers.length === 0) return 'no rows';
  const sorted = [...numbers].sort((a, b) => a - b);
  if (sorted.length === 1) return `${letter}${sorted[0]}`;
  const isContiguousFromOne =
    new Set(sorted).size === sorted.length && sorted.every((n, i) => n === i + 1);
  if (isContiguousFromOne) return `${letter}${sorted[0]}–${letter}${sorted[sorted.length - 1]}`;
  return sorted.map((n) => `${letter}${n}`).join(', ');
}

// Runs all checks and returns a list of human-readable error strings — empty
// when the register is internally coherent.
export function checkRegister(text) {
  const { text: fenceStrippedText, unterminatedFenceLine } = stripFences(text);
  const sections = splitSections(fenceStrippedText);

  // An unterminated fence blanks everything after it (stripFences treats an
  // open fence's remaining lines as still-inside-the-fence content), so
  // every check below would silently validate a truncated document. Report
  // it up front and bail before any other check can run against that
  // truncated read — a partial check here would just produce more wrong
  // numbers on top of the missing-rows problem itself.
  if (unterminatedFenceLine !== null) {
    return [
      `Unterminated fenced code block opened at line ${unterminatedFenceLine} — everything after it was ignored.`,
    ];
  }

  const glanceSection = sections.find((s) => s.title === 'At a glance');
  if (!glanceSection) {
    return ['No "## At a glance" section found — cannot check the register.'];
  }

  const {
    groups: tableGroups,
    total,
    duplicateLetters: duplicateTableLetters,
    malformedLetters,
  } = parseGlanceTable(glanceSection.body);
  const {
    groups: bodyGroups,
    duplicateLetters: duplicateBodyLetters,
    invalidRowHeadings,
  } = parseBodyGroups(sections);
  const tableLetters = new Set(tableGroups.keys());
  const bodyLetters = new Set(bodyGroups.keys());
  const malformedLetterSet = new Set(malformedLetters);
  // Mirrors malformedLetterSet: a letter with an invalid row heading (e.g.
  // `### A2a`/`### A2b` from splitting a row instead of annotating its
  // title) already gets the rejection message above — suppressing checks 1
  // and 4 for it avoids also reporting a count/contiguity mismatch that's
  // just an artifact of the same rejected heading (ops-44, issue #1913
  // review finding).
  const invalidRowHeadingLetterSet = new Set(invalidRowHeadings.map((r) => r.letter));
  const errors = [];

  // Malformed glance-table rows (wrong cell count, or a non-integer last
  // cell) are reported on their own — see parseGlanceTable's comment for why
  // this must run before, and suppress, the "missing from the table" check.
  for (const letter of malformedLetterSet) {
    errors.push(
      `The glance-table row for Group ${letter} could not be parsed — expected exactly three cells, the last a bare integer.`,
    );
  }

  // Sub-lettered row headings (e.g. `### A19b`) are the body-side mirror of
  // the malformed-table-row check above — rejected outright rather than
  // silently uncounted. The register's own convention for a row covering
  // more than one debt is to annotate the row's title, not sub-letter it
  // (ops-44, issue #1913).
  for (const { letter, headingText } of invalidRowHeadings) {
    errors.push(
      `Row heading "### ${headingText}" is not a valid row number. Rows are numbered contiguously (${letter}1, ${letter}2, …) — for a row covering more than one debt, annotate its title instead of sub-lettering.`,
    );
  }

  // Duplicate group letters: Map.set semantics mean a repeated body section
  // or table row would otherwise silently overwrite the earlier one.
  for (const letter of duplicateTableLetters) {
    errors.push(
      `Group ${letter} appears more than once in the "At a glance" table. Remove the duplicate row.`,
    );
  }
  for (const letter of duplicateBodyLetters) {
    errors.push(
      `Group ${letter} appears more than once in the body ("## Group ${letter} — ..." section is duplicated). Remove the duplicate section.`,
    );
  }

  // Check 3: every group in the table has a body section, and vice versa.
  // A letter already reported as malformed above is skipped here — it never
  // made it into tableLetters, so reporting it as "missing" too would be
  // misleading rather than additive.
  for (const letter of tableLetters) {
    if (!bodyLetters.has(letter)) {
      errors.push(
        `Group ${letter} appears in the "At a glance" table but has no "## Group ${letter} — ..." section in the body. Add the section or remove the table row.`,
      );
    }
  }
  for (const letter of bodyLetters) {
    if (!tableLetters.has(letter) && !malformedLetterSet.has(letter)) {
      errors.push(
        `Body has a "## Group ${letter} — ..." section but Group ${letter} is missing from the "At a glance" table. Add the table row or remove the section.`,
      );
    }
  }

  // Check 1: per-group counts (only for groups present on both sides —
  // a group missing from one side is already reported by check 3 above).
  // A letter with an invalid row heading is skipped — see
  // invalidRowHeadingLetterSet above.
  for (const letter of tableLetters) {
    if (!bodyLetters.has(letter)) continue;
    if (invalidRowHeadingLetterSet.has(letter)) continue;
    const tableCount = tableGroups.get(letter);
    const bodyNumbers = bodyGroups.get(letter);
    if (tableCount !== bodyNumbers.length) {
      const rowWord = bodyNumbers.length === 1 ? 'row' : 'rows';
      errors.push(
        `Group ${letter}: glance table says ${tableCount}, body has ${bodyNumbers.length} ${rowWord} (${formatRowList(letter, bodyNumbers)}). Update the table or the body.`,
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
  // duplicates. A letter with an invalid row heading is skipped — see
  // invalidRowHeadingLetterSet above.
  for (const [letter, numbers] of bodyGroups) {
    if (numbers.length === 0) continue;
    if (invalidRowHeadingLetterSet.has(letter)) continue;
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
  let text;
  try {
    text = readFileSync(registerPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(
        'Register not found at docs/testing/onbox-acceptance-register.md — if it moved, update scripts/check-onbox-register.mjs and .github/workflows/onbox-register-check.yml',
      );
      process.exit(1);
    }
    throw err;
  }
  const errors = checkRegister(text);
  if (errors.length > 0) {
    console.error('docs/testing/onbox-acceptance-register.md is not internally consistent:\n');
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }
  process.exit(0);
}
