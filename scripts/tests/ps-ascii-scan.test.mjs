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
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanPowerShellNonAscii, formatNonAsciiFindings } from '../lib/ps-ascii-scan.mjs';

const scriptsDir = dirname(dirname(fileURLToPath(import.meta.url)));

/** scripts/lib/*.ps1, scripts/lib/*.psm1, scripts/**\/*.Tests.ps1 */
function powerShellSources() {
  const files = [];
  for (const sub of ['lib', 'tests']) {
    const dir = join(scriptsDir, sub);
    for (const name of readdirSync(dir)) {
      const isLibModule = sub === 'lib' && /\.psm?1$/.test(name);
      const isPesterSuite = /\.Tests\.ps1$/.test(name);
      if (isLibModule || isPesterSuite) files.push(join(sub, name).replace(/\\/g, '/'));
    }
  }
  return files;
}

// ---- The repo-wide guard ---------------------------------------------------

test('no PowerShell source under scripts/ carries a non-ASCII character outside a comment', () => {
  const files = powerShellSources();
  // A guard over an empty file set passes vacuously — pin that it actually
  // read something. 18 files at the time of writing; the floor is deliberately
  // loose so adding/removing a suite does not fail this for the wrong reason.
  assert.ok(files.length >= 10, `expected to scan the repo's PowerShell sources, found ${files.length}`);

  const problems = [];
  for (const rel of files) {
    const findings = scanPowerShellNonAscii(readFileSync(join(scriptsDir, rel), 'utf8'));
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
  const psm1 = readFileSync(join(scriptsDir, 'lib', 'wt-gc-junctions.psm1'), 'utf8');
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
