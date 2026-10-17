/* Plan 285 (#3400) — the ONLY reader/writer of `<bookDir>/.audiobook/revisions.json`.
   Modelled on script-review-ledger.ts.

   LOCK. Every write runs under withKeyLock(revisionsLockKey(bookDir)). The key is
   "revisions:" + the path.resolve'd bookDir, normalised HERE so two callers that
   spell bookDir differently can never split the lock. The read, and every
   decision derived from it, happens inside the lock.

   LEAF LOCK. Nothing acquires any other lock while holding this one, and no file
   other than revisions.json is WRITTEN under it. (Normalisation probes
   `audio/<slug>.previous.mp3` for existence — a read-only stat, no lock, no
   write.) See the lock-order comment in cast-lock.ts.

   READS (readRevisions) take no lock: writeJsonAtomic renames atomically, so a
   reader always sees one whole version, and a GET can never hit a lock timeout.

   SCHEMA. Reads go through schema-migrate.ts's migrateSeamDoc (a newer-schema
   file throws UnsupportedSchemaError — refused, never downgraded); writes are
   stamped with stampSeamSchema. A CORRUPT file throws, exactly as on main
   (readJson's JSON.parse), so no store write ever overwrites it; only
   resetRevisions (reparse / replace) replaces a corrupt file, as the old `rm`
   did. assertRevisionsResettable is the preflight reparse/replace run BEFORE
   deleting anything. (Since plan 286 the client's PUT /state refuses a
   `revisions` slice, so nothing writes the file outside this module.)

   WRITERS. The server records `pending` entries (finalize via recordPending /
   dropPendingForChapter(s)) and the per-op routes (routes/revision-ops.ts)
   write through beginRevisionOp / commitRevisionOp / dismissDriftId. The
   client writes nothing. */

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { readJson, writeJsonAtomic } from './state-io.js';
import { audioDir, revisionsJsonPath, stateJsonPath } from './paths.js';
import { withKeyLock } from './file-lock.js';
import { hasPreviousAudio as previousAudioExists } from './preserve-previous-audio.js';
import { SCHEMA_SEAMS, migrateSeamDoc, stampSeamSchema, UnsupportedSchemaError } from './schema-migrate.js';

const REVISIONS_SEAM = SCHEMA_SEAMS.find((s) => s.label === 'revisions.json')!;

/** `uuid` / `audioRenderedAt` are the chapter's identity stamps (state.json); optional so a chapter
    that has not been stamped yet still resolves. See entryMatchesChapter. */
export interface ChapterRef { id: number; slug: string; uuid?: string; audioRenderedAt?: string }
export interface StoredRevision {
  id: string; chapterId: number; characterId: string;
  triggeredBy?: string; triggeredAgo?: string; oldDuration?: string; newDuration?: string;
  confidence?: number; playable: boolean; hasPreviousAudio: boolean;
  segments: unknown[];
  /** Present (`'server'`) on entries the server recorded; absent on legacy client-written ones. */
  origin?: 'server';
  /** Identity of the chapter this entry was recorded for (chapter `uuid`, which survives renumbering) and of the render it pairs with (`audioRenderedAt`). Stamped by finalize; absent on legacy entries. Checked by entryMatchesChapter. */
  chapterUuid?: string;
  renderedAt?: string;
  /** Plan 286 OD20 — a legacy entry the old client never flipped (stuck "Rendering…"), surfaced because .previous.mp3 exists. Its A side is the take kept before the chapter's last render, which may not be the take this entry was recorded against. */
  recovered?: true;
}
export interface StoredTimelineEntry {
  id: string; chapterId: number; characterId?: string;
  eventKind: 'accepted' | 'rejected' | 'rolled-back'; timestamp: string;
  revisionId?: string; status: 'active' | 'rolled-back-from'; reversible?: boolean;
}

export type Selection = Record<string, 'A' | 'B'>;

