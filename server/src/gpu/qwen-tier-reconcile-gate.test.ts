import { describe, it, expect, vi, beforeEach } from 'vitest';

/* Stateless leaf gate for "free a resident Qwen base tier this run doesn't
   need" (#1839). See qwen-tier-reconcile-gate.ts's file header for why this
   module imports nothing and why unregistered must fail closed.

   Each test re-imports the module fresh (vi.resetModules) rather than
   relying on execution order, since the module's `provider` is
   process-lifetime state shared across every test in this file. */

beforeEach(() => {
  vi.resetModules();
});

describe('qwen-tier-reconcile-gate', () => {
  it('fails closed (false, no call) before anything registers', async () => {
    const { reconcileResidentQwenTiersIfRegistered } = await import(
      './qwen-tier-reconcile-gate.js'
    );
    const freed = await reconcileResidentQwenTiersIfRegistered({ keep06: true, keep17: false });
    expect(freed).toBe(false);
  });

  it('calls the registered provider once one is set', async () => {
    const { setReconcileResidentQwenTiersProvider, reconcileResidentQwenTiersIfRegistered } =
      await import('./qwen-tier-reconcile-gate.js');

    const provider = vi.fn().mockResolvedValue(undefined);
    setReconcileResidentQwenTiersProvider(provider);

    const freed = await reconcileResidentQwenTiersIfRegistered(
      { keep06: false, keep17: true },
      undefined,
    );

    expect(freed).toBe(true);
    expect(provider).toHaveBeenCalledWith({ keep06: false, keep17: true }, undefined);
  });
});
