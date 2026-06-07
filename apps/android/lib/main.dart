import 'package:audio_service/audio_service.dart';
import 'package:flutter/material.dart';

import 'src/data/companion_audio_handler.dart';
import 'src/data/companion_runtime.dart';
import 'src/data/pairing_service.dart';
import 'src/data/pairing_store.dart';
import 'src/domain/paired_server.dart';
import 'src/ui/library_home_screen.dart';
import 'src/ui/pairing_screen.dart';

/// Audiobook Companion — the native listening client (plan 188). app-1 shell +
/// app-2 pairing + the app-3..14 library / sync / player wired on top, with
/// OFFLINE launch (the runtime is rebuilt from the stored cert — no network
/// needed to open the downloaded library).
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
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
      {super.key, required this.store, this.service, this.audioHandler});

  final PairingStore store;

  /// Injectable so widget tests can drive pairing without real network/TLS.
  final PairingService? service;

  /// The media-session handler (null in widget tests).
  final CompanionAudioHandler? audioHandler;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Audiobook Companion',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF8A2BE2)),
        useMaterial3: true,
      ),
      home: HomePage(
          store: store,
          service: service ?? PairingService(),
          audioHandler: audioHandler),
    );
  }
}

class HomePage extends StatefulWidget {
  const HomePage(
      {super.key,
      required this.store,
      required this.service,
      this.audioHandler});

  final PairingStore store;
  final PairingService service;
  final CompanionAudioHandler? audioHandler;

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

  @override
  void initState() {
    super.initState();
    _boot();
  }

  Future<void> _boot() async {
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
  /// pairing, then build the runtime.
  Future<void> _bootstrapFromServer() async {
    setState(() {
      _loading = true;
      _bootstrapError = null;
    });
    try {
      final conn = await widget.service.pair(_paired!);
      await widget.store.saveCaPem(conn.caPem);
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

  Future<void> _openPairing() async {
    final result = await Navigator.of(context).push<PairedServer>(
      MaterialPageRoute(
        builder: (_) => PairingScreen(service: widget.service, store: widget.store),
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
        appBar: AppBar(title: const Text('Audiobook Companion')),
        body: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text('Not paired yet', key: Key('home-status')),
              const SizedBox(height: 16),
              FilledButton(
                  onPressed: _openPairing, child: const Text('Pair a device')),
            ],
          ),
        ),
      );
    }
    if (_runtime == null) {
      // Legacy pairing, currently offline → can't open until we capture the cert.
      return Scaffold(
        appBar: AppBar(title: const Text('Audiobook Companion')),
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