export interface RevisionsFile {
  schema: 1;
  /** `${epochMs zero-padded to 15}-${random}`; minted on the first store write and on every reset. Null = a legacy/missing file nobody has written through the store. */
  fileId: string | null;
  /** +1 on every write within one fileId; 0 for a missing file and after a reset. */
  rev: number;
  pending: StoredRevision[];
  dismissed: string[];
  acceptedSelections: Record<string, Selection>;
  timeline: Record<string, StoredTimelineEntry[]>;
}

export interface RevisionsState {
  bookId: string;
  fileId: string | null;
  rev: number;
  pending: StoredRevision[];
  dismissed: string[];
  acceptedSelections: Record<string, Selection>;
  timeline: Record<string, StoredTimelineEntry[]>;
}

export function revisionsLockKey(bookDir: string): string {
  return `revisions:${resolve(bookDir)}`;
}

/** Per-chapter key serialising accept/reject (and restore-unrecorded)
    across their whole audio step. Distinct from the revisions lock:
    lock order is `revision-op` -> `revisions`, never the reverse. */
export function revisionOpLockKey(bookDir: string, chapterId: number): string {
  return `revision-op:${resolve(bookDir)}:${chapterId}`;
}

export function mintFileId(nowMs: number = Date.now(), suffix: string = randomBytes(4).toString('hex')): string {
  return `${String(nowMs).padStart(15, '0')}-${suffix}`;
}

export function emptyRevisionsFile(fileId: string | null = null): RevisionsFile {
  return { schema: 1, fileId, rev: 0, pending: [], dismissed: [], acceptedSelections: {}, timeline: {} };
}

/** Explicit `===` comparisons (not a Set) so CodeQL's
    js/prototype-polluting-assignment barrier recognises the guard inline —
    same shape as script-review-ledger.ts. */
