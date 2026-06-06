import 'dart:io';

/// A minimal filesystem port the sync engine writes through, injectable so the
/// engine + downloader unit-test without touching real disk. The real
/// [DiskFileStore] is a thin `dart:io` adapter; [InMemoryFileStore] backs the
/// tests.
abstract class FileStore {
  /// Byte length of [path], or `-1` if it does not exist.
  Future<int> size(String path);
  Future<bool> exists(String path);

  /// Full bytes of [path], or `null` if it does not exist.
  Future<List<int>?> read(String path);

  /// Overwrite [path] with [bytes] (creating parent dirs as needed).
  Future<void> writeBytes(String path, List<int> bytes);

  /// Append [bytes] to [path] (creating it + parent dirs if absent).
  Future<void> append(String path, List<int> bytes);

  /// Atomically move [from] to [to], replacing any existing file at [to].
  Future<void> rename(String from, String to);

  /// Delete [path]; a no-op if it does not exist.
  Future<void> delete(String path);

  /// Recursively delete the directory at [path]; a no-op if it does not exist.
  Future<void> deleteDir(String path);
}

/// `dart:io`-backed [FileStore] for the running app.
class DiskFileStore implements FileStore {
  const DiskFileStore();

  @override
  Future<int> size(String path) async {
    final f = File(path);
    return await f.exists() ? f.length() : -1;
  }

  @override
  Future<bool> exists(String path) => File(path).exists();

  @override
  Future<List<int>?> read(String path) async {
    final f = File(path);
    return await f.exists() ? f.readAsBytes() : null;
  }

  @override
  Future<void> writeBytes(String path, List<int> bytes) async {
    final f = File(path);
    await f.parent.create(recursive: true);
    await f.writeAsBytes(bytes, flush: true);
  }

  @override
  Future<void> append(String path, List<int> bytes) async {
    final f = File(path);
    await f.parent.create(recursive: true);
    await f.writeAsBytes(bytes, mode: FileMode.append, flush: true);
  }

  @override
  Future<void> rename(String from, String to) async {
    final dest = File(to);
    await dest.parent.create(recursive: true);
    if (await dest.exists()) await dest.delete();
    await File(from).rename(to);
  }

  @override
  Future<void> delete(String path) async {
    final f = File(path);
    if (await f.exists()) await f.delete();
  }

  @override
  Future<void> deleteDir(String path) async {
    final d = Directory(path);
    if (await d.exists()) await d.delete(recursive: true);
  }
}

/// In-memory [FileStore] for tests — paths are opaque keys; [deleteDir] removes
/// every key under the directory prefix.
class InMemoryFileStore implements FileStore {
  final Map<String, List<int>> _files = {};

  @override
  Future<int> size(String path) async => _files[path]?.length ?? -1;

  @override
  Future<bool> exists(String path) async => _files.containsKey(path);

  @override
  Future<List<int>?> read(String path) async {
    final bytes = _files[path];
    return bytes == null ? null : List<int>.from(bytes);
  }

  @override
  Future<void> writeBytes(String path, List<int> bytes) async {
    _files[path] = List<int>.from(bytes);
  }

  @override
  Future<void> append(String path, List<int> bytes) async {
    (_files[path] ??= <int>[]).addAll(bytes);
  }

  @override
  Future<void> rename(String from, String to) async {
    final bytes = _files.remove(from);
    if (bytes != null) _files[to] = bytes;
  }

  @override
  Future<void> delete(String path) async {
    _files.remove(path);
  }

  @override
  Future<void> deleteDir(String path) async {
    final prefix = path.endsWith('/') ? path : '$path/';
    _files.removeWhere((key, _) => key == path || key.startsWith(prefix));
  }
}
