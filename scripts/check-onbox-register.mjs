// Mechanical consistency check over docs/testing/onbox-acceptance-register.md
// (ops-43, issue #1907). Pure arithmetic over the file's own structure — not
// a "should this PR have added a row?" check (that shape is deferred, see
// the issue). It exists because the register's own summary drifted
// silently: on 2026-07-28 the glance table read `E = 5` against a body with
// 7 rows, and `31 owed` against a body totalling 35 — under-reporting
// outstanding debt by four rows for weeks. See the register's own header
// and CLAUDE.md Before-shipping checklist step 3.
//
// Any tightening of `checkRegister` is retro-applied to `origin/main`'s copy of
// the register, because `resolveBaselineGroups` runs the CURRENT checker over
// the FETCHED baseline and rejects it outright on any error. A new rule
// therefore cannot land in the same PR as the data it requires: ship the data
// first, merge it, then ship the rule. Landing both at once makes every
// `--against-published` run fail with CANNOT_VERIFY_BASELINE_ERROR, which the
// register's runbook says can only be fixed from `main`.
//
// Residual limitation of checks 4a/4b (row-ID stability, #2599/#2629): 4b
// stops a new row being allocated *forward* into an ID that's already in use,
// and the allocation floor stops collision with the historical pre-stable-ID
// overflow — but neither stops an author hand-typing a **discharged** ID
// (one whose row was removed) into a new row. It sits below the group's
// next-id, and the original row is gone, so 4a's uniqueness check has
// nothing left to compare against. Closing that needs a retired-ID ledger,
// which contradicts the shipped ruling that the register tracks state, not
// history — so it stays open, deliberately.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { scrubGitEnv } from './git-env.mjs';
import { isDirectlyInvoked } from './lib/is-main-module.mjs';

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
// open at EOF, so this check can't catch it. Under the old contiguity check,
// a hidden row surfaced only when it wasn't the group's highest-numbered one
// (a hidden top row just looked like a smaller-but-still-contiguous group) —
// under check 4a's whole-document ID uniqueness, a balanced-fence-hidden row
// is invisible to EVERY check, full stop, since there is no visible row for
// its ID to collide with. This is a widening of the limitation, not a
// narrowing one, and is worth saying plainly rather than leaving the old,
// narrower caveat standing.
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
// just "E1"; a contiguous run collapses to "E1–E7" — under stable IDs that
// run no longer has to start at 1, so "E3–E5" collapses too; otherwise a
// plain, comma-joined list. A gap is not an error under stable IDs (rows are
// allocated once and never reused, so gaps are the expected shape after a
// discharge), and a duplicate ID is already named explicitly by check 4a.
function formatRowList(letter, numbers) {
  if (numbers.length === 0) return 'no rows';
  const sorted = [...numbers].sort((a, b) => a - b);
  if (sorted.length === 1) return `${letter}${sorted[0]}`;
  const isContiguous = sorted.every((n, i) => i === 0 || n === sorted[i - 1] + 1);
  if (isContiguous) return `${letter}${sorted[0]}–${letter}${sorted[sorted.length - 1]}`;
  return sorted.map((n) => `${letter}${n}`).join(', ');
}

// The allocation floor. Every group's `next-id` must be at or above this, and
// every row ID strictly below its group's own `next-id`. 101 is provably above
// all history: full git log of the register and its live view gives all-time
// high-waters of A=48, B=5, C=4, D=3, E=11, F=1, G=2, H=2, and the highest ID
// A99 is the citation checker's own nonexistent-ID sentinel, and allocation
// counts UPWARD, so a floor near 50 would eventually pass through it. Never
// lower this — if a fixture breaks
// against it, the fixture is what is wrong.
export const ALLOCATION_FLOOR = 101;

// Parses a group section's `<!-- next-id: <Letter><N> -->` allocation marker.
// Returns null when absent, which callers report as an error rather than
// treating as "no floor to enforce" — a missing marker silently disabling the
// check is the guard-evaporates-on-missing-input shape this file already
// fails closed against elsewhere.
export function parseNextIdMarker(sectionBody, letter) {
  const match = sectionBody.match(
    new RegExp(`^<!--\\s*next-id:\\s*${letter}(\\d+)\\s*-->\\s*\\r?$`, 'm'),
  );
  return match ? Number(match[1]) : null;
}

// Every `### <Letter><N>` row heading in the WHOLE document, including
// sections `parseBodyGroups` never visits (Blocked, and anything added later).
// Uniqueness is a document-wide property: #2634/#2653 were exactly a Blocked
// heading reusing a live Group E ID, which a group-scoped scan cannot see.
// Returns just the composed `id` — the only field check 4a below (or any
// other caller) actually reads; a `letter`/`number` split was dead weight.
export function parseAllRowHeadings(strippedText) {
  const found = [];
  for (const match of strippedText.matchAll(/^### ([A-Z])(\d+)(?=\s|\r?$)/gm)) {
    found.push({ id: `${match[1]}${match[2]}` });
  }
  return found;
}

// #2599/A41: per-row content hashing for `--against-published`. Row PROSE is
// not expected to be word-for-word identical between the markdown register
// and its hand-authored HTML twin — they are deliberately different
// documents that only have to agree on structure (this file's own header;
// `checkLiveView`'s 'both'-direction comment) — so hashing markdown text
// against HTML text produces a mismatch for nearly every row even in a
// healthy, nothing-wrong state (confirmed against this repo's own committed
// register + live view while building this check). The two documents that
// ARE supposed to carry byte-for-byte the same row content are the TRACKED
// `docs/testing/onbox-acceptance-register-live-view.html` and whatever is
// actually live: "the published page IS the tracked live-view.html's own
// content, wrapped in a publish skeleton" (this file's own header, on why
// `--against-published` reuses `checkLiveView` rather than a second
// comparator). So this check hashes the TRACKED copy's row content against
// the PUBLISHED SNAPSHOT's row content, both HTML, both read with the same
// extraction — not the register at all. `options.trackedLiveViewHtml` is the
// CLI's local, currently-committed copy of the live view; see the CLI layer
// for where it's read from disk.
//
// Splits on each `<details class="item">` row wrapper (the one shape the
// tracked live view and every `--against-published` snapshot both use — see
// `parseLiveViewSections`'s own header for the section-level version of this
// same split-and-scan approach), reads the row ID from its `<span
// class="num">`, and hashes only the `<div class="body">...</div>` content —
// not the `<summary>` (ID/title/risk badge), which drifting on its own is a
// cosmetic rename, not the A41 content-regression shape this exists to
// catch. A row whose ID isn't a plain `<Letter><N>` (the Blocked/Unconfirmed
// sections use `—`) is skipped, the same convention `parseLiveViewSections`
// already filters on. A block with no matching `<div class="body">...</div>`
// (an extraction failure, e.g. the markup changed) is an error rather than
// silently skipped — a silent skip would mean comparing fewer rows than the
// page carries and reporting a vacuous pass.
//
// Returns { bodies, errors: [] } on success, or { bodies, errors } when
// extraction failures occur. Errors are surface-level extraction problems
// (missing markup markers, malformed rows) — not structural issues like
// missing sections, which are handled by checkLiveView's own checks.
export function parseLiveViewRowBodies(liveViewHtml) {
  const bodies = new Map();
  const errors = [];
  const blocks = liveViewHtml.split(/<details\b[^>]*\bclass="item"[^>]*>/).slice(1);
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const block = blocks[blockIndex];
    const idMatch = block.match(/<span class="num">([^<]*)<\/span>/);
    if (!idMatch) {
      errors.push(
        `Row block ${blockIndex + 1}: could not extract row ID from <span class="num">. The markup may be missing or malformed.`,
      );
      continue;
    }
    const id = idMatch[1].trim();
    if (!/^[A-Z]\d+$/.test(id)) continue;
    const bodyMatch = block.match(/<div class="body">([\s\S]*?)<\/div>\s*<\/details>/);
    if (!bodyMatch) {
      errors.push(
        `Row ${id}: could not extract body content from <div class="body">. The markup may be missing or malformed (e.g., class attribute was modified).`,
      );
      continue;
    }
    bodies.set(id, htmlCellText(bodyMatch[1]));
  }
  return { bodies, errors };
}

