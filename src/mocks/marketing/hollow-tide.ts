/* Capture-only marketing fixtures (VITE_DEMO_CAPTURE=1). Additive — never
   served in normal mock mode, so this touches no existing spec. */
import type { LibraryResponse, BookStateResponse, Character, Sentence } from '../../lib/types';
import type { CoverFraming } from '../../lib/cover-framing';

const COVER = (slug: string) => `/marketing-covers/${slug}.png`;

/* The grid card crops the square cover to 16:10 (object-cover, centred), which
   clips the title near the top. Bias the visible region upward so the title
   reads on the shelf. No effect on the 1:1 listen cover (the full square shows,
   so object-position is a no-op there). */
const TITLE_TOP_FRAME: CoverFraming = { offsetX: 0, offsetY: -55, zoom: 1 };

/* --- Recurring cast, designed in Book 1, reused in 2 & 3 --- */
const narrator = (): Character => ({
  id: 'narrator',
  name: 'Narrator',
  role: 'Narrator',
  color: '#3C6E71',
  voiceId: 'v_marin_narrator',
  voiceState: 'generated',
  tone: { warmth: 0.6, pace: 0.5, authority: 0.7, emotion: 0.4 },
  description: 'Measured, salt-weathered storyteller.',
});

const inspCray = (): Character => ({
  id: 'insp-cray',
  name: 'Insp. Cray',
  role: 'Detective',
  color: '#264653',
  voiceId: 'v_marin_cray',
  voiceState: 'generated',
  tone: { warmth: 0.4, pace: 0.45, authority: 0.85, emotion: 0.5 },
  description: 'Dogged harbour-town inspector.',
  ttsEngine: 'qwen',
  overrideTtsVoices: { qwen: { name: 'qwen-cray-v1' } },
});

const drWren = (): Character => ({
  id: 'dr-wren',
  name: 'Dr. Wren',
  role: 'Coroner',
  color: '#7B5A26',
  voiceId: 'v_marin_wren',
  voiceState: 'generated',
  tone: { warmth: 0.55, pace: 0.4, authority: 0.6, emotion: 0.45 },
  description: 'Precise, dryly humane coroner.',
  ttsEngine: 'qwen',
  overrideTtsVoices: { qwen: { name: 'qwen-wren-v1' } },
});

const reusedFromBook1 = (c: Character): Character => ({
  ...c,
  voiceState: 'reused',
  matchedFrom: {
    bookId: 'hollow-tide-1',
    characterId: c.id,
    bookTitle: 'The Drowning Bell',
    confidence: 0.97,
  },
});

/* --- Book-1-only characters (4 unique to The Drowning Bell) --- */
const book1OnlyChars: Character[] = [
  {
    id: 'elara-moss',
    name: 'Elara Moss',
    role: 'Harbormaster',
    color: '#5C3B6E',
    voiceId: 'v_marin_elara',
    voiceState: 'generated',
    tone: { warmth: 0.5, pace: 0.55, authority: 0.65, emotion: 0.6 },
    description: 'Bureaucratic harbormaster with a secret.',
  },
  {
    id: 'old-fenwick',
    name: 'Old Fenwick',
    role: 'Fisherman',
    color: '#4A6741',
    voiceId: 'v_marin_fenwick',
    voiceState: 'generated',
    tone: { warmth: 0.75, pace: 0.35, authority: 0.3, emotion: 0.55 },
    description: 'Weathered fisherman who saw too much.',
  },
  {
    id: 'constance-vale',
    name: 'Constance Vale',
    role: 'Widow',
    color: '#8C4A4A',
    voiceId: 'v_marin_constance',
    voiceState: 'generated',
    tone: { warmth: 0.45, pace: 0.5, authority: 0.4, emotion: 0.8 },
    description: 'The widow whose husband was the first victim.',
  },
  {
    id: 'priest-aldric',
    name: 'Father Aldric',
    role: 'Priest',
    color: '#3D3D5C',
    voiceId: 'v_marin_aldric',
    voiceState: 'generated',
    tone: { warmth: 0.6, pace: 0.4, authority: 0.7, emotion: 0.35 },
    description: 'The parish priest with an unsettling calm.',
  },
];

