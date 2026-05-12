/* GET /api/voices
   PUT /api/voices/:voiceId/pin

   The voice "library" is a derived view of every book's confirmed cast.json
   in the workspace — there's no separate voice store. Each character becomes
   a reusable Voice keyed by `c.voiceId ?? c.id`, which is the same id the TTS
   layer hashes against (see server/src/tts/synthesise-chapter.ts:91 and
   voice-mapping.ts:pickGeminiVoice). So cached sample WAVs at
   /audio/voices/{voiceId}-{modelKey}.wav line up automatically.

   Pin flags live in audiobook-workspace/voices.json (workspace-scope, not
   per-book) since they decide where a voice surfaces across every book. */

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
import {
  resolveGeminiAssignment,
  type CharacterHint,
  type TtsVoiceAssignment,
} from '../tts/voice-mapping.js';

export const voicesRouter = Router();

interface DerivedVoice {
  id: string;
  character: string;
  bookTitle: string;
  bookId: string;
  attributes: string[];
  gradient: [string, string];
  usedIn: number;
  source: 'current' | 'library';
  reusable?: boolean;
  pinned?: boolean;
  ttsVoice: TtsVoiceAssignment;
}

interface CastJsonCharacter {
  id: string;
  name?: string;
  role?: string;
  voiceId?: string;
  attributes?: string[];
  description?: string;
  gender?: 'male' | 'female' | 'neutral';
  ageRange?: 'child' | 'teen' | 'adult' | 'elderly';
  tone?: { warmth?: number; pace?: number; authority?: number; emotion?: number };
  evidence?: Array<{ quote?: string; note?: string }>;
}

interface CastJson {
  characters?: CastJsonCharacter[];
}

function buildHint(c: CastJsonCharacter): CharacterHint {
  const evidence = (c.evidence ?? [])
    .map(e => e.quote)
    .filter((q): q is string => typeof q === 'string' && q.length > 0);
  return {
    description: c.description,
    role: c.role,
    gender: c.gender,
    ageRange: c.ageRange,
    tone: c.tone,
    evidence: evidence.length ? evidence : undefined,
  };
}

interface VoicesMetaJson {
  pinned: string[];
  updatedAt: string;
}

/* 8-entry palette mirroring scan.ts:deterministicGradient. Keyed off voiceId
   so the same voice always looks the same across renders and books. */
const VOICE_PALETTE: Array<[string, string]> = [
  ['#3C194F', '#0F0E0D'],
  ['#F79A83', '#A43C6C'],
  ['#7C5C8C', '#3C194F'],
  ['#6B6663', '#1A1A1A'],
  ['#4A6878', '#1F3441'],
  ['#C28BA8', '#7A3A5C'],
  ['#A8D5BA', '#4A7B6B'],
  ['#D4A04E', '#7B5A26'],
];

function deterministicGradient(seed: string): [string, string] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  return VOICE_PALETTE[Math.abs(h) % VOICE_PALETTE.length];
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
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch { return []; }
}

async function loadVoicesMeta(): Promise<VoicesMetaJson> {
  const data = await readJson<VoicesMetaJson>(voicesMetaPath());
  if (!data) return { pinned: [], updatedAt: new Date(0).toISOString() };
  return { pinned: Array.isArray(data.pinned) ? data.pinned : [], updatedAt: data.updatedAt };
}

async function aggregateVoices(currentBookId: string | undefined): Promise<DerivedVoice[]> {
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

        for (const c of cast.characters) {
          const id = c.voiceId ?? c.id;
          if (!id) continue;
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
            }
            continue;
          }
          const isCurrent = !!currentBookId && state.bookId === currentBookId;
          const ttsVoice = resolveGeminiAssignment(
            { id, character: c.name, attributes: c.attributes ?? [] },
            buildHint(c),
          );
          acc.set(id, {
            id,
            character: c.name ?? id,
            bookTitle: state.title,
            bookId: state.bookId,
            attributes: c.attributes ?? [],
            gradient: deterministicGradient(id),
            usedIn: 1,
            source: isCurrent ? 'current' : 'library',
            reusable: isNarratorId(id, c.name) || undefined,
            pinned: pinned.has(id) || undefined,
            ttsVoice,
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
    const currentBookId = typeof req.query.currentBookId === 'string' ? req.query.currentBookId : undefined;
    const voices = await aggregateVoices(currentBookId);
    res.json({ voices });
  } catch (e) {
    console.error('[voices] aggregate failed', e);
    res.status(500).json({ error: (e as Error).message || 'Voice library scan failed.' });
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
