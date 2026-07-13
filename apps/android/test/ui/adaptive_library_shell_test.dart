import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/demo/demo_runtime.dart';
import 'package:castwright/src/data/file_store.dart';
import 'package:castwright/src/ui/adaptive_library_shell.dart';
import 'package:castwright/src/ui/library_pane.dart';

class _SpyObserver extends NavigatorObserver {
  _SpyObserver(this.pushes);
  final List<Route<dynamic>> pushes;
  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) {
    pushes.add(route);
  }
}

void main() {
  Future<void> pumpAt(WidgetTester tester, double logicalWidth, Widget child,
      {NavigatorObserver? observer}) async {
    tester.view.physicalSize = Size(logicalWidth, 800);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(MaterialApp(
      navigatorObservers: observer != null ? [observer] : const [],
      home: Scaffold(body: child),
    ));
    await tester.pumpAndSettle();
  }

  Widget buildShell() {
    return FutureBuilder(
      future: buildDemoRuntime(fs: InMemoryFileStore(), root: '/demo'),
      builder: (context, snap) {
        if (!snap.hasData) return const SizedBox();
        final runtime = snap.data!;
        final activeBook = ActiveBook();
        return AdaptiveLibraryShell(
          runtime: runtime,
          activeBook: activeBook,
          libraryPane: Builder(builder: (context) {
            return ListView(
              children: [
                ListTile(
                  key: const Key('book-x'),
                  title: const Text('Book X'),
                  onTap: () => activeBook.select('hollow-tide-1', title: 'The Drowning Bell'),
                ),
              ],
            );
          }),
        );
      },
    );
  }

  testWidgets('two-pane at ≥840 dp', (tester) async {
    await pumpAt(tester, 1000, buildShell());
    expect(find.byKey(const Key('adaptive-two-pane')), findsOneWidget);
    // empty detail pane before selection:
    expect(find.text('Select a book to start listening'), findsOneWidget);
  });

  testWidgets('single-pane below 840 dp', (tester) async {
    await pumpAt(tester, 700, buildShell());
    expect(find.byKey(const Key('adaptive-two-pane')), findsNothing);
  });

  testWidgets('two-pane select fills detail with no route push', (tester) async {
    final pushes = <Route<dynamic>>[];
    final observer = _SpyObserver(pushes);
    await pumpAt(tester, 1000, buildShell(), observer: observer);
    pushes.clear(); // drop the initial route push
    await tester.tap(find.byKey(const Key('book-x')));
    await tester.pumpAndSettle();
    expect(pushes, isEmpty); // filled the pane, did not push PlayerScreen
  });
}
