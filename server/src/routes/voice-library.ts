/* GET   /api/voice-library
   PATCH /api/voice-library/:voiceUuid

   fs-38 Wave 1, Task 4 — the voice-library list + edit routes. Tasks 5, 7, 9,
   10, 11 add more handlers to this same router file. The library is a core
   surface with no feature gate in front of it.

   Handlers stay thin: validate the request, call the Task 3 manifest store
   (workspace/voice-library.ts), respond. No business logic lives here. */

import { Router } from 'express';
import { existsSync } from 'node:fs';
import { mkdir, copyFile, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import multer from 'multer';
import type { Request, Response } from '../http.js';
import {
  entryDir,
  listEntries,
  readEntry,
  writeEntry,
  updateEntry,
  ConsentRequiredError,
  clonedVoiceLacksConsent,
  type VoiceConsentRecord,
  type VoiceLibraryEntry,
  type VoiceLibraryEngineStatus,
  type VoiceMaster,
} from '../workspace/voice-library.js';
import { currentQwenBaseModel } from '../tts/model-paths.js';
import { getLastKnownCoquiVersion } from '../tts/coqui-version-state.js';
import {
  CLONE_ENGINE_LIST,
  cloneStorageKey,
  isArtifactVersionStale,
  isCloneEngine,
  manifestSlotFor,
  type CloneEngine,
} from '../tts/clone-engines.js';
import { runVoiceDesign } from '../tts/design-voice-core.js';
import { scanLibraryVoiceUsage, clearLibraryVoiceReferences } from '../workspace/voice-library-usage.js';
import { castJsonPath, qwenVoiceSidecarPath, qwenVoiceWavPath } from '../workspace/paths.js';
import { qwenVoicePtPath } from './qwen-voice.js';
import { qwenStorageKey } from '../tts/voice-mapping.js';
import {
  selectTtsProvider,
  engineForModelKey,
  isTtsModelKey,
  type TtsEngine,
  type TtsModelKey,
} from '../tts/index.js';
import { resolveCharacterEngine } from '../tts/per-character-engine.js';
import { encodePcmToAudio, decodeAudioToPcm } from '../tts/mp3.js';
import {
  buildSampleText,
  djb2,
  purgeVoiceSamples,
  voiceSampleAudioDir,
  voiceSampleFileName,
  voiceSampleFilePath,
  voiceSamplePublicUrl,
} from '../tts/voice-sample-cache.js';
import { getResolvedSidecarUrl, getResolvedTtsModelKey } from '../workspace/user-settings.js';
import { findBookByBookId, bookStateLanguage } from '../workspace/scan.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { withCastLock, withLibraryVoiceLock } from '../workspace/cast-lock.js';
import { requestFailureMessage } from '../workspace/file-lock.js';
import type { CastCharacter } from '../tts/synthesise-chapter.js';
import { ingestCloneSample } from '../tts/clone-ingest.js';
/* #1951 — the clone's own manifest language, from the reference clip. */
import { sidecarLanguageName, normaliseBookLanguage } from '../tts/language.js';
import { isSupportedLanguage } from '../tts/language-registry.js';
import { readCandidate, candidateMasterPath, removeCandidate } from '../workspace/clone-candidate.js';
import { deriveEngineArtifact } from '../tts/derive-engine-artifact.js';
import { assessCloneFidelity } from '../tts/clone-fidelity.js';
import { isTransient } from '../tts/retry.js';
import { NoCapacityError } from '../tts/tts-errors.js';
import { purgeCloneArtifacts } from '../workspace/purge-clone-artifacts.js';
import { httpStatusForSidecarError } from './sidecar-error-status.js';
import { safeSegment, sanitizeIdSegment, assertContained } from '../util/safe-path.js';

export const voiceLibraryRouter = Router();

const cloneUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

/** Cap on a client-supplied clone transcript (#1836) — mirrors
 *  `CloneVoiceRequest.transcript`'s `maxLength` in openapi.yaml, so the route
 *  enforces exactly what the contract advertises. A sanity bound: 2000
 *  characters is already far above any real transcript of the ≤60 s sample
 *  clip (~1000 chars of English speech).
 *
 *  Why 2000 specifically, in characters, is enough to bound the WIRE: the
 *  value reaches the sidecar as a base64 `X-Ref-Text` header, and base64
 *  applies to UTF-8 BYTES, not characters — so the cap has to survive
 *  multi-byte text (ja/zh/ru per fs-59 is exactly the content most likely to
 *  need a correction). `.length` counts UTF-16 units, and the worst case is a
 *  3-byte BMP character per unit (astral chars cost 4 bytes but 2 units, so
 *  they're cheaper per unit). 2000 units ⇒ ≤6000 UTF-8 bytes ⇒ ≤8000 base64
 *  bytes. A separate byte check would therefore be unreachable.
 *
 *  What this does and doesn't protect: the SHIPPED sidecar installs
 *  `uvicorn[standard]` → httptools, which enforces no header limit at all, so
 *  on the default stack this is purely a sanity bound. It earns its keep on
 *  the h11 fallback (httptools absent), whose 16 KiB budget covers the WHOLE
 *  request line + header block — and the 3b2 repair path re-sends this same
 *  persisted text plus an `X-Audition-Text` header, sharing that budget.
 *  8000 base64 bytes leaves ample room for both. */
export const MAX_CLONE_TRANSCRIPT_CHARS = 2000;

/* Library single-flight lock (spec §3). A module-level in-flight set keyed by
   voiceUuid (plus one `'library:new'` key for creates) serializes design work
   for one voice so a double-submit can't race two designs onto the same `.pt`.
   This is DELIBERATELY separate from qwen-voice.ts's per-`bookDir`
   `withDesignLock` — the library has no book scope, and the spec explicitly
   rejects a cross-scope server mutex (cross-scope protection is the frontend's
   single-slot + the sidecar's own VRAM arbitration). Re-entry → 409. */
const inFlightDesigns = new Set<string>();

class DesignInFlightError extends Error {
  constructor() {
    super('design already running');
    this.name = 'DesignInFlightError';
  }
}

class CloneCandidateMissingError extends Error {
  constructor(candidateId: string) {
    super(`No clone-sample candidate "${candidateId}".`);
    this.name = 'CloneCandidateMissingError';
  }
}

type CloneConsentDraft = {
  personName: string;
  relationship: VoiceConsentRecord['relationship'];
  permittedUse: 'personal';
  /** #1943 — who is actually attesting, distinct from `personName` (whose
      voice it is) for the two non-self relationships. Trimmed; blank/absent
      is `undefined` here so the /clone handler has one shape to check rather
      than also handling empty strings. #1959 — absent here means "reject"
      for a non-self relationship and "fall back to personName" for `self`;
      this type only tracks what was supplied, not which rule applies. */
  attestedBy?: string;
};

function validateConsentDraft(raw: unknown): CloneConsentDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const personName = typeof c.personName === 'string' ? c.personName.trim() : '';
  const rel = c.relationship;
  const relOk = rel === 'self' || rel === 'family-with-permission' || rel === 'guardian-of-minor';
  if (!personName || !relOk || c.permittedUse !== 'personal') return null;
  const attestedByRaw = typeof c.attestedBy === 'string' ? c.attestedBy.trim() : '';
  return {
    personName,
    relationship: rel as VoiceConsentRecord['relationship'],
    permittedUse: 'personal',
    ...(attestedByRaw ? { attestedBy: attestedByRaw } : {}),
  };
}

async function withSingleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (inFlightDesigns.has(key)) throw new DesignInFlightError();
  inFlightDesigns.add(key);
  try {
    return await fn();
  } finally {
    inFlightDesigns.delete(key);
  }
}

/* Finding 3 (#1842 review) — /design and /:voiceUuid/redesign each validated
   an incoming `modelKey` with a character-identical block (both design onto
   a `qwen-<uuid>` storageKey only, so a non-Qwen modelKey can never be
   honoured there). Collapsed to one helper: `null` means "reject with the
   400 below", any other return is the resolved, valid modelKey (the 0.6B
   base when the caller omitted the field). Callers still own the 400
   response status/body — this only decides validity.

   fs-38 Wave 3c, Task 27 — /:voiceUuid/sample used to share this helper too,
   back when it also only ever auditioned `qwen-<uuid>`. It now resolves its
   own engine-aware modelKey inline (any clone-capable engine, not Qwen-only)
   — see that route's own comment. */
function resolveQwenModelKey(raw: unknown): TtsModelKey | null {
  if (raw === undefined) return 'qwen3-tts-0.6b';
  if (!isTtsModelKey(raw) || engineForModelKey(raw) !== 'qwen') return null;
  return raw;
}

interface DesignBody {
  name?: unknown;
  persona?: unknown;
  languageCode?: unknown;
  /** #1842 — the tier the modal's own previewUrl auditions. Must land on the
      SAME modelKey the /sample route above resolves, since design and play
      share the `qwen-<uuid>` cache scope — otherwise the design-time
      audition and the card's first Play would disagree on tier and land on
      two different cached filenames, costing a silent extra synthesis. */
  modelKey?: unknown;
}

/* POST /api/voice-library/design

   Create a brand-new designed library voice. Mints a fresh voiceUuid (the
   srv-43 nanoid generator — NOT the character-coupled ensureCharacterVoiceUuid,
   which stamps a cast member), runs the scope-agnostic design core under the
   `qwen-<uuid>` storage key, and persists a `designed` manifest stamping the
   Qwen base model it was derived from (for the list route's staleness check).
   → 201 { entry, previewUrl }; the modal auditions previewUrl before Save. */
voiceLibraryRouter.post('/design', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as DesignBody;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const persona = typeof body.persona === 'string' ? body.persona.trim() : '';
    const languageCode = typeof body.languageCode === 'string' ? body.languageCode : undefined;
    if (!name) return res.status(400).json({ error: '`name` is required.' });
    if (!persona) return res.status(400).json({ error: '`persona` is required.' });
    /* #1842 — this route only ever designs onto a `qwen-<uuid>` storageKey, so
       a non-Qwen modelKey can never be honoured. Omitted → the 0.6B base,
       matching the play route's default (resolveQwenModelKey — Finding 3). */
    const modelKey = resolveQwenModelKey(body.modelKey);
    if (!modelKey) {
      return res.status(400).json({ code: 'invalid_model', message: 'modelKey must be a Qwen model key.' });
    }

    const result = await withSingleFlight('library:new', async () => {
      const voiceUuid = nanoid();
      const { previewUrl } = await runVoiceDesign({
        storageKey: `qwen-${voiceUuid}`,
        displayName: name,
        persona,
        languageCode,
        modelKey,
      });
      const now = new Date().toISOString();
      const entry: VoiceLibraryEntry = {
        voiceUuid,
        name,
        provenance: 'designed',
        tags: [],
        pinned: false,
        ...(languageCode ? { languageCode } : {}),
        persona,
        engines: { qwen: { status: 'ready', baseModel: currentQwenBaseModel() } },
        createdAt: now,
        updatedAt: now,
      };
      await writeEntry(entry);
      return { entry: await readEntry(voiceUuid), previewUrl };
    });
    return res.status(201).json(result);
  } catch (e) {
    if (e instanceof DesignInFlightError) {
      return res.status(409).json({ error: 'design already running' });
    }
    console.error('[voice-library] design failed', e);
    return res
      .status(httpStatusForSidecarError(e))
      .json({ error: (e as Error).message || 'Voice design failed.' });
  }
});

/* GATE 1 fix (C1) — persona redesign is a DESIGNED-voice operation and must
   never touch a cloned one. Both `/redesign` and `/redesign/promote` write to
   the `qwen-<uuid>` storage key: promote does `rm(qwen-<uuid>.pt)` +
   `rename(qwen-<uuid>-preview.pt → qwen-<uuid>.pt)`, replacing a cloned
   voice's artifact in place with a persona-instruct design that has nothing
   to do with the person's clip. Nothing downstream re-checks — PATCH refuses
   to change `provenance`, promote's own `updateEntry` only touches `persona`,
   and every cast slot `/assign` wrote still carries
   `{ libraryUuid, provenance: 'cloned' }`. `libraryVoiceForEngine` resolves
   that slot, the artifact exists, and the chapter renders a stranger's
   synthesised voice under the cloned speaker's name, with no error and no
   badge change. That is Property 1's exact failure mode, reachable from the
   Edit button on a cloned card.

   Fails CLOSED with a 403 rather than inventing a re-consent flow or
   clearing the entry's cloned provenance + every slot referencing it. Both
   of those are live options and the choice between them is the repo owner's
   — this is the safe default until then, and it is trivially reversible.
   `PATCH /:voiceUuid` already enforces the same rule for the `persona` field
   itself (see its 400 below); these are the two routes that ACT on persona
   and were missing it. */
function clonedRedesignRefusal(
  entry: { provenance?: string } | null,
): { error: string } | undefined {
  if (entry?.provenance !== 'cloned') return undefined;
  return {
    error:
      'This voice was cloned from a recording, so it cannot be re-designed from a persona — ' +
      'doing so would replace the cloned voice with a synthesised one. Revoke this voice first ' +
      'if you want to design a new one.',
  };
}

/* POST /api/voice-library/:voiceUuid/redesign

   Stage a redesign of an existing library voice under `<storageKey>-preview`
   (preview:true) so the live `.pt` is untouched while the user A/B-compares.
   → 200 { previewUrl } — the A/B modal plays this against the live sample.
   → 403 when the entry is CLONED (see `clonedRedesignRefusal`). */
