// Regression test for the ffmpeg-install fail-open defect observed on
// cross-os.yml run 31564717092 (fix/scripts-cross-os-test-hooks): the
// "Install ffmpeg (Windows)" step's `choco install ffmpeg -y --no-progress`
// reported success (exit 0) while installing 0/0 packages (a 504 from the
// Chocolatey community feed) — choco's own exit code is not a reliable
// success signal. The failure only surfaced ~5 minutes later, in a totally
// different step, as scripts/preflight-ffmpeg.cjs's "ffmpeg not found"
// message (aimed at a developer workstation, not a CI runner).
//
// This pins the invariant that actually broke: the Windows ffmpeg-install
// step must verify ffmpeg is ACTUALLY RUNNABLE afterward (not just trust
// choco's exit code) and must fail the step loudly, with a CI-oriented
// message, if it isn't.
//
// Scope: only the Windows/choco step. The macOS/brew steps are NOT covered
// here — investigated separately (see the PR/report this test shipped
// with): GitHub's default (non-Windows, no explicit `shell:`) run-step shell
// is `bash -e {0}` (actions/runner ADR 0277), and `brew install` returns a
// genuine non-zero exit on a real install failure (already-installed is a
// real success case, not a masked failure) — so the macOS step already fails
// the job loudly via `-e` and does not share the fail-open defect this test
// guards against.
//
// #2480 extracted the Windows step's script out of cross-os.yml and
// release.yml (previously byte-duplicated across both) into the composite
// action .github/actions/install-ffmpeg-windows/action.yml, so there is now
// exactly one copy of the script to pin. The tests below exercise it there;
// a separate check at the bottom of this file confirms both workflows still
// reference the composite action, so a future edit can't quietly reintroduce
// an inline duplicate.
//
// IMPORTANT LIMITATION, closed below: every assertion above this line is
// TEXTUAL — it greps the step's source for phrases like `ffmpeg -version`,
// `exit 1`, and a loop shape. None of that proves the script actually RUNS.
// Run 31566528082 demonstrated exactly the gap: the step's `run:` block had
// a PowerShell parse error (`$maxAttempts:` inside a double-quoted string —
// PowerShell reads `$name:` as a scope-qualified variable reference, e.g.
// `$env:PATH` or `$script:foo`, not a variable followed by a literal colon),
// so the WHOLE SCRIPT failed to parse and the step died in 0.67s having
// attempted nothing — and every text assertion in this file still passed,
// because the broken text still contained the words `ffmpeg -version`,
// `exit 1`, a `for` loop, and `Start-Sleep`. A test that only reads text
// cannot see that a script can't parse.
//
// The tests below close that gap: they hand the extracted script to
// PowerShell's OWN parser (not a regex or a hand-rolled approximation of
// one — that would just be a worse version of the same bug) and assert it
// reports zero errors, then go a step further and actually EXECUTE the
// script's control flow against stubbed choco/winget/ffmpeg to confirm the
// retry logic behaves, not just parses. Both checks skip loudly, naming the
// real cause, on a runner with no usable PowerShell executable — see
// PWSH_SKIP_REASON below, which mirrors the capability-probe convention
// `run-sidecar-tests.test.mjs` established for PYTHON_SKIP_REASON /
// LINK_SKIP_REASON.

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { readNormalized } from '../lib/read-normalized.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const WORKFLOWS = [
  resolve(repoRoot, '.github', 'workflows', 'cross-os.yml'),
  resolve(repoRoot, '.github', 'workflows', 'release.yml'),
];

const ACTION_FILE = resolve(repoRoot, '.github', 'actions', 'install-ffmpeg-windows', 'action.yml');