function hashRowContent(plainText) {
  return createHash('sha256').update(plainText).digest('hex');
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
  // title) already gets the rejection message above — suppressing check 1
  // and 4b's per-row comparison for it avoids also reporting a count
  // mismatch or an at-or-above-next-id violation that's just an artifact of
  // the same rejected heading (ops-44, issue #1913 review finding).
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
      `Row heading "### ${headingText}" is not a valid row number. Row numbers are plain integers (${letter}1, ${letter}2, …), allocated once from the group's next-id — for a row covering more than one debt, annotate its title instead of sub-lettering.`,
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

  // Check 4a: row IDs are unique across the WHOLE document, not just within a
  // group section. Replaces the old contiguity check, which required every
  // discharge to renumber the survivors and so rotted every citation into the
  // group (#2599/#2603/#2629/#2634/#2653).
  const seenRowIds = new Map();
  for (const { id } of parseAllRowHeadings(fenceStrippedText)) {
    seenRowIds.set(id, (seenRowIds.get(id) ?? 0) + 1);
  }
  for (const [id, count] of seenRowIds) {
    if (count > 1) {
      errors.push(
        `Row ID ${id} appears more than once (${count} headings). Row IDs are allocated once and never reused — give the newer row its group's next-id instead.`,
      );
    }
  }

  // Check 4b: every row ID sits strictly below its group's allocation marker,
  // and the marker is at or above the floor. Together these keep FORWARD
  // allocation honest — an ID minted from the marker is one no row has held.
  // They do NOT stop someone hand-typing a discharged row's old ID back in:
  // that ID is below the marker, so it passes. See the residual limitation in
  // this file's header for why that is deliberate.
  for (const section of sections) {
    const titleMatch = section.title.match(/^Group ([A-Z])\b/);
    if (!titleMatch) continue;
    const letter = titleMatch[1];
    // NOTE the suppression is deliberately NOT applied to the marker-presence
    // and floor checks below — only to the per-row comparison. `:222-228`
    // suppresses checks on a letter with an invalid row heading because its
    // count and its at-or-above-next-id verdicts were artifacts of that same
    // rejected heading.
    // Whether a group carries an allocation marker is independent of every row
    // heading in it, so suppressing it here would let one `### A19b` anywhere
    // in Group A make Group A's MISSING marker unreportable — widening a
    // narrow suppression into a hole in the new check.
    const nextId = parseNextIdMarker(section.body, letter);
    if (nextId === null) {
      errors.push(
        `Group ${letter} has no "<!-- next-id: ${letter}N -->" allocation marker. Add one directly under the group heading — without it there is nothing to allocate new row IDs from.`,
      );
      continue;
    }
    if (nextId < ALLOCATION_FLOOR) {
      errors.push(
        `Group ${letter}'s next-id (${letter}${nextId}) is below the allocation floor ${letter}${ALLOCATION_FLOOR}. IDs below the floor have been used before; reusing one silently re-points every existing citation.`,
      );
    }
    if (invalidRowHeadingLetterSet.has(letter)) continue;
    for (const n of bodyGroups.get(letter) ?? []) {
      if (n >= nextId) {
        errors.push(
          `Group ${letter}: ${letter}${n} is at or above the group's next-id (${letter}${nextId}). Bump next-id past every allocated ID.`,
        );
      }
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
// Removing the comment entirely keeps its own `<section>`/`<span>` text from
// being read while leaving the surrounding structure intact. (This said
// "blanking rather than deleting" and the code has always done the latter —
// `.replace(..., '')` removes the span rather than substituting whitespace.
// Corrected because the distinction is the kind a reader would reason from.)
export function stripHtmlComments(html) {
  let out = html;
  for (;;) {
    const next = out.replace(/<!--[\s\S]*?-->/g, '');
    if (next === out) return out;
    out = next;
  }
}

// Strips tags and collapses whitespace, so a cell's text can be compared
// regardless of the markup inside it (the C group's setup cell wraps a
// `<span lang="ru">`, and every glance-table letter is wrapped in an `<a>`).
export function htmlCellText(html) {
  let stripped = html;
  for (;;) {
    const next = stripped.replace(/<[^>]*>/g, '');
    if (next === stripped) break;
    stripped = next;
  }
  return stripped.replace(/\s+/g, ' ').trim();
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
  const blocks = html.split(/<section\b[^>]*\bclass=\u0022group(?:\s[^\u0022]*)?\u0022[^>]*>/).slice(1);
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

// Parses a baseline register text (origin/main's copy, per #2199) into the
// same shape used elsewhere: the glance table's letters and the body's
// letter -> row-numbers map. Returns `null` when the baseline can't be
// TRUSTED, which this function tests by running it through `checkRegister`
// (the exact same internal-consistency check `check:onbox-register` runs
// against the tracked register) and rejecting it outright if that reports
// ANYTHING — not just the narrower "unterminated fence or no glance
// section" test an earlier version used.
//
// #2199 review round 3 (A2): that narrower test was too weak. Every OTHER
// kind of malformed baseline — a glance-table row with no matching body
// section, a body section with no glance-table row, a count mismatch, a
// duplicate row ID, a row at or above its group's next-id, a missing
// next-id marker, a duplicate letter, a sub-lettered row heading, ... —
// used to fall through it and produce a non-null result with an EMPTY (or
// merely incomplete) `bodyGroups` for the broken group. Since an empty
// baseline group makes every live-page row for that group read as
// "discharged" (nothing in the baseline to contradict it), that was a
// fail-OPEN hole with the same shape and stakes as the one round 2 closed:
// an internally-inconsistent register CAN reach `main` (the register's own
// consistency check is neither required nor unconditionally path-triggered
// — see `.github/workflows/onbox-register-check.yml`), and from that point
// every `--against-published` run against it would be silently vacuous.
// Delegating to `checkRegister` — rather than hand-rolling a wider version
// of the same narrow test — is what makes "can't be trusted" mean the same
// thing here as it does everywhere else in this file, instead of two
// definitions quietly drifting apart.
//
// Reuses the SAME parsing helpers as the working register (`stripFences`,
// `splitSections`, `parseGlanceTable`, `parseBodyGroups`) for the actual
// extraction — no second parser — once `checkRegister` has already vouched
// for the text; the fence-stripping/glance-section lookups below are just
// pulling out what `checkRegister` already confirmed is there.
function resolveBaselineGroups(baselineText) {
  if (typeof baselineText !== 'string') return null;
  if (checkRegister(baselineText).length > 0) return null;
  const { text: strippedBaseline } = stripFences(baselineText);
  const baselineSections = splitSections(strippedBaseline);
  const baselineGlanceSection = baselineSections.find((s) => s.title === 'At a glance');
  // Defence in depth, not the primary gate: `checkRegister` returning no
  // errors already guarantees this section exists, so this branch should be
  // unreachable — but failing CLOSED (null) instead of throwing a raw
  // TypeError on `.body` is strictly better if that guarantee is ever
  // violated by a future change to either function, and costs nothing here.
  if (!baselineGlanceSection) return null;
  const { groups: baselineTableGroups } = parseGlanceTable(baselineGlanceSection.body);
  const { groups: baselineBodyGroups } = parseBodyGroups(baselineSections);
  return { tableLetters: new Set(baselineTableGroups.keys()), bodyGroups: baselineBodyGroups };
}

// The single-error array `checkLiveView` returns when `extraOnly` can't
// resolve or trust a baseline at all (see `resolveBaselineGroups` above).
// Exported and matched by IDENTITY (`errors[0] === CANNOT_VERIFY_BASELINE_ERROR`)
// rather than by prose-sniffing a message prefix — #2199 review round 3
// (B2) flagged the original `errors.length === 1 &&
// errors[0].startsWith('Cannot verify')` check in the CLI layer as a
// fragile contract between this string and the CLI's remedy text: a future
// reword of the message (e.g. fixing a typo) would silently break the CLI's
// detection with no test catching it, since nothing tied the two together.
// A single shared constant makes that impossible — both sides reference the
// same value, so they cannot drift independently.
export const CANNOT_VERIFY_BASELINE_ERROR =
  'Cannot verify --against-published: the origin/main baseline register is ' +
  'unavailable, unreadable, or internally inconsistent, so a row the live page ' +
  "has but this register lacks can't be told apart from a genuine competing-lane " +
  'row. Do not publish until this passes.';

// #2272 review finding 2: the prefix every "an unconsumed --discharging
// name" error starts with. These are per-ID (one row ID interpolated per
// error, and there can be more than one in a single run), so — unlike
// CANNOT_VERIFY_BASELINE_ERROR above — no single fixed string can identity-
// match all of them. A shared PREFIX constant is the next-closest thing: the
// CLI layer partitions `checkLiveView`'s returned errors by
// `.startsWith(DISCHARGE_NAME_ERROR_PREFIX)` rather than sniffing prose it
// doesn't own, for the same reason the identity match above exists — a
// reword of the explanatory suffix can't silently break the CLI's detection,
// because both sides reference this one constant instead of two
// independently-typed strings that could drift apart.
export const DISCHARGE_NAME_ERROR_PREFIX = '--discharging named ';

// #2599/A41: the prefix every per-row content-drift error starts with —
// mirroring DISCHARGE_NAME_ERROR_PREFIX just above for the same reason: one
// error per drifted row ID, so an identity match (like
// CANNOT_VERIFY_BASELINE_ERROR) can't cover them, and the CLI layer needs to
// route this class to its OWN remedy rather than the structural "BEHIND"
// framing below — a row whose content merely drifted isn't "live-only, merge
// it in", it's "reconcile which side is actually correct", a different fix
// entirely.
export const ROW_CONTENT_DRIFT_ERROR_PREFIX = 'row ';

// Compares the live view against the markdown. Returns human-readable error
// strings; empty when the two agree.
//
// Every extraction failure below is an error rather than a skip. A regex that
// stops matching after a markup change would otherwise turn this whole check
// into a vacuous pass — which is the exact shape of bug it exists to catch.
//
// `direction`:
//   - 'both' (default): the original, symmetric tracked-pair comparison —
//     the register and the tracked live-view.html are supposed to be in
//     permanent lockstep, so EITHER side having something the other lacks
//     is a defect. Used for the no-flag `check:onbox-register` run.
//   - 'extraOnly': the `--against-published` comparison (#1931 review round
//     2/3). Comparing the register you are ABOUT TO PUBLISH against the page
//     that is ALREADY live is not symmetric: the register having rows the
//     live page lacks is the NORMAL, INTENDED pre-publish state — that is
//     the entire reason you are publishing — not evidence of anything wrong.
//     Only the live page having content the register lacks is evidence the
//     register is stale relative to what is already live (e.g. another lane
//     published first). Reporting both directions here inverts the
//     diagnosis: it fires on every genuine publish and tells the operator to
//     delete the very rows they were about to publish. So in this mode, any
//     check whose failure direction is "the register has X, the live page
//     doesn't" is skipped outright — not reworded, not softened — and only
//     "the live page has X, the register doesn't" checks fire. Extraction
//     failures, malformed markup and duplicates are unaffected: they are not
//     about direction, they are about whether the live page can be trusted
//     at all, so they fire in both modes.
//
//     #2199: "the live page has X, the register doesn't" is ALSO the normal
//     shape of a deliberate row discharge — removing a row always makes the
//     still-live page look "ahead" by that row's own ID, since under stable
//     row IDs nothing else shifts. `extraOnly` therefore disambiguates
//     each such X against `options.baselineText` — a second register text,
//     meant to be `origin/main`'s copy fetched by the CLI layer (this
//     function never shells out itself, so it stays unit-testable without
//     git): if the baseline ALSO lacks X, it was discharged (by this change
//     or an already-merged one) and is not reported; if the baseline still
//     has X, the register is genuinely behind and it IS reported. When the
//     baseline can't be resolved or parsed at all, this fails CLOSED — every
//     `extraOnly` check is skipped in favour of a single "cannot verify"
//     error — rather than silently treating "baseline unknown" the same as
//     "baseline lacks it too", which would let a discharge-shaped bug pass
//     unnoticed for the same reason a real competing-lane row would.
//
//     Residual limitation, deliberately not fixed here (#2199 review round
//     3, A3): a row that is LIVE and still genuinely OWED but never actually
//     landed on `origin/main` at all — e.g. published straight from a
//     branch that never merged, or from a PR that was later reverted — now
//     reads as "discharged" too, identically to a row someone legitimately
//     removed: both are "absent from origin/main, absent from the working
//     register". The `'both'`-mode message this replaces already names this
//     exact cause ("A row published from an unmerged branch ... is the
//     usual cause"); `extraOnly` has no way left to distinguish "removed on
//     purpose" from "never merged in the first place", because the ONLY
//     signal it has is origin/main's content, and both cases agree on what
//     that says. This is an intentional narrowing of the guard's envelope,
//     not an oversight: the alternative — treating any row absent from
//     origin/main as suspect — is the exact false positive #2199 exists to
//     fix, just with the roles of "register" and "origin/main" swapped. See
//     the register's own "Live view" step 3 for the operator-facing note.
//
//     #2272: `options.dischargingIds` closes a narrower gap the baseline
//     above cannot — it can only recognise a discharge that has ALREADY
//     MERGED to `origin/main`, but `--against-published` runs BEFORE merge,
//     from the shipping branch itself. At that moment `origin/main` still
//     has the row, so the baseline calls it genuinely BEHIND even though
//     this very branch already removed it. `dischargingIds` names the row
//     IDs the operator asserts were deliberately discharged by the change
//     being published; naming an ID suppresses the live-only BEHIND
//     verdict(s) it accounts for — one row in the common case, but if the
//     same ID is live-only in more than one section (a malformed live page)
//     it suppresses each occurrence, and naming every row a whole-group
//     discharge left behind suppresses that group's BEHIND verdict too (see
//     the group-level checks further down) — it never widens beyond the IDs
//     actually named, and it has no effect outside `direction: 'extraOnly'`.
//     Naming an ID that never accounts for any live-only row is an error,
//     not a silent no-op — see the check at the end of this function — so a
//     typo can't degenerate the flag into a blanket mute.
//
//     Name the ID of the row you discharged. Under stable row IDs that is
//     exactly the ID that disappears from the live page — IDs are never
//     reused, so nothing shifts.
//
//     #2599/A41: `options.baselineLiveViewText` is origin/main's copy of the
//     live-view.html for content-hashing disambiguation. The tracked local
//     copy may have legitimate pending-publish edits (steps already committed
//     to the branch but not yet published), which would hash differently from
//     the published version even though no drift occurred. Comparing against
//     the baseline disambiguates: if tracked matches baseline, the local edit
//     is not drift (already committed); if published matches baseline but
//     tracked doesn't, that's the genuine defect (live page reverted). When
//     the baseline can't be resolved, content hashing is skipped rather than
//     using a missing baseline as "no drift" — matching the fail-closed
//     approach the register-side baseline already uses.
export function checkLiveView(
  markdownText,
  rawLiveViewHtml,
  { direction = 'both', baselineText, dischargingIds = [], trackedLiveViewHtml, baselineLiveViewText } = {},
) {
  const errors = [];
  const dischargingSet = new Set(dischargingIds);
  const consumedDischargingIds = new Set();
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

  // 'extraOnly' needs a baseline to tell a discharge apart from a genuine
  // competing-lane row (#2199) — resolve it once, up front, and fail closed
  // immediately if it can't be trusted. This deliberately bails out before
  // any other comparison runs, mirroring the fence/glance-section bail-outs
  // above: a partial 'extraOnly' run built on an unverifiable baseline would
  // just produce more wrong verdicts on top of the "can't verify" problem
  // itself, not fewer.
  let baselineTableLetters = null;
  let baselineBodyGroups = null;
  if (direction === 'extraOnly') {
    const baseline = resolveBaselineGroups(baselineText);
    if (!baseline) {
      // Deliberately cause-agnostic (unavailable, unreadable, AND
      // internally-inconsistent-per-checkRegister all land here — see
      // resolveBaselineGroups' own header comment) and deliberately does
      // NOT prescribe a specific remedy like "run git fetch": that used to
      // read as a live contradiction when the actual cause was a fetch that
      // had already succeeded (#2199 review round 3, B3) — the CLI layer,
      // which knows which git call actually failed, is what prints the
      // specific remedy (see the `baseline.failedStep` branch below); this
      // message is also reached directly by callers that never touch git at
      // all (e.g. a unit test passing a malformed `baselineText`), for whom
      // "run git fetch" would be actively wrong advice.
      return [CANNOT_VERIFY_BASELINE_ERROR];
    }
    baselineTableLetters = baseline.tableLetters;
    baselineBodyGroups = baseline.bodyGroups;
  }

  // The owed total, as the summary strip states it.
  const owedMatch = liveViewHtml.match(/<div class="n owed">(\d+)<\/div>/);
  if (!owedMatch) {
    errors.push(
      'Live view: no `<div class="n owed">NN</div>` found — the summary strip\'s owed total could not be read. If the markup changed, update scripts/check-onbox-register.mjs.',
    );
  } else if (direction === 'both' && mdTotal !== null && Number(owedMatch[1]) !== mdTotal) {
    // Scalar, not directional: a total mismatch can't say WHICH rows differ,
    // only that they do — so in 'extraOnly' mode it is dropped in favour of
    // the precise, directional per-row `extra` checks below, rather than
    // guessed at from the sign of the difference.
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
  // The group sections and their rows. Parsed here — before the glance-table
  // loop below, not after it as originally written — so the glance-table
  // loop's own whole-group-discharge check (#2272 review finding 1) can look
  // up a vanished group's actual live row IDs via `lvSections`. A pure
  // re-parse of the same `liveViewHtml` already held in memory: moving it
  // earlier changes nothing about what it returns, only when it runs. The
  // error-reporting loops that consume `duplicateSectionLetters` and
  // `invalidRowIds` stay at their original position further down — only this
  // computation moved.
  const {
    sections: lvSections,
    duplicateLetters: duplicateSectionLetters,
    invalidRowIds,
  } = parseLiveViewSections(liveViewHtml);
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
        // "the register has a group the live page doesn't" is the normal
        // pre-publish state (a brand-new group not yet published) — not
        // evidence of staleness. Skip in 'extraOnly' mode.
        if (direction === 'both' && !malformedLetters.includes(letter)) {
          errors.push(`Live view: Group ${letter} is missing from the glance table.`);
        }
        continue;
      }
      if (direction === 'both' && lvGroups.get(letter) !== mdCount) {
        errors.push(
          `Live view: glance table says Group ${letter} has ${lvGroups.get(letter)} rows, the register says ${mdCount}.`,
        );
      }
    }
    for (const letter of lvGroups.keys()) {
      if (!mdGroups.has(letter)) {
        if (direction === 'extraOnly') {
          // #2199: the live page has a group letter this register lacks. If
          // origin/main ALSO lacks it, the whole group was discharged (by
          // this change or an already-merged one) — not an error. Only when
          // origin/main still has it is this register genuinely behind.
          if (baselineTableLetters.has(letter)) {
            // #2272 (review finding 1): a discharge that removes a group's
            // LAST row makes the whole group vanish from `mdGroups` — the
            // per-row `extra`/`staleExtra` logic further down only runs for
            // letters `mdBodyGroups` still has, so it never sees this case.
            // Consult the live page's own row IDs for this letter (via
            // `lvSections`, parsed above) so a FULLY-named group is
            // suppressed and consumed like any other discharge, while a
            // PARTIALLY-named one still fails — naming only the leftover,
            // unnamed IDs, not just "add the group back".
            const liveRowIds = lvSections.get(letter)?.rowIds ?? [];
            const namedIds = liveRowIds.filter((id) => dischargingSet.has(id));
            const unnamedIds = liveRowIds.filter((id) => !dischargingSet.has(id));
            // Every named id genuinely IS live-only for this letter, whether
            // it ends up fully discharging the group or not — consumed
            // unconditionally so a partial match isn't ALSO reported as an
            // unrecognised name by the check at the end of this function.
            for (const id of namedIds) consumedDischargingIds.add(id);
            if (liveRowIds.length > 0 && unnamedIds.length === 0) {
              // Fully named — nothing left to report, already consumed above.
            } else if (namedIds.length > 0) {
              // Partially named: leave the ORIGINAL message alone when
              // --discharging never touched this group at all (below) — only
              // switch to naming the leftovers once at least one name for
              // this group actually matched, so a plain, flag-less run keeps
              // its original wording verbatim.
              errors.push(
                `The live page's glance table has a Group ${letter} row that this register does not — the register is BEHIND what is already published. ${unnamedIds.length === 1 ? 'Row' : 'Rows'} ${unnamedIds.join(', ')} ${unnamedIds.length === 1 ? 'is' : 'are'} not named via --discharging; merge ${unnamedIds.length === 1 ? 'it' : 'them'} in before publishing.`,
              );
            } else {
              errors.push(
                `The live page's glance table has a Group ${letter} row that this register does not — the register is BEHIND what is already published. Add the group to the register before publishing.`,
              );
            }
          }
          continue;
        }
        errors.push(
          `Live view: glance table has a Group ${letter} row that the register's glance table does not. Remove it or add the group to the register.`,
        );
      }
    }
  }

  // `lvSections`, `duplicateSectionLetters` and `invalidRowIds` were parsed
  // earlier, alongside the glance table — see the comment there for why.
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
      // Normal pre-publish state in 'extraOnly' mode — see the function
      // header comment.
      if (direction === 'both') errors.push(`Live view: no group section for Group ${letter}.`);
      continue;
    }
    if (section.headerCount === null) {
      // An extraction failure, not a directional comparison — the header IS
      // there, its `gcount` span just couldn't be read. Fires in both modes.
      errors.push(
        `Live view: Group ${letter}'s header has no \`<span class="gcount">N rows</span>\`.`,
      );
    } else if (direction === 'both' && section.headerCount !== mdNumbers.length) {
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
    // `missing` (register has, live page doesn't) is the normal pre-publish
    // state in 'extraOnly' mode — see the function header comment — so it is
    // skipped there; `extra` (live page has, register doesn't) is the
    // directional signal that mode exists to surface, but as of #2199 it is
    // not reported as-is: a row in `extra` that origin/main ALSO lacks was
    // deliberately discharged, not left behind, so it's filtered out below
    // before deciding whether to fire.
    if (direction === 'both' && missing.length > 0) {
      errors.push(
        `Live view's Group ${letter} section is missing ${missing.length === 1 ? 'row' : 'rows'} ${missing.join(', ')} — present in the register, absent from that section.`,
      );
    }
    // #2199: filter `extra` down to rows origin/main's baseline still has.
    // Looked up by the ID's OWN letter (not this section's `letter`), so a
    // row filed under the wrong group (see the comment above) is checked
    // against ITS letter's baseline group, matching how `expected`/`found`
    // are keyed.
    //
    // #2272: every id in `extra` is, by definition, "live-only" (present on
    // the live page, absent from this register) — the exact target
    // `--discharging` suppresses — so a named id is marked consumed here,
    // BEFORE the baseline filter below, regardless of whether the baseline
    // would have called it stale. That way a name for a row the baseline
    // ALSO already lacks (harmless — it was never going to be reported)
    // still counts as a match, not a typo, and only a name that never shows
    // up in ANY group's `extra` set at all is left unconsumed and reported.
    if (direction === 'extraOnly') {
      for (const id of extra) {
        if (dischargingSet.has(id)) consumedDischargingIds.add(id);
      }
    }
    const staleExtra =
      direction === 'extraOnly'
        ? extra.filter((id) => {
            const idMatch = id.match(/^([A-Z])(\d+)$/);
            if (!idMatch) return true; // shouldn't happen — rowIds is pre-filtered to this shape
            const [, idLetter, idNumber] = idMatch;
            const baselineNumbers = baselineBodyGroups.get(idLetter) ?? [];
            if (!baselineNumbers.includes(Number(idNumber))) return false;
            // #2272: a named id suppresses exactly this BEHIND verdict — the
            // baseline (pre-merge origin/main) hasn't caught up yet because
            // this run is BEFORE merge, not because the row is a genuine
            // competing-lane addition.
            return !dischargingSet.has(id);
          })
        : extra;
    if (staleExtra.length > 0) {
      errors.push(
        direction === 'extraOnly'
          ? `The live page's Group ${letter} section has ${staleExtra.length === 1 ? 'row' : 'rows'} ${staleExtra.join(', ')} that this register does not yet have — the register is BEHIND what is already published. Merge ${staleExtra.length === 1 ? 'it' : 'them'} in before publishing.`
          : `Live view's Group ${letter} section has ${extra.length === 1 ? 'row' : 'rows'} ${extra.join(', ')} that the register's Group ${letter} does not. A row published from an unmerged branch, or a row filed under the wrong group, is the usual cause.`,
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
      if (direction === 'extraOnly') {
        // #2199: whole-group discharge — same baseline check as the
        // glance-table letter loop above, applied to the body section list.
        if (baselineBodyGroups.has(letter)) {
          // #2272 (review finding 1): same discharge-awareness as the
          // glance-table loop above — see its comment for why a whole-group
          // discharge needs its own handling rather than falling through to
          // the per-row `extra` logic above.
          const liveRowIds = lvSections.get(letter)?.rowIds ?? [];
          const namedIds = liveRowIds.filter((id) => dischargingSet.has(id));
          const unnamedIds = liveRowIds.filter((id) => !dischargingSet.has(id));
          // Every named id genuinely IS live-only for this letter, whether it
          // ends up fully discharging the group or not — consumed
          // unconditionally so a partial match isn't ALSO reported as an
          // unrecognised name by the check at the end of this function.
          for (const id of namedIds) consumedDischargingIds.add(id);
          if (liveRowIds.length > 0 && unnamedIds.length === 0) {
            // Fully named — nothing left to report, already consumed above.
          } else if (namedIds.length > 0) {
            // Partially named: leave the ORIGINAL message alone when
            // --discharging never touched this group at all (below) — only
            // switch to naming the leftovers once at least one name for this
            // group actually matched, so a plain, flag-less run keeps its
            // original wording verbatim.
            errors.push(
              `The live page has a Group ${letter} section that this register's body does not — the register is BEHIND what is already published. ${unnamedIds.length === 1 ? 'Row' : 'Rows'} ${unnamedIds.join(', ')} ${unnamedIds.length === 1 ? 'is' : 'are'} not named via --discharging; add ${unnamedIds.length === 1 ? 'it' : 'them'} to the register before publishing.`,
            );
          } else {
            errors.push(
              `The live page has a Group ${letter} section that this register's body does not — the register is BEHIND what is already published. Add the section before publishing.`,
            );
          }
        }
        continue;
      }
      errors.push(
        `Live view has a Group ${letter} section that the register's body does not. Remove it or add the section to the register.`,
      );
    }
  }

  // #2272: any --discharging name that never matched a live-only row is an
  // error, not a silent no-op — an unmatched name (a typo, or an ID copied
  // from the wrong discharge) must be loud, or the flag degenerates into a
  // blanket mute that would let a genuine competing-lane row slip through
  // unreported. Scoped to 'extraOnly' — dischargingIds has no effect in
  // 'both' mode, so an unconsumed name there is not an error.
  if (direction === 'extraOnly') {
    for (const id of dischargingSet) {
      if (!consumedDischargingIds.has(id)) {
        errors.push(
          `${DISCHARGE_NAME_ERROR_PREFIX}${id}, but it never accounts for a live-only row ` +
            '(present on the published page, absent from this register) — there is nothing ' +
            'to suppress. That means the ID is either not on the live page at all, or is ' +
            "still IN this register — check for a typo, or that you actually removed the " +
            'row from the register before running this; or its whole group was already ' +
            'discharged on origin/main (the baseline agrees with this register, so that ' +
            "group's stale live-page section is already a silent no-op and needs no name) — " +
            'drop it from --discharging. --discharging only has something to suppress once ' +
            'the row is genuinely absent from the register you are about to publish AND ' +
            'still present on the baseline.',
        );
      }
    }
  }

  // #2599/A41: row content drift — a row present in BOTH the TRACKED local
  // live view and the PUBLISHED snapshot (this is not about presence, which
  // the checks above already cover) whose body text hash differs. Design
  // decision, dudarenok-maker/Castwright#2599 comment 5484697345: per-row
  // hashing, not a whole-page diff — a whole-page diff would flag on every
  // ordinary content update or legitimate concurrent addition (e.g. #2588's
  // A48), which is exactly the false-positive shape `extraOnly` already
  // exists to avoid for structural drift. Compares TRACKED html against
  // PUBLISHED html, not the register — see `parseLiveViewRowBodies`'s own
  // header for why. Scoped to 'extraOnly' AND to callers that actually pass
  // `trackedLiveViewHtml` — this is the pre-publish comparison the row-
  // content regression (PR #2578 review rounds 13-18, manually byte-diffed
  // because nothing mechanical caught it) actually needs; the tracked-pair
  // 'both' comparison was never the gap this closes, and a caller with no
  // tracked copy to compare (most direct `checkLiveView` unit tests) has
  // nothing for this sub-check to do.
  // - A row ID tracked-only (edited locally, not yet on the published page)
  //   is tolerated — the normal pre-publish state, same mechanism as the
  //   #2199/#2272 presence checks above, not a new tolerance rule.
  // - A row ID published-only is untouched by this loop entirely — the
  //   existing discharge handling above already decides whether that's
  //   reported.
  //
  // #2599: Use baselineLiveViewText (origin/main's copy) to disambiguate
  // legitimate pending-publish edits from genuine drift. When tracked and
  // published content differ:
  // - If tracked matches baseline → the edit is already committed to the
  //   branch, a legitimate pending-publish state — not drift, don't report.
  // - If published matches baseline but tracked doesn't → the tracked copy
  //   has unilateral edits not in origin/main, while the published page
  //   remains at baseline (unchanged or reverted) — genuine drift, report it.
  // Fail closed when the baseline isn't available: skip content hashing
  // rather than treating "baseline unknown" as "no drift".
  if (direction === 'extraOnly' && typeof trackedLiveViewHtml === 'string') {
    const { bodies: trackedRowBodies, errors: trackedErrors } = parseLiveViewRowBodies(
      stripHtmlComments(trackedLiveViewHtml),
    );
    const { bodies: publishedRowBodies, errors: publishedErrors } = parseLiveViewRowBodies(liveViewHtml);
    let baselineRowBodies = null;
    let baselineErrors = [];
    if (typeof baselineLiveViewText === 'string') {
      const result = parseLiveViewRowBodies(stripHtmlComments(baselineLiveViewText));
      baselineRowBodies = result.bodies;
      baselineErrors = result.errors;
    }
    // Report all extraction failures from the three parses. These are errors rather
    // than skips: a row that couldn't be extracted means the check compared fewer
    // rows than the page actually carries and silently reported fewer, a vacuous pass.
    errors.push(...trackedErrors, ...publishedErrors, ...baselineErrors);
    for (const [id, trackedBody] of trackedRowBodies) {
      const publishedBody = publishedRowBodies.get(id);
      if (publishedBody === undefined) continue;
      const trackedHash = hashRowContent(trackedBody);
      const publishedHash = hashRowContent(publishedBody);
      if (trackedHash !== publishedHash) {
        // Hashes differ between tracked and published. Disambiguate using the baseline.
        if (baselineRowBodies === null) {
          // No baseline — fail closed, skip this check.
          continue;
        }
        const baselineBody = baselineRowBodies.get(id);
        if (baselineBody === undefined) {
          // Baseline has no entry for this row — a new row was added
          // tracked-locally. This is not drift, it's a pre-publish pending add.
          continue;
        }
        const baselineHash = hashRowContent(baselineBody);
        if (trackedHash === baselineHash) {
          // Tracked matches baseline — the edit is already committed to the
          // branch (either on origin/main already, or committed on this branch
          // and now being published). This is a legitimate pending-publish
          // state, not drift. Skip it.
          continue;
        }
        if (publishedHash === baselineHash) {
          // Published matches baseline (unchanged since origin/main), but
          // tracked differs — genuine drift. The tracked copy has unilateral
          // edits that never made it to the live page.
          errors.push(
            `${ROW_CONTENT_DRIFT_ERROR_PREFIX}${id}: content differs between local and published`,
          );
        }
        // If trackedHash !== baselineHash AND publishedHash !== baselineHash,
        // both differ from baseline — can't tell which is the source of truth,
        // so skip (fail closed).
      }
    }
  }

  return errors;
}

// Default git runner used by `resolveBaselineText` below: real `spawnSync`,
// with a timeout so a hanging network can't wedge the check indefinitely. A
// timeout surfaces as `result.error` set (Node's own `spawnSync` behaviour
// when its `timeout` option fires) — the caller already treats any truthy
// `result.error` as a failure, so a timeout needs no special-casing to fail
// closed like any other git failure.
//
// #2216 — scrubs the ambient GIT_DIR/GIT_WORK_TREE/GIT_OBJECT_DIRECTORY/
// GIT_COMMON_DIR repo-location vars before spawning: this runs against an
// explicit `cwd` (repoRoot), and an inherited GIT_DIR would silently
// redirect `git fetch`/`rev-parse`/`show` at a different repository instead
// of erroring. See scripts/git-env.mjs's header for the full account.
const GIT_TIMEOUT_MS = 15_000;
function runGitCommand(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true, env: scrubGitEnv() });
}

