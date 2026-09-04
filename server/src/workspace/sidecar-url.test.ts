/* srv-21 — sidecar-URL SSRF guard. Validator unit tests + the resolver
   fallback (getResolvedSidecarUrl refuses a non-local URL). */

import { describe, it, expect, afterEach } from 'vitest';
import { isPrivateHostUrl } from './sidecar-url.js';
import { getResolvedSidecarUrl, _resetUserSettingsCache } from './user-settings.js';

describe('isPrivateHostUrl', () => {
  it('accepts loopback + private-range http(s) URLs', () => {
    for (const u of [
      'http://localhost:9000',
      'http://127.0.0.1:9000',
      'http://10.0.0.5:8080',
      'http://192.168.1.20:9000',
      'http://172.16.4.4:9000',
      'http://my-nas:9000',
      'http://box.local:9000',
    ]) {
      expect(isPrivateHostUrl(u), u).toBe(true);
    }
  });

  it('rejects public hosts and bad schemes', () => {
    for (const u of [
      'http://evil.example.com:9000',
      'https://8.8.8.8',
      'http://172.32.0.1',
      'ftp://localhost',
      'not a url',
      '',
    ]) {
      expect(isPrivateHostUrl(u), u).toBe(false);
    }
  });
});

describe('getResolvedSidecarUrl — srv-21 fallback', () => {
  const savedEnv = process.env.LOCAL_TTS_URL;
  const savedPort = process.env.LOCAL_TTS_PORT;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.LOCAL_TTS_URL;
    else process.env.LOCAL_TTS_URL = savedEnv;
    if (savedPort === undefined) delete process.env.LOCAL_TTS_PORT;
    else process.env.LOCAL_TTS_PORT = savedPort;
    _resetUserSettingsCache();
  });

  it('passes through a private-host URL', () => {
    // A distinctive private host + non-default port: distinguishable from
    // the derived-default fallback (http://127.0.0.1:9000), unlike a plain
    // loopback URL, which the fallback now also resolves to on its own —
    // that shape would pass even if LOCAL_TTS_URL were ignored entirely.
    _resetUserSettingsCache();
    process.env.LOCAL_TTS_URL = 'http://192.168.1.50:9123';
    expect(getResolvedSidecarUrl()).toBe('http://192.168.1.50:9123');
  });

  it('falls back to derived-port URL for a public-host URL', () => {
    // LOCAL_TTS_PORT deliberately non-default (9110, not 9000) and distinct
    // from the rejected URL's own port (1234) — if the srv-21 guard ever
    // regressed to a hardcoded fallback instead of actually deriving from
    // LOCAL_TTS_PORT, this would catch it (a fallback hardcoded to the
    // factory-default port would fail this assertion, whereas the prior
    // version of this test used LOCAL_TTS_PORT's factory default of 9000 for
    // both the rejected URL's port and the fallback's port, so it could not
    // tell a real derivation from a lucky coincidence).
    _resetUserSettingsCache();
    process.env.LOCAL_TTS_PORT = '9110';
    process.env.LOCAL_TTS_URL = 'http://evil.example.com:1234';
    expect(getResolvedSidecarUrl()).toBe('http://127.0.0.1:9110');
  });
});
