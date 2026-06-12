/* Analysis-time cross-book reuse linking (plan 126 Facet A).

   When a later book in a series is analysed, its recurring characters should
   automatically inherit the continuity links (`matchedFrom` + a unified
   `voiceId` + `voiceState:'reused'`) that previously only the client-side,
   confirm-stage-only voice matcher produced. This module is the server-side,
   authoritative pass: given the freshly-detected roster and the source book's
   id, it returns each character enriched with reuse links against prior
   same-series confirmed cast.

   It deliberately reuses the existing primitives instead of reinventing them:
     - `scanSeriesCharactersForBookId` — prior confirmed series-mate cast
       (same scan the Phase-0a prompt already consumes).
     - `scoreOne` from voice-match.ts — the SAME name-floor (< 0.34) +
       gender/age/attribute scorer the client matcher uses, so the server
       agrees with what the client would have picked.
     - `resolveReusedVoiceFields` (via a workspace cast loader) — denormalises
       the matched prior character's bespoke (qwen) voice onto the reused row,
       identical to cast-link-prior + the srv-14 persist pass.

   Guards mirror scripts/repair-series-reuse.mjs:
     - skip `unknown-male` / `unknown-female` (per-book buckets, never reused);
     - never link a `notLinkedTo` pair (intentional same-name-different-person);
     - only link against EARLIER books (lower seriesPosition) and skip the run
       entirely for the earliest book in the series (nothing prior);
     - never overwrite an existing `matchedFrom`, nor flip a tuned/locked voice
       state.

   Additive: the client `applyVoiceMatches` path stays as a fallback. */

import { findAuthorSeriesForBookId } from './series-cast-scan.js';
import { scanLibraryCharacters, type LibraryCharacterRecord } from './library-cast-scan.js';
import { BOOKS_ROOT, stateJsonPath } from './paths.js';
import { join } from 'node:path';
import { readJson } from './state-io.js';
import type { BookStateJson } from './scan.js';
import { scoreOne, type CharacterMatchInput, type LibraryVoice } from '../routes/voice-match.js';
import { resolveReusedVoiceFields, type CastLoader } from '../tts/hydrate-reused-voice.js';
import { createWorkspaceCastLoader } from '../tts/hydrate-reused-voice-workspace.js';
import type { TtsEngine } from '../tts/index.js';

const SKIP_IDS = new Set(['unknown-male', 'unknown-female']);

/** The reuse-relevant slice of a freshly-detected character. Kept structural
    (a superset of CharacterOutput's reuse fields) so the analyzer's
    CharacterOutput rows pass through without a cast. */
export interface LinkableCharacter {
  id: string;
  name: string;
  aliases?: string[];
  gender?: 'male' | 'female' | 'neutral';
  ageRange?: 'child' | 'teen' | 'adult' | 'elderly';
  attributes?: string[];
  voiceId?: string;
  voiceState?: 'generated' | 'tuned' | 'reused' | 'locked';
  ttsEngine?: TtsEngine | null;
  overrideTtsVoices?: Partial<Record<TtsEngine, { name: string }>> | null;
  voiceStyle?: string;
  matchedFrom?: {
    bookId?: string;
    characterId?: string;
    bookTitle?: string;
    confidence?: number;
  } | null;
  matchFactors?: unknown[];
  notLinkedTo?: { bookId: string; characterId: string }[];
}

/* Walk the books tree once, returning bookId → seriesPosition for every book
   in the workspace. Mirrors the cheap tree-walk in series-cast-scan; a single
   pass keeps this O(books) instead of O(books) findBookByBookId scans. */
