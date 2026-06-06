import 'package:flutter_test/flutter_test.dart';
import 'package:audiobook_companion/src/data/playback_store.dart';
import 'package:audiobook_companion/src/data/resume_sync_service.dart';
import 'package:audiobook_companion/src/domain/resume_reconcile.dart';

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
        {int? resolvedId = 7}) =>
    ResumeSyncService(
      progressApi: api,
      playbackStore: store,
      chapterIdResolver: (bookId, uuid) async => resolvedId,
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
}
