import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/demo/demo_runtime.dart';
import 'package:castwright/src/data/file_store.dart';
import 'package:castwright/src/ui/player_pane.dart';

void main() {
  testWidgets('empty state when no active book', (tester) async {
    await tester.pumpWidget(const MaterialApp(
      home: Scaffold(body: PlayerPane(runtime: null, bookId: null, title: '')),
    ));
    expect(find.text('Select a book to start listening'), findsOneWidget);
  });

  testWidgets('renders chapters for the active book', (tester) async {
    final runtime = await buildDemoRuntime(fs: InMemoryFileStore(), root: '/demo');
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: PlayerPane(
            key: const ValueKey('hollow-tide-1'), // demo book ID (title: The Drowning Bell)
            runtime: runtime,
            bookId: 'hollow-tide-1',
            title: 'The Drowning Bell'),
      ),
    ));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('player-playpause')), findsOneWidget);
  });
}