voiceLibraryRouter.post('/:voiceUuid/redesign', async (req: Request, res: Response) => {
  try {
    const { voiceUuid } = req.params;
    const entry = await readEntry(voiceUuid);
    if (!entry) return res.status(404).json({ error: `No voice-library entry "${voiceUuid}".` });
    const refusal = clonedRedesignRefusal(entry);
    if (refusal) return res.status(403).json(refusal);

    const body = (req.body ?? {}) as { persona?: unknown; modelKey?: unknown };
    const persona = typeof body.persona === 'string' ? body.persona.trim() : '';
    if (!persona) return res.status(400).json({ error: '`persona` is required.' });
    /* #1842 — the A/B modal's previewUrl must match the tier the live voice
       will later Play at, and both share the `qwen-<uuid>` cache scope.
       Omitted → 0.6B (resolveQwenModelKey — Finding 3). */
    const modelKey = resolveQwenModelKey(body.modelKey);
    if (!modelKey) {
      return res.status(400).json({ code: 'invalid_model', message: 'modelKey must be a Qwen model key.' });
    }

    const result = await withSingleFlight(voiceUuid, async () => {
      const { previewUrl } = await runVoiceDesign({
        storageKey: `qwen-${voiceUuid}`,
        displayName: entry.name,
        persona,
        languageCode: entry.languageCode,
        preview: true,
        modelKey,
      });
      return { previewUrl };
    });
    return res.status(200).json(result);
  } catch (e) {
    if (e instanceof DesignInFlightError) {
      return res.status(409).json({ error: 'design already running' });
    }
    console.error('[voice-library] redesign failed', e);
    return res
      .status(httpStatusForSidecarError(e))
      .json({ error: (e as Error).message || 'Voice redesign failed.' });
  }
});

/* POST /api/voice-library/:voiceUuid/redesign/promote

   Commit a staged redesign onto the live voice: move the preview `.pt`/`.json`
   onto the stable `qwen-<uuid>` id (rm-then-rename for Windows EPERM safety),
   THEN best-effort evict the sidecar's in-memory prompt cache — the same
   file-op-first ordering as qwen-voice.ts's promote-voice. Purges the cached
   auditions and bumps persona/updatedAt on the manifest. A missing preview
   `.pt` (nothing staged / double-promote) → 409 — checked via `stat` BEFORE
   the live `.pt` is removed (#1804), so a double-promote can't delete a live
   artifact when the replacement was never staged.

   GATE 1 fix (C1) — → 403 when the entry is CLONED. Guarded independently of
   `/redesign` above, not merely as a consequence of it: this is the handler
   that actually overwrites the live `.pt`, so it must refuse on its own even
   if a preview were staged some other way (a pre-fix preview still sitting on
   disk, a direct API call, a future stager). Placed BEFORE the preview `stat`
   so a cloned entry can never reach the `rm`+`rename`. */
voiceLibraryRouter.post('/:voiceUuid/redesign/promote', async (req: Request, res: Response) => {
  try {
    const { voiceUuid } = req.params;
    const entry = await readEntry(voiceUuid);
    if (!entry) return res.status(404).json({ error: `No voice-library entry "${voiceUuid}".` });
    const refusal = clonedRedesignRefusal(entry);
    if (refusal) return res.status(403).json(refusal);

    const storageKey = `qwen-${voiceUuid}`;
    const previewKey = `${storageKey}-preview`;

    try {
      await stat(qwenVoicePtPath(previewKey));
    } catch (e) {
      return res
        .status(409)
        .json({ error: `No staged preview voice to promote (${(e as Error).message}).` });
    }
    await rm(qwenVoicePtPath(storageKey), { force: true });
    await rename(qwenVoicePtPath(previewKey), qwenVoicePtPath(storageKey));
    await rm(qwenVoiceSidecarPath(storageKey), { force: true }).catch(() => {});
    await rename(qwenVoiceSidecarPath(previewKey), qwenVoiceSidecarPath(storageKey)).catch(() => {});

    /* Fix wave (consent-erasure gap, mirrors qwen-voice.ts's promote-voice) —
       carry the preview's retained reference clip (§2.3) onto the live key too.
       Best-effort like the .json above (only the .pt is required): a voice
       designed before this fix, or one whose sidecar never wrote a clip, has
       no `-preview__master.wav` to move — must not 409 the whole promote. */
    await rm(qwenVoiceWavPath(`${storageKey}__master`), { force: true }).catch(() => {});
    await rename(
      qwenVoiceWavPath(`${previewKey}__master`),
      qwenVoiceWavPath(`${storageKey}__master`),
    ).catch(() => {});

    /* Drop the stale live + preview auditions (both cached under storageKey) so
       the next "Play" re-synthesises from the promoted `.pt`. */
    purgeVoiceSamples(storageKey);

    /* Evict the live id from the sidecar's in-memory prompt cache — best-effort,
       AFTER the file op (a down/empty sidecar has nothing cached, and generation
       reads the fresh `.pt` from disk regardless). */
    try {
      await fetch(`${getResolvedSidecarUrl()}/qwen/evict-voice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceId: storageKey }),
      });
    } catch {
      /* sidecar unreachable — non-fatal */
    }

    const body = (req.body ?? {}) as { persona?: unknown };
    /* fs-38 Wave 3c, Task 14 — read+mutate+write through the shared,
       per-uuid-locked `updateEntry` rather than the `entry` read at the top
       of this handler: that read happened BEFORE the file-op/sidecar-evict
       work above, a long-enough window for a concurrent xtts derive
       (clone-voice-resolver.ts) to have written `engines.xtts` in the
       meantime — writing `entry`'s stale `engines` here would silently
       erase it. `updateEntry` re-reads fresh under the lock immediately
       before writing. */
    const updated = await updateEntry(voiceUuid, (fresh) =>
      fresh
        ? { ...fresh, ...(typeof body.persona === 'string' ? { persona: body.persona } : {}) }
        : null,
    );
    if (!updated) {
      return res.status(404).json({ error: `No voice-library entry "${voiceUuid}".` });
    }
    return res.status(200).json(updated);
  } catch (e) {
    console.error('[voice-library] redesign/promote failed', e);
    return res.status(500).json({ error: (e as Error).message || 'Promote failed.' });
  }
});

/* POST /api/voice-library/:voiceUuid/redesign/discard

   Drop a staged redesign preview (Cancel in the A/B compare). Best-effort
   cleanup of the preview `.pt`/`.json` + a sidecar evict of the preview key;
   NEVER touches the live voice. Always 200 once the uuid is known. */
voiceLibraryRouter.post('/:voiceUuid/redesign/discard', async (req: Request, res: Response) => {
  try {
    const { voiceUuid } = req.params;
    const entry = await readEntry(voiceUuid);
    if (!entry) return res.status(404).json({ error: `No voice-library entry "${voiceUuid}".` });

    const previewKey = `qwen-${voiceUuid}-preview`;
    await rm(qwenVoicePtPath(previewKey), { force: true }).catch(() => {});
    await rm(qwenVoiceSidecarPath(previewKey), { force: true }).catch(() => {});
    // Fix wave (consent-erasure gap) — erase the preview's retained reference
    // clip too (§2.3), mirroring the pt/json cleanup above. No-op when absent.
    await rm(qwenVoiceWavPath(`${previewKey}__master`), { force: true }).catch(() => {});
    try {
      await fetch(`${getResolvedSidecarUrl()}/qwen/evict-voice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceId: previewKey }),
      });
    } catch {
      /* sidecar unreachable — non-fatal */
    }
    return res.status(200).json({ discarded: true });
  } catch (e) {
    console.error('[voice-library] redesign/discard failed', e);
    return res.status(500).json({ error: (e as Error).message || 'Discard failed.' });
  }
});

/* Staleness is computed at list time (not persisted): a designed voice whose
   manifest recorded the Qwen base model it was derived from no longer
   matches the CURRENT base model once that model is upgraded. Returning
   'stale' here — without touching the on-disk manifest — lets the list
   route reflect an upgrade immediately, with no migration/backfill step.

   fs-38 Wave 3c, Task 18 — recomputes the `xtts` slot too, via the SAME
   `isArtifactVersionStale` comparand `clone-voice-resolver.ts`'s per-chapter
   classifier uses, so this list-time view can't silently disagree with what
   a chapter render would decide.

   fs-38 Wave 3c, Task 19 — Coqui now has a live "installed coqui-tts
   version" oracle: `getLastKnownCoquiVersion()`, fed by the sidecar's
   /health poll (routes/sidecar-health.ts), mirroring qwen's
   `currentQwenBaseModel()`. Before the first reachable poll (the boot
   window) it reads '', which `isArtifactVersionStale` treats as "unknown,
   never stale" (see its doc comment in clone-engines.ts) — the same
   fail-safe qwen's own '' (never-fetched) case already relies on, so a
   cold-started server can't flip every cloned coqui voice to 'stale' before
   the sidecar has answered even once. */
/* Plan 276 Decision 2 [R3] — a persisted `status: 'failed'` must survive this
   computation untouched. Before this fix, a failed-but-version-stale slot was
   overwritten to `'stale'` here, so the client (which only ever sees the
   post-this-function value) could never observe `derive-failed` — the render
   still hard-fails on the raw on-disk status
   (`clone-voice-resolver.ts:238` checks `'failed'` first), so the mismatch
   was a false negative in the cast-time check, not a cosmetic one.
   Staleness of a failed artifact is meaningless: nothing will re-derive it
   until the failure itself is cleared (see the retry route), so there is
   nothing to report as merely "stale" underneath it.

   Plan 276 Task 8 — exported so the co-oracle contract test
   (`server/src/tts/clone-readiness-contract.test.ts`) can route its client
   side through the REAL transform rather than a reimplementation. See that
   file's header for why a reimplementation would be blind to exactly the
   class of bug this function exists to fix. */
export function withComputedStaleness(entry: VoiceLibraryEntry): VoiceLibraryEntry {
  let result = entry;
  const qwen = entry.engines.qwen;
  if (qwen && qwen.status !== 'failed' && isArtifactVersionStale(qwen.baseModel, currentQwenBaseModel())) {
    result = { ...result, engines: { ...result.engines, qwen: { ...qwen, status: 'stale' } } };
  }
  const xtts = entry.engines.xtts;
  if (xtts && xtts.status !== 'failed' && isArtifactVersionStale(xtts.coquiVersion, getLastKnownCoquiVersion())) {
    result = { ...result, engines: { ...result.engines, xtts: { ...xtts, status: 'stale' } } };
  }
  return result;
}

function sortEntries(entries: VoiceLibraryEntry[]): VoiceLibraryEntry[] {
  return [...entries].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
}

voiceLibraryRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const entries = await listEntries();
    const voices = sortEntries(entries).map(withComputedStaleness);
    res.json({ voices });
  } catch (e) {
    console.error('[voice-library] list failed', e);
    res.status(500).json({ error: (e as Error).message || 'Voice library list failed.' });
  }
});

interface PatchBody {
  name?: unknown;
  tags?: unknown;
  pinned?: unknown;
  persona?: unknown;
  provenance?: unknown;
  transcript?: unknown;
}