async function seriesPositionByBookId(): Promise<Map<string, number | null>> {
  const { existsSync, readdirSync } = await import('node:fs');
  const out = new Map<string, number | null>();
  if (!existsSync(BOOKS_ROOT)) return out;
  const dirs = (path: string): string[] =>
    readdirSync(path, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  for (const authorName of dirs(BOOKS_ROOT)) {
    for (const seriesName of dirs(join(BOOKS_ROOT, authorName))) {
      for (const titleName of dirs(join(BOOKS_ROOT, authorName, seriesName))) {
        const state = await readJson<BookStateJson>(
          stateJsonPath(join(BOOKS_ROOT, authorName, seriesName, titleName)),
        );
        if (state?.bookId) out.set(state.bookId, state.seriesPosition ?? null);
      }
    }
  }
  return out;
}

/* Project a prior-book confirmed character into the scorer's LibraryVoice
   shape — the same projection voice-match.ts applies, keyed by `voiceId ?? id`
   so the unified id matches the TTS pipeline's hash key. */
function projectVoice(record: LibraryCharacterRecord): LibraryVoice | null {
  const c = record.character;
  const voiceId = c.voiceId ?? c.id;
  if (!voiceId) return null;
  return {
    voiceId,
    bookId: record.bookId,
    bookTitle: record.bookTitle,
    characterId: c.id,
    name: c.name ?? c.id,
    aliases: Array.isArray(c.aliases) ? c.aliases.filter((a) => typeof a === 'string') : [],
    gender: c.gender,
    ageRange: c.ageRange,
    attributes: Array.isArray(c.attributes)
      ? c.attributes.filter((a) => typeof a === 'string')
      : [],
  };
}

/* Union the matched prior character's name + aliases into the reused
   character's aliases (case-insensitive dedup, drop the char's own name).
   Mirrors cast-link-prior.ts::appendAliases so future matches recognise both
   surface forms. */
function unionAliases(
  ownName: string,
  ownAliases: string[] | undefined,
  priorName: string,
  priorAliases: string[],
): string[] | undefined {
  const seen = new Set<string>();
  const out: string[] = [];
  const selfKey = ownName.trim().toLowerCase();
  const push = (name: string | undefined) => {
    if (!name) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (key === selfKey || seen.has(key)) return;
    seen.add(key);
    out.push(trimmed);
  };
  for (const a of ownAliases ?? []) push(a);
  push(priorName);
  for (const a of priorAliases) push(a);
  return out.length ? out : undefined;
}

export interface LinkSeriesReuseOptions {
  /** Injected for testability — defaults to the real workspace scanners. */
  scanLibrary?: () => Promise<LibraryCharacterRecord[]>;
  resolveAuthorSeries?: (
    bookId: string,
  ) => Promise<{ author: string; series: string } | null>;
  positions?: () => Promise<Map<string, number | null>>;
  castLoader?: CastLoader;
}

/* Revert a stale-linked character. A pure reuse row's voice was denormalised
   FROM the now-stale link, so it reverts to a fresh, unlinked voice; a user-
   owned voice (tuned/locked) keeps its voice and only loses the dead badge. */
function clearStaleLink(c: LinkableCharacter): void {
  delete c.matchedFrom;
  delete c.matchFactors;
  if (c.voiceState === 'reused') {
    c.voiceId = c.id;
    c.voiceState = 'generated';
    delete c.overrideTtsVoices;
    delete c.voiceStyle;
    delete c.ttsEngine;
  }
}

/* Drop a `matchedFrom` whose target is no longer a valid reuse source — i.e.
   not a same-author + same-series, strictly-EARLIER book (exactly what
   linkSeriesReuseAtAnalysis links against). This heals links that go stale when
   a book is re-homed to another series or made standalone after the link was
   stamped: seedReuseGuardsFromPriorCast preserves the old link across re-
   analysis, and the UI unmatch refuses non-series-mates, so without this the
   dead link is unclearable. Conservative: a same-series link with an unknown
   position on either side is LEFT intact (a flaky scan must not nuke a
   legitimate link), and the whole pass no-ops when the current book can't be
   resolved. Mutates in place; returns the count dropped. Run BEFORE the link
   pass so a series book can then re-link to its correct earlier sibling. */
export async function pruneStaleReuseLinks(
  bookId: string,
  characters: LinkableCharacter[],
  options: LinkSeriesReuseOptions = {},
): Promise<number> {
  if (!bookId || characters.length === 0) return 0;
  const linked = characters.filter((c) => c.matchedFrom?.bookId);
  if (linked.length === 0) return 0;

  const resolveAuthorSeries = options.resolveAuthorSeries ?? findAuthorSeriesForBookId;
  const meta = await resolveAuthorSeries(bookId);
  if (!meta) return 0; // can't resolve the current book — don't guess

  const positions = await (options.positions ?? seriesPositionByBookId)();
  const myPos = positions.get(bookId) ?? null;

  let dropped = 0;
  for (const c of linked) {
    const targetBookId = c.matchedFrom!.bookId!;
    const targetMeta = await resolveAuthorSeries(targetBookId);
    const sameSeries =
      !!targetMeta && targetMeta.author === meta.author && targetMeta.series === meta.series;
    /* Earlier-only guard mirrors the linker: a same-series link is valid only
       when the target is a strictly-lower position. Unknown positions can't
       prove "earlier", so they're treated as acceptable (conservative keep). */
    const targetPos = positions.get(targetBookId) ?? null;
    const earlierOk = myPos === null || targetPos === null || targetPos < myPos;
    if (sameSeries && earlierOk) continue;

    clearStaleLink(c);
    dropped++;
  }
  return dropped;
}

/* Mutate `characters` in place, stamping reuse links against prior same-series
   confirmed cast. Returns the count of newly-linked characters (0 when the book
   is standalone / earliest / has no prior matches). Safe to call on every
   analysis — it's idempotent and only ever ADDS links. */
export async function linkSeriesReuseAtAnalysis(
  bookId: string,
  characters: LinkableCharacter[],
  options: LinkSeriesReuseOptions = {},
): Promise<number> {
  if (!bookId || characters.length === 0) return 0;

  const resolveAuthorSeries = options.resolveAuthorSeries ?? findAuthorSeriesForBookId;
  const meta = await resolveAuthorSeries(bookId);
  if (!meta) return 0; // not in library / standalone resolves elsewhere

  const positions = await (options.positions ?? seriesPositionByBookId)();
  const myPosition = positions.get(bookId) ?? null;

  /* Pull every confirmed series-mate character (the scan already excludes the
     current book and standalones), then keep only those from EARLIER books. A
     null seriesPosition can't be ordered, so it's treated as not-earlier and
     excluded — the same conservative stance the repair script's sort takes
     (unpositioned books sink to the end). When no earlier book remains we're
     the origin: nothing to link against. */
  const scanLibrary = options.scanLibrary ?? scanLibraryCharacters;
  const all = await scanLibrary();
  /* Carry each prior's seriesPosition so a stable-key match can prefer the
     most-recent earlier book (the freshest design of that same voice). */
  const priorVoices: Array<{ voice: LibraryVoice; pos: number }> = [];
  for (const record of all) {
    if (record.bookId === bookId) continue;
    const recMeta = await resolveAuthorSeries(record.bookId);
    if (!recMeta || recMeta.author !== meta.author || recMeta.series !== meta.series) continue;
    const pos = positions.get(record.bookId) ?? null;
    /* Earlier-book guard: link only against a strictly-lower seriesPosition.
       Unknown positions (null) on either side can't establish "earlier", so
       they're skipped to avoid linking forward / sideways. */
    if (myPosition === null || pos === null || pos >= myPosition) continue;
    if (SKIP_IDS.has(record.character.id)) continue;
    const v = projectVoice(record);
    if (v) priorVoices.push({ voice: v, pos });
  }
  if (priorVoices.length === 0) return 0;

  const castLoader = options.castLoader ?? createWorkspaceCastLoader();
  let linked = 0;

  for (const c of characters) {
    if (SKIP_IDS.has(c.id)) continue;
    if (c.matchedFrom) continue; // never overwrite an existing link

    const input: CharacterMatchInput = {
      id: c.id,
      name: c.name,
      aliases: c.aliases,
      gender: c.gender,
      ageRange: c.ageRange,
      attributes: c.attributes,
    };

    const notLinkedToPrior = (v: LibraryVoice): boolean =>
      /* notLinkedTo guard — the user explicitly declared this pair is NOT the
         same person (e.g. teenage vs adult Wren); never auto-link it. */
      (c.notLinkedTo ?? []).some(
        (p) => p.bookId === v.bookId && p.characterId === v.characterId,
      );

    /* Stable-key pass FIRST: a character that kept its deterministic write key
       (`voiceId ?? id`) across books IS the same voice, even when the analyzer
       renamed it to something with no name-token overlap — the Unraveled
       narrator ("Narrator" → "Author"). The name scorer's 0.34 floor can't see
       this, so match on the key directly and prefer the most-recent earlier
       book. Confidence is 1: an identical write key is definitive, not fuzzy. */
    const myKey = c.voiceId ?? c.id;
    let best: { voice: LibraryVoice; score: number } | null = null;
    let stableBest: { voice: LibraryVoice; pos: number } | null = null;
    for (const { voice: v, pos } of priorVoices) {
      if (v.voiceId !== myKey || notLinkedToPrior(v)) continue;
      if (!stableBest || pos > stableBest.pos) stableBest = { voice: v, pos };
    }
    if (stableBest) {
      best = { voice: stableBest.voice, score: 1 };
    } else {
      for (const { voice: v } of priorVoices) {
        if (notLinkedToPrior(v)) continue;
        const cand = scoreOne(input, v);
        if (!cand) continue;
        if (!best || cand.score > best.score) best = { voice: v, score: cand.score };
      }
    }
    if (!best) continue;

    /* Stamp the link. Keep the actual score on confidence so a low-confidence
       auto-link stays visible/overridable in the UI. */
    c.voiceId = best.voice.voiceId;
    c.matchedFrom = {
      bookId: best.voice.bookId,
      characterId: best.voice.characterId,
      bookTitle: best.voice.bookTitle,
      confidence: best.score,
    };
    /* Don't demote a user-tuned/locked voice to 'reused'. */
    if (c.voiceState !== 'locked' && c.voiceState !== 'tuned') c.voiceState = 'reused';

    const nextAliases = unionAliases(c.name, c.aliases, best.voice.name, best.voice.aliases);
    if (nextAliases) c.aliases = nextAliases;

    /* Denormalise the matched prior character's bespoke (qwen) voice + persona
       onto the reused row so cast.json is self-complete — same resolver srv-14
       uses; the persona (`voiceStyle`) rides along it (srv-18). */
    if (!c.overrideTtsVoices?.qwen?.name) {
      const resolved = await resolveReusedVoiceFields(
        {
          id: c.id,
          matchedFrom: c.matchedFrom,
          overrideTtsVoices: c.overrideTtsVoices,
          voiceStyle: c.voiceStyle,
        },
        castLoader,
      );
      if (resolved) {
        c.ttsEngine = c.ttsEngine ?? resolved.ttsEngine ?? null;
        c.overrideTtsVoices = { ...resolved.overrideTtsVoices, ...(c.overrideTtsVoices ?? {}) };
        c.voiceStyle = c.voiceStyle ?? resolved.voiceStyle;
      }
    }

    linked += 1;
  }

  return linked;
}
