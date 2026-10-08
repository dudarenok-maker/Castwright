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

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { scrubGitEnv } from './git-env.mjs';
import { ghSpawn } from './gh.mjs';
import { isDirectlyInvoked } from './lib/is-main-module.mjs';
import { parsePublishToken, publishTokenRegex } from './publish-token.mjs';

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
export function stripFences(text) {
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
// CLI's local, working-tree copy of the live view (including any uncommitted
// edits in the publish workflow); see the CLI layer for where it's read from
// disk.
//
// Splits on each `<details class="item">` row wrapper (the one shape the
// tracked live view and every `--against-published` snapshot both use — see
// `parseLiveViewSections`'s own header for the section-level version of this
// same split-and-scan approach), reads the row ID from its `<span
// class="num">`, and hashes both the `<summary>` content (ID/title/risk badge)
// and the `<div class="body">...</div>` content. The summary is included to
// catch drifts in the risk badge or title, which are part of the row's
// documented state — a stale risk badge is a content regression like a changed
// body paragraph. A row whose ID isn't a plain `<Letter><N>` (the
// Blocked/Unconfirmed sections use `—`) is skipped, the same convention
// `parseLiveViewSections` already filters on. A block with no matching
// `<summary>...</summary>` or `<div class="body">...</div>` (an extraction
// failure, e.g. the markup changed) is an error rather than silently skipped —
// a silent skip would mean comparing fewer rows than the page carries and
// reporting a vacuous pass.
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
        `${EXTRACTION_ERROR_PREFIX}Row block ${blockIndex + 1}: could not extract row ID from <span class="num">. The markup may be missing or malformed.`,
      );
      continue;
    }
    const id = idMatch[1].trim();
    if (!/^[A-Z]\d+$/.test(id)) continue;
    const summaryMatch = block.match(/<summary>([\s\S]*?)<\/summary>/);
    if (!summaryMatch) {
      errors.push(
        `${EXTRACTION_ERROR_PREFIX}Row ${id}: could not extract summary content from <summary>. The markup may be missing or malformed.`,
      );
      continue;
    }
    const bodyMatch = block.match(/<div class="body">([\s\S]*?)<\/div>\s*<\/details>/);
    if (!bodyMatch) {
      errors.push(
        `${EXTRACTION_ERROR_PREFIX}Row ${id}: could not extract body content from <div class="body">. The markup may be missing or malformed (e.g., class attribute was modified).`,
      );
      continue;
    }
    const summaryText = htmlCellText(summaryMatch[1]);
    const bodyText = htmlCellText(bodyMatch[1]);
    bodies.set(id, summaryText + '\n' + bodyText);
  }
  return { bodies, errors };
}

function hashRowContent(plainText) {
  return createHash('sha256').update(plainText).digest('hex');
}

// #3529: row ID -> normalised title (the `<span class="iname">` in each
// `<details class="item">` summary), read the same way
// `parseLiveViewRowBodies` reads rows. Normalised with `htmlCellText` (tags
// and whitespace) plus the handful of entities a hand-authored page uses, so
// only a genuinely different title compares unequal. Rows whose ID is not a
// plain `<Letter><N>` (Blocked/Unconfirmed use `—`) are skipped, as there.
const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function rowTitleKey(html) {
  return htmlCellText(html)
    .replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (m, dec, hex, name) => {
      if (dec) return String.fromCodePoint(Number(dec));
      if (hex) return String.fromCodePoint(parseInt(hex, 16));
      return HTML_ENTITIES[name.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}
export function parseLiveViewRowTitles(liveViewHtml) {
  const titles = new Map();
  for (const block of liveViewHtml.split(/<details\b[^>]*\bclass="item"[^>]*>/).slice(1)) {
    const idMatch = block.match(/<span class="num">([^<]*)<\/span>/);
    const nameMatch = block.match(/<span class="iname">([\s\S]*?)<\/span>/);
    if (!idMatch || !nameMatch) continue;
    const id = idMatch[1].trim();
    if (/^[A-Z]\d+$/.test(id)) titles.set(id, rowTitleKey(nameMatch[1]));
  }
  return titles;
}

// #3529: row ID -> its whole `<details class="item">…</details>` block, raw
// except for line endings — the unit `--publishing` compares byte-for-byte
// against the live page, so a union file carries another lane's row exactly
// as that lane published it.
export function parseLiveViewRowBlocks(liveViewHtml) {
  const blocks = new Map();
  for (const m of liveViewHtml.matchAll(/<details\b[^>]*\bclass="item"[^>]*>[\s\S]*?<\/details>/g)) {
    const idMatch = m[0].match(/<span class="num">([^<]*)<\/span>/);
    if (!idMatch) continue;
    const id = idMatch[1].trim();
    if (/^[A-Z]\d+$/.test(id)) blocks.set(id, m[0].replace(/\r\n/g, '\n'));
  }
  return blocks;
}

// #3529 (PR #3532 review pass 2, 🟠3): THE union a lane publishes when the
// live page carries rows of a lane that has not merged — your tracked live
// view, plus each carried row's live `<details>` block copied verbatim, with
// the derived figures regenerated. It is deterministic, so `--publishing`
// can require the file about to be published to BE this, byte for byte (line
// endings aside), and `--build-union <out>` writes it. That is the simpler of
// the two sound options the review named: a union register (and so
// `register:build` itself) cannot be built, because the other lane's
// markdown rows are not on this branch.
//
// - Each block goes into its group's section, before the first row with a
//   higher number (else after the last row), at that row's indentation.
// - The derived figures are what `register:build` writes for a register
//   holding your rows plus the carried ones: the owed count, the group's
//   glance-table count and its section's `gcount`, each raised by the number
//   of rows carried. The strip's other tiles — groups, Blocked, Unconfirmed,
//   A1, oldest debt — are your register's: a carried row is another lane's
//   numbered row in a group your page already has, and the oldest debt stays
//   yours (a carried row's own date is not on this branch to compare).
// - A carried row whose group has no section in your live view is refused
//   (that lane added a new group: let it merge first), as is a row already
//   in your view or absent from the live page.
// Throws an Error with an operator-facing message on any refusal.
const ROW_BLOCK_REGEX = /<details\b[^>]*\bclass="item"[^>]*>[\s\S]*?<\/details>/g;
const GROUP_SECTION_REGEX = /<section\b[^>]*\bclass=\u0022group(?:\s[^\u0022]*)?\u0022[^>]*>/g;
function findGroupSection(html, letter) {
  for (const m of html.matchAll(GROUP_SECTION_REGEX)) {
    const end = html.indexOf('</section>', m.index);
    if (end === -1) continue;
    const tag = html.slice(m.index, end).match(/<span class="gtag">([^<]*)<\/span>/);
    if (tag && tag[1].trim() === letter) return { start: m.index, end };
  }
  return null;
}
function indentBefore(html, index) {
  const lineStart = html.lastIndexOf('\n', index - 1) + 1;
  const indent = html.slice(lineStart, index);
  return /^[ \t]*$/.test(indent) ? indent : '';
}
export function buildUnionLiveView(trackedHtml, liveHtml, carriedIds) {
  const liveBlocks = parseLiveViewRowBlocks(stripHtmlComments(liveHtml.replace(/\r\n/g, '\n')));
  let html = trackedHtml.replace(/\r\n/g, '\n');
  const ids = [...new Set(carriedIds)].sort((a, b) =>
    a[0] === b[0] ? Number(a.slice(1)) - Number(b.slice(1)) : a < b ? -1 : 1,
  );
  const added = new Map();
  for (const id of ids) {
    const block = liveBlocks.get(id);
    if (block === undefined) throw new Error(`row ${id} is not on the live page, so there is no live block to carry.`);
    const letter = id[0];
    const section = findGroupSection(html, letter);
    if (!section) {
      throw new Error(
        `row ${id} belongs to Group ${letter}, which has no section in your live view — the lane that owns it added a new group. Let that lane merge first rather than carrying a whole group.`,
      );
    }
    const rows = [...html.slice(section.start, section.end).matchAll(ROW_BLOCK_REGEX)].map((m) => ({
      index: section.start + m.index,
      end: section.start + m.index + m[0].length,
      id: (m[0].match(/<span class="num">([^<]*)<\/span>/)?.[1] ?? '').trim(),
    }));
    if (rows.some((r) => r.id === id)) throw new Error(`row ${id} is already in your live view; only carry rows it lacks.`);
    const next = rows.find((r) => /^[A-Z]\d+$/.test(r.id) && r.id[0] === letter && Number(r.id.slice(1)) > Number(id.slice(1)));
    if (next) {
      html = `${html.slice(0, next.index)}${block}\n${indentBefore(html, next.index)}${html.slice(next.index)}`;
    } else if (rows.length > 0) {
      const last = rows[rows.length - 1];
      html = `${html.slice(0, last.end)}\n${indentBefore(html, last.index)}${block}${html.slice(last.end)}`;
    } else {
      const headerEnd = html.indexOf('\n', html.indexOf('</h3>', section.start));
      if (headerEnd === -1 || headerEnd > section.end) throw new Error(`Group ${letter}'s section in your live view has no header to place row ${id} after.`);
      html = `${html.slice(0, headerEnd)}\n    ${block}${html.slice(headerEnd)}`;
    }
    added.set(letter, (added.get(letter) ?? 0) + 1);
  }
  if (ids.length === 0) return html;
  const owed = html.match(/<div class="n owed">(\d+)<\/div>/);
  if (!owed) throw new Error('your live view has no `<div class="n owed">N</div>` to raise.');
  html = html.replace(owed[0], () => `<div class="n owed">${Number(owed[1]) + ids.length}</div>`);
  for (const [letter, count] of added) {
    const table = html.match(/<table class="glance">[\s\S]*?<\/table>/);
    const row = table && [...table[0].matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)].find((tr) => {
      const first = tr[0].match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/);
      return first && htmlCellText(first[1]) === letter;
    });
    const cells = row ? [...row[0].matchAll(/(<t[dh][^>]*>)([\s\S]*?)(<\/t[dh]>)/g)] : [];
    const lastCell = cells[cells.length - 1];
    const numberMatch = lastCell?.[2].match(/(^|>)(\s*)(\d+)(\s*)(<|$)/);
    if (!numberMatch) throw new Error(`your live view's glance table has no count for Group ${letter} to raise.`);
    const newCell = `${lastCell[1]}${lastCell[2].replace(numberMatch[0], () => `${numberMatch[1]}${numberMatch[2]}${Number(numberMatch[3]) + count}${numberMatch[4]}${numberMatch[5]}`)}${lastCell[3]}`;
    const newRow = row[0].replace(lastCell[0], () => newCell);
    html = html.replace(table[0], () => table[0].replace(row[0], () => newRow));
    const section = findGroupSection(html, letter);
    const sectionHtml = html.slice(section.start, section.end);
    const gcount = sectionHtml.match(/<span class="gcount">(\d+) rows?<\/span>/);
    if (!gcount) throw new Error(`Group ${letter}'s section in your live view has no gcount to raise.`);
    const n = Number(gcount[1]) + count;
    html = `${html.slice(0, section.start)}${sectionHtml.replace(gcount[0], () => `<span class="gcount">${n} ${n === 1 ? 'row' : 'rows'}</span>`)}${html.slice(section.end)}`;
  }
  return html;
}

// #3529: every `<Letter><N>` row ID a live-view file carries, anywhere in it.
function liveViewRowIdSet(liveViewHtml) {
  const ids = new Set();
  for (const m of stripHtmlComments(liveViewHtml).matchAll(/<span class="num">([^<]*)<\/span>/g)) {
    const id = m[1].trim();
    if (/^[A-Z]\d+$/.test(id)) ids.add(id);
  }
  return ids;
}

