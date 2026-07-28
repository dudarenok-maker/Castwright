/* fs-38 Wave 3b2 — the cloned-voice resolver. T4 lays the module's
   foundation: the `BrokenClonedVoice` shape and `UnresolvableClonedVoiceError`
   (moved here from synthesise-chapter.ts, which re-exports it, to avoid an
   import cycle — synthesiseChapter will import this module's resolver, and
   the resolver needs this error). T5 adds the classifier + async
   orchestrator (`resolveClonedVoicesForChapter`) on top. */

import type { VoiceLibraryEntry, VoiceLibraryEngineStatus } from '../workspace/voice-library.js';
import type { deriveEngineArtifact } from './derive-engine-artifact.js';
import { currentQwenBaseModel } from './model-paths.js';
// Review C-1 — type-only: this module's whole design is injected deps for
// testability, so the REAL purgeCloneArtifacts is wired in by the caller
// (synthesise-chapter.ts's buildDefaultCloneResolverDeps), never imported
// here at runtime.
import type { purgeCloneArtifacts } from '../workspace/purge-clone-artifacts.js';
// fs-38 Wave 3c, Task 18 — the shared clone vocabulary: manifestSlotFor/
// cloneStorageKey so this module never re-derives them locally (a rejected
// pattern earlier on this branch — see Task 15's review), and the shared
// isArtifactVersionStale comparand so the classifier and
// routes/voice-library.ts's withComputedStaleness can never drift on what
// "stale" means.
import { manifestSlotFor, cloneStorageKey, isArtifactVersionStale, type CloneEngine } from './clone-engines.js';

/* Review I1 — a repair-path derive (below, both the cloned and the designed
   orchestrator) only needs the sidecar to write the `.pt`; the `previewPcm`
   `deriveEngineArtifact` returns is discarded immediately by both callers.
   Left without an `auditionText`, the sidecar falls back to the caller's
   FULL `ref_text` (the whisper transcript, up to 60s of audio) and
   synthesises that just to build a preview nobody uses — real GPU time
   inside the sidecar's `_synth_lock`, on the hot path, on every Repairable
   resolve. A short fixed line sidesteps that fallback entirely; the words
   don't matter since the audio is thrown away. `/clone`'s own derive call
   (routes/voice-library.ts) is untouched — it genuinely uses `previewPcm`
   for ECAPA scoring + the wizard audition, so it keeps voicing the real
   ref_text/calibration line. */
export const REPAIR_AUDITION_TEXT = 'Voice check.';

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
  /** fs-38 Wave 3c, Task 18 — which engine this voice was being resolved on,
      set ONLY for `reason: 'engine-unavailable'` (the one reason whose
      remedy text below actually names an engine). Left unset for every
      other reason so `toEqual` against a pre-3c literal (no `engine` key)
      still matches — `toEqual` treats a missing key and an explicit
      `undefined` the same way. */
  engine?: CloneEngine;
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
     catch-all, which would misdiagnose a perfectly healthy Qwen.

     M-4 (review) — both remedy clauses used to end with their own
     near-identical "reassign the character(s)" tail. Say it once, at the
     end, shared by every case, instead of repeating it per-reason. */
  static fromList(broken: BrokenClonedVoice[]): UnresolvableClonedVoiceError {
    if (broken.length === 0) {
      const e = new UnresolvableClonedVoiceError('');
      return Object.assign(e, {
        message:
          'Cloned voice(s) unavailable — a cloned voice must never be substituted with another.',
        broken: [],
      });
    }
    const hasWrongEngine = broken.some((b) => b.reason === 'wrong-engine');
    const hasOtherReason = broken.some((b) => b.reason !== 'wrong-engine');
    const remedies: string[] = [];
    if (hasOtherReason) {
      /* Task 18 — engine-aware remedy: name whichever engine(s) were
         actually reported unavailable ('engine-unavailable' is the only
         reason `engine` is set for — see BrokenClonedVoice's doc comment)
         instead of hardcoding "Qwen", which misdiagnoses a broken-on-coqui
         voice. Falls back to 'Qwen' when no `engine`-carrying entry is
         present (the pre-3c shape: revoked/missing-master/etc. with no
         engine-unavailable entries at all, or the legacy single-name
         constructor's un-engine-tagged item) — byte-identical to the old
         hardcoded text for that case. */
      const unavailableEngines = new Set(
        broken.filter((b) => b.reason === 'engine-unavailable').map((b) => b.engine ?? 'qwen'),
      );
      const engineLabel =
        [...unavailableEngines]
          .map((e) => (e === 'coqui' ? 'Coqui' : 'Qwen'))
          .join(' or ') || 'Qwen';
      remedies.push(`Re-enable ${engineLabel} or restore the missing voice(s)`);
    }
    if (hasWrongEngine) {
      remedies.push('switch the book to Qwen');
    }
    remedies.push('reassign the character(s)');
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
  /** fs-38 Wave 3c, Task 18 — which clone-capable engine this voice is being
      resolved on this run. Selects both the manifest slot read
      (`entry.engines[manifestSlotFor(engine)]`) and which stamped version
      field is the staleness comparand (`baseModel` for qwen, `coquiVersion`
      for coqui). */
  engine: CloneEngine;
  /** true when this character's effective route is not this engine at all
      this run (e.g. a qwen-cloned voice assigned on a Coqui-default book) —
      distinct from the engine itself being unavailable; see
      `BrokenClonedVoice`'s `wrong-engine` reason. */
  wrongEngine: boolean;
  /** true when the character DOES route to `engine`, but `engine` is unavailable this run. */
  engineUnavailable: boolean;
  /** result of stat()-ing the engine's storage key (`cloneStorageKey(engine, uuid)`) */
  ptExists: boolean;
  /** fs-38 Wave 3c, Task 18 (rename of `currentBaseModel`) — the engine's
      current expected artifact-version snapshot: `currentQwenBaseModel()`
      for qwen; for coqui, no live "installed coqui-tts version" oracle
      exists yet, so this is `''` in production (see
      `isArtifactVersionStale`'s doc comment in clone-engines.ts for why an
      empty/unknown value on EITHER side of the comparison reads as "not
      stale" rather than forcing a derive). */
  currentArtifactVersion: string;
}

