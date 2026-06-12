/* Capture-only marketing fixtures (VITE_DEMO_CAPTURE=1). Additive — never
   served in normal mock mode, so this touches no existing spec. */
import type { LibraryResponse, BookStateResponse, Character } from '../../lib/types';
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
    manuscriptEdits: null,
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
  cast: null,
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
              characterCount: 11,
              voiceCount: 11,
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

/* Posed snapshots for the animated views (Task B4 emits these once, then hangs). */
export const HOLLOW_TIDE_POSED = {
  analysing: {
    bookId: 'hollow-tide-3',
    manuscriptId: 'mns_hollow-tide-3',
    bookTitle: "The Tidewatcher's Oath",
    phaseId: 1,
    phaseLabel: 'Detecting characters',
    phaseProgress: 0.45,
    remainingMs: 9000,
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
