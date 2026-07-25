/* Ephemeral holding area for an ingested-but-not-yet-cloned voice sample
   (spec §4.2 phase 1). Lives under <voiceLibraryDir>/_candidates/<id>/; 3b1's
   POST /clone reads it and promotes master.wav into the real entry dir. In 3a it
   has no consumer — that is the disclosed behind-flag state. */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { voiceLibraryDir } from './voice-library.js';
import { safeSegment, assertContained, sanitizeIdSegment } from '../util/safe-path.js';
import type { VoiceLibraryEntry } from './voice-library.js';

export type VoiceMaster = NonNullable<VoiceLibraryEntry['master']>;
export type CloneCandidateMaster = Omit<VoiceMaster, 'clipFile'>;
export interface CloneCandidate {
  candidateId: string;
  master: VoiceMaster;
}

function candidatesRoot(): string {
  return join(voiceLibraryDir(), '_candidates');
}
export function candidateDir(candidateId: string): string {
  const root = candidatesRoot();
  const dir = join(root, sanitizeIdSegment(safeSegment(candidateId)));
  assertContained(root, dir);
  return dir;
}
export function candidateMasterPath(candidateId: string): string {
  return join(candidateDir(candidateId), 'master.wav');
}
function candidateJsonPath(candidateId: string): string {
  return join(candidateDir(candidateId), 'candidate.json');
}

export async function writeCandidate(candidateId: string, master: CloneCandidateMaster, wav: Buffer): Promise<void> {
  const dir = candidateDir(candidateId);
  await mkdir(dir, { recursive: true });
  await writeFile(candidateMasterPath(candidateId), wav);
  const full: VoiceMaster = { ...master, clipFile: 'master.wav' };
  await writeFile(candidateJsonPath(candidateId), JSON.stringify(full, null, 2), 'utf8');
}

export async function readCandidate(candidateId: string): Promise<CloneCandidate | null> {
  const p = candidateJsonPath(candidateId);
  if (!existsSync(p)) return null;
  try {
    const master = JSON.parse(await readFile(p, 'utf8')) as VoiceMaster;
    return { candidateId, master };
  } catch {
    return null;
  }
}

export async function removeCandidate(candidateId: string): Promise<void> {
  await rm(candidateDir(candidateId), { recursive: true, force: true });
}
