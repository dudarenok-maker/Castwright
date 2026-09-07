// Guard: no non-ASCII character may sit outside a comment in this repo's
// PowerShell sources (#3055 pass-2 blocking finding).
//
// The defect this closes: an em dash inside a double-quoted string literal in
// scripts/lib/wt-gc-junctions.psm1 made the whole module unparseable under
// Windows PowerShell 5.1 (a BOM-less UTF-8 file is decoded as CP1252 there,
// and the em dash's third byte lands on a character the PS lexer accepts as a
// closing double quote). `Import-Module` failed, `Remove-JunctionsRecursive`
// was undefined, the wrapper .ps1 exited 3, and `wt-gc.mjs --prune` reported
// `junction removal failed` for EVERY tree. See scripts/lib/ps-ascii-scan.mjs
// for the byte-level detail.
//
// Nothing in the suite could catch it, which is why it shipped green: both
// wt-gc.mjs's pickPowerShell() and scripts/run-powershell.mjs probe `pwsh`
// first, and `pwsh` decodes the file as UTF-8 and parses it fine. This guard
// is source-level for exactly that reason — the same shape as the .LinkTarget
// source pin in scripts/tests/wt-gc-junctions.Tests.ps1, and for the same
// reason: it is the only kind of test that can catch a 5.1-only defect from a
// box that runs PowerShell 7.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrubGitEnv } from '../git-env.mjs';
import { scanPowerShellNonAscii, formatNonAsciiFindings } from '../lib/ps-ascii-scan.mjs';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/**
 * EVERY tracked `.ps1`/`.psm1` in the repo, not a hand-listed subset.
 *
 * This used to `readdirSync` scripts/lib and scripts/tests non-recursively,
 * which covered 18 of the repo's 30 PowerShell files while the test's name
 * claimed a repo-wide invariant (#3055 pass 3). Twelve were invisible to it,
 * including scripts/start-app.ps1 — `npm start`'s entry point, `#requires
 * -Version 5.1`, and a live counter-example to the stated rule (four em
 * dashes in double-quoted strings; safe only because it carries a BOM, which
 * scanPowerShellNonAscii now models).
 *
 * `git ls-files` rather than a directory walk, deliberately: a walk would
 * sweep untracked and git-ignored trees, and server/tts-sidecar/.venv/Scripts
 * alone ships several third-party `.ps1` files this repo neither owns nor can
 * fix. Tracked-ness is the property that makes a file ours to keep ASCII.
 *
 * NO file is excluded. If one ever has to be, exclude it here by explicit
 * path with the reason — never by narrowing the enumeration, which is exactly
 * how the gap above went unnoticed.
 */
function powerShellSources() {
  const out = execFileSync('git', ['-C', repoRoot, 'ls-files', '*.ps1', '*.psm1'], {
    encoding: 'utf8',
    env: scrubGitEnv(),
  });
  return out.split('\n').map((l) => l.trim()).filter(Boolean).sort();
}

// ---- The repo-wide guard ---------------------------------------------------

test('no tracked PowerShell source in the repo carries a non-ASCII character outside a comment', () => {
  const files = powerShellSources();
  // A guard over an empty file set passes vacuously — pin that it actually
  // read something. 30 files at the time of writing; the floor is deliberately
  // loose so adding/removing a suite does not fail this for the wrong reason,
  // but it is above the 18 the pre-#3055-pass-3 enumeration reached, so a
  // silent regression back to a scripts/{lib,tests}-only walk fails here.
  assert.ok(files.length >= 25, `expected to scan the repo's PowerShell sources, found ${files.length}`);

  // The set really does reach outside scripts/lib + scripts/tests — the two
  // directories the old enumeration walked. Named files rather than a count,
  // so this says which coverage is being pinned.
  for (const rel of ['scripts/start-app.ps1', 'server/tts-sidecar/start.ps1']) {
    assert.ok(files.includes(rel), `${rel} must be inside the guarded set`);
  }

  const problems = [];
  for (const rel of files) {
    const findings = scanPowerShellNonAscii(readFileSync(join(repoRoot, rel), 'utf8'));
    if (findings.length > 0) problems.push(formatNonAsciiFindings(rel, findings));
  }
  assert.equal(
    problems.length,
    0,
    'Non-ASCII outside a comment in PowerShell source. Windows PowerShell 5.1 decodes a\n' +
      'BOM-less UTF-8 file as CP1252, so these characters change the token stream there and\n' +
      'can terminate a string literal mid-line, making the whole file unparseable.\n' +
      'Use ASCII (`--` for an em dash, `-` for an en dash, `"` for smart quotes).\n' +
      'Comments may carry non-ASCII; string literals and code may not.\n\n' +
      problems.join('\n'),
  );
});

