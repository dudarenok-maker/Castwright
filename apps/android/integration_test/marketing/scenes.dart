/// The marketing capture scene registry — one entry per screenshot, mirroring
/// the web harness's `e2e/marketing/scenes.ts`. Adding a scene = one entry here.
///
/// Every scene drives the REAL wired surface through the demo runtime so cover
/// art, download states, progress and the waveform all render (posed-pump
/// screens can't load covers). `library-home` is the wired post-pairing home
/// (`LibraryHomeScreen`) — it already folds the "Continue listening" rail in at
/// the top, so it doubles as the Continue/hero shot; `pairing` is the one
/// exception that pumps its screen directly (no runtime needed for the QR form).
enum SceneNav { library, bookDetail, player, settings, pairing }

class Scene {
  const Scene(this.id, this.nav, {this.offline = false});

  /// Output stem: `<id>.<theme>.png`. Unique.
  final String id;
  final SceneNav nav;

  /// When true, the demo runtime is built offline (manifest 503 → offline chip).
  final bool offline;
}

const marketingScenes = <Scene>[
  Scene('library-home', SceneNav.library),
  Scene('player', SceneNav.player),
  Scene('book-detail', SceneNav.bookDetail),
  Scene('library-offline', SceneNav.library, offline: true),
  Scene('settings', SceneNav.settings),
  Scene('pairing', SceneNav.pairing),
];
