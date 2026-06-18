import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/demo/demo_runtime.dart';
import 'package:castwright/src/data/file_store.dart';
import 'package:castwright/src/ui/player_screen.dart';

void main() {
  testWidgets('finished chapter shows a check; current chapter shows a progress bar',
      (tester) async {
    final rt = await buildDemoRuntime(fs: InMemoryFileStore(), root: '/demo');
    await rt.library.setChapterFinished('ht1-c1', true); // mark chapter 1 done

    await tester.pumpWidget(MaterialApp(
      home: PlayerScreen(
          runtime: rt, bookId: 'hollow-tide-1', title: 'The Drowning Bell'),
    ));
    await tester.pumpAndSettle();

    // Chapter 1 (finished, not current) → a check icon.
    expect(find.byIcon(Icons.check_circle), findsOneWidget);

    // The current chapter (ht1-c2, the resume point) → its progress bar.
    // The bar is a SIBLING of the ListTile in the row Column, not a descendant,
    // so assert on the bar's own key — NOT find.descendant of the chapter tile.
    expect(find.byKey(const Key('progress-ht1-c2')), findsOneWidget);
  });

  testWidgets('bottom transport names the current chapter', (tester) async {
    final rt = await buildDemoRuntime(fs: InMemoryFileStore(), root: '/demo');
    await tester.pumpWidget(MaterialApp(
      home: PlayerScreen(
          runtime: rt, bookId: 'hollow-tide-1', title: 'The Drowning Bell'),
    ));
    await tester.pumpAndSettle();

    // Resume point is ht1-c2 = id 2, title "Bells Beneath".
    expect(find.text('Ch. 2 · Bells Beneath'), findsOneWidget);
  });

  testWidgets('chapter list has a scroll controller and the label is tappable',
      (tester) async {
    final rt = await buildDemoRuntime(fs: InMemoryFileStore(), root: '/demo');
    await tester.pumpWidget(MaterialApp(
      home: PlayerScreen(
          runtime: rt, bookId: 'hollow-tide-1', title: 'The Drowning Bell'),
    ));
    await tester.pumpAndSettle();

    final listView = tester.widget<ListView>(find.byType(ListView));
    expect(listView.controller, isNotNull);

    // Tapping the current-chapter label must not throw (scrolls to current).
    await tester.tap(find.byKey(const Key('player-current-chapter')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('player-current-chapter')), findsOneWidget);
  });
}
