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
