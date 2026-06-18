import 'dart:io';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('pairing autoVerify filter declares www host only (apex would sink pre-31 verify)', () {
    final xml = File('android/app/src/main/AndroidManifest.xml').readAsStringSync();
    expect(xml.contains('android:autoVerify="true"'), isTrue);
    expect(xml.contains('android:host="www.castwright.ai"'), isTrue);
    expect(xml.contains('android:pathPrefix="/pair"'), isTrue);
    // The bare apex must NOT be declared: on minSdk 24 (pre-API-31) autoVerify is
    // all-or-nothing, and the apex 301-forwards (no assetlinks) so it can't verify.
    // (host="castwright.ai" with a leading quote won't match host="www.castwright.ai".)
    expect(xml.contains('android:host="castwright.ai"'), isFalse);
  });
}
