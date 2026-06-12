import '../data/pairing_store.dart';
import '../domain/paired_server.dart';

/// A [PairingStore] that reports an already-paired demo server so the app boots
/// straight to the library for marketing capture. The [caPem] is a placeholder
/// and is never parsed into a SecurityContext (the demo ApiClient uses an
/// injected fake transport).
class DemoPairingStore implements PairingStore {
  static const _server = PairedServer(
    url: 'https://studio.local:8443',
    token: 'demo-token',
    caFingerprint: 'demo-fingerprint',
    pairedAt: '2026-06-01T12:00:00Z',
  );

  @override
  Future<PairedServer?> load() async => _server;
  @override
  Future<String?> loadCaPem() async => 'demo-placeholder-ca-pem';
  @override
  Future<void> save(PairedServer server) async {}
  @override
  Future<void> saveCaPem(String pem) async {}
  @override
  Future<void> clear() async {}
}
