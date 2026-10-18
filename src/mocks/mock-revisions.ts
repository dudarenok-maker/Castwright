/* Plan 286 — in-memory stand-in for server-owned revisions.json in mock mode
   (dev:mock + e2e). Mirrors server/src/workspace/revisions-store.ts and
   routes/revision-ops.ts closely enough that the client's cache rules and
   thunk branches behave the same against it. Separate module (like
   mock-queue.ts) so api.ts, main.tsx's window hook and unit tests share one
   table. `previous` mirrors `.previous` on disk; `live` mirrors live audio. */
import type { Revision, RevisionsState, TimelineEntry } from '../lib/types';
import { RevisionOpFailure, type RevisionOpCode } from '../lib/revision-op-failure';

type MockFile = Omit<RevisionsState, 'bookId'>;
interface Book { file: MockFile; previous: Set<number>; live: Set<number> }
export interface MockRevisionsSeed { state?: Partial<MockFile>; previousChapterIds?: number[]; liveChapterIds?: number[] }

const books = new Map<string, Book>();
let mintSeq = 0;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const emptyFile = (): MockFile => ({ fileId: null, rev: 0, pending: [], dismissed: [], acceptedSelections: {}, timeline: {} });
const mintFileId = () => `${String(Date.now()).padStart(15, '0')}-mock${(mintSeq++).toString(16)}`;

function book(bookId: string): Book {
  let b = books.get(bookId);
  if (!b) { b = { file: emptyFile(), previous: new Set(), live: new Set() }; books.set(bookId, b); }
  return b;
}
const view = (bookId: string, b: Book): RevisionsState => ({ bookId, ...clone(b.file) });
function save(b: Book, next: MockFile): void {
  b.file = { ...next, fileId: next.fileId ?? mintFileId(), rev: next.rev + 1 };
}
function fail(bookId: string, b: Book, status: number, code: RevisionOpCode, message: string, withState = true): never {
  throw new RevisionOpFailure(message, status, code, withState ? view(bookId, b) : undefined);
}
function hasOutcome(f: MockFile, kind: 'accepted' | 'rejected', id: string): boolean {
  return Object.values(f.timeline).some((list) => list.some((t) => t.id === id && t.eventKind === kind));
}
function appended(f: MockFile, e: TimelineEntry): MockFile['timeline'] {
  const key = e.chapterId as unknown as keyof MockFile['timeline'];
  const prior = (f.timeline[key] ?? []).map((t) => (e.reversible ? { ...t, reversible: false } : t));
  return { ...f.timeline, [key]: [...prior, e] };
}

export function seedMockRevisions(bookId: string, seed: MockRevisionsSeed): void {
  books.set(bookId, {
    file: { ...emptyFile(), ...clone(seed.state ?? {}) },
    previous: new Set(seed.previousChapterIds ?? []),
    live: new Set(seed.liveChapterIds ?? []),
  });
}
export function resetMockRevisions(): void { books.clear(); }
export function hasMockRevisions(bookId: string): boolean { return books.has(bookId); }
export function getMockRevisions(bookId: string): RevisionsState { return view(bookId, book(bookId)); }
export function mockHasPrevious(bookId: string, chapterId: number): boolean { return book(bookId).previous.has(chapterId); }

function findOrDone(bookId: string, revisionId: string, kind: 'accepted' | 'rejected'): { b: Book; entry?: Revision; done?: RevisionsState } {
  const b = book(bookId);
  const entry = b.file.pending.find((p) => p.id === revisionId);
  if (entry) return { b, entry };
  if (hasOutcome(b.file, kind, revisionId)) return { b, done: view(bookId, b) };
  return fail(bookId, b, 404, 'revision_not_found', 'This take was replaced by a newer render or is no longer pending.');
}
function commit(bookId: string, b: Book, entry: Revision, kind: 'accepted' | 'rejected', selection?: Record<number, 'A' | 'B'>): RevisionsState {
  save(b, {
    ...b.file,
    pending: b.file.pending.filter((p) => p.id !== entry.id),
    timeline: appended(b.file, { id: entry.id, chapterId: entry.chapterId, characterId: entry.characterId, eventKind: kind, timestamp: new Date().toISOString(), status: 'active', reversible: true }),
    acceptedSelections: kind === 'accepted' ? { ...b.file.acceptedSelections, [entry.id]: selection ?? {} } : b.file.acceptedSelections,
  });
  return view(bookId, b);
}

export function mockAcceptRevision(bookId: string, revisionId: string, selection?: Record<number, 'A' | 'B'>): RevisionsState {
  const { b, entry, done } = findOrDone(bookId, revisionId, 'accepted');
  if (done) return done;
  const ch = entry!.chapterId;
  if (!b.live.has(ch) && b.previous.has(ch)) {
    fail(bookId, b, 409, 'live_audio_missing', "This chapter's current audio is missing. Reject restores the earlier take; re-rendering the chapter replaces it.");
  }
  b.previous.delete(ch);
  return commit(bookId, b, entry!, 'accepted', selection);
}
export function mockRejectRevision(bookId: string, revisionId: string): RevisionsState {
  const { b, entry, done } = findOrDone(bookId, revisionId, 'rejected');
  if (done) return done;
  const ch = entry!.chapterId;
  if (!b.previous.has(ch)) fail(bookId, b, 409, 'no_previous_audio', 'Original audio not preserved.');
  b.previous.delete(ch);
  b.live.add(ch);
  return commit(bookId, b, entry!, 'rejected');
}
export function mockDismissDrift(bookId: string, driftId: string): RevisionsState {
  const b = book(bookId);
  if (!b.file.dismissed.includes(driftId)) save(b, { ...b.file, dismissed: [...b.file.dismissed, driftId] });
  return view(bookId, b);
}
export function mockRestoreUnrecorded(bookId: string, chapterId: number): 'restored' | 'none' {
  const b = book(bookId);
  if (b.file.pending.some((p) => p.chapterId === chapterId)) {
    fail(bookId, b, 409, 'has_revision', "This chapter has an older pending review — resolve it from the chapter's review first.", false);
  }
  if (!b.previous.has(chapterId)) return 'none';
  b.previous.delete(chapterId);
  b.live.add(chapterId);
  return 'restored';
}
export function mockRecordRender(
  bookId: string,
  chapterId: number,
  review: { characterId: string; triggeredBy: string; oldDuration?: string; newDuration?: string } | null,
  opts: { assumeLive?: boolean } = {},
): boolean {
  const b = book(bookId);
  const hadAudio = opts.assumeLive === true || b.live.has(chapterId);
  if (hadAudio) b.previous.add(chapterId);
  b.live.add(chapterId);
  const others = b.file.pending.filter((p) => p.chapterId !== chapterId);
  if (review && hadAudio) {
    const entry: Revision = {
      id: `revision:${chapterId}:${Date.now()}`, chapterId, characterId: review.characterId,
      triggeredBy: review.triggeredBy, triggeredAgo: 'just now', oldDuration: review.oldDuration ?? '', newDuration: review.newDuration ?? '',
      confidence: 1, playable: true, hasPreviousAudio: true, segments: [], origin: 'server',
    };
    save(b, { ...b.file, pending: [...others, entry] });
    return true;
  }
  if (others.length !== b.file.pending.length) save(b, { ...b.file, pending: others });
  return false;
}
