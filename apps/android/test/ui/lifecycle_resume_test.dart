import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/main.dart';

class SpyRuntime {
  SpyRuntime({required this.currentBookId});
  final String? currentBookId;
  int saveNowCalls = 0;
  final List<String> syncBookCalls = [];

  late final SpyPlayer player = SpyPlayer(this);
  late final SpyResumeSync resumeSync = SpyResumeSync(this);
}

class SpyPlayer {
  SpyPlayer(this._owner);
  final SpyRuntime _owner;
  String? get currentBookId => _owner.currentBookId;
  Future<void> saveNow() async => _owner.saveNowCalls++;
}

class SpyResumeSync {
  SpyResumeSync(this._owner);
  final SpyRuntime _owner;
  Future<void> syncBook(String bookId) async => _owner.syncBookCalls.add(bookId);
}

void main() {
  testWidgets('paused → saveNow + syncBook(current)', (tester) async {
    final spy = SpyRuntime(currentBookId: 'A');
    await tester.pumpWidget(MaterialApp(
        home: LifecycleResumePusher(runtime: spy, child: const SizedBox())));
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump();
    expect(spy.saveNowCalls, 1);
    expect(spy.syncBookCalls, ['A']);
  });

  testWidgets('paused with no active book → saveNow only, no syncBook',
      (tester) async {
    final spy = SpyRuntime(currentBookId: null);
    await tester.pumpWidget(MaterialApp(
        home: LifecycleResumePusher(runtime: spy, child: const SizedBox())));
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump();
    expect(spy.saveNowCalls, 1);
    expect(spy.syncBookCalls, isEmpty);
  });

  testWidgets('resumed → no saveNow, no syncBook', (tester) async {
    final spy = SpyRuntime(currentBookId: 'A');
    await tester.pumpWidget(MaterialApp(
        home: LifecycleResumePusher(runtime: spy, child: const SizedBox())));
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
    expect(spy.saveNowCalls, 0);
    expect(spy.syncBookCalls, isEmpty);
  });
}
