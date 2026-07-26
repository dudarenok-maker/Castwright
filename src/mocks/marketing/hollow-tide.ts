/* Capture-only marketing fixtures (VITE_DEMO_CAPTURE=1). Additive — never
   served in normal mock mode, so this touches no existing spec. */
import type {
  LibraryResponse,
  BookStateResponse,
  Character,
  Sentence,
  ContinueListeningItem,
  DriftEvent,
} from '../../lib/types';
import type { CoverFraming } from '../../lib/cover-framing';
import type { ListenProgress } from '../../lib/api';
import coalfallCastJson from './coalfall-cast.json';
import coalfallManuscriptJson from './coalfall-manuscript.json';

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
  overrideTtsVoices: { qwen: { name: 'Cray v1' } },
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
  overrideTtsVoices: { qwen: { name: 'Wren v1' } },
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
  /** fs-2 — BCP-47 book language. Omitted defaults to 'en' (unset on the
      wire), matching the 4 original English-language books. */
  language?: string;
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
      language: args.language,
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
/* Quality Gate marketing/wiki screenshots (#1286) — chapter 7 (already `done`,
   the LAST of the first 7 of 11 completedSlugs below — placed there rather
   than earlier so its row sits below the fold in the two pre-existing
   `generating`/`regenerate-modal` marketing scenes' default unscrolled
   viewport) carries the advisory QA verdict the top-level "Suspect" pill
   checks (chapters-slice.ts:335). Ordered to match the segment override's
   chronological order added in api.ts (ASR content flag at [200,400),
   acoustic flag at [488,600)). */
const BOOK2_CHAPTERS = makeChapters(11).map((c) =>
  c.id === 7
    ? {
        ...c,
        audioQa: {
          status: 'suspect' as const,
          reasons: [
            'Word substitution against the script',
            'Near-silent stretch before a line',
          ],
          measuredLufs: -19.2,
          truePeakDb: -1.4,
          durationSec: 600,
          expectedSec: 580,
          checkedAt: now,
        },
      }
    : c,
);

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

/* ── Book 4 — The Harborlight Ledger — CAST-CONFIRMED, PRE-GENERATION ──
   fs-1318 Tier D: the only marketing fixture book with a genuinely
   undesigned character (harbor-clerk, below) — every other book is fully
   cast-designed, so "Design full cast" renders disabled everywhere else.
   `voiceId`/`voiceState` are OMITTED (not `null`/`'unassigned'` — both are
   type errors, see src/lib/api-types.ts:3533,3537) so the character reads
   as Qwen-effective with no matched voice, which is what
   `resolveVoiceStatus` needs to label it "Needs voice". */
const undesignedExtra = (): Character => ({
  id: 'harbor-clerk',
  name: 'Harbor Clerk',
  role: 'Minor',
  color: '#9C8B6A',
  lines: 12,
  tone: { warmth: 0.5, pace: 0.5, authority: 0.3, emotion: 0.3 },
  description: 'Brief dockside functionary, one scene.',
  ttsEngine: 'qwen',
});

const BOOK4_CHAPTERS = makeChapters(6);

const harborlight = bookState({
  bookId: 'hollow-tide-4',
  title: 'The Harborlight Ledger',
  author: 'Marin Vale',
  series: 'The Hollow Tide',
  seriesPosition: 4,
  isStandalone: false,
  coverGradient: ['#2B4C57', '#101D22'],
  castConfirmed: true,
  chapters: BOOK4_CHAPTERS,
  cast: [reusedFromBook1(narrator()), reusedFromBook1(inspCray()), undesignedExtra()],
  completedSlugs: [],
});

/* ── Coalfall Commission — Standalone ── */
const COALFALL_CHAPTERS: BookStateResponse['state']['chapters'] = [
  { id: 1, title: 'The Coalfall Commission', slug: '01-title', excluded: true },
  { id: 2, title: 'The Coalfall Commission', slug: '02-credit', excluded: true },
  { id: 3, title: 'Chapter One — The Knock', slug: '03-the-knock', duration: '41:12' },
  { id: 4, title: 'Chapter Two — The Pour', slug: '04-the-pour', duration: '38:44' },
];

/* Real prod cast + manuscript (copied from samples/the-coalfall-commission/
   .audiobook). 14-character canonical cast, all Qwen-designed with emotion
   variants + Kokoro fallbacks. Wren carries the 'Sparrow' alias (Master
   Oduvan's name for her) for the series-memory narrative. */