voiceLibraryRouter.patch('/:voiceUuid', async (req: Request, res: Response) => {
  try {
    const { voiceUuid } = req.params;
    const existing = await readEntry(voiceUuid);
    if (!existing) {
      return res.status(404).json({ error: `No voice-library entry "${voiceUuid}".` });
    }

    const body = (req.body ?? {}) as PatchBody;

    if (body.provenance !== undefined) {
      return res.status(400).json({ error: '`provenance` cannot be changed.' });
    }
    if (body.persona !== undefined && existing.provenance !== 'designed') {
      return res
        .status(400)
        .json({ error: '`persona` can only be set on a designed voice.' });
    }
    if (body.name !== undefined && typeof body.name !== 'string') {
      return res.status(400).json({ error: '`name` must be a string.' });
    }
    if (body.tags !== undefined && !isStringArray(body.tags)) {
      return res.status(400).json({ error: '`tags` must be an array of strings.' });
    }
    if (body.pinned !== undefined && typeof body.pinned !== 'boolean') {
      return res.status(400).json({ error: '`pinned` must be a boolean.' });
    }
    if (body.persona !== undefined && typeof body.persona !== 'string') {
      return res.status(400).json({ error: '`persona` must be a string.' });
    }
    /* Plan 276 Decision 6 — a clone's reference transcript becomes editable
       after the fact (the "Add transcript" cast-time-gate CTA). Only a
       cloned entry that actually carries a master clip has a transcript to
       edit at all — a designed/imported voice, or a cloned entry whose
       master is somehow absent, has nothing for this to mean.

       #2068 item 3 (fs-38) — the `master` existence check distinguishes two cases:
       1. Permanently absent (never cloned with a master, or revoked long ago):
          `existing.master` is already undefined at the pre-lock read. This is
          not a race — validate and reject here with 400.
       2. Race condition (master was present in `existing` but disappears before
          the post-lock `fresh` read): validate pre-lock that `existing.master`
          exists, then check post-lock in `updateEntry`'s callback on `fresh.master`.
          If it vanished, return 409 Conflict. */
    if (body.transcript !== undefined) {
      if (existing.provenance !== 'cloned' || !existing.master) {
        return res
          .status(400)
          .json({ error: '`transcript` can only be set on a cloned voice with a master clip.' });
      }
      if (typeof body.transcript !== 'string') {
        return res.status(400).json({ error: '`transcript` must be a string.' });
      }
      /* #1836's cap, reused rather than duplicated — see MAX_CLONE_TRANSCRIPT_CHARS's
         own doc comment for why 2000 characters bounds the wire even for a
         multi-byte-heavy correction. */
      if (body.transcript.length > MAX_CLONE_TRANSCRIPT_CHARS) {
        return res
          .status(400)
          .json({ error: `Transcript is too long (max ${MAX_CLONE_TRANSCRIPT_CHARS} characters).` });
      }
    }

    /* fs-38 Wave 3c, Task 14 — mutate/write through the shared, per-uuid-
       locked `updateEntry`, spreading over a FRESH `fresh` (read under the
       lock), not the `existing` read above. `existing` is only used for the
       validation checks above (all timing-insensitive: 404 on missing, and
       `provenance` is immutable so its value can't have changed between the
       two reads) — but writing `existing`'s `engines` back would silently
       clobber a concurrent engine-slot write (e.g. an in-flight xtts
       derive) that landed in the window between this handler's first read
       and its write. The transcript edit below applies that SAME reasoning
       to `master`/`engines`: it mutates off `fresh`, never `existing`.

       #2068 item 3 (fs-38) — the `master` existence check moved here from
       the pre-lock block above, into the `body.transcript !== undefined`
       branch below. If `fresh.master` is absent at that point (the entry
       was cloned and HAD a master when `existing` was read, but the master
       clip was removed before the lock was acquired), the request is in
       conflict with the current state of the resource: return 409 and
       perform no write, rather than silently writing nothing and returning
       200. The flag is set inside the callback (under the lock) and checked
       after `updateEntry` resolves — same pattern the retry route below
       uses for `entryFound`/`noop`. */
    let conflict = false;
    const written = await updateEntry(voiceUuid, (fresh) => {
      if (!fresh) return null;
      let next: VoiceLibraryEntry = {
        ...fresh,
        ...(body.name !== undefined ? { name: body.name as string } : {}),
        ...(body.tags !== undefined ? { tags: body.tags as string[] } : {}),
        ...(body.pinned !== undefined ? { pinned: body.pinned as boolean } : {}),
        ...(body.persona !== undefined ? { persona: body.persona as string } : {}),
      };
      if (body.transcript !== undefined) {
        const master = fresh.master;
        /* #2068 item 3 — distinguish the race condition from permanent absence:
           - If existing.master exists (pre-lock read), but fresh.master doesn't
             (post-lock read), the resource changed underneath the request and
             we return 409 Conflict (set flag, return undefined to skip write).
           - If existing.master was already absent, the pre-lock check above
             would have rejected this, so we'd never reach here.
           In both cases, return undefined (don't write). */
        if (!master) {
          if (existing.master) {
            conflict = true;
          }
          return undefined;
        }
        const transcript = body.transcript as string;
        /* Plan 276 Decision 6 [R3] — three invalidations a transcript edit
           must carry, none of which is "re-derive the qwen .pt":

           1. `entry.sampleTranscript` is a SECOND persisted copy of the
              same text, written from `refText` at clone time (see the
              /clone handler above, ~:1115). Leaving it stale makes the two
              disagree and the UI read the wrong one.
           2. `master.languageCode` / `entry.languageCode` are Whisper
              stamps promoted from the ORIGINAL clip at clone time. A
              user-edited transcript may be in a different language, so a
              stamp that used to describe the clip now contradicts the
              text. Cleared rather than guessed — re-detecting would need a
              real Whisper call inside this handler for no clear benefit,
              and `entry.languageCode` specifically feeds
              `sidecarLanguageName` (tts/language.ts), which THROWS on an
              unregistered code, so inventing a value here is strictly more
              dangerous than the "no language" state a clip in an
              unsupported language already reaches via the /clone handler's
              own `clipLanguage` branch (workspace/voice-library.ts's
              `VoiceMaster.languageCode` doc comment). Clearing lands in
              that same, already-supported state.
           3. The qwen `.pt` distilled against the OLD ref text is
              DELIBERATELY left alone — it is acoustic, not lexical. A
              corrected transcript changes what a FUTURE derive scores/
              distills against, not the sound already baked into today's
              artifact. Do not "fix" this by invalidating it. */
        next = {
          ...next,
          sampleTranscript: transcript,
          master: { ...master, transcript, transcriptSource: 'user', languageCode: undefined },
          languageCode: undefined,
        };
        /* Decision 6's third clause — a non-empty corrected transcript
           removes the CAUSE of a qwen `no-transcript`-flavoured derive
           failure, so the terminal `failed` stamp comes off (same
           slot-deletion mechanism as the retry route below). `''` clears
           the text but supplies no fix, so it must NOT clear the stamp —
           only qwen's derive needs a transcript at all (Coqui's clone is
           purely acoustic, tts/derive-engine-artifact.ts), so only the
           qwen slot is a candidate here. */
        if (transcript.trim() && next.engines.qwen?.status === 'failed') {
          const restEngines = { ...next.engines };
          delete restEngines.qwen;
          next = { ...next, engines: restEngines };
        }
      }
      return next;
    });
    if (conflict) {
      return res
        .status(409)
        .json({ error: '`master` clip was removed before this transcript edit could be applied.' });
    }
    if (!written) {
      return res.status(404).json({ error: `No voice-library entry "${voiceUuid}".` });
    }
    /* Plan 276 Decision 2 [R4] — this response goes through
       `withComputedStaleness` for the same reason `GET /` does, and it is
       load-bearing rather than cosmetic. `patchEntry.fulfilled`
       (src/store/voice-library-slice.ts:237-240) REPLACES the slice's entry
       with whatever this returns, so a raw response silently downgrades the
       client's copy from the computed status to the persisted one. A
       version-stale-but-`ready` slot then reads `'ready'` on the client
       instead of `'stale'`, and `cloneReadiness`'s rules 5/6 — gated on
       `slotStatus !== 'ready'` — stop firing. That is a false negative of
       exactly the class that killed rev 2, and the plan's own "Add
       transcript" flow triggers it: the CTA PATCHes, this response lands in
       the slice, and the gate can then clear for the wrong reason. Every
       route that hands an entry to the client must apply the same transform
       or the "post-`withComputedStaleness`" contract is only true until the
       first write. */
    res.json(withComputedStaleness(written));
  } catch (e) {
    console.error('[voice-library] patch failed', e);
    res.status(500).json({ error: (e as Error).message || 'Voice library update failed.' });
  }
});

/* POST /api/voice-library/:voiceUuid/engines/:engine/retry — plan 276
   Decision 7.

   Deletes the engine's slot key from `entry.engines` (through the same
   per-uuid-locked `updateEntry` the transcript edit above uses) rather than
   rewriting its `status`: `VoiceLibraryEngineStatus.status` is required
   (workspace/voice-library.ts), so there is no "unset" value to write, and
   an absent slot already flows correctly through `classifyClonedVoice`
   (clone-voice-resolver.ts:241-246) as "never derived". A fresh derive
   rewrites the slot with its own version stamp. Nothing else needs
   resetting — `master`, the clip file and the qwen `.pt` all stay exactly
   as they are.

   No-op (200, entry unchanged), not an error, when the slot isn't `failed`
   — a `ready` slot needs no retry, and an absent slot has nothing to clear.
   Distinguishing "slot present but healthy" from "slot absent" would add a
   branch that behaves identically either way, so both fall through the same
   early return.

   [R3] Why this does not reintroduce the loop the `failed` stamp exists to
   prevent. `cloneReadiness`'s rule 4 (`slotStatus === 'failed'` ->
   `derive-failed`) is ordered BEFORE rules 5/6 (`missing-master` /
   `no-transcript`) — see clone-readiness.ts. Once this route deletes the
   stamp, the predicate re-evaluates the UNDERLYING cause on the next
   check: a derive-failed voice with a blank transcript immediately reports
   `no-transcript` again, and the cast-time gate stays up with the CTA that
   actually fixes it. Only a failure whose cause isn't expressible in rules
   5-6 (e.g. a transient sidecar OOM) clears to "ready to try" and can fail
   again on the next derive — that residue is real and is why the CTA is
   labelled "Retry derive", not "Fix"; a repeat failure simply re-stamps
   `failed`. The policy `clone-voice-resolver.ts:229-231` protects is that a
   failed derive is never SILENTLY retried (i.e. auto-retried on every
   render); this is a user-initiated, explicit clear, not that. */
voiceLibraryRouter.post('/:voiceUuid/engines/:engine/retry', async (req: Request, res: Response) => {
  try {
    const { voiceUuid } = req.params;
    const engineParam = req.params.engine as TtsEngine;
    if (!isCloneEngine(engineParam)) {
      return res.status(400).json({ error: `"${req.params.engine}" is not a clone-capable engine.` });
    }
    const slotKey = manifestSlotFor(engineParam);

    /* `entryFound`/`noop` are set from INSIDE the locked mutate callback,
       not from a separate pre-lock read — the lock's own `fresh` read is
       the single source of truth for both "does this uuid exist" and
       "does the slot need clearing", so there's no separate stale read to
       drift from it. Returning `undefined` from the callback tells
       `updateEntry` to skip the write entirely (see its own doc comment on
       :297) — the true no-op case never touches disk, so `updatedAt` (and
       everything else) really is unchanged, not merely content-equal. */
    let entryFound = true;
    let noop: import('../workspace/voice-library.js').VoiceLibraryEntry | null = null;
    const written = await updateEntry(voiceUuid, (fresh) => {
      if (!fresh) {
        entryFound = false;
        return null;
      }
      if (fresh.engines[slotKey]?.status !== 'failed') {
        noop = fresh;
        return undefined;
      }
      const restEngines = { ...fresh.engines };
      delete restEngines[slotKey];
      return { ...fresh, engines: restEngines };
    });

    if (!entryFound) {
      return res.status(404).json({ error: `No voice-library entry "${voiceUuid}".` });
    }
    /* Plan 276 Decision 2 [R4] — same transform as the PATCH above and for
       the same reason: whatever this returns is what the client's slice
       holds next. The no-op path needs it too — a `ready`-but-version-stale
       slot is precisely the case that no-ops here AND is rewritten by the
       transform, so returning it raw is the one shape where skipping this
       actually changes the answer. */
    if (!written) {
      /* `noop` is set by the locked callback on exactly this path. The guard
         is for TypeScript — it cannot narrow a variable assigned inside a
         callback — but it is a real 500 rather than a silent `null` body if
         the two paths ever drift apart. */
      if (!noop) throw new Error('retry reached the no-op path with no entry captured');
      return res.json(withComputedStaleness(noop));
    }
    res.json(withComputedStaleness(written));
  } catch (e) {
    console.error('[voice-library] retry failed', e);
    res.status(500).json({ error: (e as Error).message || 'Voice engine retry failed.' });
  }
});

/* POST /api/voice-library/:voiceUuid/sample

   Mirrors POST /api/voices/:voiceId/sample (routes/voice-sample.ts) for a
   library voice: synthesise (or serve cached) a short preview via the
   library's Qwen storageKey.

   RECONCILIATION (fs-38 Wave 1, Task 10): the plan's original design called
   for a separate `lib-<uuid>` cache scope, but Task 9's design/redesign/
   promote routes above already cache auditions under `qwen-<uuid>` (the
   storageKey itself — see runVoiceDesign's `cacheScope: opts.storageKey`).
   Using that SAME scope here means one cache namespace per library voice —
   a Play click right after a design/promote reuses the freshly-warmed
   audition instead of re-synthesising, and ONE `purgeVoiceSamples` call
   (either here or in the DELETE route below) clears every cached preview
   for the voice. A separate `lib-` namespace would have needed its own
   purge call and never benefited from the design-time warm cache — no
   consumer needs the two namespaces kept apart.

   `contentToken = djb2(entry.persona)` busts the cache on a persona edit
   even when the request text/voiceName are otherwise unchanged (Wave 3
   swaps in a master-clip hash for cloned voices instead).

   fs-38 Wave 3c, Task 27 — `modelKey` now selects the ENGINE to audition,
   not just the Qwen tier: `voiceName`/`cacheScope` follow `engineForModelKey`
   via the shared `cloneStorageKey` (tts/clone-engines.js — never hand-built,
   Task 15 was rejected for reimplementing this helper). Before this task the
   route hardcoded `qwen-<uuid>`, so a card's Coqui chip Played the QWEN
   artifact — 409ing whenever qwen was stale/missing even though xtts was
   ready — and Task 13's `xtts-<uuid>` purge had no cache entries under that
   scope to ever reach. Restricted to the two clone-capable engines
   (`isCloneEngine`) because a library entry's `engines` map only ever
   carries a `qwen` and/or `xtts` slot; omitted → the 0.6B Qwen base, which
   is what a caller that sends no `modelKey` at all still gets.

   GATE 1 — this used to add "keeping the current frontend caller (which
   still only ever sends a Qwen tier) working unchanged". That was true when
   written and stopped being true in 918cbff5: `VoiceLibraryCard.playSample`
   (src/components/voices/voice-library-card.tsx) now picks its preview
   engine off the entry's own slot statuses — qwen when `engines.qwen` reads
   `ready`, else coqui when `engines.xtts` does — so this route's Coqui arm
   IS reached from the UI, not just from an API client. Do not treat the
   coqui path here as untrodden. */
