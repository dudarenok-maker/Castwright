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

// ---------------------------------------------------------------------------
// The live view (docs/testing/onbox-acceptance-register-live-view.html)
// ---------------------------------------------------------------------------
// The register has a hand-authored HTML twin published to a fixed artifact URL.
// It is not generated from the markdown, so the two drift: on 2026-07-28 the
// published page was simultaneously missing a row added in one PR and carrying
// a row that only existed on another PR's branch, and the two errors cancelled
// in the total — a plausible-looking summary strip over two wrong group counts.
// Nothing could see it, because the checks above validate the markdown against
// itself.
//
// These checks close that gap by comparing the two files. What they CANNOT see
// is the published page itself: publishing the wrong file, or forgetting to
// publish at all, leaves no trace in the repo. That half is a documented
// procedure, not a mechanical gate — see the register's "Live view" section.

// Blanks HTML comments before anything else parses the live view. Both
// directions matter and both were wrong without it (PR #2080 review round 2):
// a commented-out row was counted as a real one, and commenting out a whole
// group section — which removes it from the published page — was invisible.
// Blanking rather than deleting keeps the comment's own `<section>`/`<span>`
// text from being read while leaving the surrounding structure intact.
function stripHtmlComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

// Strips tags and collapses whitespace, so a cell's text can be compared
// regardless of the markup inside it (the C group's setup cell wraps a
// `<span lang="ru">`, and every glance-table letter is wrapped in an `<a>`).
function htmlCellText(html) {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Parses the live view's glance table into letter → count, mirroring the
// markdown's parseGlanceTable: a row only counts as a *group* row when its
// first cell is a single uppercase letter, so the `—`-prefixed Blocked and
// Unconfirmed rows and the header row are skipped without special-casing.
function parseLiveViewGlance(html) {
  const tableMatch = html.match(/<table class="glance">([\s\S]*?)<\/table>/);
  if (!tableMatch) return { groups: null, malformedLetters: [], duplicateLetters: new Set() };
  const groups = new Map();
  const malformedLetters = [];
  const duplicateLetters = new Set();
  // `<tr\b[^>]*>`, not a bare `<tr>`: a row carrying any attribute was
  // previously invisible, so an ADDED group row went unreported (round 2, #7).
  for (const rowMatch of tableMatch[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...rowMatch[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) =>
      htmlCellText(c[1]),
    );
    if (cells.length === 0) continue;
    if (!/^[A-Z]$/.test(cells[0])) continue;
    const letter = cells[0];
    const lastCell = cells[cells.length - 1];
    if (cells.length !== 3 || !/^\d+$/.test(lastCell)) {
      malformedLetters.push(letter);
      continue;
    }
    // Map.set is last-writer-wins, so a repeated letter would silently keep
    // only one of two contradicting rows — and which one it kept would depend
    // on their order. The markdown parser guards exactly this
    // (duplicateTableLetters); mirroring it here keeps the two symmetrical.
    if (groups.has(letter)) duplicateLetters.add(letter);
    groups.set(letter, Number(lastCell));
  }
  return { groups, malformedLetters, duplicateLetters };
}

// Parses the live view's group sections into letter → { headerCount, rowIds }.
// Rows are collected per SECTION rather than by their own ID letter, so a row
// filed under the wrong group is caught rather than silently landing in the
// right bucket. Sections whose `gtag` is not a single uppercase letter (the
// `BLK` and `?` sections) are skipped — the markdown's own glance table marks
// their rows with `—` and excludes them from the owed total too.
//
// The split marker matches a whole `<section>` tag whose class list CONTAINS
// `group`, wherever the class attribute sits among the others. Two rounds of
// review narrowed it to this:
//   - `<section class="group"` (round 1) missed the real file's modifier-class
//     sections (`class="group is-blocked"`, `class="group is-soft"`), folding
//     their content — and the trailing `<footer>` — into the PRECEDING group's
//     block. The `gtag` filter never saw them, a lettered row added to either
//     was attributed to the wrong group, and a cosmetic modifier class on any
//     other section made its whole row list read as "extra rows" (F2).
//   - `<section class="group[^"]*"` (round 2) fixed that but matched sibling
//     names like `class="grouping"` / `class="group-nav"`, and was still
//     positional: `<section id="blocked" class="group is-blocked">` re-opened
//     the fold SILENTLY, which is the one attribute variation that degraded
//     quietly rather than failing loudly (#4, #5).
// `(?:\s[^"]*)?` requires whitespace after `group`, so `grouping` no longer
// matches; the leading `[^>]*` makes attribute order irrelevant.
function parseLiveViewSections(html) {
  const sections = new Map();
  const duplicateLetters = new Set();
  const invalidRowIds = [];
  const blocks = html.split(/<section\b[^>]*\bclass="group(?:\s[^"]*)?"[^>]*>/).slice(1);
  for (const block of blocks) {
    const tagMatch = block.match(/<span class="gtag">([^<]*)<\/span>/);
    if (!tagMatch || !/^[A-Z]$/.test(tagMatch[1].trim())) continue;
    const letter = tagMatch[1].trim();
    const countMatch = block.match(/<span class="gcount">(\d+) rows?<\/span>/);
    const allIds = [...block.matchAll(/<span class="num">([^<]*)<\/span>/g)].map((m) =>
      m[1].trim(),
    );
    const rowIds = allIds.filter((id) => /^[A-Z]\d+$/.test(id));
    // A `num` that is neither a row ID nor the `—` used by the Blocked and
    // Unconfirmed sections is REPORTED, not dropped. Silently filtering it was
    // the inverse of the markdown side, which rejects the same convention
    // violation loudly (`### A19b` → invalidRowHeadings): a live-view row
    // numbered `A31b`, `a32` or `A&nbsp;32` used to vanish from the comparison
    // entirely, so the page carried a row the register did not and the check
    // stayed green (round 2, #1).
    for (const id of allIds) {
      if (!/^[A-Z]\d+$/.test(id) && id !== '—') invalidRowIds.push({ letter, id });
    }
    // Same last-writer-wins hazard as the glance table above: two sections
    // carrying the same `gtag` would leave only one visible, and the page
    // would render the group twice with nothing reporting it.
    if (sections.has(letter)) duplicateLetters.add(letter);
    sections.set(letter, {
      headerCount: countMatch ? Number(countMatch[1]) : null,
      rowIds,
    });
  }
  return { sections, duplicateLetters, invalidRowIds };
}

