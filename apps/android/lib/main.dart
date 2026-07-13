import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:app_links/app_links.dart';
import 'package:audio_service/audio_service.dart';
import 'package:audio_session/audio_session.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show rootBundle;
import 'package:path_provider/path_provider.dart';

import 'src/data/cert_pinning.dart';
import 'src/data/companion_audio_handler.dart';
import 'src/data/companion_runtime.dart';
import 'src/data/file_store.dart';
import 'src/data/pairing_service.dart';
import 'src/data/pairing_store.dart';
import 'src/demo/demo_runtime.dart';
import 'src/demo/demo_ticking_audio_engine.dart';
import 'src/domain/paired_server.dart';
import 'src/domain/pairing_qr.dart';
import 'src/ui/library_home_screen.dart';
import 'src/ui/pairing_screen.dart';

/// Default demo root — app-private, deleted on exit. Overridden in host tests.
Future<String> _defaultDemoRoot() async =>
    '${(await getApplicationDocumentsDirectory()).path}/demo-runtime';

/// Default cover-asset loader — reads a bundled PNG. Overridden in host tests.
Future<List<int>> _defaultDemoAsset(String key) async =>
    (await rootBundle.load(key)).buffer.asUint8List();

/// Castwright — the native listening client (plan 188). app-1 shell +
/// app-2 pairing + the app-3..14 library / sync / player wired on top, with
/// OFFLINE launch (the runtime is rebuilt from the stored cert — no network
/// needed to open the downloaded library).
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // app-5: configure the OS audio session BEFORE any playback so just_audio
  // actually requests/holds audio focus and auto-pauses on interruptions and
  // route changes (headset unplug / Bluetooth / Android Auto disconnect emit
  // becomingNoisy). Without this, focus loss silently stalls audio while the
  // engine still reports `playing == true` — the lock-screen/headset buttons
  // then act on a desynced state and a single press appears dead. `.speech()`
  // is the audiobook-appropriate preset (matches the audio_service example).
  final session = await AudioSession.instance;
  await session.configure(const AudioSessionConfiguration.speech());
  // app-5/app-9: the media session must exist before the UI (lock-screen /
  // Bluetooth / Android Auto). The runtime attaches the live player once paired.
  final handler = await AudioService.init(
    builder: () => CompanionAudioHandler(),
    config: companionAudioServiceConfig,
  );
  runApp(AudiobookCompanionApp(store: SecurePairingStore(), audioHandler: handler));
}

class AudiobookCompanionApp extends StatelessWidget {
  const AudiobookCompanionApp(
      {super.key,
      required this.store,
      this.service,
      this.audioHandler,
      this.deepLinks,
      this.runtimeOverride,
      this.themeMode = ThemeMode.system,
      this.demoRootResolver,
      this.demoFileStore,
      this.demoAssetLoader});

  final PairingStore store;

  /// Injectable so widget tests can drive pairing without real network/TLS.
  final PairingService? service;

  /// The media-session handler (null in widget tests).
  final CompanionAudioHandler? audioHandler;

  /// Injectable deep-link stream (null in production — uses App Links platform channel).
  final Stream<Uri>? deepLinks;

  /// Injectable pre-built runtime — used by the marketing capture + widget tests
  /// to skip pairing/connection and render posed screens. Null in production.
  final CompanionRuntime? runtimeOverride;

  /// Light/dark selection. Defaults to following the system; the capture harness
  /// forces a value per pass.
  final ThemeMode themeMode;

  final Future<String> Function()? demoRootResolver;
  final FileStore? demoFileStore;
  final Future<List<int>> Function(String)? demoAssetLoader;

  @override
  Widget build(BuildContext context) {
    const seed = Color(0xFFA43C6C);
    return MaterialApp(
      title: 'Castwright',
      debugShowCheckedModeBanner: false,
      themeMode: themeMode,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: seed),
        useMaterial3: true,
      ),
      darkTheme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: seed, brightness: Brightness.dark),
        useMaterial3: true,
      ),
      home: HomePage(
          store: store,
          service: service ?? PairingService(),
          audioHandler: audioHandler,
          deepLinks: deepLinks,
          runtimeOverride: runtimeOverride,
          demoRootResolver: demoRootResolver,
          demoFileStore: demoFileStore,
          demoAssetLoader: demoAssetLoader),
    );
  }
}

class HomePage extends StatefulWidget {
  const HomePage(
      {super.key,
      required this.store,
      required this.service,
      this.audioHandler,
      this.deepLinks,
      this.runtimeOverride,
      this.demoRootResolver,
      this.demoFileStore,
      this.demoAssetLoader});

  final PairingStore store;
  final PairingService service;
  final CompanionAudioHandler? audioHandler;

  /// Injectable deep-link stream (null in production — uses App Links platform channel).
  final Stream<Uri>? deepLinks;

  /// Injectable pre-built runtime (capture/tests). Null in production.
  final CompanionRuntime? runtimeOverride;