// #2199 review round 2: fetches `origin/main` FRESH before reading it,
// rather than trusting the local remote-tracking ref as-is. `origin/main`
// only moves on fetch/pull — reading it without fetching first reopens the
// exact #1931 race `--against-published` exists to close: an operator whose
// local checkout predates a merge on `main` sees that merge's row as absent
// from BOTH their working register AND their (stale) local `origin/main` —
// which the discharge filter in `checkLiveView` then (wrongly) reads as
// "already discharged" and lets through. That is a false NEGATIVE on the
// precise scenario this whole mode exists to catch — strictly worse than
// the false positive it replaced, and the same class of hole the
// unparseable-baseline fail-closed path already guards against, just for a
// different cause (stale ref vs. unreadable content).
//
// No offline escape hatch (deliberately no `--no-fetch`): this mode runs
// only immediately before publishing to a remote artifact URL, so an
// operator who cannot reach the network to fetch cannot publish either —
// requiring the network here costs nothing the rest of the procedure
// doesn't already require.
//
// `gitRunner` is injectable (defaults to the real `spawnSync`-based
// `runGitCommand`) so tests can record call order — proving the fetch runs
// BEFORE the show, not just that both run — and simulate a failure at
// either step (non-zero exit, a thrown/ENOENT spawn error, or a timeout,
// which surfaces identically to a spawn error via `result.error`) without
// touching the real network or git. Returns `{ text: null, failedStep }` on
// any failure, where `failedStep` names which git call failed so the CLI
// layer can tell the operator specifically what to retry. `checkLiveView`
// itself never shells out (see its own header comment) — this function is
// the CLI layer's entire git surface for baseline resolution.
//
// #2199 review round 3 (A1): reads `FETCH_HEAD`, NOT `origin/main`, for the
// `show`. "Fetch, then read the local ref" (round 2's version) is not
// provably fresh: `git fetch origin main` only GUARANTEES it writes
// `FETCH_HEAD` — updating `refs/remotes/origin/main` is an opportunistic
// side effect that happens only when the repo's `remote.origin.fetch`
// refspec maps `refs/heads/main` at all. A narrowed refspec (e.g. one that
// only tracks `refs/heads/other/*`) makes the fetch exit 0 while
// `origin/main` silently stays wherever it was — reopening the exact
// staleness hole round 2 was meant to close, through a different door. This
// repo's own default clone uses the wildcard refspec, so it isn't exposed
// today, but "a ref that updates only sometimes" is precisely the
// "unenforced prerequisite" argument this function already makes above
// about the network requirement itself — it shouldn't apply to the fetch
// but not to what the fetch is trusted to have updated. `FETCH_HEAD` has no
// such conditionality: any `git fetch` — regardless of refspec — writes it
// unconditionally to the tip(s) it just fetched, so reading it instead of
// the remote-tracking ref is correct independent of how this or any other
// clone's refspec is configured.
//
// #2199 review round 5 (optional hardening, applied): resolves `FETCH_HEAD`
// to a fixed SHA via `git rev-parse` immediately after the fetch, then reads
// from that SHA — rather than letting `git show` resolve the symbolic name
// `FETCH_HEAD` itself a moment later. This narrows (does not fully close — a
// full close needs a lock this repo has no mechanism for) a residual race: a
// concurrent PLAIN `git fetch` in the SAME worktree, landing between this
// function's own fetch and its show, can leave `FETCH_HEAD` multi-line with
// an unrelated branch on its first line — and `git show FETCH_HEAD:<path>`
// resolves the symbolic name at THAT moment, so it could silently read the
// unrelated branch's file instead. Freezing the SHA immediately after this
// function's own fetch shrinks that window to the smallest it can be without
// a lock. A `rev-parse` failure is folded into `failedStep: 'show'` — not a
// third distinct step — deliberately: from the operator's side, "resolving
// what the fetch just wrote" failed either way, and giving it its own label
// would need the CLI's per-`failedStep` message to also stop claiming
// specifically "`git show` failed" (see that message's own text), trading a
// small amount of message precision for a third branch with no additional
// operator action attached to it.
export function resolveBaselineText(repoRoot, registerPath, gitRunner = runGitCommand) {
  const fetchResult = gitRunner(['fetch', 'origin', 'main'], repoRoot);
  if (fetchResult.error || fetchResult.status !== 0) {
    return { text: null, failedStep: 'fetch' };
  }
  const revParseResult = gitRunner(['rev-parse', 'FETCH_HEAD'], repoRoot);
  if (revParseResult.error || revParseResult.status !== 0) {
    return { text: null, failedStep: 'show' };
  }
  const fetchedSha = revParseResult.stdout.trim();
  const showResult = gitRunner(['show', `${fetchedSha}:${registerPath}`], repoRoot);
  if (showResult.error || showResult.status !== 0) {
    return { text: null, failedStep: 'show' };
  }
  return { text: showResult.stdout, failedStep: null };
}