// Compares the live view against the markdown. Returns human-readable error
// strings; empty when the two agree.
//
// Every extraction failure below is an error rather than a skip. A regex that
// stops matching after a markup change would otherwise turn this whole check
// into a vacuous pass — which is the exact shape of bug it exists to catch.
export function checkLiveView(markdownText, rawLiveViewHtml) {
  const errors = [];
  const liveViewHtml = stripHtmlComments(rawLiveViewHtml);
  const { text: fenceStrippedText, unterminatedFenceLine } = stripFences(markdownText);
  // Same bail-out as checkRegister, for the same reason: an unterminated fence
  // blanks the rest of the markdown, so every comparison below would read the
  // live view against a truncated register and demand the deletion of sections
  // that are perfectly fine. checkRegister already reports the fence itself.
  if (unterminatedFenceLine !== null) {
    return [
      `Cannot check the live view: the register has an unterminated fenced code block opened at line ${unterminatedFenceLine}, so everything after it was ignored.`,
    ];
  }
  const sections = splitSections(fenceStrippedText);
  const glanceSection = sections.find((s) => s.title === 'At a glance');
  if (!glanceSection) {
    return ['No "## At a glance" section in the markdown — cannot check the live view against it.'];
  }
  const { groups: mdGroups, total: mdTotal } = parseGlanceTable(glanceSection.body);
  const { groups: mdBodyGroups } = parseBodyGroups(sections);

  // The owed total, as the summary strip states it.
  const owedMatch = liveViewHtml.match(/<div class="n owed">(\d+)<\/div>/);
  if (!owedMatch) {
    errors.push(
      'Live view: no `<div class="n owed">NN</div>` found — the summary strip\'s owed total could not be read. If the markup changed, update scripts/check-onbox-register.mjs.',
    );
  } else if (mdTotal !== null && Number(owedMatch[1]) !== mdTotal) {
    errors.push(
      `Live view says ${owedMatch[1]} owed but the register says ${mdTotal}. Update the live view's summary strip.`,
    );
  }

  // The glance table, letter by letter.
  const {
    groups: lvGroups,
    malformedLetters,
    duplicateLetters: duplicateGlanceLetters,
  } = parseLiveViewGlance(liveViewHtml);
  if (lvGroups === null) {
    errors.push(
      'Live view: no `<table class="glance">` found — the per-group counts could not be read. If the markup changed, update scripts/check-onbox-register.mjs.',
    );
  } else {
    for (const letter of duplicateGlanceLetters) {
      errors.push(
        `Live view: Group ${letter} appears more than once in the glance table. Remove the duplicate row — only one of them is being checked, and which one depends on their order.`,
      );
    }
    for (const letter of malformedLetters) {
      errors.push(
        `Live view: the glance-table row for Group ${letter} could not be parsed — expected exactly three cells, the last a bare integer.`,
      );
    }
    for (const [letter, mdCount] of mdGroups) {
      if (!lvGroups.has(letter)) {
        if (!malformedLetters.includes(letter)) {
          errors.push(`Live view: Group ${letter} is missing from the glance table.`);
        }
        continue;
      }
      if (lvGroups.get(letter) !== mdCount) {
        errors.push(
          `Live view: glance table says Group ${letter} has ${lvGroups.get(letter)} rows, the register says ${mdCount}.`,
        );
      }
    }
    for (const letter of lvGroups.keys()) {
      if (!mdGroups.has(letter)) {
        errors.push(
          `Live view: glance table has a Group ${letter} row that the register's glance table does not. Remove it or add the group to the register.`,
        );
      }
    }
  }

  // The group sections and their rows.
  const {
    sections: lvSections,
    duplicateLetters: duplicateSectionLetters,
    invalidRowIds,
  } = parseLiveViewSections(liveViewHtml);
  for (const { letter, id } of invalidRowIds) {
    errors.push(
      `Live view: Group ${letter} has a row numbered "${id}", which is not a valid row ID. Rows are ${letter}1, ${letter}2, … — for a row covering more than one debt, annotate its title instead of sub-lettering.`,
    );
  }
  if (lvSections.size === 0) {
    errors.push(
      'Live view: no `<section class="group…">` blocks with a single-letter `gtag` found — no rows could be read. If the markup changed, update scripts/check-onbox-register.mjs.',
    );
    return errors;
  }
  for (const letter of duplicateSectionLetters) {
    errors.push(
      `Live view: more than one group section carries the gtag ${letter}. The page renders that group twice — remove the duplicate section.`,
    );
  }
  for (const [letter, mdNumbers] of mdBodyGroups) {
    const section = lvSections.get(letter);
    if (!section) {
      errors.push(`Live view: no group section for Group ${letter}.`);
      continue;
    }
    if (section.headerCount === null) {
      errors.push(
        `Live view: Group ${letter}'s header has no \`<span class="gcount">N rows</span>\`.`,
      );
    } else if (section.headerCount !== mdNumbers.length) {
      errors.push(
        `Live view: Group ${letter}'s header says ${section.headerCount} rows, the register's body has ${mdNumbers.length}.`,
      );
    }
    const expected = new Set(mdNumbers.map((n) => `${letter}${n}`));
    const found = new Set(section.rowIds);
    const missing = [...expected].filter((id) => !found.has(id));
    const extra = [...found].filter((id) => !expected.has(id));
    // Both messages name the SECTION the comparison was made in. Without it a
    // row filed under the wrong group reads as two contradicting errors — "X is
    // missing" and "X is extra" — with nothing saying where it actually sits.
    if (missing.length > 0) {
      errors.push(
        `Live view's Group ${letter} section is missing ${missing.length === 1 ? 'row' : 'rows'} ${missing.join(', ')} — present in the register, absent from that section.`,
      );
    }
    if (extra.length > 0) {
      errors.push(
        `Live view's Group ${letter} section has ${extra.length === 1 ? 'row' : 'rows'} ${extra.join(', ')} that the register's Group ${letter} does not. A row published from an unmerged branch, or a row filed under the wrong group, is the usual cause.`,
      );
    }
    if (section.rowIds.length !== found.size) {
      const seen = new Set();
      const dupes = [...new Set(section.rowIds.filter((id) => seen.has(id) || !seen.add(id)))];
      errors.push(`Live view: Group ${letter} lists ${dupes.join(', ')} more than once.`);
    }
  }
  for (const letter of lvSections.keys()) {
    if (!mdBodyGroups.has(letter)) {
      errors.push(
        `Live view has a Group ${letter} section that the register's body does not. Remove it or add the section to the register.`,
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
  const REGISTER = 'docs/testing/onbox-acceptance-register.md';
  const LIVE_VIEW = 'docs/testing/onbox-acceptance-register-live-view.html';

  // A missing file is a hard failure for both, not a skip: the live view is
  // tracked precisely so it is always present, and treating its absence as
  // "nothing to check" would restore the silent-drift hole this closes.
  const read = (relPath) => {
    try {
      return readFileSync(new URL(`../${relPath}`, import.meta.url), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.error(
          `Not found: ${relPath} — if it moved, update scripts/check-onbox-register.mjs and .github/workflows/onbox-register-check.yml`,
        );
        process.exit(1);
      }
      throw err;
    }
  };

  const text = read(REGISTER);
  const liveViewHtml = read(LIVE_VIEW);

  const report = (label, errors) => {
    if (errors.length === 0) return false;
    console.error(`${label}:\n`);
    for (const error of errors) console.error(`- ${error}`);
    console.error('');
    return true;
  };

  // Both checks always run — the live-view comparison is reported even when
  // the markdown is internally inconsistent, so one PR sees both problems
  // rather than discovering the second only after fixing the first.
  const registerFailed = report(`${REGISTER} is not internally consistent`, checkRegister(text));
  const liveViewFailed = report(
    `${LIVE_VIEW} does not agree with ${REGISTER}`,
    checkLiveView(text, liveViewHtml),
  );

  process.exit(registerFailed || liveViewFailed ? 1 : 0);
}
