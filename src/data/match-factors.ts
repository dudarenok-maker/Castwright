import type { MatchFactor } from '../lib/types';

export const MATCH_FACTORS: Record<string, MatchFactor[]> = {
  narrator: [
    {
      id: 'rhythm',
      label: 'Sentence rhythm',
      score: 0.96,
      detail:
        "Long, layered subordinate clauses with restrained register — same cadence as Anders Vale's narration in Solway Bay.",
    },
    {
      id: 'register',
      label: 'Vocabulary register',
      score: 0.94,
      detail:
        "Literary, observational, dry humour. High overlap with the Solway Bay narrator's word distribution.",
    },
    {
      id: 'mode',
      label: 'Speech mode',
      score: 0.95,
      detail:
        'Third-person omniscient with inner-monologue sidebars — identical narrative posture.',
    },
    {
      id: 'tempo',
      label: 'Pacing',
      score: 0.88,
      detail: 'Mid-tempo with deliberate pauses around dialogue attribution.',
    },
    {
      id: 'audience',
      label: 'Implied listener',
      score: 0.92,
      detail:
        'Directly addresses the reader without breaking frame — same convention as the prior book.',
    },
  ],
  /* Plan 41 — pair with the matchedFrom seeds on Eliza + Marcus in
     ../data/characters so the mock voice-match returns candidates for them
     and the confirm-cast bulk-sync pill renders with N > 1. */
  eliza: [
    {
      id: 'name_alias',
      label: 'Name continuity',
      score: 0.93,
      detail: '"Eliza Gray" matches the prior book\'s stowaway under the same alias.',
    },
    {
      id: 'register',
      label: 'Vocabulary register',
      score: 0.88,
      detail: 'Working-class London cadence with defiant edge — same registers as the prior book.',
    },
  ],
  marcus: [
    {
      id: 'role',
      label: 'Role continuity',
      score: 0.9,
      detail: "Ship's cook with self-directed muttering — same role and speech mode as before.",
    },
    {
      id: 'register',
      label: 'Vocabulary register',
      score: 0.82,
      detail: 'Welsh lilt with resigned warmth — overlapping vocabulary with the prior book.',
    },
  ],
};