function isDangerousKey(key: string): boolean {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const EVENT_KINDS = new Set(['accepted', 'rejected', 'rolled-back']);

/** Pure. Never writes. `previousExists(chapterId)` answers whether
    `audio/<slug>.previous.mp3` exists for that chapter. Rules (spec §1):
    drop the legacy `drift` copy; default missing fields; keep a legacy
    (origin-less) entry — whatever its `playable` flag — only while
    `.previous.mp3` exists, surfaced as playable, and stamped
    `recovered: true` when it was stored `playable:false` (plan 286 OD20);
    keep the LAST entry per chapter, except that a recovered entry never
    replaces a non-recovered one (plan 286, pass 3 #5). */
export function normaliseRevisions(
  raw: unknown,
  previousExists: (chapterId: number) => boolean,
): RevisionsFile {
  if (!isObj(raw)) return emptyRevisionsFile();
  const fileId = typeof raw.fileId === 'string' && raw.fileId.length > 0 ? raw.fileId : null;
  const rev = typeof raw.rev === 'number' && Number.isInteger(raw.rev) && raw.rev >= 0 ? raw.rev : 0;

  const byChapter = new Map<number, StoredRevision>();
  for (const e of Array.isArray(raw.pending) ? raw.pending : []) {
    if (!isObj(e)) continue;
    if (typeof e.id !== 'string' || typeof e.characterId !== 'string') continue;
    if (typeof e.chapterId !== 'number' || !Number.isInteger(e.chapterId)) continue;
    if (e.origin !== 'server') {
      if (!previousExists(e.chapterId)) continue;
    }
    const recovered = e.origin !== 'server' && (e.playable === false || e.recovered === true);
    /* Plan 286 (OD20, pass 3 #5) — a recovered entry never replaces a non-recovered
       one for its chapter, whatever their order: a failed splice appended
       after a playable take must not shadow it (it would show as "Recovered"
       with no segments, and the next store write would persist the loss). */
    const held = byChapter.get(e.chapterId);
    if (recovered && held && !held.recovered) continue;
    byChapter.delete(e.chapterId);
    byChapter.set(e.chapterId, {
      ...(e as unknown as StoredRevision),
      segments: Array.isArray(e.segments) ? e.segments : [],
      playable: true,
      hasPreviousAudio: typeof e.hasPreviousAudio === 'boolean' ? e.hasPreviousAudio : true,
      ...(recovered ? { recovered: true as const } : {}),
    });
  }

  const dismissed = Array.isArray(raw.dismissed)
    ? [...new Set(raw.dismissed.filter((d): d is string => typeof d === 'string'))]
    : [];

  const acceptedSelections: Record<string, Selection> = {};
  if (isObj(raw.acceptedSelections)) {
    for (const [revId, sel] of Object.entries(raw.acceptedSelections)) {
      if (isDangerousKey(revId) || !isObj(sel)) continue;
      const out: Selection = {};
      for (const [k, v] of Object.entries(sel)) {
        if (isDangerousKey(k)) continue;
        if (v === 'A' || v === 'B') out[k] = v;
      }
      acceptedSelections[revId] = out;
    }
  }

  const timeline: Record<string, StoredTimelineEntry[]> = {};
  if (isObj(raw.timeline)) {
    for (const [chapterKey, list] of Object.entries(raw.timeline)) {
      if (isDangerousKey(chapterKey) || !Array.isArray(list)) continue;
      timeline[chapterKey] = list.filter(
        (t): t is StoredTimelineEntry =>
          isObj(t) && typeof t.id === 'string' && typeof t.eventKind === 'string' && EVENT_KINDS.has(t.eventKind),
      );
    }
  }

  return { schema: 1, fileId, rev, pending: [...byChapter.values()], dismissed, acceptedSelections, timeline };
}

/** An entry's `chapterId` is positional: a merge/split/reorder renumbers chapters, so after a restructure
    whose drop failed (best-effort) the id can name a DIFFERENT chapter, or the same chapter re-rendered
    (a merge survivor), whose `.previous.*` is not the A side this entry was recorded against. An entry
    that carries identity stamps is therefore honoured only while the chapter at its id still has the
    same uuid AND render stamp. A legacy / client-written entry carries neither stamp and is kept
    (nothing to compare against; its behaviour is unchanged). */
export function entryMatchesChapter(entry: StoredRevision, chapter: ChapterRef): boolean {
  if (entry.chapterUuid !== undefined && chapter.uuid !== entry.chapterUuid) return false;
  if (entry.renderedAt !== undefined && chapter.audioRenderedAt !== entry.renderedAt) return false;
  return true;
}

export function toRevisionsState(bookId: string, file: RevisionsFile): RevisionsState {
  return {
    bookId,
    fileId: file.fileId,
    rev: file.rev,
    pending: file.pending,
    dismissed: file.dismissed,
    acceptedSelections: file.acceptedSelections,
    timeline: file.timeline,
  };
}

/** Validate an accept request's `selection` (spec §2 Errors, 400). Absent →
    ok/undefined. Keys must be canonical non-negative integers, values 'A'|'B',
    and no prototype-polluting key (script-review-ledger.ts:46-52). */
export function parseSelection(
  raw: unknown,
): { ok: true; value: Selection | undefined } | { ok: false; message: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!isObj(raw)) return { ok: false, message: 'selection must be an object.' };
  const out: Selection = {};
  for (const [k, v] of Object.entries(raw)) {
    if (isDangerousKey(k)) return { ok: false, message: 'selection has a forbidden key.' };
    if (!/^(0|[1-9]\d*)$/.test(k)) return { ok: false, message: `selection key "${k}" is not a segment index.` };
    if (v !== 'A' && v !== 'B') return { ok: false, message: `selection["${k}"] must be "A" or "B".` };
    out[k] = v;
  }
  return { ok: true, value: out };
}

/** null ONLY for a missing file (checked with existsSync — readJson alone
    returns null for both a missing file and a file containing literal `null`).
    THROWS for: unparseable JSON (SyntaxError, as on main); a top level that is
    not a plain object — an array, literal `null`, a string or a number
    (SyntaxError: corrupt, never "missing"); a newer schema
    (UnsupportedSchemaError); and any read error (EISDIR, EBUSY…). So no write
    can follow a bad read and overwrite the original. */
