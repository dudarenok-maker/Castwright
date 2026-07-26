/* fs-38 Wave 1, Task 3 — voice-library manifest store.

   Persistence layer for the routes in later tasks: one directory per voice,
   keyed by voiceUuid, holding a `voice.json` manifest —
   `<WORKSPACE_ROOT>/voice-library/<voiceUuid>/voice.json`. Shared across every
   book (workspace-level, like voices/qwen), so callers key everything off
   `voiceUuid` rather than a book.

   The server does NOT consume the generated frontend `src/lib/api-types.ts`,
   so `VoiceLibraryEntry` below is a manual mirror of the openapi.yaml schema
   of the same name — keep field names identical when either side changes. */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { voiceLibraryDir } from './paths.js';
import { safeSegment, assertContained, sanitizeIdSegment } from '../util/safe-path.js';

export { voiceLibraryDir };

export type VoiceProvenance = 'designed' | 'cloned' | 'imported';

export interface VoiceLibraryEngineStatus {
  status: 'ready' | 'deriving' | 'stale' | 'failed';
  baseModel?: string;
  coquiVersion?: string;
  modelId?: string;
}

export interface VoiceLibraryEngines {
  qwen?: VoiceLibraryEngineStatus;
  xtts?: VoiceLibraryEngineStatus;
}

export interface VoiceConsentRecord {
  personName: string;
  relationship: 'self' | 'family-with-permission' | 'guardian-of-minor';
  permittedUse: 'personal';
  attestedAt: string;
  attestedBy: string;
  revokedAt?: string;
}

export interface VoiceSourceAttestation {
  source: string;
  rightsNote: string;
  attestedAt: string;
}

export interface VoiceMaster {
  clipFile: string;
  sampleRate: number;
  durationSeconds: number;
  transcript: string;
  transcriptSource: 'whisper' | 'user';
  captureMethod: 'upload' | 'record';
}

export interface VoiceLibraryEntry {
  voiceUuid: string;
  name: string;
  provenance: VoiceProvenance;
  tags: string[];
  pinned: boolean;
  languageCode?: string;
  /** designed-only instruct text */
  persona?: string;
  consent?: VoiceConsentRecord;
  sourceAttestation?: VoiceSourceAttestation;
  sampleTranscript?: string;
  sampleMeta?: {
    durationSeconds?: number;
    sampleRate?: number;
    qualityChecks?: Record<string, unknown>;
  };
  engines: VoiceLibraryEngines;
  promotedFrom?: { bookId?: string; characterId?: string };
  master?: VoiceMaster;
  createdAt: string;
  updatedAt: string;
}

/** Minimal structural validation — enough to tell "a manifest" from garbage
    without re-deriving the full openapi schema here. */
function isValidEntry(value: unknown): value is VoiceLibraryEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return Boolean(v.voiceUuid && v.name && v.provenance);
}

/** Per-entry directory, contained under voiceLibraryDir(). */
export function entryDir(voiceUuid: string): string {
  const root = voiceLibraryDir();
  const dir = join(root, sanitizeIdSegment(safeSegment(voiceUuid)));
  assertContained(root, dir);
  return dir;
}

function manifestPath(voiceUuid: string): string {
  return join(entryDir(voiceUuid), 'voice.json');
}

/** Read one entry's manifest. Returns null when the manifest is missing,
    unparseable, or fails the minimal structural check. */