// #2599/A41: fetches both the register and live-view.html baselines from
// origin/main in one flow. Does a single `git fetch`, then parses the SHA
// once, and reads both files from it. Returns `{ registerText, liveViewText,
// failedStep }` — either both texts succeed (failedStep: null), or both are
// null on any failure (failedStep names the step that failed). This keeps the
// two reads synchronized on the same commit, and avoids a second
// fetch+parse that would reopen the residual race `resolveBaselineText`'s own
// hardening already addresses.
export function resolveBaselineTexts(
  repoRoot,
  registerPath,
  liveViewPath,
  gitRunner = runGitCommand,
) {
  const fetchResult = gitRunner(['fetch', 'origin', 'main'], repoRoot);
  if (fetchResult.error || fetchResult.status !== 0) {
    return { registerText: null, liveViewText: null, failedStep: 'fetch' };
  }
  const revParseResult = gitRunner(['rev-parse', 'FETCH_HEAD'], repoRoot);
  if (revParseResult.error || revParseResult.status !== 0) {
    return { registerText: null, liveViewText: null, failedStep: 'show' };
  }
  const fetchedSha = revParseResult.stdout.trim();
  const registerResult = gitRunner(['show', `${fetchedSha}:${registerPath}`], repoRoot);
  if (registerResult.error || registerResult.status !== 0) {
    return { registerText: null, liveViewText: null, failedStep: 'show' };
  }
  const liveViewResult = gitRunner(['show', `${fetchedSha}:${liveViewPath}`], repoRoot);
  if (liveViewResult.error || liveViewResult.status !== 0) {
    return { registerText: null, liveViewText: null, failedStep: 'show' };
  }
  return {
    registerText: registerResult.stdout,
    liveViewText: liveViewResult.stdout,
    failedStep: null,
  };
}

