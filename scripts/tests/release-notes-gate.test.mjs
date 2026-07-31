import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseTopReleaseNote,
  isPlaceholderNotes,
  checkReleaseNotes,
  findMojibake,
  checkMojibake,
  parseMojibakeAllowlist,
} from '../release-notes-gate.mjs';

const REAL = '# Castwright 1.7.0\n- **Mac.** Runs on Mac.\n\n# Castwright 1.6.0\n- **x.** y.';
const PLACEHOLDER = '# v9.9.9\n\nSee the GitHub release for details.';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('parseTopReleaseNote reads only the newest section', () => {
  const top = parseTopReleaseNote(REAL);
  assert.equal(top.version, '1.7.0');
  assert.equal(top.bullets.length, 1);
});

test('isPlaceholderNotes flags empty / placeholder / no-bullets', () => {
  assert.equal(isPlaceholderNotes(''), true);
  assert.equal(isPlaceholderNotes(PLACEHOLDER), true);
  assert.equal(isPlaceholderNotes(REAL), false);
});

test('checkReleaseNotes passes when the top section matches the version', () => {
  assert.equal(checkReleaseNotes(REAL, '1.7.0').ok, true);
  assert.equal(checkReleaseNotes(REAL, 'v1.7.0').ok, true); // tolerate a leading v
});

test('checkReleaseNotes fails on placeholder or version mismatch', () => {
  assert.equal(checkReleaseNotes(PLACEHOLDER, '9.9.9').ok, false);
  assert.equal(checkReleaseNotes(REAL, '1.6.0').ok, false); // top is 1.7.0, not 1.6.0
  assert.equal(checkReleaseNotes('', '1.7.0').ok, false);
});

// #1956 — mojibake guard: a double-UTF-8-encoded em dash/arrow/etc. (correct
// UTF-8 bytes misread as windows-1252 and re-encoded as UTF-8).
const MOJIBAKE_EM_DASH = 'â€”'; // should decode to U+2014 —
const MOJIBAKE_ARROW = 'â†’'; // should decode to U+2192 →

test('findMojibake finds double-UTF-8-encoded spans and decodes them correctly', () => {
  const corrupt = `dash: ${MOJIBAKE_EM_DASH} arrow: ${MOJIBAKE_ARROW} end`;
  const hits = findMojibake(corrupt);
  assert.equal(hits.length, 2);
  assert.ok(hits.some((h) => h.decoded.startsWith('—'))); // em dash
  assert.ok(hits.some((h) => h.decoded.startsWith('→'))); // arrow
});

test('findMojibake does not flag clean ASCII or already-correct Unicode', () => {
  assert.equal(findMojibake('Plain ASCII text.').length, 0);
  assert.equal(
    findMojibake('Already correct: em dash —, arrow →, ellipsis …, café, résumé').length,
    0,
  );
});

test('checkMojibake passes on clean text and fails on corrupted text', () => {
  assert.equal(checkMojibake('Clean text with a real — dash.', 'test.md').ok, true);
  const res = checkMojibake(`Corrupted: ${MOJIBAKE_EM_DASH} dash.`, 'test.md');
  assert.equal(res.ok, false);
  assert.match(res.reason, /test\.md/);
  assert.match(res.reason, /1 double-UTF-8-encoded mojibake span/);
});

test('checkMojibake reports a capped sample plus a remainder count', () => {
  const many = Array(8).fill(MOJIBAKE_EM_DASH).join(' x ');
  const res = checkMojibake(many, 'test.md');
  assert.equal(res.ok, false);
  assert.match(res.reason, /8 double-UTF-8-encoded mojibake span\(s\)/);
  assert.match(res.reason, /\+3 more/);
});

// #1973 — the allowlist marker. The detector's acceptance rule ("cp1252-mappable
// characters whose bytes form valid UTF-8 with a lead byte >= 0xC2") is satisfied
// by some legitimate text, and release.yml's CLI path exits 1 with no --force, so
// a false positive can block a publish outright. All four are from the issue's
// measured table of legitimate strings the detector flags.
const CAFE = 'CAFÉ™'; // "É™" reads as a mangled "ə"
const GROSS = 'groß—'; // "ß—" reads as a mangled "ߗ"
const TROLL = 'Å§'; // reads as a mangled "ŧ"
const DEGREE = 'Ü°'; // reads as a mangled "ܰ"

