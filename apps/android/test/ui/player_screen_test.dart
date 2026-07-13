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

  testWidgets(
      'transport play/pause icon reflects the real engine playing state, not a local flag',
      (tester) async {
    // Regression: the in-app player used a local `_playing` bool that only
    // flipped on tap, so it never tracked the engine. When playback stopped
    // out-of-band (headset/Android Auto disconnect) the icon stayed "pause"
    // and the first tap was a silent no-op ("click twice to restart"). The
    // demo engine reports playing==true, so a correctly-bound transport shows
    // the pause icon without any tap.
    final rt = await buildDemoRuntime(fs: InMemoryFileStore(), root: '/demo');
    await tester.pumpWidget(MaterialApp(
      home: PlayerScreen(
          runtime: rt, bookId: 'hollow-tide-1', title: 'The Drowning Bell'),
    ));
    await tester.pumpAndSettle();

    final button = tester.widget<IconButton>(
        find.byKey(const Key('player-playpause')));
    expect((button.icon as Icon).icon, Icons.pause_circle);
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

  testWidgets('player renders a cover-art header when the book has cover art',
      (tester) async {
    // Seed a cover so boot resolves a non-null art path. resizeJpegToWidth
    // returns the source bytes unchanged when they aren't decodable, so a stub
    // is fine — the header renders off the path (Image.file falls back to its
    // menu_book icon for the undecodable bytes, which is irrelevant here).
    final fs = InMemoryFileStore();
    await fs.writeBytes('covers/hollow-tide-1.png', const [0, 1, 2, 3]);
    final rt = await buildDemoRuntime(fs: fs, coversDir: 'covers', root: '/demo');

    await tester.pumpWidget(MaterialApp(
      home: PlayerScreen(
          runtime: rt, bookId: 'hollow-tide-1', title: 'The Drowning Bell'),
    ));
    await tester.pumpAndSettle();

    // With cover art, the book title appears twice: in the AppBar title and in
    // the new cover header above the chapter list. Without the header (no art)
    // it appears once — so this pins the header's presence.
    expect(find.text('The Drowning Bell'), findsNWidgets(2));
  });
}