export async function readEntry(voiceUuid: string): Promise<VoiceLibraryEntry | null> {
  const p = manifestPath(voiceUuid);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(await readFile(p, 'utf8')) as unknown;
    return isValidEntry(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/* Fix wave (fs-38 Wave 3c, Task 2 review) — the "is this cloned voice
   playable" condition used to be hand-duplicated verbatim in two routes
   (voice-library.ts's own /sample route and voice-sample.ts's cast-view
   route). Two copies of a security check drift; extracted here so both
   call sites share one definition. `entry` may be null/undefined — callers
   that haven't 404'd on a missing entry yet can pass the lookup straight
   through. */
export function clonedVoiceLacksConsent(entry: VoiceLibraryEntry | null | undefined): boolean {
  return Boolean(entry && entry.provenance === 'cloned' && (!entry.consent || entry.consent.revokedAt));
}

export class ConsentRequiredError extends Error {
  status = 422;
  constructor() {
    super('A cloned voice requires a consent record (person, relationship, permitted use, attestation).');
    this.name = 'ConsentRequiredError';
  }
}

/** Structural consent guard for cloned entries — checked at write time,
    independent of `revokedAt` (a revoke write already carries a
    structurally-complete consent block, so it passes this check; the
    revoked state itself is enforced elsewhere, at assign-time). */
function assertConsentForClone(entry: VoiceLibraryEntry): void {
  if (entry.provenance !== 'cloned') return;
  const c = entry.consent;
  const structurallyValid =
    !!c && !!c.personName && !!c.relationship && !!c.permittedUse && !!c.attestedAt && !!c.attestedBy;
  if (!structurallyValid) throw new ConsentRequiredError(); // revokedAt is orthogonal — not checked here
}

/** Write (create or overwrite) one entry's manifest atomically — write
    `voice.json.tmp`, then rename over `voice.json`. Always stamps a fresh
    `updatedAt`. */
export async function writeEntry(entry: VoiceLibraryEntry): Promise<void> {
  assertConsentForClone(entry);
  const stamped: VoiceLibraryEntry = { ...entry, updatedAt: new Date().toISOString() };
  const dir = entryDir(stamped.voiceUuid);
  await mkdir(dir, { recursive: true });
  const finalPath = join(dir, 'voice.json');
  const tmpPath = join(dir, 'voice.json.tmp');
  await writeFile(tmpPath, JSON.stringify(stamped, null, 2), 'utf8');
  await rename(tmpPath, finalPath);
}

/* fs-38 Wave 3c, Task 14 — per-uuid lock closing the voice-library's
   read-modify-write race, not just the write. 3c writes a SECOND,
   independent engine slot (`engines.xtts`) alongside the existing
   `engines.qwen` one, so two concurrent callers reading the same stale
   snapshot and each writing back their own slot is no longer an idempotent
   collision (as it was pre-3c, when both writers touched only `qwen`) — it's
   a silent loss of whichever slot writes first:

     A and B both readEntry() and see {qwen: stale}. A finishes deriving xtts
     and writes {qwen: stale, xtts: ready}. B, still holding its OWN stale
     pre-derive snapshot, then writes {qwen: ready} — the xtts slot A just
     wrote is gone, clobbered by B's write of a snapshot that predates it.

   A mutex around ONLY the final `writeEntry` call does not close this: it
   would just serialize two ALREADY-STALE snapshots one after the other, and
   the second write still overwrites the first caller's change — B's write
   still doesn't know about A's xtts slot, lock or no lock, because B took
   its snapshot before A ever wrote. The critical section has to be the
   WHOLE span — fresh read, mutate, write — not the write alone.

   `withEntryLock` is a per-voiceUuid promise-chain mutex: different uuids
   never block each other, and a caller queued behind another for the SAME
   uuid only starts its own body once the prior one's fully settled (success
   OR failure — a thrown mutate can't wedge the queue for that uuid). Built
   on the "each successive .then() is the next queue slot" pattern rather
   than any lock library, since Node is single-threaded and the only thing
   that needs serializing is which `fn` gets to run next for a given uuid.

   `updateEntry` is the shared read-modify-write primitive every caller that
   reads this store, mutates its own copy, and writes it back should route
   through: it holds the lock across a FRESH readEntry, the caller's
   `mutate`, and (when `mutate` doesn't opt out by returning null/undefined)
   the writeEntry — then returns the canonical post-write record. `mutate`
   receives `null` when the entry is missing so a caller can still run a
   side effect (e.g. re-purging orphaned artifacts) under the same lock
   before declining to write.

   Cross-process (two separate `node` server processes sharing one
   workspace) stays out of scope — this is an in-process, single-Node-
   instance lock, same scope carve-out as #1826 (the 3b2 lost-update-is-
   idempotent case this task supersedes). */
const entryLocks = new Map<string, Promise<void>>();

async function withEntryLock<T>(voiceUuid: string, fn: () => Promise<T>): Promise<T> {
  const previous = entryLocks.get(voiceUuid) ?? Promise.resolve();
  const result = previous.then(fn);
  // The chain link stored in the map must never reject — a rejection there
  // would propagate into the NEXT queued caller's `previous.then(fn)` as an
  // onRejected call, which happens to still work (fn ignores the reason
  // argument) but is fragile to rely on. Swallow it explicitly instead, and
  // let `result` (returned to THIS caller) carry the real rejection.
  const settled: Promise<void> = result.then(
    () => undefined,
    () => undefined,
  );
  entryLocks.set(voiceUuid, settled);
  // Best-effort cleanup so a uuid that's gone quiet doesn't sit in the map
  // forever — only delete if nobody queued behind us in the meantime.
  settled.finally(() => {
    if (entryLocks.get(voiceUuid) === settled) entryLocks.delete(voiceUuid);
  });
  return result;
}

/** The shared read-modify-write primitive (see the module comment above for
    why a write-only mutex doesn't close the race this closes). `mutate` runs
    under the per-uuid lock, is handed the FRESH entry (or `null` if none
    exists), and may itself be async — including running its own side
    effects (e.g. purging artifacts) before deciding whether to write.
    Returning `null`/`undefined` from `mutate` skips the write entirely
    (still under the lock) and this resolves to `null`. Returning an entry
    writes it and resolves to the canonical post-write record (re-read, so
    the caller sees `writeEntry`'s own fresh `updatedAt` stamp — mirroring
    every existing call site's writeEntry-then-readEntry convention). */
export async function updateEntry(
  voiceUuid: string,
  mutate: (
    entry: VoiceLibraryEntry | null,
  ) => Promise<VoiceLibraryEntry | null | undefined> | VoiceLibraryEntry | null | undefined,
): Promise<VoiceLibraryEntry | null> {
  return withEntryLock(voiceUuid, async () => {
    const entry = await readEntry(voiceUuid);
    const next = await mutate(entry);
    if (!next) return null;
    await writeEntry(next);
    return readEntry(voiceUuid);
  });
}

/** List every valid entry in the library. A directory whose manifest is
    missing, unparseable, or structurally invalid is skipped (with a
    console.warn) rather than failing the whole listing. */
export async function listEntries(): Promise<VoiceLibraryEntry[]> {
  const root = voiceLibraryDir();
  if (!existsSync(root)) return [];
  const names = await readdir(root);
  const out: VoiceLibraryEntry[] = [];
  for (const name of names) {
    try {
      const raw = await readFile(join(entryDir(name), 'voice.json'), 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (isValidEntry(parsed)) {
        out.push(parsed);
      } else {
        console.warn(`[voice-library] skipping invalid manifest in "${name}"`);
      }
    } catch (err) {
      console.warn(`[voice-library] skipping unparseable manifest in "${name}":`, err);
    }
  }
  return out;
}

/** Delete an entry's whole directory (manifest + any sidecar assets). */
export async function removeEntryDir(voiceUuid: string): Promise<void> {
  await rm(entryDir(voiceUuid), { recursive: true, force: true });
}
