/* Task 8 — pin pipInstall's ORT marker wiring on the in-app upgrade path.
   pipInstall's real body has zero coverage elsewhere: apply.test.ts replaces
   the whole member with a stub. This is the only place its marker-delete/
   marker-write ordering is exercised. */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createApplySteps } from './apply.js';

const ORIGINAL_ACCELERATOR = process.env.ACCELERATOR;

afterEach(() => {
  if (ORIGINAL_ACCELERATOR === undefined) delete process.env.ACCELERATOR;
  else process.env.ACCELERATOR = ORIGINAL_ACCELERATOR;
});

function harness(profile: 'nvidia' | 'cpu') {
  const calls: string[] = [];
  process.env.ACCELERATOR = profile;
  const deps = {
    run: vi.fn(async (_py: string, args: string[]) => {
      calls.push(`pip ${args.join(' ')}`);
    }),
    markerDel: vi.fn(() => {
      calls.push('marker:delete');
    }),
    markerWrite: vi.fn(() => {
      calls.push('marker:write');
    }),
  };
  const steps = createApplySteps({ venvDir: '/venv', log: () => {} }, deps);
  return { calls, steps, deps };
}

describe('pipInstall ORT marker wiring', () => {
  it('deletes before the first pip call', async () => {
    const h = harness('cpu');
    await h.steps.pipInstall('/rel');
    // Positive control: the delete actually ran, not just "nothing ran first".
    expect(h.deps.markerDel).toHaveBeenCalledOnce();
    expect(h.calls[0]).toBe('marker:delete');
  });

  it('writes after the swap on nvidia', async () => {
    const h = harness('nvidia');
    await h.steps.pipInstall('/rel');
    // Positive control: the write actually ran.
    expect(h.deps.markerWrite).toHaveBeenCalledOnce();
    expect(h.calls[h.calls.length - 1]).toBe('marker:write');
  });

  it('never writes on cpu', async () => {
    const h = harness('cpu');
    await h.steps.pipInstall('/rel');
    // Positive control: pipInstall did run pip work (calls isn't just empty),
    // so the absence of 'marker:write' below is a real assertion.
    expect(h.calls.length).toBeGreaterThan(0);
    expect(h.deps.markerWrite).not.toHaveBeenCalled();
    expect(h.calls).not.toContain('marker:write');
  });

  it('deletes and does not write when a swap step throws', async () => {
    const h = harness('nvidia');
    h.deps.run.mockImplementation(async (_py: string, args: string[]) => {
      h.calls.push(`pip ${args.join(' ')}`);
      if (args.includes('--force-reinstall')) throw new Error('boom');
    });
    await expect(h.steps.pipInstall('/rel')).rejects.toThrow('boom');
    expect(h.calls.filter((c) => c === 'marker:delete')).toHaveLength(2);
    expect(h.deps.markerWrite).not.toHaveBeenCalled();
    expect(h.calls).not.toContain('marker:write');
  });
});
