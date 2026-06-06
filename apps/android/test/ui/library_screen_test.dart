import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:audiobook_companion/src/domain/library_tree.dart';
import 'package:audiobook_companion/src/ui/library_screen.dart';

LibraryBook bk(String id, String author, String title,
        {BookDownloadState state = BookDownloadState.downloaded}) =>
    LibraryBook(
      bookId: id,
      title: title,
      author: author,
      series: '',
      seriesPosition: null,
      downloadState: state,
    );

void main() {
  final books = [
    bk('b1', 'Brandon Sanderson', 'Mistborn',
        state: BookDownloadState.notDownloaded),
    bk('b2', 'Anna', 'The Way of Kings'),
  ];

  Widget host({
    void Function(String)? onOpen,
    void Function(String)? onDownload,
    void Function(String)? onRemove,
  }) =>
      MaterialApp(
        home: LibraryScreen(
          books: books,
          onOpen: onOpen ?? (_) {},
          onDownload: onDownload ?? (_) {},
          onRemove: onRemove ?? (_) {},
        ),
      );

  testWidgets('renders authors and books', (tester) async {
    await tester.pumpWidget(host());
    expect(find.text('Brandon Sanderson'), findsOneWidget);
    expect(find.text('Anna'), findsOneWidget);
    expect(find.text('Mistborn'), findsOneWidget);
    expect(find.text('The Way of Kings'), findsOneWidget);
  });

  testWidgets('search filters the list', (tester) async {
    await tester.pumpWidget(host());
    await tester.enterText(find.byKey(const Key('library-search')), 'mistborn');
    await tester.pumpAndSettle();
    expect(find.text('Mistborn'), findsOneWidget);
    expect(find.text('The Way of Kings'), findsNothing);
  });

  testWidgets('download action fires for a not-downloaded book', (tester) async {
    String? downloaded;
    await tester.pumpWidget(host(onDownload: (id) => downloaded = id));
    await tester.tap(find.byKey(const Key('download-b1')));
    await tester.pump();
    expect(downloaded, 'b1');
  });
}
