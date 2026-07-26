/* GET   /api/voice-library
   PATCH /api/voice-library/:voiceUuid

   fs-38 Wave 1, Task 4 — the voice-library list + edit routes. Tasks 5, 7, 9,
   10, 11 add more handlers to this same router file. Mounted behind
   requireVoiceLibraryEnabled (voice-library-gate.ts) at the app.ts call
   site, so every handler here can assume the feature is on.

   Handlers stay thin: validate the request, call the Task 3 manifest store
   (workspace/voice-library.ts), respond. No business logic lives here. */

import { Router } from 'express';
import { existsSync } from 'node:fs';
import { mkdir, copyFile, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
  ConsentRequiredError,
  type VoiceConsentRecord,
  type VoiceLibraryEntry,
  type VoiceLibraryEngineStatus,
  type VoiceMaster,
} from '../workspace/voice-library.js';
import { currentQwenBaseModel } from '../tts/model-paths.js';
import { runVoiceDesign } from '../tts/design-voice-core.js';
import { scanLibraryVoiceUsage, clearLibraryVoiceReferences } from '../workspace/voice-library-usage.js';
import { castJsonPath, qwenVoiceSidecarPath, qwenVoiceWavPath } from '../workspace/paths.js';
import { qwenVoicePtPath } from './qwen-voice.js';
import { qwenStorageKey } from '../tts/voice-mapping.js';
import {
  selectTtsProvider,
  engineForModelKey,
  isTtsModelKey,
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
import { findBookByBookId } from '../workspace/scan.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import type { CastCharacter } from '../tts/synthesise-chapter.js';
import { ingestCloneSample } from '../tts/clone-ingest.js';
import { readCandidate, candidateMasterPath, removeCandidate } from '../workspace/clone-candidate.js';
import { deriveEngineArtifact } from '../tts/derive-engine-artifact.js';
import { assessCloneFidelity } from '../tts/clone-fidelity.js';
import { isTransient } from '../tts/retry.js';
import { NoCapacityError } from '../tts/tts-errors.js';
import { purgeCloneArtifacts } from '../workspace/purge-clone-artifacts.js';
import { httpStatusForSidecarError } from './sidecar-error-status.js';

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
const MAX_CLONE_TRANSCRIPT_CHARS = 2000;

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
};

function validateConsentDraft(raw: unknown): CloneConsentDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const personName = typeof c.personName === 'string' ? c.personName.trim() : '';
  const rel = c.relationship;
  const relOk = rel === 'self' || rel === 'family-with-permission' || rel === 'guardian-of-minor';
  if (!personName || !relOk || c.permittedUse !== 'personal') return null;
  return { personName, relationship: rel as VoiceConsentRecord['relationship'], permittedUse: 'personal' };
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

interface DesignBody {
  name?: unknown;
  persona?: unknown;
  languageCode?: unknown;
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

