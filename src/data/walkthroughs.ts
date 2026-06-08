import type { WalkthroughStep } from '../lib/types';

export const WALKTHROUGH_STEPS: Record<string, WalkthroughStep[]> = {
  audiobookshelf: [
    {
      id: 1,
      title: 'Connect to your Audiobookshelf server',
      description: 'Paste the URL of your self-hosted server. We remember it for future exports.',
      illustration: 'server',
      input: {
        type: 'url',
        placeholder: 'https://abs.yourdomain.com',
        value: 'https://abs.dudarenok.io',
      },
      detail: 'Open-format upload — your file, your server.',
    },
    {
      id: 2,
      title: 'Confirm the destination library',
      description:
        "We'll upload to your Audiobooks library and place this title in the Northern Coast Trilogy series.",
      illustration: 'folder',
      detail: 'Audiobooks → Mike Dudarenok → Northern Coast Trilogy → The Northern Star',
    },
    {
      id: 3,
      title: 'Open Audiobookshelf to confirm',
      description:
        'The book appears within seconds across web, iOS, and Android. Chapters and metadata intact.',
      illustration: 'device-grid',
      detail: 'iOS · Android · Web · Apple TV',
    },
    {
      id: 4,
      title: 'All set — happy listening',
      description:
        'Future exports of this book (and the rest of the series) will land here automatically.',
      illustration: 'complete',
    },
  ],
  bookplayer: [
    {
      id: 1,
      title: 'Pick how to send to your iPhone',
      description:
        "AirDrop is fastest if you're on a Mac. Otherwise we'll generate a download link you can open on iOS.",
      illustration: 'airdrop',
      detail: 'AirDrop is the recommended path.',
    },
    {
      id: 2,
      title: 'AirDrop the .m4b file',
      description: 'Click Send and accept on your iPhone. The file lands in Files → Downloads.',
      illustration: 'airdrop-flow',
      detail: 'File: The Northern Star — Full audiobook.m4b · 287 MB',
    },
    {
      id: 3,
      title: 'Tap the file and choose BookPlayer',
      description:
        'iOS shows a Share sheet — select BookPlayer. The book imports with chapters preserved.',
      illustration: 'ios-share-sheet',
    },
    {
      id: 4,
      title: 'Your book is ready in BookPlayer',
      description: 'Sleep timer, speed control, and bookmarks are available immediately.',
      illustration: 'complete',
    },
  ],
  smart_audiobook: [
    {
      id: 1,
      title: 'Scan the QR code on your phone',
      description:
        "Opens the download in your phone's browser — no cable, no email, no cloud account.",
      illustration: 'qr-code',
      detail: "Or send the link via email if QR isn't handy.",
    },
    {
      id: 2,
      title: 'Save to your Audiobooks folder',
      description:
        'Most Android phones default to /Internal storage/AudioBooks. Smart AudioBook Player auto-scans this location.',
      illustration: 'android-files',
      detail: 'Default path: /storage/emulated/0/AudioBooks/',
    },
    {
      id: 3,
      title: 'Refresh the library in the app',
      description:
        'Open Smart AudioBook Player → menu → Add new books. Your title appears with all chapters tagged.',
      illustration: 'app-listing',
    },
    {
      id: 4,
      title: 'Done — pick up where you left off',
      description: '0.5×–4× speed, automatic bookmarking, configurable sleep timer.',
      illustration: 'complete',
    },
  ],
  apple_books: [
    {
      id: 1,
      title: 'Choose your starting device',
      description:
        "Once Books has it, position syncs across iPhone, iPad, and Mac via iCloud. Pick whichever's nearest.",
      illustration: 'device-grid',
      detail: 'iCloud sync handles the rest.',
    },
    {
      id: 2,
      title: 'Send to your device',
      description:
        'On a Mac: drag the .m4b onto the Books app icon. On iOS: download the file and tap Share → Books.',
      illustration: 'ios-share-sheet',
      detail: 'Both paths land the book in your Books library.',
    },
    {
      id: 3,
      title: 'Find it under Audiobooks',
      description: 'Books → Audiobooks tab → your title appears with the cover. Tap to start.',
      illustration: 'app-listing',
    },
    {
      id: 4,
      title: 'All set across devices',
      description:
        'Position, bookmarks, and notes will sync between every Apple device signed into the same iCloud account.',
      illustration: 'complete',
    },
  ],
};
