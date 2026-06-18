import 'package:flutter/material.dart';

import '../data/pairing_service.dart';
import '../data/pairing_store.dart';
import '../domain/pairing_qr.dart';
import 'qr_scan_screen.dart';
import '../brand.dart';

/// Manual pairing form (app-2). Enter the server host:port + pairing code +
/// fingerprint tag from the desktop pairing screen; on success the verified
/// connection is persisted and returned. QR scanning fills the fields so the
/// user can review before pairing.
class PairingScreen extends StatefulWidget {
  const PairingScreen(
      {super.key, required this.service, required this.store, this.initialQr});

  final PairingService service;
  final PairingStore store;

  /// When opened from a deep link, pre-fills the form for review before pairing.
  final PairingQr? initialQr;

  @override
  State<PairingScreen> createState() => _PairingScreenState();
}

class _PairingScreenState extends State<PairingScreen> {
  final _host = TextEditingController();
  final _code = TextEditingController();
  final _fpTag = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    final qr = widget.initialQr;
    if (qr != null) {
      _host.text = qr.hostPort;
      _code.text = qr.code;
      _fpTag.text = qr.fpTag;
    }
  }

  @override
  void dispose() {
    _host.dispose();
    _code.dispose();
    _fpTag.dispose();
    super.dispose();
  }

  Future<void> _pair() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final qr = PairingQr.checked(
          _host.text.trim(), _code.text.trim(), _fpTag.text.trim());
      final conn = await widget.service.pair(qr, label: 'Companion');
      final stamped =
          conn.server.copyWith(pairedAt: DateTime.now().toIso8601String());
      await widget.store.save(stamped);
      await widget.store.saveCaPem(conn.caPem);
      if (mounted) Navigator.of(context).pop(stamped);
    } on PairingException catch (e) {
      setState(() => _error = e.message);
    } on FormatException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Open the camera scanner; on a valid pairing QR, fill the form fields so
  /// the user can review before pairing.
  Future<void> _scan() async {
    final qr = await Navigator.of(context).push<PairingQr>(
      MaterialPageRoute(builder: (_) => const QrScanScreen()),
    );
    if (qr != null && mounted) {
      setState(() {
        _host.text = qr.hostPort;
        _code.text = qr.code;
        _fpTag.text = qr.fpTag;
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
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Text(
                brandTaglineShort,
                key: const Key('pair-tagline'),
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                    ),
              ),
            ),
            if (widget.initialQr != null)
              Container(
                key: const Key('pair-host-banner'),
                margin: const EdgeInsets.only(bottom: 12),
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: Theme.of(context).colorScheme.secondaryContainer,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(
                  'Pairing with ${widget.initialQr!.hostPort} — confirm this is your computer before continuing.',
                  style: Theme.of(context).textTheme.bodyMedium,
                ),
              ),
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
                key: const Key('field-host'),
                controller: _host,
                readOnly: widget.initialQr != null,
                decoration:
                    const InputDecoration(labelText: 'Server (host:port)')),
            TextField(
                key: const Key('field-code'),
                controller: _code,
                decoration: const InputDecoration(labelText: 'Pairing code')),
            TextField(
                key: const Key('field-fptag'),
                controller: _fpTag,
                decoration:
                    const InputDecoration(labelText: 'Fingerprint tag')),
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
