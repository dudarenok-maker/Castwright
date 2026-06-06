import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../domain/paired_server.dart';

/// Persists the paired-server connection across launches (app-2). An interface
/// so screens can be unit-tested against an in-memory fake.
abstract class PairingStore {
  Future<PairedServer?> load();
  Future<void> save(PairedServer server);
  Future<void> clear();
}

/// Real implementation backed by the OS keystore/keychain via
/// flutter_secure_storage — the token is a secret, so it never lands in plain
/// SharedPreferences/files.
class SecurePairingStore implements PairingStore {
  SecurePairingStore([FlutterSecureStorage? storage])
      : _storage = storage ?? const FlutterSecureStorage();

  static const _key = 'paired_server';
  final FlutterSecureStorage _storage;

  @override
  Future<PairedServer?> load() async {
    final raw = await _storage.read(key: _key);
    if (raw == null || raw.isEmpty) return null;
    try {
      return PairedServer.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } catch (_) {
      return null;
    }
  }

  @override
  Future<void> save(PairedServer server) =>
      _storage.write(key: _key, value: jsonEncode(server.toJson()));

  @override
  Future<void> clear() => _storage.delete(key: _key);
}