voiceLibraryRouter.post('/:voiceUuid/sample', async (req: Request, res: Response) => {
  /* Hoisted above the try so the catch below can name which engine the
     un-derived-artifact 409 (below) is about — assigned only once the
     modelKey has resolved to a clone-capable engine. */
  let engine: TtsEngine | undefined;
  try {
    const { voiceUuid } = req.params;
    const entry = await readEntry(voiceUuid);
    if (!entry) return res.status(404).json({ error: `No voice-library entry "${voiceUuid}".` });
    if (clonedVoiceLacksConsent(entry)) {
      return res.status(403).json({ error: 'This cloned voice has no valid consent and cannot be played.' });
    }

    const body = (req.body ?? {}) as { text?: unknown; modelKey?: unknown };
    /* #1842 — the card previews at the tier/engine the caller's session will
       render at, so the same voice doesn't sound different on the card and
       on the cast row. Omitted → the 0.6B Qwen base. */
    if (body.modelKey !== undefined && !isTtsModelKey(body.modelKey)) {
      return res.status(400).json({ code: 'invalid_model', message: 'modelKey is not a recognised TTS model key.' });
    }
    const modelKey: TtsModelKey = body.modelKey === undefined ? 'qwen3-tts-0.6b' : body.modelKey;
    const resolvedEngine = engineForModelKey(modelKey);
    if (!isCloneEngine(resolvedEngine)) {
      return res
        .status(400)
        .json({ code: 'invalid_model', message: 'modelKey must route to a clone-capable engine (Qwen or Coqui).' });
    }
    engine = resolvedEngine;

    const text =
      typeof body.text === 'string' && body.text.trim().length > 0
        ? body.text.trim()
        : buildSampleText({ id: voiceUuid, character: entry.name, overrideTtsVoices: {} });
    /* `cacheScope` IS `voiceName` — both the engine's storage key for this
       library voice, DERIVED (never hand-built) via `cloneStorageKey`.
       Deriving it from (engine, voiceUuid) alone is what lets Task 13's
       storageKey-scoped sample purge reach the cached audition on
       revoke/delete regardless of which engine it was played on. */
    const voiceName = cloneStorageKey(engine, voiceUuid);
    const cacheScope = voiceName;
    /* Finding 1 (#1842 review) — runVoiceDesign (design-voice-core.ts) derives
       this SAME token from opts.persona for a live design, so a /design
       (or /redesign's promoted) audition and this route's first Play land on
       the identical filename instead of silently missing cache. Keep the two
       derivations byte-identical if either ever changes. */
    const contentToken = entry.persona ? djb2(entry.persona).toString(36) : undefined;

    const fileName = voiceSampleFileName({ cacheScope, modelKey, text, voiceName }, contentToken);
    const filePath = voiceSampleFilePath(fileName);
    const publicUrl = voiceSamplePublicUrl(fileName);

    if (existsSync(filePath)) {
      return res.json({ url: publicUrl, cached: true });
    }

    await mkdir(voiceSampleAudioDir(), { recursive: true });

    const provider = selectTtsProvider(modelKey);
    const { pcm, sampleRate } = await provider.synthesize({ text, voiceName, modelKey });
    const mp3 = await encodePcmToAudio(pcm, sampleRate);
    await writeFile(filePath, mp3);
    return res.json({ url: publicUrl, cached: false });
  } catch (e) {
    /* #1801 doc comment on httpStatusForSidecarError flagged this as the
       deliberate follow-up: the sidecar's `voice_not_designed` 409 (raised
       for EVERY engine — server/tts-sidecar/main.py's generic /synthesize
       handler, not a Qwen-specific path) used to reach the caller as an
       opaque 502 (4xx never passes through that helper) with the sidecar's
       raw JSON body as the message. A lazily-derived engine (most commonly
       an xtts slot nobody has rendered a chapter on yet) hits this exactly
       the way a stale/never-designed qwen slot always could — translate it
       to a clean, engine-aware 409 instead, mirroring the sibling
       POST /api/voices/:voiceId/sample (routes/voice-sample.ts). */
    const msg = (e as Error).message ?? '';
    /* GATE 1 — same gap as the sibling voice-sample.ts arm: the sidecar's
       `voice_language_unsupported` 409 says the voice IS cloned and loaded
       but the loaded XTTS model can't speak the requested language. Its
       detail matches neither token in the arm below, so it fell through to
       `httpStatusForSidecarError` — which deliberately never forwards a 4xx —
       and surfaced as an opaque 502 carrying the sidecar's raw JSON. Ordered
       FIRST, mirroring the sidecar's own MIN-4 ordering (the Python exception
       subclasses VoiceNotDesignedError). Not gated on `engine` unlike the arm
       below: this condition is raised only by the Coqui/XTTS branch, so there
       is no engine name to disambiguate. Chapter render is NOT affected — it
       never routes through this route's catch. */
    if (/voice_language_unsupported/i.test(msg)) {
      return res.status(409).json({
        code: 'voice_language_unsupported',
        message:
          'This voice cannot speak the requested language on the loaded Coqui model — re-preparing it will not help.',
      });
    }
    if (engine && /voice_not_designed|not been designed yet/i.test(msg)) {
      return res.status(409).json({
        code: 'voice_not_designed',
        message: `This voice hasn't been prepared on ${engine === 'coqui' ? 'Coqui' : 'Qwen'} yet.`,
      });
    }
    console.error('[voice-library] sample failed', e);
    return res
      .status(httpStatusForSidecarError(e))
      .json({ error: (e as Error).message || 'Voice sample failed.' });
  }
});

interface AssignBody {
  bookId?: unknown;
  characterId?: unknown;
  /** Fix wave 2 (review) — the model key the CALLER actually intends to
      render with (e.g. the profile drawer's PENDING engine-picker choice,
      not yet Saved). Optional; the wrong-engine guard below falls back to
      the persisted account default when absent. See the guard's own
      comment for why the persisted default alone was unsound. */
  modelKey?: unknown;
}

interface CastJson {
  characters?: CastCharacter[];
}

interface PromoteBody {
  bookId?: unknown;
  characterId?: unknown;
  name?: unknown;
}

/* POST /api/voice-library/promote

   Promote a confirmed-cast character's designed voice into the standalone
   library. Mints a NEW library uuid — from this point the promoted voice is
   independent of the origin character. Resolves the character's TRUE source
   storage key with the SAME ordering `pickVoiceForEngine` uses for the qwen
   engine (tts/voice-mapping.ts:335-339): an `overrideTtsVoices.qwen.libraryUuid`
   assignment wins outright, else fall back to `qwenStorageKey` — so both a
   library-assigned character (whose `overrideTtsVoices.qwen.libraryUuid`
   points at another voice's storage) and a reused/matched character (whose
   `voiceUuid` points at another voice's storage) copy from that SOURCE `.pt`,
   not a nonexistent character-id-keyed one (spec §2.2 edge rule). When no
   source `.pt` exists yet, the entry is still
   created — persona-only, `engines.qwen.status: 'stale'` — rather than
   throwing; the voice can be derived on demand later. Registered as a
   literal `/promote` path (not `/:voiceUuid/...`) since there is no
   voiceUuid yet — one is minted inside the handler. The origin character/
   cast.json is NEVER modified. */
voiceLibraryRouter.post('/promote', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as PromoteBody;
    const bookId = typeof body.bookId === 'string' ? body.bookId : undefined;
    const characterId = typeof body.characterId === 'string' ? body.characterId : undefined;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!bookId || !characterId || !name) {
      return res
        .status(400)
        .json({ error: '`bookId`, `characterId`, and `name` are required.' });
    }

    const located = await findBookByBookId(bookId);
    if (!located) {
      return res.status(404).json({ error: `No book "${bookId}".` });
    }

    const cast = await readJson<CastJson>(castJsonPath(located.bookDir));
    const characters = cast?.characters ?? [];
    const character = characters.find((c) => c.id === characterId);
    if (!character) {
      return res
        .status(404)
        .json({ error: `No character "${characterId}" in book "${bookId}".` });
    }

    /* fs-38 Wave 1 review fix — mirror pickVoiceForEngine's qwen-branch
       ordering (tts/voice-mapping.ts:335-339): an explicit voice-library
       assignment (`overrideTtsVoices.qwen.libraryUuid`, set by /assign
       WITHOUT touching `character.voiceUuid`) wins outright; only fall back
       to the character-id-derived qwenStorageKey when no libraryUuid is set. */
    const assignedLibraryUuid = character.overrideTtsVoices?.qwen?.libraryUuid;
    const sourceKey = assignedLibraryUuid
      ? `qwen-${assignedLibraryUuid}`
      : qwenStorageKey({ voiceUuid: character.voiceUuid, voiceId: character.voiceId }, characterId);
    const libraryUuid = nanoid();
    const targetKey = `qwen-${libraryUuid}`;

    let qwenStatus: VoiceLibraryEngineStatus;
    if (existsSync(qwenVoicePtPath(sourceKey))) {
      await copyFile(qwenVoicePtPath(sourceKey), qwenVoicePtPath(targetKey));
      if (existsSync(qwenVoiceSidecarPath(sourceKey))) {
        await copyFile(qwenVoiceSidecarPath(sourceKey), qwenVoiceSidecarPath(targetKey));
      }
      qwenStatus = { status: 'ready', baseModel: currentQwenBaseModel() };
    } else {
      /* No designed `.pt` yet (character was never actually designed) —
         persist the persona anyway; nothing to throw over. */
      qwenStatus = { status: 'stale' };
    }

    const now = new Date().toISOString();
    const entry: VoiceLibraryEntry = {
      voiceUuid: libraryUuid,
      name,
      provenance: 'designed',
      tags: [],
      pinned: false,
      ...(character.voiceStyle ? { persona: character.voiceStyle } : {}),
      engines: { qwen: qwenStatus },
      promotedFrom: { bookId, characterId },
      createdAt: now,
      updatedAt: now,
    };
    await writeEntry(entry);
    return res.status(201).json(await readEntry(libraryUuid));
  } catch (e) {
    console.error('[voice-library] promote failed', e);
    return res.status(500).json({ error: (e as Error).message || 'Voice promotion failed.' });
  }
});

/* POST /api/voice-library/clone-sample

   fs-38 Wave 3a, Task 6 — ingest a captured/uploaded voice clip into a
   normalized clone-sample candidate (decode → quality gate → cap 60s → WAV →
   candidate store → Whisper transcript; see tts/clone-ingest.ts). No clip
   preview URL yet (out of scope for 3a) — the response carries just the
   candidateId + transcript. Registered as a literal `/clone-sample` path;
   there is no single-segment `POST /:voiceUuid` on this router, so it can't
   be shadowed regardless of registration order (verified — see plan). */
voiceLibraryRouter.post(
  '/clone-sample',
  (req: Request, res: Response, next: (err?: unknown) => void) => {
    cloneUpload.single('audio')(req, res, (err: unknown) => {
      if (err) {
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: 'Sample too large (max 25 MB).' });
        }
        return res.status(400).json({ error: (err as Error).message || 'Upload error.' });
      }
      next();
    });
  },
  async (req: Request, res: Response) => {
    try {
      const file = req.file;
      if (!file?.buffer?.length) return res.status(400).json({ error: 'No audio uploaded (use the "audio" field).' });
      const captureMethod = (req.body?.captureMethod === 'record' ? 'record' : 'upload') as 'record' | 'upload';
      const candidateId = randomUUID();
      const result = await ingestCloneSample(file.buffer, { captureMethod, candidateId });
      return res.status(202).json(result);
    } catch (e) {
      const status = (e as { status?: number }).status ?? 502;
      return res.status(status).json({ error: (e as Error).message || 'Clone-sample ingest failed.' });
    }
  },
);

/* POST /api/voice-library/clone

   fs-38 Wave 3b1 phase-2 orchestrator. Consumes a 3a candidate, derives the
   Qwen clone artifact, auditions + ECAPA-scores it, and atomically persists a
   `cloned` entry — the atomicity guarantee is ORDERING, not re-validation:
   `writeEntry` (which internally runs `assertConsentForClone`) is called only
   as the LAST step, after derive succeeds and the fidelity check either
   succeeds or fails transiently (Task 10 — a merely-unreachable ECAPA
   /embed is advisory, not blocking; see the fidelity try/catch below), so
   no entry is written if any OTHER earlier step throws (spec §7).
   SidecarDesignError status is preserved (503/502/500) by duck-typing the
   error's shape in the catch below — NOT `instanceof`, because the real
   sidecar-transport error crosses a module boundary (and tests reject with
   structurally-equal fakes) — not flattened like the /design + /redesign
   catches (#1801). */
