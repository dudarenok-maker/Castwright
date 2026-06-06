import { describe, it, expect } from 'vitest';
import { isPrivateHostUrl } from './sidecar-url';

describe('isPrivateHostUrl', () => {
  it('accepts loopback + private-range http(s) URLs', () => {
    for (const u of [
      'http://localhost:9000',
      'https://localhost',
      'http://127.0.0.1:9000',
      'http://10.0.0.5:8080',
      'http://192.168.1.20:9000',
      'http://172.16.4.4:9000',
      'http://172.31.255.255',
      'http://my-nas:9000', // bare LAN hostname
      'http://box.local:9000',
    ]) {
      expect(isPrivateHostUrl(u), u).toBe(true);
    }
  });

  it('rejects public hosts and bad schemes', () => {
    for (const u of [
      'http://evil.example.com:9000',
      'https://8.8.8.8',
      'http://172.32.0.1', // just outside 172.16/12
      'ftp://localhost',
      'file:///etc/passwd',
      'not a url',
      '',
    ]) {
      expect(isPrivateHostUrl(u), u).toBe(false);
    }
  });
});
