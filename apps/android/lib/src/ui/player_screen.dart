import 'package:flutter/material.dart';

import '../data/companion_runtime.dart';
import 'player_pane.dart';

/// Compact host: an AppBar + the reusable PlayerPane, pushed as a route on phones
/// and tablet-portrait. On large screens the pane is embedded by AdaptiveLibraryShell.
class PlayerScreen extends StatelessWidget {
  const PlayerScreen({
    super.key,
    required this.runtime,
    required this.bookId,
    required this.title,
  });

  final CompanionRuntime runtime;
  final String bookId;
  final String title;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(title)),
      body: PlayerPane(
          key: ValueKey(bookId), runtime: runtime, bookId: bookId, title: title),
    );
  }
}
