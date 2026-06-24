import { describe, it, expect } from 'vitest';
import { serverLoopbackBaseUrl } from './loopback-url.js';

describe('serverLoopbackBaseUrl', () => {
  it('uses plain http on PORT by default', () => {
    expect(serverLoopbackBaseUrl({ PORT: '8080' })).toBe('http://127.0.0.1:8080');
  });
  it('uses https on LAN_HTTPS_PORT when LAN_HTTPS is set', () => {
    expect(serverLoopbackBaseUrl({ LAN_HTTPS: '1', LAN_HTTPS_PORT: '8443' })).toBe(
      'https://127.0.0.1:8443',
    );
  });
  it('falls back to default ports', () => {
    expect(serverLoopbackBaseUrl({})).toBe('http://127.0.0.1:8080');
    expect(serverLoopbackBaseUrl({ LAN_HTTPS: 'true' })).toBe('https://127.0.0.1:8443');
  });
});