// process.exit() terminates before Node flushes pending async stdout/stderr
// writes (synchronous on Windows, ASYNCHRONOUS on Linux/macOS — see
// scripts/build-release-zip.mjs's own die()/CliError comment for the fuller
// account and the incident that motivated it, PR #2297). This CLI's own
// output was measured as tiny on its OK path — see the "extend the guard fix
// beyond scripts/" commit — but that measurement never covered the FAILURE
// path: onbox-register-check.yml runs this on ubuntu with stdout/stderr on a
// pipe, and a register with many mismatches can queue well more than a
// trivial number of console.error writes before exiting, which is exactly
// the shape that truncates on POSIX. Every process.exit() call below is
// replaced with `throw new CliExitError(code)`; the whole CLI body runs
// inside runCheckOnboxRegisterCli(), invoked from a try/catch that turns a
// caught CliExitError into `process.exitCode` instead of an instant kill, and
// re-throws anything else (an unexpected error crashes exactly as it did
// before — there was no top-level catch here previously either). This is a
// control-flow extraction, not a rewrite: every exit code is unchanged, only
// WHEN the process actually terminates (after the event loop drains, not
// mid-write) is different.
class CliExitError extends Error {
  constructor(code) {
    super(`CLI exit ${code}`);
    this.code = code;
  }
}

