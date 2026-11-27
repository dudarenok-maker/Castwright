import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/data/playback_store.dart';
import 'package:castwright/src/data/resume_sync_service.dart';
import 'package:castwright/src/domain/resume_reconcile.dart';

class FakeProgressApi implements ListenProgressApi {
  FakeProgressApi(this._remote);
  final RemoteProgress? _remote;
  final List<String> puts = [];

  @override
  Future<RemoteProgress?> getListenProgress(String bookId) async => _remote;

  @override
  Future<void> putListenProgress(String bookId,
      {required int chapterId,
      required double currentSec,
      required String listenedAt}) async {
    puts.add('$bookId|$chapterId|$currentSec|$listenedAt');
  }
}

class MemPlaybackStore implements PlaybackStore {
  final Map<String, PlaybackPoint> map = {};
  final List<String> saves = [];
  @override
  Future<void> savePlayback(String b, String u, int ms, String iso) async {
    saves.add('$b|$u|$ms|$iso');
    map[b] = PlaybackPoint(chapterUuid: u, positionMs: ms, listenedAt: iso);
  }

  @override
  Future<PlaybackPoint?> loadPlayback(String b) async => map[b];
}

ResumeSyncService make(FakeProgressApi api, MemPlaybackStore store,
        {int? resolvedId = 7,
        Future<void> Function(String bookId)? onPulled}) =>
    ResumeSyncService(
      progressApi: api,
      playbackStore: store,
      chapterIdResolver: (bookId, uuid) async => resolvedId,
      onPulled: onPulled,
    );

