import 'package:castwright/src/demo/demo_pairing_store.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('returns a canned paired server + non-empty caPem', () async {
    final store = DemoPairingStore();
    final server = await store.load();
    expect(server, isNotNull);
    expect(server!.url, isNotEmpty);
    expect(await store.loadCaPem(), isNotEmpty);
  });
}