voiceLibraryRouter.post('/clone', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    candidateId?: unknown;
    consent?: unknown;
    name?: unknown;
    transcript?: unknown;
  };
  const candidateId = typeof body.candidateId === 'string' ? body.candidateId : '';
  if (!candidateId) return res.status(400).json({ error: '`candidateId` is required.' });
  /* #1836 — `transcript` is the first CLIENT-controlled value to reach
     deriveEngineArtifact's `refText` (and, via master.transcript, every later
     re-derive), so it is bounded. Characters only: see the constant above for
     why that also bounds the base64 header in bytes, and why a separate byte
     check would be unreachable at this cap.

     Rejected outright rather than truncated: silently dropping the tail of a
     correction would persist a PARTIAL transcript as `transcriptSource:
     'user'`, which every subsequent repair would then faithfully re-derive
     from — the same silent-discard shape this whole change exists to fix. */
  if (typeof body.transcript === 'string' && body.transcript.length > MAX_CLONE_TRANSCRIPT_CHARS) {
    return res
      .status(400)
      .json({ error: `Transcript is too long (max ${MAX_CLONE_TRANSCRIPT_CHARS} characters).` });
  }
  const consentDraft = validateConsentDraft(body.consent);
  if (!consentDraft) {
    return res
      .status(422)
      .json({ error: 'A complete consent record (person, relationship, permitted use) is required.' });
  }
  /* #1959 — a non-self relationship must never fall back to personName: for
     `guardian-of-minor` that would persist a record asserting the minor
     attested to their own voice being cloned, the exact defect #1943 exists
     to fix. `personName` IS the attester only for `self`, so that is the
     one relationship allowed to omit `attestedBy`. Checked here, before any
     candidate/GPU work, so an incomplete caller never reaches a
     partially-completed clone. */
  if (consentDraft.relationship !== 'self' && !consentDraft.attestedBy) {
    return res.status(400).json({
      error: '`consent.attestedBy` is required when `consent.relationship` is not "self".',
    });
  }

  try {
    const entry = await withSingleFlight(`library:new:${candidateId}`, async () => {
      const candidate = await readCandidate(candidateId);
      if (!candidate) throw new CloneCandidateMissingError(candidateId);

      const voiceUuid = randomUUID();
      const masterWav = await readFile(candidateMasterPath(candidateId));
      const masterPcm = await decodeAudioToPcm(masterWav, candidate.master.sampleRate);

      /* #1836 — the wizard's transcript box is editable, so an optional
         corrected `transcript` on the request wins over the candidate's
         Whisper text as the `ref_text` the clone is distilled against.

         Blank/whitespace falls back to the Whisper transcript rather than
         erroring: Whisper itself can legitimately return an empty transcript
         for a non-speech clip (tts/clone-ingest.ts trims `.text`), so a blank
         value carries no correction to honour.

         `transcriptSource` is decided HERE, by comparing against the stored
         Whisper text — not taken from a client-supplied "was edited" flag —
         so it can't disagree with the text actually persisted below. */
      const suppliedTranscript = typeof body.transcript === 'string' ? body.transcript.trim() : '';
      const refText = suppliedTranscript || candidate.master.transcript;
      const transcriptSource: VoiceMaster['transcriptSource'] =
        suppliedTranscript && suppliedTranscript !== candidate.master.transcript
          ? 'user'
          : candidate.master.transcriptSource;

      /* #1951 — the reference clip's own language, as Whisper detected it at
         ingest. Governs the clone's MANIFEST: the wizard's completion audition
         and the language the Voice Library displays (routes/voices.ts reads the
         manifest word back via `codeForSidecarName`). It does NOT govern book
         synth — there the book's language wins and overrides this.

         Gated on `isSupportedLanguage` because `sidecarLanguageName` throws for
         anything the registry doesn't know, and a clip in an unsupported
         language must NOT fail the clone: the voice is perfectly usable, we
         just can't label it. Unknown/unsupported → send no `X-Language`, leave
         `languageCode` unset, and the sidecar computes its "English" default
         exactly as it always has. Never guess English explicitly. */
      const detectedLanguage = candidate.master.languageCode;
      const clipLanguage =
        detectedLanguage && isSupportedLanguage(normaliseBookLanguage(detectedLanguage))
          ? normaliseBookLanguage(detectedLanguage)
          : undefined;

      const derived = await deriveEngineArtifact(voiceUuid, 'qwen', {
        masterPcm,
        sampleRate: candidate.master.sampleRate,
        refText,
        ...(clipLanguage ? { language: sidecarLanguageName(clipLanguage) } : {}),
      });

      const dir = entryDir(voiceUuid);
      await mkdir(dir, { recursive: true });

      /* Score fidelity on the previewPcm already in hand — NOT a persisted
         file. 3b1 does not write a `preview.mp3`: the user-facing audition
         is served later by the existing POST /:uuid/sample route + its
         sample cache (a re-synth off the cloned .pt). On-disk layout for a
         3b1 cloned entry is master.wav + voice.json only (the .pt lives
         under voices/qwen/, keyed by voiceUuid — see entryDir vs. the
         sidecar's own voice dir).

         Task 10 follow-up: by this point the sidecar has ALREADY written
         the .pt (deriveEngineArtifact succeeded above) — assessCloneFidelity
         is an ADVISORY quality check on top of a real, usable clone. If the
         ECAPA /embed call itself is merely unreachable (embed-client.ts
         tags the thrown Error `{ transient: true }`), aborting here would
         orphan that .pt and leak the candidate for no benefit — the clone
         still works, we just couldn't score it. So a transient throw is
         swallowed and the clone proceeds without a cosine.

         Predicate: `isTransient` (tts/retry.ts) — the SAME `err.transient
         === true` duck-type the TTS auto-retry path already uses, not
         re-invented here. Deliberately NOT widened to "no numeric status
         => transport", the heuristic clone-voice-resolver.ts's
         isTransientDeriveFailure uses for SidecarDesignError-shaped repair
         failures: every throw inside assessCloneFidelity funnels through
         embed-client.ts's embedSegment, which already tags EVERY one of its
         throw paths with an explicit `transient` boolean (network-unreachable
         => true, HTTP 5xx => true, HTTP 4xx => false — see embed-client.ts)
         and never sets `.status`. A "no status" fallback would therefore
         swallow that explicit `transient: false` (a 4xx really is permanent)
         AND any unrelated code-level bug (e.g. a malformed embedding tripping
         cosineToCentroid) as mere "fidelity unavailable" — masking real
         defects behind a silent 200 instead of surfacing them. Any non-
         transient throw (an explicit 4xx, or a genuine SidecarDesignError
         surfaced from a shared client) still aborts — handled by the outer
         catch's existing duck-typed status mapping.

         NoCapacityError is a SEPARATE special case, ALSO treated as
         "fidelity unavailable" here: embed-client.ts's embedSegment
         deliberately rethrows it bare (see embed-client.ts:73) rather than
         tagging it `transient: true`, because in the SYNTH path a capacity
         error is genuinely non-retryable (replaying the same doomed call
         against a still-full GPU wastes a retry budget for nothing — see
         tts-errors.ts's NoCapacityError doc comment). But this is the
         CLONE ROUTE's ADVISORY fidelity step, not a synth path: by this
         point deriveEngineArtifact has already succeeded and written the
         .pt, so a GPU-contention failure of the /embed call is exactly as
         recoverable-by-not-scoring as a transport failure — aborting here
         would orphan that .pt and leak the candidate for no benefit, same
         as the transient case above. This does NOT change NoCapacityError's
         general non-retryable semantics anywhere else (synth, design,
         redesign) — only how this one advisory check reacts to it.
         Detected via `instanceof`, matching every OTHER NoCapacityError call
         site in this module graph (embed-client.ts, design-voice-core.ts,
         derive-engine-artifact.ts, sidecar-health.ts, transcribe-client.ts)
         — unlike SidecarDesignError above, NoCapacityError never crosses a
         module boundary that defeats `instanceof` here, and its own tests
         construct real instances, so `instanceof` is proven in-process. */
      let fidelity: { cosine: number; warning?: string } | undefined;
      let fidelityUnavailable = false;
      try {
        fidelity = await assessCloneFidelity(masterPcm, derived.previewPcm, candidate.master.sampleRate);
      } catch (e) {
        if (isTransient(e) || e instanceof NoCapacityError) {
          fidelityUnavailable = true;
        } else {
          throw e;
        }
      }

      /* Re-derive the typed consent draft (parsing only — body.consent was
         already validated at request entry and is immutable, so this can't
         fail differently). The REAL atomicity guarantee is ordering: writeEntry
         below is the LAST step, and it internally runs assertConsentForClone
         — so nothing is written if derive/fidelity/anything above throws. */
      const consentDraft = validateConsentDraft(body.consent);
      if (!consentDraft) throw new ConsentRequiredError();

      // Copy the retained source clip into the entry dir (candidate -> entry).
      await copyFile(candidateMasterPath(candidateId), join(dir, 'master.wav'));

      const now = new Date().toISOString();
      const name =
        typeof body.name === 'string' && body.name.trim() ? body.name.trim() : consentDraft.personName;
      /* #1943 — the real attester (a guardian, a relative) is not
         necessarily the person whose voice this is; a caller-supplied
         `attestedBy` names them. Falls back to `personName` — today's
         behaviour — when absent, so existing callers are unchanged. */
      const consent: VoiceConsentRecord = {
        personName: consentDraft.personName,
        relationship: consentDraft.relationship,
        permittedUse: 'personal',
        attestedAt: now,
        attestedBy: consentDraft.attestedBy ?? consentDraft.personName,
      };
      /* Persist the text the clone was ACTUALLY distilled against — into
         `master.transcript`, not just `sampleTranscript` below. The Wave 3b2
         repair path re-derives from `entry.master.transcript`
         (tts/synthesise-chapter.ts readMasterPcmDefault), so leaving the raw
         Whisper text here would make a later repair silently revert to it and
         undo the user's correction. */
      const master: VoiceMaster = {
        ...candidate.master,
        clipFile: 'master.wav',
        transcript: refText,
        transcriptSource,
      };
      const cloned: VoiceLibraryEntry = {
        voiceUuid,
        name,
        provenance: 'cloned',
        tags: [],
        pinned: false,
        /* #1951 — omitted entirely when the clip's language is unknown or
           unsupported, so the library shows no language rather than a wrong
           one. */
        ...(clipLanguage ? { languageCode: clipLanguage } : {}),
        consent,
        master,
        sampleTranscript: refText,
        sampleMeta: {
          durationSeconds: candidate.master.durationSeconds,
          sampleRate: candidate.master.sampleRate,
          qualityChecks: fidelityUnavailable
            ? { cloneFidelityUnavailable: true }
            : {
                cloneCosine: fidelity!.cosine,
                ...(fidelity!.warning ? { cloneFidelityWarning: fidelity!.warning } : {}),
              },
        },
        engines: { qwen: { status: 'ready', baseModel: derived.baseModel || currentQwenBaseModel() } },
        createdAt: now,
        updatedAt: now,
      };
      await writeEntry(cloned); // guard passes (consent structurally complete)
      await removeCandidate(candidateId);
      return (await readEntry(voiceUuid))!;
    });
    /* Plan 276 Decision 2 [R4] — this response goes through
       `withComputedStaleness` for the same reason `GET /` does, and it is
       load-bearing rather than cosmetic. The cloneVoice thunk
       (src/store/voice-library-slice.ts:199-209) refetches the library to get
       the computed entry, but `/clone` is the PRODUCER of the raw entry that
       cloneVoice still returns to its caller at (src/modals/clone-voice-wizard.tsx:50).
       Without this transform, the entry can read `'ready'` on the client when
       the server would call it `'stale'`. */
    return res.status(200).json(withComputedStaleness(entry));
  } catch (e) {
    if (e instanceof DesignInFlightError) {
      return res.status(409).json({ error: 'A clone for this sample is already running.' });
    }
    if (e instanceof CloneCandidateMissingError) {
      return res.status(404).json({ error: e.message });
    }
    if (e instanceof ConsentRequiredError) {
      return res.status(422).json({ error: e.message });
    }
    /* C1 — duck-type on the error's SHAPE, not `instanceof SidecarDesignError`.
       The real error crosses the sidecar-transport module boundary (and this
       route's own tests reject `deriveMock`/`assessCloneFidelity` mocks with
       structurally-equal fakes, not real class instances) — `instanceof`
       would silently miss both a genuine cross-module SidecarDesignError AND
       a structurally-equal test double, flattening either to the generic 502
       below. Duck-typing preserves status for both. */
    const sde = e as { name?: string; status?: number; code?: string; reason?: string; message?: string };
    if (sde?.name === 'SidecarDesignError' && typeof sde.status === 'number') {
      /* Status policy comes from the shared helper (#1822) so this route and
         the design/sample routes above can't drift apart on what a sidecar
         failure means to OUR caller — notably that a sidecar 4xx describes our
         request to IT, so it surfaces as 502 rather than misattributing the
         fault to the client. The duck-type above stays: it decides WHETHER
         this is a sidecar-shaped error, the helper decides what status it maps
         to. Body shape (reason/code) is this route's own. */
      return res
        .status(httpStatusForSidecarError(sde))
        .json({ error: sde.reason ?? sde.message ?? 'Clone derivation failed.', code: sde.code });
    }
    console.error('[voice-library] clone failed', e);
    return res.status(502).json({ error: (e as Error).message || 'Voice clone failed.' });
  }
});

/* fs-38 Wave 3c, Task 24 [DELTA-C1] — does this DESIGNED voice have a
   retained reference clip on disk? NOT `entry.master` (`VoiceLibraryEntry`'s
   own `master` field, workspace/voice-library.ts) — that field is populated
   only for a CLONED voice's ingested clip; a designed entry never populates
   it (see synthesise-chapter.ts's `readDesignedMasterPcmDefault` comment).
   A designed voice's retained clip instead lives on disk at
   `qwenVoiceWavPath('qwen-<uuid>__master')` — always the `qwen-` prefix
   regardless of which engine will eventually consume it (DELTA-M1), written
   once by the sidecar's `design_voice` call. Point-in-time only: a later
   re-design or purge can invalidate this the moment after it's checked,
   which is exactly why Task 20a's render-time pre-pass removes an unbacked
   slot rather than trusting this gate as a lasting guarantee. */
async function hasRetainedDesignedClip(voiceUuid: string): Promise<boolean> {
  try {
    await stat(qwenVoiceWavPath(`qwen-${voiceUuid}__master`));
    return true;
  } catch {
    return false;
  }
}

