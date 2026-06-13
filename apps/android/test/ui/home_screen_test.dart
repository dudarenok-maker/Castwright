import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/domain/home_shelf.dart';
import 'package:castwright/src/ui/home_screen.dart';
import 'package:castwright/src/brand.dart';

ShelfBook sb(String id, {String? lastPlayedAt, String updatedAt = 't'}) =>
    ShelfBook(
      bookId: id,
      title: 'Title $id',
      author: 'A',
      lastPlayedAt: lastPlayedAt,
      updatedAt: updatedAt,
    );

void main() {
  final books = [
    sb('a', lastPlayedAt: '2026-06-06T10:00:00Z'),
    sb('b'), // not started
    sb('c', lastPlayedAt: '2026-06-06T12:00:00Z'),
  ];

  Widget host(void Function(String) onOpen) =>
      MaterialApp(home: HomeScreen(books: books, onOpenBook: onOpen));

  testWidgets('shows in-progress books in the continue rail', (tester) async {
    await tester.pumpWidget(host((_) {}));
    expect(find.byKey(const Key('continue-c')), findsOneWidget);
    expect(find.byKey(const Key('continue-a')), findsOneWidget);
    expect(find.byKey(const Key('continue-b')), findsNothing); // not started
  });

  testWidgets('tapping a continue card opens that book', (tester) async {
    String? opened;
    await tester.pumpWidget(host((id) => opened = id));
    await tester.tap(find.byKey(const Key('continue-c')));
    await tester.pump();
    expect(opened, 'c');
  });

  testWidgets('shows an empty state when nothing is in progress', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: HomeScreen(books: [sb('x')], onOpenBook: (_) {}),
    ));
    expect(find.byKey(const Key('continue-empty')), findsOneWidget);
  });

  testWidgets('shows the brand tagline in the empty state', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: HomeScreen(books: [sb('x')], onOpenBook: (_) {}),
    ));
    final tagline = find.byKey(const Key('home-tagline'));
    expect(tagline, findsOneWidget);
    expect(tester.widget<Text>(tagline).data, brandTaglineShort);
  });
}
