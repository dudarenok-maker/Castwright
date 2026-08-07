/* #2166 — the reconciliation that heals a half-written reject.
   Pure: no fs, no locking. Every rule in the design doc gets a case, and the
   two Criticals from the spec's review round get one each (R3, R7). */

import { describe, it, expect } from 'vitest';
import { reconcileRejectEdges } from './reject-edge-reconcile.js';
import type { CastIdHistory } from './cast-id-history.js';

const BOOK = 'book-hollow-tide';
const OTHER_BOOK = 'book-somewhere-else';

function history(over: Partial<CastIdHistory> = {}): CastIdHistory {
  return { schema: 1, supersededBy: {}, ...over };
}

function row(id: string, notLinkedTo?: Array<{ bookId: string; characterId: string }>) {
  return notLinkedTo === undefined ? { id } : { id, notLinkedTo };
}

describe('reconcileRejectEdges', () => {
  it('[R1] removes a same-book edge with no durable backing anywhere', () => {
    const cast = [row('mairin', [{ bookId: BOOK, characterId: 'mairin_2' }])];
    const out = reconcileRejectEdges(BOOK, cast, history());

    expect(out.removes).toEqual([{ characterId: 'mairin', orphanedId: 'mairin_2' }]);
    expect(out.adds).toEqual([]);
    expect(out.next[0].notLinkedTo).toEqual([]);
  });

  it('[R2] keeps an edge backed by a rejectedPairs entry', () => {
    const cast = [row('mairin', [{ bookId: BOOK, characterId: 'mairin_2' }])];
    const out = reconcileRejectEdges(
      BOOK,
      cast,
      history({ rejectedPairs: [{ from: 'mairin_2', to: 'mairin' }] }),
    );

    expect(out.removes).toEqual([]);
    expect(out.adds).toEqual([]);
    expect(out.next[0].notLinkedTo).toEqual([{ bookId: BOOK, characterId: 'mairin_2' }]);
  });

  it('[R3] keeps an edge backed ONLY by the legacy id-wide `rejected` list', () => {
    /* The spec's revision-1 Critical. A book rejected between aa6616d8 and
       f6074ca8 recorded its decision here, not in rejectedPairs — and
       buildCastResolver still honours it (cast-resolve.ts:108/:164). Removing
       the edge would silently un-suppress the §4.4 matcher for a decision the
       user really made. */
    const cast = [row('mairin', [{ bookId: BOOK, characterId: 'mairin_2' }])];
    const out = reconcileRejectEdges(BOOK, cast, history({ rejected: ['mairin_2'] }));

    expect(out.removes).toEqual([]);
    expect(out.next[0].notLinkedTo).toEqual([{ bookId: BOOK, characterId: 'mairin_2' }]);
  });

  it('[R4] writes the edge back when a pair survived but its edge is gone', () => {
    const cast = [row('mairin')];
    const out = reconcileRejectEdges(
      BOOK,
      cast,
      history({ rejectedPairs: [{ from: 'mairin_2', to: 'mairin' }] }),
    );

    expect(out.adds).toEqual([{ characterId: 'mairin', orphanedId: 'mairin_2' }]);
    expect(out.removes).toEqual([]);
    expect(out.next[0].notLinkedTo).toEqual([{ bookId: BOOK, characterId: 'mairin_2' }]);
  });

  it('[R5] writes nothing when the pair targets a row that is not live', () => {
    const cast = [row('narrator')];
    const out = reconcileRejectEdges(
      BOOK,
      cast,
      history({ rejectedPairs: [{ from: 'mairin_2', to: 'mairin' }] }),
    );

    expect(out.adds).toEqual([]);
    expect(out.removes).toEqual([]);
  });

  it('[R6] never touches a cross-book edge', () => {
    const cast = [row('mairin', [{ bookId: OTHER_BOOK, characterId: 'someone' }])];
    const out = reconcileRejectEdges(BOOK, cast, history());

    expect(out.removes).toEqual([]);
    expect(out.next[0].notLinkedTo).toEqual([{ bookId: OTHER_BOOK, characterId: 'someone' }]);
  });

  it('[R7] leaves a relocated edge alone and still heals p.to', () => {
    /* Removal half (kept verbatim — the data-loss guard): merge-analysis-
       cast.ts:473-480 copies old.notLinkedTo onto a fresh row matched by
       NAME, so a legitimate edge can sit on a row whose id is not the pair's
       `to`. Row-scoped removal would delete it. This assertion is what stops
       that from happening. */
    const cast = [row('mairin_renamed', [{ bookId: BOOK, characterId: 'mairin_2' }]), row('mairin')];
    const out = reconcileRejectEdges(
      BOOK,
      cast,
      history({ rejectedPairs: [{ from: 'mairin_2', to: 'mairin' }] }),
    );

    expect(out.removes).toEqual([]);
    expect(out.next[0].notLinkedTo).toEqual([{ bookId: BOOK, characterId: 'mairin_2' }]);

    /* Add half (#2200 — this is the assertion that changed): a relocated
       edge for `from` is no longer a reason to suppress `p.to`'s own add.
       The relocated copy above and the fresh add below are independent —
       neither is a duplicate of the other, since they sit on different
       rows. */
    expect(out.adds).toEqual([{ characterId: 'mairin', orphanedId: 'mairin_2' }]);
    expect(out.next[1].notLinkedTo).toEqual([{ bookId: BOOK, characterId: 'mairin_2' }]);
  });

  it('[R8] heals BOTH rows when one `from` is rejected against two live characters', () => {
    /* D1 pair scope: the same orphaned id can be rejected against two
       different people, and the original POSTs wrote an edge on each. A
       blanket "no edge anywhere for this `from`" rule heals only the first.
       See the plan's "Deviation from the spec". */
    const cast = [row('mairin'), row('mara')];
    const out = reconcileRejectEdges(
      BOOK,
      cast,
      history({
        rejectedPairs: [
          { from: 'mairin_2', to: 'mairin' },
          { from: 'mairin_2', to: 'mara' },
        ],
      }),
    );

    expect(out.adds).toEqual([
      { characterId: 'mairin', orphanedId: 'mairin_2' },
      { characterId: 'mara', orphanedId: 'mairin_2' },
    ]);
    expect(out.next[0].notLinkedTo).toEqual([{ bookId: BOOK, characterId: 'mairin_2' }]);
    expect(out.next[1].notLinkedTo).toEqual([{ bookId: BOOK, characterId: 'mairin_2' }]);
  });

  it('[R8b] heals the SURVIVING half when one of two pairs kept its edge', () => {
    /* THE discriminating case for the plan's declared deviation. The spec's
       blanket rule ("no edge anywhere in this book names this `from`") sees
       mairin's surviving edge and skips BOTH pairs, so `mara` never heals and
       re-running never fixes it. Unlike [R8], this case reddens under EITHER
       reading of the blanket rule — precomputed or live — which is what makes
       it the mutation target in Step 5. */
    const cast = [row('mairin', [{ bookId: BOOK, characterId: 'mairin_2' }]), row('mara')];
    const out = reconcileRejectEdges(
      BOOK,
      cast,
      history({
        rejectedPairs: [
          { from: 'mairin_2', to: 'mairin' },
          { from: 'mairin_2', to: 'mara' },
        ],
      }),
    );

    expect(out.adds).toEqual([{ characterId: 'mara', orphanedId: 'mairin_2' }]);
    expect(out.removes).toEqual([]);
    expect(out.next[0].notLinkedTo).toEqual([{ bookId: BOOK, characterId: 'mairin_2' }]);
    expect(out.next[1].notLinkedTo).toEqual([{ bookId: BOOK, characterId: 'mairin_2' }]);
  });

  it('[R13] heals BOTH edgeless pairs even when one `from` also has a relocated edge', () => {
    /* #2200's literal acceptance shape. The issue asks only that `mara` heal,
       but nothing in the state distinguishes `mairin` and `mara` — both
       pairs are equally edgeless — so healing one and not the other would be
       an arbitrary choice. Both heal. */
    const cast = [
      row('mairin_renamed', [{ bookId: BOOK, characterId: 'mairin_2' }]),
      row('mairin'),
      row('mara'),
    ];
    const out = reconcileRejectEdges(
      BOOK,
      cast,
      history({
        rejectedPairs: [
          { from: 'mairin_2', to: 'mairin' },
          { from: 'mairin_2', to: 'mara' },
        ],
      }),
    );

    expect(out.adds).toEqual([
      { characterId: 'mairin', orphanedId: 'mairin_2' },
      { characterId: 'mara', orphanedId: 'mairin_2' },
    ]);
    expect(out.removes).toEqual([]);
    expect(out.next[0].notLinkedTo).toEqual([{ bookId: BOOK, characterId: 'mairin_2' }]);
    expect(out.next[1].notLinkedTo).toEqual([{ bookId: BOOK, characterId: 'mairin_2' }]);
    expect(out.next[2].notLinkedTo).toEqual([{ bookId: BOOK, characterId: 'mairin_2' }]);
  });

  it('[R13b] heals the surviving edgeless pair when the other pair already has its own edge, alongside a relocated copy', () => {
    /* THE discriminating case (#2200) — the production shape from routes
       (i)/(ii) of the design doc's §1.2: a relocated copy sits on a renamed
       row, `mairin` ALSO carries its own direct edge, and `mara` has none.
       The old relocation guard suppressed every add for `mairin_2` because a
       relocated edge existed — so `mara` never healed. Only `mara` should
       add here; `mairin` already has its edge and must not be duplicated. */
    const cast = [
      row('mairin_renamed', [{ bookId: BOOK, characterId: 'mairin_2' }]),
      row('mairin', [{ bookId: BOOK, characterId: 'mairin_2' }]),
      row('mara'),
    ];
    const out = reconcileRejectEdges(
      BOOK,
      cast,
      history({
        rejectedPairs: [
          { from: 'mairin_2', to: 'mairin' },
          { from: 'mairin_2', to: 'mara' },
        ],
      }),
    );

    expect(out.adds).toEqual([{ characterId: 'mara', orphanedId: 'mairin_2' }]);
    expect(out.removes).toEqual([]);
    expect(out.next[0].notLinkedTo).toEqual([{ bookId: BOOK, characterId: 'mairin_2' }]);
    expect(out.next[1].notLinkedTo).toEqual([{ bookId: BOOK, characterId: 'mairin_2' }]);
    expect(out.next[2].notLinkedTo).toEqual([{ bookId: BOOK, characterId: 'mairin_2' }]);
  });

  it('[R14] converges — feeding the healed roster back through adds nothing further', () => {
    /* Idempotence: re-running reconciliation against [R13]'s healed output
       and the same history must be a no-op, proving the fix does not force a
       write on every subsequent persist (the caller only writes when
       `adds`/`removes` are non-empty, analysis.ts:416). */
    const healed = [
      row('mairin_renamed', [{ bookId: BOOK, characterId: 'mairin_2' }]),
      row('mairin', [{ bookId: BOOK, characterId: 'mairin_2' }]),
      row('mara', [{ bookId: BOOK, characterId: 'mairin_2' }]),
    ];
    const hist = history({
      rejectedPairs: [
        { from: 'mairin_2', to: 'mairin' },
        { from: 'mairin_2', to: 'mara' },
      ],
    });
    const out = reconcileRejectEdges(BOOK, healed, hist);

    expect(out.adds).toEqual([]);
    expect(out.removes).toEqual([]);
    expect(out.next).toEqual(healed);
  });

  it('[R9] reports nothing for an already-consistent book', () => {
    const cast = [
      row('mairin', [{ bookId: BOOK, characterId: 'mairin_2' }]),
      row('narrator'),
    ];
    const out = reconcileRejectEdges(
      BOOK,
      cast,
      history({ rejectedPairs: [{ from: 'mairin_2', to: 'mairin' }] }),
    );

    expect(out.adds).toEqual([]);
    expect(out.removes).toEqual([]);
  });

  it('[R10] removes only the unbacked edge, keeping a backed sibling on the same row', () => {
    const cast = [
      row('mairin', [
        { bookId: BOOK, characterId: 'mairin_2' },
        { bookId: BOOK, characterId: 'ghost_id' },
      ]),
    ];
    const out = reconcileRejectEdges(
      BOOK,
      cast,
      history({ rejectedPairs: [{ from: 'mairin_2', to: 'mairin' }] }),
    );

    expect(out.removes).toEqual([{ characterId: 'mairin', orphanedId: 'ghost_id' }]);
    expect(out.next[0].notLinkedTo).toEqual([{ bookId: BOOK, characterId: 'mairin_2' }]);
  });

  it('[R11] does not mutate its input on the REMOVE path', () => {
    const edges = [{ bookId: BOOK, characterId: 'mairin_2' }];
    const cast = [{ id: 'mairin', notLinkedTo: edges }];
    reconcileRejectEdges(BOOK, cast, history());

    expect(cast[0].notLinkedTo).toBe(edges);
    expect(edges).toEqual([{ bookId: BOOK, characterId: 'mairin_2' }]);
  });

  it('[R12] does not mutate its input on the ADD path', () => {
    /* [R11] runs with an empty history, so pass 2 never executes and the
       `next[idx] = { ...row, … }` line it is meant to cover is never reached. */
    const cast = [{ id: 'mairin' }, { id: 'mara' }];
    const snapshot = JSON.stringify(cast);
    const out = reconcileRejectEdges(
      BOOK,
      cast,
      history({ rejectedPairs: [{ from: 'mairin_2', to: 'mairin' }] }),
    );

    expect(JSON.stringify(cast)).toBe(snapshot);
    expect(out.next[0]).not.toBe(cast[0]);
    expect(out.next[1]).toBe(cast[1]); // untouched rows pass through by reference
  });
});