/* Pure — no fs, no async. Order matters: revoked beats every other reason
   (a revoked person's .pt surviving on disk must never read as merely
   "repairable"); within the engine-problem tier, wrongEngine is checked
   FIRST (Task 6b) since it's the more specific diagnosis — a character that
   doesn't route to this engine at all is not the same failure as the engine
   itself being unreachable, and reporting the wrong one misdirects the fix.
   engine-unavailable then beats a stale/missing artifact, and a persisted
   'failed' status is terminal (never silently retried here — a retry has to
   come from a fresh derive attempt that clears it). */
export function classifyClonedVoice(input: ClassifyInput): ClonedVoiceClassification {
  const { entry, engine, wrongEngine, engineUnavailable, ptExists, currentArtifactVersion } = input;
  if (entry.consent?.revokedAt) return { state: 'broken', reason: 'revoked' };
  if (wrongEngine) return { state: 'broken', reason: 'wrong-engine' };
  if (engineUnavailable) return { state: 'broken', reason: 'engine-unavailable' };
  const slot = entry.engines[manifestSlotFor(engine)];
  if (slot?.status === 'failed') return { state: 'broken', reason: 'derive-failed' };
  // M3 (review) — 'deriving' is declared on VoiceLibraryEngineStatus['status']
  // but nothing ever persists it; no branch here handles it intentionally.
  const storedVersion = engine === 'qwen' ? slot?.baseModel : slot?.coquiVersion;
  const needsDerive =
    !ptExists || isArtifactVersionStale(storedVersion, currentArtifactVersion) || slot?.status === 'stale';
  if (needsDerive) {
    return entry.master ? { state: 'repairable' } : { state: 'broken', reason: 'missing-master' };
  }
  return { state: 'healthy' };
}

export interface ResolveChapterDeps {
  readEntry(uuid: string): Promise<VoiceLibraryEntry | null>;
  writeEntry(entry: VoiceLibraryEntry): Promise<void>;
  /** fs-38 Wave 3c, Task 14 — the shared, per-uuid-locked read-modify-write
      primitive (workspace/voice-library.ts's `updateEntry`), injected here
      the same way `readEntry`/`writeEntry` are. The post-derive status
      stamp below routes through THIS, not a bare readEntry+writeEntry pair,
      because the lock has to span the fresh re-read through the write as
      ONE critical section — a mutex around only the write still lets a
      concurrent writer's write use a stale pre-derive snapshot. `mutate`
      returning null/undefined skips the write (still under the lock),
      letting a caller run a side effect (the revoked/gone re-purge below)
      before declining. */
  updateEntry(
    uuid: string,
    mutate: (
      entry: VoiceLibraryEntry | null,
    ) => Promise<VoiceLibraryEntry | null | undefined> | VoiceLibraryEntry | null | undefined,
  ): Promise<VoiceLibraryEntry | null>;
  ptExists(storageKey: string): Promise<boolean>;
  deriveEngineArtifact: typeof deriveEngineArtifact;
  readMasterPcm(
    uuid: string,
    entry: VoiceLibraryEntry,
  ): Promise<{ pcm: Buffer; sampleRate: number; refText: string }>;
  /** fs-38 Wave 3c, Task 18 (rename + parametrize of `currentBaseModel`) —
      see `ClassifyInput.currentArtifactVersion`'s doc comment for what this
      returns per engine and why coqui's is `''` in production today. */
  currentArtifactVersion(engine: CloneEngine): string;
  /** Review C-1 — re-run after a post-derive re-read finds the entry gone or
      revoked, so a `.pt` the sidecar wrote DURING the derive (after an
      in-flight revoke's own purge already ran) doesn't survive it. Same
      function that backs the revoke/delete routes
      (workspace/purge-clone-artifacts.ts) — injected here, not imported
      directly, to keep this module's dependency-injection pattern intact. */
  purgeCloneArtifacts: typeof purgeCloneArtifacts;
  /** #1813 — fired immediately before a Repairable voice's re-derive starts
      (the multi-second sidecar clone-distil round trip), so the caller can
      surface a "Preparing voice" UI phase instead of the SSE going silent.
      Typed payload, no caption string built here — see synthesise-chapter.ts's
      `SynthesiseChapterOpts.onVoicePrepare` doc comment for the full chain. */
  onVoicePrepare?(e: { characterId: string; characterName: string }): void;
  signal?: AbortSignal;
  /** fs-38 Wave 3c, Task 22 fix round 1 (F1/F3) — invoked immediately before
      the FIRST real coqui derive this call issues (never for a healthy or
      broken/skipped request, and never for a qwen derive) — see the call
      site below. Lets synthesise-chapter.ts's pre-pass defer its VRAM-
      freeing sidecar evict until there's genuine coqui derive work to
      protect, instead of evicting for every request that merely EXISTS
      (F3), and lets a failed evict be classified exactly like any other
      derive failure by THIS function's own existing fail-loud policy (F1) —
      no separate try/catch needed at the call site. */
  beforeFirstDerive?(): Promise<void>;
  /** fs-38 Wave 3c, Task 22 fix round 2 [NEW-CRITICAL] — the mirror of
      `beforeFirstDerive`, QWEN side: invoked immediately before the FIRST
      real QWEN derive this call issues (never for a healthy or
      broken/skipped request, and never for a coqui derive). Lets
      synthesise-chapter.ts's pre-pass evict a possibly-resident Coqui
      (freshly derived THIS chapter, OR left resident by an earlier chapter
      in the same run — round 2's "Important" fix removed the THIS-chapter-
      only `coquiEvict.ok` gate) exactly once, with the failure classified
      by THIS function's own existing fail-loud policy — same mechanism as
      `beforeFirstDerive`, just the other direction. */
  beforeFirstQwenDerive?(): Promise<void>;
}