const coalfallCast: Character[] = (coalfallCastJson.characters as unknown as Character[]).map((c) =>
  c.id === 'wren'
    ? {
        ...c,
        aliases: ['Sparrow'],
        // Custom voice design with emotion variants, for the cast-drawer shot.
        overrideTtsVoices: {
          ...c.overrideTtsVoices,
          qwen: {
            name: c.overrideTtsVoices?.qwen?.name ?? 'qwen-wren',
            variants: {
              whisper: { name: 'qwen-wren__whisper' },
              angry: { name: 'qwen-wren__angry' },
              excited: { name: 'qwen-wren__excited' },
              sad: { name: 'qwen-wren__sad' },
            },
          },
        },
      }
    : c,
);

const coalfallSentences = coalfallManuscriptJson.sentences as unknown as Sentence[];

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

/* ── The Coalfall Commission, Russian edition — fs-1318 Tier D ──
   Ports Chapter One from the real language-detection fixture
   (server/src/__fixtures__/the-coalfall-commission.ru.md) — same story,
   same two leads, translated. Both cast members are fully Qwen-designed
   (non-English books narrate on Qwen — see Voice Engines), so this book
   demonstrates a finished non-English cast, not the undesigned-voice gate
   (that's hollow-tide-4's job). */
const COALFALL_RU_CHAPTERS: BookStateResponse['state']['chapters'] = [
  { id: 1, title: 'Глава первая — Стук', slug: '01-glava-pervaya', duration: '39:20' },
];

const coalfallRuCast: Character[] = [
  {
    id: 'narrator-ru',
    name: 'Рассказчик',
    role: 'Narrator',
    color: '#5B3A29',
    voiceId: 'v_ru_narrator',
    voiceState: 'generated',
    tone: { warmth: 0.6, pace: 0.5, authority: 0.6, emotion: 0.4 },
    description: 'Спокойный голос, ведущий читателя сквозь холодную ночь Коалфолла.',
    ttsEngine: 'qwen',
    overrideTtsVoices: { qwen: { name: 'qwen-narrator-ru' } },
  },
  {
    id: 'ren-ru',
    name: 'Рен',
    role: 'Blacksmith apprentice',
    color: '#264653',
    voiceId: 'v_ru_ren',
    voiceState: 'generated',
    tone: { warmth: 0.55, pace: 0.5, authority: 0.4, emotion: 0.6 },
    description: 'Подмастерье кузнеца, называемая Воробушком.',
    ttsEngine: 'qwen',
    overrideTtsVoices: { qwen: { name: 'qwen-ren-ru' } },
  },
];

const coalfallRu = bookState({
  bookId: 'coalfall-commission-ru',
  title: 'Заказ Коалфолла',
  author: 'Castwright',
  series: 'Standalones',
  seriesPosition: null,
  isStandalone: true,
  coverGradient: ['#3C194F', '#0F0E0D'],
  castConfirmed: true,
  chapters: COALFALL_RU_CHAPTERS,
  cast: coalfallRuCast,
  completedSlugs: COALFALL_RU_CHAPTERS.map((c) => c.slug),
  language: 'ru',
});

/* ── Der Auftrag von Coalfall — German edition — fs-1318 Tier D ──────────────
   Ported from the real German render in the maintainer's library
   (books/Castwright/Standalones/Der Auftrag von Coalfall) — same story, same
   two leads, translated, exactly like the Russian edition above. It replaced
   an invented standalone ("Der Bernsteinturm") that corresponded to no real
   book and therefore had no cover art, so it fell back to the ENGLISH Coalfall
   cover and the library showed the same cover twice. Keep this book a
   translation: the cover art has its German title baked in, so an invented
   title can only ever disagree with it. Both cast members are fully
   Qwen-designed (non-English books narrate on Qwen — see Voice Engines). */
const COALFALL_DE_CHAPTERS: BookStateResponse['state']['chapters'] = [
  { id: 1, title: 'Kapitel Eins — Das Klopfen', slug: '01-kapitel-eins-das-klopfen', duration: '36:05' },
];

