import 'package:flutter/material.dart';

import '../domain/home_shelf.dart';
import '../brand.dart';

/// Home surface (`app-14`): a "Continue listening" shelf of in-progress books
/// (most-recently-played first) plus a recently-updated rail. Tapping a book
/// opens it — the host wires [onOpenBook] to the player's `switchBook`, so each
/// book resumes at its own saved position (per-book state from app-5/app-6).
class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key, required this.books, required this.onOpenBook});

  final List<ShelfBook> books;
  final void Function(String bookId) onOpenBook;

  @override
  Widget build(BuildContext context) {
    final continueRail = buildContinueListening(books);
    final recent = buildRecentlyUpdated(books);
    return Scaffold(
      appBar: AppBar(title: const Text('Home')),
      body: ListView(
        children: [
          const _Header('Continue listening'),
          if (continueRail.isEmpty)
            Padding(
              key: const Key('continue-empty'),
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('Nothing in progress yet — start a book from Library.'),
                  const SizedBox(height: 8),
                  Text(
                    brandTaglineShort,
                    key: const Key('home-tagline'),
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                          color: Theme.of(context).colorScheme.onSurfaceVariant,
                        ),
                  ),
                ],
              ),
            )
          else
            _Rail(books: continueRail, prefix: 'continue', onOpen: onOpenBook),
          const _Header('Recently updated'),
          _Rail(books: recent, prefix: 'recent', onOpen: onOpenBook),
        ],
      ),
    );
  }
}

class _Rail extends StatelessWidget {
  const _Rail({required this.books, required this.prefix, required this.onOpen});
  final List<ShelfBook> books;
  final String prefix;
  final void Function(String) onOpen;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 150,
      child: ListView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        children: [
          for (final b in books)
            Padding(
              padding: const EdgeInsets.all(4),
              child: InkWell(
                key: Key('$prefix-${b.bookId}'),
                onTap: () => onOpen(b.bookId),
                child: SizedBox(
                  width: 120,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Container(
                        height: 100,
                        width: 120,
                        color: Theme.of(context).colorScheme.surfaceContainerHighest,
                        child: const Icon(Icons.menu_book, size: 40),
                      ),
                      const SizedBox(height: 4),
                      Text(b.title,
                          maxLines: 1, overflow: TextOverflow.ellipsis),
                    ],
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header(this.label);
  final String label;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
        child: Text(label, style: Theme.of(context).textTheme.titleMedium),
      );
}