// #3529: row ID -> the rest of its `### <Letter><N> …` register heading,
// whitespace-collapsed. Register-to-register only, so both sides share one
// markdown convention and no HTML normalisation is needed.
export function parseRegisterRowTitles(registerText) {
  const titles = new Map();
  const { text } = stripFences(registerText);
  for (const m of text.matchAll(/^### ([A-Z]\d+)(?=\s|\r?$)([^\r\n]*)\r?$/gm)) {
    titles.set(m[1], m[2].replace(/\s+/g, ' ').trim());
  }
  return titles;
}

// #3529 (PR #3532 review pass 2, 🟠2; operator decision 3 on #3529): the
// "Retired carried rows" record. A row another lane published whose PR was
// closed without merging would otherwise have to be carried by every later
// publish forever. Listing it here drops it from that must-carry set; the
// `--against-published` run confirms through `gh` that the PR really is
// closed and unmerged and (operator decision 4) that its head branch is the
// branch that first committed the row, so the record cannot mute a live lane.
//
// The section is OPTIONAL: `checkRegister` is retro-applied to origin/main's
// copy (see this file's header), so requiring it would break every
// `--against-published` run until the section reached main. When present it
// must hold the table below, which a reason cell cannot contain a `|` in.
// Returns `{ entries: [{ id, pr, date, reason }], errors }`.
export const RETIRED_SECTION_TITLE = 'Retired carried rows';
const RETIRED_TABLE_HEADER = ['Row', 'Owning PR', 'Closed unmerged', 'Reason'];
export function parseRetiredCarriedRows(registerText) {
  const { text } = stripFences(registerText);
  const section = splitSections(text).find((s) => s.title === RETIRED_SECTION_TITLE);
  if (!section) return { entries: [], errors: [] };
  const where = `The "## ${RETIRED_SECTION_TITLE}" section`;
  const tableLines = section.body
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => /^\|.*\|\s*$/.test(l));
  const cellsOf = (line) =>
    line
      .trim()
      .slice(1, -1)
      .split('|')
      .map((c) => c.trim());
  const header = tableLines[0] ? cellsOf(tableLines[0]) : [];
  if (
    header.join('|') !== RETIRED_TABLE_HEADER.join('|') ||
    !tableLines[1] ||
    !cellsOf(tableLines[1]).every((c) => /^:?-+:?$/.test(c))
  ) {
    return {
      entries: [],
      errors: [
        `${where} has no "| ${RETIRED_TABLE_HEADER.join(' | ')} |" table (a header row and its separator row). Keep the table even when it is empty.`,
      ],
    };
  }
  const entries = [];
  const errors = [];
  const seen = new Set();
  for (const line of tableLines.slice(2)) {
    const cells = cellsOf(line);
    if (cells.length !== 4) {
      errors.push(`${where}: "${line.trim()}" must have exactly four cells — row ID, owning PR, closed-unmerged date, reason.`);
      continue;
    }
    const [id, pr, date, reason] = cells;
    const problems = [];
    if (!/^[A-Z]\d+$/.test(id)) problems.push(`"${id}" is not a row ID (a letter and a number, e.g. B103)`);
    if (!/^#\d+$/.test(pr)) problems.push(`the owning PR "${pr}" must be a PR reference such as #3505`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) problems.push(`the closed-unmerged date "${date}" must be YYYY-MM-DD`);
    if (!reason) problems.push('the reason is empty');
    if (problems.length > 0) {
      errors.push(`${where}: "${line.trim()}": ${problems.join('; ')}.`);
      continue;
    }
    if (seen.has(id)) {
      errors.push(`${where} lists ${id} more than once — one entry per row.`);
      continue;
    }
    seen.add(id);
    entries.push({ id, pr: Number(pr.slice(1)), date, reason });
  }
  return { entries, errors };
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

  // #3529: the "Retired carried rows" record's shape, and no entry for a row
  // this register still has — a retired row is one whose lane never merged.
  const retired = parseRetiredCarriedRows(text);
  errors.push(...retired.errors);
  for (const { id } of retired.entries) {
    if (seenRowIds.has(id)) {
      errors.push(
        `The "## ${RETIRED_SECTION_TITLE}" section lists ${id}, which is still a row in this register. A retired carried row is one whose lane closed without merging — remove the entry or the row.`,
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

// #3116: "did the live view's RENDERED content change since <ref> without the
// publish counter moving." A stamp commit sitting somewhere in a branch's
// history proves nothing about its LATEST content — only comparing the tip
// against a base ref catches an unstamped edit landed after that stamp. This
// is deliberately weaker than publish-token.mjs's `comparePublishTokens` (no
// nonce-in-history search, no rebase/behind-main diagnosis): it answers one
// question — "did content drift while the counter sat still" — for a check
// that must also stay `git`-free at its core so it is unit-testable without a
// scratch repo (the CLI layer supplies the two HTML strings; see
// `resolveStampedSinceBaseline` for how the `<ref>` side is read).
//
// Content comparison ignores HTML comments (the header comment and the
// `<!-- BEGIN GENERATED:... -->` markers are not rendered) and ignores the
// token itself (`stripHtmlComments` already strips comments elsewhere in this
// file; reused here rather than reimplemented, same reasoning as sharing
// `parsePublishToken` with the stamper). Blanking the token's two attribute
// values — not stripping the whole marker — keeps the rest of the diff
// positional, though nothing here depends on that.
//
// A missing or malformed token on EITHER side fails closed: a missing token
// is not "no change", it's "cannot tell whether there was a change".
export function checkStampedSince({ workingHtml, baselineHtml }) {
  const blankToken = (html) =>
    stripHtmlComments(html).replace(publishTokenRegex(), 'data-published-as="" data-publish-id=""');

  if (blankToken(workingHtml) === blankToken(baselineHtml)) return [];

  const w = parsePublishToken(workingHtml);
  const b = parsePublishToken(baselineHtml);

  if (w === null) {
    return [
      "Publish token: the live view's content changed, but the tracked copy has no publish " +
        'token at all. Run `npm run stamp:publish-token` — never hand-edit the counter.',
    ];
  }
  if (w.malformed) {
    return [`Publish token (tracked): ${w.malformed}. Fix it, then run \`npm run stamp:publish-token\`.`];
  }
  if (b === null) {
    return [
      "Publish token: the live view's content changed since the base ref, but the base ref's " +
        'copy has no publish token at all — investigate before trusting this comparison.',
    ];
  }
  if (b.malformed) {
    return [`Publish token (base ref): ${b.malformed}. Investigate before trusting this comparison.`];
  }

  if (w.n < b.n) {
    return [
      `Publish token: the live view's rendered content changed since the base ref, but the ` +
        `publish counter is BEHIND (${w.n} vs ${b.n}). This is the "undo a bad fold" shape: ` +
        `rebase or re-derive from the base ref; do not just bump the number.`,
    ];
  }
  if (w.n === b.n) {
    return [
      `Publish token: the live view's rendered content changed since the base ref, but the ` +
        `publish counter (data-published-as) stayed at ${w.n} on both sides. Run ` +
        '`npm run stamp:publish-token` — never hand-edit the number — then commit the result.',
    ];
  }
  // w.n > b.n is unconditionally true here (both earlier branches returned), but stating
  // it documents the predicate: when counter is higher AND nonce is unchanged, that's a
  // hand-edit. Keeping it guards against future branch reordering.
  if (w.n > b.n && w.nonce === b.nonce) {
    return [
      `Publish token: the counter moved (${b.n} → ${w.n}), but the nonce stayed the same. ` +
        `This is a hand-edited counter, bypassing the stamp command. Run ` +
        '`npm run stamp:publish-token` — never hand-edit the number.',
    ];
  }

  return [];
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
// consistency check is a required step in `verify.yml`'s `lint-and-checks` job
// on every PR), and from that point
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
  // #3529: origin/main's own next-id marker per group — an allocation surface
  // a collision's renumber target must clear (allocate-once), NOT a provenance
  // signal: an open lane's rows drop below it as soon as another lane minting
  // in the same group merges first. `checkRegister` already vouched that
  // every group has a marker. `rowTitles` feeds the merged-lane collision
  // check (same ID on main and here, absent at the merge-base).
  const nextIds = new Map();
  for (const section of baselineSections) {
    const titleMatch = section.title.match(/^Group ([A-Z])\b/);
    if (!titleMatch) continue;
    nextIds.set(titleMatch[1], parseNextIdMarker(section.body, titleMatch[1]));
  }
  return {
    tableLetters: new Set(baselineTableGroups.keys()),
    bodyGroups: baselineBodyGroups,
    nextIds,
    rowTitles: parseRegisterRowTitles(baselineText),
  };
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
// entirely. The prefix is deliberately distinctive to avoid accidental
// collision with other error strings that might happen to start with 'row '.
export const ROW_CONTENT_DRIFT_ERROR_PREFIX = 'row-content-drift: ';

// #2599 Finding 3: the prefix for extraction errors from live-view HTML parsing.
// These are distinct from BEHIND/drift errors and need their own remedy message.
// An extraction failure means the check couldn't parse the HTML, not that
// content drifted — the operator needs to fix the markup, not reconcile content
// or merge rows. Routed to its own bucket in the CLI, not the BEHIND bucket.
export const EXTRACTION_ERROR_PREFIX = 'extraction-error: ';

// #2837 Finding 1: the prefix for 3-way content-difference warnings. A 3-way
// disagreement between tracked, published, and baseline is ordinarily just a
// multi-step pending-publish (edit, publish, then edit again before merging) —
// hash-only comparison cannot distinguish this common shape from a genuine
// conflict. These are reported as visible warnings (never silent), but do NOT
// block the publish (do not add to the errors array that drives exit 1). The
// operator can reconcile manually if needed, but an ordinary multi-step publish
// must not hard-fail.
export const THREE_WAY_CONTENT_WARNING_PREFIX = 'three-way-warning: ';

// #3529: four failure classes the structural BEHIND remedy ("merge the rows
// named above") is wrong for, so the CLI routes them to their own buckets —
// same reason as the prefixes above. A row-ID collision's fix is to RENUMBER
// your row; an unmerged lane's live-only row's fix is to publish a file that
// carries it (`--publishing`) or coordinate with that lane; an unknown
// provenance's fix is to fetch the publishing branch or confirm it by hand;
// a `--publishing` file whose copy of a row differs from the live block's
// fix is to copy that block verbatim. None of them is "merge it in".
export const ROW_ID_COLLISION_ERROR_PREFIX = 'row-id-collision: ';
export const UNMERGED_LANE_ROW_ERROR_PREFIX = 'unmerged-lane-row: ';
export const UNKNOWN_PROVENANCE_ERROR_PREFIX = 'unknown-provenance: ';
export const PUBLISHING_FILE_ERROR_PREFIX = 'publishing-file: ';
// #3529 (PR #3532 review pass 2, 🟠2): a "Retired carried rows" entry the
// check will not honour (its PR is open, merged or unreadable, or the table
// is malformed) — and the advisory, non-blocking warning printed when `gh`
// cannot confirm an entry, which is then accepted.
export const RETIRED_ROW_ERROR_PREFIX = 'retired-carried-row: ';
export const RETIRED_ROW_WARNING_PREFIX = 'retired-row-warning: ';

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
//     #3529: "origin/main lacks it" alone does NOT prove a discharge — a row
//     an UNMERGED lane published has the same shape (#2199 review round 3,
//     A3, accepted that as a residual; the 2026-10-07 #3525/#3505 incident
//     showed it is the common case, not an edge). Content cannot separate
//     them, so `options.publishedProvenance` supplies PROVENANCE instead: the
//     commit that stamped the live page's `data-publish-id`, resolved by the
//     CLI layer (`resolvePublishedProvenance`) as one of
//       - 'merged'   — that commit is reachable from origin/main;
//       - 'own'      — it is in this branch's HEAD history, not main's;
//       - 'unmerged' — it exists only on another branch;
//       - 'unknown'  — no history this checkout has contains it (or the
//                      page carries no token, or the lookup failed).
//     plus `stampedRowIds`, the rows the live view AT that commit carried.
//     A live-only row origin/main lacks is then silent only when the page is
//     a merged or own publish AND that commit carried the row (a discharge,
//     or your own row you since dropped). Every other such row belongs to a
//     lane that has not merged — the whole page for 'unmerged', and a row a
//     union publish carried in on top of its own commit for 'merged'/'own' —
//     and fails as `unmerged-lane-row`. 'unknown' fails closed, but only when
//     a verdict actually depends on it. An earlier draft of #3529 used
//     origin/main's `next-id` instead ("below it ⇒ discharged"); it failed
//     open as soon as another lane minting in the same group merged first,
//     and never saw a brand-new group letter at all (PR #3532 review pass 1).
//     A caller that passes no provenance gets 'unknown'.
//
//     The stamping commit is the OLDEST commit that introduced the nonce, not
//     the merge commit that later brought it to main (PR #3532 review pass 2).
//
//     #3529 (review pass 2): two more ways a live-only row is silent.
//     `options.mainEverCarried(id)` answers whether origin/main's register
//     has EVER carried the row on main's own first-parent line — a row main
//     held and dropped was discharged there (CLI: `resolveMainEverCarried`;
//     review pass 3 narrowed it from every reachable commit, see there). And
//     a row listed in the register's "Retired carried rows" record (this
//     register's or origin/main's) is no longer carried, provided
//     `options.retiredPrStates` (CLI: `resolveRetiredPrStates`) confirms its
//     PR is closed unmerged and (review pass 3, operator decision 4) that PR's
//     head branch is among the branches `options.rowOwnerLookup` finds for the
//     row; an open or merged PR, a different branch, or an owner that cannot
//     be found fails as `retired-carried-row`, and `gh` being unavailable is
//     a warning that accepts the entry. `options.rowOwnerLookup` (CLI:
//     `resolveRowOwner`) also names an `unmerged-lane-row`'s owner; without
//     it the error says the owner is unknown and that the publish id names
//     the page's publisher, not necessarily the row's owner.
//     `options.carryOut`, a Set, receives every live row this run found that
//     publishing would drop and that is not yours to drop — what
//     `--build-union` carries.
//
//     #3529: `options.publishingHtml` is the file actually about to be
//     published, when it is not the tracked live view — a union carrying
//     another lane's rows. A row that would otherwise fail as BEHIND or
//     `unmerged-lane-row` passes when that file carries the live page's block
//     for it byte-for-byte (line endings aside); a different copy fails as
//     `publishing-file`. Rows the check already treats as discharges are not
//     consulted against it. The file as a whole must be exactly
//     `buildUnionLiveView(tracked, live, <the rows it carries>)` (review pass
//     2, 🟠3): every tracked row byte-for-byte, every other row a verbatim
//     live block, and the derived figures regenerated — anything else fails
//     as `publishing-file`.
//
//     #3529: `options.mergeBaseText` is the register at merge-base(HEAD,
//     origin/main). A row ID origin/main and this register BOTH carry under
//     different titles, which the merge-base lacks, was minted independently
//     by two lanes and the other merged first — a `row-id-collision`. `null`
//     (unresolvable) fails closed, but only for such a shared ID — the one
//     case the merge-base decides (review pass 2, 🟡3); `undefined` skips
//     that one check.
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
//     the baseline disambiguates three cases:
//     - If tracked matches baseline but published differs → genuine drift:
//       the published page was reverted or hand-edited independently, so it
//       now differs from the merged baseline. Report this as an error.
//     - If published matches baseline but tracked differs → ordinary
//       pending-publish: the tracked copy has uncommitted local edits ahead
//       of origin/main, but the live page hasn't changed yet (still at
//       baseline). This is the normal pre-merge state — don't report.
//     - If all three differ → unresolvable 3-way conflict: cannot tell which
//       is correct from hashes alone. Ordinarily this is just a multi-step
//       edit (publish, then edit again before merging), but hash-only
//       comparison cannot distinguish from a genuine conflict. Report as an
//       advisory warning, not a hard error (see THREE_WAY_CONTENT_WARNING_PREFIX).
//     When the baseline can't be resolved, content hashing is skipped rather
//     than using a missing baseline as "no drift" — matching the fail-closed
//     approach the register-side baseline already uses.
export function checkLiveView(
  markdownText,
  rawLiveViewHtml,
  {
    direction = 'both',
    baselineText,
    dischargingIds = [],
    trackedLiveViewHtml,
    baselineLiveViewText,
    publishedProvenance,
    publishingHtml,
    mergeBaseText,
    mainEverCarried,
    rowOwnerLookup,
    retiredPrStates,
    carryOut,
  } = {},
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
  const { groups: mdGroups } = parseGlanceTable(glanceSection.body);
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
  let baselineNextIds = null;
  let baselineRowTitles = null;
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
    baselineNextIds = baseline.nextIds;
    baselineRowTitles = baseline.rowTitles;
  }

  // #3529: provenance of the published page — see the header comment.
  const provenance = publishedProvenance ?? {
    kind: 'unknown',
    nonce: null,
    reason: 'no provenance was supplied for the published page',
  };
  const stampedRowIds = new Set(provenance.stampedRowIds ?? []);
  const isOwnRow = (id) =>
    (provenance.kind === 'merged' || provenance.kind === 'own') && stampedRowIds.has(id);
  // Rows whose verdict needed a provenance this run does not have; reported
  // once, at the end.
  const unknownProvenanceIds = [];
  // Live rows publishing would drop that are not this lane's to drop.
  const carry = carryOut instanceof Set ? carryOut : new Set();

  // #3529 (review pass 2, 🟠2): the "Retired carried rows" record — this
  // register's entries plus origin/main's, so a branch that predates a
  // retirement still honours it. An entry is honoured only for a PR `gh`
  // confirms is closed unmerged AND (review pass 3, operator decision 4)
  // whose head branch is the branch that first committed the row
  // (`rowOwnerLookup`); without `gh` it is accepted with a warning. The
  // owner is checked lazily, only for a retired row the live page still
  // carries: once a retirement has been published, that row and its lane's
  // branch may both be gone, and the entry must not start failing.
  const retiredIds = new Set();
  const retiredCandidates = new Map();
  if (direction === 'extraOnly') {
    const entries = new Map();
    for (const entry of parseRetiredCarriedRows(baselineText).entries) entries.set(entry.id, entry);
    const mine = parseRetiredCarriedRows(markdownText);
    for (const e of mine.errors) errors.push(`${RETIRED_ROW_ERROR_PREFIX}${e}`);
    for (const entry of mine.entries) entries.set(entry.id, entry);
    for (const { id, pr } of entries.values()) {
      if (!retiredPrStates || !retiredPrStates.available) {
        retiredIds.add(id);
        errors.push(
          `${RETIRED_ROW_WARNING_PREFIX}${id} is retired as PR #${pr}'s row without confirming that #${pr} is closed and unmerged, or that it owns ${id} (${retiredPrStates?.reason ?? 'no gh lookup was made'}). Confirm both by hand — gh pr view ${pr} --json state,mergedAt,headRefName, and that branch is the one that first committed ${id} — before you publish.`,
        );
        continue;
      }
      const st = retiredPrStates.states.get(pr);
      if (!st || st.error) {
        errors.push(
          `${RETIRED_ROW_ERROR_PREFIX}${id}: the register retires it as PR #${pr}'s row, but gh could not read #${pr} (${st?.error ?? 'no answer'}). A retirement is honoured only for a PR confirmed closed without merging — fix the PR reference, or re-run once gh can read it.`,
        );
      } else if (st.state === 'CLOSED' && !st.mergedAt) {
        retiredCandidates.set(id, { pr, headRefName: st.headRefName ?? null });
      } else {
        const state = st.state === 'MERGED' || st.mergedAt ? 'MERGED' : st.state;
        errors.push(
          `${RETIRED_ROW_ERROR_PREFIX}${id}: the register retires it as PR #${pr}'s row, closed without merging, but #${pr} is ${state}. ${state === 'MERGED' ? 'A merged lane is not one whose rows need retiring' : 'An open lane still owns that row, and the record cannot retire it'} — remove the entry; until then the row must still be carried.`,
        );
      }
    }
  }
  // Decision 4: a closed-unmerged retirement is honoured only once the row's
  // owner is confirmed to be that PR's head branch. Memoised; a refusal is
  // reported once, and the row then still has to be carried.
  const retiredOwnerMemo = new Map();
  const isRetired = (id) => {
    if (retiredIds.has(id)) return true;
    const candidate = retiredCandidates.get(id);
    if (!candidate) return false;
    if (retiredOwnerMemo.has(id)) return retiredOwnerMemo.get(id);
    const { pr, headRefName } = candidate;
    const owner = typeof rowOwnerLookup === 'function' ? rowOwnerLookup(id) : null;
    const ownerBranches = (owner?.commit ? owner.refs ?? [] : []).map((r) => r.replace(/^origin[/]/, ''));
    let reason = null;
    if (!headRefName) {
      reason = `gh did not report #${pr}'s head branch, so it cannot be matched against the branch that first committed ${id}. Re-run once gh can read it.`;
    } else if (ownerBranches.length === 0) {
      reason = `the branch that first committed ${id} cannot be determined here, so #${pr} (head branch ${headRefName}) cannot be confirmed as its owner. Fetch that branch — git fetch origin pull/${pr}/head:${headRefName} — and re-run.`;
    } else if (!ownerBranches.includes(headRefName)) {
      reason = `#${pr}'s head branch is ${headRefName}, but ${id} was first committed on ${ownerBranches.join(', ')} (${String(owner.commit).slice(0, 12)}). The record names the wrong PR — find the owner's with gh pr list --head ${ownerBranches[0]} --state all.`;
    }
    if (reason !== null) {
      errors.push(
        `${RETIRED_ROW_ERROR_PREFIX}${id}: the register retires it as PR #${pr}'s row, and a retirement is honoured only for the PR that owns the row, but ${reason} Until then the row must still be carried.`,
      );
    }
    retiredOwnerMemo.set(id, reason === null);
    return reason === null;
  };
  const everCarriedMemo = new Map();
  const everOnMain = (id) => {
    if (typeof mainEverCarried !== 'function') return false;
    if (!everCarriedMemo.has(id)) everCarriedMemo.set(id, mainEverCarried(id) === true);
    return everCarriedMemo.get(id);
  };
  const publishingBlocks =
    typeof publishingHtml === 'string'
      ? parseLiveViewRowBlocks(stripHtmlComments(publishingHtml))
      : null;
  const publishedBlocks = publishingBlocks ? parseLiveViewRowBlocks(liveViewHtml) : null;
  // A row that would fail because publishing drops it passes when the file
  // being published carries the live block verbatim ('carried'). A different
  // copy is its own failure, reported here ('differs'); none at all leaves
  // the original verdict standing ('absent').
  // Memoised: the whole-group checks consult the same row from both the
  // glance table and the section list, and a 'differs' is reported once.
  const publishingVerdicts = new Map();
  const publishingCarries = (id) => {
    if (publishingVerdicts.has(id)) return publishingVerdicts.get(id);
    const block = publishingBlocks?.get(id);
    let verdict = 'carried';
    if (block === undefined) verdict = 'absent';
    else if (publishedBlocks.get(id) === undefined) {
      verdict = 'notLive';
      errors.push(
        `${PUBLISHING_FILE_ERROR_PREFIX}${id}: the file passed to --publishing carries row ${id}, which is neither in your tracked live view nor on the live page. A union carries only live rows, verbatim — build it with --build-union <out>.`,
      );
    } else if (block !== publishedBlocks.get(id)) {
      verdict = 'differs';
      errors.push(
        `${PUBLISHING_FILE_ERROR_PREFIX}${id}: the file passed to --publishing carries row ${id}, but its block differs from the live page's. Copy the live page's <details> block for ${id} into that file verbatim (another lane's row is that lane's to edit), then re-run.`,
      );
    }
    publishingVerdicts.set(id, verdict);
    return verdict;
  };
  const stillDropped = (id) => publishingCarries(id) === 'absent';
  // A colliding row's new ID must clear every allocation surface: this
  // register's next-id, the live page's highest ID, and origin/main's next-id
  // (an ID main minted and since dropped is still spent — allocate-once).
  const renumberAdvice = (letter) => {
    const mineNext = parseNextIdMarker(
      sections.find((s) => s.title.startsWith(`Group ${letter}`))?.body ?? '',
      letter,
    );
    const liveNumbers = (lvSections.get(letter)?.rowIds ?? []).map((r) => Number(r.slice(1)));
    const liveNext = liveNumbers.length > 0 ? Math.max(...liveNumbers) + 1 : 0;
    const target = Math.max(mineNext ?? 0, liveNext, baselineNextIds?.get(letter) ?? 0);
    return `Renumber your row to ${letter}${target} (the highest of your next-id, the live page's highest ID + 1 and origin/main's next-id), then re-run.`;
  };
  // Review pass 2, 🟠2: name the row's OWNER — the lane that first committed
  // it — never the page's publisher, which for a union is only its carrier.
  const ownerText = (id) => {
    const owner = typeof rowOwnerLookup === 'function' ? rowOwnerLookup(id) : null;
    if (owner && owner.commit) {
      const branch = owner.refs?.[0]?.replace(/^origin\//, '');
      return `It was first committed in ${String(owner.commit).slice(0, 12)}${owner.refs?.length ? ` (on ${owner.refs.join(', ')})` : ''}, by the lane that owns it${branch ? ` — find its PR with \`gh pr list --head ${branch} --state all\`` : ''}.`;
    }
    return `No branch this checkout has fetched committed it, so its owner cannot be named here — fetch every branch (git fetch origin '+refs/heads/*:refs/remotes/origin/*') and re-run to name it. The page's publish id "${provenance.nonce}" names whoever PUBLISHED the page, which for a union publish is not the row's owner.`;
  };
  const unmergedLaneError = (id, letter) =>
    `${UNMERGED_LANE_ROW_ERROR_PREFIX}${id}: the live page's Group ${letter} section has row ${id}, which origin/main lacks; it belongs to a lane that has not merged. ${ownerText(id)} Publishing a file without it drops it: carry its live block verbatim in the file you publish (--build-union <out> builds it) and name that file with --publishing <file>; if that lane's PR was closed without merging, retire the row in the register's "Retired carried rows" table instead.`;
  // A live-only row origin/main lacks: 'yours' (silent: your own or a
  // merged publish's row, a row main's register has ever carried, or a
  // retired one), 'foreign' (another unmerged lane's) or 'unknown'.
  const classifyUnbaselined = (id) => {
    if (isRetired(id) || isOwnRow(id) || everOnMain(id)) return 'yours';
    return provenance.kind === 'unknown' ? 'unknown' : 'foreign';
  };
  // A live-only row origin/main lacks that publishing would drop and that is
  // not yours to drop: 'foreign' for the caller to report, or null (silent,
  // or queued as an unknown-provenance row).
  // The cheap --publishing test runs first: classifying can cost git calls.
  const liveOnlyVerdict = (id) => {
    if (!stillDropped(id)) return null;
    const verdict = classifyUnbaselined(id);
    if (verdict === 'yours') return null;
    carry.add(id);
    if (verdict === 'unknown') {
      unknownProvenanceIds.push(id);
      return null;
    }
    return 'foreign';
  };
  const baselineHasRow = (id) => {
    const [, idLetter, idNumber] = id.match(/^([A-Z])(\d+)$/);
    return (baselineBodyGroups.get(idLetter) ?? []).includes(Number(idNumber));
  };

  // The owed total, as the summary strip states it.
  const owedMatch = liveViewHtml.match(/<div class="n owed">(\d+)<\/div>/);
  if (!owedMatch) {
    errors.push(
      'Live view: no `<div class="n owed">NN</div>` found — the summary strip\'s owed total could not be read. If the markup changed, update scripts/check-onbox-register.mjs.',
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
    for (const letter of mdGroups.keys()) {
      if (!lvGroups.has(letter)) {
        // "the register has a group the live page doesn't" is the normal
        // pre-publish state (a brand-new group not yet published) — not
        // evidence of staleness. Skip in 'extraOnly' mode.
        if (direction === 'both' && !malformedLetters.includes(letter)) {
          errors.push(`Live view: Group ${letter} is missing from the glance table.`);
        }
        continue;
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
            // #3529 (review pass 2, 🟠4): only rows origin/main still has are
            // a BEHIND/--discharging question. A row it lacks is classified by
            // provenance in the section loop below, like every other live-only
            // row, so --discharging can never silence another lane's row here.
            const behindRowIds = liveRowIds.filter(baselineHasRow);
            const namedIds = behindRowIds.filter((id) => dischargingSet.has(id));
            // #3529: a row the --publishing file carries verbatim is not
            // dropped by this publish.
            const unnamedIds = behindRowIds.filter((id) => !dischargingSet.has(id) && stillDropped(id));
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
    }
    const expected = new Set(mdNumbers.map((n) => `${letter}${n}`));
    const found = new Set(section.rowIds);
    // The error message below names the SECTION the comparison was made in.
    // Without it a row filed under the wrong group reads as "extra" with
    // nothing saying where it actually sits. `expected`-has-but-`found`-lacks
    // ("missing") is the normal pre-publish state (a row not yet published,
    // or — since Task 7/8 — already covered by row-shell reconciliation's own
    // insert/delete/reorder handling) and is no longer reported here; `extra`
    // (live page has, register doesn't) is the directional signal this
    // function exists to surface, but as of #2199 it is not reported as-is: a
    // row in `extra` that origin/main ALSO lacks was deliberately discharged,
    // not left behind, so it's filtered out below before deciding whether to
    // fire.
    const extra = [...found].filter((id) => !expected.has(id));
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
    // #3529: "origin/main lacks it" alone is NOT proof of a discharge — a row
    // an UNMERGED lane added has the same shape. Provenance decides (see the
    // header comment): only a row the page's own merged/own publish committed
    // is silent. (Only rows with numeric IDs reach here: Blocked/Unconfirmed
    // rows use `—` and are never in `rowIds`, so their handling is
    // unchanged.) `--discharging` does NOT suppress another lane's row: it
    // names rows THIS change discharged, and those are already silent.
    const unmergedExtra = [];
    const staleExtra =
      direction === 'extraOnly'
        ? extra.filter((id) => {
            const idMatch = id.match(/^([A-Z])(\d+)$/);
            if (!idMatch) return true; // shouldn't happen — rowIds is pre-filtered to this shape
            const [, idLetter, idNumber] = idMatch;
            const baselineNumbers = baselineBodyGroups.get(idLetter) ?? [];
            if (!baselineNumbers.includes(Number(idNumber))) {
              if (liveOnlyVerdict(id) === 'foreign') unmergedExtra.push(id);
              return false;
            }
            // #2272: a named id suppresses exactly this BEHIND verdict — the
            // baseline (pre-merge origin/main) hasn't caught up yet because
            // this run is BEFORE merge, not because the row is a genuine
            // competing-lane addition.
            return !dischargingSet.has(id) && stillDropped(id);
          })
        : extra;
    if (staleExtra.length > 0) {
      errors.push(
        direction === 'extraOnly'
          ? `The live page's Group ${letter} section has ${staleExtra.length === 1 ? 'row' : 'rows'} ${staleExtra.join(', ')} that this register does not yet have — the register is BEHIND what is already published. Merge ${staleExtra.length === 1 ? 'it' : 'them'} in before publishing.`
          : `Live view's Group ${letter} section has ${extra.length === 1 ? 'row' : 'rows'} ${extra.join(', ')} that the register's Group ${letter} does not. A row published from an unmerged branch, or a row filed under the wrong group, is the usual cause.`,
      );
    }
    for (const id of unmergedExtra) errors.push(unmergedLaneError(id, letter));
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
          // #3529 (review pass 2, 🟠4): see the glance-table loop above. A
          // row origin/main lacks is classified here, one by one; naming it
          // in --discharging consumes the name but silences nothing.
          const behindRowIds = liveRowIds.filter(baselineHasRow);
          for (const id of liveRowIds.filter((rowId) => !baselineHasRow(rowId))) {
            if (dischargingSet.has(id)) consumedDischargingIds.add(id);
            if (liveOnlyVerdict(id) === 'foreign') errors.push(unmergedLaneError(id, letter));
          }
          const namedIds = behindRowIds.filter((id) => dischargingSet.has(id));
          // #3529: a row the --publishing file carries verbatim is not dropped.
          const unnamedIds = behindRowIds.filter((id) => !dischargingSet.has(id) && stillDropped(id));
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
        } else {
          // #3529: a group origin/main has never had — a brand-new letter.
          // Its rows are classified one by one, exactly like a live-only row
          // in a group both sides have: nothing here is keyed on a marker.
          for (const id of lvSections.get(letter)?.rowIds ?? []) {
            if (dischargingSet.has(id)) consumedDischargingIds.add(id);
            if (liveOnlyVerdict(id) === 'foreign') errors.push(unmergedLaneError(id, letter));
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
  // - If tracked matches baseline → this edit is already merged to
  //   origin/main, but the published page hasn't caught up — the classic
  //   A41 drift signature. Report it.
  // - If published matches baseline but tracked doesn't → the tracked copy
  //   has a local edit not yet merged to origin/main, and the published page
  //   is simply unchanged (still at baseline) because nothing has been
  //   published yet — the ordinary pending-publish state. Don't report.
  // - If neither matches baseline (all three disagree) → a 3-way content
  //   disagreement; report as an advisory warning (not blocking), since
  //   ordinary multi-step publishes (edit, publish, edit again before merge)
  //   trigger this and hash-only comparison cannot distinguish from conflicts.
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
    // Tag each with its source so the CLI can correctly attribute the error to
    // the right file (tracked local working tree, published live page, or baseline
    // origin/main copy) — this determines the remedy message shown to the operator.
    const taggedTrackedErrors = trackedErrors.map((e) => `${EXTRACTION_ERROR_PREFIX}[tracked] ${e.substring(EXTRACTION_ERROR_PREFIX.length)}`);
    const taggedPublishedErrors = publishedErrors.map((e) => `${EXTRACTION_ERROR_PREFIX}[published] ${e.substring(EXTRACTION_ERROR_PREFIX.length)}`);
    const taggedBaselineErrors = baselineErrors.map((e) => `${EXTRACTION_ERROR_PREFIX}[baseline] ${e.substring(EXTRACTION_ERROR_PREFIX.length)}`);
    errors.push(...taggedTrackedErrors, ...taggedPublishedErrors, ...taggedBaselineErrors);
    // #3529: same ID, genuinely different title, and origin/main has no such
    // row — two lanes each allocated it, so the by-ID comparison would call
    // them equal. Not when the live page is this lane's OWN earlier publish
    // and its commit carried the row: that is a retitle. A row origin/main
    // DOES have is the merge-base check's business (after this block).
    const trackedTitles = parseLiveViewRowTitles(stripHtmlComments(trackedLiveViewHtml));
    const publishedTitles = parseLiveViewRowTitles(liveViewHtml);
    for (const [id, trackedTitle] of trackedTitles) {
      const publishedTitle = publishedTitles.get(id);
      if (publishedTitle === undefined || publishedTitle === trackedTitle) continue;
      const [, idLetter, idNumber] = id.match(/^([A-Z])(\d+)$/);
      if ((baselineBodyGroups.get(idLetter) ?? []).includes(Number(idNumber))) continue;
      if (provenance.kind === 'own' && stampedRowIds.has(id)) continue;
      if (provenance.kind === 'unknown') {
        unknownProvenanceIds.push(id);
        continue;
      }
      errors.push(
        `${ROW_ID_COLLISION_ERROR_PREFIX}${id}: your row is "${trackedTitle}" but the live page's ${id} is "${publishedTitle}" — two lanes allocated the same ID. ${renumberAdvice(idLetter)}`,
      );
    }
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
          // Tracked matches baseline (merged to main) — the edit is already
          // committed to the branch and published. But published differs from
          // both, so this is A41-style drift: the published page was
          // independently reverted or hand-edited while baseline stayed current.
          // Genuine drift. Report it.
          errors.push(
            `${ROW_CONTENT_DRIFT_ERROR_PREFIX}${id}: content differs between local and published`,
          );
          continue;
        }
        if (publishedHash === baselineHash) {
          // Published matches baseline (unchanged since origin/main), but
          // tracked differs — the local copy has uncommitted edits not yet
          // merged to main. This is the ordinary pending-publish state:
          // published hasn't changed, tracked is ahead with local work about
          // to be published. Not drift, skip it.
          continue;
        }
        // If trackedHash !== baselineHash AND publishedHash !== baselineHash,
        // all three differ from each other — can't tell which is the source
        // of truth. This is ordinarily NOT a conflict: it's just a multi-step
        // edit before merge (publish v1, then edit to v2 locally before merging).
        // Hash-only comparison has no way to establish that published is a
        // checkpoint on the SAME edit trajectory as tracked, vs. a truly
        // independent third version. So report this as an ADVISORY WARNING
        // (visible but non-blocking) rather than a hard failure — see
        // THREE_WAY_CONTENT_WARNING_PREFIX. The operator can reconcile
        // manually if the content actually looks wrong, but an ordinary
        // multi-step-publish must not hard-fail the gate.
        errors.push(
          `${THREE_WAY_CONTENT_WARNING_PREFIX}${id}: content differs in three-way comparison (local vs published vs origin/main) — this is usually an ordinary multi-step edit before merging, not investigated further; if this row's content seems wrong, check manually`,
        );
      }
    }
  }

  // #3529 (review pass 2, 🟠3): the file about to be published, as a whole.
  // It must be exactly the union `buildUnionLiveView` builds from your
  // tracked live view and the rows it carries — so it cannot drop one of
  // your rows (S6), carry a stale copy of one, carry a row that is not live,
  // or publish hand-edited derived figures. The specific failures are named
  // first; the whole-file comparison runs only once they are clear.
  if (direction === 'extraOnly' && publishingBlocks) {
    if (typeof trackedLiveViewHtml !== 'string') {
      errors.push(
        `${PUBLISHING_FILE_ERROR_PREFIX}--publishing needs your tracked live view to compare the file against, and none was supplied.`,
      );
    } else {
      const trackedBlocks = parseLiveViewRowBlocks(stripHtmlComments(trackedLiveViewHtml));
      let comparable = true;
      for (const [id, block] of trackedBlocks) {
        const copy = publishingBlocks.get(id);
        if (copy === block) continue;
        comparable = false;
        errors.push(
          copy === undefined
            ? `${PUBLISHING_FILE_ERROR_PREFIX}${id}: the file passed to --publishing drops your own row ${id}, which your tracked live view carries — publishing it would delete that row from the live page. A union is your tracked live view PLUS other lanes' rows: build it with --build-union <out>.`
            : `${PUBLISHING_FILE_ERROR_PREFIX}${id}: the file passed to --publishing carries your row ${id}, but not as your tracked live view has it (a stale copy?). Rebuild the union from your current tracked live view with --build-union <out>.`,
        );
      }
      const carriedIds = [...publishingBlocks.keys()].filter((id) => !trackedBlocks.has(id));
      for (const id of carriedIds) {
        if (publishingCarries(id) !== 'carried') comparable = false;
      }
      if (comparable) {
        let expected = null;
        try {
          expected = buildUnionLiveView(trackedLiveViewHtml, rawLiveViewHtml, carriedIds);
        } catch (err) {
          errors.push(`${PUBLISHING_FILE_ERROR_PREFIX}the file passed to --publishing cannot be a valid union: ${err.message}`);
        }
        const actual = publishingHtml.replace(/\r\n/g, '\n');
        if (expected !== null && actual !== expected) {
          const a = actual.split('\n');
          const b = expected.split('\n');
          let i = 0;
          while (i < a.length && i < b.length && a[i] === b[i]) i++;
          const show = (line) => (line === undefined ? '<end of file>' : `"${line.trim().slice(0, 160)}"`);
          errors.push(
            `${PUBLISHING_FILE_ERROR_PREFIX}the file passed to --publishing is not your tracked live view plus the rows it carries${carriedIds.length > 0 ? ` (${carriedIds.join(', ')})` : ''}: its line ${i + 1} reads ${show(a[i])} where the union has ${show(b[i])}. The derived figures (the owed count, each carried row's group counts) are your register's plus one per carried row and are never hand-edited — build the file with --build-union <out> instead of by hand.`,
          );
        }
      }
    }
  }

  if (direction === 'extraOnly') {
    // #3529 (review pass 1): a collision with a lane that has ALREADY merged.
    // origin/main has the row, so the checks above treat it as main's; but if
    // the merge-base this branch forked from lacks it while this register
    // carries it under another title, both lanes minted it independently.
    // An unreadable merge-base fails closed only for such a shared ID, the
    // one case it decides (review pass 2, 🟡3): it is not a provenance
    // failure for any other row.
    if (typeof mergeBaseText === 'string' || mergeBaseText === null) {
      const mergeBaseIds = mergeBaseText === null ? null : new Set(parseRegisterRowTitles(mergeBaseText).keys());
      const undecidable = [];
      for (const [id, mineTitle] of parseRegisterRowTitles(markdownText)) {
        const mainTitle = baselineRowTitles.get(id);
        if (mainTitle === undefined || mainTitle === mineTitle) continue;
        if (mergeBaseIds === null) {
          undecidable.push(id);
          continue;
        }
        if (mergeBaseIds.has(id)) continue;
        errors.push(
          `${ROW_ID_COLLISION_ERROR_PREFIX}${id}: your row is "${mineTitle}" but origin/main's ${id} is "${mainTitle}", and the merge-base your branch forked from has no ${id} — two lanes allocated the same ID and the other merged first. ${renumberAdvice(id[0])}`,
        );
      }
      if (undecidable.length > 0) {
        errors.push(
          `${UNKNOWN_PROVENANCE_ERROR_PREFIX}${undecidable.join(', ')}: origin/main carries ${undecidable.length === 1 ? 'this ID' : 'these IDs'} under a different title than this register, and the register at merge-base(HEAD, origin/main) could not be read, so whether that is your retitle or another lane's row under the same ID cannot be decided. Check that HEAD and origin/main share history (an unshallowed clone), then re-run. Do not publish until this passes.`,
        );
      }
    }
    if (unknownProvenanceIds.length > 0) {
      const ids = [...new Set(unknownProvenanceIds)];
      // A live-only row can be carried; a row you share with the live page
      // under another title (the collision check) cannot — it is in your file.
      const carryable = ids.filter((id) => carry.has(id));
      const titled = ids.filter((id) => !carry.has(id));
      const them = (list) => (list.length === 1 ? 'it' : 'them');
      errors.push(
        `${UNKNOWN_PROVENANCE_ERROR_PREFIX}cannot tell who published the live page — ${provenance.reason}${provenance.nonce ? ` (publish id "${provenance.nonce}")` : ''} — so whether ${ids.join(', ')} ${ids.length === 1 ? 'is' : 'are'} yours, discharged, or another unmerged lane's cannot be decided. Fetch every branch (git fetch origin '+refs/heads/*:refs/remotes/origin/*') and re-run.` +
          (carryable.length > 0
            ? ` If that does not settle ${carryable.join(', ')}, do not drop ${them(carryable)}: carry ${them(carryable)} in the file you publish — --build-union <out> builds it — and re-run with --publishing <out>.`
            : '') +
          (titled.length > 0
            ? ` ${titled.join(', ')} ${titled.length === 1 ? 'is' : 'are'} titled differently on the live page than in your live view: establish whose row ${titled.length === 1 ? 'that is' : 'each is'} by hand (your retitle, or another lane's row under the same ID — then renumber yours).`
            : '') +
          ' Do not publish until this passes.',
      );
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
  // #3116 review finding 4: locale-pin git's stderr messages. Missing-path
  // detection depends on specific English substrings from `git show`, and
  // those strings are translated depending on the ambient LANG/LC_ALL. Setting
  // LC_ALL: 'C' ensures consistent English messages regardless of the system's
  // locale, so the check is deterministic rather than silently failing in
  // non-English environments.
  const env = scrubGitEnv();
  env.LC_ALL = 'C';
  env.LANG = 'C';
  return spawnSync('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true, env });
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
    // #3529: the frozen SHA, so provenance and the merge-base are resolved
    // against the same commit the baseline texts came from.
    fetchedSha,
  };
}

// #3529: the OLDEST commit in `ref`'s history whose live view carries
// `data-publish-id="<nonce>"` — the stamp itself — with that file's text. The
// pickaxe flags are `nonceInHistory`'s (scripts/publish-token.mjs), for the
// same three reasons its header gives — `--full-history`, the anchored `-S`,
// and `--diff-merges=first-parent` (a re-stamp made while resolving a merge
// conflict is born in the merge commit itself) — plus `-s`, without which that
// last flag streams a full patch. Pickaxe lists every commit that CHANGED the
// anchor's count. That includes the commit that later re-stamped it away and,
// on main, the PR's merge commit: along main's first parent the merge is
// where the nonce appears. So the newest hit is not the stamp. PR #3532 review
// pass 2 found it returning "Merge pull request #3501" for main's own page,
// whose rows are main's after the merge, not the publish's. Oldest-first,
// keeping the first commit that carries the anchor, is the commit step 3's
// `git log --all -S` names. `{ failed: true }` when git itself failed, so a
// failed lookup is never read as "not found".
function findStampingCommit(repoRoot, liveViewPath, nonce, ref, gitRunner) {
  const anchored = `data-publish-id="${nonce}"`;
  const log = gitRunner(
    ['log', '--format=%H', '-s', '--full-history', '--diff-merges=first-parent', '-S', anchored, ref, '--', liveViewPath],
    repoRoot,
  );
  if (log.error || log.status !== 0 || typeof log.stdout !== 'string') return { failed: true };
  for (const sha of log.stdout.split(/\s+/).filter(Boolean).reverse()) {
    const show = gitRunner(['show', `${sha}:${liveViewPath}`], repoRoot);
    if (show.error || show.status !== 0 || typeof show.stdout !== 'string') continue;
    if (show.stdout.includes(anchored)) return { sha, html: show.stdout };
  }
  return { sha: null };
}

// #3529: who published the live page — the provenance `checkLiveView`'s
// `options.publishedProvenance` consumes (see that function's header for what
// each kind means and why content alone cannot answer this). Searched in
// order: origin/main (`mainRef`, the frozen FETCH_HEAD SHA), then HEAD, then
// every ref this checkout has (`--all` — deliberately, unlike
// `nonceInHistory`: the question here is "which branch stamped it", and a
// fetched-but-unmerged lane is exactly the answer being looked for). A nonce
// in none of them, a page with no token, and a failed lookup are all
// 'unknown' — never a default to any other kind.
export function resolvePublishedProvenance(
  repoRoot,
  liveViewPath,
  publishedHtml,
  mainRef,
  gitRunner = runGitCommand,
) {
  const token = parsePublishToken(publishedHtml);
  if (token === null) {
    return { kind: 'unknown', nonce: null, reason: 'the live page carries no publish token' };
  }
  if (token.malformed) {
    return { kind: 'unknown', nonce: null, reason: `the live page's publish token is malformed: ${token.malformed}` };
  }
  const { nonce } = token;
  const lookupFailed = (ref) => ({
    kind: 'unknown',
    nonce,
    reason: `could not search ${ref}'s history for the page's publish id (a git call failed)`,
  });
  for (const [kind, ref, label] of [
    ['merged', mainRef, 'origin/main'],
    ['own', 'HEAD', 'HEAD'],
  ]) {
    const found = findStampingCommit(repoRoot, liveViewPath, nonce, ref, gitRunner);
    if (found.failed) return lookupFailed(label);
    if (found.sha) {
      return { kind, nonce, commit: found.sha, stampedRowIds: liveViewRowIdSet(found.html) };
    }
  }
  const anywhere = findStampingCommit(repoRoot, liveViewPath, nonce, '--all', gitRunner);
  if (anywhere.failed) return lookupFailed('every branch');
  if (anywhere.sha) return { kind: 'unmerged', nonce, commit: anywhere.sha };
  return {
    kind: 'unknown',
    nonce,
    reason: 'its publish id is not in any git history this checkout has (an unfetched branch, or a hand-published page)',
  };
}

// #3529: the register at merge-base(HEAD, `mainRef`), for the merged-lane
// collision check. '' when the register did not exist there yet (no rows);
// null when git could not answer, which `checkLiveView` fails closed on.
export function resolveMergeBaseRegister(repoRoot, registerPath, mainRef, gitRunner = runGitCommand) {
  const mergeBase = gitRunner(['merge-base', 'HEAD', mainRef], repoRoot);
  if (mergeBase.error || mergeBase.status !== 0 || typeof mergeBase.stdout !== 'string') return null;
  const show = gitRunner(['show', `${mergeBase.stdout.trim()}:${registerPath}`], repoRoot);
  if (show.error) return null;
  if (show.status !== 0) {
    const stderr = typeof show.stderr === 'string' ? show.stderr : '';
    return stderr.includes('does not exist in') || stderr.includes('exists on disk, but not in') ? '' : null;
  }
  return typeof show.stdout === 'string' ? show.stdout : null;
}

// #3529 (PR #3532 review pass 2, 🟠1): whether origin/main's register has
// EVER carried row `id` — any commit on `mainRef`'s FIRST-PARENT line whose
// register diff adds or removes its `### <id> ` heading. A row main held and
// dropped was discharged there, whoever published the page. `--first-parent`
// (review pass 3, 🔴): what main's register carried is what its own line
// held. Every reachable commit, as pass 2 had it, includes a merged PR
// branch's transient rows: #3525 minted B103 in f980d2c8 and renumbered it
// before merging, which made #3505's still-live B103 read as discharged.
// Main's first-parent line is mostly merge commits, so
// `--diff-merges=first-parent` is what lets `-G` see a merge's register
// change at all. `-G` is anchored to the heading and to the end of the
// number, so B10 never matches B101. Not allocate-once-proof: a colliding ID
// that reached main and was discharged while the other lane's copy is still
// live reads as carried (both lanes must have escaped both collision checks).
// `checkLiveView` asks only for a row that would otherwise fail, so the
// common run makes no call. `true`/`false`, or `null` when git failed,
// which grants no exemption.
export function resolveMainEverCarried(repoRoot, registerPath, mainRef, id, gitRunner = runGitCommand) {
  if (!/^[A-Z]\d+$/.test(id)) return false;
  const log = gitRunner(
    ['log', '--format=%H', '-s', '-n', '1', '--first-parent', '--diff-merges=first-parent', '-G', `^### ${id}[^0-9]`, mainRef, '--', registerPath],
    repoRoot,
  );
  if (log.error || log.status !== 0 || typeof log.stdout !== 'string') return null;
  return log.stdout.trim() !== '';
}

// #3529 (PR #3532 review pass 2, 🟠2): the lane that OWNS a live row — the
// oldest commit on any branch whose live view introduced the row's
// `<span class="num">` — with the branches that contain it, main excluded. A
// union publish carries another lane's row under the carrier's own publish
// id, so the page's provenance names the carrier, never the owner. `null`
// when no fetched branch committed the row, or git failed.
export function resolveRowOwner(repoRoot, liveViewPath, id, gitRunner = runGitCommand) {
  const anchored = `<span class="num">${id}</span>`;
  const log = gitRunner(
    ['log', '--all', '--format=%H', '-s', '--full-history', '--diff-merges=first-parent', '-S', anchored, '--', liveViewPath],
    repoRoot,
  );
  if (log.error || log.status !== 0 || typeof log.stdout !== 'string') return null;
  let commit = null;
  for (const sha of log.stdout.split(/\s+/).filter(Boolean).reverse()) {
    const show = gitRunner(['show', `${sha}:${liveViewPath}`], repoRoot);
    if (show.error || show.status !== 0 || typeof show.stdout !== 'string') continue;
    if (show.stdout.includes(anchored)) {
      commit = sha;
      break;
    }
  }
  if (commit === null) return null;
  const branches = gitRunner(['branch', '-a', '--contains', commit, '--format=%(refname:short)'], repoRoot);
  const refs =
    branches.error || branches.status !== 0 || typeof branches.stdout !== 'string'
      ? []
      : branches.stdout
          .split(/\r?\n/)
          .map((r) => r.trim())
          .filter((r) => r && r !== 'origin' && !r.startsWith('(') && !/^(origin\/)?(main|HEAD)$/.test(r));
  return { commit, refs };
}

// #3529 (PR #3532 review pass 2, 🟠2): the state of each PR the "Retired
// carried rows" record names, from `gh`. `{ available: false, reason }` when
// gh is missing or not authenticated — the record is then accepted with a
// warning, since the check cannot confirm it. Otherwise `states` maps each PR
// number to `{ state, mergedAt, headRefName }` (the head branch, for the
// ownership check of operator decision 4), or `{ error }` when gh could not
// read it.
// `ghRunner` is injectable so tests never touch the network; the default
// goes through the repo's `gh` chokepoint (scripts/gh.mjs, #2184).
function runGhCommand(args, cwd) {
  return ghSpawn(args, { cwd, timeout: GIT_TIMEOUT_MS, env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
}
export function resolveRetiredPrStates(repoRoot, prNumbers, ghRunner = runGhCommand) {
  const states = new Map();
  if (prNumbers.length === 0) return { available: true, states };
  const auth = ghRunner(['auth', 'status'], repoRoot);
  if (auth.error) {
    return {
      available: false,
      reason: auth.error.code === 'ENOENT' ? 'gh is not installed' : `gh could not run (${auth.error.message})`,
    };
  }
  if (auth.status !== 0) {
    const detail = String(auth.stderr ?? '').trim().split(/\r?\n/)[0];
    return { available: false, reason: `gh is not authenticated${detail ? ` (${detail})` : ''}` };
  }
  for (const pr of prNumbers) {
    const r = ghRunner(['pr', 'view', String(pr), '--json', 'state,mergedAt,headRefName'], repoRoot);
    if (r.error || r.status !== 0) {
      states.set(pr, { error: String(r.stderr ?? '').trim().split(/\r?\n/)[0] || r.error?.message || `gh exited ${r.status}` });
      continue;
    }
    try {
      const json = JSON.parse(r.stdout);
      states.set(pr, { state: json.state, mergedAt: json.mergedAt ?? null, headRefName: json.headRefName ?? null });
    } catch {
      states.set(pr, { error: 'gh printed output that is not JSON' });
    }
  }
  return { available: true, states };
}

// #3116: reads the live view AT an arbitrary ref (the PR base, in CI) for
// `--stamped-since`. Deliberately narrower than `resolveBaselineTexts` above:
// no fetch (the caller — the CLI layer, or the workflow before invoking it —
// is responsible for making `ref` resolvable locally; in CI, `actions/checkout@v7`
// with `fetch-depth: 2` makes the base branch's tip -- the merge commit's first parent, NOT the merge-base -- available as HEAD^1), one file, and THREE outcomes rather than
// fetch-then-show's two, because "the file didn't exist yet at this ref" is
// not a failure here (it's the newly-added-file case the issue calls out) —
// it must not be folded into the same bucket as "the ref itself is garbage."
//
// #3116 review finding 5: correctness depends on the working tree being
// `merge(base, head)` -- the PR head merged ONTO the base branch's current tip.
// In CI this is guaranteed: `actions/checkout@v7` on a pull_request event
// checks out `refs/pull/N/merge`, GitHub's `Merge <head> into <base>` commit,
// rebuilt on the base's current tip. Its first parent is that tip, available
// as HEAD^1 (the tip, not the merge-base). By hand, never pass HEAD^1: outside
// CI's merge commit it need not be the base your branch will merge onto (it may
// be, for example, your previous commit, your own pre-merge tip, or after a
// fast-forward main's previous tip), so the comparison can run against the wrong
// tree. That can fail to catch an unstamped edit -- for example when HEAD^1
// already contains the edit, or when a stamp main landed in between is credited
// to your branch. Pass the target ref explicitly after merging it in
// (`git fetch origin && git merge origin/main`, then `--stamped-since
// origin/main`): that is CI's comparison. Un-merged against the target, the
// result mixes main's changes with yours: an unstamped edit is still refused
// unless main's counter is now lower than your branch's, the message can read
// BEHIND when main's counter is higher than your branch's, and a branch that
// never touched the live view can be refused because of main's change. The
// comparison is only meaningful when the working tree is merge(base, head) and
// `ref` is that base.
//
// `git show <ref>:<path>` exits 128 for BOTH "path missing at that ref" and
// "ref doesn't resolve at all"; the only way to tell them apart is the
// stderr text. Git's own C code uses TWO distinct messages for "missing at
// that ref", not one: `fatal: path '%s' does not exist in '%s'` when the
// path is absent everywhere the working tree can see, and `fatal: path '%s'
// exists on disk, but not in '%s'` when it exists on disk in the CURRENT
// working tree but wasn't tracked yet at <ref> — exactly the newly-added-file
// shape this flag has to pass. Both are "missing"; anything else (an invalid
// ref, a corrupt object, a timeout) falls through to 'error' and fails
// closed, per the issue's explicit instruction that an unresolvable ref must
// never read as "no change".
export function resolveStampedSinceBaseline(repoRoot, liveViewPath, ref, gitRunner = runGitCommand) {
  const result = gitRunner(['show', `${ref}:${liveViewPath}`], repoRoot);
  if (result.error) {
    return { status: 'error', text: null, message: `\`git show ${ref}:${liveViewPath}\` failed to run: ${result.error.message}` };
  }
  if (result.status !== 0) {
    const stderr = typeof result.stderr === 'string' ? result.stderr : '';
    if (stderr.includes('does not exist in') || stderr.includes('exists on disk, but not in')) {
      return { status: 'missing', text: null, message: null };
    }
    return {
      status: 'error',
      text: null,
      message:
        `\`git show ${ref}:${liveViewPath}\` failed (exit ${result.status}): ` +
        `${stderr.trim() || '(no stderr output)'}`,
    };
  }
  if (typeof result.stdout !== 'string') {
    return {
      status: 'error',
      text: null,
      message: `\`git show ${ref}:${liveViewPath}\` produced no readable output.`,
    };
  }
  return { status: 'ok', text: result.stdout, message: null };
}

// process.exit() terminates before Node flushes pending async stdout/stderr
// writes (synchronous on Windows, ASYNCHRONOUS on Linux/macOS — see
// scripts/build-release-zip.mjs's own die()/CliError comment for the fuller
// account and the incident that motivated it, PR #2297). This CLI's own
// output was measured as tiny on its OK path — see the "extend the guard fix
// beyond scripts/" commit — but that measurement never covered the FAILURE
// path: verify.yml's lint-and-checks job runs this on ubuntu with stdout/stderr on a
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
  // IMPORTANT: These paths must stay in sync with the globs at scripts/verify-cache.mjs
  // around line 88. If these paths change, update both locations.
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
          `Not found: ${relPath}\n` +
          `Expected paths: ${REGISTER}, ${LIVE_VIEW}\n` +
          `If these paths have moved, update the path constants in this file (around line 1613) ` +
          `and the matching globs in scripts/verify-cache.mjs (around line 88).`,
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

  // --stamped-since <ref> (#3116): opt-in, invoked by CI with HEAD^1 (the
  // merge commit's first parent, the base tip at merge time). Answers ONE
  // question — did the live view's rendered content change since <ref> without
  // the publish counter moving — and stays independent of the register-vs-live-view
  // comparison below: it reads neither REGISTER (no `read(REGISTER)` above this
  // block, deliberately) nor does it require LIVE_VIEW to exist (a newly-added
  // file has nothing to compare against; see the ENOENT handling below). No network fetch here — that would make
  // the no-flag run's offline guarantee a lie if this block ever grew a
  // dependency on it; the caller (the workflow, or an operator by hand) is
  // responsible for making `ref` resolvable locally first.
  //
  // Correctness assumes the working tree is merge(base, head): the PR head
  // merged onto the base branch's tip. In CI, actions/checkout@v7 with
  // fetch-depth: 2 checks out refs/pull/N/merge (`Merge <head> into <base>`,
  // rebuilt on the base's current tip), whose first parent HEAD^1 is that tip.
  // Hand-run: never pass HEAD^1. Outside CI's merge commit it need not be the base
  // your branch will merge onto, so the check can fail to catch an unstamped edit (for
  // example when HEAD^1 already contains it, or when a stamp main landed in
  // between is credited to your branch). Merge the target in, then pass it
  // explicitly -- that is CI's comparison. Un-merged, the result mixes main's
  // changes with yours; see the header comment on resolveStampedSinceBaseline.
  const stampedSinceIdx = process.argv.indexOf('--stamped-since');
  if (stampedSinceIdx !== -1) {
    // #3116 review finding 2: --stamped-since is incompatible with
    // --against-published and --discharging. Both are part of the
    // pre-publish check, not the CI gate, so they cannot appear together.
    // Refuse explicitly rather than silently ignoring them.
    const againstPublishedIdx = process.argv.indexOf('--against-published');
    const dischargingIdx = process.argv.indexOf('--discharging');
    const publishingIdx = process.argv.indexOf('--publishing');
    const buildUnionIdx = process.argv.indexOf('--build-union');
    if (againstPublishedIdx !== -1 || dischargingIdx !== -1 || publishingIdx !== -1 || buildUnionIdx !== -1) {
      const conflicting = [];
      if (againstPublishedIdx !== -1) conflicting.push('--against-published');
      if (dischargingIdx !== -1) conflicting.push('--discharging');
      if (publishingIdx !== -1) conflicting.push('--publishing');
      if (buildUnionIdx !== -1) conflicting.push('--build-union');
      console.error(
        `--stamped-since cannot be combined with ${conflicting.join(' and ')}. ` +
          `--stamped-since is for CI (checks if content moved without a stamp); ` +
          `${conflicting.join(' and ')} are for hand-run pre-publish checks. ` +
          `Run them separately.`,
      );
      throw new CliExitError(1);
    }
    // Same "flag given twice" refusal as --against-published/--discharging
    // above (well, below in file order, same convention): a second
    // occurrence is silently dropped by `indexOf`, which would otherwise
    // just run against the wrong ref with no warning.
    if (process.argv.lastIndexOf('--stamped-since') !== stampedSinceIdx) {
      console.error(
        '--stamped-since was passed more than once — pass exactly one ref, e.g. ' +
          '--stamped-since origin/main.',
      );
      throw new CliExitError(1);
    }
    const ref = process.argv[stampedSinceIdx + 1];
    if (!ref) {
      console.error('--stamped-since requires a value: a ref to compare against, e.g. a commit sha.');
      throw new CliExitError(1);
    }

    let workingHtml;
    try {
      workingHtml = readFileSync(new URL(`../${LIVE_VIEW}`, import.meta.url), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        // The file doesn't exist in the working tree. Deletion is not this
        // check's business (per the issue) — pass.
        console.log(`check:onbox-register --stamped-since: OK — ${LIVE_VIEW} does not exist.`);
        return;
      }
      throw err;
    }

    const repoRoot = fileURLToPath(new URL('..', import.meta.url));
    const baseline = resolveStampedSinceBaseline(repoRoot, LIVE_VIEW, ref);
    if (baseline.status === 'error') {
      console.error(
        `Publish token: could not read ${LIVE_VIEW} at ${ref} — ${baseline.message} An ` +
          'unresolvable ref must never read as "no change"; fix the ref (or the fetch that ' +
          'was meant to make it resolvable) and try again.',
      );
      throw new CliExitError(1);
    }
    if (baseline.status === 'missing') {
      // Newly added at HEAD relative to `ref` — nothing to compare. Pass.
      console.log(`check:onbox-register --stamped-since: OK — ${LIVE_VIEW} does not exist at ${ref}.`);
      return;
    }

    const stampedSinceErrors = checkStampedSince({ workingHtml, baselineHtml: baseline.text });
    const stampedSinceFailed = report(
      `${LIVE_VIEW} changed since ${ref} without a fresh publish stamp`,
      stampedSinceErrors,
    );
    if (!stampedSinceFailed) {
      console.log(`check:onbox-register --stamped-since: OK — ${LIVE_VIEW} vs ${ref}.`);
    }
    if (stampedSinceFailed) throw new CliExitError(1);
    return;
  }

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
  // the last step before publishing — not wired into the CI checks, which
  // have no such file to read and no network access to fetch one.
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

  // --publishing <file> (#3529): the file actually about to be published, when
  // it is not the tracked live view — a union carrying another lane's rows.
  // Same single-value, only-with-`--against-published` contract as
  // --discharging above.
  const publishingIdx = process.argv.indexOf('--publishing');
  let publishingHtml;
  if (publishingIdx !== -1) {
    if (process.argv.lastIndexOf('--publishing') !== publishingIdx) {
      console.error('--publishing was passed more than once — pass exactly one file.');
      throw new CliExitError(1);
    }
    if (againstPublishedIdx === -1) {
      console.error(
        '--publishing only makes sense alongside --against-published — it names the file you ' +
          'are about to publish, so it is compared against the page currently live.',
      );
      throw new CliExitError(1);
    }
    const publishingPath = process.argv[publishingIdx + 1];
    if (!publishingPath) {
      console.error('--publishing requires a value: the path of the file you are about to publish.');
      throw new CliExitError(1);
    }
    try {
      publishingHtml = readFileSync(resolve(publishingPath), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'EISDIR' || err.code === 'EACCES') {
        console.error(`Cannot read --publishing ${publishingPath} (${err.code}) — pass a readable file path.`);
        throw new CliExitError(1);
      }
      throw err;
    }
  }

  // --build-union <out> (#3529, PR #3532 review pass 2): writes the union —
  // your tracked live view plus every live row this run finds you must not
  // drop (`buildUnionLiveView`) — to <out>, then checks <out> exactly as
  // --publishing would. The way to build a union file; never by hand.
  const buildUnionIdx = process.argv.indexOf('--build-union');
  let buildUnionPath;
  if (buildUnionIdx !== -1) {
    if (process.argv.lastIndexOf('--build-union') !== buildUnionIdx) {
      console.error('--build-union was passed more than once — pass exactly one output file.');
      throw new CliExitError(1);
    }
    if (againstPublishedIdx === -1) {
      console.error(
        "--build-union only makes sense alongside --against-published — it carries the live page's rows " +
          'that publishing your tracked file would drop.',
      );
      throw new CliExitError(1);
    }
    if (publishingIdx !== -1) {
      console.error(
        '--build-union cannot be combined with --publishing: --build-union writes the union and checks it; ' +
          '--publishing checks a union you already have. Pass one.',
      );
      throw new CliExitError(1);
    }
    buildUnionPath = process.argv[buildUnionIdx + 1];
    if (!buildUnionPath) {
      console.error('--build-union requires a value: the path to write the union file to.');
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
    const baselineLiveViewFileOverride = process.env.ONBOX_TEST_BASELINE_LIVEVIEW_FILE;
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
        const registerText = readFileSync(resolve(baselineFileOverride), 'utf8');
        let liveViewText = null;
        if (baselineLiveViewFileOverride) {
          liveViewText = readFileSync(resolve(baselineLiveViewFileOverride), 'utf8');
        }
        baseline = {
          registerText,
          liveViewText,
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
    // compares this TRACKED, working-tree copy of the live view (including
    // any uncommitted edits mid-publish) against the published snapshot — not
    // the register — see `parseLiveViewRowBodies`'s own header for why. Read
    // the same way the no-flag path below reads it.
    //
    // TEST-ONLY override, mirroring ONBOX_TEST_BASELINE_FILE /
    // ONBOX_TEST_BASELINE_LIVEVIEW_FILE above: a CLI-level test that wants to
    // exercise a specific tracked-vs-published-vs-baseline scenario cannot
    // control this file's real on-disk content without mutating the actual
    // repo file (unsafe, non-hermetic — see #2599 review round 2). Fires the
    // same unconditional WARNING as the other two overrides so this can never
    // silently reach a real invocation.
    const trackedLiveViewFileOverride = process.env.ONBOX_TEST_TRACKED_LIVEVIEW_FILE;
    if (trackedLiveViewFileOverride) {
      console.error(
        `WARNING: tracked live-view injected from ONBOX_TEST_TRACKED_LIVEVIEW_FILE=${trackedLiveViewFileOverride}; ` +
          'this is NOT the real working-tree file and must never be used to gate a publish.',
      );
    }
    const trackedLiveViewHtml = trackedLiveViewFileOverride
      ? readFileSync(resolve(trackedLiveViewFileOverride), 'utf8')
      : read(LIVE_VIEW);
    // #3529: who published the live page, and the register at the merge-base
    // — see `checkLiveView`'s header. Resolved against the SAME frozen SHA the
    // baseline texts came from. TEST-ONLY override, mirroring the ones above:
    // `ONBOX_TEST_PUBLISHED_PROVENANCE` (merged | own | unmerged | unknown)
    // replaces the git lookup, with the published page's own rows standing in
    // for the stamping commit's; under `ONBOX_TEST_BASELINE_FILE` (no git
    // SHA to search) it defaults to 'merged', #2199's original reading, and
    // the merge-base check is skipped.
    const provenanceOverride =
      process.env.ONBOX_TEST_PUBLISHED_PROVENANCE ?? (baselineFileOverride ? 'merged' : undefined);
    if (process.env.ONBOX_TEST_PUBLISHED_PROVENANCE) {
      console.error(
        `WARNING: published-page provenance injected from ONBOX_TEST_PUBLISHED_PROVENANCE=${provenanceOverride}; ` +
          'this is NOT a real git lookup and must never be used to gate a publish.',
      );
    }
    let publishedProvenance;
    let mergeBaseText;
    let mainEverCarried;
    let rowOwnerLookup;
    if (provenanceOverride) {
      const token = parsePublishToken(publishedHtml);
      publishedProvenance = {
        kind: provenanceOverride,
        nonce: token && !token.malformed ? token.nonce : null,
        reason: 'injected by ONBOX_TEST_PUBLISHED_PROVENANCE',
        stampedRowIds: liveViewRowIdSet(publishedHtml),
      };
    } else if (baseline.fetchedSha) {
      publishedProvenance = resolvePublishedProvenance(repoRoot, LIVE_VIEW, publishedHtml, baseline.fetchedSha);
      mergeBaseText = resolveMergeBaseRegister(repoRoot, REGISTER, baseline.fetchedSha);
      // #3529 (review pass 2): asked only for a row that would otherwise fail.
      mainEverCarried = (id) => resolveMainEverCarried(repoRoot, REGISTER, baseline.fetchedSha, id);
      rowOwnerLookup = (id) => resolveRowOwner(repoRoot, LIVE_VIEW, id);
    }
    // #3529 (review pass 2, 🟠2): the PRs the "Retired carried rows" record
    // names, confirmed through gh (no call at all when the record is empty).
    // TEST-ONLY override, mirroring the ones above: ONBOX_TEST_GH_PR_STATES is
    // a JSON object of PR number -> OPEN | CLOSED | MERGED, or
    // { state, headRefName }, or `unavailable`. It stands in for gh itself,
    // not for the lookup, so only the PRs this run asks about are answered
    // and a PR it does not list reads as one gh could not resolve.
    const retiredPrs = [
      ...new Set(
        [...parseRetiredCarriedRows(text).entries, ...parseRetiredCarriedRows(baseline.registerText ?? '').entries].map(
          (e) => e.pr,
        ),
      ),
    ];
    const ghOverride = process.env.ONBOX_TEST_GH_PR_STATES;
    let retiredPrStates;
    if (ghOverride) {
      console.error(
        `WARNING: gh PR states injected from ONBOX_TEST_GH_PR_STATES=${ghOverride}; ` +
          'this is NOT a real gh lookup and must never be used to gate a publish.',
      );
      const injected = ghOverride === 'unavailable' ? {} : JSON.parse(ghOverride);
      retiredPrStates = resolveRetiredPrStates(repoRoot, retiredPrs, (args) => {
        if (args[0] === 'auth') {
          return ghOverride === 'unavailable'
            ? { status: 1, stdout: '', stderr: 'injected as unavailable by ONBOX_TEST_GH_PR_STATES' }
            : { status: 0, stdout: '', stderr: '' };
        }
        const answer = injected[args[2]];
        if (answer === undefined) {
          return { status: 1, stdout: '', stderr: `Could not resolve to a PullRequest (#${args[2]} is not in ONBOX_TEST_GH_PR_STATES)` };
        }
        const { state, headRefName = null } = typeof answer === 'string' ? { state: answer } : answer;
        return { status: 0, stdout: JSON.stringify({ state, mergedAt: state === 'MERGED' ? 'injected' : null, headRefName }), stderr: '' };
      });
    } else {
      retiredPrStates = resolveRetiredPrStates(repoRoot, retiredPrs);
    }
    const checkOptions = {
      direction: 'extraOnly',
      baselineText: baseline.registerText,
      dischargingIds,
      trackedLiveViewHtml,
      baselineLiveViewText: baseline.liveViewText,
      publishedProvenance,
      publishingHtml,
      mergeBaseText,
      mainEverCarried,
      rowOwnerLookup,
      retiredPrStates,
    };
    const carryOut = new Set();
    let publishedErrors = checkLiveView(text, publishedHtml, { ...checkOptions, carryOut });
    // --build-union: write the union of what this run found must be carried,
    // then judge THAT file, exactly as --publishing would.
    if (buildUnionPath && publishedErrors[0] !== CANNOT_VERIFY_BASELINE_ERROR) {
      if (carryOut.size === 0) {
        console.log(
          `--build-union: no live row needs carrying, so ${buildUnionPath} was not written — publish ${LIVE_VIEW} itself.`,
        );
      } else {
        let union;
        try {
          union = buildUnionLiveView(trackedLiveViewHtml, publishedHtml, [...carryOut]);
        } catch (err) {
          console.error(`--build-union: cannot build the union — ${err.message}`);
          throw new CliExitError(1);
        }
        writeFileSync(resolve(buildUnionPath), union, 'utf8');
        console.log(
          `--build-union: wrote ${buildUnionPath} — ${LIVE_VIEW} plus ${[...carryOut].sort().join(', ')}, copied ` +
            'verbatim from the live page. It is checked below exactly as --publishing would; if it passes, ' +
            'publish THAT file in step 4, not the tracked one.',
        );
        publishedErrors = checkLiveView(text, publishedHtml, { ...checkOptions, publishingHtml: union });
      }
    }
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
    // #2599 Finding 3: extraction errors are their own class — they indicate
    // malformed HTML markup that must be fixed, not content drift or missing
    // rows. Must not be routed to the "BEHIND" bucket or its remedy text.
    const extractionErrors = cannotVerify
      ? []
      : publishedErrors.filter((e) => e.startsWith(EXTRACTION_ERROR_PREFIX));
    // #2837 Finding 1: 3-way content-difference warnings are advisory, not
    // blocking. Extract them so they don't count as errors for the gate, but
    // still print them visibly so the operator sees them. A multi-step
    // pending-publish (edit, publish, edit again before merge) looks like a
    // 3-way disagreement to hash-only comparison, but is ordinarily not a
    // conflict — the operator can investigate manually if needed.
    const collisionErrors = cannotVerify
      ? []
      : publishedErrors.filter((e) => e.startsWith(ROW_ID_COLLISION_ERROR_PREFIX));
    const unmergedLaneErrors = cannotVerify
      ? []
      : publishedErrors.filter((e) => e.startsWith(UNMERGED_LANE_ROW_ERROR_PREFIX));
    const unknownProvenanceErrors = cannotVerify
      ? []
      : publishedErrors.filter((e) => e.startsWith(UNKNOWN_PROVENANCE_ERROR_PREFIX));
    const publishingFileErrors = cannotVerify
      ? []
      : publishedErrors.filter((e) => e.startsWith(PUBLISHING_FILE_ERROR_PREFIX));
    const retiredErrors = cannotVerify
      ? []
      : publishedErrors.filter((e) => e.startsWith(RETIRED_ROW_ERROR_PREFIX));
    const retiredWarnings = cannotVerify
      ? []
      : publishedErrors.filter((e) => e.startsWith(RETIRED_ROW_WARNING_PREFIX));
    const threeWayWarnings = cannotVerify
      ? []
      : publishedErrors.filter((e) => e.startsWith(THREE_WAY_CONTENT_WARNING_PREFIX));
    const behindErrors = cannotVerify
      ? []
      : publishedErrors.filter(
          (e) =>
            !e.startsWith(DISCHARGE_NAME_ERROR_PREFIX) &&
            !e.startsWith(ROW_ID_COLLISION_ERROR_PREFIX) &&
            !e.startsWith(UNMERGED_LANE_ROW_ERROR_PREFIX) &&
            !e.startsWith(UNKNOWN_PROVENANCE_ERROR_PREFIX) &&
            !e.startsWith(PUBLISHING_FILE_ERROR_PREFIX) &&
            !e.startsWith(RETIRED_ROW_ERROR_PREFIX) &&
            !e.startsWith(RETIRED_ROW_WARNING_PREFIX) &&
            !e.startsWith(ROW_CONTENT_DRIFT_ERROR_PREFIX) &&
            !e.startsWith(EXTRACTION_ERROR_PREFIX) &&
            !e.startsWith(THREE_WAY_CONTENT_WARNING_PREFIX),
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
      if (collisionErrors.length > 0) {
        publishedFailed =
          report(
            `Another lane (on ${publishedPath} or already on origin/main) uses a row ID that ` +
              `${LIVE_VIEW} also uses for a different row`,
            collisionErrors,
          ) || publishedFailed;
        console.error('Do not publish. Renumber your row as each error above says.');
      }
      if (unmergedLaneErrors.length > 0) {
        publishedFailed =
          report(
            `${publishedPath} (the currently-PUBLISHED page) has rows from another unmerged lane`,
            unmergedLaneErrors,
          ) || publishedFailed;
        console.error(
          "Do not publish this file: it would drop that lane's rows. Publish a file that carries " +
            'each row named above verbatim and pass it via --publishing <file>, or coordinate with ' +
            'that lane first.',
        );
      }
      if (publishingFileErrors.length > 0) {
        publishedFailed =
          report('The --publishing file does not carry the live page\'s rows verbatim', publishingFileErrors) ||
          publishedFailed;
        console.error(
          'Do not publish. Build the union with --build-union <out> rather than by hand: it is your tracked ' +
            "live view plus each carried row's live block, unchanged, with the derived figures regenerated.",
        );
      }
      if (retiredErrors.length > 0) {
        publishedFailed =
          report(`The register's "${RETIRED_SECTION_TITLE}" record names an entry the check will not honour`, retiredErrors) ||
          publishedFailed;
        console.error(
          'Do not publish. A retirement is honoured only for a PR confirmed closed without merging — fix or ' +
            "remove each entry named above (an open lane's row must still be carried).",
        );
      }
      if (retiredWarnings.length > 0) {
        console.warn(`\n${RETIRED_SECTION_TITLE} accepted WITHOUT a gh check (not blocking — confirm each by hand):`);
        for (const warning of retiredWarnings) console.warn(`  ${warning}`);
      }
      if (unknownProvenanceErrors.length > 0) {
        publishedFailed =
          report(`Who published ${publishedPath} could not be established`, unknownProvenanceErrors) ||
          publishedFailed;
      }
      if (contentDriftErrors.length > 0) {
        publishedFailed =
          report(
            `${publishedPath} (the currently-PUBLISHED page, fetched just now) has row content ` +
              `that differs from ${LIVE_VIEW}`,
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
      if (extractionErrors.length > 0) {
        // #2837 Finding 4: tag each extraction error with its source file so
        // the remedy message correctly identifies which copy is broken.
        const trackedExtErrors = extractionErrors.filter((e) => e.includes('[tracked]'));
        const publishedExtErrors = extractionErrors.filter((e) => e.includes('[published]'));
        const baselineExtErrors = extractionErrors.filter((e) => e.includes('[baseline]'));

        if (trackedExtErrors.length > 0) {
          publishedFailed =
            report(
              `Your local ${LIVE_VIEW} (working-tree copy) has malformed or unreadable HTML markup`,
              trackedExtErrors,
            ) || publishedFailed;
        }
        if (publishedExtErrors.length > 0) {
          publishedFailed =
            report(
              `${publishedPath} (the currently-PUBLISHED page) has malformed or unreadable HTML markup`,
              publishedExtErrors,
            ) || publishedFailed;
        }
        if (baselineExtErrors.length > 0) {
          publishedFailed =
            report(
              `origin/main's ${LIVE_VIEW} (baseline copy) has malformed or unreadable HTML markup`,
              baselineExtErrors,
            ) || publishedFailed;
        }
        console.error(
          'Do not publish. The HTML structure is corrupted or missing expected elements. ' +
            'Each error above explains what was unreadable and which file is broken. Check that all ' +
            '<details class="item">, <span class="num">, <summary>, and <div class="body"> elements ' +
            'are present and correctly formed in the identified file(s).',
        );
      }
      if (threeWayWarnings.length > 0) {
        // #2837 Finding 1: Print 3-way warnings visibly but do not set
        // publishedFailed — these are advisory, not blocking. Ordinary
        // multi-step publishes (edit, publish, edit again before merge) trigger
        // them; hash-only comparison cannot distinguish from genuine conflicts.
        console.warn(
          '\n⚠️  Three-way content differences detected (not blocking, but check if wrong):',
        );
        for (const warning of threeWayWarnings) {
          const idMatch = warning.match(new RegExp(`^${THREE_WAY_CONTENT_WARNING_PREFIX}([A-Z]\\d+):`));
          const id = idMatch ? idMatch[1] : 'unknown';
          const message = warning.substring(THREE_WAY_CONTENT_WARNING_PREFIX.length);
          console.warn(`  ${id}: ${message}`);
        }
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
