/* fs-38 Wave 3b2 — the cloned-voice resolver. T4 lays the module's
   foundation: the `BrokenClonedVoice` shape and `UnresolvableClonedVoiceError`
   (moved here from synthesise-chapter.ts, which re-exports it, to avoid an
   import cycle — synthesiseChapter will import this module's resolver, and
   the resolver needs this error). T5 adds the classifier + async
   orchestrator (`resolveClonedVoicesForChapter`) on top. */

import type { VoiceLibraryEntry } from '../workspace/voice-library.js';
import type { deriveEngineArtifact } from './derive-engine-artifact.js';

/* Why a cloned voice can't be used this run. `engine-unavailable` is the
   coarse 3b1 reason (Qwen unreachable) preserved for the legacy single-name
   constructor; the finer-grained reasons are for T5's classifier. */
export interface BrokenClonedVoice {
  name: string;
  reason: 'revoked' | 'missing-master' | 'engine-unavailable' | 'derive-failed' | 'misconfigured';
}

/* fs-38 Wave 3b1 (C1) — a cloned-provenance Qwen group must never be silently
   substituted. When Qwen is unavailable this run, applyQwenFallback raises this
   instead of rerouting to Kokoro/Coqui — a real person's voice is never swapped
   for another. 3b2's resolver reuses this same typed error, now carrying a
   structured `broken` list so a multi-character resolver pre-pass (T5) can
   report every unresolvable voice in one throw instead of failing character
   by character. */
export class UnresolvableClonedVoiceError extends Error {
  readonly broken: BrokenClonedVoice[];

  constructor(characterName: string, detail?: string) {
    super(
      `Cloned voice for "${characterName}" is unavailable — the Qwen engine is not available this ` +
        `run, and a cloned voice must never be substituted with another. Re-enable Qwen or reassign ` +
        `the character.` +
        (detail ? ` ${detail}` : ''),
    );
    this.name = 'UnresolvableClonedVoiceError';
    this.broken = [{ name: characterName, reason: 'engine-unavailable' }];
  }

  /* Pre-pass entry point (T5): build one error from the full set of
     characters whose cloned voice couldn't be resolved this run. */
  static fromList(broken: BrokenClonedVoice[]): UnresolvableClonedVoiceError {
    const message =
      broken.length === 0
        ? 'Cloned voice(s) unavailable — a cloned voice must never be substituted with another.'
        : `Cloned voice(s) unavailable — a cloned voice must never be substituted with another: ` +
          broken.map((b) => `"${b.name}" (${b.reason})`).join(', ') +
          `. Re-enable Qwen, restore the missing voice(s), or reassign the character(s).`;
    const e = new UnresolvableClonedVoiceError(broken[0]?.name ?? '');
    return Object.assign(e, { message, broken: [...broken] });
  }
}

/* --- T5: classifier + async orchestrator --------------------------------- */

export type ClonedVoiceState = 'healthy' | 'repairable' | 'broken';

export interface ClonedVoiceClassification {
  state: ClonedVoiceState;
  /** Present when state==='broken' — user-facing reason. */
  reason?: BrokenClonedVoice['reason'];
}

export interface ClassifyInput {
  entry: VoiceLibraryEntry;
  /** true when this character's effective route is not qwen, or qwen is unavailable this run. */
  engineUnavailable: boolean;
  /** result of stat()-ing voices/qwen/qwen-<uuid>.pt */
  ptExists: boolean;
  /** currentQwenBaseModel() snapshot */
  currentBaseModel: string;
}

/* Pure — no fs, no async. Order matters: revoked beats every other reason
   (a revoked person's .pt surviving on disk must never read as merely
   "repairable"), engine-unavailable beats a stale/missing .pt, and a
   persisted 'failed' status is terminal (never silently retried here — a
   retry has to come from a fresh derive attempt that clears it). */
