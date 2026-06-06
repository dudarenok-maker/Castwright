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
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.LOCAL_TTS_URL;
    else process.env.LOCAL_TTS_URL = savedEnv;
    _resetUserSettingsCache();
  });

  it('passes through a private-host URL', () => {
    _resetUserSettingsCache();
    process.env.LOCAL_TTS_URL = 'http://127.0.0.1:9000';
    expect(getResolvedSidecarUrl()).toBe('http://127.0.0.1:9000');
  });

  it('falls back to the default for a public-host URL', () => {
    _resetUserSettingsCache();
    process.env.LOCAL_TTS_URL = 'http://evil.example.com:9000';
    expect(getResolvedSidecarUrl()).toBe('http://localhost:9000');
  });
});
