import type { Character } from '../lib/types';

export const initialCharacters: Character[] = [
  {
    id: 'narrator',
    name: 'Narrator',
    role: 'Third-person omniscient',
    color: 'narrator',
    lines: 312,
    scenes: 24,
    attributes: ['Neutral', 'Mid-tempo', 'Mid-Atlantic', 'Warm'],
    tone: { warmth: 60, pace: 50, authority: 55, emotion: 30 },
    voiceId: 'v_anders',
    voiceState: 'reused',
    description: 'Steady, lightly literary, never melodramatic. Establishes mood through cadence.',
    evidence: [
      {
        quote:
          'He could feel it before he saw it — a pressure shift behind his right ear that thirty winters at sea had taught him to trust more than any instrument the Admiralty could nail to a wall.',
        note: 'Long-form: drives the voice-cloning sample. Sentence rhythm with layered subordinate clauses, restrained register.',
      },
      {
        quote: 'She said it under her breath, which is how she said most of the things she meant.',
        note: 'Dry, observational; understated humour.',
      },
      {
        quote:
          'The fog came in the way fog always came in here — without apology, and without announcement.',
        note: 'Lightly literary cadence; comma-split parallelism is a hallmark.',
      },
    ],
    matchedFrom: {
      bookTitle: 'Solway Bay',
      bookId: 'sb',
      characterId: 'narrator_sb',
      confidence: 0.94,
    },
  },
  {
    id: 'halloran',
    name: 'Captain Halloran',
    role: 'Captain of the Northern Star',
    color: 'halloran',
    lines: 247,
    scenes: 18,
    attributes: ['Male', 'Baritone', 'Northern English', '60s', 'Authoritative'],
    tone: { warmth: 35, pace: 40, authority: 90, emotion: 45 },
    voiceId: 'v_halloran',
    voiceState: 'generated',
    description: 'Quiet command, never raised. Speaks in clipped, complete sentences.',
    evidence: [
      {
        quote:
          '“Mr. Vance, you will reef the topsails before the next bell. You will do it without comment, and you will report back to me when it is done — and not, sir, a moment before.”',
        note: 'Long-form: drives the voice-cloning sample. Triple-cadence order, calm authority, period vocabulary.',
      },
      {
        quote:
          '“Hard to starboard,” he said, not loudly, because Halloran had never had to be loud to be obeyed.',
        note: 'Authority cue: command obeyed without volume.',
      },
      {
        quote: '“Possibly,” Halloran allowed, “though not in the next hour, and not by my hand.”',
        note: 'Speech split by attribution; precise, parsed thinking.',
      },
      { quote: 'thirty winters at sea', note: 'Age inference: 50s–60s; nautical vernacular.' },
    ],
  },
  {
    id: 'eliza',
    name: 'Eliza Gray',
    role: 'Reluctant stowaway',
    color: 'eliza',
    lines: 412,
    scenes: 22,
    attributes: ['Female', 'Alto', 'Working-class London', '20s', 'Defiant'],
    tone: { warmth: 55, pace: 70, authority: 40, emotion: 75 },
    voiceId: 'v_eliza',
    voiceState: 'tuned',
    ttsEngine: 'qwen',
    overrideTtsVoices: { qwen: { name: 'qwen-eliza' } },
    description: 'Sharp-tongued, sharper-witted. Hides fear behind sarcasm.',
    evidence: [
      {
        quote:
          "“Oh, that's lovely, that is — a captain who can't read his own glass, and a cook who burns the only fish we've got, and me down here in the wet with the both of you. I'd laugh, only my teeth are chattering.”",
        note: 'Long-form: drives the voice-cloning sample. Working-class London cadence, defiance pinned over fear.',
      },
      {
        quote: "“You'll get us all drowned, you old fool.”",
        note: 'Direct address using diminutive; defiant register.',
      },
      {
        quote: 'She said it under her breath, which is how she said most of the things she meant.',
        note: 'Habitual mode: sotto voce honesty.',
      },
    ],
    /* Plan 41 — fixture: Eliza is also a returning character from a prior
       series book, so the bulk-sync pill on confirm-cast has more than one
       eligible card to toggle in mock mode. */
    matchedFrom: {
      bookTitle: 'Solway Bay',
      bookId: 'sb',
      characterId: 'eliza_sb',
      confidence: 0.89,
    },
  },
  {
    id: 'marcus',
    name: 'Marcus the Cook',
    role: "Ship's cook",
    color: 'marcus',
    lines: 86,
    scenes: 11,
    attributes: ['Male', 'Tenor', 'Welsh', '50s', 'Wry'],
    tone: { warmth: 80, pace: 55, authority: 45, emotion: 50 },
    voiceId: 'v_marcus',
    voiceState: 'generated',
    description: 'Sees everything. Says little. Talks to himself most of all.',
    evidence: [
      {
        quote:
          "“Well now, if the captain wants his supper hot, the captain ought to keep his ship out of the wind a quarter-hour, that's all I'm saying — to the pot, mind, not to him. To him I'll say nothing, and the pot won't tell.”",
        note: 'Long-form: drives the voice-cloning sample. Welsh lilt, self-directed muttering, resigned warmth.',
      },
      {
        quote:
          'He said it to the empty galley, which is the only place a man like Marcus ever truly spoke first.',
        note: "Narrator profile of Marcus's speech mode.",
      },
      { quote: '“Cold supper it is, then.”', note: 'Single line; self-directed; resigned warmth.' },
    ],
    /* Plan 41 — fixture: Marcus is also a returning character from a prior
       series book. Combined with the narrator + Eliza seeds, the bulk-sync
       pill renders with N=3 in mock mode. */
    matchedFrom: {
      bookTitle: 'Solway Bay',
      bookId: 'sb',
      characterId: 'marcus_sb',
      confidence: 0.86,
    },
  },
];
