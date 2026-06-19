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
import { Router } from 'express';
import type { Request, Response } from '../http.js';
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
  resolveVoiceAssignment,
  qwenStorageKey,
  type TtsVoiceAssignment,
} from '../tts/voice-mapping.js';
import { gradientForTtsVoice } from '../tts/voice-palette.js';
import { buildHintFromCast, type CastCharacter } from '../tts/synthesise-chapter.js';
import {
  createWorkspaceCastLoader,
  hydrateCastReusedVoices,
} from '../tts/hydrate-reused-voice-workspace.js';
import type { TtsEngine } from '../tts/index.js';
import {
  listBaseVoices,
  invalidateBaseVoiceCache,
  type BaseVoiceEntry,
} from '../tts/base-voices.js';
import { getResolvedSidecarUrl } from '../workspace/user-settings.js';
import { findAuthorSeriesForBookId } from '../workspace/series-cast-scan.js';
import { collectRenderedQwenVoiceNames } from '../audio/segments-io.js';
import { listVoiceSampleFiles } from '../tts/voice-sample-cache.js';

/* The single model key the bespoke Qwen engine synthesises under (mirror of
   the frontend's QWEN_MODEL_KEY / sampleModelKeyForEngine). Cached auditions
   are named `<scope>-qwen3-tts-0.6b-<hash>.mp3`, so the `sampled` scan anchors
   on this literal. Revisit if a second Qwen synth key is ever added. */
