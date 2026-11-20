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

  /* #4075 - the quiet-poll rule's splice epoch. */
  it('readSpliceEpoch is null unregistered (callers treat it as moved) and reads the registered reader', async () => {
    const { setSpliceEpochReader, readSpliceEpoch } = await import('./active-generation-gate.js');
    expect(readSpliceEpoch()).toBeNull();
    let n = 7;
    setSpliceEpochReader(() => n);
    expect(readSpliceEpoch()).toBe(7);
    n = 8;
    expect(readSpliceEpoch()).toBe(8);
  });

  it('registerSplice bumps the epoch even when the splice releases before anyone looks', async () => {
    const { readSpliceEpoch } = await import('./active-generation-gate.js');
    const { registerSplice } = await import('../routes/chapter-job-coordination.js');
    const before = readSpliceEpoch();
    expect(before).not.toBeNull();
    const release = registerSplice('book-epoch', 1, new AbortController());
    release();
    expect(readSpliceEpoch()).toBe((before as number) + 1);
  });

  /* #4445 - the generation-path tier reconcile excludes its own book's render (its keep
     set protects it) but must see any other render or any splice/repair. */
  describe('isOtherGenerationActive', () => {
    it('fails closed (true) when unregistered', async () => {
      const { isOtherGenerationActive } = await import('./active-generation-gate.js');
      expect(isOtherGenerationActive('book-1')).toBe(true);
    });

    it('is false when the provider returns only the given book', async () => {
      const { setActiveGenerationBooksProvider, isOtherGenerationActive } = await import(
        './active-generation-gate.js'
      );
      setActiveGenerationBooksProvider(() => ['book-1']);
      expect(isOtherGenerationActive('book-1')).toBe(false);
    });

    it('is true when the provider returns another book', async () => {
      const { setActiveGenerationBooksProvider, isOtherGenerationActive } = await import(
        './active-generation-gate.js'
      );
      setActiveGenerationBooksProvider(() => ['book-1', 'book-2']);
      expect(isOtherGenerationActive('book-1')).toBe(true);
    });

    it('is true when a splice counter reads > 0, even if only the given book renders', async () => {
      const { setActiveGenerationBooksProvider, setInFlightSpliceCounter, isOtherGenerationActive } =
        await import('./active-generation-gate.js');
      setActiveGenerationBooksProvider(() => ['book-1']);
      setInFlightSpliceCounter(() => 1);
      expect(isOtherGenerationActive('book-1')).toBe(true);
    });

    it.each([
      ['design', 'setInFlightDesignCounter'],
      ['mint', 'setInFlightMintCounter'],
    ] as const)('is true when a %s is in flight, even if only the given book renders', async (_k, setter) => {
      const gate = await import('./active-generation-gate.js');
      gate.setActiveGenerationBooksProvider(() => ['book-1']);
      expect(gate.isOtherGenerationActive('book-1')).toBe(false);
      gate[setter](() => 1);
      expect(gate.isDesignOrMintActive()).toBe(true);
      expect(gate.isOtherGenerationActive('book-1')).toBe(true);
      gate[setter](() => 0);
      expect(gate.isDesignOrMintActive()).toBe(false);
    });
  });
});