  final Future<String> Function()? demoRootResolver;
  final FileStore? demoFileStore;
  final Future<List<int>> Function(String)? demoAssetLoader;

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  PairedServer? _paired;
  CompanionRuntime? _runtime;
  bool _loading = true;

  /// Legacy pairing with no stored cert — needs one online reconnect to
  /// capture it before offline mode works.
  String? _bootstrapError;

  bool _pairingOpen = false;

  bool _demoMode = false;
  String? _demoRoot;

  static const _demoServer = PairedServer(
      url: 'https://demo.castwright.local',
      token: 'demo',
      caFingerprint: 'demo',
      pairedAt: null);

  StreamSubscription<Uri>? _deepLinkSub;

  /// Cold-start initial link first, then the live warm stream. Injected in tests.
  Stream<Uri> _platformDeepLinks() async* {
    final appLinks = AppLinks();
    final initial = await appLinks.getInitialLink();
    if (initial != null) yield initial;
    yield* appLinks.uriLinkStream;
  }

  void _listenDeepLinks() {
    final stream = widget.deepLinks ?? _platformDeepLinks();
    _deepLinkSub = stream.listen(_handleDeepLink, onError: (_) {});
  }

  Uri? _lastHandledLink;

  void _handleDeepLink(Uri uri) {
    // uriLinkStream can also surface the cold-start link getInitialLink already
    // yielded — de-dupe so we never stack two pairing screens for one launch URI.
    if (uri == _lastHandledLink) return;
    final PairingQr qr;
    try {
      qr = PairingQr.parse(uri.toString());
    } on FormatException {
      return; // not a pairing link — ignore
    }
    _lastHandledLink = uri;
    _openPairing(initialQr: qr);
  }

  @override
  void initState() {
    super.initState();
    _boot();
    _listenDeepLinks();
  }

  @override
  void dispose() {
    _deepLinkSub?.cancel();
    super.dispose();
  }

  Future<void> _boot() async {
    if (widget.runtimeOverride != null) {
      _paired = await widget.store.load();
      if (!mounted) return;
      setState(() {
        _runtime = widget.runtimeOverride;
        _loading = false;
      });
      return;
    }
    final server = await widget.store.load();
    if (!mounted) return;
    if (server == null) {
      setState(() => _loading = false);
      return;
    }
    _paired = server;
    final caPem = await widget.store.loadCaPem();
    if (caPem == null || caPem.isEmpty) {
      // Pre-offline pairing: must reconnect once to capture the cert.
      await _bootstrapFromServer();
      return;
    }
    // Offline-capable: rebuild the pinned runtime from stored creds, no network.
    try {
      final runtime = await CompanionRuntime.forConnection(
          Connection(server: server, caPem: caPem),
          handler: widget.audioHandler,
          onRepairNeeded: () => _openPairing());
      if (mounted) {
        setState(() {
          _runtime = runtime;
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _bootstrapError = '$e';
          _loading = false;
        });
      }
    }
  }

  /// One online round-trip to fetch + verify + persist the cert for a legacy
  /// pairing (predates offline cert storage), then build the runtime.
  Future<void> _bootstrapFromServer() async {
    setState(() {
      _loading = true;
      _bootstrapError = null;
    });
    try {
      final server = _paired!;
      // Fetch the CA cert over a one-shot, validation-bypassing client and
      // verify it matches the stored full SHA-256 fingerprint.
      final client = HttpClient()..badCertificateCallback = (cert, host, port) => true;
      final String caPem;
      try {
        final req = await client.getUrl(Uri.parse('${server.url}/cert/root.crt'));
        final res = await req.close();
        caPem = await res.transform(const Utf8Decoder()).join();
      } finally {
        client.close(force: true);
      }
      if (!verifyCaFingerprint(caPem, server.caFingerprint)) {
        throw Exception('Certificate fingerprint mismatch — re-pair the device.');
      }
      await widget.store.saveCaPem(caPem);
      final conn = Connection(server: server, caPem: caPem);
      final runtime = await CompanionRuntime.forConnection(conn,
          handler: widget.audioHandler, onRepairNeeded: () => _openPairing());
      if (mounted) {
        setState(() {
          _runtime = runtime;
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _bootstrapError = '$e';
          _loading = false;
        });
      }
    }
  }

  Future<void> _openPairing({PairingQr? initialQr}) async {
    if (_pairingOpen) return;
    _pairingOpen = true;
    try {
      final result = await Navigator.of(context).push<PairedServer>(
        MaterialPageRoute(
          builder: (_) => PairingScreen(
              service: widget.service, store: widget.store, initialQr: initialQr),
        ),
      );
      if (result != null && mounted) {
        _paired = result;
        await _boot();
      }
    } finally {
      _pairingOpen = false;
    }
  }

