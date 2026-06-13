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
    rebaselineActions.begin({ bookId: 'book-1', selectedCharacterIds: ['maerin', 'marlow'] }),
  );
}

describe('rebaselineSlice — begin / setup', () => {
  it('seeds the selection and resets prior run state', () => {
    const s = freshOpen();
    expect(s.status).toBe('setup');
    expect(s.bookId).toBe('book-1');
    expect(s.selectedCharacterIds).toEqual(['maerin', 'marlow']);
    expect(s.proposals).toEqual({});
    expect(s.appliedCount).toBe(0);
  });

  it('begin clears proposals from a previous run', () => {
    let s = freshOpen();
    s = reducer(s, rebaselineActions.startProposing({}));
    s = reducer(
      s,
      rebaselineActions.proposalReady({
        characterId: 'maerin',
        persona: 'p',
        proposedVoiceId: 'qwen-maerin',
      }),
    );
    expect(Object.keys(s.proposals)).toHaveLength(2);
    s = reducer(s, rebaselineActions.begin({ bookId: 'book-2', selectedCharacterIds: ['wren'] }));
    expect(s.proposals).toEqual({});
    expect(s.selectedCharacterIds).toEqual(['wren']);
  });

  it('toggleSelected adds and removes', () => {
    let s = freshOpen();
    s = reducer(s, rebaselineActions.toggleSelected('wren'));
    expect(s.selectedCharacterIds).toContain('wren');
    s = reducer(s, rebaselineActions.toggleSelected('maerin'));
    expect(s.selectedCharacterIds).not.toContain('maerin');
  });
});

describe('rebaselineSlice — principal-cast default selection', () => {
  it('begin uses selectPrincipalCast output as the default', () => {
    const characters = [
      { id: 'narrator', name: 'Narrator' },
      { id: 'maerin', name: 'Maerin' },
      { id: 'marlow', name: 'Marlow' },
      { id: 'bystander', name: 'Bystander' },
    ];
    const lines = { narrator: 500, maerin: 80, marlow: 60, bystander: 2 };
    const principal = selectPrincipalCast(characters, lines);
    const s = reducer(
      undefined,
      rebaselineActions.begin({ bookId: 'b', selectedCharacterIds: Array.from(principal) }),
    );
    // Narrator excluded; principals carry ≥80% of non-narrator lines.
    expect(s.selectedCharacterIds).toContain('maerin');
    expect(s.selectedCharacterIds).toContain('marlow');
    expect(s.selectedCharacterIds).not.toContain('narrator');
  });
});