const coalfallDeCast: Character[] = [
  {
    id: 'narrator-de',
    name: 'Erzähler',
    role: 'Narrator',
    color: '#3D3D5C',
    voiceId: 'v_de_narrator',
    voiceState: 'generated',
    tone: { warmth: 0.55, pace: 0.5, authority: 0.55, emotion: 0.4 },
    description: 'Ruhige Stimme, die den Leser durch die kalte Nacht von Coalfall führt.',
    ttsEngine: 'qwen',
    overrideTtsVoices: { qwen: { name: 'qwen-narrator-de' } },
  },
  {
    id: 'wren-de',
    name: 'Wren',
    role: 'Blacksmith apprentice',
    color: '#7B5A26',
    voiceId: 'v_de_wren',
    voiceState: 'generated',
    tone: { warmth: 0.55, pace: 0.5, authority: 0.4, emotion: 0.6 },
    /* Mirrors the Russian edition's «называемая Воробушком» — the same
       called-by-another-name beat the coalfall-wren-drawer scene leans on. */
    description: 'Schmiedelehrling, Spatz genannt.',
    ttsEngine: 'qwen',
    overrideTtsVoices: { qwen: { name: 'qwen-wren-de' } },
  },
];

const coalfallDe = bookState({
  bookId: 'coalfall-commission-de',
  title: 'Der Auftrag von Coalfall',
  author: 'Castwright',
  series: 'Standalones',
  seriesPosition: null,
  isStandalone: true,
  coverGradient: ['#4A3728', '#100D09'],
  castConfirmed: true,
  chapters: COALFALL_DE_CHAPTERS,
  cast: coalfallDeCast,
  completedSlugs: COALFALL_DE_CHAPTERS.map((c) => c.slug),
  language: 'de',
});

export const HOLLOW_TIDE_BOOK_STATES = new Map<string, BookStateResponse>([
  ['hollow-tide-1', drowningBell],
  ['hollow-tide-2', saltgrave],
  ['hollow-tide-3', tidewatcher],
  ['hollow-tide-4', harborlight],
  ['coalfall-commission', coalfallCommission],
  ['coalfall-commission-ru', coalfallRu],
  ['coalfall-commission-de', coalfallDe],
]);

/* Distinct voice ids behind a book's voiceCount (voiceId ?? id), mirroring the
   server's per-book `voiceIds`. The library view unions these across books for
   its DISTINCT-voices total — summing voiceCount would count a series-reused
   voice once per book. Without this the marketing library showed "VOICES 0". */
