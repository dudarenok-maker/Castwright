import { describe, it, expect, vi, beforeEach } from 'vitest';

/* Stateless leaf gate for "is any render in flight anywhere" (#1839). See
   active-generation-gate.ts's file header for why this module imports
   nothing and why unregistered must fail closed.

   Each test re-imports the module fresh (vi.resetModules) rather than
   relying on execution order, since the module's `provider` is
   process-lifetime state shared across every test in this file. */

beforeEach(() => {
  vi.resetModules();
});

describe('active-generation-gate', () => {
  it('fails closed (true) before anything registers', async () => {
    const { isAnyGenerationActive } = await import('./active-generation-gate.js');
    expect(isAnyGenerationActive()).toBe(true);
  });

  it('reads the registered provider once one is set', async () => {
    const { setActiveGenerationBooksProvider, isAnyGenerationActive } = await import(
      './active-generation-gate.js'
    );

    setActiveGenerationBooksProvider(() => ['book-1']);
    expect(isAnyGenerationActive()).toBe(true);

    setActiveGenerationBooksProvider(() => []);
    expect(isAnyGenerationActive()).toBe(false);
  });

  /* #4066 — a QA repair or a splice re-synthesises on the GPU but is not in
     generation's `inFlightByBook`; the owning module registers a counter. */
  it('counts a registered in-flight splice/repair as active (both predicates)', async () => {
    const { setActiveGenerationBooksProvider, setInFlightSpliceCounter, isAnyGenerationActive, isGenerationKnownActive } =
      await import('./active-generation-gate.js');

    setActiveGenerationBooksProvider(() => []);
    let spliceCount = 0;
    setInFlightSpliceCounter(() => spliceCount);
    expect(isAnyGenerationActive()).toBe(false);
    expect(isGenerationKnownActive()).toBe(false);

    spliceCount = 1;
    expect(isAnyGenerationActive()).toBe(true);
    expect(isGenerationKnownActive()).toBe(true);
  });

  /* #4075 - wording-only: a repair-only state must be distinguishable from a render. */
  it('isRepairOnlyKnownActive is true only for a splice/repair with no render, and false unregistered', async () => {
    const { setActiveGenerationBooksProvider, setInFlightSpliceCounter, isRepairOnlyKnownActive } = await import(
      './active-generation-gate.js'
    );
    expect(isRepairOnlyKnownActive()).toBe(false); // unregistered

    let books: string[] = [];
    let splices = 0;
    setActiveGenerationBooksProvider(() => books);
    setInFlightSpliceCounter(() => splices);
    expect(isRepairOnlyKnownActive()).toBe(false); // idle

    splices = 1;
    expect(isRepairOnlyKnownActive()).toBe(true); // repair only

    books = ['book-1'];
    expect(isRepairOnlyKnownActive()).toBe(false); // a render is also running: render wording
  });
});