    const result = await withSingleFlight('library:new', async () => {
      const voiceUuid = nanoid();
      const { previewUrl } = await runVoiceDesign({
        storageKey: `qwen-${voiceUuid}`,
        displayName: name,
        persona,
        languageCode,
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

/* POST /api/voice-library/:voiceUuid/redesign

   Stage a redesign of an existing library voice under `<storageKey>-preview`
   (preview:true) so the live `.pt` is untouched while the user A/B-compares.
   → 200 { previewUrl } — the A/B modal plays this against the live sample. */
voiceLibraryRouter.post('/:voiceUuid/redesign', async (req: Request, res: Response) => {
  try {
    const { voiceUuid } = req.params;
    const entry = await readEntry(voiceUuid);
    if (!entry) return res.status(404).json({ error: `No voice-library entry "${voiceUuid}".` });

    const body = (req.body ?? {}) as { persona?: unknown };
    const persona = typeof body.persona === 'string' ? body.persona.trim() : '';
    if (!persona) return res.status(400).json({ error: '`persona` is required.' });

    const result = await withSingleFlight(voiceUuid, async () => {
      const { previewUrl } = await runVoiceDesign({
        storageKey: `qwen-${voiceUuid}`,
        displayName: entry.name,
        persona,
        languageCode: entry.languageCode,
        preview: true,
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
   `.pt` (nothing staged / double-promote) → 409. */
voiceLibraryRouter.post('/:voiceUuid/redesign/promote', async (req: Request, res: Response) => {
  try {
    const { voiceUuid } = req.params;
    const entry = await readEntry(voiceUuid);
    if (!entry) return res.status(404).json({ error: `No voice-library entry "${voiceUuid}".` });

    const storageKey = `qwen-${voiceUuid}`;
    const previewKey = `${storageKey}-preview`;

    try {
      await rm(qwenVoicePtPath(storageKey), { force: true });
      await rename(qwenVoicePtPath(previewKey), qwenVoicePtPath(storageKey));
    } catch (e) {
      return res
        .status(409)
        .json({ error: `No staged preview voice to promote (${(e as Error).message}).` });
    }
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
    const updated: VoiceLibraryEntry = {
      ...entry,
      ...(typeof body.persona === 'string' ? { persona: body.persona } : {}),
    };
    await writeEntry(updated); // stamps a fresh updatedAt
    return res.status(200).json(await readEntry(voiceUuid));
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
   route reflect an upgrade immediately, with no migration/backfill step. */
function withComputedStaleness(entry: VoiceLibraryEntry): VoiceLibraryEntry {
  const qwen = entry.engines.qwen;
  if (!qwen?.baseModel || qwen.baseModel === currentQwenBaseModel()) return entry;
  return { ...entry, engines: { ...entry.engines, qwen: { ...qwen, status: 'stale' } } };
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

    const updated: VoiceLibraryEntry = {
      ...existing,
      ...(body.name !== undefined ? { name: body.name as string } : {}),
      ...(body.tags !== undefined ? { tags: body.tags as string[] } : {}),
      ...(body.pinned !== undefined ? { pinned: body.pinned as boolean } : {}),
      ...(body.persona !== undefined ? { persona: body.persona as string } : {}),
    };
    await writeEntry(updated);
    const written = await readEntry(voiceUuid);
    res.json(written);
  } catch (e) {
    console.error('[voice-library] patch failed', e);
    res.status(500).json({ error: (e as Error).message || 'Voice library update failed.' });
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
   swaps in a master-clip hash for cloned voices instead). */
voiceLibraryRouter.post('/:voiceUuid/sample', async (req: Request, res: Response) => {
  try {
    const { voiceUuid } = req.params;
    const entry = await readEntry(voiceUuid);
    if (!entry) return res.status(404).json({ error: `No voice-library entry "${voiceUuid}".` });
    if (entry.provenance === 'cloned' && (!entry.consent || entry.consent.revokedAt)) {
      return res.status(403).json({ error: 'This cloned voice has no valid consent and cannot be played.' });
    }

    const body = (req.body ?? {}) as { text?: unknown };
    const voiceName = `qwen-${voiceUuid}`;
    const modelKey: TtsModelKey = 'qwen3-tts-0.6b';
    const text =
      typeof body.text === 'string' && body.text.trim().length > 0
        ? body.text.trim()
        : buildSampleText({ id: voiceUuid, character: entry.name, overrideTtsVoices: {} });
    const cacheScope = `qwen-${voiceUuid}`;
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
      return res.status(202).json({ ...result, qualityWarnings: result.qualityWarnings });
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
     re-derive). Bound it in both units — see the constants above for why the
     byte bound is the one that actually holds for non-ASCII.

     Rejected outright rather than truncated: silently dropping the tail of a
     correction would persist a PARTIAL transcript as `transcriptSource:
     'user'`, which every subsequent repair would then faithfully re-derive
     from — the same silent-discard shape this whole change exists to fix. */
  if (typeof body.transcript === 'string' && body.transcript.length > MAX_CLONE_TRANSCRIPT_CHARS) {
    return res
      .status(400)
      .json({ error: `Transcript is too long (max ${MAX_CLONE_TRANSCRIPT_CHARS} characters).` });
  }
  if (!validateConsentDraft(body.consent)) {
    return res
      .status(422)
      .json({ error: 'A complete consent record (person, relationship, permitted use) is required.' });
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

      const derived = await deriveEngineArtifact(voiceUuid, 'qwen', {
        masterPcm,
        sampleRate: candidate.master.sampleRate,
        refText,
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
      const consent: VoiceConsentRecord = {
        personName: consentDraft.personName,
        relationship: consentDraft.relationship,
        permittedUse: 'personal',
        attestedAt: now,
        attestedBy: consentDraft.personName,
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
    return res.status(200).json(entry);
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

/* POST /api/voice-library/:voiceUuid/assign

   Assigns a library voice to ONE character in ONE book — a bespoke,
   character-targeted cast write (NOT `applyOverrideToCastFiles` from
   routes/voices.ts, which is keyed by voiceId across every matching book
   and whose `override` param can't carry `libraryUuid`/`provenance`).
   Reads the book's cast.json, merges the new `qwen` slot into that one
   character's `overrideTtsVoices` (sibling engine slots + the rest of the
   qwen slot survive), and writes back atomically. `character.voiceUuid`
   is never touched — that field is the srv-43 identity key, not something
   an assign should alias. */
voiceLibraryRouter.post('/:voiceUuid/assign', async (req: Request, res: Response) => {
  try {
    const { voiceUuid } = req.params;
    const entry = await readEntry(voiceUuid);
    if (!entry) {
      return res.status(404).json({ error: `No voice-library entry "${voiceUuid}".` });
    }
    if (entry.consent?.revokedAt) {
      return res.status(409).json({ error: 'Consent for this voice has been revoked.' });
    }
    /* fs-38 Wave 3b1 — never assign an un-derived cloned voice (would produce a
       broken slot the moment it's synthesised). The wizard only ever creates
       ready entries; this stops a stale/never-derived cloned entry (or the mock
       demo) from being assigned. */
    if (entry.provenance === 'cloned' && entry.engines?.qwen?.status !== 'ready') {
      return res.status(409).json({ error: 'Cloned voice is not ready to assign yet.' });
    }

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

    const cast = await readJson<CastJson>(castJsonPath(located.bookDir));
    const characters = cast?.characters ?? [];
    const charIndex = characters.findIndex((c) => c.id === characterId);
    if (charIndex === -1) {
      return res
        .status(404)
        .json({ error: `No character "${characterId}" in book "${bookId}".` });
    }

    const character = characters[charIndex];

    /* Task 6b — a cloned voice renders on Qwen ONLY. Assigning one to a
       character that doesn't route to Qwen this run would produce exactly
       the same 3b2 resolver-pre-pass hard-fail this task exists to give an
       accurate reason for ('wrong-engine') — but discovered only at RENDER
       time, chapters deep. Catch it here instead, at assign time, so the
       user gets an actionable 409 immediately.

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
       explicitly cast on Qwen is unaffected by the book/session default
       sitting elsewhere. */
    if (entry.provenance === 'cloned') {
      const requestedModelKey = isTtsModelKey(body.modelKey) ? body.modelKey : undefined;
      const bookDefaultEngine = engineForModelKey(requestedModelKey ?? getResolvedTtsModelKey());
      const routedEngine = resolveCharacterEngine(character, bookDefaultEngine);
      if (routedEngine !== 'qwen') {
        /* I-2 — name the ACTUAL cause. When the character carries its own
           `ttsEngine` override, THAT is why it's not routing to Qwen — the
           book/session default is irrelevant, and telling the user to
           "switch the book's engine" would send them to fix the wrong
           thing (the same misdiagnosis class Part A eliminated for the
           render-time error). */
        const characterCaused = Boolean(character.ttsEngine);
        const cause = characterCaused
          ? `"${character.name ?? characterId}" is cast on ${routedEngine}`
          : `this book is set to ${routedEngine}`;
        const fix = characterCaused
          ? `Switch the character's engine to Qwen (or reassign the character)`
          : `Switch the book's engine to Qwen`;
        return res.status(409).json({
          error: `Cloned voices render on Qwen, but ${cause}. ${fix} before assigning "${character.name ?? characterId}".`,
        });
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
       the previous base and don't carry over. */
    const nextCharacters = [...characters];
    nextCharacters[charIndex] = {
      ...character,
      overrideTtsVoices: {
        ...character.overrideTtsVoices,
        qwen: {
          ...character.overrideTtsVoices?.qwen,
          name: `qwen-${voiceUuid}`,
          libraryUuid: voiceUuid,
          provenance: entry.provenance,
          variants: undefined,
        },
      },
    };

    await writeJsonAtomic(castJsonPath(located.bookDir), { ...cast, characters: nextCharacters });

    res.status(200).json({ updated: 1 });
  } catch (e) {
    console.error('[voice-library] assign failed', e);
    res.status(500).json({ error: (e as Error).message || 'Voice library assign failed.' });
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
   rather than claiming clean erasure it didn't achieve. */
voiceLibraryRouter.post('/:voiceUuid/revoke', async (req: Request, res: Response) => {
  try {
    const { voiceUuid } = req.params;
    const entry = await readEntry(voiceUuid);
    if (!entry) return res.status(404).json({ error: `No voice-library entry "${voiceUuid}".` });
    if (!entry.consent) return res.status(409).json({ error: 'Entry has no consent record to revoke.' });
    const updated = { ...entry, consent: { ...entry.consent, revokedAt: new Date().toISOString() } };
    await writeEntry(updated); // passes the guard — revokedAt is orthogonal (Task 7)
    // Erase resynthesis-capable artifacts AND the original recording itself.
    const purgeResult = await purgeCloneArtifacts(voiceUuid, { deleteMasterClip: true });
    const final = (await readEntry(voiceUuid)) ?? updated;
    if (purgeResult.failed.length > 0) {
      console.warn(
        `[voice-library] revoke for "${voiceUuid}" left ${purgeResult.failed.length} artifact(s) ` +
          `un-erased:`,
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
   revoke route above. */
async function eraseLibraryVoiceArtifacts(voiceUuid: string): Promise<void> {
  await purgeCloneArtifacts(voiceUuid, { deleteEntryDir: true });
}

/* DELETE /api/voice-library/:voiceUuid

   Usage-scan + confirm, then multi-location erasure (spec §2.4/§7). Any
   character across the workspace whose overrideTtsVoices[*].libraryUuid
   matches this voice is reported via 409 unless the caller passes
   `?confirm=1`; on confirm (or when unused) the matching override slots are
   cleared first — leaving those characters voiceless on that engine, which
   the fe-46 gate surfaces — THEN every derived artifact is erased. */
voiceLibraryRouter.delete('/:voiceUuid', async (req: Request, res: Response) => {
  try {
    const { voiceUuid } = req.params;
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
    await eraseLibraryVoiceArtifacts(voiceUuid);

    res.status(200).json({ deleted: true });
  } catch (e) {
    console.error('[voice-library] delete failed', e);
    res.status(500).json({ error: (e as Error).message || 'Voice library delete failed.' });
  }
});

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}