  Future<void> _unpair() async {
    await _runtime?.dispose();
    await widget.store.clear();
    if (mounted) {
      setState(() {
        _runtime = null;
        _paired = null;
        _bootstrapError = null;
      });
    }
  }

  Future<void> _startDemo() async {
    if (_loading) return; // guard against a double-tap orphaning a runtime
    setState(() => _loading = true);
    final root = await (widget.demoRootResolver ?? _defaultDemoRoot)();
    final fs = widget.demoFileStore ?? const DiskFileStore();
    final loadAsset = widget.demoAssetLoader ?? _defaultDemoAsset;
    const coverIds = [
      'hollow-tide-1',
      'hollow-tide-2',
      'hollow-tide-3',
      'coalfall-commission',
    ];
    final coversDir = '$root/covers';
    for (final id in coverIds) {
      try {
        final bytes = await loadAsset('assets/demo-covers/$id.png');
        await fs.writeBytes('$coversDir/$id.png', bytes);
      } catch (_) {
        // A cover is polish; a missing one degrades to the placeholder tile.
      }
    }
    final runtime = await buildDemoRuntime(
      fs: fs,
      coversDir: coversDir,
      root: root,
      offline: false,
      engine: DemoTickingAudioEngine(),
    );
    if (!mounted) return;
    setState(() {
      _demoMode = true;
      _demoRoot = root;
      _paired = _demoServer;
      _runtime = runtime;
      _loading = false;
    });
  }

  Future<void> _exitDemo() async {
    final rt = _runtime;
    final root = _demoRoot;
    final fs = widget.demoFileStore ?? const DiskFileStore();
    if (mounted) {
      setState(() {
        _demoMode = false;
        _demoRoot = null;
        _runtime = null;
        _paired = null;
      });
    }
    await rt?.dispose();
    if (root != null) {
      try {
        await fs.deleteDir(root);
      } catch (_) {}
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    if (_paired == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('Castwright')),
        body: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text('Not paired yet', key: Key('home-status')),
              const SizedBox(height: 16),
              FilledButton(
                  onPressed: () => _openPairing(), child: const Text('Pair a device')),
              const SizedBox(height: 12),
              OutlinedButton(
                  key: const Key('try-demo'),
                  onPressed: _startDemo,
                  child: const Text('Try the demo')),
            ],
          ),
        ),
      );
    }
    if (_runtime == null) {
      // Legacy pairing, currently offline → can't open until we capture the cert.
      return Scaffold(
        appBar: AppBar(title: const Text('Castwright')),
        body: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text('Paired with ${_paired!.url}', key: const Key('home-status')),
              const Padding(
                padding: EdgeInsets.all(16),
                child: Text(
                  'Connect to the server once to enable offline playback.',
                  textAlign: TextAlign.center,
                ),
              ),
              if (_bootstrapError != null)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 24),
                  child: Text(_bootstrapError!,
                      textAlign: TextAlign.center,
                      style:
                          TextStyle(color: Theme.of(context).colorScheme.error)),
                ),
              const SizedBox(height: 12),
              Wrap(spacing: 12, children: [
                FilledButton(
                    onPressed: _bootstrapFromServer, child: const Text('Connect')),
                OutlinedButton(onPressed: _unpair, child: const Text('Unpair')),
              ]),
            ],
          ),
        ),
      );
    }
    return LifecycleResumePusher(
      runtime: _runtime!,
      child: LibraryHomeScreen(
        runtime: _runtime!,
        server: _paired!,
        onUnpair: _demoMode ? _exitDemo : _unpair,
        demoMode: _demoMode,
      ),
    );
  }
}

/// Flushes resume on app pause (app-21). In two-pane there is no per-book
/// `PlayerPane.dispose` to push the server sync (the pane stays resident
/// across selections) — this is the app-lifecycle equivalent, covering
/// backgrounding regardless of layout. Best-effort + idempotent: overlaps
/// `activateBook`'s save→push→switch handoff and `AutoSyncService`'s
/// connectivity-triggered flush, but `srv-34`'s guarded compare-and-set
/// tolerates the redundant PUT.
class LifecycleResumePusher extends StatefulWidget {
  const LifecycleResumePusher({super.key, required this.runtime, required this.child});

  /// `CompanionRuntime` in production; a duck-typed spy in tests (only
  /// `player.{currentBookId,saveNow}` and `resumeSync.syncBook` are used).
  final dynamic runtime;
  final Widget child;

  @override
  State<LifecycleResumePusher> createState() => _LifecycleResumePusherState();
}

class _LifecycleResumePusherState extends State<LifecycleResumePusher>
    with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Future<void> didChangeAppLifecycleState(AppLifecycleState state) async {
    if (state != AppLifecycleState.paused) return;
    await widget.runtime.player.saveNow();
    final id = widget.runtime.player.currentBookId;
    if (id != null) {
      try {
        await widget.runtime.resumeSync.syncBook(id);
      } catch (_) {/* offline / no server record */}
    }
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
