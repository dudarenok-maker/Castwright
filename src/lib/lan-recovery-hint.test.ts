import { describe, it, expect, afterEach, vi } from 'vitest';
import { recoveryHint } from './lan-recovery-hint';

/* Three branches: loopback+known-port, loopback+no-port (the :443 forwarder
   path), and not-on-host (every other hostname — including castwright.local,
   which is NOT evidence of being on-host since every LAN device resolves it). */
describe('recoveryHint', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('names the port when on loopback with a known port', () => {
    vi.stubGlobal('location', { hostname: 'localhost', port: '8443' });
    expect(recoveryHint()).toBe(
      'Open https://localhost:8443 on this computer and use “Authorize this browser”.',
    );
  });

  it('127.0.0.1 also counts as loopback', () => {
    vi.stubGlobal('location', { hostname: '127.0.0.1', port: '8443' });
    expect(recoveryHint()).toBe(
      'Open https://localhost:8443 on this computer and use “Authorize this browser”.',
    );
  });

  it('[::1] also counts as loopback (what location.hostname reports for https://[::1]:8443)', () => {
    vi.stubGlobal('location', { hostname: '[::1]', port: '8443' });
    expect(recoveryHint()).toBe(
      'Open https://localhost:8443 on this computer and use “Authorize this browser”.',
    );
  });

  it('omits the port on loopback when the :443 forwarder hides it (location.port === "")', () => {
    vi.stubGlobal('location', { hostname: 'localhost', port: '' });
    expect(recoveryHint()).toBe(
      'Open Castwright on this computer and use “Authorize this browser” under Account → LAN access.',
    );
  });

  it('treats castwright.local as NOT on-host — every LAN device resolves it', () => {
    vi.stubGlobal('location', { hostname: 'castwright.local', port: '' });
    expect(recoveryHint()).toBe(
      'Open Castwright on the computer running it and use “Authorize this browser”, then reload here.',
    );
  });

  it('treats a bare LAN IP as not on-host', () => {
    vi.stubGlobal('location', { hostname: '192.168.1.9', port: '8443' });
    expect(recoveryHint()).toBe(
      'Open Castwright on the computer running it and use “Authorize this browser”, then reload here.',
    );
  });
});
