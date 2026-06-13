import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Mirrors the web app's "no retired tagline survives anywhere" guard (#706).
/// `flutter test` runs with the package root (apps/android) as cwd, so `lib/`
/// resolves directly.
void main() {
  test('no retired tagline or banned brand words survive in lib/', () {
    const banned = <String>[
      'effortlessly',
      'even in your own voice',
      'seamless',
    ];
    final offenders = <String>[];
    for (final entity in Directory('lib').listSync(recursive: true)) {
      if (entity is! File || !entity.path.endsWith('.dart')) continue;
      final text = entity.readAsStringSync().toLowerCase();
      for (final phrase in banned) {
        if (text.contains(phrase)) offenders.add('${entity.path}: "$phrase"');
      }
    }
    expect(
      offenders,
      isEmpty,
      reason: 'retired brand copy found:\n${offenders.join('\n')}',
    );
  });
}
