import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:audiobook_companion/src/data/download_foreground_service.dart';
import 'package:audiobook_companion/src/data/sync_engine.dart';

class _FakeController implements ForegroundController {
  final List<String> calls = [];

  @override
  Future<void> start(String title, String text) async =>
      calls.add('start:$title|$text');

  @override
  Future<void> update(String text) async => calls.add('update:$text');

  @override
  Future<void> stop() async => calls.add('stop');
}

SyncResult emptyResult() => const SyncResult(
      chaptersDownloaded: 2,
      chaptersDeferred: 0,
      chaptersEvicted: 0,
      booksEvicted: 0,
      errors: {},
    );

void main() {
  group('SyncForegroundRunner', () {
    test('starts the service, updates per progress tick, and stops after', () async {
      final ctrl = _FakeController();
      final runner = SyncForegroundRunner(ctrl);

      // Model the real flow: the task emits progress as it runs (the engine
      // emits between its internal awaits), so the listener fires mid-task.
      final pc = StreamController<SyncProgress>.broadcast();
      final result = await runner.run(
        progress: pc.stream,
        task: () async {
          for (final p in const [
            SyncProgress(phase: SyncPhase.indexing),
            SyncProgress(
                phase: SyncPhase.chapter,
                bookId: 'b1',
                chaptersDone: 0,
                chaptersTotal: 3),
            SyncProgress(phase: SyncPhase.done),
          ]) {
            pc.add(p);
            await Future<void>.delayed(Duration.zero);
          }
          return emptyResult();
        },
      );
      await pc.close();

      expect(result.chaptersDownloaded, 2);
      expect(ctrl.calls.first, startsWith('start:'));
      expect(ctrl.calls.last, 'stop');
      expect(ctrl.calls.where((c) => c.startsWith('update:')), isNotEmpty);
      // The chapter tick renders the "ch x/y" progress copy.
      expect(ctrl.calls.any((c) => c.contains('ch 1/3')), isTrue);
    });

    test('always stops the service even if the sync throws', () async {
      final ctrl = _FakeController();
      final runner = SyncForegroundRunner(ctrl);

      await expectLater(
        runner.run(
          progress: const Stream.empty(),
          task: () async => throw Exception('boom'),
        ),
        throwsA(isA<Exception>()),
      );
      expect(ctrl.calls, contains('stop'));
    });
  });
}