async function loadRaw(bookDir: string): Promise<Record<string, unknown> | null> {
  const path = revisionsJsonPath(bookDir);
  if (!existsSync(path)) return null;
  const raw = await readJson<unknown>(path);
  if (!isObj(raw)) throw new SyntaxError('revisions.json: expected a JSON object at the top level');
  return migrateSeamDoc(REVISIONS_SEAM, raw).doc;
}

/** state.json's chapters as they are on disk now; [] when it is missing, unreadable or malformed
    (the snapshot alone then decides, as before). */
async function readLiveChapters(bookDir: string): Promise<ChapterRef[]> {
  try {
    const path = stateJsonPath(bookDir);
    if (!existsSync(path)) return [];
    const state = await readJson<{ chapters?: unknown }>(path);
    return Array.isArray(state?.chapters) ? (state.chapters as ChapterRef[]) : [];
  } catch {
    return [];
  }
}

async function load(bookDir: string, chapters: readonly ChapterRef[]): Promise<RevisionsFile> {
  return (await loadWithStored(bookDir, chapters)).file;
}

/** `file` is the normalised view (legacy entries kept only while `.previous.mp3`
    exists). `stored` is the same normalisation WITHOUT that `.previous` filter —
    the entries as stored. commitRevisionOp looks its own entry up there: the
    op's audio step has by then consumed `.previous`, which would otherwise make
    a legacy entry (every pending entry in production today) look gone. */
async function loadWithStored(
  bookDir: string,
  chapters: readonly ChapterRef[],
): Promise<{ file: RevisionsFile; stored: RevisionsFile }> {
  const slugById = new Map(chapters.map((c) => [c.id, c.slug] as const));
  const root = audioDir(bookDir);
  const raw = await loadRaw(bookDir);
  const normalised = normaliseRevisions(raw, (chapterId) => {
    const slug = slugById.get(chapterId);
    return slug !== undefined && previousAudioExists(root, slug);
  });
  /* A stamped entry whose chapter no longer sits at its id is invisible to every read and op (begin
     answers not-found) and falls off the file at the next write. A missing chapter is left to
     beginRevisionOp's own branch. */
  const chapterById = new Map(chapters.map((c) => [c.id, c] as const));
  /* The caller's snapshot can be stale: finalize passes the state.json it read before its own
     write, and a sibling chapter's finalize (it stamps state.json BEFORE recording its entry) may
     have landed since. An entry the snapshot refuses is therefore also checked against state.json as
     it is now (read here, under the revisions lock for every writer; no other lock is taken), and
     only dropped when that refuses it too. */
  const live = new Map((await readLiveChapters(bookDir)).map((c) => [c.id, c] as const));
  const file: RevisionsFile = {
    ...normalised,
    pending: normalised.pending.filter((p) => {
      const chapter = chapterById.get(p.chapterId);
      if (chapter === undefined || entryMatchesChapter(p, chapter)) return true;
      const current = live.get(p.chapterId);
      return current !== undefined && entryMatchesChapter(p, current);
    }),
  };
  return { file, stored: normaliseRevisions(raw, () => true) };
}

async function writeStamped(bookDir: string, file: RevisionsFile): Promise<void> {
  await writeJsonAtomic(revisionsJsonPath(bookDir), stampSeamSchema(REVISIONS_SEAM, { ...file } as Record<string, unknown>));
}

async function save(bookDir: string, file: RevisionsFile): Promise<RevisionsFile> {
  const next: RevisionsFile = { ...file, schema: 1, fileId: file.fileId ?? mintFileId(), rev: file.rev + 1 };
  await writeStamped(bookDir, next);
  return next;
}

export async function readRevisions(bookDir: string, chapters: readonly ChapterRef[]): Promise<RevisionsFile> {
  return load(bookDir, chapters);
}

/** Plan 286 — lock-free: does the normalised view hold a pending entry for
    this chapter? restore-unrecorded's check-then-act guard (spec §4: a guard
    against the common case, not a fence). */