/* --- Book-2-new characters (3 unique to Saltgrave) --- */
const book2NewChars: Character[] = [
  {
    id: 'dockhand-remy',
    name: 'Remy Halse',
    role: 'Dockhand',
    color: '#5A7A6E',
    voiceId: 'v_marin_remy',
    voiceState: 'generated',
    tone: { warmth: 0.65, pace: 0.6, authority: 0.25, emotion: 0.7 },
    description: 'Jumpy dockhand who knows the salt-mines.',
  },
  {
    id: 'magistrate-cross',
    name: 'Magistrate Cross',
    role: 'Magistrate',
    color: '#6B5740',
    voiceId: 'v_marin_cross',
    voiceState: 'generated',
    tone: { warmth: 0.3, pace: 0.45, authority: 0.9, emotion: 0.25 },
    description: 'The magistrate who controls the salt trade.',
  },
  {
    id: 'lighthouse-keeper',
    name: 'Sable Orn',
    role: 'Lighthouse Keeper',
    color: '#3E5C6A',
    voiceId: 'v_marin_sable',
    voiceState: 'generated',
    tone: { warmth: 0.5, pace: 0.3, authority: 0.5, emotion: 0.6 },
    description: 'Reclusive lighthouse keeper with a long memory.',
  },
];

const now = '2026-06-12T09:00:00.000Z';

function bookState(args: {
  bookId: string;
  title: string;
  author: string;
  series: string;
  seriesPosition: number | null;
  isStandalone: boolean;
  coverGradient: [string, string];
  castConfirmed: boolean;
  chapters: BookStateResponse['state']['chapters'];
  cast: Character[] | null;
  completedSlugs: string[];
  sentences?: Sentence[];
}): BookStateResponse {
  return {
    state: {
      bookId: args.bookId,
      manuscriptId: `mns_${args.bookId}`,
      title: args.title,
      author: args.author,
      series: args.series,
      seriesPosition: args.seriesPosition,
      isStandalone: args.isStandalone,
      manuscriptFile: 'manuscript.epub',
      castConfirmed: args.castConfirmed,
      chapters: args.chapters,
      coverGradient: args.coverGradient,
      createdAt: now,
      updatedAt: now,
      narratorCredit: null,
    },
    cast: args.cast ? { characters: args.cast } : null,
    manuscript: { wordCount: 84_000, format: 'epub' },
    manuscriptEdits: args.sentences ? { sentences: args.sentences } : null,
    revisions: null,
    completedSlugs: args.completedSlugs,
    changeLog: null,
  };
}

/* Helper to build chapter arrays */
function makeChapters(
  count: number,
  opts: { withDuration?: boolean } = {},
): BookStateResponse['state']['chapters'] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    title: `Chapter ${i + 1}`,
    slug: `${String(i + 1).padStart(2, '0')}-chapter`,
    ...(opts.withDuration ? { duration: '34:12' } : {}),
  }));
}

/* ── Book 1 — The Drowning Bell — FINISHED (worked example) ── */
const BOOK1_CHAPTERS = makeChapters(12, { withDuration: true });

const drowningBell = bookState({
  bookId: 'hollow-tide-1',
  title: 'The Drowning Bell',
  author: 'Marin Vale',
  series: 'The Hollow Tide',
  seriesPosition: 1,
  isStandalone: false,
  coverGradient: ['#1F3A40', '#0B1416'],
  castConfirmed: true,
  chapters: BOOK1_CHAPTERS,
  cast: [narrator(), inspCray(), drWren(), ...book1OnlyChars],
  completedSlugs: BOOK1_CHAPTERS.map((c) => c.slug),
});

/* ── Book 2 — Saltgrave — GENERATING (11 chapters, 7 done) ── */
const BOOK2_CHAPTERS = makeChapters(11);

