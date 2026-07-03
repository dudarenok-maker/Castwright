import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { buildAnswer, primaryLanIp } from '../mdns-responder.mjs';

function makeFakeSocket({ address = null, failConnect = false } = {}) {
  const ee = new EventEmitter();
  ee.connect = (_port, _host, cb) => {
    if (failConnect) {
      queueMicrotask(() => ee.emit('error', new Error('no route')));
      return;
    }
    queueMicrotask(cb);
  };
  ee.address = () => (address ? { address } : undefined);
  ee.close = () => {};
  return ee;
}

test('primaryLanIp: resolves the local address the OS bound for outbound traffic', async () => {
  const socket = makeFakeSocket({ address: '192.168.1.42' });
  const ip = await primaryLanIp(() => socket);
  assert.equal(ip, '192.168.1.42');
});

test('primaryLanIp: resolves null when the socket cannot connect (no route)', async () => {
  const socket = makeFakeSocket({ failConnect: true });
  const ip = await primaryLanIp(() => socket);
  assert.equal(ip, null);
});

test('buildAnswer: answers a single A-record for a configured hostname', () => {
  const answers = buildAnswer('castwright.dev.local', ['castwright.dev.local'], '192.168.1.42');
  assert.deepEqual(answers, [
    { name: 'castwright.dev.local', type: 'A', ttl: 120, data: '192.168.1.42' },
  ]);
});

test('buildAnswer: returns null for a hostname this responder does not serve', () => {
  const answers = buildAnswer('someone-else.local', ['castwright.dev.local'], '192.168.1.42');
  assert.equal(answers, null);
});

test('buildAnswer: returns null when there is no primary IP to answer with', () => {
  const answers = buildAnswer('castwright.dev.local', ['castwright.dev.local'], null);
  assert.equal(answers, null);
});

test('buildAnswer: never answers with more than one address (single-IP design, not enumerateLanIps())', () => {
  const answers = buildAnswer('castwright.local', ['castwright.local'], '10.0.0.5');
  assert.equal(answers.length, 1);
});

test('buildAnswer: matches a differently-cased queried name case-insensitively (RFC 6762)', () => {
  const answers = buildAnswer('Castwright.local', ['castwright.local'], '192.168.1.42');
  assert.deepEqual(answers, [
    { name: 'Castwright.local', type: 'A', ttl: 120, data: '192.168.1.42' },
  ]);
});