void main() {
  group('ResumeSyncService.syncBook', () {
    test('pushes the local position when it is newer (with listenedAt)', () async {
      final api = FakeProgressApi(const RemoteProgress(
          chapterUuid: 'u1', chapterId: 7, currentSec: 10, updatedAt: '2026-06-06T12:00:00Z'));
      final store = MemPlaybackStore()
        ..map['b1'] = const PlaybackPoint(
            chapterUuid: 'u1', positionMs: 30000, listenedAt: '2026-06-06T12:30:00Z');

      final action = await make(api, store).syncBook('b1');

      expect(action, ResumeAction.pushLocal);
      expect(api.puts.single, 'b1|7|30.0|2026-06-06T12:30:00Z');
      expect(store.saves, isEmpty);
    });

    test('pulls the remote position when it is newer', () async {
      final api = FakeProgressApi(const RemoteProgress(
          chapterUuid: 'u2', chapterId: 3, currentSec: 12, updatedAt: '2026-06-06T13:00:00Z'));
      final store = MemPlaybackStore()
        ..map['b1'] = const PlaybackPoint(
            chapterUuid: 'u1', positionMs: 1000, listenedAt: '2026-06-06T12:00:00Z');

      final action = await make(api, store).syncBook('b1');

      expect(action, ResumeAction.pullRemote);
      expect(store.saves.single, 'b1|u2|12000|2026-06-06T13:00:00Z');
      expect(api.puts, isEmpty);
    });

    test('pushes when the server has no record yet', () async {
      final api = FakeProgressApi(null);
      final store = MemPlaybackStore()
        ..map['b1'] = const PlaybackPoint(
            chapterUuid: 'u1', positionMs: 5000, listenedAt: '2026-06-06T12:00:00Z');

      final action = await make(api, store).syncBook('b1');
      expect(action, ResumeAction.pushLocal);
      expect(api.puts.single, 'b1|7|5.0|2026-06-06T12:00:00Z');
    });

    test('pulls when there is no local record', () async {
      final api = FakeProgressApi(const RemoteProgress(
          chapterUuid: 'u9', chapterId: 1, currentSec: 4, updatedAt: '2026-06-06T12:00:00Z'));
      final store = MemPlaybackStore();
      final action = await make(api, store).syncBook('b1');
      expect(action, ResumeAction.pullRemote);
      expect(store.saves.single, 'b1|u9|4000|2026-06-06T12:00:00Z');
    });

    test('does nothing when timestamps are equal', () async {
      final api = FakeProgressApi(const RemoteProgress(
          chapterUuid: 'u1', chapterId: 7, currentSec: 10, updatedAt: '2026-06-06T12:00:00Z'));
      final store = MemPlaybackStore()
        ..map['b1'] = const PlaybackPoint(
            chapterUuid: 'u1', positionMs: 10000, listenedAt: '2026-06-06T12:00:00Z');
      final action = await make(api, store).syncBook('b1');
      expect(action, ResumeAction.noop);
      expect(api.puts, isEmpty);
      expect(store.saves, isEmpty);
    });

    test('skips the push when the chapter id cannot be resolved', () async {
      final api = FakeProgressApi(null);
      final store = MemPlaybackStore()
        ..map['b1'] = const PlaybackPoint(
            chapterUuid: 'u1', positionMs: 5000, listenedAt: '2026-06-06T12:00:00Z');
      final action = await make(api, store, resolvedId: null).syncBook('b1');
      expect(action, ResumeAction.pushLocal);
      expect(api.puts, isEmpty); // unresolved -> no PUT
    });
  });

  group('ResumeSyncService.onPulled (#4722)', () {
    const newerRemote = RemoteProgress(
        chapterUuid: 'u2', chapterId: 3, currentSec: 12, updatedAt: '2026-06-06T13:00:00Z');
    const olderLocal = PlaybackPoint(
        chapterUuid: 'u1', positionMs: 1000, listenedAt: '2026-06-06T12:00:00Z');

    test('a pull calls it once with the book id, after the store holds the '
        'pulled row, and awaits it', () async {
      final store = MemPlaybackStore()..map['b1'] = olderLocal;
      final seen = <String>[];

      await make(FakeProgressApi(newerRemote), store, onPulled: (bookId) async {
        final row = await store.loadPlayback(bookId);
        await Future<void>.delayed(Duration.zero); // only seen if awaited
        seen.add('$bookId|${row?.chapterUuid}|${row?.positionMs}');
      }).syncBook('b1');

      expect(seen, ['b1|u2|12000']);
    });

    test('a push does not call it', () async {
      final store = MemPlaybackStore()
        ..map['b1'] = const PlaybackPoint(
            chapterUuid: 'u1', positionMs: 30000, listenedAt: '2026-06-06T14:00:00Z');
      final pulled = <String>[];

      final action = await make(FakeProgressApi(newerRemote), store,
          onPulled: (b) async => pulled.add(b)).syncBook('b1');

      expect(action, ResumeAction.pushLocal);
      expect(pulled, isEmpty);
    });

    test('a noop does not call it', () async {
      final store = MemPlaybackStore()
        ..map['b1'] = const PlaybackPoint(
            chapterUuid: 'u2', positionMs: 12000, listenedAt: '2026-06-06T13:00:00Z');
      final pulled = <String>[];

      final action = await make(FakeProgressApi(newerRemote), store,
          onPulled: (b) async => pulled.add(b)).syncBook('b1');

      expect(action, ResumeAction.noop);
      expect(pulled, isEmpty);
    });

    test('a pull that writes nothing (no chapter uuid) does not call it',
        () async {
      final api = FakeProgressApi(const RemoteProgress(
          chapterUuid: null, chapterId: 3, currentSec: 12, updatedAt: '2026-06-06T13:00:00Z'));
      final store = MemPlaybackStore()..map['b1'] = olderLocal;
      final pulled = <String>[];

      final action = await make(api, store,
          onPulled: (b) async => pulled.add(b)).syncBook('b1');

      expect(action, ResumeAction.pullRemote);
      expect(store.saves, isEmpty);
      expect(pulled, isEmpty);
    });

    test('a throwing callback does not fail the sync', () async {
      final store = MemPlaybackStore()..map['b1'] = olderLocal;
      var calls = 0;

      final action = await make(FakeProgressApi(newerRemote), store,
          onPulled: (_) async {
        calls++;
        throw StateError('re-seek failed');
      }).syncBook('b1');

      expect(action, ResumeAction.pullRemote);
      expect(calls, 1, reason: 'the callback really ran and threw');
      expect(store.saves.single, 'b1|u2|12000|2026-06-06T13:00:00Z');
    });
  });
}
