export const TOUR_SCREENS = ['library', 'manuscript', 'cast', 'generate', 'listen'] as const;
export type TourScreen = (typeof TOUR_SCREENS)[number];

export type TourStep = {
  id: string;
  screen: TourScreen;
  anchor: string | null; // data-tour-id; null = centered bubble
  title: string;
  body: string;
  placement?: 'auto' | 'top' | 'bottom' | 'left' | 'right';
  kind: 'real' | 'explain';
  opensDrawer?: boolean;
};

/* Sample-data ids — CONFIRM against the real bundled sample (cast.json /
   manuscript) at implementation. In mock mode these match the canned sample. */
export const SAMPLE = {
  slug: 'the-coalfall-commission',
  bookId: 'castwright__standalones__the-coalfall-commission',
  drawerCharacterId: 'wren', // the character whose drawer s7 opens
} as const;

export const TOUR_STEPS: ReadonlyArray<TourStep> = [
  // 1 · Library
  { id: 's1-welcome', screen: 'library', anchor: null, kind: 'real',
    title: 'Welcome to Castwright',
    body: "Turn any book into a full-cast performance. We've loaded a sample — The Coalfall Commission — to show you how." },
  { id: 's2-card', screen: 'library', anchor: 'book-card', kind: 'real',
    title: 'Your library',
    body: 'Every book lives here. Open the sample to look inside.' },
  { id: 's3-newbook', screen: 'library', anchor: 'new-book-btn', kind: 'explain',
    title: 'Add your own book',
    body: 'Later, click New book and drop a manuscript — Castwright reads it and finds the cast (a few minutes). The sample is already read.' },
  // 2 · Manuscript
  { id: 's4-line', screen: 'manuscript', anchor: 'manuscript-line', kind: 'real',
    title: 'Who says each line',
    body: 'The whole book, line by line, colour-coded by speaker. Tap a line to reassign the speaker, or set a quote\'s emotion.' },
  { id: 's5-boundary', screen: 'manuscript', anchor: 'chapter-boundary', kind: 'real',
    title: 'Chapters & paragraphs',
    body: 'Adjust where chapters begin and end, and merge or split paragraphs — drag the boundary handle (touch works too).' },
  // 3 · Cast & voices
  { id: 's6-roster', screen: 'cast', anchor: 'cast-roster', kind: 'real',
    title: 'Meet the cast',
    body: 'Narrator, Master Oduvan, Wren, Maerin… Merge duplicates and link characters from earlier books in a series.' },
  { id: 's7-drawer', screen: 'cast', anchor: 'profile-drawer', kind: 'real', opensDrawer: true,
    title: 'Give a character a voice',
    body: 'Open a character to read their profile and lines, design a voice from a description, preview it, and add emotion variants. This is where a character gets their sound.' },
  { id: 's8-fullcast', screen: 'cast', anchor: null, kind: 'explain',
    title: 'Design the whole cast',
    body: 'When you start a fresh book, Design full cast voices the whole roster in one pass.' },
  // 4 · Generate
  { id: 's9-generate', screen: 'generate', anchor: 'generate-resume-btn', kind: 'explain',
    title: 'Render the book',
    body: "Generation renders every chapter in the right voices — it keeps going without you. Chapter 1's done; Resume generation finishes the rest." },
  // 5 · Listen, pair & export
  { id: 's10-play', screen: 'listen', anchor: 'chapter-1-play', kind: 'real',
    title: 'Press play',
    body: 'Here\'s the finished chapter 1 — the full cast, on Qwen voices. Press play. (The other chapters render once you generate them.)' },
  { id: 's11-companion', screen: 'listen', anchor: 'companion-app-banner', kind: 'real',
    title: 'Listen on your phone',
    body: 'Pair the Castwright Companion app with a quick QR scan and your library follows you to your phone.' },
  { id: 's12-export', screen: 'listen', anchor: 'download-tile-m4b', kind: 'real',
    title: 'Or any player',
    body: 'Prefer your own app? Export the audiobook (M4B here) and drop it into any player. Nothing locks you in.' },
  { id: 's13-finish', screen: 'listen', anchor: null, kind: 'real',
    title: "That's the whole journey",
    body: 'Add your own book whenever you\'re ready.' },
];

export function stepsForScreen(screen: TourScreen): TourStep[] {
  return TOUR_STEPS.filter((s) => s.screen === screen);
}
