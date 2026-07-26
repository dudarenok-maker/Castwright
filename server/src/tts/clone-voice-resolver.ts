/* fs-38 Wave 3b2 — the cloned-voice resolver. T4 lays the module's
   foundation: the `BrokenClonedVoice` shape and `UnresolvableClonedVoiceError`
   (moved here from synthesise-chapter.ts, which re-exports it, to avoid an
   import cycle — synthesiseChapter will import this module's resolver, and
   the resolver needs this error). T5 adds the classifier + async
   orchestrator (`resolveClonedVoicesForChapter`) on top. */

import type { VoiceLibraryEntry } from '../workspace/voice-library.js';
import type { deriveEngineArtifact } from './derive-engine-artifact.js';
// Review C-1 — type-only: this module's whole design is injected deps for
// testability, so the REAL purgeCloneArtifacts is wired in by the caller
// (synthesise-chapter.ts's buildDefaultCloneResolverDeps), never imported
// here at runtime.
import type { purgeCloneArtifacts } from '../workspace/purge-clone-artifacts.js';

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
      remedies.push('Re-enable Qwen or restore the missing voice(s)');
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
  // M3 (review) — 'deriving' is declared on VoiceLibraryEngineStatus['status']
  // but nothing ever persists it; no branch here handles it intentionally.
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
  /** Review C-1 — re-run after a post-derive re-read finds the entry gone or
      revoked, so a `.pt` the sidecar wrote DURING the derive (after an
      in-flight revoke's own purge already ran) doesn't survive it. Same
      function that backs the revoke/delete routes
      (workspace/purge-clone-artifacts.ts) — injected here, not imported
      directly, to keep this module's dependency-injection pattern intact. */
  purgeCloneArtifacts: typeof purgeCloneArtifacts;
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

/** Review C-1 — after a derive completes (a real, seconds+ GPU op), the
    voice-library entry may have changed underneath the in-flight repair: a
    revoke can land mid-derive (stamping `consent.revokedAt` and purging
    artifacts) before this write goes out, or the entry can be deleted
    outright. Re-read fresh right before every post-derive write so that
    write doesn't resurrect a revoked/deleted entry — or clobber
    `revokedAt` — from the STALE pre-derive snapshot the caller classified
    against. Returns the fresh entry to merge the status stamp into, or
    `undefined` when the write must be skipped entirely (gone/revoked) — in
    which case this reports the voice Broken/revoked and re-runs the
    artifact purge, so a `.pt` (and sidecar in-memory prompt) the derive just
    produced AFTER an in-flight revoke's own purge already ran doesn't
    survive it.

    NOT a lock: `writeEntry` is tmp+rename with no compare-and-swap (true of
    every manifest write in this codebase), so this closes the seconds-wide
    GPU window, not the millisecond one between this re-read and the write
    that follows. If a revoke lands in THAT window the flag can still be
    clobbered — but the revoke's purge runs strictly after its own
    `writeEntry`, hence after this re-read, so it lands last and the
    artifacts still go: the residue is a stale un-revoked flag with nothing
    renderable behind it (the next render fails loud on the missing master),
    recoverable by revoking again. Per-uuid write serialization / an
    `updatedAt` CAS would close it properly — tracked as a follow-up, which
    also names the two-worker compound corner. */
async function guardPostDeriveWrite(
  deps: ResolveChapterDeps,
  libraryUuid: string,
  characterName: string,
  broken: BrokenClonedVoice[],
): Promise<VoiceLibraryEntry | undefined> {
  const fresh = await deps.readEntry(libraryUuid);
  if (!fresh || fresh.consent?.revokedAt) {
    broken.push({ name: characterName, reason: 'revoked' });
    await deps.purgeCloneArtifacts(libraryUuid, {});
    return undefined;
  }
  return fresh;
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
        { masterPcm: pcm, sampleRate, refText, auditionText: REPAIR_AUDITION_TEXT },
        { signal: deps.signal },
      );
      const fresh = await guardPostDeriveWrite(deps, libraryUuid, characterName, broken);
      if (!fresh) continue; // gone/revoked mid-derive — guard already reported + purged.
      await deps.writeEntry({
        ...fresh,
        engines: {
          ...fresh.engines,
          qwen: { ...fresh.engines.qwen, status: 'ready', baseModel: currentBaseModel },
        },
      });
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
        // re-read guard as the success path (review C-1): a revoke landing
        // between the (failed) derive attempt and this write must not have
        // its revokedAt clobbered by the stale pre-derive snapshot.
        const fresh = await guardPostDeriveWrite(deps, libraryUuid, characterName, broken);
        if (fresh) {
          await deps.writeEntry({
            ...fresh,
            engines: { ...fresh.engines, qwen: { ...fresh.engines.qwen, status: 'failed' } },
          });
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
  libraryUuid: string | undefined;
}