const QWEN_SAMPLE_MODEL_KEY = 'qwen3-tts-0.6b';

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
  /** The underlying character's alternate names + cross-book
      "not-linked-to" pairs, copied straight off cast.json. Synthesis
      ignores both; they ride along so the voices-view duplicate detector
      can suppress already-resolved pairs on the global `#/voices` tab,
      where no book cast is hydrated (plan 101 bug fix 2026-05-26). */
  aliases?: string[];
  notLinkedTo?: Array<{ bookId: string; characterId: string }>;
  gradient: [string, string];
  usedIn: number;
  source: 'current' | 'library';
  /** True when this voice belongs to a book in the currently-open book's
      (author, series) — including the open book itself. Always falsy when no
      book is open or the open book is a standalone (a standalone has no
      series continuity). Drives the cast view's "Series" tab, which scopes to
      `source === 'library' && inCurrentSeries` so it shows only this series'
      siblings rather than every other book in the workspace. */
  inCurrentSeries?: boolean;
  reusable?: boolean;
  pinned?: boolean;
  /** True when this voice has rendered chapter audio at least once.
      Populated only for bespoke Qwen voices (the engine query is 'qwen')
      by scanning rendered segments for the resolved voiceId; preset voices
      omit it. Drives the Voices view's "Designed" vs "Generated" split and
      the cast Status column. Cross-book: true if rendered in ANY book that
      carries this voiceId — for the dominant single-book character that
      equals "rendered in this book". */
  generated?: boolean;
  /** True when a 12s audition has been synthesised for this voice — the
      lifecycle tier between "Designed" and "Generated". Populated only for
      bespoke Qwen voices (the engine query is 'qwen') by checking the
      voice-sample cache for a `<scope>-qwen3-tts-0.6b-*.mp3` file, where
      `scope = voiceId ?? char-<characterId>` (the same scope the player +
      design route cache under). Cross-book like `generated`; preset voices
      omit it. A `generated` voice outranks `sampled` at the presentation
      layer. */
  sampled?: boolean;
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
  /** srv-43 — immutable per-voice identity (nanoid) minted at design time.
      Copied from the source Character. Absent on pre-srv-43 designs and
      catalog voices. */
  voiceUuid?: string;
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

  /* bookId → its (author, series, isStandalone), recorded for every book that
     contributes voices. Used after the scan to resolve which voices belong to
     the open book's series (the `inCurrentSeries` flag). */
  const bookMeta = new Map<string, { author: string; series: string; isStandalone: boolean }>();

  /* One memoised cast loader for reused-voice hydration, shared across every
     book scanned below so each source book's cast.json is read at most once
     (many reused characters across the series resolve to the same source). */
  const reuseLoader = createWorkspaceCastLoader();

  /* The voice-sample cache is workspace-global (not per-book), so read it
     once. Empty for preset engines — the `sampled` lifecycle tier is
     Qwen-only, matching the `generated` invariant. A character has been
     "Sampled" when a `<scope>-qwen3-tts-0.6b-*.mp3` audition exists, where
     `scope = voiceId ?? char-<characterId>`. */
  const sampleFiles = engine === 'qwen' ? listVoiceSampleFiles() : [];
  const hasCachedQwenSample = (sampleScope: string): boolean => {
    const prefix = `${sampleScope}-${QWEN_SAMPLE_MODEL_KEY}-`;
    return sampleFiles.some((f) => f.startsWith(prefix));
  };

  for (const authorName of listDirs(BOOKS_ROOT)) {
    for (const seriesName of listDirs(join(BOOKS_ROOT, authorName))) {
      for (const titleName of listDirs(join(BOOKS_ROOT, authorName, seriesName))) {
        const bookDir = join(BOOKS_ROOT, authorName, seriesName, titleName);
        const state = await readJson<BookStateJson>(stateJsonPath(bookDir));
        if (!state || !state.castConfirmed) continue;
        const cast = await readJson<CastJson>(castJsonPath(bookDir));
        if (!cast?.characters?.length) continue;

        bookMeta.set(state.bookId, {
          author: state.author,
          series: state.series,
          isStandalone: state.isStandalone === true,
        });

        /* Hydrate reused characters' bespoke voice from their source book so the
           ttsVoice assignment below reflects the DESIGNED voice, not the empty
           "no voice designed yet" stub. A reused Qwen character carries only
           voiceId + matchedFrom on disk; this folds the source book's
           ttsEngine + overrideTtsVoices onto it (no-op for non-reused or
           already-designed characters). Mirrors the same hydration the
           generation path applies, so the cast view and what actually renders
           agree. */
        cast.characters = await hydrateCastReusedVoices(cast.characters, reuseLoader);

        /* For the Qwen engine, collect which designed voiceIds actually
           rendered audio in this book (scanning the per-chapter segments).
           Empty for preset engines — the scan only runs for 'qwen', so the
           extra disk reads never touch the Coqui/Kokoro/Gemini path. */
        const renderedQwenNames =
          engine === 'qwen'
            ? await collectRenderedQwenVoiceNames(bookDir, state.chapters)
            : new Set<string>();

        for (const rawC of cast.characters) {
          /* Apply read-time migration so the rest of this loop never
             sees the legacy singular field. */
          const c = normaliseCastCharacter(rawC);
          const id = c.voiceId ?? c.id;
          if (!id) continue;
          /* The sample-cache scope keys on `char-<id>` (not bare `<id>`) for a
             voiceId-less character — matching the frontend's sampleScopeFor —
             so it can diverge from `id` above. Compute it explicitly. */
          const sampleScope = c.voiceId ?? `char-${c.id}`;
          /* srv-43 Wave 2 — the on-disk storage key for this character's bespoke
             Qwen voice (qwen-<uuid> when a uuid exists, else qwen-<voiceId>).
             Used to key generated-flag lookups against renderedQwenNames (which
             contains STORAGE keys from segment snapshots), independently of the
             human display name emitted on ttsVoice.name below. */
          const qwenStoreKey =
            engine === 'qwen' ? qwenStorageKey({ voiceUuid: c.voiceUuid, voiceId: c.voiceId }, id) : null;
          const overrideMap = c.overrideTtsVoices ?? null;
          const overrideForEngine = overrideMap?.[engine] ?? null;
          const legacyShape = overrideForEngine ? { engine, name: overrideForEngine.name } : null;
          const existing = acc.get(id);
          if (existing) {
            existing.books.add(state.bookId);
            existing.usedIn = existing.books.size;
            /* Promote to generated if this book rendered the voice, even
               when the identity fields froze on an earlier (unrendered) book.
               srv-43 Wave 2: compare against the STORAGE key (qwen-<uuid> or
               qwen-<voiceId>), not ttsVoice.name which is now the human display
               name (qwen-<voiceId>) regardless of whether a uuid is present. */
            const existingStoreKey =
              engine === 'qwen'
                ? qwenStorageKey(
                    { voiceUuid: existing.voiceUuid, voiceId: existing.id },
                    existing.id,
                  )
                : null;
            if (
              !existing.generated &&
              existingStoreKey &&
              renderedQwenNames.has(existingStoreKey)
            ) {
              existing.generated = true;
            }
            /* Likewise promote to sampled if any book carrying this voiceId
               has a cached audition (sample cache is global, so the scope
               matches regardless of which book first seeded the entry). */
            if (!existing.sampled && hasCachedQwenSample(sampleScope)) {
              existing.sampled = true;
            }
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
          const ttsVoiceRaw = resolveVoiceAssignment(
            engine,
            {
              id,
              character: c.name,
              attributes: c.attributes ?? [],
              overrideTtsVoices: overrideMap,
            },
            buildHintFromCast(c),
          );
          /* srv-43 Wave 2: for a DESIGNED Qwen voice (ttsVoice.name is non-empty,
             meaning a qwen override exists), replace the opaque storage key
             (qwen-<uuid>) with the human display name (qwen-<voiceId>).
             This restores the cast-view label and makes the cross-book dedup
             bucket on the stable per-voice-id name rather than the uuid.
             Undesigned qwen voices (ttsVoice.name === '') and all other engines
             are left untouched. */
          const ttsVoice: TtsVoiceAssignment =
            engine === 'qwen' && ttsVoiceRaw.name
              ? { ...ttsVoiceRaw, name: `qwen-${id}` }
              : ttsVoiceRaw;
          acc.set(id, {
            id,
            character: c.name ?? id,
            bookTitle: state.title,
            bookId: state.bookId,
            bookSeries: normaliseSeries(seriesName),
            attributes: c.attributes ?? [],
            /* First-seen character's alias / not-linked-to sets win — same
               "identity fields freeze on first occurrence" rule the rest of
               this object follows. Duplicate-candidate voices have distinct
               voiceIds (one per book), so each candidate row carries its own
               character's sets; a voiceId that legitimately spans books is
               already linked and never forms a candidate pair. */
            aliases: c.aliases?.length ? c.aliases : undefined,
            notLinkedTo: c.notLinkedTo?.length ? c.notLinkedTo : undefined,
            gradient: gradientForTtsVoice(ttsVoice.name, id),
            usedIn: 1,
            source: isCurrent ? 'current' : 'library',
            reusable: isNarratorId(id, c.name) || undefined,
            pinned: pinned.has(id) || undefined,
            /* srv-43 Wave 2: key on the STORAGE key (qwenStoreKey) so a uuid-
               bearing voice (storage key = qwen-<uuid>) still matches the
               rendered snapshot even though ttsVoice.name is now qwen-<voiceId>. */
            generated: (qwenStoreKey ? renderedQwenNames.has(qwenStoreKey) : false) || undefined,
            sampled: hasCachedQwenSample(sampleScope) || undefined,
            ttsVoice,
            overrideTtsVoices: overrideMap,
            overrideTtsVoice: legacyShape,
            voiceUuid: c.voiceUuid,
            books: new Set([state.bookId]),
          });
        }
      }
    }
  }

  /* Resolve the open book's series (null when no book is open, the book has
     no derived voices, or it's a standalone), then flag every voice that
     shares that (author, series). The cast view's Series tab reads this so a
     standalone never surfaces an unrelated series' cast. */
  const cur = currentBookId ? bookMeta.get(currentBookId) : undefined;
  const currentSeries =
    cur && !cur.isStandalone ? { author: cur.author, series: cur.series } : null;
  if (currentSeries) {
    for (const voice of acc.values()) {
      const inSeries = Array.from(voice.books).some((bid) => {
        const m = bookMeta.get(bid);
        return (
          !!m &&
          !m.isStandalone &&
          m.author === currentSeries.author &&
          m.series === currentSeries.series
        );
      });
      if (inSeries) voice.inCurrentSeries = true;
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
  const body = (req.body ?? {}) as { override?: unknown; scope?: unknown; bookId?: unknown };
  const parsed = parseOverrideField(body.override);
  if (parsed === 'invalid') {
    return res.status(400).json({
      error: 'Body must include `override: { engine, name }` or `override: null`.',
    });
  }
  /* Scope (plan 108): default 'workspace' keeps the original behaviour
     (write to every confirmed cast.json that shares the voiceId). A
     'series' scope limits the write to the (author, series) of `bookId`
     so a bespoke Qwen voice propagates across that series only. The
     scope/bookId may arrive in the body OR as query params (the client
     uses the body). */
  const scopeRaw =
    typeof body.scope === 'string'
      ? body.scope
      : typeof req.query.scope === 'string'
        ? req.query.scope
        : undefined;
  const bookId =
    typeof body.bookId === 'string'
      ? body.bookId
      : typeof req.query.bookId === 'string'
        ? req.query.bookId
        : undefined;
  if (scopeRaw !== undefined && scopeRaw !== 'series' && scopeRaw !== 'workspace') {
    return res.status(400).json({ error: "`scope` must be 'series' or 'workspace'." });
  }
  const scope: 'series' | 'workspace' = scopeRaw === 'series' ? 'series' : 'workspace';
  if (scope === 'series' && !bookId) {
    return res.status(400).json({ error: "`scope: 'series'` requires `bookId`." });
  }
  try {
    ensureWorkspace();
    let seriesFilter: { author: string; series: string } | undefined;
    if (scope === 'series') {
      const resolved = await findAuthorSeriesForBookId(bookId!);
      if (!resolved) {
        return res
          .status(404)
          .json({ error: `Book "${bookId}" not found — can't resolve its series.` });
      }
      seriesFilter = resolved;
    }
    const updates = await applyOverrideToCastFiles(voiceId, parsed, seriesFilter);
    if (updates === 0) {
      const where = seriesFilter
        ? `in series "${seriesFilter.author} / ${seriesFilter.series}"`
        : 'in any confirmed cast';
      return res
        .status(404)
        .json({ error: `No character with voiceId "${voiceId}" found ${where}.` });
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

/* Walk every confirmed cast.json (series-scoped when `seriesFilter` is given,
   workspace-wide otherwise) and apply `mutate` to each character whose linked
   identity (`voiceId ?? id`) matches `voiceId`, persisting only the books that
   changed. Standalones are excluded from a series scope (a standalone's cast
   isn't series continuity). Shared by the base-voice override propagation and
   the emotion-variant propagation so a designed voice — base OR variant —
   travels identically across every linked character in the series. Returns the
   number of characters touched. */
export async function forEachMatchingCastCharacter(
  voiceId: string,
  seriesFilter: { author: string; series: string } | undefined,
  mutate: (character: CastCharacter) => CastCharacter,
): Promise<number> {
  let updated = 0;
  for (const authorName of listDirs(BOOKS_ROOT)) {
    for (const seriesName of listDirs(join(BOOKS_ROOT, authorName))) {
      for (const titleName of listDirs(join(BOOKS_ROOT, authorName, seriesName))) {
        const bookDir = join(BOOKS_ROOT, authorName, seriesName, titleName);
        const state = await readJson<BookStateJson>(stateJsonPath(bookDir));
        if (!state || !state.castConfirmed) continue;
        if (seriesFilter) {
          if (state.isStandalone === true) continue;
          if (state.author !== seriesFilter.author || state.series !== seriesFilter.series)
            continue;
        }
        const cast = await readJson<CastJson>(castJsonPath(bookDir));
        if (!cast?.characters?.length) continue;
        let dirty = false;
        for (let i = 0; i < cast.characters.length; i++) {
          const original = cast.characters[i];
          const id = original.voiceId ?? original.id;
          if (id !== voiceId) continue;
          cast.characters[i] = mutate(original);
          dirty = true;
          updated += 1;
        }
        if (dirty) {
          await writeJsonAtomic(castJsonPath(bookDir), cast);
        }
      }
    }
  }
  return updated;
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
export async function applyOverrideToCastFiles(
  voiceId: string,
  override: { engine: TtsEngine; name: string } | null,
  /* When provided, only cast.json files whose state.json (author, series)
     matches are touched — the plan-108 series-scoped write. Compared
     against state.json's author/series (not the folder names) so it
     stays consistent with series-cast-scan's resolution. Standalones are
     excluded from a series scope (a standalone's cast isn't series
     continuity). Omit for the original workspace-wide behaviour. */
  seriesFilter?: { author: string; series: string },
): Promise<number> {
  const updated = await forEachMatchingCastCharacter(voiceId, seriesFilter, (original) => {
    const normalised = normaliseCastCharacter(original);
    const replacement: CastCharacter = { ...normalised };
    if (override === null) {
      delete replacement.overrideTtsVoices;
    } else {
      const map = { ...(normalised.overrideTtsVoices ?? {}) };
      /* Preserve any existing slot detail (notably qwen emotion `variants`)
         when (re)assigning the base name — a base re-design, or its series
         propagation, must NOT wipe designed variants. */
      map[override.engine] = { ...(map[override.engine] ?? {}), name: override.name };
      replacement.overrideTtsVoices = map;
      /* Setting a per-engine voice override is a deliberate "use this
         engine for this character" action (the only callers — the cast
         picker + the series rebaseline — only write when switching the
         character TO that engine). Pin `ttsEngine` so the switch
         propagates across the series: otherwise other books get the
         voice slot but keep the wrong active engine (plan 108 — "wrong
         model in this book"). */
      replacement.ttsEngine = override.engine;
    }
    /* Always remove the legacy singular field — normaliseCastCharacter
       already folded it into the map. */
    delete replacement.overrideTtsVoice;
    return replacement;
  });
  /* Override changes don't affect the base-voice catalog itself, but call
     this anyway so a future invocation refreshes /speakers cleanly if the
     sidecar was bounced in between. Cheap and side-effect free. */
  if (updated > 0) invalidateBaseVoiceCache();
  return updated;
}
