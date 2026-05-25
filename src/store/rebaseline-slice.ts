/* Rebaseline-the-series slice (plan 108, Wave 5).

   Drives the "Rebaseline the series" modal — a three-step flow that moves
   the principal cast onto bespoke Qwen voices:

   1. setup    — the user toggles which characters to rebaseline (the
                 principal cast is pre-selected via `selectPrincipalCast`).
   2. propose  — for each selected character, generate a persona
                 (`api.generateVoiceStyle`) + design its Qwen voice
                 (`api.designQwenVoice`); per-character failures are
                 tolerated (the row is marked `failed`, the rest continue).
   3. approve  — for each INCLUDED proposal, write the series-scoped Qwen
                 override (`api.setVoiceOverride … { scope:'series' }`) +
                 persist `ttsEngine:'qwen'` + `voiceStyle`. The drift
                 detector flags the affected chapters on the next poll —
                 this slice never fabricates drift.

   The slice holds only modal-local working state; the authoritative cast
   lives in `cast-slice`, and the modal mirrors persona/engine writes back
   there via the existing reducers (`setVoiceStyle`, `updateCharacter`).
   Modal open/close is owned by `ui-slice` (`rebaselineModalOpen`). */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

/* Per-character proposal lifecycle:
   - pending:    queued, not yet designed
   - designing:  the persona/design calls are in flight
   - ready:      a persona + designed voiceId are in hand
   - unchanged:  the character is already on its bespoke Qwen voice in THIS book
                 (engine + designed voice) — nothing to design OR write
   - failed:     the persona or design call threw; carries the error
   - applied:    the series-scoped override write landed on approve */
export type ProposalStatus = 'pending' | 'designing' | 'ready' | 'unchanged' | 'failed' | 'applied';

export interface Proposal {
  characterId: string;
  /** The editable voice-design persona. Seeds from the character's
      existing voiceStyle when present, else filled by the propose step. */
  persona: string;
  /** Designed Qwen voiceId — set once the design call returns. */
  proposedVoiceId: string | null;
  /** Object URL for the audition preview blob. The component revokes it on
      re-design / unmount. */
  previewUrl?: string;
  status: ProposalStatus;
  /** Per-row failure message when status === 'failed'. */
  error?: string;
  /** Whether this row is included in the approve write. Defaults true on a
      ready row; the user can untick it. */
  include: boolean;
}

/* Overall modal phase. `setup` is the character-toggle step, `proposing`
   while the batch design loop runs, `proposed` once it settles (some rows
   may have failed), `approving` while the series writes run, `done` after
   approve completes. */
export type RebaselineStatus = 'setup' | 'proposing' | 'proposed' | 'approving' | 'done';

export interface RebaselineState {
  status: RebaselineStatus;
  /** The book the rebaseline is anchored to (drives the series-scoped
      override write). Null until the modal opens against a book. */
  bookId: string | null;
  selectedCharacterIds: string[];
  /** Proposals keyed by characterId, populated by the propose step. */
  proposals: Record<string, Proposal>;
  /** Number of characters whose override actually landed on approve —
      drives the success toast count. */
  appliedCount: number;
}

const initialState: RebaselineState = {
  status: 'setup',
  bookId: null,
  selectedCharacterIds: [],
  proposals: {},
  appliedCount: 0,
};

