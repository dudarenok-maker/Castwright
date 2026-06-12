/// The marketing capture scene registry — one entry per screenshot, mirroring
/// the web harness's `e2e/marketing/scenes.ts`. Adding a scene = one entry here.
enum SceneNav { library, player, settings, pairing }

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
  Scene('settings', SceneNav.settings),
  Scene('library-offline', SceneNav.library, offline: true),
  Scene('pairing', SceneNav.pairing),
];
