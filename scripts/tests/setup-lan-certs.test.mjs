import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCertHosts } from '../setup-lan-certs.mjs';

test('buildCertHosts: always includes localhost + loopback + the friendly hostnames', () => {
  const hosts = buildCertHosts([]);
  assert.deepEqual(hosts, ['localhost', '127.0.0.1', 'castwright.local', 'castwright.dev.local']);
});

test('buildCertHosts: appends every detected LAN IP after the fixed entries', () => {
  const hosts = buildCertHosts(['192.168.1.42', '10.0.0.5']);
  assert.deepEqual(hosts, [
    'localhost',
    '127.0.0.1',
    'castwright.local',
    'castwright.dev.local',
    '192.168.1.42',
    '10.0.0.5',
  ]);
});
