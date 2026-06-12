import type { DriftEvent } from '../lib/types';

/* Mock drift events used by `api.pollRevisions` in VITE_USE_MOCKS mode.
   Two books are seeded so the modal's multi-book grouping renders in
   dev: `sb` (the design fixture's current book) and
   `cc` (a second book to exercise the cross-book header).

   Each event now embeds the structured comparison payload the Drift
   Report relies on: `chapterTitle` (so the row label doesn't need to
   join chapters slice), `snapshot` (pre-render profile), `current`
   (live cast profile). Mirror of the server emit contract in
   server/src/routes/revisions.ts. */
export const VOICE_DRIFT_EVENTS: DriftEvent[] = [
  {
    id: 'drift:sb:7:eliza:register',
    bookId: 'sb',
    characterId: 'eliza',
    chapterId: 7,
    chapterTitle: 'An Unexpected Reading',
    severity: 'severe',
    factor: 'register',
    factorLabel: 'Vocabulary register',
    description:
      "Eliza's register here doesn't match her established defiant working-class register from chapters 1–6. The chapter reads more formal — likely an artefact of recent manuscript edits.",
    metrics: { current: 32, expected: 65, unit: 'informality' },
    snapshot: {
      voiceId: 'af_sarah',
      gender: 'female',
      ageRange: 'adult',
      tone: { warmth: 60, pace: 50, authority: 45, emotion: 55 },
      attributes: ['defiant', 'working-class', 'sharp'],
    },
    current: {
      name: 'Eliza',
      voiceId: 'af_sarah',
      gender: 'female',
      ageRange: 'adult',
      tone: { warmth: 60, pace: 50, authority: 45, emotion: 55 },
      attributes: ['defiant', 'working-class', 'sharp'],
    },
    detected: '2 hr ago',
    suggestedAction: 'regenerate_chapter',
  },
  /* Plan 91 — three more Eliza events on the same snapshot to exercise
     the consolidation path (one card with four chapters inside, rather
     than four separate cards). Mirrors the real-world bug: a single
     cast edit causes drift on every chapter the character voiced. */
  {
    id: 'drift:sb:2:eliza:register',
    bookId: 'sb',
    characterId: 'eliza',
    chapterId: 2,
    chapterTitle: 'A First Meeting',
    severity: 'severe',
    factor: 'register',
    factorLabel: 'Vocabulary register',
    description:
      "Same register drift as chapter 7 — manuscript edits propagated the change across every chapter Eliza voiced.",
    snapshot: {
      voiceId: 'af_sarah',
      gender: 'female',
      ageRange: 'adult',
      tone: { warmth: 60, pace: 50, authority: 45, emotion: 55 },
      attributes: ['defiant', 'working-class', 'sharp'],
    },
    current: {
      name: 'Eliza',
      voiceId: 'af_sarah',
      gender: 'female',
      ageRange: 'adult',
      tone: { warmth: 60, pace: 50, authority: 45, emotion: 55 },
      attributes: ['defiant', 'working-class', 'sharp'],
    },
    detected: '2 hr ago',
    suggestedAction: 'regenerate_chapter',
  },
  {
    id: 'drift:sb:8:eliza:register',
    bookId: 'sb',
    characterId: 'eliza',
    chapterId: 8,
    chapterTitle: 'The Reckoning',
    severity: 'severe',
    factor: 'register',
    factorLabel: 'Vocabulary register',
    description: 'Same snapshot as chapter 7 — consolidated card.',
    snapshot: {
      voiceId: 'af_sarah',
      gender: 'female',
      ageRange: 'adult',
      tone: { warmth: 60, pace: 50, authority: 45, emotion: 55 },
      attributes: ['defiant', 'working-class', 'sharp'],
    },
    current: {
      name: 'Eliza',
      voiceId: 'af_sarah',
      gender: 'female',
      ageRange: 'adult',
      tone: { warmth: 60, pace: 50, authority: 45, emotion: 55 },
      attributes: ['defiant', 'working-class', 'sharp'],
    },
    detected: '2 hr ago',
    suggestedAction: 'regenerate_chapter',
  },
  {
    id: 'drift:sb:9:eliza:register',
    bookId: 'sb',
    characterId: 'eliza',
    chapterId: 9,
    chapterTitle: 'Aftermath',
    severity: 'severe',
    factor: 'register',
    factorLabel: 'Vocabulary register',
    description: 'Same snapshot as chapter 7 — consolidated card.',
    snapshot: {
      voiceId: 'af_sarah',
      gender: 'female',
      ageRange: 'adult',
      tone: { warmth: 60, pace: 50, authority: 45, emotion: 55 },
      attributes: ['defiant', 'working-class', 'sharp'],
    },
    current: {
      name: 'Eliza',
      voiceId: 'af_sarah',
      gender: 'female',
      ageRange: 'adult',
      tone: { warmth: 60, pace: 50, authority: 45, emotion: 55 },
      attributes: ['defiant', 'working-class', 'sharp'],
    },
    detected: '2 hr ago',
    suggestedAction: 'regenerate_chapter',
  },
  {
    id: 'drift:sb:5:halloran:pace',
    bookId: 'sb',
    characterId: 'halloran',
    chapterId: 5,
    chapterTitle: "What the Captain Knew",
    severity: 'moderate',
    factor: 'pace',
    factorLabel: 'Pace',
    description:
      "22% faster than character average. Halloran's hallmark slow command feels rushed in this chapter.",
    metrics: { current: 188, expected: 154, unit: 'words / min' },
    snapshot: {
      voiceId: 'am_michael',
      gender: 'male',
      ageRange: 'adult',
      tone: { warmth: 50, pace: 30, authority: 80, emotion: 40 },
      attributes: ['commanding', 'measured'],
    },
    current: {
      name: 'Captain Halloran',
      voiceId: 'am_michael',
      gender: 'male',
      ageRange: 'adult',
      tone: { warmth: 50, pace: 65, authority: 80, emotion: 40 },
      attributes: ['commanding', 'measured'],
    },
    detected: '1 hr ago',
    suggestedAction: 'regenerate_chapter',
  },
  {
    id: 'drift:sb:4:marcus:warmth',
    bookId: 'sb',
    characterId: 'marcus',
    chapterId: 4,
    chapterTitle: "The Cook's Particular Soup",
    severity: 'mild',
    factor: 'warmth',
    factorLabel: 'Warmth',
    description:
      "Slightly cooler than Marcus's profile. Within tolerance — worth a listen if the chapter sounds off.",
    metrics: { current: 68, expected: 80, unit: 'warmth score' },
    snapshot: {
      voiceId: 'am_adam',
      gender: 'male',
      ageRange: 'adult',
      tone: { warmth: 80, pace: 50, authority: 50, emotion: 60 },
      attributes: ['warm', 'gentle'],
    },
    current: {
      name: 'Marcus',
      voiceId: 'am_adam',
      gender: 'male',
      ageRange: 'adult',
      tone: { warmth: 68, pace: 50, authority: 50, emotion: 60 },
      attributes: ['warm', 'gentle'],
    },
    detected: '30 min ago',
    suggestedAction: 'review',
  },
  /* Second book — exercises the multi-book group header in dev. */
  {
    id: 'drift:cc:3:wren:attributes',
    bookId: 'cc',
    characterId: 'wren',
    chapterId: 3,
    chapterTitle: 'A Letter From Oduvan',
    severity: 'moderate',
    factor: 'attributes',
    factorLabel: 'Attributes',
    description:
      'Attributes added "enthusiastic", "personable", "chatty" after this chapter rendered. Prebuilt-voice picker may now resolve to a different voice on regenerate.',
    snapshot: {
      voiceId: 'af_bella',
      gender: 'female',
      ageRange: 'teen',
      tone: { warmth: 70, pace: 55, authority: 35, emotion: 70 },
      attributes: ['warm', 'observant'],
    },
    current: {
      name: 'Wren Sparrow',
      voiceId: 'af_bella',
      gender: 'female',
      ageRange: 'teen',
      tone: { warmth: 70, pace: 55, authority: 35, emotion: 70 },
      attributes: ['warm', 'observant', 'enthusiastic', 'personable', 'chatty'],
    },
    detected: '12 min ago',
    suggestedAction: 'regenerate_chapter',
  },
];