test('parseMojibakeAllowlist reads every literal of every marker', () => {
  const text =
    `<!-- release-notes-gate: allow "${CAFE}", "${GROSS}" -->\n` +
    `<!-- release-notes-gate: allow "${TROLL}" -->\n`;
  assert.deepEqual(parseMojibakeAllowlist(text), [CAFE, GROSS, TROLL]);
  assert.deepEqual(parseMojibakeAllowlist('no markers here'), []);
});

test('checkMojibake still fails on a legitimate-but-flagged span with no marker', () => {
  const res = checkMojibake(`Order at ${CAFE} today.`, 'test.md');
  assert.equal(res.ok, false); // the false positive #1973 documents, unsuppressed
  assert.match(res.reason, /1 double-UTF-8-encoded mojibake span/);
});

test('checkMojibake passes a flagged span named by an allowlist marker', () => {
  const text = `<!-- release-notes-gate: allow "${CAFE}" -->\n\nOrder at ${CAFE} today.\n`;
  assert.equal(checkMojibake(text, 'test.md').ok, true);
});

test('checkMojibake honours several literals per marker and several markers per file', () => {
  const text =
    `<!-- release-notes-gate: allow "${CAFE}", "${GROSS}" -->\n` +
    `<!-- release-notes-gate: allow "${TROLL}" -->\n` +
    `<!-- release-notes-gate: allow "${DEGREE}" -->\n\n` +
    `${CAFE} serves ${GROSS} portions; ${TROLL} and ${DEGREE} follow.\n`;
  assert.equal(findMojibake(text).length > 4, true); // every one of them IS flagged
  assert.equal(checkMojibake(text, 'test.md').ok, true); // and every one is allowed
});

test('an allowlisted literal that appears nowhere else suppresses nothing', () => {
  const text = `<!-- release-notes-gate: allow "${CAFE}" -->\n\nCorrupted: ${MOJIBAKE_EM_DASH} dash.\n`;
  const res = checkMojibake(text, 'test.md');
  assert.equal(res.ok, false);
  assert.match(res.reason, /1 double-UTF-8-encoded mojibake span/);
});

// LOAD-BEARING: suppression is positional, not by substring. The span the
// detector reports for "CAFÉ™" is "É™" — so a by-substring allowlist would also
// swallow a genuinely corrupted "É™" elsewhere in the same file, silently
// reintroducing #1956. This is the test that tells the two implementations apart.
test('an allowlisted span does not suppress the same characters corrupted elsewhere', () => {
  const marker = `<!-- release-notes-gate: allow "${CAFE}" -->`;
  const body = `We reopened ${CAFE} downtown.\nzzÉ™zz was mangled.\n`;

  // Without the marker both spans are flagged — neither is invisible to start with.
  assert.equal(checkMojibake(body, 'test.md').reason.match(/2 double-UTF-8/) !== null, true);

  const res = checkMojibake(`${marker}\n\n${body}`, 'test.md');
  assert.equal(res.ok, false);
  assert.match(res.reason, /1 double-UTF-8-encoded mojibake span/);
  // The survivor is the corrupted one, identified by its own surrounding context.
  assert.ok(res.reason.includes(JSON.stringify('É™zz')), res.reason);
  assert.equal(res.reason.includes(JSON.stringify('É™ d')), false, res.reason);
});

test('a failing reason names the offending literal and a paste-able marker line', () => {
  const res = checkMojibake(`Order at ${CAFE} today.`, 'docs/release-notes-next.md');
  assert.equal(res.ok, false);
  assert.match(res.reason, /docs\/release-notes-next\.md/);
  assert.ok(res.reason.includes('É™'), res.reason); // the offending literal
  // The marker now contains the full token "CAFÉ™", not just the core "É™"
  assert.ok(
    res.reason.includes(`<!-- release-notes-gate: allow "CAFÉ™" -->`),
    res.reason, // the widened literal to stay scoped to the legitimate use
  );
});

