/* #2063 (ported from server/src/vitest-retry-hazard-reporter.test.ts, #2028)
   — pins retryHazardReporter, the observability mechanism vitest.config.ts
   uses instead of flipping/scoping retry:1 blind (see the doc comment above
   it for the full reasoning). The property under test: a test that failed
   on its first attempt and only passed after a vitest retry prints a
   `[retry-hazard]` warning naming the file and test — and stays SILENT for
   a clean first-attempt pass, a still-failing test, or a test whose
   diagnostic isn't available yet (so the reporter can never itself become
   noise on an ordinary green run).

   Unlike the server copy, the reporter lives in its OWN module
   (src/test/retry-hazard-reporter.ts) rather than being a named export of
   vitest.config.ts, so this imports it directly and statically. That split is
   PR #2160 review finding 5: a config file with both a default and a named
   export makes rolldown print a `[MIXED_EXPORTS]` warning on the first line of
   stdout for every root `vitest` run. The wiring tests below still spawn the
   REAL on-disk vitest.config.ts, so nothing about the installation proof
   changes — see that module's own doc comment. */
import { describe, it, expect, vi } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';
import type { TestCase } from 'vitest/node';
import { retryHazardReporter } from './test/retry-hazard-reporter';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fakeTestCase(opts: { retryCount: number | undefined; state: 'passed' | 'failed' }): TestCase {
  return {
    module: { moduleId: '/repo/src/example.test.ts' },
    fullName: 'suite > example test',
    diagnostic: () =>
      opts.retryCount === undefined
        ? undefined
        : {
            retryCount: opts.retryCount,
            slow: false,
            heap: undefined,
            duration: 0,
            startTime: 0,
          },
    result: () => ({ state: opts.state }),
  } as unknown as TestCase;
}

