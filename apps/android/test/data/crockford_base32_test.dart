import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/data/crockford_base32.dart';

void main() {
  test('matches the server known-vector', () {
    expect(crockfordBase32([0x01, 0x02, 0x03, 0x04, 0x05]), '04106105');
  });
  test('all-ones 5 bytes => ZZZZZZZZ', () {
    expect(crockfordBase32([0xff, 0xff, 0xff, 0xff, 0xff]), 'ZZZZZZZZ');
  });
  test('10 bytes => 16 chars', () {
    expect(crockfordBase32(List<int>.filled(10, 0)), '0000000000000000');
  });
}