const voiceIdsOf = (b: BookStateResponse): string[] => [
  ...new Set((b.cast?.characters ?? []).map((c) => c.voiceId ?? c.id)),
];

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
              voiceIds: voiceIdsOf(drowningBell),
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
              voiceIds: voiceIdsOf(saltgrave),
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
              voiceIds: [],
              progress: 0.4,
              lastWorkedOn: 'Just now',
              coverGradient: ['#22343F', '#0A1014'],
              coverImageUrl: COVER('hollow-tide-3'),
              coverFraming: TITLE_TOP_FRAME,
              tags: ['series-1'],
            },
            {
              /* fs-1318 Tier D — cast-confirmed, zero chapters rendered:
                 the one marketing book with a genuinely undesigned voice
                 (harbor-clerk), which opens the voice-readiness gate from
                 the Manuscript view's "Approve cast & start generating".
                 voiceCount matches voiceIds.length (3) exactly — voiceIds
                 runs through the shared voiceIdsOf helper, whose
                 `voiceId ?? id` fallback pads in harbor-clerk's own id for
                 the undesigned slot, so voiceCount counts that placeholder
                 too rather than the 2 characters with a real voice. A
                 pre-existing helper quirk, not something this book needs
                 to work around. */
              bookId: 'hollow-tide-4',
              title: 'The Harborlight Ledger',
              author: 'Marin Vale',
              series: 'The Hollow Tide',
              seriesPosition: 4,
              isStandalone: false,
              status: 'cast_pending',
              chapterCount: 6,
              completedChapters: 0,
              characterCount: 3,
              voiceCount: 3,
              voiceIds: voiceIdsOf(harborlight),
              progress: 0,
              lastWorkedOn: 'Just now',
              coverGradient: ['#2B4C57', '#101D22'],
              coverImageUrl: COVER('hollow-tide-4'),
              coverFraming: TITLE_TOP_FRAME,
              tags: ['series-1'],
            },
          ],
          /* Series-memory marketing/wiki screenshots — gates series-memory-chip's
             render (library-grid.tsx:102: `{series.seriesMemory && (<SeriesMemoryChip …>`).
             confirmedBookCount/spanBooks are the "how many books has this cast
             carried across" headline (SeriesMemorySummary — types.ts: "M for
             in-app surfaces … NOT series.books.length"), deliberately decoupled
             from the physical shelf (still 4 real cards: hollow-tide-1..4) —
             kept to 6 (not a bigger number) so the gap against the shelf's own
             "4 books" label (rendered right beside the chip in library-grid.tsx)
             reads as real growth, not a jarring, suspicious-looking mismatch.
             Carried cast = 5 voices: the three `usedIn: 3` recurring ones
             (Narrator, Insp. Cray, Dr. Wren) plus two more real
             HOLLOW_TIDE_VOICES entries (Constance Vale, Magistrate Cross)
             promoted to "carried across the series" for this fixture. Cross
             joins from Book 2 (his real firstBookId in series-memory.ts), so
             book 1's carriedPresent is 4, not 5 — every other book counts all 5.

             perBook MUST have one entry per book in the confirmedBookCount/
             spanBooks span (6), not just the 2 real ones — SeriesSparkline
             (rendered next to SeriesMemoryChip in library-grid.tsx) reads
             perBook.length for its bar count and carriedPresent per bar; the
             ONE other real precedent (Northern Coast Trilogy, library.ts)
             always keeps perBook.length === confirmedBookCount === spanBooks,
             so a shorter perBook under a "6 books" claim would render a
             sparkline contradicting its own "carried across 6 books"
             aria-label right next to the chip's "6 books" — the exact
             self-contradiction a marketing screenshot must not show. Books
             1-2 keep their real principalCount (7/6, mirroring characterCount
             above) and real bookIds; books 3-6 use a distinct
             `hollow-tide-future-N` id (NOT the real `hollow-tide-3`/
             `hollow-tide-4` bookIds, which already exist in HOLLOW_TIDE_LIBRARY
             with their own real, much smaller characterCount — 0 and 3 — that
             would otherwise directly contradict this row's invented
             principalCount the moment someone views the library in table view,
             which always renders the real characterCount per row). */
          seriesMemory: {
            carriedCount: 5,
            bespokeCount: 0,
            designedCount: 0,
            confirmedBookCount: 6,
            spanBooks: 6,
            perBook: [
              { bookId: 'hollow-tide-1', index: 1, principalCount: 7, carriedPresent: 4 },
              { bookId: 'hollow-tide-2', index: 2, principalCount: 6, carriedPresent: 5 },
              { bookId: 'hollow-tide-future-3', index: 3, principalCount: 6, carriedPresent: 5 },
              { bookId: 'hollow-tide-future-4', index: 4, principalCount: 5, carriedPresent: 5 },
              { bookId: 'hollow-tide-future-5', index: 5, principalCount: 7, carriedPresent: 5 },
              { bookId: 'hollow-tide-future-6', index: 6, principalCount: 6, carriedPresent: 5 },
            ],
          },
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
              characterCount: 13,
              voiceCount: 13,
              voiceIds: voiceIdsOf(coalfallCommission),
              progress: 1,
              runtime: '2h 41m',
              lastWorkedOn: 'Last week',
              coverGradient: ['#3C194F', '#0F0E0D'],
              coverImageUrl: COVER('coalfall-commission'),
              coverFraming: TITLE_TOP_FRAME,
              tags: [],
            },
            {
              /* fs-1318 Tier D — non-English library entries for the
                 language-detection + non-English cast-confirmation
                 screenshots. Own localized cover art (translated title
                 baked in), extracted from the real per-language
                 Coalfall Commission renders in the maintainer's workspace —
                 not a reuse of the English cover. */
              bookId: 'coalfall-commission-ru',
              title: 'Заказ Коалфолла',
              author: 'Castwright',
              series: 'Standalones',
              seriesPosition: null,
              isStandalone: true,
              status: 'complete',
              chapterCount: 1,
              completedChapters: 1,
              characterCount: 2,
              voiceCount: 2,
              voiceIds: voiceIdsOf(coalfallRu),
              progress: 1,
              runtime: '39m',
              lastWorkedOn: 'Last week',
              coverGradient: ['#3C194F', '#0F0E0D'],
              coverImageUrl: COVER('coalfall-commission-ru'),
              coverFraming: TITLE_TOP_FRAME,
              tags: [],
              language: 'ru',
            },
            {
              /* Same deal as the Russian edition above — its own localized
                 cover, translated title baked in. */
              bookId: 'coalfall-commission-de',
              title: 'Der Auftrag von Coalfall',
              author: 'Castwright',
              series: 'Standalones',
              seriesPosition: null,
              isStandalone: true,
              status: 'complete',
              chapterCount: 1,
              completedChapters: 1,
              characterCount: 2,
              voiceCount: 2,
              voiceIds: voiceIdsOf(coalfallDe),
              progress: 1,
              runtime: '36m',
              lastWorkedOn: 'Last week',
              coverGradient: ['#4A3728', '#100D09'],
              coverImageUrl: COVER('coalfall-commission-de'),
              coverFraming: TITLE_TOP_FRAME,
              tags: [],
              language: 'de',
            },
          ],
        },
      ],
    },
  ],
};

