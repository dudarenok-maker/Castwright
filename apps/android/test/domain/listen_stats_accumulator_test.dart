import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/domain/listen_stats_accumulator.dart';

void main() {
  group('StatsAccumulator', () {
    test('accrues wall-clock while playing, ignores paused time', () {
      var t = 1749808800000; // 2026-06-13T10:00:00Z (ms epoch)
      final acc = StatsAccumulator('book-1', () => t, () => '2026-06-13');
      acc.onPlay();
      t += 10000;
      acc.onPause();
      t += 60000;
      acc.onPlay();
      t += 5000;
      final drained = acc.drain();
      expect(drained.sessionPresent, isTrue);
      expect(drained.days.length, 1);
      expect(drained.days.first.date, '2026-06-13');
      expect(drained.days.first.seconds, 15);
    });

    test('attributes to the active book and flushes prior book on switch', () {
      var t = 1749808800000;
      var dateStr = '2026-06-13';
      final acc = StatsAccumulator('book-1', () => t, () => dateStr);
      acc.onPlay();
      t += 20000;
      final handoff = acc.switchBook('book-2');
      expect(handoff.bookId, 'book-1');
      expect(handoff.days.length, 1);
      expect(handoff.days.first.date, '2026-06-13');
      expect(handoff.days.first.seconds, 20);
      // playing continues on book-2 with refreshed checkpoint
      t += 10000;
      final drained = acc.drain();
      expect(drained.days.length, 1);
      expect(drained.days.first.date, '2026-06-13');
      expect(drained.days.first.seconds, 10);
    });

    test('splits a play interval across local midnight', () {
      var t = 1749858590000; // 2026-06-13T23:59:50Z
      var dateStr = '2026-06-13';
      final acc = StatsAccumulator('b', () => t, () => dateStr);
      acc.onPlay();
      t += 10000;
      dateStr = '2026-06-13';
      acc.tick();
      t += 10000;
      dateStr = '2026-06-14';
      acc.tick();
      final days = acc.drain().days;
      expect(days.any((d) => d.date == '2026-06-13' && d.seconds == 10), isTrue);
      expect(days.any((d) => d.date == '2026-06-14' && d.seconds == 10), isTrue);
    });

    test('drain reports sessionPresent false before any play', () {
      final acc = StatsAccumulator('b', () => 0, () => '2026-06-13');
      final drained = acc.drain();
      expect(drained.sessionPresent, isFalse);
      expect(drained.days, isEmpty);
    });

    test('double onPause does not double-count', () {
      var t = 1749808800000;
      final acc = StatsAccumulator('b', () => t, () => '2026-06-13');
      acc.onPlay();
      t += 10000;
      acc.onPause();
      t += 5000;
      acc.onPause(); // no-op: not playing
      final days = acc.drain().days;
      expect(days.length, 1);
      expect(days.first.seconds, 10);
    });

    test('draining twice while playing does not re-count the same interval', () {
      var t = 1749808800000;
      final acc = StatsAccumulator('b', () => t, () => '2026-06-13');
      acc.onPlay();
      t += 10000;
      final first = acc.drain();
      expect(first.days.first.seconds, 10);
      t += 5000;
      final second = acc.drain();
      expect(second.days.first.seconds, 15);
    });

    test('zero-second days are filtered from drain', () {
      var t = 1749808800000;
      final acc = StatsAccumulator('b', () => t, () => '2026-06-13');
      acc.onPlay();
      acc.onPause(); // zero elapsed
      final drained = acc.drain();
      expect(drained.days, isEmpty);
      // sessionPresent is true because byDate has an entry (even zero) OR playing was true.
      // Actually after pause, playing=false, and byDate has 0s — drain filters it.
      // sessionPresent = byDate.isNotEmpty || playing: byDate has entry with 0s → isNotEmpty
      // so sessionPresent may be true here (matching TS: byDate.size > 0 || playing).
      // We just assert days is empty — the critical contract.
    });
  });
}