export interface ClonedVoiceRequest {
  characterName: string;
  /** #1813 — the cast character id this request resolves for (both request
      lists synthesise-chapter.ts builds are already derived from
      `CastCharacter`, so this is `c.id`). Carried through to
      `onVoicePrepare`'s payload; never used for classification. */
  characterId: string;
  libraryUuid: string | undefined;
  /** fs-38 Wave 3c, Task 18 — which clone-capable engine this request is
      being resolved on this run. */
  engine: CloneEngine;
  /** true when this character's effective route is not `engine` at all this run. */
  wrongEngine: boolean;
  /** true when the character DOES route to `engine`, but `engine` is unavailable this run. */
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

/** Review I-1 — true for the caller's own abort (the `AbortSignal` this loop
    was given actually fired), whether it surfaced as a named `AbortError` or
    just left `deps.signal.aborted` true. `deriveEngineArtifact`'s fetch
    layer converts EVERY rejection — abort included — into a
    `SidecarDesignError(…, 0)`, so `err.name` alone can't be trusted; the
    signal itself is the ground truth. */
function isAbort(err: unknown, deps: ResolveChapterDeps): boolean {
  return (err as { name?: string } | null)?.name === 'AbortError' || Boolean(deps.signal?.aborted);
}

/** Review I-1 — the error this pre-pass rejects with when it detects an
    abort. Prefers the signal's own `.reason` (a real `AbortError`
    DOMException when `controller.abort()` was called with no argument), then
    falls back to `err` itself when IT already carries the right name (the
    direct-mock-throws-AbortError shape a unit-test harness would use), and
    only synthesizes a fresh one as a last resort. This guarantees callers
    further up the stack — synthesiseChapter's own signal-aborted checks, and
    ultimately `routes/generation.ts`'s `err.name === 'AbortError'` pause
    detector — see a genuine `AbortError` even though `deriveEngineArtifact`
    stripped that identity off the underlying fetch rejection before it ever
    reached this module. Without this, `deps.signal?.aborted` alone (matched
    in `isAbort` above) would correctly SKIP misreporting broken/derive-failed
    here, but the SidecarDesignError this rethrows verbatim would still read
    as a real failure one level up — silently reintroducing the exact
    "Pause reads as a chapter failure" bug this fix exists to close. */
function abortRejection(err: unknown, deps: ResolveChapterDeps): unknown {
  if ((err as { name?: string } | null)?.name === 'AbortError') return err;
  return deps.signal?.reason ?? Object.assign(new Error('Aborted'), { name: 'AbortError' });
}

/** fs-38 Wave 3c, Task 14 — after a derive completes (a real, seconds+ GPU
    op), the voice-library entry may have changed underneath the in-flight
    repair: a revoke can land mid-derive (stamping `consent.revokedAt` and
    purging artifacts) before this write goes out, or the entry can be
    deleted outright. Runs entirely inside `deps.updateEntry`'s per-uuid
    lock, so the fresh read this closure is handed and the write it decides
    on are ONE atomic critical section — not just the write. When gone or
    revoked, this reports the voice Broken/revoked and re-runs the artifact
    purge (still under the lock) so a `.pt` the derive just produced AFTER
    an in-flight revoke's own purge already ran doesn't survive it, and
    returns null so `updateEntry` skips the write. Otherwise returns the
    status-stamped entry to write.

    Previously (pre-Task-14) this only re-read fresh before an UNLOCKED
    write, which closed the seconds-wide GPU-derive window but not the
    millisecond one between that re-read and the write — a second writer
    (e.g. a concurrent PATCH, or another character's repair landing on a
    DIFFERENT engine slot of the same entry) could still read its own stale
    snapshot in that gap and clobber this write. `deps.updateEntry` closes
    that gap by holding the SAME per-uuid lock across the read this function
    does and the write the caller makes from its result. */
function statusStampMutate(
  deps: ResolveChapterDeps,
  libraryUuid: string,
  characterName: string,
  broken: BrokenClonedVoice[],
  applyStatus: (fresh: VoiceLibraryEntry) => VoiceLibraryEntry,
): (fresh: VoiceLibraryEntry | null) => Promise<VoiceLibraryEntry | null> {
  return async (fresh) => {
    if (!fresh || fresh.consent?.revokedAt) {
      broken.push({ name: characterName, reason: 'revoked' });
      await deps.purgeCloneArtifacts(libraryUuid, {});
      return null;
    }
    return applyStatus(fresh);
  };
}

/** For each requested cloned voice: classify, derive Repairable, collect Broken.
 *  Throws UnresolvableClonedVoiceError with the full Broken list if any is Broken. */
export async function resolveClonedVoicesForChapter(
  requests: ClonedVoiceRequest[],
  deps: ResolveChapterDeps,
): Promise<void> {
  const broken: BrokenClonedVoice[] = [];

  for (const request of requests) {
    // Review I-1 — a paused/cancelled run must stop here, not keep spending
    // GPU time (or "instantly failing" against an already-aborted signal on
    // every remaining voice) — see isAbort's doc comment for why the signal
    // itself, not err.name, is the ground truth.
    if (deps.signal?.aborted) {
      throw abortRejection(undefined, deps);
    }

    const { characterName, characterId, libraryUuid, engine, wrongEngine, engineUnavailable } = request;

    if (!libraryUuid) {
      broken.push({ name: characterName, reason: 'misconfigured' });
      continue;
    }

    const entry = await deps.readEntry(libraryUuid);
    if (!entry) {
      broken.push({ name: characterName, reason: 'misconfigured' });
      continue;
    }

    const currentArtifactVersion = deps.currentArtifactVersion(engine);
    const slotKey = manifestSlotFor(engine);
    const ptExists = await deps.ptExists(cloneStorageKey(engine, libraryUuid));
    const classification = classifyClonedVoice({
      entry,
      engine,
      wrongEngine,
      engineUnavailable,
      ptExists,
      currentArtifactVersion,
    });

    if (classification.state === 'healthy') continue;

    if (classification.state === 'broken') {
      broken.push({
        name: characterName,
        reason: classification.reason!,
        // Task 18 — only 'engine-unavailable' names an engine in its remedy
        // text (UnresolvableClonedVoiceError.fromList); every other reason
        // leaves `engine` unset so pre-3c `.broken` assertions keep matching.
        ...(classification.reason === 'engine-unavailable' ? { engine } : {}),
      });
      continue;
    }

    // repairable — re-derive from the retained master.wav.
    deps.onVoicePrepare?.({ characterId, characterName });
    try {
      /* Task 22 fix round 1 (F1/F3) + round 2 (NEW-CRITICAL) — fires exactly
         once we KNOW a real derive is about to happen, on WHICHEVER side
         needs the OTHER engine evicted first, still inside this try/catch,
         so a failed evict is reported exactly like any other derive failure
         below (fail-loud, same as always — this resolver's policy is
         engine-agnostic: any derive failure is fail-loud). */
      if (engine === 'coqui') await deps.beforeFirstDerive?.();
      else if (engine === 'qwen') await deps.beforeFirstQwenDerive?.();
      const { pcm, sampleRate, refText } = await deps.readMasterPcm(libraryUuid, entry);
      const result = await deps.deriveEngineArtifact(
        libraryUuid,
        engine,
        { masterPcm: pcm, sampleRate, refText, auditionText: REPAIR_AUDITION_TEXT },
        { signal: deps.signal },
      );
      /* Task 18 — per-engine ready stamp. qwen keeps its EXISTING (pre-3c)
         shape unchanged: `baseModel` is the pre-derive `currentArtifactVersion`
         snapshot, never the derive response's own `result.baseModel` — that
         was already this codebase's established choice (see the designed
         self-heal's own DELTA-I4 note for the same tension resolved the
         OTHER way there) and this task doesn't touch qwen's tested behaviour.
         coqui is a brand-new path with no such precedent — Task 19 later gave
         it a live "current" oracle (`getLastKnownCoquiVersion()`, see
         ClassifyInput's doc comment), but this write-side choice predates
         and doesn't depend on that: it prefers the derive's own reported
         `coquiVersion`/`modelId` (the freshest possible truth, straight off
         the sidecar response that just ran), falling back to
         `currentArtifactVersion` only if the response itself came back empty
         (the older-sidecar-fallback case).

         fix wave (Task 18 review, MINOR-5) — `modelId` is only included when
         the derive response actually reported one. `deriveEngineArtifact`
         defaults it to `''` when `X-Model-Id` is absent (an older-sidecar
         response), and this object is spread OVER the existing slot below
         (`{...fresh.engines[slotKey], ...readySlot}`) — an unconditional
         `modelId: result.modelId` would overwrite a previously-recorded real
         modelId with `''` on that older-sidecar path. Omitting the key
         entirely lets the spread's LHS (the existing slot) survive instead. */
      const readySlot: VoiceLibraryEngineStatus =
        engine === 'qwen'
          ? { status: 'ready', baseModel: currentArtifactVersion }
          : {
              status: 'ready',
              coquiVersion: result.coquiVersion || currentArtifactVersion,
              ...(result.modelId ? { modelId: result.modelId } : {}),
            };
      const written = await deps.updateEntry(
        libraryUuid,
        statusStampMutate(deps, libraryUuid, characterName, broken, (fresh) => ({
          ...fresh,
          engines: {
            ...fresh.engines,
            [slotKey]: { ...fresh.engines[slotKey], ...readySlot },
          },
        })),
      );
      if (!written) continue; // gone/revoked mid-derive — mutate already reported + purged.
    } catch (err) {
      // Review I-1 — the caller's own abort must propagate as a real
      // AbortError (see abortRejection's doc comment), stopping the whole
      // pre-pass, never reclassified as a derive failure.
      if (isAbort(err, deps)) throw abortRejection(err, deps);
      if (isTransientDeriveFailure(err)) {
        // Transient (unreachable / 5xx) — do NOT persist 'failed'; a retry
        // must be able to re-attempt (classify rule 3 makes 'failed'
        // terminal, so persisting here would brick the voice on a hiccup).
        broken.push({ name: characterName, reason: 'derive-failed' });
      } else {
        // Permanent (4xx) — the sidecar rejected the clip itself. Same
        // locked re-read as the success path (Task 14 / review C-1): a
        // revoke landing between the (failed) derive attempt and this
        // write must not have its revokedAt clobbered by the stale
        // pre-derive snapshot.
        const written = await deps.updateEntry(
          libraryUuid,
          statusStampMutate(deps, libraryUuid, characterName, broken, (fresh) => ({
            ...fresh,
            engines: { ...fresh.engines, [slotKey]: { ...fresh.engines[slotKey], status: 'failed' } },
          })),
        );
        if (written) {
          broken.push({ name: characterName, reason: 'derive-failed' });
        }
      }
    }
  }

  if (broken.length > 0) throw UnresolvableClonedVoiceError.fromList(broken);
}

/* --- Task 12 (§2.3): designed-voice orphan self-heal ---------------------

   A CLONED voice's resolver above throws when a re-derive fails, because a
   cloned voice is consent-scoped — never substitute, fail loud. A DESIGNED
   voice carries no consent and already renders fine today even when stale
   (a base-model upgrade just means it's using an older embedding, not a
   correctness bug), so this self-heal is deliberately narrower and gentler:

     - ONLY triggers when the `.pt` is missing from disk entirely. A stale
       `baseModel`/`status` on an otherwise-present `.pt` is untouched —
       auto-re-deriving on every base-model bump has drift/quality
       implications nobody has designed (plan's §2.3 self-review recommended
       deferring exactly this); leave the existing render-fine-from-stale
       behaviour alone. This function never even looks at a
       VoiceLibraryEntry's `engines.qwen` — only the on-disk `.pt`
       presence — so there's no seam for that case to sneak in through.
     - NEVER throws, EXCEPT an abort (review M-1) — a paused/cancelled run
       must stop here too, not keep spending GPU time on a self-heal nobody
       wants anymore. Every other failure mode is swallowed: if the retained
       clip/ref-text is missing, or the re-derive itself fails (sidecar
       down, GPU busy, whatever), this logs a warning and lets the chapter
       proceed to whatever happens today for a missing designed voice (the
       sidecar's own error at synth time) — unchanged behaviour, not a
       differently-shaped abort.
     - A successful re-derive restores the designed-only manifest fields the
       sidecar's clone_voice handler would otherwise truncate away (review
       C-1), and stamps the voice-library entry ready with the fresh
       baseModel so it stops reading "stale" forever (review I-2). Both are
       best-effort on top of an already-successful derive — see the inline
       comments below. */

export interface DesignedVoiceRequest {
  characterName: string;
  /** #1813 — the cast character id this request resolves for (both request
      lists synthesise-chapter.ts builds are already derived from
      `CastCharacter`, so this is `c.id`). Carried through to
      `onVoicePrepare`'s payload; never used for classification. */
  characterId: string;
  libraryUuid: string | undefined;
  /** fs-38 Wave 3c, Task 20a — which clone-capable engine this self-heal
      request targets. 'qwen' preserves the pre-3c self-heal BYTE-FOR-BYTE:
      presence-only (`ptExists`), never removes anything on failure — a
      failed or impossible qwen self-heal just leaves the `.pt` missing,
      exactly as before this task. 'coqui' is the NEW D-B/D-F fail-SOFT arm:
      it also checks `coquiVersion` staleness (not just presence —
      `[DELTA-I3]`), and on a failed derive or a missing retained clip it
      reports the uuid via the returned `softFailedUuids` instead of
      leaving a slot with no artifact behind it — CoquiEngine.synthesize's
      cached-latents branch (main.py) has no catalogue fallback, so an
      unresolved `xtts-<uuid>` slot hard-fails the chapter (D-F). The two
      arms share this loop but never their failure policy — see the
      module-level note above `resolveClonedVoicesForChapter` on why
      fail-loud (that function) and fail-soft (this one) must never share a
      code path; that boundary holds INSIDE this function too, between the
      two engine arms. */
  engine: CloneEngine;
}

/** fs-38 Wave 3c, Task 20a — the designed-voice pre-pass's result. This
    module holds no `CastCharacter` (it's built on injected deps, keyed by
    uuid), so a soft coqui failure can't mutate `cast` itself — the call
    site (synthesise-chapter.ts, which owns `cast`) does that, using this
    uuid list. */
export interface ResolveDesignedVoicesResult {
  /** libraryUuids whose COQUI self-heal failed this chapter — the derive
      threw, or no retained clip was found to derive from. Never populated
      for a 'qwen' request (see `DesignedVoiceRequest.engine`'s doc
      comment). The call site must remove the affected character(s)'
      `overrideTtsVoices.coqui` slot for THIS CHAPTER ONLY — a per-chapter
      copy, never `cast` itself (`[DELTA-I2]`: a resumed run re-reads
      cast.json, so a whole-run downgrade would make a transient failure in
      chapter 1 silently change chapter 40's voice too) — so
      `pickVoiceForEngine` falls through to a catalogue voice instead of
      re-reaching an `xtts-<uuid>` key with no artifact behind it. */
  softFailedUuids: string[];
}

export interface ResolveDesignedVoiceDeps {
  /** result of stat()-ing the engine's storage key
      (`cloneStorageKey(engine, uuid)`: `voices/qwen/qwen-<uuid>.pt` or
      `voices/xtts/xtts-<uuid>.pt`). */
  ptExists(storageKey: string): Promise<boolean>;
  /** Reads the retained `qwen-<uuid>__master.wav` (Task 11) plus its
      matching ref_text off the sidecar's own disk — ALWAYS under the
      `qwen-` prefix regardless of `engine`: the retained calibration clip
      is a property of the DESIGN (minted once, only ever via qwen
      VoiceDesign), not of whichever engine later derives an artifact from
      it. `engine` gates only whether an empty/missing `refText`
      disqualifies the read (`[DELTA-M1]`) — a QWEN derive needs a
      transcript (`deriveEngineArtifact` validates this at call time), so
      `engine === 'qwen'` still requires a non-empty `refText`; a COQUI
      derive is purely acoustic and never sends `refText` on the wire (see
      derive-engine-artifact.ts), so gating a coqui self-heal on `refText`
      presence would misreport "no retained clip" for a design whose
      manifest merely lacks one. Returns `null` — never throws — when the
      manifest, the wav, or (qwen only) the refText is absent/unreadable,
      so the caller can fall through cleanly instead of surfacing a new
      failure. Also returns the FULL parsed sidecar manifest (review C-1) —
      the pre-derive snapshot the QWEN arm needs to restore designed-only
      fields the sidecar's clone_voice handler would otherwise truncate
      away (the coqui arm never needs this — see `writeSidecarManifest`'s
      doc comment). */
  readDesignedMasterPcm(
    uuid: string,
    engine: CloneEngine,
  ): Promise<
    { pcm: Buffer; sampleRate: number; refText: string; manifest: Record<string, unknown> } | null
  >;
  /** QWEN ARM ONLY. Review C-1 — atomically re-write `qwen-<uuid>.json`
      after a successful QWEN self-heal derive, restoring the designed-only
      fields (`instruct`, `designModel`, `mintMethod`, `fallbackFor`,
      `voiceUuid`, `language`) the sidecar's clone_voice handler truncates
      away, while keeping the derive's fresh `baseModel`/`refText`. The
      coqui arm never calls this: a coqui derive's `clone_voice` writes a
      SEPARATE `xtts-<uuid>.json` (main.py's `CoquiEngine.clone_voice`),
      never touching `qwen-<uuid>.json` — there is nothing on this file for
      a coqui derive to truncate or restore. */
  writeSidecarManifest(uuid: string, manifest: Record<string, unknown>): Promise<void>;
  /** Review I-2 — read the voice-library entry. The qwen arm reads it only
      indirectly, via `updateEntry` below, at its final success stamp. The
      coqui arm ALSO reads it directly, up front, per request, for two
      Task 20a reasons: (1) an explicit provenance re-check —
      `entry.provenance !== 'designed' => skip` — so this self-heal (and
      its slot-REMOVAL power) can never reach a cloned voice's slot, even
      if a future call-site regression ever fed one in. Today it can't, but
      only incidentally — a cloned voice's uuid yields no `__master.wav`
      under this naming convention, two modules away; this makes the
      invariant explicit instead of relying on that coincidence
      (`[DELTA-verified]`). (2) `coquiVersion` staleness (`[DELTA-I3]`):
      unlike the qwen arm's deliberately presence-only check, the coqui arm
      ALSO re-derives when `entry.engines.xtts?.coquiVersion` reads stale
      against `currentArtifactVersion('coqui')`, via the SAME
      `isArtifactVersionStale` comparand the cloned resolver's classifier
      uses. */
  readEntry(uuid: string): Promise<VoiceLibraryEntry | null>;
  writeEntry(entry: VoiceLibraryEntry): Promise<void>;
  /** fs-38 Wave 3c, Task 14 — the shared, per-uuid-locked read-modify-write
      primitive (see `ResolveChapterDeps.updateEntry`'s doc comment). The
      success-stamp write below routes through this instead of a bare
      readEntry+writeEntry pair for the same reason as the cloned resolver's
      derive-success write: the lock has to span the fresh read AND the
      write as one critical section, not just the write. Task 20a raises the
      stakes on this: a coqui designed derive now writes `engines.xtts` on
      the SAME entry a cloned coqui repair (`resolveClonedVoicesForChapter`)
      can concurrently write `engines.xtts`/`engines.qwen` on — exactly the
      cross-slot lost-update hazard Task 14 built this primitive to close. */
  updateEntry(
    uuid: string,
    mutate: (
      entry: VoiceLibraryEntry | null,
    ) => Promise<VoiceLibraryEntry | null | undefined> | VoiceLibraryEntry | null | undefined,
  ): Promise<VoiceLibraryEntry | null>;
  deriveEngineArtifact: typeof deriveEngineArtifact;
  /** COQUI ARM ONLY — mirrors `ResolveChapterDeps.currentArtifactVersion`;
      see that doc comment for what this returns per engine and why coqui's
      reads `''` before the sidecar's first reachable /health poll. The
      qwen arm never calls this — presence-only, unchanged (`[DELTA-I3]`). */
  currentArtifactVersion(engine: CloneEngine): string;
  /** #1813 — mirrors `ResolveChapterDeps.onVoicePrepare`: fired immediately
      before a self-heal derive starts (either arm), so the caller can
      surface a "Preparing voice" UI phase for a designed-voice self-heal
      too, not just a cloned-voice repair. */
  onVoicePrepare?(e: { characterId: string; characterName: string }): void;
  signal?: AbortSignal;
  /** fs-38 Wave 3c, Task 22 fix round 1 (F1/F3) — same contract as
      `ResolveChapterDeps.beforeFirstDerive`: fires once, immediately before
      the FIRST real coqui derive (COQUI ARM ONLY — the qwen arm never calls
      this). A thrown/rejected hook is caught by this function's own
      existing fail-SOFT catch below, exactly like any other unexpected coqui
      self-heal failure — never a new hard failure (§2.3). */
  beforeFirstDerive?(): Promise<void>;
  /** fs-38 Wave 3c, Task 22 fix round 2 [NEW-CRITICAL] — mirror of
      `beforeFirstDerive`, QWEN ARM ONLY (the coqui arm never calls this).
      Fires once, immediately before the FIRST real qwen derive. A thrown/
      rejected hook is caught by the SAME shared catch as every other qwen-
      arm failure and, like every other failure there, is fail-soft
      (`console.warn`, byte-for-byte the qwen arm's existing pre-3c policy)
      — EXCEPT a genuine abort (M-1 below), which the shared catch still
      rethrows. Task 23 correction: that escape is unreachable from THIS
      hook's own body (`evictEngineForPhase`'s fetch carries no signal, so a
      failed evict can only throw a plain Error, never an AbortError), but a
      real in-flight `deps.signal` abort DURING the call still rethrows
      correctly — "never rethrown" was an overstatement (this arm has NO
      loop-top abort check of its own, unlike the cloned resolver — see the
      synthesise-chapter.ts call site for why that makes the shared catch's
      abort escape load-bearing, not redundant, for this arm). */
  beforeFirstQwenDerive?(): Promise<void>;
}

/** For each requested designed voice: best-effort re-derive from its
 *  retained clip. QWEN ARM: presence-only, byte-for-byte pre-3c behaviour —
 *  a failed or impossible self-heal just leaves the `.pt` missing, exactly
 *  as it is today. COQUI ARM (fs-38 Wave 3c, Task 20a — D-B/D-F): also
 *  checks `coquiVersion` staleness, and on a failed derive or a missing
 *  retained clip reports the uuid via the returned `softFailedUuids` so the
 *  call site can drop the character's coqui slot for this chapter rather
 *  than leave one with no artifact behind it. Never THROWS on either arm,
 *  except a genuine abort (M-1 below) — the two arms' failure POLICIES
 *  differ (soft-removal vs. leave-alone), but neither ever raises
 *  `UnresolvableClonedVoiceError` or any other error; that separation from
 *  `resolveClonedVoicesForChapter`'s fail-loud contract is the whole point
 *  of this being a different function. */
export async function resolveDesignedVoicesForChapter(
  requests: DesignedVoiceRequest[],
  deps: ResolveDesignedVoiceDeps,
): Promise<ResolveDesignedVoicesResult> {
  const softFailedUuids = new Set<string>();

  for (const { characterName, characterId, libraryUuid, engine } of requests) {
    if (!libraryUuid) continue;

    /* Task 20a fix round 1 (F1) — set from inside the coqui branch below the
       moment `ptExists` is actually known, and consulted by the shared catch
       at the bottom: a STALE-but-PRESENT artifact must never be downgraded
       to a catalogue voice just because its re-derive failed (a stale
       artifact still renders correctly today — the whole point of fail-soft
       is to avoid a downgrade, not cause one). Stays `false` (the safe
       default — never confirmed present) for every other case: the qwen
       arm, the provenance-skip, and any unexpected throw from `readEntry`/
       `ptExists` itself before this gets set. */
    let coquiPtExists = false;

    /* I-1 (review) — the ENTIRE per-voice body now lives in one try/catch.
       Previously `ptExists`/`readDesignedMasterPcm` were called outside any
       try here (only the derive call itself was guarded), so a throw from
       either — or an escaped throw from `readDesignedMasterPcm` despite its
       own "never throws" contract — would propagate straight out of this
       function and abort a chapter that would otherwise have rendered.
       Task 20a: the coqui arm's `readEntry`/`ptExists`/derive calls live
       under this SAME try, so an unexpected throw from any of them is
       treated the same as a genuine derive failure — softFailed, never
       propagated (see the shared catch below). */
    try {
      if (engine === 'coqui') {
        /* [DELTA-verified] — explicit provenance re-check before this
           self-heal's slot-REMOVAL power touches anything. See
           ResolveDesignedVoiceDeps.readEntry's doc comment: this is what
           stops it from ever reaching a cloned voice's slot on purpose,
           rather than by the pre-3c naming-convention coincidence. */
        const entry = await deps.readEntry(libraryUuid);
        if (!entry || entry.provenance !== 'designed') continue;

        const storageKey = cloneStorageKey('coqui', libraryUuid);
        const ptExists = await deps.ptExists(storageKey);
        coquiPtExists = ptExists;
        /* [DELTA-I3] — unlike qwen's presence-only check, the coqui arm
           ALSO re-derives on a coquiVersion bump, via the SAME shared
           comparand the cloned resolver's classifier uses — never a
           locally re-derived one. */
        const stale = isArtifactVersionStale(
          entry.engines.xtts?.coquiVersion,
          deps.currentArtifactVersion('coqui'),
        );
        if (ptExists && !stale) continue; // present and current — leave alone.

        const master = await deps.readDesignedMasterPcm(libraryUuid, 'coqui');
        if (!master) {
          /* [DELTA-C2] contract — no retained clip to derive/refresh from.
             Task 20a fix round 1 (F1): only REMOVE the slot when there is
             no artifact backing it at all (`!ptExists`) — a stale-but-
             present `.pt` renders correctly today, so keep it rather than
             downgrading to a catalogue voice on a re-derive this function
             couldn't even attempt. */
          if (!ptExists) {
            softFailedUuids.add(libraryUuid);
            console.warn(
              `[clone-voice-resolver] designed coqui voice for "${characterName}" (${libraryUuid}) has ` +
                `no retained clip to derive from — removing its coqui slot for this chapter.`,
            );
          } else {
            console.warn(
              `[clone-voice-resolver] designed coqui voice for "${characterName}" (${libraryUuid}) is ` +
                `stale but has no retained clip to refresh from — keeping the existing artifact rather ` +
                `than downgrading to a catalogue voice.`,
            );
          }
          continue;
        }

        deps.onVoicePrepare?.({ characterId, characterName });
        /* Task 22 fix round 1 (F1/F3) — same hook as the cloned resolver's
           coqui branch, still inside this per-voice try (I-1 above), so a
           failed evict is caught by the shared catch below exactly like any
           other coqui self-heal failure — soft, never a new hard failure. */
        await deps.beforeFirstDerive?.();
        const result = await deps.deriveEngineArtifact(
          libraryUuid,
          'coqui',
          {
            masterPcm: master.pcm,
            sampleRate: master.sampleRate,
            refText: master.refText,
            auditionText: REPAIR_AUDITION_TEXT,
          },
          { signal: deps.signal },
        );

        /* [DELTA-I4] — engines.xtts only: coquiVersion/modelId, NEVER
           baseModel (that field is the qwen arm's, below). Best-effort,
           same rationale as the qwen arm's stamp write: a write failure
           here must not turn a successful re-derive (the `.pt` IS on disk
           now) into a reported self-heal failure. */
        try {
          await deps.updateEntry(libraryUuid, (fresh) =>
            fresh
              ? {
                  ...fresh,
                  engines: {
                    ...fresh.engines,
                    xtts: {
                      ...fresh.engines.xtts,
                      status: 'ready',
                      coquiVersion: result.coquiVersion ?? '',
                      ...(result.modelId ? { modelId: result.modelId } : {}),
                    },
                  },
                }
              : null,
          );
        } catch (entryErr) {
          console.warn(
            `[clone-voice-resolver] designed coqui self-heal for "${characterName}" (${libraryUuid}) ` +
              `re-derived successfully but failed to stamp its voice-library entry ready:`,
            entryErr,
          );
        }
        continue;
      }

      // --- qwen arm — byte-for-byte pre-3c behaviour, unchanged below. ---
      const storageKey = `qwen-${libraryUuid}`;
      const ptExists = await deps.ptExists(storageKey);
      if (ptExists) continue; // present (healthy OR merely stale, out of scope) — leave it alone.

      const master = await deps.readDesignedMasterPcm(libraryUuid, 'qwen');
      if (!master) continue; // no retained clip / no ref_text — fall through to today's behaviour.

      deps.onVoicePrepare?.({ characterId, characterName });
      /* Task 22 fix round 2 [NEW-CRITICAL] — mirror of the coqui arm's
         `beforeFirstDerive` call. Still inside the shared I-1 try, so a
         failed evict is caught by the shared catch below exactly like any
         other qwen self-heal failure — `console.warn` and fail-soft, unless
         it's a genuine abort (M-1 below), which still rethrows; see
         `beforeFirstQwenDerive`'s own doc comment above for why that escape
         isn't reachable from this hook's own failure mode. */
      await deps.beforeFirstQwenDerive?.();
      const result = await deps.deriveEngineArtifact(
        libraryUuid,
        'qwen',
        {
          masterPcm: master.pcm,
          sampleRate: master.sampleRate,
          refText: master.refText,
          auditionText: REPAIR_AUDITION_TEXT,
        },
        { signal: deps.signal },
      );

      /* C-1 (review) — the sidecar's clone_voice handler TRUNCATE-REWRITES
         qwen-<uuid>.json to a bare clone manifest (voiceId/voiceUuid/
         refText/language/baseModel/designModel:null/clone:true) — it has no
         idea this voiceId was ever DESIGNED, so `instruct`/`designModel`/
         `mintMethod`/`fallbackFor` are lost on the very first self-heal
         (and a re-DESIGN then fails on the resulting empty persona). Restore
         them: spread the manifest read BEFORE the derive back over whatever
         the sidecar just wrote, refreshing only `refText`/`baseModel` to the
         derive's actual values. Best-effort — a write failure here must not
         turn a successful re-derive (the `.pt` IS on disk now) into a
         reported self-heal failure. */
      const restoredManifest: Record<string, unknown> = {
        ...master.manifest,
        refText: master.refText,
        baseModel: result.baseModel || master.manifest.baseModel,
      };
      try {
        await deps.writeSidecarManifest(libraryUuid, restoredManifest);
      } catch (manifestErr) {
        console.warn(
          `[clone-voice-resolver] designed self-heal for "${characterName}" (${libraryUuid}) re-derived ` +
            `successfully but failed to restore its sidecar manifest:`,
          manifestErr,
        );
      }

      /* I-2 (review) — stamp the voice-library entry ready with the
         derive's fresh baseModel, mirroring the cloned resolver's success
         write (~:223-229 above), so a voice this feature just healed
         doesn't keep reading "stale" forever: a promote-with-no-.pt entry
         is created as `{status:'stale'}` with NO baseModel at all
         (routes/voice-library.ts ~:545), which `withComputedStaleness`
         can't repair on its own. Preserve sibling engines + other qwen
         fields via spreads, same as the cloned path. Best-effort, same
         rationale as the manifest write above.

         fs-38 Wave 3c, Task 14 — routes through `deps.updateEntry`, the
         shared per-uuid-locked read-modify-write primitive, rather than a
         bare readEntry+writeEntry pair: without the lock, a concurrent
         writer (e.g. the cloned resolver's own repair, or a PATCH) could
         read its own snapshot in the gap between this read and this write
         and have ITS write clobbered by this one landing after — or vice
         versa. `mutate` returning null when the entry has vanished skips
         the write, matching the prior "if (entry)" guard.

         Task 15 — `deriveEngineArtifact`'s `baseModel` is now optional on
         its result (coqui derives never set it), so `result.baseModel` is
         `string | undefined` here even though this call site always derives
         via the literal 'qwen' (which always populates it at runtime).
         Falling back to `currentQwenBaseModel()` on the type-level
         possibility keeps this from ever writing `baseModel: undefined` onto
         `engines.qwen` — `withComputedStaleness` (routes/voice-library.ts)
         reads a falsy `baseModel` as "never stale", so an undefined write
         here would silently disable this voice's future staleness checks. */
      try {
        await deps.updateEntry(libraryUuid, (fresh) =>
          fresh
            ? {
                ...fresh,
                engines: {
                  ...fresh.engines,
                  qwen: {
                    ...fresh.engines.qwen,
                    status: 'ready',
                    baseModel: result.baseModel || currentQwenBaseModel(),
                  },
                },
              }
            : null,
        );
      } catch (entryErr) {
        console.warn(
          `[clone-voice-resolver] designed self-heal for "${characterName}" (${libraryUuid}) re-derived ` +
            `successfully but failed to stamp its voice-library entry ready:`,
          entryErr,
        );
      }
    } catch (err) {
      /* M-1 (review) — an abort must stop the loop, not be swallowed as an
         ordinary best-effort failure. */
      const name = (err as { name?: string } | null)?.name;
      if (name === 'AbortError' || deps.signal?.aborted) throw err;
      if (engine === 'coqui') {
        /* Task 20a — an unexpected throw anywhere in the coqui arm (readEntry,
           ptExists, the derive itself) is treated as a soft failure UNLESS
           `coquiPtExists` proves an artifact is already on disk (fix round 1,
           F1): a stale-but-present `.pt` must survive a failed re-derive
           attempt rather than being swapped for a catalogue voice — "we
           don't know exactly why this broke" only overrides "never a new
           hard failure" (D-F) when we genuinely don't know whether ANY
           artifact exists at all. */
        if (!coquiPtExists) {
          softFailedUuids.add(libraryUuid);
          console.warn(
            `[clone-voice-resolver] designed coqui voice self-heal failed for "${characterName}" ` +
              `(${libraryUuid}) — removing its coqui slot for this chapter:`,
            err,
          );
        } else {
          console.warn(
            `[clone-voice-resolver] designed coqui voice self-heal failed for "${characterName}" ` +
              `(${libraryUuid}) — keeping the existing (stale) artifact rather than downgrading to a ` +
              `catalogue voice:`,
            err,
          );
        }
        continue;
      }
      /* M-3 (review) — a bare `catch {}` here made a self-heal failing on
         EVERY render undiagnosable. Name the voice + error so it shows up
         in the server log; still best-effort — never throws, never bricks
         the chapter (the sidecar raises its own error for a missing
         designed voice). */
      console.warn(
        `[clone-voice-resolver] designed voice self-heal failed for "${characterName}" (${libraryUuid}):`,
        err,
      );
    }
  }

  return { softFailedUuids: [...softFailedUuids] };
}