/* ── Continue-listening shelf fixture (served under VITE_DEMO_CAPTURE=1) ──
   Posed so the front-screen rail finally shows in marketing shots. Array order
   IS the on-screen order (the slice doesn't re-sort); updatedAt is also kept
   descending to match the OpenAPI "most-recently-updated first" contract.

   Only books with generated audio belong here — hollow-tide-3 is still
   analysing, so it's excluded. The 92%-through Drowning Bell as the first card
   tells the "dipped into the next book before finishing the first" story.

   remainingSec renders via formatDuration (MM:SS / HH:MM:SS):
     2040 → "34:00", 6960 → "01:56:00", 19260 → "05:21:00". */
export const HOLLOW_TIDE_CONTINUE: ContinueListeningItem[] = [
  {
    bookId: 'hollow-tide-1',
    title: 'The Drowning Bell',
    chapterId: 11,
    currentSec: 540,
    remainingSec: 2040,
    completionPct: 0.92,
    updatedAt: '2026-06-12T18:30:00.000Z',
  },
  {
    bookId: 'coalfall-commission',
    title: 'The Coalfall Commission',
    chapterId: 3,
    currentSec: 300,
    remainingSec: 6960,
    completionPct: 0.28,
    updatedAt: '2026-06-12T15:10:00.000Z',
  },
  {
    bookId: 'hollow-tide-2',
    title: 'Saltgrave',
    chapterId: 2,
    currentSec: 120,
    remainingSec: 19260,
    completionPct: 0.15,
    updatedAt: '2026-06-11T20:00:00.000Z',
  },
];

/* ── Listen-progress + markers fixture (fs-1318 Tier D, served under
   VITE_DEMO_CAPTURE=1) — powers the markers panel + a re-record marker on
   the Drowning Bell's listen view. */
export const HOLLOW_TIDE_LISTEN_PROGRESS = new Map<string, ListenProgress>([
  [
    'hollow-tide-1',
    {
      chapterId: 1,
      currentSec: 83.5,
      updatedAt: '2026-07-01T10:00:00.000Z',
      markers: [
        {
          id: 'mk-1',
          chapterId: 1,
          sec: 42,
          label: 'Great line reading',
          kind: 'note',
          createdAt: '2026-07-01T09:55:00.000Z',
        },
        {
          id: 'mk-2',
          chapterId: 1,
          sec: 118,
          label: 'Mispronounced name — needs a re-record',
          kind: 'rerecord',
          createdAt: '2026-07-01T09:58:00.000Z',
        },
      ],
    },
  ],
]);

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
      // Stays 1 — voice-library-panel.tsx's reuse badge only reads usedIn
      // when source === 'library' (this entry is 'current'), so bumping it
      // wouldn't render anything anyway. The "carried across the series"
      // story lives entirely in series-memory.ts, which doesn't read this
      // field either (see Magistrate Cross's comment above for the same
      // reasoning).
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
      ttsVoice: qwenTts('Remy v1', 'Designed voice'),
    }),
    withGradient({
      id: 'v_marin_cross',
      character: 'Magistrate Cross',
      bookTitle: 'Saltgrave',
      bookId: 'hollow-tide-2',
      bookSeries: 'The Hollow Tide',
      attributes: ['Male', 'Baritone', 'RP English', '60s', 'Imperious'],
      // Stays 1 — his real per-book cast data only casts him in Saltgrave.
      // The series-memory "carried across the series" story (series-memory.ts)
      // is a separate fixture that doesn't read this field, so bumping it
      // wouldn't feed that narrative anyway; it would only trip
      // voice-library-panel.tsx's `source === 'library' && usedIn > 1`
      // reuse badge on the ordinary Cast/Voice Library screen, showing a
      // misleading "★×2" next to a character who's genuinely in 1 book.
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
      ttsVoice: qwenTts('Sable v1', 'Designed voice'),
    }),
  ],
};

