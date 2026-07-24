/* GET   /api/voice-library
   PATCH /api/voice-library/:voiceUuid

   fs-38 Wave 1, Task 4 — the voice-library list + edit routes. Tasks 5, 7, 9,
   10, 11 add more handlers to this same router file. Mounted behind
   requireVoiceLibraryEnabled (voice-library-gate.ts) at the app.ts call
   site, so every handler here can assume the feature is on.

   Handlers stay thin: validate the request, call the Task 3 manifest store
   (workspace/voice-library.ts), respond. No business logic lives here. */

import { Router } from 'express';
import { rename, rm } from 'node:fs/promises';
import { nanoid } from 'nanoid';
import type { Request, Response } from '../http.js';
import {
  listEntries,
  readEntry,
  removeEntryDir,
  writeEntry,
  type VoiceLibraryEntry,
} from '../workspace/voice-library.js';
import { currentQwenBaseModel } from '../tts/model-paths.js';
import { runVoiceDesign } from '../tts/design-voice-core.js';
import { scanLibraryVoiceUsage, clearLibraryVoiceReferences } from '../workspace/voice-library-usage.js';
import { castJsonPath, qwenVoiceSidecarPath } from '../workspace/paths.js';
import { qwenVoicePtPath } from './qwen-voice.js';
import { purgeVoiceSamples } from '../tts/voice-sample-cache.js';
import { getResolvedSidecarUrl } from '../workspace/user-settings.js';
import { findBookByBookId } from '../workspace/scan.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import type { CastCharacter } from '../tts/synthesise-chapter.js';

export const voiceLibraryRouter = Router();

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

interface AssignBody {
  bookId?: unknown;
  characterId?: unknown;
}

interface CastJson {
  characters?: CastCharacter[];
}

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

  purgeVoiceSamples(voiceUuid);

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