test('the specific 5.1-breaking shape: wt-gc-junctions.psm1 throw strings are pure ASCII', () => {
  // Named for the site the class guard was written from, so a reintroduction
  // there points at the history rather than only at the class.
  const psm1 = readFileSync(join(repoRoot, 'scripts', 'lib', 'wt-gc-junctions.psm1'), 'utf8');
  const throwLines = psm1.split(/\r?\n/).filter((l) => l.trim().startsWith('throw '));
  assert.ok(throwLines.length >= 2, 'expected the two fail-closed scan throws to still exist');
  for (const line of throwLines) {
    assert.ok(
      [...line].every((c) => c.codePointAt(0) <= 127),
      `throw string must be ASCII-only (Windows PowerShell 5.1 mis-decodes it otherwise): ${line.trim()}`,
    );
  }
});

// ---- The scanner itself ----------------------------------------------------
// Each case pairs a positive with the negative that proves the classifier is
// reading lexical state rather than always-firing (or never-firing).

test('scanner: flags a non-ASCII character inside a double-quoted string', () => {
  const findings = scanPowerShellNonAscii('throw "a — b"');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].codePoint, 'U+2014');
  assert.equal(findings[0].context, 'double-quoted string');
});

test('scanner: flags a non-ASCII character inside a single-quoted string', () => {
  const findings = scanPowerShellNonAscii("It 'a — b' {}");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].context, 'single-quoted string');
});

test('scanner: flags a non-ASCII character in bare code (not in any string)', () => {
  const findings = scanPowerShellNonAscii('$x = 1 — 2');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].context, 'code');
});

test('scanner: ALLOWS a non-ASCII character in a line comment (proves it is not always-on)', () => {
  assert.deepEqual(scanPowerShellNonAscii('# prose — with an em dash'), []);
});

test('scanner: ALLOWS a non-ASCII character in a trailing comment after code', () => {
  assert.deepEqual(scanPowerShellNonAscii('$x = 1  # prose — here'), []);
});

test('scanner: ALLOWS a non-ASCII character inside a <# block comment #>', () => {
  assert.deepEqual(scanPowerShellNonAscii('<#\n prose — here\n#>\n$x = 1'), []);
});

test('scanner: a `#` INSIDE a string does not start a comment — the naive-strip miss', () => {
  // The whole reason this is a lexer and not a regex: stripping from the
  // first `#` would swallow the em dash and report a clean file.
  const findings = scanPowerShellNonAscii('Write-Host "issue #3055 — broken"');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].context, 'double-quoted string');
});

test('scanner: reports line and column of the offending character', () => {
  const findings = scanPowerShellNonAscii('$a = 1\n$b = "x—"');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 2);
  assert.equal(findings[0].column, 8);
});

test('scanner: flags a non-ASCII character inside a here-string body', () => {
  const findings = scanPowerShellNonAscii('$s = @"\nline — here\n"@\n');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].context, 'here-string');
});

test('scanner: a here-string terminator returns to code, so a later comment is still allowed', () => {
  assert.deepEqual(scanPowerShellNonAscii("$s = @'\nplain\n'@\n# tail — comment"), []);
});

test('scanner: doubled quotes inside a string are an escape, not a close', () => {
  // `''` does not end the string, so the em dash after it is still inside it.
  const findings = scanPowerShellNonAscii("It 'box''s — label' {}");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].context, 'single-quoted string');
});

test('scanner: an all-ASCII file produces no findings', () => {
  assert.deepEqual(scanPowerShellNonAscii('# comment\nthrow "a -- b"\n$x = @{ y = 1 }\n'), []);
});

test('formatNonAsciiFindings: names the file, position, code point and context', () => {
  const findings = scanPowerShellNonAscii('throw "a — b"');
  const text = formatNonAsciiFindings('scripts/lib/x.psm1', findings);
  assert.match(text, /scripts\/lib\/x\.psm1:1:10/);
  assert.match(text, /U\+2014/);
  assert.match(text, /double-quoted string/);
});

// ---- BOM: the one thing that makes non-ASCII safe (#3055 pass 3) -----------

test('scanner: a UTF-8 BOM makes the whole file clean -- 5.1 decodes it as UTF-8', () => {
  // scripts/start-app.ps1's real shape. Without this, widening the guarded
  // set to every tracked PowerShell file reddens it on a file with no live
  // defect, AND the BOM itself is reported as a U+FEFF-in-code finding.
  const src = '\uFEFF#requires -Version 5.1\nWrite-Host "Castwright \u2014 any book"\n';
  assert.deepEqual(scanPowerShellNonAscii(src), []);
});

test('scanner: the SAME source without the BOM is flagged (proves the BOM path is not always-clean)', () => {
  const src = '#requires -Version 5.1\nWrite-Host "Castwright \u2014 any book"\n';
  const findings = scanPowerShellNonAscii(src);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].codePoint, 'U+2014');
  assert.equal(findings[0].context, 'double-quoted string');
});

test('scanner: a BOM only counts at offset 0, not mid-file', () => {
  const findings = scanPowerShellNonAscii('$x = 1\n$y = "a\uFEFFb"\n');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].codePoint, 'U+FEFF');
  assert.equal(findings[0].line, 2);
});

