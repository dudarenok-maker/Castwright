/* Cast slice — characters + their voice assignments. */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { Character, AnalyseResponse, VoiceMatchResponse } from '../lib/types';

export interface CastState {
  characters: Character[];
}

/* Empty initial state — the fixture seed (`initialCharacters` from
   ../data/characters) used to live here so the demo had something to show,
   but that meant a real book's Cast view briefly displayed fixture
   characters between click and async hydration. Hydration via
   `hydrateFromAnalysis` / `setCharacters` (from the layout's getBookState
   handler) is the only legitimate source for a real book. */
const initialState: CastState = { characters: [] };

export const castSlice = createSlice({
  name: 'cast',
  initialState,
  reducers: {
    setCharacters: (s, a: PayloadAction<Character[]>) => {
      s.characters = a.payload;
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