export const rebaselineSlice = createSlice({
  name: 'rebaseline',
  initialState,
  reducers: {
    /* Open against a book with a default selection (the principal cast,
       computed by the caller via selectPrincipalCast). Resets any prior
       run's proposals. */
    begin: (s, a: PayloadAction<{ bookId: string; selectedCharacterIds: string[] }>) => {
      s.status = 'setup';
      s.bookId = a.payload.bookId;
      s.selectedCharacterIds = [...a.payload.selectedCharacterIds];
      s.proposals = {};
      s.appliedCount = 0;
    },
    /* Toggle a character in/out of the setup selection. */
    toggleSelected: (s, a: PayloadAction<string>) => {
      const id = a.payload;
      if (s.selectedCharacterIds.includes(id)) {
        s.selectedCharacterIds = s.selectedCharacterIds.filter((x) => x !== id);
      } else {
        s.selectedCharacterIds.push(id);
      }
    },
    /* Enter the propose phase — seed a pending proposal per selected
       character (so the rows render immediately) and flip to 'proposing'. */
    startProposing: (s, a: PayloadAction<{ personaSeeds?: Record<string, string> }>) => {
      s.status = 'proposing';
      const seeds = a.payload.personaSeeds ?? {};
      s.proposals = {};
      for (const id of s.selectedCharacterIds) {
        s.proposals[id] = {
          characterId: id,
          persona: seeds[id] ?? '',
          proposedVoiceId: null,
          status: 'pending',
          include: true,
        };
      }
    },
    /* Re-queue a proposal (Re-design / Regenerate) — back to pending so it
       shows "Queued…" until the serial design worker reaches it. Keeps the
       existing persona + preview until the new design lands. */
    proposalQueued: (s, a: PayloadAction<{ characterId: string }>) => {
      const p = s.proposals[a.payload.characterId];
      if (p) {
        p.status = 'pending';
        p.error = undefined;
      }
    },
    /* Mark a single proposal as in-flight. */
    proposalDesigning: (s, a: PayloadAction<{ characterId: string }>) => {
      const p = s.proposals[a.payload.characterId];
      if (p) {
        p.status = 'designing';
        p.error = undefined;
      }
    },
    /* A proposal's persona + designed voice are in hand. */
    proposalReady: (
      s,
      a: PayloadAction<{
        characterId: string;
        persona: string;
        proposedVoiceId: string;
        previewUrl?: string;
      }>,
    ) => {
      const p = s.proposals[a.payload.characterId];
      if (!p) return;
      p.persona = a.payload.persona;
      p.proposedVoiceId = a.payload.proposedVoiceId;
      p.previewUrl = a.payload.previewUrl;
      p.status = 'ready';
      p.error = undefined;
    },
    /* The character already has its bespoke Qwen voice in this book — nothing
       to design or write. Carries the existing voiceId so the row can show it.
       Excluded from the approve write (status !== 'ready'). */
    proposalUnchanged: (s, a: PayloadAction<{ characterId: string; proposedVoiceId: string }>) => {
      const p = s.proposals[a.payload.characterId];
      if (!p) return;
      p.proposedVoiceId = a.payload.proposedVoiceId;
      p.status = 'unchanged';
      p.error = undefined;
    },
    /* A proposal's design failed — keep the row, mark it failed, untick it
       so it can't be approved. */
    proposalFailed: (s, a: PayloadAction<{ characterId: string; error: string }>) => {
      const p = s.proposals[a.payload.characterId];
      if (!p) return;
      p.status = 'failed';
      p.error = a.payload.error;
      p.include = false;
    },
    /* Edit a proposal's persona (the textarea). Clears any prior failure so
       a regenerate can be retried. */
    setProposalPersona: (s, a: PayloadAction<{ characterId: string; persona: string }>) => {
      const p = s.proposals[a.payload.characterId];
      if (p) p.persona = a.payload.persona;
    },
    /* Toggle whether a ready proposal is included in the approve write. */
    toggleProposalInclude: (s, a: PayloadAction<{ characterId: string }>) => {
      const p = s.proposals[a.payload.characterId];
      if (p && p.status !== 'failed') p.include = !p.include;
    },
    /* The propose loop settled (every selected character resolved or
       failed). */
    proposingSettled: (s) => {
      s.status = 'proposed';
    },
    /* Enter the approve phase. */
    startApproving: (s) => {
      s.status = 'approving';
    },
    /* Mark one proposal applied (series override written + cast persisted). */
    proposalApplied: (s, a: PayloadAction<{ characterId: string }>) => {
      const p = s.proposals[a.payload.characterId];
      if (p) p.status = 'applied';
    },
    /* Approve completed — record how many landed for the toast. */
    approveDone: (s, a: PayloadAction<{ appliedCount: number }>) => {
      s.status = 'done';
      s.appliedCount = a.payload.appliedCount;
    },
    /* Tear down on modal close. */
    reset: () => initialState,
  },
});

export const rebaselineActions = rebaselineSlice.actions;

/* The proposals the user kept ticked and that actually designed a voice —
   the set the approve step writes. */
export function includedProposals(state: RebaselineState): Proposal[] {
  return Object.values(state.proposals).filter(
    (p) => p.include && p.status === 'ready' && p.proposedVoiceId,
  );
}
