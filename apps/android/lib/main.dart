import 'package:flutter/material.dart';

import 'src/data/pairing_service.dart';
import 'src/data/pairing_store.dart';
import 'src/domain/paired_server.dart';
import 'src/ui/pairing_screen.dart';

/// Audiobook Companion — the native listening client (plan 188). app-1 shell +
/// app-2 pairing; the library and the player land on top.
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
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    widget.store.load().then((p) {
      if (mounted) {
        setState(() {
          _paired = p;
          _loading = false;
        });
      }
    });
  }

  Future<void> _openPairing() async {
    final result = await Navigator.of(context).push<PairedServer>(
      MaterialPageRoute(
        builder: (_) => PairingScreen(service: widget.service, store: widget.store),
      ),
    );
    if (result != null && mounted) setState(() => _paired = result);
  }

  Future<void> _unpair() async {
    await widget.store.clear();
    if (mounted) setState(() => _paired = null);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Audiobook Companion')),
      body: Center(child: _body()),
    );
  }

  Widget _body() {
    if (_loading) return const CircularProgressIndicator();
    if (_paired == null) {
      return Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Text('Not paired yet', key: Key('home-status')),
          const SizedBox(height: 16),
          FilledButton(onPressed: _openPairing, child: const Text('Pair a device')),
        ],
      );
    }
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text('Paired with ${_paired!.url}', key: const Key('home-status')),
        const SizedBox(height: 16),
        OutlinedButton(onPressed: _unpair, child: const Text('Unpair')),
      ],
    );
  }
}