describe('rebaselineSlice — propose', () => {
  it('startProposing seeds a pending proposal per selected character', () => {
    let s = freshOpen();
    s = reducer(s, rebaselineActions.startProposing({ personaSeeds: { maerin: 'bright teen' } }));
    expect(s.status).toBe('proposing');
    expect(s.proposals.maerin).toMatchObject({
      status: 'pending',
      persona: 'bright teen',
      include: true,
    });
    expect(s.proposals.marlow).toMatchObject({ status: 'pending', persona: '', include: true });
  });

  it('proposalReady fills persona + voiceId + preview', () => {
    let s = freshOpen();
    s = reducer(s, rebaselineActions.startProposing({}));
    s = reducer(
      s,
      rebaselineActions.proposalReady({
        characterId: 'maerin',
        persona: 'a bright, confident teenage girl',
        proposedVoiceId: 'qwen-maerin',
        previewUrl: 'blob:abc',
      }),
    );
    expect(s.proposals.maerin).toMatchObject({
      status: 'ready',
      persona: 'a bright, confident teenage girl',
      proposedVoiceId: 'qwen-maerin',
      previewUrl: 'blob:abc',
      include: true,
    });
  });

  it('proposalFailed marks the row failed + unticks it; the loop continues', () => {
    let s = freshOpen();
    s = reducer(s, rebaselineActions.startProposing({}));
    s = reducer(
      s,
      rebaselineActions.proposalFailed({ characterId: 'maerin', error: 'sidecar down' }),
    );
    s = reducer(
      s,
      rebaselineActions.proposalReady({
        characterId: 'marlow',
        persona: 'p',
        proposedVoiceId: 'qwen-marlow',
      }),
    );
    expect(s.proposals.maerin).toMatchObject({
      status: 'failed',
      error: 'sidecar down',
      include: false,
    });
    expect(s.proposals.marlow.status).toBe('ready');
  });

  it('proposalQueued re-queues a row to pending and clears a prior error', () => {
    let s = freshOpen();
    s = reducer(s, rebaselineActions.startProposing({}));
    s = reducer(
      s,
      rebaselineActions.proposalFailed({ characterId: 'maerin', error: 'sidecar down' }),
    );
    // A Re-design/Regenerate re-queues the failed row behind the serial worker.
    s = reducer(s, rebaselineActions.proposalQueued({ characterId: 'maerin' }));
    expect(s.proposals.maerin.status).toBe('pending');
    expect(s.proposals.maerin.error).toBeUndefined();
  });

  it('proposalUnchanged marks a row as kept with its existing voiceId (excluded from the write)', () => {
    let s = freshOpen();
    s = reducer(s, rebaselineActions.startProposing({}));
    s = reducer(
      s,
      rebaselineActions.proposalUnchanged({
        characterId: 'maerin',
        proposedVoiceId: 'qwen-existing',
      }),
    );
    expect(s.proposals.maerin.status).toBe('unchanged');
    expect(s.proposals.maerin.proposedVoiceId).toBe('qwen-existing');
    // 'unchanged' is not 'ready', so includedProposals never writes it.
    expect(includedProposals(s)).toHaveLength(0);
  });

  it('setProposalPersona edits the textarea value', () => {
    let s = freshOpen();
    s = reducer(s, rebaselineActions.startProposing({}));
    s = reducer(
      s,
      rebaselineActions.setProposalPersona({ characterId: 'maerin', persona: 'edited' }),
    );
    expect(s.proposals.maerin.persona).toBe('edited');
  });

  it('toggleProposalInclude flips include for non-failed rows only', () => {
    let s = freshOpen();
    s = reducer(s, rebaselineActions.startProposing({}));
    s = reducer(
      s,
      rebaselineActions.proposalReady({ characterId: 'maerin', persona: 'p', proposedVoiceId: 'v' }),
    );
    s = reducer(s, rebaselineActions.proposalFailed({ characterId: 'marlow', error: 'x' }));
    s = reducer(s, rebaselineActions.toggleProposalInclude({ characterId: 'maerin' }));
    expect(s.proposals.maerin.include).toBe(false);
    // failed row stays excluded — toggle is a no-op
    s = reducer(s, rebaselineActions.toggleProposalInclude({ characterId: 'marlow' }));
    expect(s.proposals.marlow.include).toBe(false);
  });
});

describe('rebaselineSlice — approve', () => {
  function readied(): RebaselineState {
    let s = freshOpen();
    s = reducer(s, rebaselineActions.startProposing({}));
    s = reducer(
      s,
      rebaselineActions.proposalReady({
        characterId: 'maerin',
        persona: 'p1',
        proposedVoiceId: 'qwen-maerin',
      }),
    );
    s = reducer(
      s,
      rebaselineActions.proposalReady({
        characterId: 'marlow',
        persona: 'p2',
        proposedVoiceId: 'qwen-marlow',
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
    s = reducer(s, rebaselineActions.proposalApplied({ characterId: 'maerin' }));
    expect(s.proposals.maerin.status).toBe('applied');
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
        characterId: 'maerin',
        persona: 'p',
        proposedVoiceId: 'qwen-maerin',
      }),
    );
    // marlow stays pending (no voiceId) → excluded
    const included = includedProposals(s);
    expect(included.map((p) => p.characterId)).toEqual(['maerin']);
    // untick maerin → empty
    s = reducer(s, rebaselineActions.toggleProposalInclude({ characterId: 'maerin' }));
    expect(includedProposals(s)).toHaveLength(0);
  });
});
