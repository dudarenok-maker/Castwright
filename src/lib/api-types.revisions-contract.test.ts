/* Plan 285 Task 6 — the PR-1 revisions contract, pinned against the GENERATED
   types. Compile-time assertions: they fail under `npm run typecheck`. The
   runtime `expect`s exist so vitest also reports each case. */
import { describe, it, expect, expectTypeOf } from 'vitest';
import type { components, paths } from './api-types';
import type { SpliceTick, QaRepairTick, __MockApi, __RealApi } from './api';
import type { ReviewRequest, BookStateResponse } from './types';

type S = components['schemas'];
type RevisionsState = S['RevisionsState'];
type Ok<P extends keyof paths> = paths[P] extends {
  post: { responses: { 200: { content: { 'application/json': infer B } } } };
}
  ? B
  : never;

describe('openapi: plan 285 PR 1', () => {
  it('accept / reject / dismiss each answer a full RevisionsState', () => {
    expectTypeOf<
      Ok<'/api/books/{bookId}/revisions/{revisionId}/accept'>
    >().toEqualTypeOf<RevisionsState>();
    expectTypeOf<
      Ok<'/api/books/{bookId}/revisions/{revisionId}/reject'>
    >().toEqualTypeOf<RevisionsState>();
    expectTypeOf<
      Ok<'/api/books/{bookId}/drift/{driftId}/dismiss'>
    >().toEqualTypeOf<RevisionsState>();
  });

  it('RevisionsState is fully required, fileId nullable', () => {
    expectTypeOf<RevisionsState>().toEqualTypeOf<Required<RevisionsState>>();
    expectTypeOf<RevisionsState['fileId']>().toEqualTypeOf<string | null>();
    expectTypeOf<RevisionsState['rev']>().toEqualTypeOf<number>();
    const s: RevisionsState = {
      bookId: 'b',
      fileId: null,
      rev: 0,
      pending: [],
      dismissed: [],
      acceptedSelections: {},
      timeline: {},
    };
    expect(s.rev).toBe(0);
  });

  it('every field added to an EXISTING schema is optional (PR 1 mocks return partial shapes)', () => {
    const poll: S['RevisionsResponse'] = {};
    const tick: S['GenerationTick'] = { type: 'idle' };
    const rev: S['Revision'] = { id: 'r', chapterId: 1, characterId: 'c', segments: [] };
    const q: S['QueueEntry'] = {
      id: 'e',
      bookId: 'b',
      chapterId: 1,
      scope: 'this',
      addedAt: '2026-10-02T00:00:00.000Z',
      status: 'queued',
      order: 0,
    };
    expect([poll, tick, rev, q]).toHaveLength(4);
    expectTypeOf<S['RevisionsResponse']['fileId']>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<S['GenerationTick']['reviewChapter']>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<S['GenerationTick']['reviewOutcome']>().toEqualTypeOf<'recorded' | 'none' | 'failed' | undefined>();
    expectTypeOf<S['Revision']['origin']>().toEqualTypeOf<'server' | undefined>();
    expectTypeOf<S['QueueEntry']['review']>().toEqualTypeOf<ReviewRequest | undefined>();
    expectTypeOf<S['QueueEnqueueEntry']['review']>().toEqualTypeOf<ReviewRequest | undefined>();
    expectTypeOf<NonNullable<S['BookStateResponse']['revisions']>>().toEqualTypeOf<S['RevisionsState']>();
    expectTypeOf<S['BookStateResponse']['revisionsError']>().toEqualTypeOf<string | undefined>();
  });

  it('ReviewRequest is { characterId, triggeredBy }', () => {
    expectTypeOf<ReviewRequest>().toEqualTypeOf<{ characterId: string; triggeredBy: string }>();
  });

  it('the hand-written splice / qa-repair completion ticks carry an optional reviewOutcome', () => {
    expectTypeOf<
      Extract<SpliceTick, { type: 'splice_complete' }>['reviewOutcome']
    >().toEqualTypeOf<'recorded' | 'none' | 'failed' | undefined>();
    expectTypeOf<
      Extract<QaRepairTick, { type: 'qa_repair_complete' }>['reviewOutcome']
    >().toEqualTypeOf<'recorded' | 'none' | 'failed' | undefined>();
  });
});

describe('openapi: plan 286 PR 2', () => {
  it('plan 286 — restore-unrecorded is a POST with 204 / 404 / 409 / 500', () => {
    type Op = paths['/api/books/{bookId}/chapters/{chapterId}/audio/previous/restore-unrecorded']['post'];
    expectTypeOf<keyof Op['responses']>().toEqualTypeOf<204 | 404 | 409 | 500>();
  });

  it('plan 286 (OD20) — Revision carries an optional recovered flag', () => {
    expectTypeOf<S['Revision']['recovered']>().toEqualTypeOf<boolean | undefined>();
  });

  it('plan 286 — the client BookStateResponse.revisions is the generated RevisionsState', () => {
    expectTypeOf<BookStateResponse['revisions']>().toEqualTypeOf<S['RevisionsState'] | null>();
    expectTypeOf<BookStateResponse['revisionsError']>().toEqualTypeOf<string | undefined>();
  });

  it('plan 286 — mock and real revisions functions have identical signatures', () => {
    type K =
      | 'acceptRevision'
      | 'rejectRevision'
      | 'dismissDrift'
      | 'restorePreviousUnrecorded'
      | 'pollRevisions'
      | 'pollRevisionsBulk'
      | 'getChapterAudioPrevious';
    expectTypeOf<Pick<__MockApi, K>>().toEqualTypeOf<Pick<__RealApi, K>>();
  });
});
