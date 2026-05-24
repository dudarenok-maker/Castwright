/* GET    /api/voices
   GET    /api/voices/base
   PUT    /api/voices/:voiceId/pin
   PUT    /api/voices/:voiceId/override

   The voice "library" is a derived view of every book's confirmed cast.json
   in the workspace — there's no separate voice store. Each character becomes
   a reusable Voice keyed by `c.voiceId ?? c.id`, which is the same id the TTS
   layer hashes against (see server/src/tts/synthesise-chapter.ts and
   voice-mapping.ts:pickVoiceForEngine). Cached sample MP3s live at
   /audio/voices/{voiceId}-{modelKey}-{paramHash}.mp3 — the trailing hash
   captures the synthesis inputs so attribute edits bust the cache.

   The aggregator stamps each voice with a `ttsVoice` assignment so the cast
   view can label "what this voice will sound like" without round-tripping.
   The assignment is engine-specific; the engine is taken from the optional
   `engine` query param (default 'coqui' to match the UI's default).

   Pin flags live in audiobook-workspace/voices.json (workspace-scope, not
   per-book) since they decide where a voice surfaces across every book.

   Override flags (`overrideTtsVoice`) live on the character entry inside
   each cast.json — they belong to the character's identity, same as
   `voiceId` and `gender`. When a user overrides a Voice family that spans
   multiple books, every character sharing that voiceId picks up the same
   override (writing through to each cast.json). */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Router, type Request, type Response } from 'express';
import {
  BOOKS_ROOT,
  castJsonPath,
  ensureWorkspace,
  stateJsonPath,
  voicesMetaPath,
} from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import type { BookStateJson } from '../workspace/scan.js';
import { resolveVoiceAssignment, type TtsVoiceAssignment } from '../tts/voice-mapping.js';
import { gradientForTtsVoice } from '../tts/voice-palette.js';
import { buildHintFromCast, type CastCharacter } from '../tts/synthesise-chapter.js';
import type { TtsEngine } from '../tts/index.js';
import {
  listBaseVoices,
  invalidateBaseVoiceCache,
  type BaseVoiceEntry,
} from '../tts/base-voices.js';
import { getResolvedSidecarUrl } from '../workspace/user-settings.js';

export const voicesRouter = Router();

interface DerivedVoice {
  id: string;
  character: string;
  bookTitle: string;
  bookId: string;
  /** Series name parsed from the book directory (`books/<Author>/<Series>/<Book>`),
      or null for standalones. Used by the voice-family-grouped Voices view
      to nest cast members under their book series. */
  bookSeries: string | null;
  attributes: string[];
  gradient: [string, string];
  usedIn: number;
  source: 'current' | 'library';
  reusable?: boolean;
  pinned?: boolean;
  ttsVoice: TtsVoiceAssignment;
  /** Per-engine user-set voice overrides. The `ttsVoice` field above
      resolves to the slot matching the query's `engine`; this map is
      surfaced separately so the UI can render all engine assignments
      across tabs and offer per-engine "Clear" buttons. */
  overrideTtsVoices?: Partial<Record<TtsEngine, { name: string }>> | null;
  /** @deprecated Surfaced for one release so old clients still parse
      the response. New clients read `overrideTtsVoices`. Populated from
      the active engine's slot when present. */
  overrideTtsVoice?: { engine: TtsEngine; name: string } | null;
}

/* Read-time migration. Older cast.json files (pre-Kokoro) stored a
   singular `overrideTtsVoice: { engine, name }`. The plural map is
   strictly more expressive — fold the legacy field into the right slot
   and drop it. New writes always emit `overrideTtsVoices`; the singular
   field is removed once a cast is normalised so we don't carry both. */
function normaliseCastCharacter(c: CastCharacter): CastCharacter {
  const legacy = c.overrideTtsVoice;
  if (!legacy || !legacy.name || !legacy.engine) return c;
  const existing = c.overrideTtsVoices ?? {};
  /* Don't clobber an explicit map entry — if the new field already names
     a voice for the legacy field's engine, that's the authoritative one
     (newer-format-wins). The legacy field is only load-bearing when the
     new map has no slot for its engine. */
  const merged = { ...existing };
  if (!merged[legacy.engine]?.name) {
    merged[legacy.engine] = { name: legacy.name };
  }
  return { ...c, overrideTtsVoices: merged, overrideTtsVoice: null };
}