const saltgrave = bookState({
  bookId: 'hollow-tide-2',
  title: 'Saltgrave',
  author: 'Marin Vale',
  series: 'The Hollow Tide',
  seriesPosition: 2,
  isStandalone: false,
  coverGradient: ['#2B4C57', '#101D22'],
  castConfirmed: true,
  chapters: BOOK2_CHAPTERS,
  cast: [
    reusedFromBook1(narrator()),
    reusedFromBook1(inspCray()),
    reusedFromBook1(drWren()),
    ...book2NewChars,
  ],
  completedSlugs: BOOK2_CHAPTERS.slice(0, 7).map((c) => c.slug),
});

/* ── Book 3 — The Tidewatcher's Oath — ANALYSING (cast still forming) ── */
const BOOK3_CHAPTERS = makeChapters(8);

const tidewatcher = bookState({
  bookId: 'hollow-tide-3',
  title: "The Tidewatcher's Oath",
  author: 'Marin Vale',
  series: 'The Hollow Tide',
  seriesPosition: 3,
  isStandalone: false,
  coverGradient: ['#22343F', '#0A1014'],
  castConfirmed: false,
  chapters: BOOK3_CHAPTERS,
  cast: [reusedFromBook1(narrator()), reusedFromBook1(inspCray())],
  completedSlugs: [],
});

/* ── Coalfall Commission — Standalone ── */
const COALFALL_CHAPTERS = makeChapters(4, { withDuration: true });

