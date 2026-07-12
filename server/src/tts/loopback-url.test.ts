import { describe, it, expect, afterEach } from 'vitest';
import { serverLoopbackBaseUrl } from './loopback-url.js';
import { setLanRuntime } from '../lan-runtime.js';

describe('serverLoopbackBaseUrl', () => {
  afterEach(() => {
    setLanRuntime({ httpsActive: false, port: 8080 }); // module default
  });

  it('uses plain http on the bound port when HTTPS is not active', () => {
    setLanRuntime({ httpsActive: false, port: 8080 });
    expect(serverLoopbackBaseUrl()).toBe('http://127.0.0.1:8080');
  });

  it('uses https on the bound LAN port when HTTPS is active', () => {
    setLanRuntime({ httpsActive: true, port: 8443 });
    expect(serverLoopbackBaseUrl()).toBe('https://127.0.0.1:8443');
  });

  it('the regression: LAN requested but degraded to HTTP → callback targets the ACTUAL http port, not :8443', () => {
    // LAN_HTTPS=1 requested, but certs were missing so the server bound loopback HTTP
    process.env.LAN_HTTPS = '1';
    setLanRuntime({ httpsActive: false, port: 8080 });
    expect(serverLoopbackBaseUrl()).toBe('http://127.0.0.1:8080');
    delete process.env.LAN_HTTPS;
  });
});
