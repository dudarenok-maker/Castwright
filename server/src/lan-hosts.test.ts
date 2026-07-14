import { describe, it, expect, vi } from 'vitest';

vi.mock('node:os', () => ({ networkInterfaces: vi.fn() }));
import { networkInterfaces } from 'node:os';
import { enumerateLanIps } from './lan-hosts.js';

describe('enumerateLanIps', () => {
  it('keeps non-internal IPv4, drops loopback / IPv6 / link-local', () => {
    vi.mocked(networkInterfaces).mockReturnValue({
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as never],
      eth0: [
        { address: '192.168.1.42', family: 'IPv4', internal: false } as never,
        { address: 'fe80::1', family: 'IPv6', internal: false } as never,
      ],
      wsl: [{ address: '169.254.10.5', family: 'IPv4', internal: false } as never],
      docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false } as never],
    });
    expect(enumerateLanIps()).toEqual(['192.168.1.42', '172.17.0.1']);
  });

  it('returns [] when there are no external IPv4 interfaces', () => {
    vi.mocked(networkInterfaces).mockReturnValue({
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as never],
    });
    expect(enumerateLanIps()).toEqual([]);
  });
});