// Pulls the full step block (from `- name: Install ffmpeg (Windows)` up to
// the next step at the same (6-space) indentation, a shallower-indented key
// (the next job), or end of file) out of a workflow's or composite action's
// source text. Uses plain index search rather than a `^`/`$`-anchored regex
// with the `m` flag: multiline `$` matches before EVERY newline, not just
// end-of-string, which silently truncated the match at the step's first
// inner line.
function windowsFfmpegStepBlock(source) {
  const marker = '- name: Install ffmpeg (Windows)';
  const markerIdx = source.indexOf(marker);
  assert.ok(markerIdx !== -1, "no 'Install ffmpeg (Windows)' step found — did it get renamed?");
  const lineStart = source.lastIndexOf('\n', markerIdx) + 1;

  const afterMarker = source.slice(markerIdx + marker.length);
  const boundary = afterMarker.match(/\n {6}- name:|\n {2,4}[A-Za-z][\w-]*:\n/);
  const end = boundary
    ? markerIdx + marker.length + boundary.index
    : source.length;

  return source.slice(lineStart, end);
}

// Extracts just the `run: |` block scalar's PowerShell BODY out of a step
// block already isolated by windowsFfmpegStepBlock — the parser check needs
// the script text alone, not the surrounding YAML (`- name:`, `if:`,
// `run: |`), which is not itself PowerShell and would never parse as such.
//
// Follows YAML's own block-scalar indentation rule: the indentation is set
// by the FIRST non-blank content line; every subsequent line at or above
// that indentation is part of the body (with that many leading spaces
// stripped), and a line that dedents below it ends the block.
function windowsFfmpegScriptBody(block) {
  const runMatch = block.match(/\n( *)run:\s*\|[+-]?\r?\n/);
  assert.ok(
    runMatch,
    'no `run: |` block scalar found in the Windows ffmpeg step -- did its shell or step shape change?',
  );
  const keyIndent = runMatch[1].length;
  const rest = block.slice(runMatch.index + runMatch[0].length).split('\n');

  let baseIndent = null;
  const bodyLines = [];
  for (const line of rest) {
    if (line.trim() === '') {
      bodyLines.push('');
      continue;
    }
    const indent = line.match(/^ */)[0].length;
    if (baseIndent === null) {
      assert.ok(
        indent > keyIndent,
        'run: | block scalar body is not indented past the `run:` key -- cannot locate the script',
      );
      baseIndent = indent;
    }
    if (indent < baseIndent) break;
    bodyLines.push(line.slice(baseIndent));
  }
  while (bodyLines.length && bodyLines[bodyLines.length - 1] === '') bodyLines.pop();
  assert.ok(bodyLines.length > 0, 'extracted an empty PowerShell script body from the run: block');
  return bodyLines.join('\n');
}

// --- PowerShell capability probe (mirrors run-sidecar-tests.test.mjs's
// PYTHON_SKIP_REASON / LINK_SKIP_REASON shape) ---
//
// `pwsh` (PowerShell Core) is preinstalled on GitHub's ubuntu-latest runners
// as well as Windows, so try it first everywhere; `powershell` (Windows
// PowerShell 5.1) is the Windows-only fallback. Probed once at module load
// and shared by every test below rather than rebuilt per test.
function probePowerShell(exe) {
  const args = ['-NoProfile', '-NonInteractive'];
  if (process.platform === 'win32') args.push('-ExecutionPolicy', 'Bypass');
  args.push('-Command', '$PSVersionTable.PSVersion.ToString()');
  return spawnSync(exe, args, { encoding: 'utf8' });
}

function findPowerShell() {
  const candidates = process.platform === 'win32' ? ['pwsh', 'powershell'] : ['pwsh'];
  const attempts = [];
  for (const exe of candidates) {
    const probe = probePowerShell(exe);
    if (probe.error) {
      attempts.push(`${exe}: not found on PATH (${probe.error.code ?? probe.error.message})`);
      continue;
    }
    if (probe.status !== 0) {
      attempts.push(`${exe}: ran but exited ${probe.status} (${(probe.stderr || '').trim().slice(0, 200)})`);
      continue;
    }
    return { exe, attempts: [] };
  }
  return { exe: null, attempts };
}

// PWSH_SKIP_REASON is null (falsy) whenever a usable PowerShell WAS found, so
// `{ skip: PWSH_SKIP_REASON ?? false }` only ever skips for the real,
// reproducible cause — never unconditionally.
const PWSH_DISCOVERY = findPowerShell();
const PWSH_EXE = PWSH_DISCOVERY.exe;
const PWSH_SKIP_REASON = PWSH_EXE
  ? null
  : [
      'no PowerShell executable available on this runner (tried ' +
        (process.platform === 'win32' ? 'pwsh, then powershell' : 'pwsh') +
        ') -- the Windows ffmpeg-install step\'s PowerShell is untested on this run, not confirmed to',
      'parse or behave correctly. Tried:',
      ...PWSH_DISCOVERY.attempts.map((a) => `  - ${a}`),
    ].join('\n');