/* Canonical cast for The Coalfall Commission — dark-fantasy dragon mystery. */
const coalfallCast: Character[] = [
  {
    id: 'narrator',
    name: 'Narrator',
    role: 'Narrator',
    color: '#3C6E71',
    voiceState: 'generated',
    tone: { warmth: 0.6, pace: 0.5, authority: 0.7, emotion: 0.4 },
    description: 'Unhurried chronicler of ash and shadow.',
    gender: 'neutral',
    ageRange: 'adult',
    lines: 310,
    scenes: 4,
  },
  {
    id: 'wren',
    name: 'Wren',
    role: "Dragon's apprentice",
    color: '#7B3F9E',
    voiceState: 'reused',
    aliases: ['Sparrow'],
    ttsEngine: 'qwen',
    overrideTtsVoices: { qwen: { name: 'qwen-wren-v1' } },
    tone: { warmth: 0.7, pace: 0.55, authority: 0.4, emotion: 0.75 },
    description: "Curious, quick-tongued apprentice who earns the dragon's trust.",
    gender: 'female',
    ageRange: 'teen',
    matchedFrom: {
      bookId: 'the-ember-year',
      characterId: 'sparrow',
      bookTitle: 'The Ember Year',
      confidence: 0.96,
    },
    lines: 240,
    scenes: 4,
  },
  {
    id: 'master-oduvan',
    name: 'Master Oduvan',
    role: 'Dragon-keeper',
    color: '#4A2C6B',
    voiceState: 'generated',
    ttsEngine: 'qwen',
    overrideTtsVoices: { qwen: { name: 'qwen-oduvan-v1' } },
    tone: { warmth: 0.5, pace: 0.35, authority: 0.8, emotion: 0.3 },
    description: 'Ancient keeper of the last bonded dragon; patient as cooling lava.',
    gender: 'male',
    ageRange: 'elderly',
    lines: 175,
    scenes: 4,
  },
  {
    id: 'coalfall',
    name: 'Coalfall',
    role: 'Dragon',
    color: '#B54E1A',
    voiceState: 'generated',
    ttsEngine: 'qwen',
    overrideTtsVoices: {
      qwen: {
        name: 'qwen-coalfall-v1',
        variants: {
          angry: { name: 'qwen-coalfall-angry' },
          whisper: { name: 'qwen-coalfall-whisper' },
          excited: { name: 'qwen-coalfall-excited' },
          sad: { name: 'qwen-coalfall-sad' },
        },
      },
    },
    tone: { warmth: 0.35, pace: 0.3, authority: 0.95, emotion: 0.65 },
    description: 'The last bonded dragon — volcanic-voiced, ancient, and grieving.',
    gender: 'neutral',
    ageRange: 'elderly',
    lines: 95,
    scenes: 3,
  },
  {
    id: 'brann-weir',
    name: 'Brann Weir',
    role: 'Commissioner',
    color: '#2E4A6C',
    voiceState: 'generated',
    tone: { warmth: 0.3, pace: 0.45, authority: 0.85, emotion: 0.35 },
    description: 'The city commissioner who ordered the investigation; pragmatic and cold.',
    gender: 'male',
    ageRange: 'adult',
    lines: 88,
    scenes: 3,
  },
  {
    id: 'berrin-weir',
    name: 'Berrin Weir',
    role: "Commissioner's son",
    color: '#3A6E8A',
    voiceState: 'generated',
    tone: { warmth: 0.5, pace: 0.6, authority: 0.35, emotion: 0.7 },
    description: "Brann's idealistic son — caught between duty and conscience.",
    gender: 'male',
    ageRange: 'teen',
    lines: 62,
    scenes: 2,
  },
  {
    id: 'father-lessom',
    name: 'Father Lessom',
    role: 'Priest',
    color: '#4B4B72',
    voiceState: 'generated',
    tone: { warmth: 0.55, pace: 0.4, authority: 0.7, emotion: 0.4 },
    description: 'Parish priest of the Ashwell chapel; keeper of uncomfortable truths.',
    gender: 'male',
    ageRange: 'adult',
    lines: 54,
    scenes: 2,
  },
  {
    id: 'ivo',
    name: 'Ivo',
    role: 'Stablehand',
    color: '#5A7A4A',
    voiceState: 'generated',
    tone: { warmth: 0.75, pace: 0.65, authority: 0.2, emotion: 0.6 },
    description: 'Kindhearted stablehand who tends the dragon when no one else will.',
    gender: 'male',
    ageRange: 'teen',
    lines: 41,
    scenes: 2,
  },
  {
    id: 'maerin',
    name: 'Maerin',
    role: 'Healer',
    color: '#7A4A5A',
    voiceState: 'generated',
    ttsEngine: 'qwen',
    overrideTtsVoices: { qwen: { name: 'qwen-maerin-v1' } },
    tone: { warmth: 0.8, pace: 0.45, authority: 0.5, emotion: 0.65 },
    description: 'Village healer who suspects the poisoning was deliberate.',
    gender: 'female',
    ageRange: 'adult',
    lines: 48,
    scenes: 2,
  },
  {
    id: 'hart',
    name: 'Hart',
    role: 'Guard captain',
    color: '#4A3C28',
    voiceState: 'generated',
    tone: { warmth: 0.35, pace: 0.5, authority: 0.8, emotion: 0.25 },
    description: 'Laconic guard captain who follows orders without question.',
    gender: 'male',
    ageRange: 'adult',
    lines: 35,
    scenes: 2,
  },
  {
    id: 'sela',
    name: 'Sela',
    role: 'Innkeeper',
    color: '#8C5E3A',
    voiceState: 'generated',
    tone: { warmth: 0.8, pace: 0.6, authority: 0.45, emotion: 0.55 },
    description: 'Warm-hearted innkeeper who hears everything and forgets nothing.',
    gender: 'female',
    ageRange: 'adult',
    lines: 30,
    scenes: 1,
  },
  {
    id: 'Pell-hollis',
    name: 'Pell Hollis',
    role: 'Messenger',
    color: '#6E6E3A',
    voiceState: 'generated',
    tone: { warmth: 0.55, pace: 0.7, authority: 0.2, emotion: 0.5 },
    description: 'Fleet-footed messenger who carries more dangerous news than he realises.',
    gender: 'male',
    ageRange: 'adult',
    lines: 22,
    scenes: 1,
  },
];

