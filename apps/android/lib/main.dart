import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:app_links/app_links.dart';
import 'package:audio_service/audio_service.dart';
import 'package:flutter/material.dart';

import 'src/data/cert_pinning.dart';
import 'src/data/companion_audio_handler.dart';
import 'src/data/companion_runtime.dart';
import 'src/data/pairing_service.dart';
import 'src/data/pairing_store.dart';
import 'src/domain/paired_server.dart';
import 'src/domain/pairing_qr.dart';
import 'src/ui/library_home_screen.dart';
import 'src/ui/pairing_screen.dart';

/// Castwright — the native listening client (plan 188). app-1 shell +
/// app-2 pairing + the app-3..14 library / sync / player wired on top, with
/// OFFLINE launch (the runtime is rebuilt from the stored cert — no network
/// needed to open the downloaded library).
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // app-5/app-9: the media session must exist before the UI (lock-screen /
  // Bluetooth / Android Auto). The runtime attaches the live player once paired.
  final handler = await AudioService.init(
    builder: () => CompanionAudioHandler(
      notifyChildrenChanged: AudioService.notifyChildrenChanged,
    ),
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
      this.themeMode = ThemeMode.system});

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
          runtimeOverride: runtimeOverride),
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
      this.runtimeOverride});

  final PairingStore store;
  final PairingService service;
  final CompanionAudioHandler? audioHandler;

  /// Injectable deep-link stream (null in production — uses App Links platform channel).
  final Stream<Uri>? deepLinks;

  /// Injectable pre-built runtime (capture/tests). Null in production.
  final CompanionRuntime? runtimeOverride;

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
          handler: widget.audioHandler);
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
      final runtime =
          await CompanionRuntime.forConnection(conn, handler: widget.audioHandler);
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
    return LibraryHomeScreen(
      runtime: _runtime!,
      server: _paired!,
      onUnpair: _unpair,
    );
  }
}
