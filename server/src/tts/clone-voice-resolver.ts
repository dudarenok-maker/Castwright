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
   constructor; the finer-grained reasons are for T5's classifier.
   `wrong-engine` (Task 6b) is distinct from `engine-unavailable`: it fires
   when the CHARACTER simply doesn't route to Qwen at all this run (e.g. a
   cloned voice assigned on a Kokoro-default book) — Qwen itself may be
   perfectly healthy, so lumping this under `engine-unavailable`'s "re-enable
   Qwen" messaging would misdiagnose the fix. */
export interface BrokenClonedVoice {
  name: string;
  reason:
    | 'revoked'
    | 'missing-master'
    | 'engine-unavailable'
    | 'derive-failed'
    | 'misconfigured'
    | 'wrong-engine';
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
     characters whose cloned voice couldn't be resolved this run. Task 6b —
     the trailing remedy sentence is reason-aware: `wrong-engine` gets its
     own accurate copy (the fix is switching the BOOK's engine, not Qwen's
     availability) instead of being folded into the "Re-enable Qwen…"
     catch-all, which would misdiagnose a perfectly healthy Qwen. */
  static fromList(broken: BrokenClonedVoice[]): UnresolvableClonedVoiceError {
    if (broken.length === 0) {
      const e = new UnresolvableClonedVoiceError('');
      return Object.assign(e, {
        message: 'Cloned voice(s) unavailable — a cloned voice must never be substituted with another.',
        broken: [],
      });
    }
    const hasWrongEngine = broken.some((b) => b.reason === 'wrong-engine');
    const hasOtherReason = broken.some((b) => b.reason !== 'wrong-engine');
    const remedies: string[] = [];
    if (hasOtherReason) {
      remedies.push('Re-enable Qwen, restore the missing voice(s), or reassign the character(s)');
    }
    if (hasWrongEngine) {
      remedies.push(
        'switch the book to Qwen, or reassign the character(s) currently routed to another engine',
      );
    }
    const message =
      `Cloned voice(s) unavailable — a cloned voice must never be substituted with another: ` +
      broken.map((b) => `"${b.name}" (${b.reason})`).join(', ') +
      `. ${remedies.join('; ')}.`;
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
  /** true when this character's effective route is not qwen at all this run
      (e.g. assigned on a Kokoro-default book) — distinct from Qwen itself
      being unavailable; see `BrokenClonedVoice`'s `wrong-engine` reason. */
  wrongEngine: boolean;
  /** true when the character DOES route to qwen, but qwen is unavailable this run. */
  engineUnavailable: boolean;
  /** result of stat()-ing voices/qwen/qwen-<uuid>.pt */
  ptExists: boolean;
  /** currentQwenBaseModel() snapshot */
  currentBaseModel: string;
}

/* Pure — no fs, no async. Order matters: revoked beats every other reason
   (a revoked person's .pt surviving on disk must never read as merely
   "repairable"); within the engine-problem tier, wrongEngine is checked
   FIRST (Task 6b) since it's the more specific diagnosis — a character that
   doesn't route to qwen at all is not the same failure as qwen itself being
   unreachable, and reporting the wrong one misdirects the fix. engine-
   unavailable then beats a stale/missing .pt, and a persisted 'failed'
   status is terminal (never silently retried here — a retry has to come
   from a fresh derive attempt that clears it). */
export function classifyClonedVoice(input: ClassifyInput): ClonedVoiceClassification {
  const { entry, wrongEngine, engineUnavailable, ptExists, currentBaseModel } = input;
  if (entry.consent?.revokedAt) return { state: 'broken', reason: 'revoked' };
  if (wrongEngine) return { state: 'broken', reason: 'wrong-engine' };
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
  /** true when this character's effective route is not qwen at all this run. */
  wrongEngine: boolean;
  /** true when the character DOES route to qwen, but qwen is unavailable this run. */
  engineUnavailable: boolean;
}

/** A thrown error's numeric transport status, if present (SidecarDesignError
    and similar shapes carry `.status`). Permanent is EXACTLY a 4xx (the
    sidecar rejected the clip itself) — everything else, including 0, <400,
    >=500, and a thrown error with no numeric status at all, is treated as
    transient. This errs toward fail-loud (retryable) rather than toward
    silently bricking the voice on an unrecognised failure shape. */
function isTransientDeriveFailure(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status !== 'number') return true;
  return !(status >= 400 && status < 500);
}

/** For each requested cloned voice: classify, derive Repairable, collect Broken.
 *  Throws UnresolvableClonedVoiceError with the full Broken list if any is Broken. */
export async function resolveClonedVoicesForChapter(
  requests: ClonedVoiceRequest[],
  deps: ResolveChapterDeps,
): Promise<void> {
  const broken: BrokenClonedVoice[] = [];

  for (const request of requests) {
    const { characterName, libraryUuid, wrongEngine, engineUnavailable } = request;

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
      wrongEngine,
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