/* Canonical manuscript sentences for Chapter 1 of The Coalfall Commission. */
const coalfallSentences: Sentence[] = [
  {
    id: 1,
    chapterId: 1,
    characterId: 'narrator',
    text: 'The smell of scorched stone reached the lower courtyard long before dawn, carried on a wind that tasted of old fire.',
  },
  {
    id: 2,
    chapterId: 1,
    characterId: 'narrator',
    text: "Wren had learned, in her first weeks under Master Oduvan's roof, that the dragon always knew when someone was afraid.",
  },
  {
    id: 3,
    chapterId: 1,
    characterId: 'master-oduvan',
    text: 'You will carry the morning pail yourself today, and you will not run, and you will not look away.',
  },
  {
    id: 4,
    chapterId: 1,
    characterId: 'wren',
    text: 'I know the rules.',
    emotion: 'whisper',
  },
  {
    id: 5,
    chapterId: 1,
    characterId: 'master-oduvan',
    text: 'Knowing and doing are not the same country.',
  },
  {
    id: 6,
    chapterId: 1,
    characterId: 'narrator',
    text: "The keep's inner gate swung wide, and Wren stepped through into the heat.",
  },
  {
    id: 7,
    chapterId: 1,
    characterId: 'coalfall',
    text: "You smell of the commissioner's house.",
    emotion: 'angry',
  },
  {
    id: 8,
    chapterId: 1,
    characterId: 'wren',
    text: 'I carried a letter through the lower district — it was the fastest route.',
  },
  {
    id: 9,
    chapterId: 1,
    characterId: 'coalfall',
    text: 'Weir does not send letters without a blade hidden inside them.',
    confidence: 0.58,
  },
  {
    id: 10,
    chapterId: 1,
    characterId: 'narrator',
    text: 'The dragon lowered its great head until one amber eye was level with hers, the pupil narrowing to a slit in the torchlight.',
  },
  {
    id: 11,
    chapterId: 1,
    characterId: 'master-oduvan',
    text: 'Coalfall — enough. She is mine to instruct, not yours to interrogate.',
  },
  {
    id: 12,
    chapterId: 1,
    characterId: 'coalfall',
    text: 'Then instruct her to be careful.',
    emotion: 'sad',
  },
  {
    id: 13,
    chapterId: 1,
    characterId: 'wren',
    text: 'What does the commission want with a bonded dragon, Master?',
  },
  {
    id: 14,
    chapterId: 1,
    characterId: 'master-oduvan',
    text: 'That is exactly the question that will keep us both alive long enough to find out.',
  },
];

const coalfallCommission = bookState({
  bookId: 'coalfall-commission',
  title: 'The Coalfall Commission',
  author: 'Castwright',
  series: 'Standalones',
  seriesPosition: null,
  isStandalone: true,
  coverGradient: ['#3C194F', '#0F0E0D'],
  castConfirmed: true,
  chapters: COALFALL_CHAPTERS,
  cast: coalfallCast,
  sentences: coalfallSentences,
  completedSlugs: COALFALL_CHAPTERS.map((c) => c.slug),
});

export const HOLLOW_TIDE_BOOK_STATES = new Map<string, BookStateResponse>([
  ['hollow-tide-1', drowningBell],
  ['hollow-tide-2', saltgrave],
  ['hollow-tide-3', tidewatcher],
  ['coalfall-commission', coalfallCommission],
]);

export const HOLLOW_TIDE_LIBRARY: LibraryResponse = {
  authors: [
    {
      name: 'Marin Vale',
      series: [
        {
          name: 'The Hollow Tide',
          books: [
            {
              bookId: 'hollow-tide-1',
              title: 'The Drowning Bell',
              author: 'Marin Vale',
              series: 'The Hollow Tide',
              seriesPosition: 1,
              isStandalone: false,
              status: 'complete',
              chapterCount: 12,
              completedChapters: 12,
              characterCount: 7,
              voiceCount: 7,
              progress: 1,
              runtime: '7h 02m',
              lastWorkedOn: '2 days ago',
              coverGradient: ['#1F3A40', '#0B1416'],
              coverImageUrl: COVER('hollow-tide-1'),
              coverFraming: TITLE_TOP_FRAME,
              tags: ['series-1'],
            },
            {
              bookId: 'hollow-tide-2',
              title: 'Saltgrave',
              author: 'Marin Vale',
              series: 'The Hollow Tide',
              seriesPosition: 2,
              isStandalone: false,
              status: 'generating',
              chapterCount: 11,
              completedChapters: 7,
              characterCount: 6,
              voiceCount: 6,
              progress: 0.62,
              runtime: '6h 18m',
              lastWorkedOn: '4 min ago',
              coverGradient: ['#2B4C57', '#101D22'],
              coverImageUrl: COVER('hollow-tide-2'),
              coverFraming: TITLE_TOP_FRAME,
              pinned: true,
              tags: ['series-1'],
            },
            {
              bookId: 'hollow-tide-3',
              title: "The Tidewatcher's Oath",
              author: 'Marin Vale',
              series: 'The Hollow Tide',
              seriesPosition: 3,
              isStandalone: false,
              status: 'analysing',
              chapterCount: 8,
              completedChapters: 0,
              characterCount: 0,
              voiceCount: 0,
              progress: 0.4,
              lastWorkedOn: 'Just now',
              coverGradient: ['#22343F', '#0A1014'],
              coverImageUrl: COVER('hollow-tide-3'),
              coverFraming: TITLE_TOP_FRAME,
              tags: ['series-1'],
            },
          ],
        },
      ],
    },
    {
      name: 'Castwright',
      series: [
        {
          name: 'Standalones',
          books: [
            {
              bookId: 'coalfall-commission',
              title: 'The Coalfall Commission',
              author: 'Castwright',
              series: 'Standalones',
              seriesPosition: null,
              isStandalone: true,
              status: 'complete',
              chapterCount: 4,
              completedChapters: 4,
              characterCount: 12,
              voiceCount: 12,
              progress: 1,
              runtime: '2h 41m',
              lastWorkedOn: 'Last week',
              coverGradient: ['#3C194F', '#0F0E0D'],
              coverImageUrl: COVER('coalfall-commission'),
              coverFraming: TITLE_TOP_FRAME,
              tags: [],
            },
          ],
        },
      ],
    },
  ],
};