export async function hasPendingForChapter(
  bookDir: string,
  chapters: readonly ChapterRef[],
  chapterId: number,
): Promise<boolean> {
  return (await load(bookDir, chapters)).pending.some((p) => p.chapterId === chapterId);
}

/** Preflight for reparse / replace, run BEFORE they delete anything (lock-free
    read). A reset discards the contents, so a corrupt or missing file is fine
    to reset; only a NEWER-schema file must be refused (never downgraded). */
export async function assertRevisionsResettable(bookDir: string): Promise<void> {
  try {
    await loadRaw(bookDir);
  } catch (err) {
    if (err instanceof UnsupportedSchemaError) throw err;
  }
}

export async function resetRevisions(bookDir: string): Promise<RevisionsFile> {
  return withKeyLock(revisionsLockKey(bookDir), async () => {
    /* Re-checked under the lock (the preflight ran lock-free, earlier). */
    await assertRevisionsResettable(bookDir);
    const next = emptyRevisionsFile(mintFileId());
    await writeStamped(bookDir, next);
    return next;
  });
}

export async function recordPending(
  bookDir: string,
  chapters: readonly ChapterRef[],
  entry: StoredRevision,
): Promise<RevisionsFile> {
  return withKeyLock(revisionsLockKey(bookDir), async () => {
    const file = await load(bookDir, chapters);
    const pending = [...file.pending.filter((p) => p.chapterId !== entry.chapterId), entry];
    return save(bookDir, { ...file, pending });
  });
}

export async function dropPendingForChapter(
  bookDir: string,
  chapters: readonly ChapterRef[],
  chapterId: number,
): Promise<RevisionsFile> {
  return withKeyLock(revisionsLockKey(bookDir), async () => {
    const file = await load(bookDir, chapters);
    if (!file.pending.some((p) => p.chapterId === chapterId)) return file;
    return save(bookDir, { ...file, pending: file.pending.filter((p) => p.chapterId !== chapterId) });
  });
}

/** Plan 286 — drop pending entries for several chapters a restructure
    touched, in one write under the revisions lock. No-op (no write) when
    none of the ids match. */
export async function dropPendingForChapters(
  bookDir: string,
  chapters: readonly ChapterRef[],
  chapterIds: readonly number[],
): Promise<RevisionsFile> {
  return withKeyLock(revisionsLockKey(bookDir), async () => {
    const file = await load(bookDir, chapters);
    const ids = new Set(chapterIds);
    if (!file.pending.some((p) => ids.has(p.chapterId))) return file;
    return save(bookDir, { ...file, pending: file.pending.filter((p) => !ids.has(p.chapterId)) });
  });
}

export async function dismissDriftId(
  bookDir: string,
  chapters: readonly ChapterRef[],
  driftId: string,
): Promise<RevisionsFile> {
  return withKeyLock(revisionsLockKey(bookDir), async () => {
    const file = await load(bookDir, chapters);
    if (file.dismissed.includes(driftId)) return file;
    return save(bookDir, { ...file, dismissed: [...file.dismissed, driftId] });
  });
}

/* ── Two-phase accept / reject (spec §2) ───────────────────────────────────
   beginRevisionOp (step 1, under the lock) → the caller's audio step (step 2,
   OUTSIDE the lock) → commitRevisionOp (step 3, under the lock; re-reads and
   writes only if the entry is still pending). */

export type RevisionOpKind = 'accept' | 'reject';

export type BeginResult =
  | { kind: 'proceed'; entry: StoredRevision; chapter: ChapterRef; file: RevisionsFile }
  | { kind: 'already-done'; file: RevisionsFile }
  | { kind: 'not-found'; file: RevisionsFile };

export type CommitResult =
  | { kind: 'committed'; file: RevisionsFile }
  | { kind: 'already-done'; file: RevisionsFile }
  | { kind: 'gone'; file: RevisionsFile };

/** Idempotence keys on TimelineEntry.id === revisionId (revisions-slice.ts:170-178);
    the schema's own `revisionId` field means "rollback target" and is not it. */