interface CastJson {
  characters?: CastCharacter[];
}

interface VoicesMetaJson {
  pinned: string[];
  updatedAt: string;
}

function isNarratorId(id: string, name?: string): boolean {
  const lid = id.toLowerCase();
  if (lid === 'narrator' || lid === 'char-narrator') return true;
  return (name ?? '').toLowerCase() === 'narrator';
}

function listDirs(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

async function loadVoicesMeta(): Promise<VoicesMetaJson> {
  const data = await readJson<VoicesMetaJson>(voicesMetaPath());
  if (!data) return { pinned: [], updatedAt: new Date(0).toISOString() };
  return { pinned: Array.isArray(data.pinned) ? data.pinned : [], updatedAt: data.updatedAt };
}

function parseEngine(value: unknown): TtsEngine {
  if (
    value === 'gemini' ||
    value === 'coqui' ||
    value === 'piper' ||
    value === 'kokoro' ||
    value === 'qwen'
  )
    return value;
  return 'coqui';
}

function normaliseSeries(name: string): string | null {
  /* `Standalones` is the synthetic series slot used for one-off books — it's
     not a real series the user would want to see as a nested header. Treat
     it as null so the UI can flatten standalones rather than grouping them. */
  if (!name) return null;
  if (name === 'Standalones') return null;
  return name;
}

async function aggregateVoices(
  currentBookId: string | undefined,
  engine: TtsEngine,
): Promise<DerivedVoice[]> {
  ensureWorkspace();
  const meta = await loadVoicesMeta();
  const pinned = new Set(meta.pinned);

  /* voiceId → derived voice (first occurrence wins on identity fields;
     usedIn aggregates across every book that contains the same voiceId). */
  const acc = new Map<string, DerivedVoice & { books: Set<string> }>();

  for (const authorName of listDirs(BOOKS_ROOT)) {
    for (const seriesName of listDirs(join(BOOKS_ROOT, authorName))) {
      for (const titleName of listDirs(join(BOOKS_ROOT, authorName, seriesName))) {
        const bookDir = join(BOOKS_ROOT, authorName, seriesName, titleName);
        const state = await readJson<BookStateJson>(stateJsonPath(bookDir));
        if (!state || !state.castConfirmed) continue;
        const cast = await readJson<CastJson>(castJsonPath(bookDir));
        if (!cast?.characters?.length) continue;

        for (const rawC of cast.characters) {
          /* Apply read-time migration so the rest of this loop never
             sees the legacy singular field. */
          const c = normaliseCastCharacter(rawC);
          const id = c.voiceId ?? c.id;
          if (!id) continue;
          const overrideMap = c.overrideTtsVoices ?? null;
          const overrideForEngine = overrideMap?.[engine] ?? null;
          const legacyShape = overrideForEngine ? { engine, name: overrideForEngine.name } : null;
          const existing = acc.get(id);
          if (existing) {
            existing.books.add(state.bookId);
            existing.usedIn = existing.books.size;
            /* Promote to 'current' if any book containing this voice is the
               currently-open one. */
            if (currentBookId && state.bookId === currentBookId) {
              existing.source = 'current';
              existing.bookTitle = state.title;
              existing.bookId = state.bookId;
              existing.bookSeries = normaliseSeries(seriesName);
            }
            /* Merge override maps across books with the same voiceId.
               Conflicts are unlikely (the override write loops every
               cast.json), but if they happen, first-seen wins per
               engine slot. */
            if (overrideMap) {
              const merged: Partial<Record<TtsEngine, { name: string }>> = {
                ...(existing.overrideTtsVoices ?? {}),
              };
              for (const [eng, val] of Object.entries(overrideMap)) {
                const e = eng as TtsEngine;
                if (val?.name && !merged[e]?.name) merged[e] = { name: val.name };
              }
              existing.overrideTtsVoices = merged;
              existing.overrideTtsVoice = merged[engine]
                ? { engine, name: merged[engine]!.name }
                : null;
            }
            continue;
          }
          const isCurrent = !!currentBookId && state.bookId === currentBookId;
          const ttsVoice = resolveVoiceAssignment(
            engine,
            {
              id,
              character: c.name,
              attributes: c.attributes ?? [],
              overrideTtsVoices: overrideMap,
            },
            buildHintFromCast(c),
          );
          acc.set(id, {
            id,
            character: c.name ?? id,
            bookTitle: state.title,
            bookId: state.bookId,
            bookSeries: normaliseSeries(seriesName),
            attributes: c.attributes ?? [],
            gradient: gradientForTtsVoice(ttsVoice.name, id),
            usedIn: 1,
            source: isCurrent ? 'current' : 'library',
            reusable: isNarratorId(id, c.name) || undefined,
            pinned: pinned.has(id) || undefined,
            ttsVoice,
            overrideTtsVoices: overrideMap,
            overrideTtsVoice: legacyShape,
            books: new Set([state.bookId]),
          });
        }
      }
    }
  }

  /* Strip the internal `books` Set and sort: pinned first, then by usedIn
     desc, then by character name. */
  return Array.from(acc.values())
    .map(({ books: _b, ...v }) => v)
    .sort((a, b) => {
      const ap = a.pinned ? 1 : 0;
      const bp = b.pinned ? 1 : 0;
      if (ap !== bp) return bp - ap;
      if (a.usedIn !== b.usedIn) return b.usedIn - a.usedIn;
      return a.character.localeCompare(b.character);
    });
}

voicesRouter.get('/', async (req: Request, res: Response) => {
  try {
    const currentBookId =
      typeof req.query.currentBookId === 'string' ? req.query.currentBookId : undefined;
    const engine = parseEngine(req.query.engine);
    const voices = await aggregateVoices(currentBookId, engine);
    res.json({ voices });
  } catch (e) {
    console.error('[voices] aggregate failed', e);
    res.status(500).json({ error: (e as Error).message || 'Voice library scan failed.' });
  }
});

/* GET /api/voices/base — base-voice catalog across every engine. Used by
   the Voices view's "Base voices" tab and the Profile Drawer's override
   picker. Coqui entries come from the live sidecar manifest (with a
   fallback to the static catalog when the sidecar is down); Gemini lists
   all 30 published prebuilt voices. Piper/Kokoro are empty until their
   tables land in voice-mapping.ts. */
voicesRouter.get('/base', async (_req: Request, res: Response) => {
  try {
    const sidecarUrl = getResolvedSidecarUrl();
    const voices: BaseVoiceEntry[] = await listBaseVoices({ sidecarUrl });
    res.json({ voices });
  } catch (e) {
    console.error('[voices] base catalog failed', e);
    res.status(500).json({ error: (e as Error).message || 'Base-voice catalog failed.' });
  }
});

voicesRouter.put('/:voiceId/pin', async (req: Request, res: Response) => {
  try {
    const { voiceId } = req.params;
    const body = (req.body ?? {}) as { pinned?: unknown };
    if (typeof body.pinned !== 'boolean') {
      return res.status(400).json({ error: 'Body must include `pinned: boolean`.' });
    }
    ensureWorkspace();
    const meta = await loadVoicesMeta();
    const set = new Set(meta.pinned);
    if (body.pinned) set.add(voiceId);
    else set.delete(voiceId);
    const next: VoicesMetaJson = {
      pinned: Array.from(set).sort(),
      updatedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(voicesMetaPath(), next);
    res.status(204).end();
  } catch (e) {
    console.error('[voices] pin failed', e);
    res.status(500).json({ error: (e as Error).message || 'Pin update failed.' });
  }
});

/* PUT /api/voices/:voiceId/override — set or clear the manual base-voice
   override for every cast.json character whose voiceId matches. Body shape:
       { override: { engine, name } }   to set
       { override: null }               to clear
   Walks every confirmed-cast book in the workspace because the same voiceId
   can recur across a series — they're meant to be the same character, so
   one override applies to all. */
voicesRouter.put('/:voiceId/override', async (req: Request, res: Response) => {
  const { voiceId } = req.params;
  const body = (req.body ?? {}) as { override?: unknown };
  const parsed = parseOverrideField(body.override);
  if (parsed === 'invalid') {
    return res.status(400).json({
      error: 'Body must include `override: { engine, name }` or `override: null`.',
    });
  }
  try {
    ensureWorkspace();
    const updates = await applyOverrideToCastFiles(voiceId, parsed);
    if (updates === 0) {
      return res
        .status(404)
        .json({ error: `No character with voiceId "${voiceId}" found in any confirmed cast.` });
    }
    res.status(204).end();
  } catch (e) {
    console.error('[voices] override failed', e);
    res.status(500).json({ error: (e as Error).message || 'Override update failed.' });
  }
});

function parseOverrideField(
  value: unknown,
): { engine: TtsEngine; name: string } | null | 'invalid' {
  if (value === null) return null;
  if (typeof value !== 'object' || value === null) return 'invalid';
  const v = value as { engine?: unknown; name?: unknown };
  if (typeof v.engine !== 'string' || typeof v.name !== 'string') return 'invalid';
  if (
    v.engine !== 'coqui' &&
    v.engine !== 'gemini' &&
    v.engine !== 'piper' &&
    v.engine !== 'kokoro' &&
    v.engine !== 'qwen'
  )
    return 'invalid';
  if (v.name.trim().length === 0) return 'invalid';
  return { engine: v.engine, name: v.name.trim() };
}

/* Apply a per-engine override across every cast.json that contains a
   character with this voiceId.
     - override = { engine, name } → set `overrideTtsVoices[engine] = { name }`,
       leaving other engine slots untouched.
     - override = null → clear ALL engine slots (drop the map entirely).
   Clearing one specific engine slot isn't in the API yet; if the UI
   needs it, send `{ engine, name: '' }` — but parseOverrideField rejects
   empty names, so we'd extend the parser to accept that as "delete slot".

   Each touched character is also normalised: the legacy singular
   `overrideTtsVoice` field is folded into the new map and removed,
   so one user action upgrades the cast.json shape. */
async function applyOverrideToCastFiles(
  voiceId: string,
  override: { engine: TtsEngine; name: string } | null,
): Promise<number> {
  let updated = 0;
  for (const authorName of listDirs(BOOKS_ROOT)) {
    for (const seriesName of listDirs(join(BOOKS_ROOT, authorName))) {
      for (const titleName of listDirs(join(BOOKS_ROOT, authorName, seriesName))) {
        const bookDir = join(BOOKS_ROOT, authorName, seriesName, titleName);
        const state = await readJson<BookStateJson>(stateJsonPath(bookDir));
        if (!state || !state.castConfirmed) continue;
        const cast = await readJson<CastJson>(castJsonPath(bookDir));
        if (!cast?.characters?.length) continue;
        let dirty = false;
        for (let i = 0; i < cast.characters.length; i++) {
          const original = cast.characters[i];
          const id = original.voiceId ?? original.id;
          if (id !== voiceId) continue;
          const normalised = normaliseCastCharacter(original);
          const replacement: CastCharacter = { ...normalised };
          if (override === null) {
            delete replacement.overrideTtsVoices;
          } else {
            const map = { ...(normalised.overrideTtsVoices ?? {}) };
            map[override.engine] = { name: override.name };
            replacement.overrideTtsVoices = map;
          }
          /* Always remove the legacy singular field — normaliseCastCharacter
             already folded it into the map. */
          delete replacement.overrideTtsVoice;
          cast.characters[i] = replacement;
          dirty = true;
          updated += 1;
        }
        if (dirty) {
          await writeJsonAtomic(castJsonPath(bookDir), cast);
        }
      }
    }
  }
  /* Override changes don't affect the base-voice catalog itself, but call
     this anyway so a future invocation refreshes /speakers cleanly if the
     sidecar was bounced in between. Cheap and side-effect free. */
  if (updated > 0) invalidateBaseVoiceCache();
  return updated;
}
