import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/domain/resume_reconcile.dart';

void main() {
  group('reconcileResume', () {
    test('no local and no remote -> noop', () {
      expect(reconcileResume(localListenedAt: null, remoteUpdatedAt: null),
          ResumeAction.noop);
    });

    test('local only -> push local', () {
      expect(reconcileResume(localListenedAt: 't', remoteUpdatedAt: null),
          ResumeAction.pushLocal);
    });

    test('remote only -> pull remote', () {
      expect(reconcileResume(localListenedAt: null, remoteUpdatedAt: 't'),
          ResumeAction.pullRemote);
    });

    test('local strictly newer -> push local (last-write-wins by listen time)', () {
      expect(
        reconcileResume(
          localListenedAt: '2026-06-06T12:30:00Z',
          remoteUpdatedAt: '2026-06-06T12:00:00Z',
        ),
        ResumeAction.pushLocal,
      );
    });

    test('remote strictly newer -> pull remote', () {
      expect(
        reconcileResume(
          localListenedAt: '2026-06-06T12:00:00Z',
          remoteUpdatedAt: '2026-06-06T12:30:00Z',
        ),
        ResumeAction.pullRemote,
      );
    });

    test('equal timestamps -> noop', () {
      expect(
        reconcileResume(
          localListenedAt: '2026-06-06T12:00:00Z',
          remoteUpdatedAt: '2026-06-06T12:00:00Z',
        ),
        ResumeAction.noop,
      );
    });

    test('orders by instant, not raw string (tz-skew)', () {
      // local is +10:00 wall time, remote is the same instant in UTC → noop/pull, not a wrong push
      final action = reconcileResume(
        localListenedAt: '2026-06-20T20:00:00.000+10:00',
        remoteUpdatedAt: '2026-06-20T10:00:00.000Z', // same instant
      );
      expect(action, ResumeAction.noop);
    });
  });
}
