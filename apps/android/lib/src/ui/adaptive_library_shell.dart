import 'package:flutter/material.dart';

import '../data/companion_runtime.dart';
import '../domain/pane_split.dart';
import '../domain/window_size.dart';
import 'library_pane.dart';
import 'player_pane.dart';

/// Single-pane vs two-pane switch (app-21). At `expanded` (>=840 dp), the
/// library and a persistent [PlayerPane] share a `Row`; selecting a book
/// updates [activeBook] in place (no route push). Below `expanded`, only the
/// library renders — the caller pushes [PlayerScreen] itself.
class AdaptiveLibraryShell extends StatelessWidget {
  const AdaptiveLibraryShell({
    super.key,
    required this.runtime,
    required this.activeBook,
    required this.libraryPane,
  });

  final CompanionRuntime runtime;
  final ActiveBook activeBook;
  final Widget libraryPane;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (context, constraints) {
      final layout = libraryLayoutFor(windowSizeClassFor(constraints.maxWidth));
      if (layout == LibraryLayout.singlePane) return libraryPane;

      final split = paneSplitForHinge(
          constraints.biggest, MediaQuery.of(context).displayFeatures);
      return Row(
        key: const Key('adaptive-two-pane'),
        children: [
          SizedBox(width: split.leftWidth, child: libraryPane),
          if (split.gutter > 0)
            SizedBox(width: split.gutter)
          else
            const VerticalDivider(width: 1),
          Expanded(
            child: AnimatedBuilder(
              animation: activeBook,
              builder: (_, _) => PlayerPane(
                key: ValueKey(activeBook.bookId),
                runtime: activeBook.bookId == null ? null : runtime,
                bookId: activeBook.bookId,
                title: activeBook.title,
              ),
            ),
          ),
        ],
      );
    });
  }
}
