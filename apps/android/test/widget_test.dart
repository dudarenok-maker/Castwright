import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:audiobook_companion/main.dart';

void main() {
  testWidgets('renders the app title and the unpaired home state', (tester) async {
    await tester.pumpWidget(const AudiobookCompanionApp());

    expect(find.text('Audiobook Companion'), findsWidgets);
    expect(find.byKey(const Key('home-status')), findsOneWidget);
    expect(find.text('Not paired yet'), findsOneWidget);
  });
}
