/* srv-33 — pure helpers (no IO): hash stability, valid-device lookup
   (timing-safe, revocation-aware), and redaction. */
import { describe, it, expect } from 'vitest';
import {
  hashToken,
  findValidDevice,
  redactDevice,
  type DeviceTokenRecord,
} from './device-tokens.js';

const future = new Date(Date.now() + 86_400_000).toISOString();
const past = new Date(Date.now() - 1000).toISOString();

function rec(over: Partial<DeviceTokenRecord> & { tokenHash: string }): DeviceTokenRecord {
  return {
    id: over.id ?? 'id1',
    label: over.label ?? 'Phone',
    tokenHash: over.tokenHash,
    createdAt: over.createdAt ?? '2026-06-07T00:00:00.000Z',
    expiresAt: over.expiresAt ?? future,
    lastSeenAt: over.lastSeenAt,
    revoked: over.revoked,
  };
}

describe('device-tokens (pure)', () => {
  it('hashToken is stable and differs per input', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
    expect(hashToken('abc')).toHaveLength(64); // sha256 hex
  });

  it('findValidDevice matches a non-revoked device by raw token', () => {
    const devices = [rec({ id: 'a', tokenHash: hashToken('tok-a') })];
    expect(findValidDevice(devices, 'tok-a')?.id).toBe('a');
    expect(findValidDevice(devices, 'wrong')).toBeNull();
  });

  it('findValidDevice ignores revoked devices', () => {
    const devices = [rec({ id: 'a', tokenHash: hashToken('tok-a'), revoked: true })];
    expect(findValidDevice(devices, 'tok-a')).toBeNull();
  });

  it('findValidDevice picks the right device among several', () => {
    const devices = [
      rec({ id: 'a', tokenHash: hashToken('tok-a') }),
      rec({ id: 'b', tokenHash: hashToken('tok-b') }),
    ];
    expect(findValidDevice(devices, 'tok-b')?.id).toBe('b');
  });

  it('redactDevice drops the token hash and normalises revoked', () => {
    const pub = redactDevice(rec({ id: 'a', tokenHash: hashToken('x') }));
    // toEqual is an exact match — proves no tokenHash (or any extra key) leaks.
    expect(pub).toEqual({
      id: 'a',
      label: 'Phone',
      createdAt: '2026-06-07T00:00:00.000Z',
      expiresAt: future,
      revoked: false,
    });
  });

  it('rejects an expired record', () => {
    const d = { id: '1', label: 'P', tokenHash: hashToken('tok'), createdAt: future, expiresAt: past };
    expect(findValidDevice([d], 'tok')).toBeNull();
  });

  it('rejects a record with no expiresAt (legacy → re-pair)', () => {
    const d = { id: '1', label: 'P', tokenHash: hashToken('tok'), createdAt: future };
    expect(findValidDevice([d], 'tok')).toBeNull();
  });

  it('honours an injected now', () => {
    const d = { id: '1', label: 'P', tokenHash: hashToken('tok'), createdAt: future, expiresAt: future };
    expect(findValidDevice([d], 'tok', Date.parse(future) + 1)).toBeNull();
    expect(findValidDevice([d], 'tok', Date.parse(future) - 1)).not.toBeNull();
  });
});