// CLI mode: `node scripts/check-onbox-register.mjs`
function runCheckOnboxRegisterCli() {
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
        throw new CliExitError(1);
      }
      throw err;
    }
  };

  const report = (label, errors) => {
    if (errors.length === 0) return false;
    console.error(`${label}:\n`);
    for (const error of errors) console.error(`- ${error}`);
    console.error('');
    return true;
  };

  const text = read(REGISTER);

  // --against-published <file>: the mechanical half of #1931's "re-read the
  // live register immediately before publishing" step. CI has no credentials
  // to fetch the published artifact itself — see this file's own header and
  // the register's "Live view" section — so this mode takes a LOCALLY SAVED
  // COPY of the page fetched by hand immediately before a publish, and runs
  // the identical `checkLiveView` comparison against it, with `direction:
  // 'extraOnly'` — see that function's own header comment for why this
  // comparison is NOT symmetric like the no-flag tracked-pair run below: the
  // register having rows the live page doesn't is the normal pre-publish
  // state, not a defect, and reporting it here would tell the operator to
  // delete the very rows they are about to publish (#1931 review round 3).
  // Deliberately the same comparator, not a second one: the published page
  // IS the tracked live-view.html's own content, wrapped in a publish
  // skeleton the class-name-anchored parsers don't look at. Run BY HAND as
  // the last step before publishing — not wired into
  // onbox-register-check.yml, which has no such file to read and no network
  // access to fetch one.
  const againstPublishedIdx = process.argv.indexOf('--against-published');

  // --discharging <id>[,<id>...] (#2272): names row IDs the operator asserts
  // were deliberately discharged by the change about to publish. Parsed here,
  // at the CLI layer — the flag/argv surface — and threaded into
  // `checkLiveView` as plain data (`options.dischargingIds`); `checkLiveView`
  // itself never touches argv or shells out (see its own header comment),
  // and that separation is what keeps it unit-testable. Only meaningful
  // alongside --against-published — there is nothing for it to suppress in
  // any other run — so it fails loudly rather than being silently ignored
  // when passed without it.
  const dischargingIdx = process.argv.indexOf('--discharging');
  let dischargingIds = [];
  if (dischargingIdx !== -1) {
    // #2272 review (nit 2): `indexOf` only ever finds the FIRST occurrence —
    // a repeated flag (`--discharging A1 --discharging A2`) would otherwise
    // silently parse only A1 and drop A2 with no warning. Reject a second
    // occurrence outright rather than accumulating across them: it matches
    // --against-published's own single-value contract just above, and needs
    // no new merge logic.
    if (process.argv.lastIndexOf('--discharging') !== dischargingIdx) {
      console.error(
        '--discharging was passed more than once — pass every ID in ONE comma-separated ' +
          'value instead, e.g. --discharging E10,E11.',
      );
      throw new CliExitError(1);
    }
    // #2280 review (nit 5): checked before the missing-value check just
    // below, so a bare `--discharging` with no `--against-published` reports
    // the more useful "only makes sense alongside --against-published"
    // rather than "requires a value" — the flag is pointless either way,
    // but this names the actual reason first.
    if (againstPublishedIdx === -1) {
      console.error(
        '--discharging only makes sense alongside --against-published — it names a row ' +
          'deliberately discharged by the change about to publish, and there is nothing ' +
          'for it to suppress outside that comparison.',
      );
      throw new CliExitError(1);
    }
    const dischargingArg = process.argv[dischargingIdx + 1];
    if (!dischargingArg) {
      console.error(
        '--discharging requires a value: one row ID, or a comma-separated list, e.g. ' +
          '--discharging E10 or --discharging E10,E11.',
      );
      throw new CliExitError(1);
    }
    dischargingIds = dischargingArg
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    // #2272 review (nit 3): a value like ",,," or "," survives the
    // `!dischargingArg` check above (the raw string is non-empty) but
    // filters down to an EMPTY array here — which would otherwise proceed
    // exactly as if --discharging had never been passed: flag accepted, did
    // nothing, said nothing. That is the precise silent-failure shape this
    // whole feature exists to prevent.
    if (dischargingIds.length === 0) {
      console.error(
        `--discharging ${dischargingArg} has no usable row ID in it after splitting on ` +
          'commas — pass at least one, e.g. --discharging E10 or --discharging E10,E11.',
      );
      throw new CliExitError(1);
    }
  }

  if (againstPublishedIdx !== -1) {
    const publishedPath = process.argv[againstPublishedIdx + 1];
    if (!publishedPath) {
      console.error(
        '--against-published requires a file path: a locally saved copy of the page ' +
          'fetched from the published URL just now.',
      );
      throw new CliExitError(1);
    }
    let publishedHtml;
    try {
      publishedHtml = readFileSync(resolve(publishedPath), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.error(
          `Not found: ${publishedPath} — pass the path to a locally saved copy of the ` +
            'fetched published page.',
        );
        throw new CliExitError(1);
      }
      // A directory (EISDIR) or a permissions failure (EACCES) is also a
      // "can't read this" case, not just ENOENT — report it the same way
      // rather than letting a raw stack trace stand in for the friendly
      // message. Still fails closed either way.
      if (err.code === 'EISDIR' || err.code === 'EACCES') {
        console.error(`Cannot read ${publishedPath} (${err.code}) — pass a readable file path.`);
        throw new CliExitError(1);
      }
      throw err;
    }
    // #2199 review round 2: `origin/main` is FETCHED fresh here, not just
    // read as-is — see `resolveBaselineText`'s own header comment for why a
    // read-only local ref reopens the #1931 race this mode exists to close.
    //
    // #2199 review round 3 (A4/A5): `ONBOX_TEST_BASELINE_FILE` is a TEST-ONLY
    // escape hatch — never mentioned in the register's operator-facing "Live
    // view" procedure, and deliberately narrow: when set, it substitutes
    // ONLY this one read (the baseline text), never the rest of the flow.
    // When unset (every real invocation), behaviour is exactly
    // `resolveBaselineText`'s real `git fetch` + `git show FETCH_HEAD`. It
    // exists so the test suite can pin CLI behaviour against a KNOWN,
    // hermetic baseline instead of depending on live network access or
    // whatever `origin/main` happens to contain at test-run time — a CLI
    // test that derives its expected verdict from live git state is a
    // latent bug (a genuinely new row landing in the same group on `main`
    // while this branch is open silently flips the test's verdict; see the
    // now-hermetic tests below for what that looked like before this seam
    // existed). The real-git, real-network fetch-failure test further down
    // deliberately does NOT use this override — it is the one place a live
    // `git fetch` failing is exactly the point.
    const repoRoot = fileURLToPath(new URL('..', import.meta.url));
    const baselineFileOverride = process.env.ONBOX_TEST_BASELINE_FILE;
    if (baselineFileOverride) {
      // #2199 review round 4: printed UNCONDITIONALLY whenever the override
      // is active — before the verdict, and on the success path as much as
      // the failure path. A silent bypass here is exactly the "guard
      // evaporates on missing/substituted input" shape #2199 exists to fix,
      // just reached through the environment instead of a malformed
      // baseline: a green `--against-published` run with this set is
      // otherwise byte-for-byte indistinguishable from a genuine pass — the
      // exit code is 0 either way, and the "OK" line doesn't say where the
      // baseline came from. If this is ever set in a shell profile, a CI
      // job, or copied into a real invocation by a future agent, the check
      // silently becomes decorative and the operator publishes on a green
      // that means nothing. This line is what makes that state loud instead
      // of silent — it fires on EVERY run where the override is set, not
      // just when something else also goes wrong.
      console.error(
        `WARNING: baseline injected from ONBOX_TEST_BASELINE_FILE=${baselineFileOverride}; ` +
          'this is NOT a real origin/main check and must never be used to gate a publish.',
      );
    }
    let baseline;
    if (baselineFileOverride) {
      try {
        baseline = {
          registerText: readFileSync(resolve(baselineFileOverride), 'utf8'),
          liveViewText: null,
          failedStep: null,
        };
      } catch {
        // #2199 review round 5 (nit 1): its own distinct label, NOT 'show' —
        // reusing 'show' here made the CLI claim "`git show FETCH_HEAD:...`
        // failed even though the preceding `git fetch origin main` just
        // succeeded" when in fact no git ran at all (this whole branch only
        // runs when the TEST-ONLY override is set). Test-only path, but it's
        // the first message a future agent debugging a red test would read,
        // and it was actively wrong about what happened.
        baseline = { registerText: null, liveViewText: null, failedStep: 'override' };
      }
    } else {
      baseline = resolveBaselineTexts(repoRoot, REGISTER, LIVE_VIEW);
    }
    if (baseline.failedStep) {
      // Named explicitly, distinct from checkLiveView's generic "cannot
      // verify" error below (which fires too, since baseline texts are null) —
      // this line is what tells the operator WHICH git call to retry.
      let failureMessage;
      if (baseline.failedStep === 'fetch') {
        failureMessage =
          '`git fetch origin main` failed — cannot verify --against-published without ' +
          'a freshly-fetched baseline, and there is no offline fallback (a stale ' +
          'baseline is exactly the hole this check exists to close). Check your ' +
          'network connection and the `origin` remote, then try again — do not retry ' +
          'the fetch again without addressing the underlying error first.';
      } else if (baseline.failedStep === 'override') {
        failureMessage =
          `Could not read ONBOX_TEST_BASELINE_FILE=${baselineFileOverride} — this is the ` +
          'TEST-ONLY baseline-injection seam, not git (no `git fetch` or `git show` ran). ' +
          'Check the path exists and is readable, then try again.';
      } else {
        // Covers BOTH a `git rev-parse FETCH_HEAD` failure and `git show`
        // failures for either file — resolveBaselineTexts folds them into one
        // `failedStep` (see that function's own comment for why), so this
        // message deliberately doesn't claim it was specifically which `show`.
        failureMessage =
          'Resolving what the fetch just wrote (`git rev-parse FETCH_HEAD` or `git show`) ' +
          'failed even though the preceding `git fetch origin main` just succeeded — the ' +
          'fetched content may not have this file at this ref. Check the file path, not ' +
          'the network or the fetch (which already worked), then try again.';
      }
      console.error(failureMessage);
    }
    // #2599/A41: the row-content-drift sub-check inside `checkLiveView`
    // compares this TRACKED, currently-committed copy of the live view
    // against the published snapshot — not the register — see
    // `parseLiveViewRowBodies`'s own header for why. Read the same way the
    // no-flag path below reads it.
    const trackedLiveViewHtml = read(LIVE_VIEW);
    const publishedErrors = checkLiveView(text, publishedHtml, {
      direction: 'extraOnly',
      baselineText: baseline.registerText,
      dischargingIds,
      trackedLiveViewHtml,
      baselineLiveViewText: baseline.liveViewText,
    });
    // The fail-closed "cannot verify" case (#2199) does not mean the
    // register IS behind (that's unknown), so it gets its own label rather
    // than the "shows the register is BEHIND" framing below, which would
    // overstate what's actually known — the `baseline.failedStep` branch
    // above already printed the specific, actionable remedy. Matched by
    // IDENTITY against the shared `CANNOT_VERIFY_BASELINE_ERROR` constant,
    // not by sniffing message prose (#2199 review round 3, B2) — see that
    // constant's own comment for why.
    const cannotVerify =
      publishedErrors.length === 1 && publishedErrors[0] === CANNOT_VERIFY_BASELINE_ERROR;
    // #2272 review finding 2: an unconsumed --discharging name is a THIRD
    // failure class, distinct from both `cannotVerify` and a genuine BEHIND
    // verdict — "your flag value is wrong", not "the register is stale" and
    // not "the baseline can't be trusted". Wrapping it in the BEHIND
    // framing below is actively wrong: that framing's remedy ("Merge the
    // rows named above — already live, not yet in this register") is false
    // for a name like an already-registered row, and an agent following it
    // literally would add a duplicate and trip check 4a's document-wide ID
    // uniqueness check.
    // Partitioned by the shared `DISCHARGE_NAME_ERROR_PREFIX` — see that
    // constant's own comment for why a prefix, not an identity match, is the
    // right tool here. Skipped entirely when `cannotVerify` — in that case
    // `checkLiveView` returned only the single cannot-verify error, before
    // it ever got to evaluating any `--discharging` name.
    const dischargeNameErrors = cannotVerify
      ? []
      : publishedErrors.filter((e) => e.startsWith(DISCHARGE_NAME_ERROR_PREFIX));
    // #2599/A41: content-drift errors are their own class — see
    // ROW_CONTENT_DRIFT_ERROR_PREFIX's own comment for why they can't share
    // the structural BEHIND bucket's remedy.
    const contentDriftErrors = cannotVerify
      ? []
      : publishedErrors.filter((e) => e.startsWith(ROW_CONTENT_DRIFT_ERROR_PREFIX));
    const behindErrors = cannotVerify
      ? []
      : publishedErrors.filter(
          (e) =>
            !e.startsWith(DISCHARGE_NAME_ERROR_PREFIX) &&
            !e.startsWith(ROW_CONTENT_DRIFT_ERROR_PREFIX),
        );

    let publishedFailed = false;
    if (cannotVerify) {
      publishedFailed = report(`${publishedPath} could not be checked`, publishedErrors);
    } else {
      if (dischargeNameErrors.length > 0) {
        publishedFailed =
          report(
            '--discharging named an ID that does not account for any live-only row',
            dischargeNameErrors,
          ) || publishedFailed;
        console.error(
          'Fix the --discharging value(s) named above — each error explains why that ID ' +
            "didn't match — then re-run this command against the SAME saved copy from step 1.",
        );
      }
      if (contentDriftErrors.length > 0) {
        publishedFailed =
          report(
            `${publishedPath} (the currently-PUBLISHED page, fetched just now) has row content ` +
              `that differs from ${REGISTER}`,
            contentDriftErrors,
          ) || publishedFailed;
        console.error(
          'Do not publish until this is reconciled. Each row named above has the same ID on ' +
            'both sides but different body text — check which side is actually correct (the ' +
            'live page may have been hand-edited or reverted independently of this register, ' +
            'or this register may simply not have caught up with it yet) and update the other ' +
            'side to match before re-running this command against the SAME saved copy from step 1.',
        );
      }
      if (behindErrors.length > 0) {
        const behindFailed = report(
          `${publishedPath} (the currently-PUBLISHED page, fetched just now) shows the ` +
            `register is BEHIND what is already live`,
          behindErrors,
        );
        publishedFailed = publishedFailed || behindFailed;
        if (behindFailed) {
          console.error(
            'Do not publish. Merge the rows named above — already live, not yet in this ' +
              'register — then re-run this command against a fresh copy of the (still-current) ' +
              'published page before publishing, per the "Live view" section of the register.',
          );
        }
      }
    }
    if (!publishedFailed) {
      // A prior version of this mode was silent on success — indistinguishable
      // at the console (and to a test asserting only on the exit code) from
      // the CLI block never having run at all. Echo explicitly, mirroring
      // release-notes-gate.mjs's own `[…] OK — …` convention.
      console.log(`check:onbox-register: OK — ${REGISTER} is not behind ${publishedPath}.`);
    }
    // The cannotVerify case prints nothing extra here: the
    // CANNOT_VERIFY_BASELINE_ERROR text `report()` already printed above
    // ends with "Do not publish until this passes." on its own (#2199
    // review round 5, nit 2: this line used to print that exact sentence a
    // second time).
    if (publishedFailed) throw new CliExitError(1);
    return;
  }

  const liveViewHtml = read(LIVE_VIEW);

  // Both checks always run — the live-view comparison is reported even when
  // the markdown is internally inconsistent, so one PR sees both problems
  // rather than discovering the second only after fixing the first.
  const registerFailed = report(`${REGISTER} is not internally consistent`, checkRegister(text));
  const liveViewFailed = report(
    `${LIVE_VIEW} does not agree with ${REGISTER}`,
    checkLiveView(text, liveViewHtml),
  );

  // Same silent-success gap as --against-published above, closed the same
  // way: a broken `invokedAsCli` and a genuine pass both used to read as
  // "exit 0, no output" — indistinguishable to a test asserting only on the
  // exit code.
  if (!registerFailed && !liveViewFailed) {
    console.log(`check:onbox-register: OK — ${REGISTER} and ${LIVE_VIEW} agree.`);
  }

  if (registerFailed || liveViewFailed) throw new CliExitError(1);
}

if (isDirectlyInvoked(import.meta.url)) {
  try {
    runCheckOnboxRegisterCli();
  } catch (err) {
    if (err instanceof CliExitError) {
      process.exitCode = err.code;
    } else {
      throw err;
    }
  }
}
