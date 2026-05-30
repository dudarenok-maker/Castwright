/* Cast slice — characters + their voice assignments. */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { Character, AnalyseResponse, VoiceMatchResponse } from '../lib/types';

export interface CastState {
  characters: Character[];
  /** fe-16 — characterId → engine the character actually rendered in when it
      differs from its configured engine (`'kokoro'` for a Qwen fallback).
      Hydrated from the book-state GET; drives the "Fallback (Kokoro)" Status
      pill. Optional (absent on pre-fe-16 preloaded test stores) — selectors
      read it through a `?? {}` guard. */
  renderedFallbackByCharacter?: Record<string, string>;
}

/* Empty initial state — the fixture seed (`initialCharacters` from
   ../data/characters) used to live here so the demo had something to show,
   but that meant a real book's Cast view briefly displayed fixture
   characters between click and async hydration. Hydration via
   `hydrateFromAnalysis` / `setCharacters` (from the layout's getBookState
   handler) is the only legitimate source for a real book. */
const initialState: CastState = { characters: [], renderedFallbackByCharacter: {} };

export const castSlice = createSlice({
  name: 'cast',
  initialState,
  reducers: {
    setCharacters: (s, a: PayloadAction<Character[]>) => {
      s.characters = a.payload;
    },
    /* fe-16 — overwrite the per-character render fallback map from the
       book-state GET. Hydrated alongside setCharacters on book open; the empty
       case clears stale entries (e.g. after a fresh render with no fallback). */
    setRenderedFallback: (s, a: PayloadAction<Record<string, string>>) => {
      s.renderedFallbackByCharacter = a.payload ?? {};
    },
    declineMatch: (s, a: PayloadAction<string>) => {
      const c = s.characters.find((x) => x.id === a.payload);
      if (c) {
        c.matchedFrom = undefined;
        c.voiceState = 'generated';
      }
    },
    /* Pin a character's voice so subsequent regenerates preserve it. The
       Profile Drawer's Lock button dispatches this; the change-log slice
       records the matching voice_lock event. */
    lockVoice: (s, a: PayloadAction<string>) => {
      const c = s.characters.find((x) => x.id === a.payload);
      if (c) c.voiceState = 'locked';
    },
    updateCharacter: (s, a: PayloadAction<Character>) => {
      const next = a.payload;
      s.characters = s.characters.map((c) => (c.id === next.id ? { ...c, ...next } : c));
    },
    /* Plan 108 — set a character's Gemini-generated voice-design persona
       ("voice style"). The server persists it to cast.json; this reducer
       mirrors the returned persona into redux so the future drawer (Wave 4)
       renders the new value without re-hydrating the whole cast. No-op when
       the character id isn't in the slice. */
    setVoiceStyle: (s, a: PayloadAction<{ characterId: string; voiceStyle: string }>) => {
      const { characterId, voiceStyle } = a.payload;
      const c = s.characters.find((x) => x.id === characterId);
      if (c) c.voiceStyle = voiceStyle;
    },
    /* From POST /api/manuscripts/:id/analysis response. The analyser schema
       leaves voiceState optional, but freshly-analysed characters have, by
       definition, just had a voice generated for them — default the field
       so the Cast view's Status column renders the green "Generated" pill
       instead of nothing. */
    hydrateFromAnalysis: (s, a: PayloadAction<AnalyseResponse>) => {
      const { characters } = a.payload;
      if (characters?.length) {
        s.characters = characters.map((c) =>
          c.voiceState ? c : { ...c, voiceState: 'generated' },
        );
      }
    },
    /* Live cast-update events from Phase 0a (per-chapter cast detection).
       Each event carries the running roster snapshot — upsert by id so
       user-locked voiceId / matchedFrom on existing entries survive a
       mid-analysis snapshot replacing them. New characters land at the
       end of the array in roster discovery order. */
    mergeCharacters: (s, a: PayloadAction<Character[]>) => {
      const incoming = a.payload;
      if (!incoming?.length) return;
      const byId = new Map(s.characters.map((c) => [c.id, c]));
      const next: Character[] = [];
      const seen = new Set<string>();
      for (const inc of incoming) {
        const existing = byId.get(inc.id);
        if (existing) {
          /* Preserve voiceId / matchedFrom / matchFactors / voiceState
             from the local entry — those came from voice matching or
             user edits and shouldn't get clobbered by an analyser
             snapshot that doesn't know about them. */
          next.push({
            ...inc,
            voiceId: existing.voiceId ?? inc.voiceId,
            matchedFrom: existing.matchedFrom ?? inc.matchedFrom,
            matchFactors: existing.matchFactors ?? inc.matchFactors,
            voiceState: existing.voiceState ?? inc.voiceState ?? 'generated',
          });
        } else {
          next.push(inc.voiceState ? inc : { ...inc, voiceState: 'generated' });
        }
        seen.add(inc.id);
      }
      /* Carry forward any locally-known characters the snapshot omitted.
         Defensive — Phase 0a sends the full roster on every event so this
         set should always be empty in practice, but keeps the slice safe
         against future delta-style updates. */
      for (const c of s.characters) {
        if (!seen.has(c.id)) next.push(c);
      }
      s.characters = next;
    },
    /* From POST /api/books/:bookId/cast/merge — replaces the local cast
       with the server's merged list. The server is authoritative because
       it walks manuscript-edits.json + the analysis cache to recompute
       lines / scenes; doing the merge in the reducer would risk drift
       against the persisted state. */
    applyMerge: (s, a: PayloadAction<{ characters: Character[] }>) => {
      const { characters } = a.payload;
      if (!characters) return;
      /* Preserve voiceId / matchedFrom / matchFactors / voiceState on each
         surviving character — those are local-only or library-derived and
         the server's character list doesn't carry them. */
      const byId = new Map(s.characters.map((c) => [c.id, c]));
      s.characters = characters.map((inc) => {
        const existing = byId.get(inc.id);
        if (!existing) return inc;
        return {
          ...inc,
          voiceId: existing.voiceId ?? inc.voiceId,
          matchedFrom: existing.matchedFrom ?? inc.matchedFrom,
          matchFactors: existing.matchFactors ?? inc.matchFactors,
          voiceState: existing.voiceState ?? inc.voiceState,
        };
      });
    },
    /* From POST /api/books/:bookId/cast/add-from-roster — the user
       picked a prior series-mate's character from the manuscript-view
       reassign picker and the server has appended a new row to this
       book's cast.json. Idempotent on the redux side: if a character
       with the same id already exists (shouldn't happen — server mints
       unique ids — but defensive against double-dispatch under network
       retry) the existing entry is left in place. The caller follows
       with manuscriptActions.setSentenceCharacter / setSentencesCharacter
       using the returned id to reassign the originating sentence. */
    addCharacter: (s, a: PayloadAction<Character>) => {
      const incoming = a.payload;
      if (s.characters.some((c) => c.id === incoming.id)) return;
      s.characters.push(incoming);
    },
    /* From POST /api/books/:bookId/cast/unlink-alias — split an alias
       chip off its current character back into its own standalone cast
       member. Delta-only: strip the alias off the source's aliases list
       (case-insensitive, trim-tolerant), then append the new character
       at the end (matches the analyser fold + cast-merge convention of
       appending freshly-minted entries). No sentence reassignment here
       — the Reattribute Lines modal handles those via the existing
       per-sentence picker dispatching manuscriptActions.setSentenceCharacter. */
    applyUnlinkAlias: (
      s,
      a: PayloadAction<{
        sourceCharacterId: string;
        aliasName: string;
        newCharacter: Character;
      }>,
    ) => {
      const { sourceCharacterId, aliasName, newCharacter } = a.payload;
      const key = aliasName.trim().toLowerCase();
      const source = s.characters.find((c) => c.id === sourceCharacterId);
      if (source) {
        source.aliases = (source.aliases ?? []).filter(
          (n) => n.trim().toLowerCase() !== key,
        );
      }
      /* Append the new standalone character. Idempotent on id (double-
         dispatch under network retry leaves the existing entry in place,
         mirroring addCharacter). Default voiceState to 'generated' so the
         Cast view's Status column renders a pill rather than blank. */
      if (!s.characters.some((c) => c.id === newCharacter.id)) {
        s.characters.push({
          ...newCharacter,
          voiceState: newCharacter.voiceState ?? 'generated',
        });
      }
    },
    /* From POST /api/books/:bookId/cast/add-alias — append a typed name
       to a character's aliases array. Idempotent (case-insensitive
       dedup), rejects self-aliases silently (server returns 400 in that
       case — surfaced as an error toast at the dispatch site). */
    applyAddAlias: (
      s,
      a: PayloadAction<{ characterId: string; aliasName: string }>,
    ) => {
      const { characterId, aliasName } = a.payload;
      const trimmed = aliasName.trim();
      if (!trimmed) return;
      const target = s.characters.find((c) => c.id === characterId);
      if (!target) return;
      const key = trimmed.toLowerCase();
      if (key === target.name.trim().toLowerCase()) return;
      const existing = target.aliases ?? [];
      if (existing.some((n) => n.trim().toLowerCase() === key)) return;
      target.aliases = [...existing, trimmed];
    },
    /* Set a character's primary display name. Serves two drawer affordances:
       free-text rename ("Dame Alina" → "Councilor Alina") and promoting an
       existing alias to be the primary name. Both collapse here because the
       old primary name is ALWAYS demoted into aliases — a rename never loses
       a name (earlier chapters may still use the old title). When the new
       name is itself an existing alias (the promote case), it's stripped from
       the aliases list so it doesn't double up. Dedup is case-insensitive,
       trim-tolerant; display casing is preserved. Persisted to cast.json via
       the 'cast/renameCharacter' rule in persistence-middleware.ts. */
    renameCharacter: (
      s,
      a: PayloadAction<{ characterId: string; name: string }>,
    ) => {
      const { characterId, name } = a.payload;
      const trimmed = name.trim();
      if (!trimmed) return;
      const c = s.characters.find((x) => x.id === characterId);
      if (!c) return;
      const oldName = c.name;
      const newKey = trimmed.toLowerCase();
      if (oldName.trim().toLowerCase() === newKey) return;
      /* Strip the new name off the aliases if present (covers promote). */
      let aliases = (c.aliases ?? []).filter((al) => al.trim().toLowerCase() !== newKey);
      /* Demote the old primary into aliases (the lossless swap), de-duped. */
      const oldKey = oldName.trim().toLowerCase();
      if (oldKey && !aliases.some((al) => al.trim().toLowerCase() === oldKey)) {
        aliases = [...aliases, oldName];
      }
      c.name = trimmed;
      c.aliases = aliases;
    },
    /* From POST /api/books/:bookId/cast/link-prior — the user just
       manually declared "this character is the same person as that one
       from a prior series book." Single-row analogue of applyVoiceMatches
       (no candidates list, no factors): write matchedFrom + voiceId +
       voiceState='reused' so the confirm card's "Continuity preserved"
       footer + "Sync profile" checkbox light up exactly like the
       auto-match path. Tuned voice (voiceState='locked' / 'tuned') is
       preserved — the user already invested effort in it. */
    applyManualMatch: (
      s,
      a: PayloadAction<{
        characterId: string;
        matchedFrom: NonNullable<Character['matchedFrom']>;
        voiceId?: string;
      }>,
    ) => {
      const { characterId, matchedFrom, voiceId } = a.payload;
      const c = s.characters.find((x) => x.id === characterId);
      if (!c) return;
      c.matchedFrom = matchedFrom;
      if (c.voiceState !== 'locked' && c.voiceState !== 'tuned') {
        c.voiceId = voiceId ?? c.voiceId;
        c.voiceState = 'reused';
      }
    },
    /* From POST /api/books/:bookId/cast/:characterId/not-linked-to (plan 101).
       The user has just declared "these two cross-book characters are
       intentionally different people" (e.g. teenage Sophie vs adult
       Sophie). Server has pair-written the entry to both books' cast.json;
       on the source side this reducer mirrors the write into redux so
       the duplicate-candidate detection memo immediately stops surfacing
       the pair. The OTHER book's redux state lives in a different tab /
       a foreign-cast cache — that side's write will be picked up the
       next time its cast hydrates. Idempotent on duplicate dispatch. */
    applyNotLinked: (
      s,
      a: PayloadAction<{
        characterId: string;
        otherBookId: string;
        otherCharacterId: string;
      }>,
    ) => {
      const { characterId, otherBookId, otherCharacterId } = a.payload;
      const c = s.characters.find((x) => x.id === characterId);
      if (!c) return;
      const existing = c.notLinkedTo ?? [];
      if (
        existing.some(
          (p) => p.bookId === otherBookId && p.characterId === otherCharacterId,
        )
      ) {
        return;
      }
      c.notLinkedTo = [...existing, { bookId: otherBookId, characterId: otherCharacterId }];
    },
    /* From DELETE /api/books/:bookId/cast/:characterId/not-linked-to (fs-11).
       Undo a prior "different on purpose" decision — strip the (otherBookId,
       otherCharacterId) entry from this character's notLinkedTo so the
       voices-view duplicate detector re-surfaces the pair. Idempotent: a
       no-op when the entry is already absent. The OTHER book's redux state
       lives elsewhere (its side is reconciled via the foreign-cast cache). */
    removeNotLinked: (
      s,
      a: PayloadAction<{
        characterId: string;
        otherBookId: string;
        otherCharacterId: string;
      }>,
    ) => {
      const { characterId, otherBookId, otherCharacterId } = a.payload;
      const c = s.characters.find((x) => x.id === characterId);
      if (!c?.notLinkedTo) return;
      c.notLinkedTo = c.notLinkedTo.filter(
        (p) => !(p.bookId === otherBookId && p.characterId === otherCharacterId),
      );
    },
    /* From POST /api/books/:bookId/voice-match. Carries bookId + characterId
       through to matchedFrom so the confirm view's override toggle has a
       stable handle on the library record (POST /api/library-cast/override). */
    applyVoiceMatches: (s, a: PayloadAction<VoiceMatchResponse>) => {
      const { matches } = a.payload;
      const byId = Object.fromEntries((matches || []).map((m) => [m.characterId, m]));
      s.characters = s.characters.map((c) => {
        const m = byId[c.id];
        if (!m || !m.candidates?.length) return c;
        const top = m.candidates[0];
        return {
          ...c,
          voiceId: top.voiceId,
          matchedFrom: {
            bookId: top.fromBookId,
            characterId: top.fromCharacterId,
            bookTitle: top.fromBookTitle,
            confidence: top.score,
          },
          matchFactors: top.factors,
          voiceState: 'reused',
        };
      });
    },
  },
});

export const castActions = castSlice.actions;
