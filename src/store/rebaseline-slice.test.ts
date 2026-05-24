/* Rebaseline slice (plan 108, Wave 5) — setup → propose → approve
   reducers, principal-cast default selection wiring, and per-row failure
   handling. */

import { describe, expect, it } from 'vitest';
import {
  rebaselineSlice,
  rebaselineActions,
  includedProposals,
  type RebaselineState,
} from './rebaseline-slice';
import { selectPrincipalCast } from '../lib/principal-cast';

const reducer = rebaselineSlice.reducer;

function freshOpen(): RebaselineState {
  return reducer(
    undefined,
    rebaselineActions.begin({ bookId: 'book-1', selectedCharacterIds: ['Maerin', 'Marlow'] }),
  );
}

describe('rebaselineSlice — begin / setup', () => {
  it('seeds the selection and resets prior run state', () => {
    const s = freshOpen();
    expect(s.status).toBe('setup');
    expect(s.bookId).toBe('book-1');
    expect(s.selectedCharacterIds).toEqual(['Maerin', 'Marlow']);
    expect(s.proposals).toEqual({});
    expect(s.appliedCount).toBe(0);
  });

  it('begin clears proposals from a previous run', () => {
    let s = freshOpen();
    s = reducer(s, rebaselineActions.startProposing({}));
    s = reducer(
      s,
      rebaselineActions.proposalReady({
        characterId: 'Maerin',
        persona: 'p',
        proposedVoiceId: 'qwen-Maerin',
      }),
    );
    expect(Object.keys(s.proposals)).toHaveLength(2);
    s = reducer(s, rebaselineActions.begin({ bookId: 'book-2', selectedCharacterIds: ['Wren'] }));
    expect(s.proposals).toEqual({});
    expect(s.selectedCharacterIds).toEqual(['Wren']);
  });

  it('toggleSelected adds and removes', () => {
    let s = freshOpen();
    s = reducer(s, rebaselineActions.toggleSelected('Wren'));
    expect(s.selectedCharacterIds).toContain('Wren');
    s = reducer(s, rebaselineActions.toggleSelected('Maerin'));
    expect(s.selectedCharacterIds).not.toContain('Maerin');
  });
});

describe('rebaselineSlice — principal-cast default selection', () => {
  it('begin uses selectPrincipalCast output as the default', () => {
    const characters = [
      { id: 'narrator', name: 'Narrator' },
      { id: 'Maerin', name: 'Maerin' },
      { id: 'Marlow', name: 'Marlow' },
      { id: 'bystander', name: 'Bystander' },
    ];
    const lines = { narrator: 500, Maerin: 80, Marlow: 60, bystander: 2 };
    const principal = selectPrincipalCast(characters, lines);
    const s = reducer(
      undefined,
      rebaselineActions.begin({ bookId: 'b', selectedCharacterIds: Array.from(principal) }),
    );
    // Narrator excluded; principals carry ≥80% of non-narrator lines.
    expect(s.selectedCharacterIds).toContain('Maerin');
    expect(s.selectedCharacterIds).toContain('Marlow');
    expect(s.selectedCharacterIds).not.toContain('narrator');
  });
});