describe('retryHazardReporter (#2028, #2063)', () => {
  it('warns when a test failed on its first attempt and only passed after a retry', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      retryHazardReporter.onTestCaseResult?.(fakeTestCase({ retryCount: 1, state: 'passed' }));
      expect(warn).toHaveBeenCalledTimes(1);
      const message = warn.mock.calls[0]?.[0] as string;
      expect(message).toContain('[retry-hazard]');
      expect(message).toContain('/repo/src/example.test.ts');
      expect(message).toContain('suite > example test');
      expect(message).toContain('#2028');
    } finally {
      warn.mockRestore();
    }
  });

  it('stays silent when a test passed on its first attempt (no retry)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      retryHazardReporter.onTestCaseResult?.(fakeTestCase({ retryCount: 0, state: 'passed' }));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('stays silent when a test failed even after retrying — it is still red, nothing is hidden', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      retryHazardReporter.onTestCaseResult?.(fakeTestCase({ retryCount: 1, state: 'failed' }));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('stays silent when no diagnostic is available yet', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      retryHazardReporter.onTestCaseResult?.(fakeTestCase({ retryCount: undefined, state: 'passed' }));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

/* Real-wiring tests, ported from server/src/vitest-retry-hazard-reporter.test.ts
   (F2 / Finding 6, PR #2049 review) — every test above calls
   onTestCaseResult() with a HAND-BUILT fake TestCase, which pins the
   predicate but never the INSTALLATION: whether `reporters:` in the real,
   on-disk vitest.config.ts actually wires retryHazardReporter into a real
   vitest run. Deleting the `reporters:` line entirely would leave all four
   tests above green — the exact "data, not wire" gap this closes. Spawns
   the REAL vitest CLI against a REAL, on-disk config — not a reconstructed
   copy.

   The fixture is NOT written into the real src/ tree: it lands under
   src/__wire-fixtures__/, which vitest.config.ts EXCLUDES outright, so a
   fixture that survives a kill between write and `finally` cleanup can
   never poison the real suite. Running it at all needs
   vitest.config.wire-fixtures.ts, the one config that DOES include that
   directory — see its own doc comment for why it still proves the real
   config's retry/reporters behaviour rather than a copy of it. */
const VITEST_BIN = resolve(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const WIRE_FIXTURES_CONFIG = resolve(REPO_ROOT, 'vitest.config.wire-fixtures.ts');
const WIRE_FIXTURES_DIR = resolve(REPO_ROOT, 'src', '__wire-fixtures__');

/** Write `fixtureName` under src/__wire-fixtures__/ (creating the directory
    if needed), run the real vitest CLI — via vitest.config.wire-fixtures.ts,
    the only config that includes that directory — against just that file
    with `envOverrides` layered onto (or deleted from, via an explicit
    `undefined`) the current env, and delete the fixture afterwards
    regardless of outcome. */
function runVitestOnFixture(
  fixtureName: string,
  fixtureBody: string,
  envOverrides: Record<string, string | undefined>,
) {
  mkdirSync(WIRE_FIXTURES_DIR, { recursive: true });
  const fixturePath = resolve(WIRE_FIXTURES_DIR, fixtureName);
  writeFileSync(fixturePath, fixtureBody);
  try {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const [key, value] of Object.entries(envOverrides)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    return spawnSync(
      'node',
      [VITEST_BIN, 'run', '--config', WIRE_FIXTURES_CONFIG, `src/__wire-fixtures__/${fixtureName}`],
      { cwd: REPO_ROOT, encoding: 'utf8', env },
    );
  } finally {
    rmSync(fixturePath, { force: true });
  }
}

const RETRY_THEN_PASS_FIXTURE = `let attempt = 0;
it('fails once then passes, to trigger a real vitest retry', () => {
  attempt += 1;
  if (attempt === 1) throw new Error('deliberate first-attempt failure');
  expect(attempt).toBe(2);
});
`;

// A nested vitest invocation is slow under contention, so this gets its own
// explicit, generous timeout rather than sharing the file's default.
describe('retryHazardReporter — real wiring (#2028, #2063, PR #2049 review F2)', () => {
  it(
    'a real retried-then-passed run prints [retry-hazard] via the ACTUAL on-disk config',
    { timeout: 30_000 },
    () => {
      const out = runVitestOnFixture('__wire_fixture_retry_hazard__.test.ts', RETRY_THEN_PASS_FIXTURE, {
        GITHUB_ACTIONS: undefined,
      });
      const combined = `${out.stdout ?? ''}${out.stderr ?? ''}`;
      expect(combined).toContain('[retry-hazard]');
      expect(combined).toContain('__wire_fixture_retry_hazard__.test.ts');
      expect(combined).toContain('fails once then passes, to trigger a real vitest retry');
    },
  );
});

/* Same "data, not wire" defect shape, for vitest's OWN built-in
   'github-actions' reporter: it is appended automatically only when the
   resolved `reporters` array is EMPTY, so setting one unconditionally would
   silently suppress it in CI (verify.yml runs `vitest run`/`vitest run
   --changed` directly at the repo root, so this is the live gating path).
   Spawns the real CLI exactly like the describe block above. */
const OUTRIGHT_FAIL_FIXTURE = `it('deliberately fails outright, no rescue', () => {
  expect(1).toBe(2);
});
`;

describe('github-actions reporter — real wiring under CI (#2028, #2063, PR #2049 review F1)', () => {
  it(
    "GITHUB_ACTIONS=true restores the built-in github-actions reporter's ::error annotation",
    { timeout: 30_000 },
    () => {
      const withCi = runVitestOnFixture('__wire_fixture_gha_on__.test.ts', OUTRIGHT_FAIL_FIXTURE, {
        GITHUB_ACTIONS: 'true',
      });
      expect(`${withCi.stdout ?? ''}${withCi.stderr ?? ''}`).toContain('::error');
    },
  );

  // And the toggle is real, not a vitest-global behaviour our config can't
  // affect either way: outside CI the built-in reporter never fires.
  it('outside CI, the built-in github-actions reporter never fires', { timeout: 30_000 }, () => {
    const withoutCi = runVitestOnFixture('__wire_fixture_gha_off__.test.ts', OUTRIGHT_FAIL_FIXTURE, {
      GITHUB_ACTIONS: undefined,
    });
    const combined = `${withoutCi.stdout ?? ''}${withoutCi.stderr ?? ''}`;
    /* POSITIVE CONTROL FIRST (PR #2160 review, finding 1). The `not.toContain`
       below is a bare negative over spawned-process output: it passes just as
       happily when vitest never ran at all. Proven, not suspected — pointing
       --config at a nonexistent file makes vitest die at startup with exit 1
       and no '::error' anywhere, and the assertion still passed. These two
       lines pin that the fixture genuinely executed and genuinely failed, so
       the absence below is evidence rather than silence. */
    expect(withoutCi.status).toBe(1);
    expect(combined).toContain('deliberately fails outright');
    expect(combined).not.toContain('::error');
  });
});

/* PR #2160 review, finding 3 — nothing asserted the BASE half of the
   reporters ternary. Both wire describes above prove the appended reporters
   fire, but a "simplification" to `[retryHazardReporter]` /
   `['github-actions', retryHazardReporter]` would drop vitest's own summary
   reporter and stay green across every other test here — i.e. it would
   reintroduce exactly PR #2049 Finding 1, the regression this config's
   comment says it is pre-empting.

   Asserted through the base reporter's OWN output rather than by importing
   the config and inspecting the array: the array's contents are a mechanism,
   the summary line is the outcome, and only the outcome proves the reporter
   was actually installed in the spawned run. */
/** Strip SGR colour escapes.

    The assertion below spans several tokens, and on a GitHub runner vitest
    colourises each separately — the child's real output there is
    `<ESC>[2m Test Files <ESC>[22m <ESC>[1m<ESC>[31m1 failed<ESC>[39m`, so a
    plain `Test Files\s+\d+` cannot cross the escapes. Locally the same spawn
    is uncoloured and the naive pattern matches, which is exactly how this
    test went green here and red on the runner on PR #2160's first run.

    NOTE, so the next reader trusts no more than was established: that colour
    difference could NOT be reproduced locally. Neither `FORCE_COLOR=1` nor
    `CI=true` on the parent makes the spawned child colourise — both were run
    against a control with this stripping removed, and the control passed both
    times. The runner's behaviour is evidenced only by the captured assertion
    diff in the failing job. Hence the deliberately tolerant pattern at the
    call site AS WELL AS this stripping: two independent reasons for the
    assertion to hold, because only one of them is checkable from here. */
const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

describe('the base reporter survives the ternary (#2063, PR #2049 review F1)', () => {
  it("vitest's own summary reporter still runs in BOTH env branches", { timeout: 90_000 }, () => {
    for (const GITHUB_ACTIONS of [undefined, 'true'] as const) {
      const out = runVitestOnFixture(
        `__wire_fixture_base_reporter_${GITHUB_ACTIONS ?? 'off'}__.test.ts`,
        OUTRIGHT_FAIL_FIXTURE,
        { GITHUB_ACTIONS },
      );
      const combined = stripAnsi(`${out.stdout ?? ''}${out.stderr ?? ''}`);
      /* Tolerant of anything between the words — see stripAnsi's note: the
         escape sequences are the known case, but stripping is verified only
         against uncoloured local output, so the pattern does not depend on the
         stripping having been exhaustive. `[^\n]{0,60}?` stays on one line, so
         it cannot drift across into an unrelated part of the output. */
      expect(combined, `GITHUB_ACTIONS=${GITHUB_ACTIONS}`).toMatch(
        /Test Files[^\n]{0,60}?\d+[^\n]{0,20}?(passed|failed)/,
      );
    }
  });
});