/* ── Voice-library fixture (served under VITE_DEMO_CAPTURE=1) ──────────── */
import type { VoiceLibraryResponse, Voice } from '../../lib/types';
import { gradientForTtsVoice } from '../../lib/voice-palette';

type MockVoice = Omit<Voice, 'gradient'> & {
  ttsVoice: { provider: 'gemini' | 'qwen'; name: string; description: string };
};

function withGradient(v: MockVoice): Voice {
  return { ...v, gradient: gradientForTtsVoice(v.ttsVoice.name, v.id) };
}

const geminiTts = (name: string, description: string) => ({
  provider: 'gemini' as const,
  name,
  description,
});

const qwenTts = (name: string, description: string) => ({
  provider: 'qwen' as const,
  name,
  description,
});

/* Three distinct base voices for the recurring principals.
   Two minor characters share 'Sulafat' intentionally — the library then
   shows a family with >1 member for that base voice. */
export const HOLLOW_TIDE_VOICES: VoiceLibraryResponse = {
  voices: [
    /* ── Recurring across the whole series (designed in Book 1) ── */
    withGradient({
      id: 'v_marin_narrator',
      character: 'Narrator',
      bookTitle: 'The Drowning Bell',
      bookId: 'hollow-tide-1',
      bookSeries: 'The Hollow Tide',
      attributes: ['Neutral', 'Mid-tempo', 'Mid-Atlantic', 'Measured', 'Weathered'],
      usedIn: 3,
      source: 'current',
      reusable: true,
      ttsVoice: geminiTts('Sulafat', 'Warm'),
    }),
    withGradient({
      id: 'v_marin_cray',
      character: 'Insp. Cray',
      bookTitle: 'The Drowning Bell',
      bookId: 'hollow-tide-1',
      bookSeries: 'The Hollow Tide',
      attributes: ['Male', 'Baritone', 'Northern English', '50s', 'Dogged'],
      usedIn: 3,
      source: 'current',
      ttsVoice: geminiTts('Charon', 'Informative'),
    }),
    withGradient({
      id: 'v_marin_wren',
      character: 'Dr. Wren',
      bookTitle: 'The Drowning Bell',
      bookId: 'hollow-tide-1',
      bookSeries: 'The Hollow Tide',
      attributes: ['Female', 'Mezzo', 'RP English', '40s', 'Precise'],
      usedIn: 3,
      source: 'current',
      ttsVoice: geminiTts('Aoede', 'Breezy'),
    }),
    /* ── Book-1-only characters (The Drowning Bell) ── */
    withGradient({
      id: 'v_marin_elara',
      character: 'Elara Moss',
      bookTitle: 'The Drowning Bell',
      bookId: 'hollow-tide-1',
      bookSeries: 'The Hollow Tide',
      attributes: ['Female', 'Alto', 'West Country', '40s', 'Guarded'],
      usedIn: 1,
      source: 'current',
      ttsVoice: geminiTts('Kore', 'Firm'),
    }),
    withGradient({
      id: 'v_marin_fenwick',
      character: 'Old Fenwick',
      bookTitle: 'The Drowning Bell',
      bookId: 'hollow-tide-1',
      bookSeries: 'The Hollow Tide',
      attributes: ['Male', 'Bass', 'Scottish', '70s', 'Grizzled'],
      usedIn: 1,
      source: 'current',
      ttsVoice: geminiTts('Algieba', 'Smooth'),
    }),
    withGradient({
      id: 'v_marin_constance',
      character: 'Constance Vale',
      bookTitle: 'The Drowning Bell',
      bookId: 'hollow-tide-1',
      bookSeries: 'The Hollow Tide',
      attributes: ['Female', 'Soprano', 'Southern English', '50s', 'Grieving'],
      usedIn: 1,
      source: 'current',
      ttsVoice: geminiTts('Sulafat', 'Warm'),
    }),
    withGradient({
      id: 'v_marin_aldric',
      character: 'Father Aldric',
      bookTitle: 'The Drowning Bell',
      bookId: 'hollow-tide-1',
      bookSeries: 'The Hollow Tide',
      attributes: ['Male', 'Tenor', 'Irish', '60s', 'Sepulchral'],
      usedIn: 1,
      source: 'current',
      ttsVoice: geminiTts('Iapetus', 'Clear'),
    }),
    /* ── Book-2-new characters (Saltgrave) ── */
    withGradient({
      id: 'v_marin_remy',
      character: 'Remy Halse',
      bookTitle: 'Saltgrave',
      bookId: 'hollow-tide-2',
      bookSeries: 'The Hollow Tide',
      attributes: ['Male', 'Tenor', 'West Country', '20s', 'Nervous'],
      usedIn: 1,
      source: 'library',
      inCurrentSeries: true,
      ttsVoice: qwenTts('qwen-remy', 'Designed voice'),
    }),
    withGradient({
      id: 'v_marin_cross',
      character: 'Magistrate Cross',
      bookTitle: 'Saltgrave',
      bookId: 'hollow-tide-2',
      bookSeries: 'The Hollow Tide',
      attributes: ['Male', 'Baritone', 'RP English', '60s', 'Imperious'],
      usedIn: 1,
      source: 'library',
      inCurrentSeries: true,
      ttsVoice: geminiTts('Charon', 'Informative'),
    }),
    withGradient({
      id: 'v_marin_sable',
      character: 'Sable Orn',
      bookTitle: 'Saltgrave',
      bookId: 'hollow-tide-2',
      bookSeries: 'The Hollow Tide',
      attributes: ['Female', 'Contralto', 'Scottish', '50s', 'Reclusive'],
      usedIn: 1,
      source: 'library',
      inCurrentSeries: true,
      ttsVoice: qwenTts('qwen-sable', 'Designed voice'),
    }),
  ],
};

/* Posed snapshots for the animated views (Task B4 emits these once, then hangs). */
export const HOLLOW_TIDE_POSED = {
  analysing: {
    bookId: 'hollow-tide-3',
    manuscriptId: 'mns_hollow-tide-3',
    bookTitle: "The Tidewatcher's Oath",
    phaseId: 1,
    phaseLabel: 'Detecting characters',
    phaseProgress: 0.55,
    remainingMs: 42_000,
    live: {
      totalChapters: 8,
      chapters: [
        { chapterIndex: 3, chapterTitle: 'Chapter 3', elapsedMs: 4200, estMs: 7000 },
        { chapterIndex: 4, chapterTitle: 'Chapter 4', elapsedMs: 1600, estMs: 6800 },
      ],
    },
  },
  generating: {
    bookId: 'hollow-tide-2',
    chapterId: 8,
    modelKey: 'kokoro-v1' as const,
    done: 7,
    total: 11,
    inProgress: 1,
  },
};
