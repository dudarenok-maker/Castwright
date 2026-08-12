import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import {
  parseTopReleaseNote,
  isPlaceholderNotes,
  checkReleaseNotes,
  findMojibake,
  checkMojibake,
  parseMojibakeAllowlist,
  formatHonouredEcho,
  findConflictMarkers,
  checkConflictMarkers,
  hasBOM,
  stripBOM,
  checkBOM,
} from '../release-notes-gate.mjs';

const REAL = '# Castwright 1.7.0\n- **Mac.** Runs on Mac.\n\n# Castwright 1.6.0\n- **x.** y.';
const PLACEHOLDER = '# v9.9.9\n\nSee the GitHub release for details.';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// PR #2007 review, Major 2 — every other test in this file calls
// checkMojibake()/formatHonouredEcho() directly, which pins the HELPER and
// the DATA but never the WIRING between them at the actual call site. Spawn
// the real CLI (mirrors the technique bump-version.test.mjs already uses)
// so a deleted echo call site is caught, not just a broken helper.
const here = dirname(fileURLToPath(import.meta.url));
const gateScript = resolve(here, '..', 'release-notes-gate.mjs');

/* repoRootFromHere() inside release-notes-gate.mjs resolves relative to the
   SCRIPT'S OWN file location, not cwd — so mirroring just the script into a
   throwaway scripts/ dir is enough to make it treat that tempdir as "the
   repo" for both RELEASE_NOTES.md and docs/release-notes-next.md. */
function setupGateFixture() {
  const dir = mkdtempSync(resolve(tmpdir(), 'release-notes-gate-test-'));
  mkdirSync(resolve(dir, 'scripts'));
  writeFileSync(resolve(dir, 'scripts', 'release-notes-gate.mjs'), readFileSync(gateScript, 'utf8'));
  // #2291 — release-notes-gate.mjs now imports ./lib/is-main-module.mjs (the
  // shared direct-execution guard); mirror it too, or the spawned CLI
  // crashes on module resolution.
  mkdirSync(resolve(dir, 'scripts', 'lib'));
  writeFileSync(
    resolve(dir, 'scripts', 'lib', 'is-main-module.mjs'),
    readFileSync(resolve(here, '..', 'lib', 'is-main-module.mjs'), 'utf8'),
  );
  mkdirSync(resolve(dir, 'docs'));
  return dir;
}

function runGate(dir, args) {
  return spawnSync('node', [resolve(dir, 'scripts', 'release-notes-gate.mjs'), ...args], {
    cwd: dir,
    encoding: 'utf8',
  });
}

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

/* #1982 round 2 — helpers for the standalone-span invariant.

   Whitespace-padded variants of a span: the literal an operator writes by hand
   when the gate offers nothing, i.e. the span plus the whitespace beside it.
   NBSP is written as an escape on purpose — as a literal glyph it is
   indistinguishable from a plain space in a diff, and gets flattened into one
   by some editors, which would silently reduce this to the space case. */
const PADS = [' ', '\t', '\u00a0'];
const paddedVariants = (span) =>
  PADS.flatMap((l) => ['', ...PADS].map((r) => `${l}${span}${r}`)).concat(
    PADS.map((r) => `${span}${r}`),
  );

/** How many spans checkMojibake actually reports (0 when it passes). */
const reportedSpans = (text) => {
  const res = checkMojibake(text, 'test.md');
  return res.ok ? 0 : Number(/contains (\d+) double/.exec(res.reason)[1]);
};

/** Assert that `text`'s own markers excused NOTHING: every span the detector
    finds is still reported. Stronger and less brittle than a fixed count —
    a marker line carries its own copy of its literal, so "the count did not
    drop" has to hold for that copy too. */
const assertSuppressesNothing = (text, what) => {
  const found = findMojibake(text).length;
  assert.ok(found > 0, `${what}: nothing to suppress in the first place`);
  assert.equal(reportedSpans(text), found, `${what}: suppressed at least one span`);
};

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
// a false positive can block a publish outright. All four are the issue's measured
// legitimate shapes, each shown with the surrounding characters that make it
// legitimate — which is also what makes it allowlistable at all (#1982): a literal
// has to extend past the flagged span, so the flagged pair on its own is never a
// usable literal.
const CAFE = 'CAFÉ™'; // "É™" reads as a mangled "ə"
const GROSS = 'groß—'; // "ß—" reads as a mangled "ߗ"
const TROLL = 'Å§land'; // "Å§" reads as a mangled "ŧ"
const DEGREE = '25Ü°C'; // "Ü°" reads as a mangled "ܰ"

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

// #2114 — same rationale as the mojibake pair above: asserting against the
// ACTUAL COMMITTED files means this guard fires pre-commit (npm run
// test:hooks), not only at tag time, if a BOM ever comes back — e.g. from a
// PowerShell Out-File/>/>> redirect touching either file. Reads raw BYTES
// (no 'utf8' decode) so the assertion can't be satisfied by a reader that
// silently normalises a BOM away; a fixture-only test can't catch this by
// construction, since nothing forces a throwaway fixture to be exercised
// against what's actually committed.
test('the committed docs/release-notes-next.md has no leading UTF-8 BOM', () => {
  const bytes = readFileSync(resolve(repoRoot, 'docs/release-notes-next.md'));
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});

