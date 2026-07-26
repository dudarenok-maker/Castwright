import { describe, it, expect, vi, beforeEach } from 'vitest';

/* Stateless leaf gate for "what does the sidecar currently report resident"
   (#1839). See sidecar-health-gate.ts's file header for why this module
   imports nothing and why unregistered must fail closed.

   Each test re-imports the module fresh (vi.resetModules) rather than
   relying on execution order, since the module's `provider` is
   process-lifetime state shared across every test in this file. */

beforeEach(() => {
  vi.resetModules();
});

describe('sidecar-health-gate', () => {
  it('fails closed (null, no call) before anything registers', async () => {
    const { probeSidecarHealthIfRegistered } = await import('./sidecar-health-gate.js');
    const snapshot = await probeSidecarHealthIfRegistered();
    expect(snapshot).toBeNull();
  });

  it('calls the registered provider once one is set', async () => {
    const { setProbeSidecarHealthProvider, probeSidecarHealthIfRegistered } = await import(
      './sidecar-health-gate.js'
    );

    const provider = vi.fn().mockResolvedValue({ modelLoaded: true, kokoroLoaded: false });
    setProbeSidecarHealthProvider(provider);

    const snapshot = await probeSidecarHealthIfRegistered();

    expect(snapshot).toEqual({ modelLoaded: true, kokoroLoaded: false });
    expect(provider).toHaveBeenCalledTimes(1);
  });
});
