import 'dart:convert';

import '../domain/app_settings.dart';
import 'file_store.dart';

/// Persists [AppSettings] as a single JSON file via [FileStore] — defaults when
/// absent or corrupt, so a bad file never bricks the app.
class SettingsStore {
  SettingsStore(this._fs, {required String path}) : _filePath = path;

  final FileStore _fs;
  final String _filePath;

  Future<AppSettings> load() async {
    final bytes = await _fs.read(_filePath);
    if (bytes == null) return AppSettings.defaults;
    try {
      final decoded = jsonDecode(utf8.decode(bytes));
      if (decoded is Map<String, dynamic>) return AppSettings.fromJson(decoded);
    } catch (_) {
      // fall through to defaults
    }
    return AppSettings.defaults;
  }

  Future<void> save(AppSettings settings) async {
    await _fs.writeBytes(_filePath, utf8.encode(jsonEncode(settings.toJson())));
  }
}
