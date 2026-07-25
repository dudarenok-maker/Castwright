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
  removeEntryDir,
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
import { castJsonPath, qwenVoiceSidecarPath } from '../workspace/paths.js';
import { qwenVoicePtPath } from './qwen-voice.js';
import { qwenStorageKey } from '../tts/voice-mapping.js';
import { selectTtsProvider, type TtsModelKey } from '../tts/index.js';
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
import { getResolvedSidecarUrl } from '../workspace/user-settings.js';
import { findBookByBookId } from '../workspace/scan.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import type { CastCharacter } from '../tts/synthesise-chapter.js';
import { ingestCloneSample } from '../tts/clone-ingest.js';
import { readCandidate, candidateMasterPath, removeCandidate } from '../workspace/clone-candidate.js';
import { deriveEngineArtifact } from '../tts/derive-engine-artifact.js';
import { assessCloneFidelity } from '../tts/clone-fidelity.js';

export const voiceLibraryRouter = Router();

const cloneUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

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
    return res.status(502).json({ error: (e as Error).message || 'Voice design failed.' });
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
    return res.status(502).json({ error: (e as Error).message || 'Voice redesign failed.' });
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
    return res.status(502).json({ error: (e as Error).message || 'Voice sample failed.' });
  }
});

interface AssignBody {
  bookId?: unknown;
  characterId?: unknown;
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
   as the LAST step, after derive + the fidelity check succeed, so no entry is
   written if any earlier step throws (spec §7). SidecarDesignError status is
   preserved (503/502/500) by duck-typing the error's shape in the catch below
   — NOT `instanceof`, because the real sidecar-transport error crosses a
   module boundary (and tests reject with structurally-equal fakes) — not
   flattened like the /design + /redesign catches (#1801). */
voiceLibraryRouter.post('/clone', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { candidateId?: unknown; consent?: unknown; name?: unknown };
  const candidateId = typeof body.candidateId === 'string' ? body.candidateId : '';
  if (!candidateId) return res.status(400).json({ error: '`candidateId` is required.' });
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

      const derived = await deriveEngineArtifact(voiceUuid, 'qwen', {
        masterPcm,
        sampleRate: candidate.master.sampleRate,
        refText: candidate.master.transcript,
      });

      const dir = entryDir(voiceUuid);
      await mkdir(dir, { recursive: true });

      /* Score fidelity on the previewPcm already in hand — NOT a persisted
         file. 3b1 does not write a `preview.mp3`: the user-facing audition
         is served later by the existing POST /:uuid/sample route + its
         sample cache (a re-synth off the cloned .pt). On-disk layout for a
         3b1 cloned entry is master.wav + voice.json only (the .pt lives
         under voices/qwen/, keyed by voiceUuid — see entryDir vs. the
         sidecar's own voice dir). */
      const fidelity = await assessCloneFidelity(masterPcm, derived.previewPcm, candidate.master.sampleRate);

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
      const master: VoiceMaster = { ...candidate.master, clipFile: 'master.wav' };
      const cloned: VoiceLibraryEntry = {
        voiceUuid,
        name,
        provenance: 'cloned',
        tags: [],
        pinned: false,
        consent,
        master,
        sampleTranscript: candidate.master.transcript,
        sampleMeta: {
          durationSeconds: candidate.master.durationSeconds,
          sampleRate: candidate.master.sampleRate,
          qualityChecks: {
            cloneCosine: fidelity.cosine,
            ...(fidelity.warning ? { cloneFidelityWarning: fidelity.warning } : {}),
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
      const status = sde.status >= 400 && sde.status <= 599 ? sde.status : 502;
      return res.status(status).json({ error: sde.reason ?? sde.message ?? 'Clone derivation failed.', code: sde.code });
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
   no consent record at all — nothing to revoke. */
voiceLibraryRouter.post('/:voiceUuid/revoke', async (req: Request, res: Response) => {
  try {
    const { voiceUuid } = req.params;
    const entry = await readEntry(voiceUuid);
    if (!entry) return res.status(404).json({ error: `No voice-library entry "${voiceUuid}".` });
    if (!entry.consent) return res.status(409).json({ error: 'Entry has no consent record to revoke.' });
    const updated = { ...entry, consent: { ...entry.consent, revokedAt: new Date().toISOString() } };
    await writeEntry(updated); // passes the guard — revokedAt is orthogonal (Task 7)
    return res.status(200).json(updated);
  } catch (e) {
    return res.status(502).json({ error: (e as Error).message || 'Revoke failed.' });
  }
});

/* Erase EVERY on-disk artifact of a library voice — not just the manifest
   dir — so "local-only, never leaves the machine" holds through deletion
   (spec §2.4). Windows-safety ordering (spec §7, copied from qwen-voice.ts's
   `tearDownEmotionVariant`): the file removals happen FIRST; the sidecar
   `/qwen/evict-voice` call is a separate, best-effort in-memory-cache-
   coherency step that fires AFTER — never before, and its failure must
   never fail the delete (the sidecar caches prompts in memory; it doesn't
   hold the `.pt` open, so ordering here is about cache freshness, not file
   locking). */
async function eraseLibraryVoiceArtifacts(voiceUuid: string): Promise<void> {
  await removeEntryDir(voiceUuid);

  const qwenVoiceId = `qwen-${voiceUuid}`;
  await rm(qwenVoicePtPath(qwenVoiceId), { force: true }).catch(() => {});
  await rm(qwenVoiceSidecarPath(qwenVoiceId), { force: true }).catch(() => {});

  /* Purge by the REAL cache scope (`qwen-<uuid>`, the storageKey) — design/
     promote (Task 9) and the sample route (Task 10) both cache auditions
     there, not under the bare voiceUuid. Purging `voiceUuid` here (the
     pre-fix behaviour) silently orphaned every cached sample MP3 on
     delete — see the Task 10 reconciliation note above the sample route. */
  purgeVoiceSamples(qwenVoiceId);

  try {
    await fetch(`${getResolvedSidecarUrl()}/qwen/evict-voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voiceId: qwenVoiceId }),
    });
  } catch {
    /* sidecar unreachable — non-fatal, generation reads the fresh (now-
       deleted) state from disk regardless. */
  }
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
