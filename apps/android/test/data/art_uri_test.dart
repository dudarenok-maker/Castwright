import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/data/art_uri.dart';

void main() {
  group('carArtUri', () {
    test('builds a content:// URI the AA host can read for the art provider', () {
      final uri = carArtUri('/data/app_flutter/companion/thumbs/b1.jpg')!;
      expect(uri.scheme, 'content');
      expect(uri.host, 'ai.castwright.art');
      // The original file path round-trips through the query (provider decodes it).
      expect(uri.queryParameters['path'],
          '/data/app_flutter/companion/thumbs/b1.jpg');
    });

    test('is null for a null or empty path', () {
      expect(carArtUri(null), isNull);
      expect(carArtUri(''), isNull);
    });
  });
}
