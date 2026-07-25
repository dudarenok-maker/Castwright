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

/** Write (create or overwrite) one entry's manifest atomically — write
    `voice.json.tmp`, then rename over `voice.json`. Always stamps a fresh
    `updatedAt`. */
export async function writeEntry(entry: VoiceLibraryEntry): Promise<void> {
  const stamped: VoiceLibraryEntry = { ...entry, updatedAt: new Date().toISOString() };
  const dir = entryDir(stamped.voiceUuid);
  await mkdir(dir, { recursive: true });
  const finalPath = join(dir, 'voice.json');
  const tmpPath = join(dir, 'voice.json.tmp');
  await writeFile(tmpPath, JSON.stringify(stamped, null, 2), 'utf8');
  await rename(tmpPath, finalPath);
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