/* #1933 — does a CLONED voice's retained reference clip (`entry.master`)
   still exist on disk? `entry.master` is only a *declaration*; the clip it
   names can be gone (purged, moved, whatever) — and if it is, the render
   path finds out the hard way: `readMasterPcmDefault`
   (synthesise-chapter.ts) throws a status-less error that
   `isTransientDeriveFailure` classifies as TRANSIENT, so the chapter
   hard-fails and the engine slot never even gets stamped. Catching it here,
   at assign time, is the whole point of the #1933 gate. Mirrors that
   function's path hardening verbatim — `safeSegment` (THROWS on a bad
   segment) -> `sanitizeIdSegment` -> `assertContained` against
   `entryDir(voiceUuid)` — wrapped in try/catch because a clip path we can't
   even safely resolve is a clip we can't derive from either: return `false`,
   never let it escape as a 500 on a route that works today. Engine-agnostic
   (one `master.wav` per entry), so a single stat serves both evaluations of
   `clonedAssignBlock` below. */
async function clonedMasterClipExists(voiceUuid: string, master: VoiceMaster): Promise<boolean> {
  try {
    const dir = entryDir(voiceUuid);
    const clipPath = join(dir, sanitizeIdSegment(safeSegment(master.clipFile)));
    assertContained(dir, clipPath);
    await stat(clipPath);
    return true;
  } catch {
    return false;
  }
}

const CLONE_ENGINE_LABELS: Record<CloneEngine, string> = { qwen: 'Qwen', coqui: 'Coqui XTTS v2' };

function otherCloneEngine(engine: CloneEngine): CloneEngine {
  return engine === 'qwen' ? 'coqui' : 'qwen';
}

type CloneAssignBlock = 'failed' | 'no-clip' | 'no-transcript';

/** #1933 — the per-engine assign readiness rule for a CLONED library entry
    being assigned onto routed engine `engine`. Reads only `entry.engines`,
    `entry.master`, `entry.master.transcript`, plus the pre-computed
    `clipOnDisk` boolean (`clonedMasterClipExists`, above — one stat covers
    both engines, since the clip is engine-agnostic).

    | # | Condition                                   | Outcome | Why |
    |---|----------------------------------------------|---------|-----|
    | 1 | `slot?.status === 'failed'`                   | blocked | `classifyClonedVoice` (clone-voice-resolver.ts) makes `'failed'` terminal at render time — nothing in `server/src` ever clears it, so render never retries. |
    | 2 | `slot?.status === 'ready'`                    | OK      | Healthy. If the `.pt` was purged since, render-time repair handles it — same as today. |
    | 3 | otherwise (`'stale'`, `'deriving'`, or absent) | OK iff derivable | Render will need a derive. Allow only if that derive can actually run: |

    "Derivable" in case 3, for either engine, requires the clip to still be
    on disk (`clipOnDisk`) — without it `classifyClonedVoice` reports
    `missing-master` -> Broken -> the chapter hard-fails. For QWEN
    additionally, `entry.master.transcript` must be a non-empty string — a
    Qwen derive needs a `refText` (`derive-engine-artifact.ts`) and a 400
    from a transcript-less derive is classified PERMANENT, which persists a
    terminal `'failed'` status forever (see rule 1). Coqui's derive is
    purely acoustic and has no such requirement.

    Deliberately symmetric on the artifact axis, asymmetric on the
    transcript axis — see #1933's implementation-brief §0/§1 for the full
    render-time citations. Case 2 does NOT also require `master`: today's
    gate already allows `ready` + no `master` (repair falls back to the
    render-time pre-pass), and requiring it here would be a NEW block, not a
    fix. Case 3 deliberately loosens Qwen too — keeping Qwen strict while
    loosening Coqui would just move the same over-block bug onto Coqui.
    `'deriving'` needs no special branch: nothing in `server/src` ever
    persists it, so it falls through to case 3 exactly like `'stale'`/absent
    would, structurally.

    Pure and synchronous — evaluated TWICE per cloned assign (once against
    the routed engine, once against the other clone-capable engine, see the
    call site) from one predicate, so the two can never drift. */
function clonedAssignBlock(
  entry: VoiceLibraryEntry,
  engine: CloneEngine,
  clipOnDisk: boolean,
): CloneAssignBlock | null {
  const slot = entry.engines[manifestSlotFor(engine)];
  if (slot?.status === 'failed') return 'failed';
  if (slot?.status === 'ready') return null;
  if (!entry.master || !clipOnDisk) return 'no-clip';
  if (engine === 'qwen' && (typeof entry.master.transcript !== 'string' || !entry.master.transcript.trim())) {
    return 'no-transcript';
  }
  return null;
}

/** #1933 — the 409 the ROUTED engine's own readiness failure produces. */
function blockMessage(block: CloneAssignBlock, engine: CloneEngine, voiceName: string, charName: string): string {
  const label = CLONE_ENGINE_LABELS[engine];
  switch (block) {
    case 'failed':
      return (
        `"${voiceName}"'s ${label} voice failed to derive, so "${charName}" would fail to render on ${label}. ` +
        `Re-clone the voice, or cast "${charName}" on ${CLONE_ENGINE_LABELS[otherCloneEngine(engine)]} instead.`
      );
    case 'no-clip':
      return (
        `"${voiceName}" has no retained reference clip and its ${label} voice is not ready, so there is ` +
        `nothing to derive it from. Re-clone the voice before assigning it to "${charName}".`
      );
    case 'no-transcript':
      return (
        `"${voiceName}"'s Qwen voice is not ready and its reference clip has no transcript, which a Qwen ` +
        `clone needs. Re-clone the voice with a transcript. Casting "${charName}" on Coqui XTTS v2 would let ` +
        `the assign through — Coqui needs no transcript — but the Qwen slot this also writes would stay unusable.`
      );
  }
}

/** #1933 — the 200 advisory (`warning` field) when the OTHER clone-capable
    engine (not the routed one) is unusable. Reuses the existing `warning`
    field on the assign response — see the call site's comment for why. */
function advisoryMessage(block: CloneAssignBlock, engine: CloneEngine, voiceName: string, charName: string): string {
  const label = CLONE_ENGINE_LABELS[engine];
  switch (block) {
    case 'failed':
      return (
        `Assigned. Note: "${voiceName}"'s ${label} voice failed to derive, so if "${charName}" is ever ` +
        `switched to ${label} it will fail to render. Re-clone the voice to fix it.`
      );
    case 'no-clip':
      return (
        `Assigned. Note: "${voiceName}" has no retained reference clip, so its ${label} voice can never be ` +
        `derived — if "${charName}" is ever switched to ${label} it will fail to render.`
      );
    case 'no-transcript':
      return (
        `Assigned. Note: "${voiceName}"'s reference clip has no transcript, which a Qwen clone needs — its ` +
        `Qwen voice can't be derived, so if "${charName}" is ever switched to Qwen it will fail to render. ` +
        `Re-clone the voice with a transcript to fix it.`
      );
  }
}

/* POST /api/voice-library/:voiceUuid/assign

   Assigns a library voice to ONE character in ONE book — a bespoke,
   character-targeted cast write (NOT `applyOverrideToCastFiles` from
   routes/voices.ts, which is keyed by voiceId across every matching book
   and whose `override` param can't carry `libraryUuid`/`provenance`).
   Reads the book's cast.json, merges the new `qwen` slot — and, fs-38 Wave
   3c, ALSO the `coqui` slot when the voice is clone-capable there too (see
   the both-slots gate below) — into that one character's
   `overrideTtsVoices` (sibling engine slots + the rest of each merged slot
   survive), and writes back atomically. `character.voiceUuid` is never
   touched — that field is the srv-43 identity key, not something an assign
   should alias.

   #1981 — the cast.json read-modify-write window (`readJson` ->
   `nextCharacters` -> `writeJsonAtomic`) is wrapped in `withCastLock`, and
   the whole handler from `readEntry` on is wrapped in `withLibraryVoiceLock`
   OUTSIDE that — THAT nesting is what makes this safe against a concurrent
   write to the same cast.json (two overlapping assigns for one book, or
   this route racing a debounced cast-editor save), not any property of the
   window's own shape — a zero-`await` window was never "effectively
   atomic" against a second, independently-scheduled request. The
   library-voice lock opens before `readEntry` because every decision
   derived from the library entry (the 404, the revoked-consent 409, the
   #1933 readiness gate) has to be inside it too (rule 2); it must open
   BEFORE the cast lock, never after, because the DELETE path (Task 5) holds
   `library-voice:<uuid>` across a helper that itself takes cast locks per
   book — the other order is an AB/BA deadlock. Since #2260 that surfaces as a
   `LockAcquisitionTimeoutError` after 10s per acquisition rather than a
   permanent hang, but it is still a deadlock and this route is still 2 locks
   deep. See cast-lock.ts's header for the four rules and the timeout's limits,
   and the
   `shouldWriteCoquiSlot` comment below for the fuller version of this. */
