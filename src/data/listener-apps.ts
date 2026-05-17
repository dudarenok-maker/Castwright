import type { ListenerApp } from '../lib/types';

export const SUPPORTED_APPS: ListenerApp[] = [
  {
    /* Fifth live integration target — Audiobookshelf (self-hosted server).
       Scans a configured library root and treats each subfolder as one
       book; iOS / Android / web clients stream from it. Defaults to
       mp3-folder + sync-folder so the chapters mirror into the
       Audiobookshelf scan root, then appear after the server's next
       library rescan. */
    id: 'audiobookshelf',
    name: 'Audiobookshelf',
    glyph: 'AB',
    gradient: ['#6E5BD2', '#3C194F'],
    platforms: ['iOS', 'Android', 'Web', 'Self-host'],
    tagline: 'Open-source library — your books, your server.',
    description:
      'Self-hosted; folder-per-book library, chapter support, cross-device sync. Drops per-chapter MP3s into your library root; Audiobookshelf picks them up on the next scan.',
    sendVerb: 'Send to Audiobookshelf library',
  },
  {
    /* Fourth live integration target — BookPlayer (iOS). Imports a folder
       per book via the Files app or AirDrop from a Mac. Defaults to
       mp3-folder + sync-folder so the chapters land in a sync directory
       on the Mac that the user can then AirDrop. */
    id: 'bookplayer',
    name: 'BookPlayer',
    glyph: 'BP',
    gradient: ['#F79A83', '#A43C6C'],
    platforms: ['iOS'],
    tagline: 'Lightweight iOS player.',
    description:
      'Folder-per-book via iOS Files or AirDrop from a Mac. Per-chapter MP3s arrive tagged with title, author, and cover art ready to import.',
    sendVerb: 'Send to BookPlayer',
  },
  {
    /* Third live integration target — Smart AudioBook Player. Android-only,
       free + ad-supported. Reads a folder per book from a configurable
       books directory; 0.5x to 4x speed control, automatic bookmarking,
       sleep timer. Defaults to mp3-folder + sync-folder so the per-
       chapter MP3s land directly in the SABP books folder via Syncthing. */
    id: 'smart_audiobook',
    name: 'Smart AudioBook Player',
    glyph: 'SA',
    gradient: ['#7C5C8C', '#3C194F'],
    platforms: ['Android'],
    tagline: 'The Android default for sideloads.',
    description:
      'Folder-per-book library, 0.5x–4x speed, auto-bookmark, sleep timer. Drops per-chapter MP3s into your sync folder; SABP picks them up on the next scan.',
    sendVerb: 'Send to Smart AudioBook Player',
  },
  {
    id: 'apple_books',
    name: 'Apple Books',
    glyph: 'AP',
    gradient: ['#0F0E0D', '#3C194F'],
    platforms: ['iOS', 'macOS'],
    tagline: 'Native Apple library.',
    description:
      'Drop the M4B into Books — position syncs across iPhone, iPad, and Mac via iCloud.',
    sendVerb: 'Add to Books',
  },
  {
    id: 'plex',
    name: 'Plex',
    glyph: 'PL',
    gradient: ['#D4A04E', '#7B5A26'],
    platforms: ['iOS', 'Android', 'Web'],
    tagline: 'Stream from your media server.',
    description:
      'Embedded chapters display correctly. Stream to any device on your network or beyond.',
    sendVerb: 'Send to library',
  },
  {
    /* First-class integration target — daily-driver reader on the user's
       Android device. Ships ahead of others when real handoff lands. */
    id: 'pocketbook',
    name: 'PocketBook',
    glyph: 'PB',
    gradient: ['#2C7A4B', '#0F3A23'],
    platforms: ['Android', 'iOS', 'E-Ink'],
    tagline: 'E-reader maker’s own audiobook app.',
    description:
      'Side-load M4B into the PocketBook Reader app — works on PocketBook e-readers with audio support and on the phone apps. Chapter markers and cover art are honoured.',
    sendVerb: 'Send to PocketBook',
  },
  {
    /* Second live integration target — Voice (formerly Material Audiobook
       Player). GPLv3, F-Droid + Play Store, Android-only. Folder-scan
       library, per-book resume + custom bookmarks (Voice-side database
       keyed by file path), Android Auto. Defaults to M4B + sync-folder so
       the file lands directly in the Voice library folder via Syncthing. */
    id: 'voice',
    name: 'Voice',
    glyph: 'VO',
    gradient: ['#3C5BA9', '#1B2A52'],
    platforms: ['Android'],
    tagline: 'Open-source Android audiobook player.',
    description:
      'GPLv3, F-Droid + Play Store. Folder-based library, per-book resume, custom bookmarks, Android Auto. Drops a chaptered M4B into your sync folder; Voice picks it up on the next scan.',
    sendVerb: 'Send to Voice',
  },
];