export function classifyClonedVoice(input: ClassifyInput): ClonedVoiceClassification {
  const { entry, engineUnavailable, ptExists, currentBaseModel } = input;
  if (entry.consent?.revokedAt) return { state: 'broken', reason: 'revoked' };
  if (engineUnavailable) return { state: 'broken', reason: 'engine-unavailable' };
  const qwen = entry.engines.qwen;
  if (qwen?.status === 'failed') return { state: 'broken', reason: 'derive-failed' };
  const needsDerive =
    !ptExists ||
    (Boolean(qwen?.baseModel) && qwen?.baseModel !== currentBaseModel) ||
    qwen?.status === 'stale';
  if (needsDerive) {
    return entry.master ? { state: 'repairable' } : { state: 'broken', reason: 'missing-master' };
  }
  return { state: 'healthy' };
}

export interface ResolveChapterDeps {
  readEntry(uuid: string): Promise<VoiceLibraryEntry | null>;
  writeEntry(entry: VoiceLibraryEntry): Promise<void>;
  ptExists(storageKey: string): Promise<boolean>;
  deriveEngineArtifact: typeof deriveEngineArtifact;
  readMasterPcm(
    uuid: string,
    entry: VoiceLibraryEntry,
  ): Promise<{ pcm: Buffer; sampleRate: number; refText: string }>;
  currentBaseModel(): string;
  reportProgress?(msg: string): void;
  signal?: AbortSignal;
}

export interface ClonedVoiceRequest {
  characterName: string;
  libraryUuid: string | undefined;
  engineUnavailable: boolean;
}

/** A thrown error's numeric transport status, if present (SidecarDesignError
    and similar shapes carry `.status`). Anything else — including a thrown
    error with no numeric status at all — is treated as transient (never
    bricks the voice on an unrecognised failure shape). */
function isTransientDeriveFailure(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status !== 'number') return true;
  return status === 0 || status >= 500;
}

/** For each requested cloned voice: classify, derive Repairable, collect Broken.
 *  Throws UnresolvableClonedVoiceError with the full Broken list if any is Broken. */
export async function resolveClonedVoicesForChapter(
  requests: ClonedVoiceRequest[],
  deps: ResolveChapterDeps,
): Promise<void> {
  const broken: BrokenClonedVoice[] = [];

  for (const request of requests) {
    const { characterName, libraryUuid, engineUnavailable } = request;

    if (!libraryUuid) {
      broken.push({ name: characterName, reason: 'misconfigured' });
      continue;
    }

    const entry = await deps.readEntry(libraryUuid);
    if (!entry) {
      broken.push({ name: characterName, reason: 'misconfigured' });
      continue;
    }

    const currentBaseModel = deps.currentBaseModel();
    const ptExists = await deps.ptExists(`qwen-${libraryUuid}`);
    const classification = classifyClonedVoice({
      entry,
      engineUnavailable,
      ptExists,
      currentBaseModel,
    });

    if (classification.state === 'healthy') continue;

    if (classification.state === 'broken') {
      broken.push({ name: characterName, reason: classification.reason! });
      continue;
    }

    // repairable — re-derive from the retained master.wav.
    deps.reportProgress?.(`Preparing voice "${characterName}"…`);
    try {
      const { pcm, sampleRate, refText } = await deps.readMasterPcm(libraryUuid, entry);
      await deps.deriveEngineArtifact(
        libraryUuid,
        'qwen',
        { masterPcm: pcm, sampleRate, refText },
        { signal: deps.signal },
      );
      await deps.writeEntry({
        ...entry,
        engines: {
          ...entry.engines,
          qwen: { ...entry.engines.qwen, status: 'ready', baseModel: currentBaseModel },
        },
      });
    } catch (err) {
      if (isTransientDeriveFailure(err)) {
        // Transient (unreachable / 5xx) — do NOT persist 'failed'; a retry
        // must be able to re-attempt (classify rule 3 makes 'failed'
        // terminal, so persisting here would brick the voice on a hiccup).
        broken.push({ name: characterName, reason: 'derive-failed' });
      } else {
        // Permanent (4xx) — the sidecar rejected the clip itself.
        await deps.writeEntry({
          ...entry,
          engines: { ...entry.engines, qwen: { ...entry.engines.qwen, status: 'failed' } },
        });
        broken.push({ name: characterName, reason: 'derive-failed' });
      }
    }
  }

  if (broken.length > 0) throw UnresolvableClonedVoiceError.fromList(broken);
}
