import 'package:flutter/material.dart';

import '../data/pairing_service.dart';
import '../data/pairing_store.dart';
import '../domain/paired_server.dart';
import 'qr_scan_screen.dart';

/// Manual pairing form (app-2). Enter the server URL + token + CA fingerprint
/// from the desktop pairing screen; on success the verified connection is
/// persisted and returned. QR scanning is a follow-up (a camera is impractical
/// on an emulator), but this exercises the full verify → pin → probe flow.
class PairingScreen extends StatefulWidget {
  const PairingScreen({super.key, required this.service, required this.store});

  final PairingService service;
  final PairingStore store;

  @override
  State<PairingScreen> createState() => _PairingScreenState();
}

class _PairingScreenState extends State<PairingScreen> {
  final _url = TextEditingController();
  final _token = TextEditingController();
  final _fingerprint = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _url.dispose();
    _token.dispose();
    _fingerprint.dispose();
    super.dispose();
  }

  Future<void> _pair() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final server = PairedServer(
        url: _url.text.trim(),
        token: _token.text.trim(),
        caFingerprint: _fingerprint.text.trim(),
      );
      final conn = await widget.service.pair(server);
      await widget.store.save(conn.server);
      await widget.store.saveCaPem(conn.caPem);
      if (mounted) Navigator.of(context).pop(conn.server);
    } on PairingException catch (e) {
      setState(() => _error = e.message);
    } on FormatException catch (e) {
      setState(() => _error = e.message);
    } catch (e) {
      setState(() => _error = 'Pairing failed: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Open the camera scanner; on a valid pairing QR, fill the form fields so
  /// the user can review before pairing.
  Future<void> _scan() async {
    final server = await Navigator.of(context).push<PairedServer>(
      MaterialPageRoute(builder: (_) => const QrScanScreen()),
    );
    if (server != null && mounted) {
      setState(() {
        _url.text = server.url;
        _token.text = server.token;
        _fingerprint.text = server.caFingerprint;
        _error = null;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Pair a device')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text('Scan the pairing QR shown on the desktop, or enter the '
                'details manually.'),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              key: const Key('scan-qr'),
              onPressed: _busy ? null : _scan,
              icon: const Icon(Icons.qr_code_scanner),
              label: const Text('Scan QR'),
            ),
            const SizedBox(height: 12),
            TextField(
              key: const Key('field-url'),
              controller: _url,
              keyboardType: TextInputType.url,
              decoration: const InputDecoration(labelText: 'Server URL (https://…:8443)'),
            ),
            TextField(
              key: const Key('field-token'),
              controller: _token,
              decoration: const InputDecoration(labelText: 'Access token'),
            ),
            TextField(
              key: const Key('field-fingerprint'),
              controller: _fingerprint,
              decoration: const InputDecoration(labelText: 'CA fingerprint (SHA-256)'),
            ),
            const SizedBox(height: 16),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: Text(
                  _error!,
                  key: const Key('pair-error'),
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ),
            FilledButton(
              onPressed: _busy ? null : _pair,
              child: Text(_busy ? 'Pairing…' : 'Pair'),
            ),
          ],
        ),
      ),
    );
  }
}