voiceLibraryRouter.post('/:voiceUuid/assign', async (req: Request, res: Response) => {
  try {
    const { voiceUuid } = req.params;

    return await withLibraryVoiceLock(voiceUuid, async () => {
      const entry = await readEntry(voiceUuid);
      if (!entry) {
        return res.status(404).json({ error: `No voice-library entry "${voiceUuid}".` });
      }
      if (entry.consent?.revokedAt) {
        return res.status(409).json({ error: 'Consent for this voice has been revoked.' });
      }

      /* fs-38 Wave 3c, Task 24 (fix round 1, review) — write BOTH the qwen and
         coqui slots when the library voice is actually clone-capable on both
         engines, so this route closes the reachability gap: it was the only
         writer of `libraryUuid` at all, and until this both-slots write
         lands, no character can carry a resolvable coqui-cloned slot end to
         end. A CLONED entry always qualifies (§2.3 — an ingested clip derives
         on either engine). A DESIGNED entry qualifies only when it still has
         its retained reference clip on disk (`hasRetainedDesignedClip`,
         above) — without that clip a coqui derive has nothing to derive
         FROM, so writing a coqui slot here would strand the character on a
         slot the resolver can never back. `entry.master` is NOT the right
         test — see `hasRetainedDesignedClip`'s own comment. An IMPORTED entry
         never qualifies. This check is point-in-time only (see that helper's
         comment) — Task 20a's render-time pre-pass is what actually enforces
         the invariant over time, not this gate.

         DELIBERATELY computed here, before `findBookByBookId`/`readJson`
         below, not next to the `nextCharacters` build where it's consumed —
         it depends only on `entry` and `voiceUuid`, both already in hand.
         #1981 — this placement is now just a best-effort narrowing of an
         unmeasured window, kept as insurance against a future writer that
         forgets to lock; it is NOT what makes the RMW safe. The actual
         guarantee is the `withLibraryVoiceLock` / `withCastLock` nesting
         around the whole handler (see the route's own top comment and
         cast-lock.ts) — a zero-`await` window was never "effectively
         atomic" against a second, concurrently-running request: two
         requests each running their OWN `readJson` still race each other
         regardless of what happens between one request's own read and its
         own write. Keep this `await` where it is anyway (still true
         insurance), but do not treat its position as the safety property. */
      const shouldWriteCoquiSlot =
        entry.provenance === 'cloned' ||
        (entry.provenance === 'designed' && (await hasRetainedDesignedClip(voiceUuid)));

      /* #1933 — same placement rationale as `shouldWriteCoquiSlot` immediately
         above: real filesystem I/O, computed here (depends only on `entry` and
         `voiceUuid`, both already in hand) so it stays outside the cast.json
         read-modify-write window below. Only a CLONED entry with a `master`
         declaration can even have a clip to check; anything else short-
         circuits to `false` without the `stat`. */
      const clonedClipOnDisk =
        entry.provenance === 'cloned' && entry.master
          ? await clonedMasterClipExists(voiceUuid, entry.master)
          : false;

      const body = (req.body ?? {}) as AssignBody;
      const bookId = typeof body.bookId === 'string' ? body.bookId : undefined;
      const characterId = typeof body.characterId === 'string' ? body.characterId : undefined;
      if (!bookId || !characterId) {
        return res.status(400).json({ error: '`bookId` and `characterId` are required.' });
      }

      const located = await findBookByBookId(bookId);
      if (!located) {
        return res.status(404).json({ error: `No book "${bookId}".` });
      }

      /* #1981 — hoisted out of the cast.json read-modify-write window
         (moved up from just above the `nextCharacters` build, where it used
         to sit alongside the cast read). Depends only on `entry.provenance`,
         `voiceUuid` and `located.state` — all already in hand once the book
         is located — so nothing requires it to sit inside the RMW; only the
         warning STRING built from it (which also needs `character.name`,
         not available until the character lookup) stays at the original
         site, inside `withCastLock` below.

         #1953 — WARN, never block, when a DESIGNED voice's baked manifest
         language differs from the book's language. This is deliberately a
         sibling of the 409 block above, not a widening of it: the 409's own
         comment explains why a designed voice "has always been free to route
         anywhere" and a hard failure for it would be a regression — that
         reasoning holds for a 409, not for a non-fatal advisory.

         `clearMismatchedDesignedVoices` (verify-designed-voice-language.ts)
         already catches this at RENDER time, but only for non-English books —
         its callers gate it behind `isNonEnglish(bookLanguage)`. A designed
         voice assigned to an ENGLISH book therefore sailed through with no
         signal at all, right up until a full chapter rendered unintelligible
         audio (measured on the dev box: avg_logprob -1.303 wrong-language vs.
         -0.201 correct — a mismatch doesn't degrade the audio, it destroys
         it). This warning is the earlier, softer signal for exactly that gap;
         it does not move or replace the render-time gate.

         A CLONED voice has no baked design language (its manifest, when one
         exists, reflects the speaker's own voice, not a chosen design
         language) — `entry.provenance === 'designed'` is the library-entry
         equivalent of `clearMismatchedDesignedVoices`'s `hasClonedProvenance`
         skip, and an imported entry never carries a Qwen design manifest
         either, so both fall through this block with no warning.

         Review round 2 — `sidecarLanguageName` deliberately THROWS for a book
         language outside the registry (language.ts's own "fail-loud safety
         net" comment), because the confirm-screen import gate is supposed to
         block an unsupported language before it ever reaches this far. That
         gate is client-side only; `routes/import.ts` persists an unchecked
         `normaliseBookLanguage(body.language)` (see #1955), so a pre-existing
         book with an unregistered language (e.g. `'pt'`) can already be on
         disk. Assign is a route that works fine for such a book today — it
         never used to touch the language registry — so letting the throw
         escape here would be a NEW 500 on an existing, previously-working
         route. With no registry entry there is no sidecar word to compare
         the manifest against, so there is no mismatch to assert either way:
         skip the warning, exactly like the pre-#1953 behaviour, never 500. */
      let expectedSidecarLang: string | undefined;
      let designedManifest: { language?: string } | null = null;
      if (entry.provenance === 'designed') {
        const bookLanguage = bookStateLanguage(located.state);
        try {
          expectedSidecarLang = sidecarLanguageName(bookLanguage);
        } catch {
          expectedSidecarLang = undefined;
        }
        designedManifest = await readJson<{ language?: string }>(
          qwenVoiceSidecarPath(cloneStorageKey('qwen', voiceUuid)),
        ).catch(() => null);
      }

      return await withCastLock(located.bookDir, async () => {
        const cast = await readJson<CastJson>(castJsonPath(located.bookDir));
        const characters = cast?.characters ?? [];
        const charIndex = characters.findIndex((c) => c.id === characterId);
        if (charIndex === -1) {
          return res
            .status(404)
            .json({ error: `No character "${characterId}" in book "${bookId}".` });
        }

        const character = characters[charIndex];

        /* #1933 — `clonedAdvisory` and `languageWarning` (declared together,
           set inside their own respective provenance-scoped blocks below) are
           mutually exclusive by construction: `clonedAdvisory` is only ever set
           inside a `provenance === 'cloned'` branch, `languageWarning` only
           inside a `provenance === 'designed'` one — an entry is never both —
           so the two can share the single `warning` response field with no
           collision to disambiguate. */
        let clonedAdvisory: string | undefined;
        let languageWarning: string | undefined;

        /* Task 6b, widened by fs-38 Wave 3c Task 24 — a cloned voice renders on
           a clone-capable engine ONLY (Qwen or Coqui XTTS v2 —
           `CLONE_CAPABLE_ENGINES`, tts/clone-engines.js). Assigning one to a
           character that routes to neither would produce exactly the same 3b2
           resolver-pre-pass hard-fail this task exists to give an accurate
           reason for ('wrong-engine') — but discovered only at RENDER time,
           chapters deep. Catch it here instead, at assign time, so the user
           gets an actionable 409 immediately. Scoped to `provenance === 'cloned'`
           only — a DESIGNED voice has always been free to route anywhere
           (spec §2.3); widening this guard to designed voices would be a new
           hard failure for them.

           Fix wave 2 (review) — the guard's FIRST cut computed the book's
           effective default purely from the PERSISTED `getResolvedTtsModelKey()`
           account default. That default is not what actually renders: the
           engine picker on the Voices page (and the session `ui.ttsModelKey` it
           writes) is never persisted, and generation itself routes off the
           REQUEST's modelKey, not the account default — so a session pick of
           Qwen against a non-Qwen persisted default produced a false 409, and
           the reverse produced a false 200 (assign succeeds, render then fails).
           The caller now optionally sends the modelKey it actually intends to
           render with (`body.modelKey` — e.g. the profile drawer's PENDING
           engine-picker choice); that wins when present. Only when the caller
           has no meaningful engine context (and omits the field) do we fall
           back to the persisted default. A character's own `ttsEngine` override
           (if any) still wins via `resolveCharacterEngine`, so a character
           explicitly cast on Qwen or Coqui is unaffected by the book/session
           default sitting elsewhere.

           #1933 — order matters: this wrong-engine check runs FIRST, the
           per-engine readiness gate SECOND. Mirrors `classifyClonedVoice`'s own
           precedence (`wrongEngine` beats every artifact concern) — a character
           not even routed to a clone engine should hear about THAT, not about a
           slot it will never use. `isCloneEngine` (tts/clone-engines.js) is
           `CLONE_CAPABLE_ENGINES.has(e)` verbatim, so this 409 is
           behaviour-identical to before — but as a real type guard, the early
           return below narrows `routedEngine` to `CloneEngine` for everything
           that follows, so `manifestSlotFor`/`clonedAssignBlock` type-check with
           no cast. */
        if (entry.provenance === 'cloned') {
          const requestedModelKey = isTtsModelKey(body.modelKey) ? body.modelKey : undefined;
          const bookDefaultEngine = engineForModelKey(requestedModelKey ?? getResolvedTtsModelKey());
          const routedEngine = resolveCharacterEngine(character, bookDefaultEngine);
          if (!isCloneEngine(routedEngine)) {
            /* I-2 — name the ACTUAL cause. When the character carries its own
               `ttsEngine` override, THAT is why it's not routing to a
               clone-capable engine — the book/session default is irrelevant,
               and telling the user to "switch the book's engine" would send
               them to fix the wrong thing (the same misdiagnosis class Part A
               eliminated for the render-time error). */
            const characterCaused = Boolean(character.ttsEngine);
            const cause = characterCaused
              ? `"${character.name ?? characterId}" is cast on ${routedEngine}`
              : `this book is set to ${routedEngine}`;
            const fix = characterCaused
              ? `Switch the character's engine to Qwen or Coqui XTTS v2 (or reassign the character)`
              : `Switch the book's engine to Qwen or Coqui XTTS v2`;
            return res.status(409).json({
              error: `Cloned voices render on Qwen or Coqui XTTS v2, but ${cause}. ${fix} before assigning "${character.name ?? characterId}".`,
            });
          }

          /* #1933 — readiness of the engine this assign will ACTUALLY render
             on. Blocks the assign outright when the routed engine's own slot
             can't back it (see `clonedAssignBlock`'s doc comment for the rule). */
          const charName = character.name ?? characterId;
          const block = clonedAssignBlock(entry, routedEngine, clonedClipOnDisk);
          if (block) {
            return res.status(409).json({ error: blockMessage(block, routedEngine, entry.name, charName) });
          }

          /* #1933 — the write below persists BOTH slots unconditionally for a
             cloned entry (`shouldWriteCoquiSlot` above), regardless of which
             engine this assign was routed for — so warn now if the OTHER
             clone-capable engine's slot is unusable, rather than letting the
             user discover it only when they later switch engines. */
          const otherEngine = otherCloneEngine(routedEngine);
          const otherBlock = clonedAssignBlock(entry, otherEngine, clonedClipOnDisk);
          if (otherBlock) {
            clonedAdvisory = advisoryMessage(otherBlock, otherEngine, entry.name, charName);
          }
        }

        /* #1981 — `expectedSidecarLang`/`designedManifest` were fetched
           above, outside the cast.json RMW (see that comment for why); only
           the warning STRING construction stays here, since it needs
           `character.name`, not available until the character lookup a few
           lines up. */
        if (entry.provenance === 'designed') {
          if (
            expectedSidecarLang &&
            designedManifest?.language &&
            designedManifest.language !== expectedSidecarLang
          ) {
            languageWarning =
              `"${character.name ?? characterId}"'s voice was designed in ${designedManifest.language} but this ` +
              `book is ${expectedSidecarLang} — the audio will be unintelligible. Re-design the voice in ` +
              `${expectedSidecarLang} to fix it.`;
          }
        }

        /* Review I-4 — a prior DESIGNED voice's minted emotion `variants` are
           anchored to that base identity (qwen-<old-uuid>__<emotion>). Assigning
           a library voice swaps the base identity to qwen-<voiceUuid>, and
           `pickEmotionVariantVoice` re-derives the variant key from the NEW
           base — so a carried-over `variants` map would point at a `.pt` that
           never existed for this voice. The pre-render pre-pass only validates
           the BASE `.pt`, so that dangling variant key would die mid-GPU-work at
           synth time on the sidecar's own VoiceNotDesignedError, breaking the
           fail-fast promise. Drop `variants` here — they're semantically tied to
           the previous base and don't carry over (both slots, when both are
           written). */
        const nextCharacters = [...characters];
        nextCharacters[charIndex] = {
          ...character,
          overrideTtsVoices: {
            ...character.overrideTtsVoices,
            qwen: {
              ...character.overrideTtsVoices?.qwen,
              name: cloneStorageKey('qwen', voiceUuid),
              libraryUuid: voiceUuid,
              provenance: entry.provenance,
              variants: undefined,
            },
            ...(shouldWriteCoquiSlot
              ? {
                  coqui: {
                    ...character.overrideTtsVoices?.coqui,
                    name: cloneStorageKey('coqui', voiceUuid),
                    libraryUuid: voiceUuid,
                    provenance: entry.provenance,
                    variants: undefined,
                  },
                }
              : {}),
          },
        };

        await writeJsonAtomic(castJsonPath(located.bookDir), { ...cast, characters: nextCharacters });

        /* GATE 1 [F1] — report WHICH engine slots were actually persisted. The
           response used to be a bare `{ updated: 1 }`, which told the caller
           nothing about `shouldWriteCoquiSlot`: the profile drawer's picker
           mirrored a coqui assignment into redux on any 200, so a designed entry
           with no retained reference clip (coqui slot declined above) displayed
           as a "My voice" coqui assignment that cast.json never carried, with no
           refetch to reconcile it. Derived from the SAME `shouldWriteCoquiSlot`
           flag the write above spreads on, not recomputed — the two cannot
           disagree. Order mirrors the write: qwen is unconditional, coqui is
           conditional. */
        const written: CloneEngine[] = shouldWriteCoquiSlot ? ['qwen', 'coqui'] : ['qwen'];
        /* #1933 — `clonedAdvisory` and `languageWarning` are mutually exclusive
           by construction (see their shared declaration comment above), so
           there is no collision picking one over the other here. */
        const warning = clonedAdvisory ?? languageWarning;
        return res.status(200).json({ updated: 1, written, ...(warning ? { warning } : {}) });
      });
    });
  } catch (e) {
    console.error('[voice-library] assign failed', e);
    /* #2260 FINAL ROUND (B2) — this route is TWO locks deep
       (`library-voice:<uuid>` → `withCastLock(bookDir)`), and since #2260 either
       acquisition can expire on ordinary contention where it previously hung.
       `(e as Error).message` then handed the client
       `withKeyLock: timed out … "<ABSOLUTE PATH>\.audiobook\cast.json" — either
       a cast-lock.ts rule 1 …`, over a LAN this app serves by design. The leak
       is NEW to #2260: before it, that request hung and there was no error to
       serialise. `requestFailureMessage` curates that one class and leaves every
       other body exactly as it was; the raw error still goes to the log above. */
    res.status(500).json({
      error: requestFailureMessage(e, (e as Error).message || 'Voice library assign failed.'),
    });
  }
});

/* DELETE /api/voice-library/:voiceUuid/assign?bookId=…&characterId=…

   GATE 1, owner-decided — the exact inverse of the assign route above, and
   the missing half of `[DELTA-I5]`: until now there was NO way to take a
   library voice back OFF a character.

   Both of the routes that could plausibly have done it deliberately refuse:
   `PUT /api/voices/:voiceId/override` with `override: null` 409s outright
   when any matching character carries a cloned slot (Task 4), and its SET
   branch preserves `libraryUuid`/`provenance` through the
   `hasClonedProvenance` fail-safe guard — so picking a stock catalogue
   voice over a cloned slot leaves the character still RENDERING the clone.
   Both refusals are correct in their own right (Phase 0 of this wave fixed
   seven bugs that were all clone markers erased by an unrelated upstream
   write); what they left missing was a DELIBERATE, character-targeted
   unassign. That is this route.

   Deliberate properties:

   - **Clears whole slots, not just the markers.** Half-clearing (dropping
     `libraryUuid`/`provenance` and keeping `name`) would strand the
     character on a raw `xtts-<uuid>`/`qwen-<uuid>` storage key the resolver
     no longer recognises as a library voice — the exact "slot the resolver
     can never back" shape Task 24's coqui gate exists to avoid. Removing
     the slot returns the character to "no voice assigned", where the
     engine's ordinary catalogue/attribute inference takes over. Any
     `variants` on the slot go with it, which is correct: `/assign` already
     drops them (review I-4), so a slot bearing THIS uuid has none that
     mean anything.
   - **Scoped by `libraryUuid`, never by engine.** Only slots that actually
     point at THIS voice are touched, so a character carrying a different
     library voice on its other engine keeps it.
   - **No consent / readiness / provenance gate, and no `readEntry` at
     all.** Unassigning destroys nothing — it is the escape hatch, so it
     must not be refusable. It must in particular still work when the entry
     is revoked or already deleted, which is exactly when a character is
     most likely to be stuck holding a dangling assignment.
   - **No `await` between the cast.json read and its write-back**, same
     atomicity discipline the assign route's `shouldWriteCoquiSlot` comment
     spells out.

   `cleared: []` with a 200 is the honest answer for a character that
   wasn't carrying this voice — the requested end state already holds. */