test('the committed RELEASE_NOTES.md has no leading UTF-8 BOM', () => {
  const bytes = readFileSync(resolve(repoRoot, 'RELEASE_NOTES.md'));
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
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

// #1982 - the failure message must never print a line that would not work or
// would over-suppress. A token carrying a double-quote cannot go inside the
// marker's own quoted literal, and the old fallback (print the bare core) was
// precisely the file-wide-blinding line. So: print nothing, and say why.
//
// #1982 round 2 (F4): "why" has THREE answers and they are not
// interchangeable. Here the span DOES have surrounding context - `"CAFÉ™"` -
// it just cannot be quoted inside the marker. Saying "no surrounding context to
// name" was simply wrong for this input, and this test used to pin exactly that
// wrong sentence against exactly that input.
test('no marker is suggested when the surrounding token would break the marker syntax', () => {
  const text = `He said "CAFÉ™" yesterday.`;
  const res = checkMojibake(text, 'test.md');
  assert.equal(res.ok, false);
  assert.equal(/<!-- release-notes-gate: allow "[^"]*" -->/.test(res.reason), false, res.reason);
  // The right reason: context exists, it just cannot be quoted.
  assert.match(res.reason, /sit inside a word carrying a double-quote/, res.reason);
  assert.match(res.reason, /terminate the marker's own quoting/, res.reason);
  // And NOT the standalone sentence, which is false for this input.
  assert.equal(/no surrounding word to name/.test(res.reason), false, res.reason);
});

// #1982 F4 - the other half of the same distinction, so neither branch can
// silently absorb the other: a genuinely standalone span still gets the
// "no surrounding word" wording.
test('a genuinely standalone span is told it has no surrounding word to name', () => {
  const res = checkMojibake(`line with a ${MOJIBAKE_EM_DASH} in it`, 'test.md');
  assert.equal(res.ok, false);
  assert.match(
    res.reason,
    /stand alone between spaces, with no surrounding word to name/,
    res.reason,
  );
  assert.equal(/terminate the marker's own quoting/.test(res.reason), false, res.reason);
});

// #1982 round 2 - the third reason, and the one the whitespace guard CREATES.
// A doubly-encoded NBSP is `Â` + NBSP and a doubly-encoded Cyrillic `Р` is
// `Ð` + NBSP, so a real span can carry whitespace INSIDE it. Every literal
// containing such a span therefore contains whitespace, and allowedRanges drops
// it - so the gate must not print one. It used to: with the F1 guard in place
// but no matching check here, `Order at CAFÉ<NBSP>! today.` printed
// `allow "CAFÉ<NBSP>!"`, which parsed, looked right, and suppressed nothing.
test('no marker is suggested when the span itself straddles whitespace', () => {
  const NBSP = String.fromCharCode(0x00a0);
  const text = `Order at CAFÉ${NBSP}! today.`;
  assert.equal(findMojibake(text).length, 1); // the span spans the NBSP
  const res = checkMojibake(text, 'test.md');
  assert.equal(res.ok, false);
  // No marker line at all - and in particular not one the allowlist would drop.
  assert.equal(/<!-- release-notes-gate: allow "[^"]*" -->/.test(res.reason), false, res.reason);
  assert.match(res.reason, /straddle a whitespace character themselves/, res.reason);
});

// Producer/consumer lockstep: whatever the gate DOES offer must survive its own
// allowlist. Sweep a spread of shapes and assert that every printed marker,
// pasted back, actually suppresses something.
test('every marker line the gate prints is one its own allowlist accepts', () => {
  const NBSP = String.fromCharCode(0x00a0);
  const samples = [
    `Order at ${CAFE} today.`,
    `We serve ${GROSS} portions.`,
    `${TROLL} is up north.`,
    `It hit ${DEGREE} at noon.`,
    `A ${MOJIBAKE_EM_DASH} standing alone.`,
    `He said "${CAFE}" yesterday.`,
    `Order at CAFÉ${NBSP}! today.`,
    `Mangled ${MOJIBAKE_ARROW} arrow and a ${CAFE} too.`,
    `tail-->${CAFE} carries a terminator.`,
  ];
  for (const body of samples) {
    const res = checkMojibake(body, 'test.md');
    if (res.ok) continue;
    const m = /<!-- release-notes-gate: allow "([^"]*)" -->/.exec(res.reason);
    if (!m) continue; // nothing offered is always a legal answer
    const pasted = `${m[0]}\n\n${body}`;
    const found = findMojibake(pasted).length;
    const still = checkMojibake(pasted, 'test.md');
    const remaining = still.ok ? 0 : Number(/contains (\d+) double/.exec(still.reason)[1]);
    assert.ok(
      remaining < found,
      `the gate offered ${JSON.stringify(m[1])} for ${JSON.stringify(body)} but it suppressed nothing`,
    );
  }
});

// #1982 F1 — THE REPLAY. The suggestion mechanism must never be a route to a
// green gate: paste whatever the gate prints, re-run, repeat. Every span here
// is whitespace-delimited (the dominant #1956 shape), so widening finds nothing
// to add and no literal is legal for any of them. Before the fix, widening was
// a no-op on exactly these spans, the printed literal was the bare core, and
// one paste per distinct span drove the real 242-span file to green.
test('replaying the suggested markers can never drive a corrupted file green', () => {
  const spans = [
    MOJIBAKE_EM_DASH, // 3-byte —
    MOJIBAKE_ARROW, // 3-byte →
    'â€¦', // 3-byte …
    'Â§', // 2-byte §
    'â‰¥', // 3-byte ≥
    'ðŸš€', // 4-byte 🚀
  ];
  let text = spans.map((s, n) => `- line ${n} has a ${s} in it\n`).join('');
  const MARKER_RE = /<!-- release-notes-gate: allow "[^"]*" -->/;
  let rounds = 0;
  let res = checkMojibake(text, 'test.md');
  assert.match(res.reason, /6 double-UTF-8-encoded mojibake span\(s\)/);
  while (!res.ok && rounds < 25) {
    const m = res.reason.match(MARKER_RE);
    if (!m) break; // nothing offered — the loop is over
    text = `${m[0]}\n${text}`;
    rounds += 1;
    res = checkMojibake(text, 'test.md');
  }
  assert.ok(rounds < 25, `the paste loop must terminate, took ${rounds} rounds`);
  assert.equal(res.ok, false, 'the gate must never go green off its own suggestions');
  // And it terminated because nothing was offered, not because it ran out of road.
  assert.equal(MARKER_RE.test(res.reason), false, res.reason);
  assert.match(res.reason, /6 double-UTF-8-encoded mojibake span\(s\)/);

  // #1982 round 2 - REPLAYING ONLY WHAT THE GATE OFFERS IS NOT THE THREAT
  // MODEL. The gate offers nothing here, so the loop above ends after zero
  // rounds and proves nothing about an operator who writes a marker by hand.
  // isExcused only asks for one CHARACTER of extension, so the obvious
  // hand-written literal - the span plus the space beside it - used to excuse
  // every occurrence of that span in the file. Replay the padded variants too.
  for (const span of spans) {
    for (const lit of paddedVariants(span)) {
      const padded = `<!-- release-notes-gate: allow "${lit}" -->\n${text}`;
      // The marker parses - this is not a syntax rejection...
      assert.ok(parseMojibakeAllowlist(padded).includes(lit), JSON.stringify(lit));
      // ...it simply excuses nothing at all, so the gate cannot move to green.
      assertSuppressesNothing(padded, `padded suggestion ${JSON.stringify(lit)}`);
    }
  }
});

// #1982 round 2 (F1) - THE STANDALONE-SPAN INVARIANT, STATED DIRECTLY.
//
// "A span standing alone between spaces cannot be allowlisted at all" is the
// gate's own contract (isExcused's doc comment) and the sentence the failure
// message prints at the operator. Nothing pinned it. isExcused requires the
// literal's occurrence to extend one CHARACTER past the span; every doc says
// one WORD. The difference is exactly the adjacent space, and on the real
// 242-span file a literal of " —" (a space plus the flagged pair)
// excused 155 of the 242 spans on its own, all 242 were suppressible, and 31
// hand-written markers reached green.
//
// The assertion is deliberately "not one span was excused" rather than a fixed
// count: the marker line carries its own copy of the literal, and a padded
// literal must fail to excuse even that.
test('a whitespace-padded literal suppresses nothing, so a standalone span stays unallowlistable', () => {
  const body = `The build ${MOJIBAKE_EM_DASH} yes, that one ${MOJIBAKE_EM_DASH} shipped.\n`;
  assert.match(checkMojibake(body, 'test.md').reason, /2 double-UTF-8-encoded mojibake span\(s\)/);

  for (const lit of paddedVariants(MOJIBAKE_EM_DASH)) {
    const text = `<!-- release-notes-gate: allow "${lit}" -->\n\n${body}`;
    assert.deepEqual(parseMojibakeAllowlist(text), [lit]); // the marker parses fine...
    assertSuppressesNothing(text, `padded literal ${JSON.stringify(lit)}`);
  }
});

// The other side of the guard: rejecting whitespace must not cost the feature
// anything. Every literal suggestLiteral can emit is a whitespace-free token,
// and all three documented false-positive shapes are single words.
test('a legitimate whitespace-free token literal still suppresses its span', () => {
  const TOKEN = `serverâ†”frontend`; // the middle three read as a mangled U+2194
  const body = `The ${TOKEN} contract is stable.\n`;
  assert.equal(checkMojibake(body, 'test.md').ok, false); // flagged without a marker
  const res = checkMojibake(`<!-- release-notes-gate: allow "${TOKEN}" -->\n\n${body}`, 'test.md');
  assert.equal(res.ok, true, res.reason);

  // And the three documented false-positive shapes keep working, one marker each.
  for (const shape of [CAFE, GROSS, TROLL]) {
    const t = `<!-- release-notes-gate: allow "${shape}" -->\n\nWe mention ${shape} here.\n`;
    const r = checkMojibake(t, 'test.md');
    assert.equal(r.ok, true, `${shape}: ${r.reason}`);
  }
});

// The strongest form of the invariant: a file whose every span stands between
// spaces cannot be driven green by ANY marker naming the span with adjacent
// whitespace - not one at a time, and not all of them at once.
test('no set of whitespace-padded markers can drive a standalone-span file green', () => {
  const spans = [MOJIBAKE_EM_DASH, MOJIBAKE_ARROW, 'â€¦', 'Â§'];
  const body = spans.map((s, n) => `- item ${n} uses a ${s} here\n`).join('');
  assert.match(checkMojibake(body, 'test.md').reason, /4 double-UTF-8-encoded mojibake span\(s\)/);

  const literals = spans.flatMap((s) => paddedVariants(s));
  const markers = literals.map((l) => `<!-- release-notes-gate: allow "${l}" -->`).join('\n');
  const text = `${markers}\n\n${body}`;
  assert.equal(parseMojibakeAllowlist(text).length, literals.length); // all of them parsed
  assertSuppressesNothing(text, `${literals.length} padded markers at once`);
});

// #1982 F2 — a hit's tail is NOT always mere context. A greedy 4-character match
// can hold two 2-byte mangles; measuring the core off the decoded lead code point
// judged only the first half and dropped the second half with it.
test('a literal ending at one mojibake pair does not swallow the pair immediately after it', () => {
  const body = `Our ${CAFE}Â© sign.\n`; // CAFÉ™ (legitimate) then a mangled ©
  const marker = `<!-- release-notes-gate: allow "${CAFE}" -->`;
  const res = checkMojibake(`${marker}\n\n${body}`, 'test.md');
  assert.equal(res.ok, false, 'the adjacent mangle must still be reported');
  assert.match(res.reason, /1 double-UTF-8-encoded mojibake span/);
  // The whole four-character run is reported, decoding to "ə©" — the second half
  // is the genuine corruption the marker must not reach.
  assert.ok(res.reason.includes(JSON.stringify('É™Â©')), res.reason);
  assert.ok(res.reason.includes('©'), res.reason);
});

// #1982 F3 — fail closed on a malformed marker. Scanning to the next "-->"
// anywhere in the file let an unterminated marker harvest every quoted phrase
// after it as a literal, silencing whatever those phrases happened to contain.
test('an unterminated marker harvests no quoted prose', () => {
  const text =
    `<!-- release-notes-gate: allow "${CAFE}"\n` + // no terminator on this line
    `We shipped "an em dash ${MOJIBAKE_EM_DASH} here" and "an arrow ${MOJIBAKE_ARROW} here".\n` +
    `-->\n`;
  assert.deepEqual(parseMojibakeAllowlist(text), []);
  const res = checkMojibake(text, 'test.md');
  assert.equal(res.ok, false);
  assert.match(res.reason, /3 double-UTF-8-encoded mojibake span\(s\)/);
});

// #1990 — there is no fence exemption at all any more. An earlier version
// skipped markers inside a ```-fenced code block on the theory that
// documenting the syntax in a gated file could not then arm it; the
// fence-awareness itself is deleted now (see the comment above
// parseMojibakeAllowlist), so a marker inside ANY of these shapes is honoured
// like any other, and checkMojibake's `honoured` field / formatHonouredEcho
// name it so an accidental arming is visible rather than silent.
test('a marker inside a backtick-fenced code block now arms, and the echo names it', () => {
  const text =
    '```\n' +
    `<!-- release-notes-gate: allow "${CAFE}" -->\n` +
    '```\n\n' +
    `Order at ${CAFE} today.\n`;
  assert.deepEqual(parseMojibakeAllowlist(text), [CAFE]);
  const res = checkMojibake(text, 'test.md');
  assert.equal(res.ok, true, res.reason); // the fenced marker excuses the span
  assert.deepEqual(res.honoured, [CAFE]);
  assert.equal(formatHonouredEcho('test.md', res.honoured), `[allow] test.md honoured 1 literal(s): "${CAFE}"`);
});

// #1990 shape 1 — a `~~~` fence. The old parser only ever tracked ``` lines,
// so this one already slipped through pre-fix; it stays armed post-fix, and
// what's new is that the echo now names it instead of the marker's presence
// being invisible.
test('a marker inside a ~~~ fence arms, and the echo names it', () => {
  const text = `~~~\n<!-- release-notes-gate: allow "${GROSS}" -->\n~~~\n\nWe serve ${GROSS} portions.\n`;
  assert.deepEqual(parseMojibakeAllowlist(text), [GROSS]);
  const res = checkMojibake(text, 'test.md');
  assert.equal(res.ok, true, res.reason);
  assert.deepEqual(res.honoured, [GROSS]);
  assert.match(formatHonouredEcho('test.md', res.honoured), /honoured 1 literal\(s\)/);
});

// #1990 shape 2 — a 4-space indented code block. There is no fence to track
// at all here, so this also already slipped through pre-fix.
test('a marker inside a 4-space indented code block arms, and the echo names it', () => {
  const text = `    <!-- release-notes-gate: allow "${TROLL}" -->\n\n${TROLL} is up north.\n`;
  assert.deepEqual(parseMojibakeAllowlist(text), [TROLL]);
  const res = checkMojibake(text, 'test.md');
  assert.equal(res.ok, true, res.reason);
  assert.deepEqual(res.honoured, [TROLL]);
});

// #1990 shape 3 — a fence inside a blockquote. The old FENCE_RE's `^\s*`
// anchor never matched the `>` prefix, so this shape also already slipped
// through pre-fix.
test('a marker inside a blockquoted fence arms, and the echo names it', () => {
  const text = `> \`\`\`\n> <!-- release-notes-gate: allow "${DEGREE}" -->\n> \`\`\`\n\nIt hit ${DEGREE} at noon.\n`;
  assert.deepEqual(parseMojibakeAllowlist(text), [DEGREE]);
  const res = checkMojibake(text, 'test.md');
  assert.equal(res.ok, true, res.reason);
  assert.deepEqual(res.honoured, [DEGREE]);
});

// #1990 shape 4 — the parity flip. A single earlier line that merely STARTS
// with a backtick fence toggles the old tracker's in-fence flag with no
// matching partner, so anything after it (fenced or not) inherits the wrong
// state. Here it flips the tracker to "in fence" before it ever reaches the
// marker, so the OLD fence-aware parser reads the marker as inert (an empty
// array) even though nothing about the marker itself is fenced — proving the
// old skip was parity-dependent, not fence-aware. The new parser has no
// concept of fence state at all, so it honours the marker regardless.
test('an unrelated earlier stray backtick-fence line no longer flips the marker after it (parity case)', () => {
  const text =
    '``` this line merely starts with a backtick fence, and has no matching partner\n' +
    `<!-- release-notes-gate: allow "${CAFE}" -->\n\n` +
    `Order at ${CAFE} today.\n`;
  assert.deepEqual(parseMojibakeAllowlist(text), [CAFE]);
  const res = checkMojibake(text, 'test.md');
  assert.equal(res.ok, true, res.reason);
  assert.deepEqual(res.honoured, [CAFE]);
});

// #1982 — the core of the design change, stated directly.
test('a literal naming only the flagged span suppresses nothing, and the failure says why', () => {
  const bare = 'É™';
  const text = `<!-- release-notes-gate: allow "${bare}" -->\n\nzz${bare}zz was mangled.\n`;
  assert.deepEqual(parseMojibakeAllowlist(text), [bare]); // the marker parses fine…
  const res = checkMojibake(text, 'test.md');
  assert.equal(res.ok, false); // …it just excuses nothing, not even its own copy
  assert.match(res.reason, /2 double-UTF-8-encoded mojibake span\(s\)/);
  assert.match(res.reason, /suppresses NOTHING/);
});

// #1985 — a marker is refused outright in RELEASE_NOTES.md: the file is
// cumulative and never mechanically reset, so a marker there would keep its
// literal excused for every future release with nothing to expire it. This
// must fail EVEN THOUGH the marker would otherwise excuse a real span — the
// refusal fires on the marker's mere presence, not on whether it was needed.
test('a marker in RELEASE_NOTES.md is refused outright, naming the file, the literal, and both alternatives', () => {
  const text = `<!-- release-notes-gate: allow "${CAFE}" -->\n\nOrder at ${CAFE} today.\n`;
  const res = checkMojibake(text, 'RELEASE_NOTES.md');
  assert.equal(res.ok, false);
  assert.match(res.reason, /RELEASE_NOTES\.md/);
  assert.match(res.reason, /refused/);
  assert.match(res.reason, /re-encode/i);
  assert.match(res.reason, /--force/);
  assert.ok(res.reason.includes(JSON.stringify(CAFE)), res.reason); // names the literal, not just the file
  assert.deepEqual(res.honoured, []); // refused, so nothing is honoured or echoed
});

// A refusal naming several literals at once names all of them, not just one.
test('a refusal in RELEASE_NOTES.md names every literal a marker offered, not only the first', () => {
  const text = `<!-- release-notes-gate: allow "${CAFE}", "${GROSS}" -->\n\nOrder at ${CAFE} today.\n`;
  const res = checkMojibake(text, 'RELEASE_NOTES.md');
  assert.equal(res.ok, false);
  assert.ok(res.reason.includes(JSON.stringify(CAFE)), res.reason);
  assert.ok(res.reason.includes(JSON.stringify(GROSS)), res.reason);
});

// The refusal is keyed on the label naming RELEASE_NOTES.md specifically —
// the exact same marker, in any other label (docs/release-notes-next.md, or a
// bare working-file label used elsewhere in this suite), still works exactly
// as it always has.
test('the same marker still works in every label other than RELEASE_NOTES.md', () => {
  const text = `<!-- release-notes-gate: allow "${CAFE}" -->\n\nOrder at ${CAFE} today.\n`;
  for (const label of ['docs/release-notes-next.md', 'test.md', 'notes.md']) {
    const res = checkMojibake(text, label);
    assert.equal(res.ok, true, `${label}: ${res.reason}`);
    assert.deepEqual(res.honoured, [CAFE], label);
  }
});

// A file that simply has no marker at all is unaffected by the refusal path —
// RELEASE_NOTES.md must still fail (and pass) exactly as before on ordinary
// mojibake with no marker in sight.
test('RELEASE_NOTES.md with no marker still gates mojibake normally', () => {
  assert.equal(checkMojibake('Clean text with a real — dash.', 'RELEASE_NOTES.md').ok, true);
  const res = checkMojibake(`Corrupted: ${MOJIBAKE_EM_DASH} dash.`, 'RELEASE_NOTES.md');
  assert.equal(res.ok, false);
  assert.match(res.reason, /1 double-UTF-8-encoded mojibake span/);
  assert.deepEqual(res.honoured, []); // no marker present, so nothing to honour
});

// PR #2007 review, Major 1 — a SUGGESTIBLE span (word-embedded, unlike the
// standalone em-dash above) must not make the gate print a paste-able marker
// line for RELEASE_NOTES.md: that label refuses any marker outright (#1985),
// so following the old "add this line to RELEASE_NOTES.md: ..." advice
// verbatim just walked the operator into the refusal above on the very next
// run. This is exactly the shape the standalone-em-dash test above cannot
// catch, since a standalone span was never suggestible to begin with.
test('a suggestible span in RELEASE_NOTES.md never advises a paste-able marker line', () => {
  const res = checkMojibake(`Ships with a ${CAFE} badge.`, 'RELEASE_NOTES.md');
  assert.equal(res.ok, false);
  assert.doesNotMatch(res.reason, /add this line/);
  assert.doesNotMatch(res.reason, /<!--/);
  assert.match(res.reason, /refused outright/);
  assert.match(res.reason, /re-encode/i);
  assert.match(res.reason, /--force/);
  assert.match(res.reason, /bump-version\.mjs-only/);
  assert.deepEqual(res.honoured, []); // no marker was present to honour
});

// PR #2007 review, Minor 6 — CONTRIBUTING.md and the header comment both
// promise the refusal covers "any marker," not merely one that happens to
// parse a quoted literal. A marker with no literal at all must still refuse.
test('a marker naming no literal at all is still refused in RELEASE_NOTES.md', () => {
  const res = checkMojibake('<!-- release-notes-gate: allow -->\nSome text.', 'RELEASE_NOTES.md');
  assert.equal(res.ok, false);
  assert.match(res.reason, /refused/);
  assert.deepEqual(res.honoured, []);
});

// #1990 — formatHonouredEcho itself: the exact echo wording, and that it is
// silent (returns null) when nothing was honoured, so a normal, marker-free
// run prints nothing extra.
test('formatHonouredEcho names every honoured literal and stays silent otherwise', () => {
  assert.equal(
    formatHonouredEcho('docs/release-notes-next.md', [CAFE, GROSS]),
    `[allow] docs/release-notes-next.md honoured 2 literal(s): "${CAFE}", "${GROSS}"`,
  );
  assert.equal(formatHonouredEcho('docs/release-notes-next.md', []), null);
  assert.equal(formatHonouredEcho('docs/release-notes-next.md', undefined), null);
});

// #1990 — the echo fires on a PASSING run too, not only a failing one: a
// marker that excused every span it named must still show up in `honoured`.
test('checkMojibake reports honoured markers even when the gate passes', () => {
  const text = `<!-- release-notes-gate: allow "${CAFE}" -->\n\nOrder at ${CAFE} today.\n`;
  const res = checkMojibake(text, 'test.md');
  assert.equal(res.ok, true, res.reason);
  assert.deepEqual(res.honoured, [CAFE]);
  assert.equal(formatHonouredEcho('test.md', res.honoured), `[allow] test.md honoured 1 literal(s): "${CAFE}"`);
});

// #1990 — the echo also fires on a FAILING run: a marker that excuses nothing
// (or not everything) must still be named, so an operator can see it was
// parsed even though it didn't help.
test('checkMojibake reports honoured markers even when the gate still fails', () => {
  const text = `<!-- release-notes-gate: allow "${CAFE}" -->\n\nCorrupted: ${MOJIBAKE_EM_DASH} dash.\n`;
  const res = checkMojibake(text, 'test.md');
  assert.equal(res.ok, false);
  assert.deepEqual(res.honoured, [CAFE]);
});

// Fail-closed regression (#1990's confirmed-working list, item 1): a marker
// split across two lines — the terminator IS present, just on the wrong line
// — still yields nothing. ALLOW_MARKER_RE requires `-->` on the same line as
// `<!--` (no fence involved at all), so this was never about fences and stays
// exactly as strict post-fix.
test('a marker split across two lines yields nothing, fence or no fence', () => {
  // The literal is deliberately plain ASCII (not CAFE) so the malformed
  // marker's own leaked text can't itself register as a second mojibake hit.
  const text = `<!-- release-notes-gate: allow "HELLO"\n-->\n\nCorrupted: ${MOJIBAKE_EM_DASH} dash.\n`;
  assert.deepEqual(parseMojibakeAllowlist(text), []);
  const res = checkMojibake(text, 'test.md');
  assert.equal(res.ok, false);
  assert.match(res.reason, /1 double-UTF-8-encoded mojibake span/);
});

// Fail-closed regression (#1990's confirmed-working list, item 3): CRLF line
// endings must not break marker parsing (a marker still parses) or the
// mojibake scan itself.
test('CRLF line endings do not break marker parsing or the mojibake scan', () => {
  const text = `<!-- release-notes-gate: allow "${CAFE}" -->\r\n\r\nOrder at ${CAFE} today.\r\n`;
  assert.deepEqual(parseMojibakeAllowlist(text), [CAFE]);
  const res = checkMojibake(text, 'test.md');
  assert.equal(res.ok, true, res.reason);
  assert.deepEqual(res.honoured, [CAFE]);
});

// PR #2007 review, Major 2 — the CLI's own call site (the for-loop over
// mojibakeTargets that prints formatHonouredEcho's result on every run, pass
// or fail) had no test targeting it at all: every test above calls
// checkMojibake()/formatHonouredEcho() directly, so a deleted `if (echo)
// process.stdout.write(...)` line was invisible to the whole suite.
// docs/release-notes-next.md (not RELEASE_NOTES.md, which refuses a marker
// outright) is where a real marker can actually be honoured and echoed.
test('the CLI echoes an honoured marker in docs/release-notes-next.md on stdout', () => {
  const dir = setupGateFixture();
  try {
    writeFileSync(resolve(dir, 'RELEASE_NOTES.md'), '# v1.0.0\n\n- Something shipped.\n');
    writeFileSync(
      resolve(dir, 'docs', 'release-notes-next.md'),
      `<!-- release-notes-gate: allow "${CAFE}" -->\n\n# v1.0.0\n\n- Ships with a ${CAFE} badge.\n`,
    );
    const out = runGate(dir, ['v1.0.0']);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /^\[allow\] docs\/release-notes-next\.md honoured 1 literal\(s\): "CAFÉ™"$/m);
    assert.match(out.stdout, /OK — RELEASE_NOTES\.md leads with 1\.0\.0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #2018 — the gate must catch unresolved git conflict markers: not
// hypothetical, three of them landed inside RELEASE_NOTES.md's own v1.15.0
// section on PR #2010 with every other gate green.
const CONFLICT_FIXTURE =
  '- **Line before.**\n' +
  '<<<<<<< HEAD\n' +
  '- **Ours.**\n' +
  '=======\n' +
  '- **Theirs.**\n' +
  '>>>>>>> origin/main\n' +
  '- **Line after.**\n';

test('findConflictMarkers finds the outer <<<<<<< / >>>>>>> pair with 1-indexed line numbers', () => {
  const hits = findConflictMarkers(CONFLICT_FIXTURE);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].line, 2);
  assert.equal(hits[0].text, '<<<<<<< HEAD');
  assert.equal(hits[1].line, 6);
  assert.equal(hits[1].text, '>>>>>>> origin/main');
});

test('findConflictMarkers does not flag a bare "=======" markdown setext rule', () => {
  // A setext heading underline, with no <<<<<<< / >>>>>>> anywhere nearby —
  // the property #2018 explicitly calls out as a false-positive risk to avoid.
  const text = 'Title\n=======\n\nSome prose.\n';
  assert.deepEqual(findConflictMarkers(text), []);
});

test('findConflictMarkers finds nothing in ordinary release-note prose', () => {
  assert.deepEqual(findConflictMarkers('- **Ships a fix.** Details here.\n'), []);
});

test('checkConflictMarkers fails and names the file and line numbers', () => {
  const res = checkConflictMarkers(CONFLICT_FIXTURE, 'RELEASE_NOTES.md');
  assert.equal(res.ok, false);
  assert.match(res.reason, /RELEASE_NOTES\.md/);
  assert.match(res.reason, /2 unresolved git conflict marker/);
  assert.match(res.reason, /line\(s\) 2, 6/);
  assert.match(res.reason, /no allowlist/);
});

test('checkConflictMarkers passes on clean text', () => {
  assert.equal(checkConflictMarkers('Clean release notes.\n', 'RELEASE_NOTES.md').ok, true);
});

// The CLI wiring itself: a marker in EITHER gated file fails the run and
// names the file + line, and — the property #2018 exists for — this fires
// even though the file's version heading and mojibake are both otherwise
// clean, i.e. no other check happens to catch it first.
test('the CLI fails on an unresolved conflict marker in RELEASE_NOTES.md, naming the file and line', () => {
  const dir = setupGateFixture();
  try {
    writeFileSync(
      resolve(dir, 'RELEASE_NOTES.md'),
      `# v1.15.0\n\n${CONFLICT_FIXTURE}`,
    );
    const out = runGate(dir, ['v1.15.0']);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /RELEASE_NOTES\.md contains 2 unresolved git conflict marker/);
    assert.match(out.stderr, /line\(s\) 4, 8/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI fails on an unresolved conflict marker in docs/release-notes-next.md', () => {
  const dir = setupGateFixture();
  try {
    writeFileSync(resolve(dir, 'RELEASE_NOTES.md'), '# v1.0.0\n\n- Something shipped.\n');
    writeFileSync(
      resolve(dir, 'docs', 'release-notes-next.md'),
      `# v1.0.0\n\n${CONFLICT_FIXTURE}`,
    );
    const out = runGate(dir, ['v1.0.0']);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /docs\/release-notes-next\.md contains 2 unresolved git conflict marker/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #2025 — the echo's ORDERING relative to its failure branch was untested,
// and ordering is the whole property: PR #2007 replaced fence-awareness with
// "an armed marker is never silent," which only holds if the [allow] line
// prints even when the run goes on to fail. Both prior CLI spawn tests
// (above) only ever exercised a PASSING run, so a `process.exit(1)` moved to
// sit BEFORE the echo write was invisible to the whole suite — verified
// during the PR #2007 re-review: moving both echo blocks after their failure
// branches left the suite at 81 pass / 0 fail while genuinely silencing the
// echo on every failing run. This fixture — an armed CAFÉ™ marker plus a
// SEPARATE, unallowlistable standalone mangle — forces exactly that
// combination: the gate still fails (the standalone span), but the marker it
// honoured along the way must still be echoed.
test('the CLI echoes an honoured marker even on a run that still fails overall', () => {
  const dir = setupGateFixture();
  try {
    writeFileSync(resolve(dir, 'RELEASE_NOTES.md'), '# v1.0.0\n\n- Something shipped.\n');
    writeFileSync(
      resolve(dir, 'docs', 'release-notes-next.md'),
      `<!-- release-notes-gate: allow "${CAFE}" -->\n\n# v1.0.0\n\n` +
        `- Ships with a ${CAFE} badge.\n` +
        `- A ${MOJIBAKE_EM_DASH} standing alone.\n`,
    );
    const out = runGate(dir, ['v1.0.0']);
    assert.equal(out.status, 1);
    assert.match(out.stdout, /^\[allow\] docs\/release-notes-next\.md honoured 1 literal\(s\): "CAFÉ™"$/m);
    assert.match(out.stderr, /1 double-UTF-8-encoded mojibake span/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI passes on a clean RELEASE_NOTES.md with no conflict markers', () => {
  const dir = setupGateFixture();
  try {
    writeFileSync(resolve(dir, 'RELEASE_NOTES.md'), '# v1.0.0\n\n- Something shipped.\n');
    const out = runGate(dir, ['v1.0.0']);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /OK — RELEASE_NOTES\.md leads with 1\.0\.0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// PR #2049 review, F5 — the conflict check (#2018) was a NEW early exit added
// in this same PR, and it originally ran BEFORE the mojibake echo: a target
// carrying both a conflict marker and an armed `allow` marker died naming
// only the conflict, with the armed marker never echoed that run — silently
// regressing #1990's "an armed marker is never silent" property for exactly
// the files it's meant to cover. The fix computes the mojibake check (and
// prints its echo) before EITHER failure branch, so the echo survives
// regardless of which check is what ultimately fails the run.
test('an armed marker is still echoed even when a conflict marker is what fails the run', () => {
  const dir = setupGateFixture();
  try {
    writeFileSync(resolve(dir, 'RELEASE_NOTES.md'), '# v1.0.0\n\n- Something shipped.\n');
    writeFileSync(
      resolve(dir, 'docs', 'release-notes-next.md'),
      `<!-- release-notes-gate: allow "${CAFE}" -->\n\n# v1.0.0\n\n` +
        `- Ships with a ${CAFE} badge.\n\n${CONFLICT_FIXTURE}`,
    );
    const out = runGate(dir, ['v1.0.0']);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /docs\/release-notes-next\.md contains 2 unresolved git conflict marker/);
    assert.match(out.stdout, /^\[allow\] docs\/release-notes-next\.md honoured 1 literal\(s\): "CAFÉ™"$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #2114 — a UTF-8 byte-order mark (U+FEFF / EF BB BF bytes) must never lead
// docs/release-notes-next.md or RELEASE_NOTES.md: the former is fed verbatim
// into the annotated tag message, which release.yml publishes as the public
// GitHub release body, and a leading BOM can defeat the CommonMark
// HTML-block start condition that keeps the file's internal maintainer
// comment invisible. Not hypothetical — a branch in the #2040 follow-up wave
// committed exactly this (`3c 21 2d 2d` -> `ef bb bf 3c`) with every gate at
// the time green.

/** Write `text` to `path` with a REAL UTF-8 BOM prepended, as raw bytes (not
 *  via a JS string + 'utf8' encoding) — the fixture must carry the literal
 *  `EF BB BF` byte sequence a corrupted Windows text editor would actually
 *  produce, so a test built on it proves the gate catches the real defect
 *  rather than a string-level stand-in a BOM-stripping reader could
 *  silently normalise away. */
function writeBOMFile(path, text) {
  writeFileSync(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]));
}

// Built via fromCharCode, not an embedded literal, so this test file — which
// specifically pins detection of a stray BOM — never itself carries one as
// raw source bytes outside of writeBOMFile's deliberate byte-level fixture.
const BOM_CHAR = String.fromCharCode(0xfeff);

test('hasBOM / stripBOM / checkBOM operate on the exact U+FEFF code point', () => {
  assert.equal(hasBOM(`${BOM_CHAR}# Hello`), true);
  assert.equal(hasBOM('# Hello'), false);
  assert.equal(hasBOM(''), false);
  assert.equal(stripBOM(`${BOM_CHAR}# Hello`), '# Hello');
  assert.equal(stripBOM('# Hello'), '# Hello'); // no-op when absent
  assert.equal(checkBOM(`${BOM_CHAR}# Hello`, 'test.md').ok, false);
  assert.equal(checkBOM('# Hello', 'test.md').ok, true);
});

test('checkBOM names the file and the byte sequence, with no allowlist/--force escape', () => {
  const res = checkBOM(`${BOM_CHAR}# v1.0.0\n`, 'docs/release-notes-next.md');
  assert.equal(res.ok, false);
  assert.match(res.reason, /docs\/release-notes-next\.md/);
  assert.match(res.reason, /U\+FEFF/);
  assert.match(res.reason, /EF BB BF/);
  assert.match(res.reason, /no allowlist or --force/);
});

test('the CLI fails on a real BOM-prefixed docs/release-notes-next.md, naming the file', () => {
  const dir = setupGateFixture();
  try {
    writeFileSync(resolve(dir, 'RELEASE_NOTES.md'), '# v1.0.0\n\n- Something shipped.\n');
    const notesNextPath = resolve(dir, 'docs', 'release-notes-next.md');
    writeBOMFile(notesNextPath, '<!-- internal maintainer notes -->\n\n# v1.0.0\n\n- Something shipped.\n');

    // Control assertion (per the test bar): the fixture on disk carries the
    // REAL byte sequence, not a string-level stand-in.
    const rawBytes = readFileSync(notesNextPath);
    assert.deepEqual([...rawBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);

    const out = runGate(dir, ['v1.0.0']);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /docs\/release-notes-next\.md begins with a UTF-8 byte-order mark/);
    assert.match(out.stderr, /EF BB BF/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI fails on a real BOM-prefixed RELEASE_NOTES.md, naming the file', () => {
  const dir = setupGateFixture();
  try {
    const notesPath = resolve(dir, 'RELEASE_NOTES.md');
    writeBOMFile(notesPath, '# v1.0.0\n\n- Something shipped.\n');

    const rawBytes = readFileSync(notesPath);
    assert.deepEqual([...rawBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);

    const out = runGate(dir, ['v1.0.0']);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /RELEASE_NOTES\.md begins with a UTF-8 byte-order mark/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI passes on clean, BOM-free RELEASE_NOTES.md and docs/release-notes-next.md', () => {
  const dir = setupGateFixture();
  try {
    const notesPath = resolve(dir, 'RELEASE_NOTES.md');
    const notesNextPath = resolve(dir, 'docs', 'release-notes-next.md');
    writeFileSync(notesPath, '# v1.0.0\n\n- Something shipped.\n');
    writeFileSync(notesNextPath, '# v1.0.0\n\n- Something shipped.\n');

    // Control: confirm the clean fixtures genuinely carry no BOM bytes.
    assert.notDeepEqual([...readFileSync(notesPath).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.notDeepEqual([...readFileSync(notesNextPath).subarray(0, 3)], [0xef, 0xbb, 0xbf]);

    const out = runGate(dir, ['v1.0.0']);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /OK — RELEASE_NOTES\.md leads with 1\.0\.0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