export interface ResolveDesignedVoiceDeps {
  /** result of stat()-ing voices/qwen/qwen-<uuid>.pt */
  ptExists(storageKey: string): Promise<boolean>;
  /** Reads the retained `qwen-<uuid>__master.wav` (Task 11) plus its
      matching ref_text off the sidecar's own disk. Returns `null` — never
      throws — when either artifact is absent/unreadable, so the caller can
      fall through cleanly instead of surfacing a new failure. Also returns
      the FULL parsed sidecar manifest (review C-1) — the pre-derive
      snapshot the caller needs to restore designed-only fields the
      sidecar's clone_voice handler would otherwise truncate away. */
  readDesignedMasterPcm(
    uuid: string,
  ): Promise<
    { pcm: Buffer; sampleRate: number; refText: string; manifest: Record<string, unknown> } | null
  >;
  /** Review C-1 — atomically re-write `qwen-<uuid>.json` after a successful
      self-heal derive, restoring the designed-only fields (`instruct`,
      `designModel`, `mintMethod`, `fallbackFor`, `voiceUuid`, `language`)
      the sidecar's clone_voice handler truncates away, while keeping the
      derive's fresh `baseModel`/`refText`. */
  writeSidecarManifest(uuid: string, manifest: Record<string, unknown>): Promise<void>;
  /** Review I-2 — read/write the voice-library entry so a successful
      self-heal can stamp `engines.qwen` ready with the derive's baseModel,
      mirroring the cloned resolver's success write. */
  readEntry(uuid: string): Promise<VoiceLibraryEntry | null>;
  writeEntry(entry: VoiceLibraryEntry): Promise<void>;
  deriveEngineArtifact: typeof deriveEngineArtifact;
  reportProgress?(msg: string): void;
  signal?: AbortSignal;
}

/** For each requested designed voice whose `.pt` is missing: best-effort
 *  re-derive from its retained clip. Never throws (except an abort — see
 *  M-1 below) — a failed or impossible self-heal just leaves the `.pt`
 *  missing, exactly as it is today. */
export async function resolveDesignedVoicesForChapter(
  requests: DesignedVoiceRequest[],
  deps: ResolveDesignedVoiceDeps,
): Promise<void> {
  for (const { characterName, libraryUuid } of requests) {
    if (!libraryUuid) continue;

    /* I-1 (review) — the ENTIRE per-voice body now lives in one try/catch.
       Previously `ptExists`/`readDesignedMasterPcm` were called outside any
       try here (only the derive call itself was guarded), so a throw from
       either — or an escaped throw from `readDesignedMasterPcm` despite its
       own "never throws" contract — would propagate straight out of this
       function and abort a chapter that would otherwise have rendered. */
    try {
      const storageKey = `qwen-${libraryUuid}`;
      const ptExists = await deps.ptExists(storageKey);
      if (ptExists) continue; // present (healthy OR merely stale, out of scope) — leave it alone.

      const master = await deps.readDesignedMasterPcm(libraryUuid);
      if (!master) continue; // no retained clip / no ref_text — fall through to today's behaviour.

      deps.reportProgress?.(`Preparing voice "${characterName}"…`);
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
         rationale as the manifest write above. */
      try {
        const entry = await deps.readEntry(libraryUuid);
        if (entry) {
          await deps.writeEntry({
            ...entry,
            engines: {
              ...entry.engines,
              qwen: { ...entry.engines.qwen, status: 'ready', baseModel: result.baseModel },
            },
          });
        }
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
}
