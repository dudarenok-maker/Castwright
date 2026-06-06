import 'package:flutter_test/flutter_test.dart';
import 'package:audiobook_companion/src/domain/resume_reconcile.dart';

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
  });
}