function hasOutcome(file: RevisionsFile, op: RevisionOpKind, revisionId: string): boolean {
  const kind = op === 'accept' ? 'accepted' : 'rejected';
  return Object.values(file.timeline).some((list) => list.some((t) => t.id === revisionId && t.eventKind === kind));
}

/** The timeline's reversible-chain rule (mirrored by src/mocks/mock-revisions.ts): a
    new reversible entry flips every prior entry on the chapter to non-reversible. */
function appendTimelineEntry(
  timeline: Record<string, StoredTimelineEntry[]>,
  entry: StoredTimelineEntry,
): Record<string, StoredTimelineEntry[]> {
  const key = String(entry.chapterId);
  const prior = (timeline[key] ?? []).map((t) => (entry.reversible ? { ...t, reversible: false } : t));
  return { ...timeline, [key]: [...prior, entry] };
}

/** Spec §2 step 1. */
export async function beginRevisionOp(
  bookDir: string,
  chapters: readonly ChapterRef[],
  op: RevisionOpKind,
  revisionId: string,
): Promise<BeginResult> {
  return withKeyLock(revisionsLockKey(bookDir), async () => {
    const file = await load(bookDir, chapters);
    const entry = isDangerousKey(revisionId) ? undefined : file.pending.find((p) => p.id === revisionId);
    if (!entry) {
      return hasOutcome(file, op, revisionId) ? { kind: 'already-done', file } : { kind: 'not-found', file };
    }
    const chapter = chapters.find((c) => c.id === entry.chapterId);
    if (!chapter) {
      /* A restructure whose best-effort drop failed: clear the entry so the
         prompt stops looping, and answer not-found. */
      const next = await save(bookDir, { ...file, pending: file.pending.filter((p) => p.id !== revisionId) });
      return { kind: 'not-found', file: next };
    }
    return { kind: 'proceed', entry, chapter: { id: chapter.id, slug: chapter.slug }, file };
  });
}

/** Spec §2 step 3. Writes ONLY when the entry is still pending. */
export async function commitRevisionOp(
  bookDir: string,
  chapters: readonly ChapterRef[],
  op: RevisionOpKind,
  revisionId: string,
  selection?: Selection,
): Promise<CommitResult> {
  return withKeyLock(revisionsLockKey(bookDir), async () => {
    const { file, stored } = await loadWithStored(bookDir, chapters);
    /* Either view: `stored` finds a legacy entry whose `.previous.mp3` the op
       consumed; `file` finds a server entry that a later legacy entry for the
       same chapter shadows in `stored` (begin saw it through `file`). */
    const entry = isDangerousKey(revisionId)
      ? undefined
      : (stored.pending.find((p) => p.id === revisionId) ?? file.pending.find((p) => p.id === revisionId));
    if (!entry) {
      return hasOutcome(file, op, revisionId) ? { kind: 'already-done', file } : { kind: 'gone', file };
    }
    const timeline = appendTimelineEntry(file.timeline, {
      id: revisionId,
      chapterId: entry.chapterId,
      characterId: entry.characterId,
      eventKind: op === 'accept' ? 'accepted' : 'rejected',
      timestamp: new Date().toISOString(),
      status: 'active',
      reversible: true,
    });
    const acceptedSelections =
      op === 'accept' ? { ...file.acceptedSelections, [revisionId]: selection ?? {} } : file.acceptedSelections;
    const next = await save(bookDir, {
      ...file,
      pending: file.pending.filter((p) => p.id !== revisionId),
      timeline,
      acceptedSelections,
    });
    return { kind: 'committed', file: next };
  });
}

/** Plan 286 (invariant 8) — the text a whole-request 500 may show for a
    store failure: UnsupportedSchemaError's own fixed "upgrade" sentence, or
    the caller's fixed fallback. Never an fs error's message (it embeds the
    absolute workspace path). */
export function revisionsFailureText(err: unknown, fallback: string): string {
  return err instanceof UnsupportedSchemaError ? err.message : fallback;
}