describe('rebaselineSlice — propose', () => {
  it('startProposing seeds a pending proposal per selected character', () => {
    let s = freshOpen();
    s = reducer(s, rebaselineActions.startProposing({ personaSeeds: { Maerin: 'bright teen' } }));
    expect(s.status).toBe('proposing');
    expect(s.proposals.Maerin).toMatchObject({
      status: 'pending',
      persona: 'bright teen',
      include: true,
    });
    expect(s.proposals.Marlow).toMatchObject({ status: 'pending', persona: '', include: true });
  });

  it('proposalReady fills persona + voiceId + preview', () => {
    let s = freshOpen();
    s = reducer(s, rebaselineActions.startProposing({}));
    s = reducer(
      s,
      rebaselineActions.proposalReady({
        characterId: 'Maerin',
        persona: 'a bright, confident teenage girl',
        proposedVoiceId: 'qwen-Maerin',
        previewUrl: 'blob:abc',
      }),
    );
    expect(s.proposals.Maerin).toMatchObject({
      status: 'ready',
      persona: 'a bright, confident teenage girl',
      proposedVoiceId: 'qwen-Maerin',
      previewUrl: 'blob:abc',
      include: true,
    });
  });

  it('proposalFailed marks the row failed + unticks it; the loop continues', () => {
    let s = freshOpen();
    s = reducer(s, rebaselineActions.startProposing({}));
    s = reducer(
      s,
      rebaselineActions.proposalFailed({ characterId: 'Maerin', error: 'sidecar down' }),
    );
    s = reducer(
      s,
      rebaselineActions.proposalReady({
        characterId: 'Marlow',
        persona: 'p',
        proposedVoiceId: 'qwen-Marlow',
      }),
    );
    expect(s.proposals.Maerin).toMatchObject({
      status: 'failed',
      error: 'sidecar down',
      include: false,
    });
    expect(s.proposals.Marlow.status).toBe('ready');
  });

  it('setProposalPersona edits the textarea value', () => {
    let s = freshOpen();
    s = reducer(s, rebaselineActions.startProposing({}));
    s = reducer(
      s,
      rebaselineActions.setProposalPersona({ characterId: 'Maerin', persona: 'edited' }),
    );
    expect(s.proposals.Maerin.persona).toBe('edited');
  });

  it('toggleProposalInclude flips include for non-failed rows only', () => {
    let s = freshOpen();
    s = reducer(s, rebaselineActions.startProposing({}));
    s = reducer(
      s,
      rebaselineActions.proposalReady({ characterId: 'Maerin', persona: 'p', proposedVoiceId: 'v' }),
    );
    s = reducer(s, rebaselineActions.proposalFailed({ characterId: 'Marlow', error: 'x' }));
    s = reducer(s, rebaselineActions.toggleProposalInclude({ characterId: 'Maerin' }));
    expect(s.proposals.Maerin.include).toBe(false);
    // failed row stays excluded — toggle is a no-op
    s = reducer(s, rebaselineActions.toggleProposalInclude({ characterId: 'Marlow' }));
    expect(s.proposals.Marlow.include).toBe(false);
  });
});

describe('rebaselineSlice — approve', () => {
  function readied(): RebaselineState {
    let s = freshOpen();
    s = reducer(s, rebaselineActions.startProposing({}));
    s = reducer(
      s,
      rebaselineActions.proposalReady({
        characterId: 'Maerin',
        persona: 'p1',
        proposedVoiceId: 'qwen-Maerin',
      }),
    );
    s = reducer(
      s,
      rebaselineActions.proposalReady({
        characterId: 'Marlow',
        persona: 'p2',
        proposedVoiceId: 'qwen-Marlow',
      }),
    );
    s = reducer(s, rebaselineActions.proposingSettled());
    return s;
  }

  it('proposingSettled → proposed', () => {
    expect(readied().status).toBe('proposed');
  });

  it('startApproving → approving; proposalApplied marks rows; approveDone records the count', () => {
    let s = readied();
    s = reducer(s, rebaselineActions.startApproving());
    expect(s.status).toBe('approving');
    s = reducer(s, rebaselineActions.proposalApplied({ characterId: 'Maerin' }));
    expect(s.proposals.Maerin.status).toBe('applied');
    s = reducer(s, rebaselineActions.approveDone({ appliedCount: 2 }));
    expect(s.status).toBe('done');
    expect(s.appliedCount).toBe(2);
  });

  it('reset returns to initial state', () => {
    let s = readied();
    s = reducer(s, rebaselineActions.reset());
    expect(s.status).toBe('setup');
    expect(s.bookId).toBeNull();
    expect(s.proposals).toEqual({});
  });
});

describe('includedProposals helper', () => {
  it('returns only ticked, ready, voiceId-bearing proposals', () => {
    let s = freshOpen();
    s = reducer(s, rebaselineActions.startProposing({}));
    s = reducer(
      s,
      rebaselineActions.proposalReady({
        characterId: 'Maerin',
        persona: 'p',
        proposedVoiceId: 'qwen-Maerin',
      }),
    );
    // Marlow stays pending (no voiceId) → excluded
    const included = includedProposals(s);
    expect(included.map((p) => p.characterId)).toEqual(['Maerin']);
    // untick Maerin → empty
    s = reducer(s, rebaselineActions.toggleProposalInclude({ characterId: 'Maerin' }));
    expect(includedProposals(s)).toHaveLength(0);
  });
});
