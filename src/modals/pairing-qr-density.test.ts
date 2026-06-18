import { describe, it, expect } from 'vitest';
import QRCode from 'qrcode';

/* Regression for the real-phone pairing-scan failure (2026-06-10), re-anchored
   for app-17. The pairing QR is now a verified deep-link URL
   (https://www.castwright.ai/pair?h=…&c=…&f=…) so the phone's STOCK camera can
   auto-open the app. The bound is no longer zxing-cpp's ≤ v4 ceiling — stock-
   camera / in-app ML Kit decode far denser codes — but we still lock the
   density so the payload can never silently bloat back toward the unscannable
   JSON that broke the original (measured v9). The worst-case URL measures v6
   (41×41) with the 128-bit (26-char) fp-tag; ≤ v7 leaves headroom. QRCode
   options (errorCorrectionLevel 'M') mirror the modal's QRCode.toDataURL in
   pair-device.tsx.
   Spec: docs/superpowers/specs/2026-06-18-app-17-deeplink-pairing-launch-design.md */
describe('pairing QR density (scan-failure regression)', () => {
  // Worst-case realistic payload: longest IPv4 + port (LAN host is IPv4-only,
  // enumerateLanUrls filters family !== 'IPv4'), 8-char code, 26-char fpTag.
  const urlPayload =
    'https://www.castwright.ai/pair?h=255.255.255.255%3A8443&c=K7QF3M2P&f=1CR5AYMZRKMGWCTRFPHCFV0H6R';

  it('encodes to a stock-camera-comfortable QR (≤ v7) at EC-M', () => {
    const qr = QRCode.create(urlPayload, { errorCorrectionLevel: 'M' });
    expect(qr.version).toBeLessThanOrEqual(7);
  });

  it('stays strictly smaller than the retired JSON payload', () => {
    const retiredJson = JSON.stringify({
      url: 'https://255.255.255.255:8443',
      token: 'Q'.repeat(32),
      caFingerprint: Array.from({ length: 32 }, () => 'AB').join(':'),
    });
    const retiredVersion = QRCode.create(retiredJson, { errorCorrectionLevel: 'M' }).version;
    const urlVersion = QRCode.create(urlPayload, { errorCorrectionLevel: 'M' }).version;
    expect(urlVersion).toBeLessThan(retiredVersion);
  });
});
