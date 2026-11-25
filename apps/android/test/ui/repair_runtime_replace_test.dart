import 'dart:async';

import 'package:castwright/main.dart';
import 'package:castwright/src/data/companion_audio_handler.dart';
import 'package:castwright/src/data/companion_runtime.dart';
import 'package:castwright/src/ui/library_home_screen.dart';
import 'package:castwright/src/ui/player_screen.dart';
import 'package:castwright/src/data/file_store.dart';
import 'package:castwright/src/data/pairing_service.dart';
import 'package:castwright/src/data/pairing_store.dart';
import 'package:castwright/src/demo/demo_audio_engine.dart';
import 'package:castwright/src/demo/demo_runtime.dart';
import 'package:castwright/src/domain/paired_server.dart';
import 'package:flutter/widgets.dart' show Key;
import 'package:flutter_test/flutter_test.dart';

class _PairedStore implements PairingStore {
  PairedServer? server = const PairedServer(
      url: 'https://192.168.1.5:8443',
      token: 'old-revoked-token',
      caFingerprint: 'f');
  @override
  Future<PairedServer?> load() async => server;
  @override
  Future<String?> loadCaPem() async => 'pem';
  @override
  Future<void> save(PairedServer s) async => server = s;
  @override
  Future<void> saveCaPem(String pem) async {}
  @override
  Future<void> clear() async => server = null;
}

class _RecordingEngine extends DemoAudioEngine {
  bool disposed = false;
  @override
  Future<void> dispose() async => disposed = true;
}

/// An engine whose position can be moved, and which reports the playback row
/// the library holds at the moment the runtime disposes it (just before the
/// database closes), via [onDispose].
class _MovableEngine extends DemoAudioEngine {
  Duration _pos = const Duration(minutes: 7, seconds: 12);
  Future<void> Function()? onDispose;
  @override
  Duration get position => _pos;
  set position(Duration d) => _pos = d;
  @override
  Future<void> dispose() async => await onDispose?.call();
}

