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
// Scope: only the Windows/choco steps. The macOS/brew steps are NOT covered
// here — investigated separately (see the PR/report this test shipped
// with): GitHub's default (non-Windows, no explicit `shell:`) run-step shell
// is `bash -e {0}` (actions/runner ADR 0277), and `brew install` returns a
// genuine non-zero exit on a real install failure (already-installed is a
// real success case, not a masked failure) — so the macOS step already fails
// the job loudly via `-e` and does not share the fail-open defect this test
// guards against. Same reasoning applies to both files, so both are checked
// here for the Windows step only.

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readNormalized } from '../lib/read-normalized.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const WORKFLOWS = [
  resolve(repoRoot, '.github', 'workflows', 'cross-os.yml'),
  resolve(repoRoot, '.github', 'workflows', 'release.yml'),
];

// Pulls the full step block (from `- name: Install ffmpeg (Windows)` up to
// the next step at the same (6-space) indentation, a shallower-indented key
// (the next job), or end of file) out of a workflow's source text. Uses
// plain index search rather than a `^`/`$`-anchored regex with the `m` flag:
// multiline `$` matches before EVERY newline, not just end-of-string, which
// silently truncated the match at the step's first inner line.
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

for (const path of WORKFLOWS) {
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
}