/* Coalfall's own voice library — derived from its real cast so the standalone's
   cast view shows ITS voices, not the Hollow Tide ones. All Qwen-designed. */
export const COALFALL_VOICES: VoiceLibraryResponse = {
  voices: coalfallCast.map((c) =>
    withGradient({
      id: `v_coalfall_${c.id}`,
      character: c.name,
      bookTitle: 'The Coalfall Commission',
      bookId: 'coalfall-commission',
      bookSeries: 'Standalones',
      attributes: c.attributes ?? [],
      usedIn: 1,
      source: 'current',
      ttsVoice: qwenTts(c.overrideTtsVoices?.qwen?.name ?? `qwen-${c.id}`, c.role),
    }),
  ),
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

/* ── Voice-drift fixture for Saltgrave (served under VITE_DEMO_CAPTURE=1) ──
   Quality Gate marketing/wiki screenshots (#1286). Two severities so the
   drift-report modal's severity grouping and Auto-regen control both show.
   Both chapters (2, 5) are within Saltgrave's 7 done chapters (see
   `completedSlugs` above). `autoQueueable` is a SERVER-set field
   (api-types.ts:3454 — "today: severity === 'severe'"), not client-derived,
   so the severe event must set it explicitly or the modal falls back to
   manual Regenerate. `onAutoQueueRegenerate` is already unconditionally
   wired to DriftReportModal in real app code (layout.tsx:1966) — no
   additional wiring needed for the Auto-regen control to render. */
export const HOLLOW_TIDE_DRIFT_EVENTS: DriftEvent[] = [
  {
    id: 'drift:hollow-tide-2:2:insp-cray:register',
    bookId: 'hollow-tide-2',
    characterId: 'insp-cray',
    chapterId: 2,
    chapterTitle: 'Chapter 2',
    severity: 'severe',
    factor: 'register',
    factorLabel: 'Vocabulary register',
    description:
      "Cray's register here reads far more formal than his established " +
      "dogged, plainspoken voice from Book 1 — likely a manuscript edit " +
      'sharpening his dialogue after this chapter rendered.',
    metrics: { current: 70, expected: 35, unit: 'formality' },
    snapshot: {
      voiceId: 'v_marin_cray', gender: 'male', ageRange: 'adult',
      tone: { warmth: 40, pace: 45, authority: 85, emotion: 50 },
      attributes: ['Male', 'Baritone', 'Northern English', '50s', 'Dogged'],
    },
    current: {
      name: 'Insp. Cray', voiceId: 'v_marin_cray', gender: 'male', ageRange: 'adult',
      tone: { warmth: 40, pace: 30, authority: 85, emotion: 30 },
      attributes: ['Male', 'Baritone', 'Northern English', '50s', 'Dogged'],
    },
    detected: '2 hr ago',
    suggestedAction: 'regenerate_chapter',
    autoQueueable: true,
  },
  {
    id: 'drift:hollow-tide-2:5:dr-wren:warmth',
    bookId: 'hollow-tide-2',
    characterId: 'dr-wren',
    chapterId: 5,
    chapterTitle: 'Chapter 5',
    severity: 'moderate',
    factor: 'warmth',
    factorLabel: 'Warmth',
    description:
      "Wren reads cooler here than her established precise-but-humane " +
      'profile — worth a listen before shipping.',
    metrics: { current: 40, expected: 58, unit: 'warmth score' },
    snapshot: {
      voiceId: 'v_marin_wren', gender: 'female', ageRange: 'adult',
      tone: { warmth: 58, pace: 40, authority: 60, emotion: 45 },
      attributes: ['Female', 'Mezzo', 'RP English', '40s', 'Precise'],
    },
    current: {
      name: 'Dr. Wren', voiceId: 'v_marin_wren', gender: 'female', ageRange: 'adult',
      tone: { warmth: 40, pace: 40, authority: 60, emotion: 45 },
      attributes: ['Female', 'Mezzo', 'RP English', '40s', 'Precise'],
    },
    detected: '1 hr ago',
    suggestedAction: 'review',
  },
];
