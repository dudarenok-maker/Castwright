/* GET   /api/voice-library
   PATCH /api/voice-library/:voiceUuid

   fs-38 Wave 1, Task 4 — the voice-library list + edit routes. Tasks 5, 7, 9,
   10, 11 add more handlers to this same router file. Mounted behind
   requireVoiceLibraryEnabled (voice-library-gate.ts) at the app.ts call
   site, so every handler here can assume the feature is on.

   Handlers stay thin: validate the request, call the Task 3 manifest store
   (workspace/voice-library.ts), respond. No business logic lives here. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { listEntries, readEntry, writeEntry, type VoiceLibraryEntry } from '../workspace/voice-library.js';
import { currentQwenBaseModel } from '../tts/model-paths.js';

export const voiceLibraryRouter = Router();

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

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}
