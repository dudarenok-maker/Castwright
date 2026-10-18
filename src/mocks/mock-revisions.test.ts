import { describe, it, expect, beforeEach } from 'vitest';
import * as m from './mock-revisions';
import { RevisionOpFailure } from '../lib/revision-op-failure';

const entry = (ch: number, id = `r${ch}`) => ({ id, chapterId: ch, characterId: 'eliza', segments: [], playable: true, hasPreviousAudio: true, origin: 'server' as const });
const codeOf = (fn: () => unknown): string => { try { fn(); return 'no-throw'; } catch (e) { return (e as RevisionOpFailure).code; } };
beforeEach(() => m.resetMockRevisions());

describe('mock revisions store (plan 286)', () => {
  it('accept removes the entry, deletes previous, records the outcome and bumps rev', () => {
    m.seedMockRevisions('b', { state: { pending: [entry(3)] }, previousChapterIds: [3], liveChapterIds: [3] });
    const s = m.mockAcceptRevision('b', 'r3', { 0: 'B' });
    expect(s.pending).toEqual([]);
    expect(s.timeline[3].map((t) => t.eventKind)).toEqual(['accepted']);
    expect(s.acceptedSelections.r3).toEqual({ 0: 'B' });
    expect(s.rev).toBe(1);
    expect(s.fileId).not.toBeNull();
    expect(m.mockHasPrevious('b', 3)).toBe(false);
  });
  it('a repeated accept answers the current state; a reject of an accepted id is 404', () => {
    m.seedMockRevisions('b', { state: { pending: [entry(3)] }, previousChapterIds: [3], liveChapterIds: [3] });
    const first = m.mockAcceptRevision('b', 'r3');
    expect(m.mockAcceptRevision('b', 'r3')).toEqual(first);
    expect(codeOf(() => m.mockRejectRevision('b', 'r3'))).toBe('revision_not_found');
  });
  it('accept refuses live_audio_missing when only previous exists, and writes nothing', () => {
    m.seedMockRevisions('b', { state: { pending: [entry(3)] }, previousChapterIds: [3], liveChapterIds: [] });
    expect(codeOf(() => m.mockAcceptRevision('b', 'r3'))).toBe('live_audio_missing');
    expect(m.getMockRevisions('b').rev).toBe(0);
  });
  it('reject with no previous is 409 no_previous_audio and keeps the entry', () => {
    m.seedMockRevisions('b', { state: { pending: [entry(3)] }, liveChapterIds: [3] });
    expect(codeOf(() => m.mockRejectRevision('b', 'r3'))).toBe('no_previous_audio');
    expect(m.getMockRevisions('b').pending).toHaveLength(1);
  });
  it('a review render records only when the chapter already had audio', () => {
    expect(m.mockRecordRender('b', 1, { characterId: 'eliza', triggeredBy: 't' })).toBe(false);
    expect(m.getMockRevisions('b').pending).toEqual([]);
    expect(m.mockRecordRender('b', 1, { characterId: 'eliza', triggeredBy: 't' })).toBe(true);
    const p = m.getMockRevisions('b').pending;
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ chapterId: 1, origin: 'server', playable: true });
    expect(m.mockHasPrevious('b', 1)).toBe(true);
  });
  it('a plain render drops the chapter entry', () => {
    m.seedMockRevisions('b', { state: { pending: [entry(2)] }, liveChapterIds: [2] });
    m.mockRecordRender('b', 2, null);
    expect(m.getMockRevisions('b').pending).toEqual([]);
  });
  it('restore-unrecorded: has_revision with an entry; restored / none otherwise', () => {
    m.seedMockRevisions('b', { state: { pending: [entry(2)] }, previousChapterIds: [2, 4], liveChapterIds: [2, 4] });
    expect(codeOf(() => m.mockRestoreUnrecorded('b', 2))).toBe('has_revision');
    expect(m.mockRestoreUnrecorded('b', 4)).toBe('restored');
    expect(m.mockRestoreUnrecorded('b', 4)).toBe('none');
  });
  it('dismiss is idempotent and bumps rev once', () => {
    expect(m.mockDismissDrift('b', 'd').rev).toBe(1);
    expect(m.mockDismissDrift('b', 'd').rev).toBe(1);
    expect(m.getMockRevisions('b').dismissed).toEqual(['d']);
  });
  it('books are isolated, and the view carries its bookId', () => {
    m.seedMockRevisions('a', { state: { pending: [entry(1)] } });
    expect(m.getMockRevisions('b').pending).toEqual([]);
    expect(m.getMockRevisions('a').bookId).toBe('a');
  });
});