test('scripts/start-app.ps1 really is BOM-carrying -- the reason it scans clean', () => {
  // Pins the premise of the exemption rather than the exemption's effect: if
  // someone strips the BOM, this fails and names why, instead of the repo-wide
  // guard failing with four opaque em-dash findings.
  const raw = readFileSync(join(repoRoot, 'scripts', 'start-app.ps1'));
  assert.deepEqual(
    [raw[0], raw[1], raw[2]],
    [0xef, 0xbb, 0xbf],
    'scripts/start-app.ps1 carries em dashes in double-quoted strings and is safe ONLY because\n' +
      'of its UTF-8 BOM. Either restore the BOM or replace those em dashes with `--`.',
  );
});

// ---- Multi-line string literals (#3055 pass-3 minor 1) ---------------------

test('scanner: a `#` opening the continuation line of a multi-line string does NOT hide it', () => {
  // Measured under Windows PowerShell 5.1: this source is a ParserError
  // ("Unexpected token 'launch'" + "The string is missing the terminator").
  // The scanner used to return [] for it -- the exact class it exists to
  // close, passing clean.
  const src = '$msg = "Castwright start\n  # step 2 \u2014 launch the sidecar\n  done"\n';
  const findings = scanPowerShellNonAscii(src);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].codePoint, 'U+2014');
  assert.equal(findings[0].line, 2);
});

test('scanner: a `<# ... #>` on a multi-line string continuation line does NOT hide it either', () => {
  const src = '$msg = "Castwright start\n  <# step 2 \u2014 launch #>\n  done"\n';
  const findings = scanPowerShellNonAscii(src);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].codePoint, 'U+2014');
});

test('scanner: comments before any unterminated quote are still comments (the latch is not always-on)', () => {
  // The negative half: without this, "flag everything" would pass the two
  // tests above for the wrong reason.
  const src = '# header \u2014 prose\n$x = 1  # trailing \u2014 prose\n$msg = "open\n# after \u2014 latched\n"\n';
  const findings = scanPowerShellNonAscii(src);
  assert.equal(findings.length, 1, 'only the post-latch line should be reported');
  assert.equal(findings[0].line, 4);
});

test('no tracked PowerShell source trips the unterminated-quote latch', () => {
  // The latch over-reports by design. This pins that the design is free
  // today: if a real file ever ends a line inside an unterminated quote, this
  // fails FIRST and names it, instead of the repo-wide guard above failing
  // with a confusing pile of comment-prose findings.
  //
  // Probe: append a comment carrying an em dash to each file and rescan. In an
  // unlatched file that comment is skipped; in a latched one the `#` no longer
  // opens a comment, so the em dash is reported. Directly falsifiable -- the
  // sentinel IS a violation if the latch fired, and is invisible if it did not.
  const SENTINEL = '\n# latch probe — em dash in a comment\n';
  const latched = [];
  for (const rel of powerShellSources()) {
    const text = readFileSync(join(repoRoot, rel), 'utf8');
    if (text.charCodeAt(0) === 0xfeff) continue; // clean by construction
    if (scanPowerShellNonAscii(text + SENTINEL).length > 0) latched.push(rel);
  }
  assert.deepEqual(latched, []);

  // The probe itself must be able to fire, or the loop above proves nothing.
  assert.equal(scanPowerShellNonAscii('$m = "open' + SENTINEL).length, 1);
});

// ---- The stated mechanism must be true (#3055 pass-3 minor 4) --------------

test('ps-ascii-scan.mjs states the CP1252 mis-decode correctly, and for the whole class', () => {
  // The header used to say the em dash's third byte "is `\"`". It is not: 0x94
  // is U+201D, and it closes the literal because PowerShell accepts smart
  // quotes as string delimiters. Stated the wrong way it understates the
  // class -- a reader concludes only em dashes in double-quoted strings
  // matter. Re-derive the three measured cases from the actual encodings so
  // this is a check, not a restatement.
  const decodeCp1252Tail = (cp) => {
    const bytes = Buffer.from(String.fromCodePoint(cp), 'utf8');
    return new TextDecoder('windows-1252').decode(bytes).at(-1);
  };
  assert.equal(decodeCp1252Tail(0x2014), '”'); // EM DASH      -> RIGHT DOUBLE QUOTE
  assert.equal(decodeCp1252Tail(0x2013), '“'); // EN DASH      -> LEFT DOUBLE QUOTE
  assert.equal(decodeCp1252Tail(0x2011), '‘'); // NB HYPHEN    -> LEFT SINGLE QUOTE
  assert.notEqual(decodeCp1252Tail(0x2014), '"', 'byte 0x94 is NOT ASCII 0x22');

  const header = readFileSync(join(repoRoot, 'scripts', 'lib', 'ps-ascii-scan.mjs'), 'utf8').slice(0, 3000);
  assert.match(header, /U\+201D/, 'the header must name the character the em dash actually becomes');
  assert.match(header, /U\+2013/, 'the header must show the class is wider than the em dash');
  assert.match(header, /U\+2011/, 'the header must show a SINGLE-quoted string is reachable too');
});