voiceLibraryRouter.delete('/:voiceUuid/assign', async (req: Request, res: Response) => {
  try {
    const { voiceUuid } = req.params;
    const bookId = typeof req.query.bookId === 'string' ? req.query.bookId : undefined;
    const characterId =
      typeof req.query.characterId === 'string' ? req.query.characterId : undefined;
    if (!bookId || !characterId) {
      return res.status(400).json({ error: '`bookId` and `characterId` are required.' });
    }

    const located = await findBookByBookId(bookId);
    if (!located) {
      return res.status(404).json({ error: `No book "${bookId}".` });
    }

    /* #1981 — the read is inside the lock; `charIndex`/`cleared` and the
       write are all decisions derived from it. No `withLibraryVoiceLock`
       here — this route's own header comment already explains why: no
       consent/readiness/provenance gate, no `readEntry` at all, so there is
       no library-voice-scoped state to guard, only the cast.json RMW. */
    await withCastLock(located.bookDir, async () => {
      const cast = await readJson<CastJson>(castJsonPath(located.bookDir));
      const characters = cast?.characters ?? [];
      const charIndex = characters.findIndex((c) => c.id === characterId);
      if (charIndex === -1) {
        return res
          .status(404)
          .json({ error: `No character "${characterId}" in book "${bookId}".` });
      }

      const character = characters[charIndex];
      const nextSlots = { ...character.overrideTtsVoices };
      const cleared: CloneEngine[] = [];
      for (const engine of CLONE_ENGINE_LIST) {
        if (nextSlots[engine]?.libraryUuid === voiceUuid) {
          delete nextSlots[engine];
          cleared.push(engine);
        }
      }

      if (cleared.length > 0) {
        const nextCharacters = [...characters];
        nextCharacters[charIndex] = { ...character, overrideTtsVoices: nextSlots };
        await writeJsonAtomic(castJsonPath(located.bookDir), {
          ...cast,
          characters: nextCharacters,
        });
      }

      return res.status(200).json({ cleared });
    });
  } catch (e) {
    console.error('[voice-library] unassign failed', e);
    /* #2260 FINAL ROUND (B2) — the third of this file's three lock-taking
       handlers: the unassign's own `withCastLock` above. Same curation. */
    res.status(500).json({
      error: requestFailureMessage(e, (e as Error).message || 'Voice library unassign failed.'),
    });
  }
});

/* POST /api/voice-library/:voiceUuid/revoke

   Consent revocation (fs-38 Wave 3a, Task 8). Stamps `consent.revokedAt` on
   the entry and re-writes it — this PASSES the Task 7 write-time consent
   guard, since revokedAt is orthogonal to structural consent validity (the
   entry still carries a complete consent record, just a revoked one). A 409
   guards the (should-be-impossible-for-a-cloned-voice) case of an entry with
   no consent record at all — nothing to revoke. Wave 3b2, Task 3: revocation
   also erases the resynthesis-capable clone artifacts via `purgeCloneArtifacts`
   (no `deleteEntryDir` — the manifest is retained so the entry stays
   visible/inspectable, revoked). User-directed fix (consent-erasure, same
   wave): revoke ALSO erases the entry-dir recording itself — the person's
   actual `master.wav` — via `deleteMasterClip: true`, since "revoke consent"
   that leaves the original clip sitting on disk isn't really revoked.
   `purgeCloneArtifacts` clears the entry's `master` field when it erases the
   clip, so this handler re-reads the entry afterward rather than returning
   the pre-purge snapshot, keeping the response's `master` in sync with what's
   actually on disk.

   Review I-2 — `purgeCloneArtifacts` now reports any file it could NOT
   remove (e.g. a Windows EBUSY from the sidecar holding a `.pt` open
   mid-load). The consent flag itself (`revokedAt`) still blocks rendering
   either way — see the resolver's `revoked` classification, which never
   consults on-disk artifact presence — so the response STAYS 200 and
   `revokedAt` is set regardless. But a partial erasure must not read as a
   silent, total success: when any path survives, this adds
   `artifactPurgeIncomplete`/`artifactPurgeFailedPaths` to the response
   rather than claiming clean erasure it didn't achieve.

   Task 14a — that same `failed` array (and therefore this same
   `artifactPurgeIncomplete` gate) now ALSO covers a failed/timed-out
   sidecar cache evict, not just file unlinks. Before this, a bare
   `catch {}` inside `purgeCloneArtifacts` swallowed both a non-2xx evict
   response AND a timeout/rejection, so revoke could answer 200 with no
   `artifactPurgeIncomplete` while XTTS's TTL-less latents cache
   (`CoquiEngine._latents_cache`) still held the voice — this route needed
   no code change of its own to pick that up, since it already forwards
   `purgeResult.failed` verbatim. */
voiceLibraryRouter.post('/:voiceUuid/revoke', async (req: Request, res: Response) => {
  try {
    const { voiceUuid } = req.params;
    const entry = await readEntry(voiceUuid);
    if (!entry) return res.status(404).json({ error: `No voice-library entry "${voiceUuid}".` });
    if (!entry.consent) return res.status(409).json({ error: 'Entry has no consent record to revoke.' });
    /* fs-38 Wave 3c, Task 14 — stamp `revokedAt` through the shared,
       per-uuid-locked `updateEntry` (fresh read + mutate + write, held
       under one lock) instead of writing back the `entry` read above,
       which by now may be stale relative to a concurrent engine-slot
       write (e.g. an in-flight xtts derive elsewhere) that would
       otherwise be silently clobbered. The 404/409 checks above stay
       against the pre-lock `entry` — both are timing-insensitive here
       (missing-entirely and no-consent-record are not states a concurrent
       writer would create out from under a genuinely present, consented
       entry) — only the write itself needs the fresh snapshot. */
    const updated = await updateEntry(voiceUuid, (fresh) =>
      fresh?.consent
        ? { ...fresh, consent: { ...fresh.consent, revokedAt: new Date().toISOString() } }
        : null,
    );
    if (!updated) {
      return res.status(404).json({ error: `No voice-library entry "${voiceUuid}".` });
    }
    // Erase resynthesis-capable artifacts AND the original recording itself.
    const purgeResult = await purgeCloneArtifacts(voiceUuid, { deleteMasterClip: true });
    const final = (await readEntry(voiceUuid)) ?? updated;
    if (purgeResult.failed.length > 0) {
      console.warn(
        '[voice-library] revoke for "%s" left %d artifact(s) ' +
          'un-erased:',
        voiceUuid,
        purgeResult.failed.length,
        purgeResult.failed,
      );
    }
    return res.status(200).json(
      purgeResult.failed.length > 0
        ? { ...final, artifactPurgeIncomplete: true, artifactPurgeFailedPaths: purgeResult.failed }
        : final,
    );
  } catch (e) {
    return res.status(502).json({ error: (e as Error).message || 'Revoke failed.' });
  }
});

/* Erase EVERY on-disk artifact of a library voice — not just the manifest
   dir — so "local-only, never leaves the machine" holds through deletion
   (spec §2.4). Thin wrapper around the Wave 3b2 Task 2 `purgeCloneArtifacts`
   (workspace/purge-clone-artifacts.ts), which is the single source of truth
   for "every consent-scoped clone artifact" — including the `__1.7b.pt`
   variant this route's prior ad-hoc erasure missed. `deleteEntryDir: true`
   also removes the manifest dir (voice.json + master.wav), unlike the
   revoke route above — but only when the purge came back CLEAN; see the C3
   comment in purge-clone-artifacts.ts.

   GATE 1 fix (C3) — the `failed` array is no longer discarded here. It was
   the same report the revoke route already forwards as
   `artifactPurgeIncomplete`, thrown away on the delete path so the route
   could answer an unconditional `{ deleted: true }`. Returning it is what
   lets the handler stop claiming more erasure than happened. */
async function eraseLibraryVoiceArtifacts(voiceUuid: string): Promise<{ failed: string[] }> {
  return purgeCloneArtifacts(voiceUuid, { deleteEntryDir: true });
}

/* DELETE /api/voice-library/:voiceUuid

   Usage-scan + confirm, then multi-location erasure (spec §2.4/§7). Any
   character across the workspace whose overrideTtsVoices[*].libraryUuid
   matches this voice is reported via 409 unless the caller passes
   `?confirm=1`; on confirm (or when unused) the matching override slots are
   cleared first — leaving those characters voiceless on that engine, which
   the fe-46 gate surfaces — THEN every derived artifact is erased.

   GATE 1 fix (C3) — a purge that could not erase everything answers
   `{ deleted: false, artifactPurgeIncomplete: true, artifactPurgeFailedPaths }`
   instead of the old unconditional `{ deleted: true }`, and the entry
   SURVIVES (purge-clone-artifacts.ts keeps the manifest whenever `failed` is
   non-empty — see the C3 comment there for why removing it would leave the
   surviving artifact ungated). `deleted: false` is therefore literal, not
   cosmetic: the card is still in the library and the user can retry the
   delete or revoke instead. Still 200 — the reference-clearing and the
   artifact sweep both genuinely ran; this is a partial outcome, not an
   error. `artifactPurgeIncomplete`/`artifactPurgeFailedPaths` are the same
   two fields the revoke route above already carries (Task 14a), deliberately
   reused rather than a second, delete-only signal.

   #1981 — the whole scan -> clear -> erase sequence (`readEntry` and its
   404, `scanLibraryVoiceUsage`, `clearLibraryVoiceReferences`,
   `eraseLibraryVoiceArtifacts`) is wrapped in `withLibraryVoiceLock`,
   symmetric with `POST /:voiceUuid/assign`'s own use of the same key: that
   is what closes the erase-vs-assign race (the scan can pass a book, an
   assign then plants a reference in it, the artifacts get erased afterwards
   — a character left pointing at a `libraryUuid` whose files are gone).
   `library-voice` opens before `readEntry` (not just before the scan) for
   the same rule-2 reason `/assign` states in its own comment: the 404 is a
   decision derived from the library entry, so it belongs inside the lock
   too — even though two concurrent DELETEs racing this window is itself
   harmless (the second finds nothing left to erase).
   `clearLibraryVoiceReferences` (workspace/voice-library-usage.ts) takes a
   `withCastLock` per book INSIDE this lock, never the other way — this is
   `library-voice -> cast`, matching cast-lock.ts's rule 4/global order, and
   the same order `/assign` takes; either route taking the two locks in the
   opposite order would AB/BA-deadlock the other — since #2260 surfacing as a
   `LockAcquisitionTimeoutError` after 10s per acquisition rather than a
   permanent hang (see cast-lock.ts's header). NOTE this path is the deepest
   nesting in the codebase: it holds `library-voice:<uuid>` while
   `clearLibraryVoiceReferences` takes a cast lock per confirmed book, so its
   worst-case acquisition budget is (N + 1) × 10s for N books. It is also the
   longest holder of `library-voice:<uuid>` (see file-lock.ts's budget note),
   so on a large library a concurrent `/assign` on the same uuid is the most
   likely way a user ever meets that error WITHOUT any rule having been broken.
   Both catches — `/assign`'s and this one — used to answer with
   `(e as Error).message` verbatim, so what a user saw for that entirely normal
   contention was the raw lock-timeout string, absolute workspace path and all;
   both now return the curated `LOCK_CONTENTION_REQUEST_ERROR` instead (see each
   handler). */
voiceLibraryRouter.delete('/:voiceUuid', async (req: Request, res: Response) => {
  const { voiceUuid } = req.params;
  try {
    return await withLibraryVoiceLock(voiceUuid, async () => {
      const existing = await readEntry(voiceUuid);
      if (!existing) {
        return res.status(404).json({ error: `No voice-library entry "${voiceUuid}".` });
      }

      const confirmed = req.query.confirm === '1';
      const usage = await scanLibraryVoiceUsage(voiceUuid);
      if (usage.length > 0 && !confirmed) {
        return res.status(409).json({ usage });
      }

      if (usage.length > 0) {
        await clearLibraryVoiceReferences(voiceUuid);
      }
      const purgeResult = await eraseLibraryVoiceArtifacts(voiceUuid);
      if (purgeResult.failed.length > 0) {
        console.warn(
          '[voice-library] delete for "%s" left %d artifact(s) ' +
            'un-erased — the entry is RETAINED so the consent gates still cover them:',
          voiceUuid,
          purgeResult.failed.length,
          purgeResult.failed,
        );
        return res.status(200).json({
          deleted: false,
          artifactPurgeIncomplete: true,
          artifactPurgeFailedPaths: purgeResult.failed,
        });
      }

      return res.status(200).json({ deleted: true });
    });
  } catch (e) {
    console.error('[voice-library] delete failed', e);
    /* #2260 FINAL ROUND (B2) — the deepest lock nesting in the codebase (N+1
       acquisitions for N confirmed books, see the route comment above), so this
       is the site MOST likely to produce the class, and it leaked the cast-lock
       key — an absolute workspace path — the same way `/assign` did. */
    res.status(500).json({
      error: requestFailureMessage(e, (e as Error).message || 'Voice library delete failed.'),
    });
  }
});

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}
