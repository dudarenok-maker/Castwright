import { describe, it, expect } from 'vitest';
import { selectBindHost } from './bind-host.js';

describe('selectBindHost (srv-19)', () => {
  it('binds loopback (127.0.0.1) by default in plain-HTTP mode', () => {
    expect(selectBindHost(false, {})).toBe('127.0.0.1');
  });

  it('binds all interfaces (0.0.0.0) in LAN HTTPS mode', () => {
    expect(selectBindHost(true, {})).toBe('0.0.0.0');
  });

  it('LAN HTTPS mode ignores BIND_HOST/HOST (always all interfaces)', () => {
    expect(selectBindHost(true, { BIND_HOST: '127.0.0.1', HOST: '127.0.0.1' })).toBe('0.0.0.0');
  });

  it('honours BIND_HOST override in plain-HTTP mode', () => {
    expect(selectBindHost(false, { BIND_HOST: '0.0.0.0' })).toBe('0.0.0.0');
  });

  it('honours HOST override in plain-HTTP mode', () => {
    expect(selectBindHost(false, { HOST: '192.168.1.50' })).toBe('192.168.1.50');
  });

  it('BIND_HOST takes precedence over HOST', () => {
    expect(selectBindHost(false, { BIND_HOST: '0.0.0.0', HOST: '10.0.0.1' })).toBe('0.0.0.0');
  });
});