function runPowerShellFile(scriptPath, extraArgs = [], env = process.env) {
  const args = ['-NoProfile', '-NonInteractive'];
  if (process.platform === 'win32') args.push('-ExecutionPolicy', 'Bypass');
  args.push('-File', scriptPath, ...extraArgs);
  return spawnSync(PWSH_EXE, args, { encoding: 'utf8', env });
}

// Uses PowerShell's OWN parser — System.Management.Automation.Language.Parser
// — rather than a regex or hand-rolled lexer, which would just be a worse
// version of the bug this test exists to catch. ParseInput reports syntax
// errors (with line/column) without executing anything.
const PARSE_CHECK_WRAPPER = `
param([string]$ScriptPath)
$content = [System.IO.File]::ReadAllText($ScriptPath)
$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseInput($content, [ref]$tokens, [ref]$errors) | Out-Null
$result = @()
foreach ($e in $errors) {
  $result += [PSCustomObject]@{
    message = $e.Message
    line = $e.Extent.StartLineNumber
    column = $e.Extent.StartColumnNumber
  }
}
ConvertTo-Json -InputObject $result -Depth 5
`;

function parsePowerShellSyntaxErrors(scriptText) {
  const dir = mkdtempSync(join(tmpdir(), 'pwsh-parse-'));
  const scriptPath = join(dir, 'target.ps1');
  const wrapperPath = join(dir, 'parse-check.ps1');
  writeFileSync(scriptPath, scriptText, 'utf8');
  writeFileSync(wrapperPath, PARSE_CHECK_WRAPPER, 'utf8');
  try {
    const proc = runPowerShellFile(wrapperPath, ['-ScriptPath', scriptPath]);
    assert.equal(
      proc.status,
      0,
      `the PowerShell parser-check process itself failed to run (exit ${proc.status}): ` +
        `${proc.stderr || proc.error}`,
    );
    const stdout = proc.stdout.trim();
    if (stdout === '') return [];
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : [parsed];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- Behavioural harness: execute the extracted script's actual control
// flow, not just parse it ---
//
// choco/winget/ffmpeg are shadowed with PowerShell functions defined ahead
// of the extracted script in the SAME scope: PowerShell's command
// resolution order checks functions before external applications, so
// `choco install ...`, `& ffmpeg -version`, and `Get-Command winget` all
// resolve to the stubs below without touching PATH or installing anything
// real. `$LASTEXITCODE` is only set by a genuine native-process exit, never
// by a function call, so each ffmpeg stub sets `$global:LASTEXITCODE`
// explicitly to control the outcome the real script's own
// `$LASTEXITCODE -eq 0` check observes.
//
// The workflow file itself is NOT touched to make this fast: `Start-Sleep`
// is shadowed the same way as choco/winget/ffmpeg (a function defined ahead
// of the script in-scope wins command resolution), so the real, unmodified
// `Start-Sleep -Seconds 15` calls resolve to a stub that returns instantly
// and leaves a marker behind — proving the delay actually fires, without
// the test paying the 15s wall-clock cost and without changing a single
// character of the shipped script.
// GITHUB_PATH and LOCALAPPDATA are real, live environment variables when
// this test itself runs inside GitHub Actions (test:hooks is scoped in by
// this diff on every OS, including ubuntu-latest, where LOCALAPPDATA is
// never set). Without isolating them, the stubbed script under test would
// either crash (Join-Path against a null LOCALAPPDATA) or, worse, silently
// append a test-only path to the CI job's OWN $GITHUB_PATH file, corrupting
// PATH for every later step of the real job the test is running inside.
// Each invocation gets its own throwaway GITHUB_PATH file and, by default,
// its own LOCALAPPDATA directory, so the script's real control flow can be
// observed without touching (or depending on) the host job's actual
// environment. `withLocalAppData: false` deliberately UNSETS it (deleted
// from the child's env entirely, not set to '') to reproduce the shape that
// actually broke #2478's first fix attempt: GITHUB_PATH present,
// LOCALAPPDATA absent -- exactly ubuntu-latest's Hooks-tests leg.
function runStubbedFfmpegScript(scriptBody, stubPreamble, { withLocalAppData = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pwsh-behave-'));
  const scriptPath = join(dir, 'scenario.ps1');
  writeFileSync(scriptPath, `${stubPreamble}\n${scriptBody}\n`, 'utf8');
  const githubPathFile = join(dir, 'github_path.txt');
  const localAppDataDir = withLocalAppData ? join(dir, 'LocalAppData') : null;
  const env = { ...process.env, GITHUB_PATH: githubPathFile };
  if (withLocalAppData) {
    env.LOCALAPPDATA = localAppDataDir;
  } else {
    delete env.LOCALAPPDATA;
  }
  try {
    const proc = runPowerShellFile(scriptPath, [], env);
    let githubPathContents = '';
    try {
      githubPathContents = readFileSync(githubPathFile, 'utf8');
    } catch {
      // Never written -- valid when the script never reached the
      // PATH-persist branch (e.g. the choco-works-first-try path).
    }
    return { ...proc, githubPathContents, localAppDataDir };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const STUB_CHOCO_WORKS_FIRST_TRY = ['function choco { }', 'function ffmpeg { $global:LASTEXITCODE = 0 }'].join(
  '\n',
);

const STUB_CHOCO_FAILS_WINGET_RESCUES = [
  '$global:wingetInstalled = $false',
  'function choco { }',
  'function ffmpeg { if ($global:wingetInstalled) { $global:LASTEXITCODE = 0 } else { $global:LASTEXITCODE = 1 } }',
  'function winget { $global:wingetInstalled = $true }',
].join('\n');

const STUB_BOTH_FAIL_ALL_ATTEMPTS = [
  'function choco { }',
  'function ffmpeg { $global:LASTEXITCODE = 1 }',
  'function winget { }',
  'function Start-Sleep { param($Seconds) Write-Host "STUB:Start-Sleep:$Seconds" }',
].join('\n');

// The script now has exactly one source of truth: the composite action.
// Extracted once here and reused by every test below instead of looping
// over both workflow files as before #2480 (each of which now just
// `uses:` the composite rather than embedding the script).
{
  const path = ACTION_FILE;
  const rel = path.slice(repoRoot.length + 1).replace(/\\/g, '/');

  test(`${rel}: Windows ffmpeg install verifies ffmpeg actually runs, not just choco's exit code`, () => {
    const source = readNormalized(path);
    const block = windowsFfmpegStepBlock(source);

    // The step must still install via choco (that part of the defect —
    // "no package manager at all" — was never in question).
    assert.match(block, /choco install ffmpeg/, 'step no longer installs ffmpeg via choco');

    // It must invoke ffmpeg itself as the success check — not just choco's
    // exit code. A bare `choco install ...` one-liner (the pre-fix shape)
    // fails this.
    assert.match(
      block,
      /ffmpeg\s+-version/,
      'step does not invoke `ffmpeg -version` to verify the binary actually runs',
    );

    // The verification must gate an explicit failure exit — a step that
    // merely logs a warning and falls through still reports green.
    assert.match(
      block,
      /exit\s+1\b/,
      'step has no explicit non-zero exit when ffmpeg verification fails',
    );

    // The failure message must be aimed at CI, not a developer workstation —
    // the whole point of the defect was a message telling a CI runner to
    // "open a new terminal" / run a local installer.
    assert.match(
      block,
      /CI/,
      "step's failure message does not mention CI — risks repeating the " +
        'developer-workstation-oriented message that made the original failure hard to diagnose',
    );
  });

  // This test asserts the PROPERTY ("a bounded repeat around the install,
  // with a delay between attempts"), not one exact loop spelling. Rewriting
  // `for ($attempt = 1; ...)` as `1..3 | ForEach-Object { ... }`, or
  // renaming `$attempt`/`$maxAttempts`, must NOT break this test — only
  // removing the retry (or the delay) itself should. What it can detect:
  // a loop construct (for/foreach/while/do/range-pipe) plus a small
  // explicit numeric attempt bound plus a `Start-Sleep` call, all present
  // somewhere in the step block. What it CANNOT detect: that the loop
  // actually wraps the `choco install` call (vs. sitting next to it doing
  // nothing), or that the delay is actually between attempts rather than
  // decoration elsewhere in the block — it is a textual presence check, not
  // a control-flow analysis. It does still genuinely fail for the pre-fix
  // one-shot `choco install ffmpeg -y --no-progress` with no loop at all.
  test(`${rel}: Windows ffmpeg install retries the transient-feed case with a delay between attempts`, () => {
    const source = readNormalized(path);
    const block = windowsFfmpegStepBlock(source);

    // A single `choco install` call has no defence against a transient feed
    // error (the observed 504 from community.chocolatey.org). Look for any
    // of the common PowerShell bounded-loop shapes around the install, not
    // a specific one.
    assert.match(
      block,
      /\bfor\s*\(|\bforeach\s*\(|\bwhile\s*\(|\bdo\s*\{|\d+\s*\.\.\s*\d+|ForEach-Object/i,
      'no loop construct (for/foreach/while/do/range-pipe) found around the choco install',
    );

    // "Bounded" is the point — an unbounded `while ($true)` retries forever
    // against a live outage. Require a small explicit numeric attempt count
    // rather than just "a loop exists somewhere".
    assert.match(
      block,
      /\b(?:maxAttempts|attempts?|retries|maxRetries)\s*=\s*[2-9]\b|\b[2-9]\s*\.\.\s*[2-9]\b/i,
      'no explicit small numeric attempt count found -- an unbounded loop is not a bounded retry',
    );

    // A retry with no delay just re-hammers a feed that is mid-outage.
    assert.match(
      block,
      /Start-Sleep\b/,
      'no delay (Start-Sleep or equivalent) found between retry attempts',
    );
  });

  // Closes the gap the tests above cannot: they are textual and pass
  // whether or not the script PARSES. Run 31566528082 had a script that
  // matched every assertion above and still died in 0.67s with a
  // ParserError, because `$maxAttempts:` inside a double-quoted string is a
  // scope-qualified variable reference in PowerShell, not a variable
  // followed by a literal colon. This hands the extracted script to
  // PowerShell's own parser and requires zero syntax errors.
  test(`${rel}: Windows ffmpeg install step's PowerShell actually parses (the text assertions above cannot prove this)`, {
    skip: PWSH_SKIP_REASON ?? false,
  }, () => {
    const source = readNormalized(path);
    const block = windowsFfmpegStepBlock(source);
    const scriptBody = windowsFfmpegScriptBody(block);
    const errors = parsePowerShellSyntaxErrors(scriptBody);
    assert.equal(
      errors.length,
      0,
      `PowerShell's parser reported ${errors.length} syntax error(s) in the Windows ffmpeg install ` +
        `script:\n${errors.map((e) => `  line ${e.line}, col ${e.column}: ${e.message}`).join('\n')}`,
    );
  });

  // Parsing is a low bar — a script can parse cleanly and still be wrong.
  // These execute the extracted script's REAL control flow (unmodified) in
  // a separate pwsh/powershell child process, with choco/winget/ffmpeg
  // stubbed via function-shadowing (see runStubbedFfmpegScript's comment),
  // across the three paths the retry logic is meant to handle.
  test(`${rel}: Windows ffmpeg install behaviour -- choco works on the first try`, {
    skip: PWSH_SKIP_REASON ?? false,
  }, () => {
    const source = readNormalized(path);
    const scriptBody = windowsFfmpegScriptBody(windowsFfmpegStepBlock(source));
    const proc = runStubbedFfmpegScript(scriptBody, STUB_CHOCO_WORKS_FIRST_TRY);
    assert.equal(proc.status, 0, `expected exit 0; stdout:\n${proc.stdout}\nstderr:\n${proc.stderr}`);
    assert.match(proc.stdout, /ffmpeg verified working \(attempt 1\/3\)\./);
    // The PATH-persist branch lives inside the winget-fallback path only --
    // choco succeeding on the first try must never touch $GITHUB_PATH. A
    // guard that dropped its `$ffmpegOk` (or its winget-only scoping) would
    // still pass every other assertion in this file; this is the one that
    // would catch it.
    assert.equal(proc.githubPathContents, '', 'expected $GITHUB_PATH untouched on the choco-succeeds path');
  });

  test(`${rel}: Windows ffmpeg install behaviour -- choco fails, winget rescues it`, {
    skip: PWSH_SKIP_REASON ?? false,
  }, () => {
    const source = readNormalized(path);
    const scriptBody = windowsFfmpegScriptBody(windowsFfmpegStepBlock(source));
    const proc = runStubbedFfmpegScript(scriptBody, STUB_CHOCO_FAILS_WINGET_RESCUES);
    assert.equal(proc.status, 0, `expected exit 0; stdout:\n${proc.stdout}\nstderr:\n${proc.stderr}`);
    assert.match(
      proc.stdout,
      /Attempt 1\/3: choco reported success but ffmpeg is not runnable/,
      'expected the step to notice the first ffmpeg check failed and fall through to winget',
    );
    assert.match(
      proc.stdout,
      /ffmpeg verified working \(attempt 1\/3\)\./,
      'expected the post-winget ffmpeg re-check to succeed',
    );
    // Pins the #2478 fix itself: the step must persist the ffmpeg install
    // directory to $GITHUB_PATH so LATER steps in the job (Verify, Build,
    // ...) — fresh processes that never re-read the registry PATH this
    // step patched in-process — can still find it. Isolated GITHUB_PATH /
    // LOCALAPPDATA (see runStubbedFfmpegScript) means this exercises the
    // real branch rather than skipping it, which is what let the original
    // #2478 fix ship with this exact defect (Join-Path against a null
    // LOCALAPPDATA crashes; the crash was masked locally because
    // GITHUB_PATH is unset outside CI, so the guard never entered the
    // branch at all).
    assert.match(
      proc.githubPathContents,
      /Microsoft[\\/]WinGet[\\/]Links/,
      `expected the ffmpeg install directory to be appended to $GITHUB_PATH; got:\n${JSON.stringify(proc.githubPathContents)}`,
    );
    assert.ok(
      proc.githubPathContents.includes(join(proc.localAppDataDir, 'Microsoft', 'WinGet', 'Links')),
      `expected the persisted directory to be rooted under this run's LOCALAPPDATA; got:\n${JSON.stringify(proc.githubPathContents)}`,
    );
  });

  // This is the exact shape (GITHUB_PATH present, LOCALAPPDATA absent) that
  // ubuntu-latest's Hooks-tests leg hits, and that broke the #2478 fix's
  // first attempt (PR #2479 review pass 1) -- the pass-1 script had no
  // dedicated try/catch around the PATH-persist logic at all, so
  // `Join-Path $null ...` crashed straight into the winget-install
  // try/catch, which flipped the whole install verdict to failed (attempt
  // 2/3, not 1/3). Round 2 fixed the CRASH by giving the persist logic its
  // own try/catch -- which the `attempt 1/3` + empty-$GITHUB_PATH
  // assertions below pin -- but that alone still let a real box missing
  // LOCALAPPDATA skip the persist with zero signal. This test's final
  // assertion (the explicit `::warning::` line) is what actually pins the
  // LOCALAPPDATA-specific guard: round-3 review proved that folding
  // `$env:LOCALAPPDATA` back into the single outer condition (undoing the
  // nested if/else) leaves every OTHER assertion in this test green, since
  // the crash containment alone already accounts for them.
  test(`${rel}: Windows ffmpeg install behaviour -- choco fails, winget rescues it, but LOCALAPPDATA is unset (ubuntu-latest's Hooks-tests leg)`, {
    skip: PWSH_SKIP_REASON ?? false,
  }, () => {
    const source = readNormalized(path);
    const scriptBody = windowsFfmpegScriptBody(windowsFfmpegStepBlock(source));
    const proc = runStubbedFfmpegScript(scriptBody, STUB_CHOCO_FAILS_WINGET_RESCUES, { withLocalAppData: false });
    assert.equal(proc.status, 0, `expected exit 0; stdout:\n${proc.stdout}\nstderr:\n${proc.stderr}`);
    assert.match(
      proc.stdout,
      /ffmpeg verified working \(attempt 1\/3\)\./,
      'expected the winget-rescued ffmpeg install to still be reported successful with LOCALAPPDATA absent',
    );
    // The PATH-persist branch must be SKIPPED, not crash and not fall
    // through to a later attempt -- with no LOCALAPPDATA there is nowhere
    // correct to derive a WinGet Links directory from.
    assert.equal(
      proc.githubPathContents,
      '',
      `expected $GITHUB_PATH untouched when LOCALAPPDATA is absent; got:\n${JSON.stringify(proc.githubPathContents)}`,
    );
    // The skip must be LOUD (round-2 review, PR #2479): folding
    // `$env:LOCALAPPDATA` back into the single outer `if` condition
    // (instead of the nested if/else this pins) makes the exact same three
    // assertions above pass -- ffmpeg still verifies working, PATH still
    // stays untouched -- while silently dropping this warning, which is
    // the only signal a real box missing LOCALAPPDATA would ever produce.
    assert.match(
      proc.stdout,
      /::warning::LOCALAPPDATA is not set/,
      'expected an explicit warning when LOCALAPPDATA is absent, not a silent skip',
    );
  });

  test(`${rel}: Windows ffmpeg install behaviour -- both choco and winget fail all 3 attempts -> exit 1 with the CI message, retrying with a real delay`, {
    skip: PWSH_SKIP_REASON ?? false,
  }, () => {
    const source = readNormalized(path);
    const scriptBody = windowsFfmpegScriptBody(windowsFfmpegStepBlock(source));
    const proc = runStubbedFfmpegScript(scriptBody, STUB_BOTH_FAIL_ALL_ATTEMPTS);
    assert.equal(proc.status, 1, `expected exit 1; stdout:\n${proc.stdout}\nstderr:\n${proc.stderr}`);
    // Guards against a mutated condition that drops `$ffmpegOk` from the
    // PATH-persist gate: ffmpeg never actually installed here, so nothing
    // should be written to $GITHUB_PATH across any of the 3 attempts.
    assert.equal(
      proc.githubPathContents,
      '',
      `expected $GITHUB_PATH untouched when ffmpeg never verified working; got:\n${JSON.stringify(proc.githubPathContents)}`,
    );
    assert.match(
      proc.stderr,
      /CI: ffmpeg install failed after 3 attempts/,
      'expected the CI-oriented failure message on stderr (Write-Error) after exhausting all attempts',
    );
    // The (unmodified) `Start-Sleep -Seconds 15` calls resolve to the stub,
    // which logs a marker instead of actually sleeping. Exactly 2 delays are
    // expected for 3 attempts (between 1->2 and 2->3, never after the last
    // attempt) — proving Start-Sleep is really wired between retries, not
    // just present as decoration somewhere in the block.
    const sleepCalls = (proc.stdout.match(/STUB:Start-Sleep:/g) || []).length;
    assert.equal(sleepCalls, 2, `expected exactly 2 retry delays; stdout:\n${proc.stdout}`);
  });
}

// Guards the extraction itself: a future edit that pastes the script back
// inline (reintroducing the #2480 duplication) must not go unnoticed. Each
// workflow's "Install ffmpeg (Windows)" step must reference the composite
// action rather than embed its own `run: |` block.
for (const path of WORKFLOWS) {
  const rel = path.slice(repoRoot.length + 1).replace(/\\/g, '/');

  test(`${rel}: Windows ffmpeg install step delegates to the composite action, not an inline script`, () => {
    const source = readNormalized(path);
    const block = windowsFfmpegStepBlock(source);

    assert.match(
      block,
      /uses:\s*\.\/\.github\/actions\/install-ffmpeg-windows\b/,
      'step no longer references ./.github/actions/install-ffmpeg-windows -- did the composite action get inlined again?',
    );

    assert.doesNotMatch(
      block,
      /choco install ffmpeg/,
      'step embeds its own choco install call -- the Windows ffmpeg script should live only in .github/actions/install-ffmpeg-windows/action.yml',
    );
  });
}
