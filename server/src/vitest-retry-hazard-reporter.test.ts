/* ops-46 (#2028) — pins retryHazardReporter, the observability mechanism
   server/vitest.config.ts uses instead of flipping/scoping retry:1 blind
   (see the doc comment above it for the full reasoning). The property under
   test: a test that failed on its first attempt and only passed after a
   vitest retry prints a `[retry-hazard]` warning naming the file and test —
   and stays SILENT for a clean first-attempt pass, a still-failing test, or
   a test whose diagnostic isn't available yet (so the reporter can never
   itself become noise on an ordinary green run).

   server/vitest.config.ts lives OUTSIDE server's rootDir (server/src), so a
   static import fails tsc's rootDir check the same way
   force-rerun-triggers.test.ts documents for forceRerunTriggers. A dynamic
   import with a runtime-computed specifier isn't statically resolved by TS,
   so it can't pull the file into the rootDir-checked program. */
import { describe, it, expect, vi } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';
import type { Reporter, TestCase } from 'vitest/node';

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function loadRetryHazardReporter(): Promise<Reporter> {
  const mod = (await import(pathToFileURL(resolve(SERVER_ROOT, 'vitest.config.ts')).href)) as {
    retryHazardReporter: Reporter;
  };
  return mod.retryHazardReporter;
}

function fakeTestCase(opts: {
  retryCount: number | undefined;
  state: 'passed' | 'failed';
}): TestCase {
  return {
    module: { moduleId: '/repo/server/src/example.test.ts' },
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

describe('retryHazardReporter (#2028)', () => {
  it('warns when a test failed on its first attempt and only passed after a retry', async () => {
    const reporter = await loadRetryHazardReporter();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      reporter.onTestCaseResult?.(fakeTestCase({ retryCount: 1, state: 'passed' }));
      expect(warn).toHaveBeenCalledTimes(1);
      const message = warn.mock.calls[0]?.[0] as string;
      expect(message).toContain('[retry-hazard]');
      expect(message).toContain('/repo/server/src/example.test.ts');
      expect(message).toContain('suite > example test');
      expect(message).toContain('#2028');
    } finally {
      warn.mockRestore();
    }
  });

  it('stays silent when a test passed on its first attempt (no retry)', async () => {
    const reporter = await loadRetryHazardReporter();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      reporter.onTestCaseResult?.(fakeTestCase({ retryCount: 0, state: 'passed' }));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('stays silent when a test failed even after retrying — it is still red, nothing is hidden', async () => {
    const reporter = await loadRetryHazardReporter();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      reporter.onTestCaseResult?.(fakeTestCase({ retryCount: 1, state: 'failed' }));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('stays silent when no diagnostic is available yet', async () => {
    const reporter = await loadRetryHazardReporter();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      reporter.onTestCaseResult?.(fakeTestCase({ retryCount: undefined, state: 'passed' }));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

/* F2 (PR #2049 review) — every test above calls onTestCaseResult() with a
   HAND-BUILT fake TestCase, which pins the predicate but never the
   INSTALLATION: whether `reporters:` in the real, on-disk vitest.config.ts
   actually wires retryHazardReporter into a real vitest run. Deleting the
   `reporters:` line entirely left all four tests above green — the exact
   "data, not wire" gap commit 3 of this PR (#2025) closes for the mojibake
   echo, reproduced here for this reporter. Spawns the REAL vitest CLI
   against a REAL, on-disk config — not a reconstructed copy — the same
   principle setupGateFixture() uses for the release-notes gate's own CLI
   tests.

   Finding 6 (PR #2049 review) — the fixture is NOT written into the real
   server/src/ tree: it lands under src/__wire-fixtures__/, which
   server/vitest.config.ts EXCLUDES outright, so a fixture that survives a
   kill between write and `finally` cleanup can never poison the real
   suite. Running it at all needs vitest.config.wire-fixtures.ts, the one
   config that DOES include that directory — see its own doc comment for
   why it still proves the real config's retry/reporters behaviour rather
   than a copy of it. */
const VITEST_BIN = resolve(SERVER_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const WIRE_FIXTURES_CONFIG = resolve(SERVER_ROOT, 'vitest.config.wire-fixtures.ts');
const WIRE_FIXTURES_DIR = resolve(SERVER_ROOT, 'src', '__wire-fixtures__');

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
      { cwd: SERVER_ROOT, encoding: 'utf8', env, windowsHide: true },
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

// Finding 5 (PR #2049 review) — a nested vitest invocation is slow
// under contention (a real 5.2s measured under partial pool load on a
// developer box, well over what an idle run needs), so this gets its own
// explicit, generous timeout rather than sharing the file's 15s default.
describe('retryHazardReporter — real wiring (#2028, PR #2049 review F2)', () => {
  it(
    'a real retried-then-passed run prints [retry-hazard] via the ACTUAL on-disk config',
    { timeout: 30_000 },
    () => {
      const out = runVitestOnFixture(
        '__wire_fixture_retry_hazard__.test.ts',
        RETRY_THEN_PASS_FIXTURE,
        { GITHUB_ACTIONS: undefined },
      );
      const combined = `${out.stdout ?? ''}${out.stderr ?? ''}`;
      expect(combined).toContain('[retry-hazard]');
      expect(combined).toContain('__wire_fixture_retry_hazard__.test.ts');
      expect(combined).toContain('fails once then passes, to trigger a real vitest retry');
    },
  );
});

/* F1 (PR #2049 review) — same "data, not wire" defect shape, for vitest's
   OWN built-in 'github-actions' reporter: it is appended automatically only
   when the resolved `reporters` array is EMPTY, so setting one
   unconditionally silently suppressed it in CI (verify.yml runs `vitest
   run` directly in server/, so this is the live gating path). Spawns the
   real CLI exactly like the F2 describe block above.

   Finding 5 (PR #2049 review) — this used to be ONE `it` running TWO
   sequential nested vitest processes against the file's shared 15s
   testTimeout; split into two `it`s, each with its own generous explicit
   timeout, so contention on one spawn can't starve the other's budget. */
const OUTRIGHT_FAIL_FIXTURE = `it('deliberately fails outright, no rescue', () => {
  expect(1).toBe(2);
});
`;

describe('github-actions reporter — real wiring under CI (#2028, PR #2049 review F1)', () => {
  it(
    "GITHUB_ACTIONS=true restores the built-in github-actions reporter's ::error annotation",
    { timeout: 30_000 },
    () => {
      const withCi = runVitestOnFixture(
        '__wire_fixture_gha_on__.test.ts',
        OUTRIGHT_FAIL_FIXTURE,
        { GITHUB_ACTIONS: 'true' },
      );
      expect(`${withCi.stdout ?? ''}${withCi.stderr ?? ''}`).toContain('::error');
    },
  );

  // And the toggle is real, not a vitest-global behaviour our config can't
  // affect either way: outside CI the built-in reporter never fires.
  it(
    'outside CI, the built-in github-actions reporter never fires',
    { timeout: 30_000 },
    () => {
      const withoutCi = runVitestOnFixture(
        '__wire_fixture_gha_off__.test.ts',
        OUTRIGHT_FAIL_FIXTURE,
        { GITHUB_ACTIONS: undefined },
      );
      expect(`${withoutCi.stdout ?? ''}${withoutCi.stderr ?? ''}`).not.toContain('::error');
    },
  );
});
