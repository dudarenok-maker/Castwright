import 'dart:io';

import 'package:integration_test/integration_test_driver_extended.dart';

/// `flutter drive` runs with CWD = apps/android, so resolve the repo root
/// (../../) and write the marketing PNGs to the git-ignored mockups tree.
Future<void> main() async {
  await integrationDriver(
    onScreenshot: (String name, List<int> bytes, [Map<String, Object?>? args]) async {
      final file = File('../../mockups/marketing-screens/companion/$name.png');
      await file.create(recursive: true);
      await file.writeAsBytes(bytes);
      return true;
    },
  );
}
