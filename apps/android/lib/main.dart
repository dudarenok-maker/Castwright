import 'package:flutter/material.dart';

import 'src/data/companion_runtime.dart';
import 'src/data/pairing_service.dart';
import 'src/data/pairing_store.dart';
import 'src/domain/paired_server.dart';
import 'src/ui/library_home_screen.dart';
import 'src/ui/pairing_screen.dart';

/// Audiobook Companion — the native listening client (plan 188). app-1 shell +
/// app-2 pairing + the app-3..14 library / sync / player wired on top.
void main() {
  runApp(AudiobookCompanionApp(store: SecurePairingStore()));
}

class AudiobookCompanionApp extends StatelessWidget {
  const AudiobookCompanionApp({super.key, required this.store, this.service});

  final PairingStore store;

  /// Injectable so widget tests can drive pairing without real network/TLS.
  final PairingService? service;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Audiobook Companion',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF8A2BE2)),
        useMaterial3: true,
      ),
      home: HomePage(store: store, service: service ?? PairingService()),
    );
  }
}

class HomePage extends StatefulWidget {
  const HomePage({super.key, required this.store, required this.service});

  final PairingStore store;
  final PairingService service;

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  PairedServer? _paired;
  CompanionRuntime? _runtime;
  bool _loading = true;
  String? _connError;

  @override
  void initState() {
    super.initState();
    widget.store.load().then((p) async {
      if (!mounted) return;
      if (p == null) {
        setState(() => _loading = false);
        return;
      }
      _paired = p;
      await _establish();
    });
  }

  /// Re-establish the cert-pinned connection from stored credentials (re-fetch
  /// + verify the CA, re-probe the token), then build the wired runtime.
  Future<void> _establish() async {
    setState(() {
      _loading = true;
      _connError = null;
    });
    try {
      final conn = await widget.service.pair(_paired!);
      final runtime = await CompanionRuntime.forConnection(conn);
      if (mounted) {
        setState(() {
          _runtime = runtime;
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _connError = '$e';
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
      await _establish();
    }
  }

  Future<void> _unpair() async {
    await _runtime?.dispose();
    await widget.store.clear();
    if (mounted) {
      setState(() {
        _runtime = null;
        _paired = null;
        _connError = null;
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
      return Scaffold(
        appBar: AppBar(title: const Text('Audiobook Companion')),
        body: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text('Paired with ${_paired!.url}', key: const Key('home-status')),
              const SizedBox(height: 8),
              if (_connError != null)
                Padding(
                  padding: const EdgeInsets.all(16),
                  child: Text("Couldn't reach the server:\n$_connError",
                      textAlign: TextAlign.center),
                ),
              Wrap(spacing: 12, children: [
                FilledButton(onPressed: _establish, child: const Text('Retry')),
                OutlinedButton(onPressed: _unpair, child: const Text('Unpair')),
              ]),
            ],
          ),
        ),
      );
    }
    return LibraryHomeScreen(
      runtime: _runtime!,
      serverLabel: _paired!.url,
      onUnpair: _unpair,
    );
  }
}