void main() {
  // E118 / PR #4635 review: a successful re-pair rebuilds the runtime. The old
  // runtime must be disposed first, or its Connectivity listener keeps probing
  // with the revoked token and (since a 401 now re-opens pairing) re-opens the
  // pairing screen on every later network change.
  testWidgets('a successful re-pair disposes the runtime it replaces',
      (tester) async {
    final links = StreamController<Uri>();
    addTearDown(links.close);
    final engines = <_RecordingEngine>[];

    final service = PairingService(
      fetchCa: (_) async => 'pem',
      verifyTag: (_, _) => true,
      redeem: (_, _, _) async =>
          const RedeemResult(token: 'new-token', caFingerprint: 'f'),
    );

    await tester.pumpWidget(AudiobookCompanionApp(
      store: _PairedStore(),
      service: service,
      deepLinks: links.stream,
      runtimeFactory: (Connection c,
          {CompanionAudioHandler? handler,
          void Function()? onRepairNeeded}) async {
        final engine = _RecordingEngine();
        engines.add(engine);
        return buildDemoRuntime(
            fs: InMemoryFileStore(), root: '/t', engine: engine);
      },
    ));
    await tester.runAsync(() => Future<void>.delayed(
        const Duration(milliseconds: 200)));
    await tester.pumpAndSettle();
    expect(engines, hasLength(1));
    expect(engines.single.disposed, isFalse);

    links.add(Uri.parse(
        'https://www.castwright.ai/pair?h=192.168.1.5:8443&c=K7QF3M2P&f=J4XQ2A7BWZ9K3M5R'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Pair'));
    await tester.runAsync(() => Future<void>.delayed(
        const Duration(milliseconds: 500)));
    await tester.pumpAndSettle();

    expect(engines, hasLength(2), reason: 'the re-pair rebuilt the runtime');
    expect(engines.first.disposed, isTrue,
        reason: 'the replaced runtime must be disposed (cancels its probe)');
    expect(engines.last.disposed, isFalse,
        reason: 'the new runtime must stay alive');
  });

  // PR #4635 review pass 2: on a phone a book's PlayerScreen is pushed on the
  // root navigator, and the pairing screen is pushed on top of it (that is
  // where the 401 fires). The re-pair disposes the old runtime, so the routes
  // under pairing must be popped or the user lands back on a player bound to a
  // closed database.
  testWidgets('a re-pair started from the player leaves no route on the old runtime',
      (tester) async {
    final links = StreamController<Uri>();
    addTearDown(links.close);
    final engines = <_RecordingEngine>[];
    final runtimes = <CompanionRuntime>[];

    final service = PairingService(
      fetchCa: (_) async => 'pem',
      verifyTag: (_, _) => true,
      redeem: (_, _, _) async =>
          const RedeemResult(token: 'new-token', caFingerprint: 'f'),
    );

    await tester.pumpWidget(AudiobookCompanionApp(
      store: _PairedStore(),
      service: service,
      deepLinks: links.stream,
      runtimeFactory: (Connection c,
          {CompanionAudioHandler? handler,
          void Function()? onRepairNeeded}) async {
        final engine = _RecordingEngine();
        engines.add(engine);
        final runtime = await buildDemoRuntime(
            fs: InMemoryFileStore(), root: '/t', engine: engine);
        runtimes.add(runtime);
        return runtime;
      },
    ));
    await tester.runAsync(() => Future<void>.delayed(
        const Duration(milliseconds: 200)));
    await tester.pumpAndSettle();

    await tester.tap(find.text('The Drowning Bell'));
    await tester.pumpAndSettle();
    expect(find.byType(PlayerScreen), findsOneWidget);

    links.add(Uri.parse(
        'https://www.castwright.ai/pair?h=192.168.1.5:8443&c=K7QF3M2P&f=J4XQ2A7BWZ9K3M5R'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Pair'));
    await tester.runAsync(() => Future<void>.delayed(
        const Duration(milliseconds: 500)));
    await tester.pumpAndSettle();

    expect(engines.first.disposed, isTrue);
    expect(find.byType(PlayerScreen), findsNothing,
        reason: 'the player bound to the disposed runtime must be popped');
    expect(find.byType(LibraryHomeScreen), findsOneWidget);
    expect(tester.widget<LibraryHomeScreen>(find.byType(LibraryHomeScreen)).runtime,
        same(runtimes.last));
  });

  // PR #4635 review pass 3: a re-pair while listening must flush the player's
  // position BEFORE the old runtime closes its database; the pane's own closing
  // save lands after the close and is swallowed, losing up to 10 s.
  testWidgets('a re-pair while listening saves the live position first',
      (tester) async {
    final links = StreamController<Uri>();
    addTearDown(links.close);
    final engines = <_MovableEngine>[];
    final runtimes = <CompanionRuntime>[];
    int? savedAtDispose;

    final service = PairingService(
      fetchCa: (_) async => 'pem',
      verifyTag: (_, _) => true,
      redeem: (_, _, _) async =>
          const RedeemResult(token: 'new-token', caFingerprint: 'f'),
    );

    await tester.pumpWidget(AudiobookCompanionApp(
      store: _PairedStore(),
      service: service,
      deepLinks: links.stream,
      runtimeFactory: (Connection c,
          {CompanionAudioHandler? handler,
          void Function()? onRepairNeeded}) async {
        final engine = _MovableEngine();
        final runtime = await buildDemoRuntime(
            fs: InMemoryFileStore(), root: '/t', engine: engine);
        engine.onDispose = () async {
          final id = runtime.player.currentBookId;
          if (engines.first != engine || id == null) return;
          savedAtDispose = (await runtime.library.loadPlayback(id))?.positionMs;
        };
        engines.add(engine);
        runtimes.add(runtime);
        return runtime;
      },
    ));
    await tester.runAsync(() => Future<void>.delayed(
        const Duration(milliseconds: 200)));
    await tester.pumpAndSettle();

    await tester.tap(find.text('The Drowning Bell'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('player-playpause')));
    await tester.pumpAndSettle();
    engines.first.position = const Duration(milliseconds: 440000);

    links.add(Uri.parse(
        'https://www.castwright.ai/pair?h=192.168.1.5:8443&c=K7QF3M2P&f=J4XQ2A7BWZ9K3M5R'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Pair'));
    await tester.runAsync(() => Future<void>.delayed(
        const Duration(milliseconds: 500)));
    await tester.pumpAndSettle();

    expect(engines, hasLength(2));
    expect(savedAtDispose, 440000,
        reason: 'the live position must be saved before the old database closes');
  });
}