test('hits still carry chunk/decoded verbatim, so split/join repair works, plus index', () => {
  const corrupt = `dash: ${MOJIBAKE_EM_DASH} and arrow: ${MOJIBAKE_ARROW} end`;
  const hits = findMojibake(corrupt);
  let repaired = corrupt;
  for (const h of hits) repaired = repaired.split(h.chunk).join(h.decoded);
  assert.equal(repaired, 'dash: — and arrow: → end');
  for (const h of hits) {
    assert.equal(typeof h.index, 'number');
    assert.equal(corrupt.slice(h.index, h.index + h.chunk.length), h.chunk);
  }
});

// Regression: this must FAIL against the pre-#1956-fix content of
// docs/release-notes-next.md (242 mojibake spans found on main @ b5479e9c)
// and PASS now that the file has been re-encoded. Asserting against the
// actual committed file means the guard fires pre-commit, not only at tag
// time, if the corruption ever comes back.
test('the committed docs/release-notes-next.md is free of mojibake', () => {
  const text = readFileSync(resolve(repoRoot, 'docs/release-notes-next.md'), 'utf8');
  const res = checkMojibake(text, 'docs/release-notes-next.md');
  assert.equal(res.ok, true, res.reason);
});

test('the committed RELEASE_NOTES.md is free of mojibake', () => {
  const text = readFileSync(resolve(repoRoot, 'RELEASE_NOTES.md'), 'utf8');
  const res = checkMojibake(text, 'RELEASE_NOTES.md');
  assert.equal(res.ok, true, res.reason);
});

// #1973 follow-up: the suggested allowlist literal must be the full token, not just the core
test('checkMojibake suggests the full whitespace-delimited token, not just the mojibake core', () => {
  // CAFE = 'CAFÉ™', chunk detected = 'É™', core length = 2, so core = 'É™'
  // But the token is 'CAFÉ™', so the suggestion should widen to that
  const res = checkMojibake(`Order at ${CAFE} today.`, 'test.md');
  assert.equal(res.ok, false);
  // The marker should contain the full token 'CAFÉ™', not just the core
  assert.match(res.reason, /allow "CAFÉ™"/);
});

// LOAD-BEARING: suppression by exact literal match means a narrow marker suppresses all instances.
// The fix's suggestion must be wide enough to stay scoped to the legitimate use.
test('pasting the suggested marker and re-running still flags genuine corruption elsewhere', () => {
  // Scenario: CAFÉ™ is legitimate, but zzÉ™zz is genuine corruption
  const text1 = `Order at ${CAFE} today.\nCorruption: zzÉ™zz was mangled.\n`;

  // Before the marker, both mojibake spans are flagged
  const res1 = checkMojibake(text1, 'test.md');
  assert.equal(res1.ok, false);
  assert.match(res1.reason, /2 double-UTF-8-encoded mojibake span/);

  // Extract the suggested marker line from the failure message
  const markerMatch = res1.reason.match(/<!-- release-notes-gate: allow "[^"]*" -->/);
  assert.ok(markerMatch, 'should find the suggested marker');
  const suggestedMarker = markerMatch[0];

  // Paste the marker and re-run
  const text2 = `${suggestedMarker}\n\n${text1}`;
  const res2 = checkMojibake(text2, 'test.md');

  // The key assertion: we should still fail because the genuine corruption is not suppressed
  // (suppression is positional, and the corruption sits outside the "CAFÉ™" span)
  assert.equal(res2.ok, false, 'should still fail after pasting the suggested marker');
  assert.match(res2.reason, /1 double-UTF-8-encoded mojibake span/);
  // The survivor should be the genuine corruption, identified by its surrounding context
  assert.ok(res2.reason.includes(JSON.stringify('É™zz')), res2.reason);
});

test('checkMojibake degrades safely when a token contains a double-quote', () => {
  // Create a scenario where the token containing the mojibake includes a quote
  // E.g., something like: He said "CAFÉ™"
  const text = `He said "CAFÉ™" yesterday.`;
  const res = checkMojibake(text, 'test.md');
  assert.equal(res.ok, false);
  // Should still print a marker, but safely degraded to the core since the token has a quote
  assert.match(res.reason, /<!-- release-notes-gate: allow "[^"]*" -->/);
  // The marker should parse correctly via parseMojibakeAllowlist
  const marker = res.reason.match(/<!-- release-notes-gate: allow "[^"]*" -->/)[0];
  const allowlist = parseMojibakeAllowlist(marker);
  assert.ok(allowlist.length > 0, 'marker should parse without error');
});
