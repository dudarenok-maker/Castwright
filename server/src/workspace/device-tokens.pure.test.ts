/* srv-33 — pure helpers (no IO): hash stability, valid-device lookup
   (timing-safe, revocation-aware), and redaction. */
import { describe, it, expect } from 'vitest';
import {
  hashToken,
  findValidDevice,
  redactDevice,
  clampTtlDays,
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

  // srv-2144 — Date.parse(expiresAt) is NaN for these shapes, and every
  // comparison against NaN is false, so a bare `>` check lets them through.
  // Each shape gets its own assertion so a future regression pins to the
  // specific input rather than one representative case.
  it('rejects expiresAt: null (e.g. a JSON round-trip or hand-edited store)', () => {
    const d = {
      id: '1',
      label: 'P',
      tokenHash: hashToken('tok'),
      createdAt: future,
      expiresAt: null as unknown as string,
    };
    expect(findValidDevice([d], 'tok')).toBeNull();
  });

  it('rejects expiresAt: "" (empty string)', () => {
    const d = { id: '1', label: 'P', tokenHash: hashToken('tok'), createdAt: future, expiresAt: '' };
    expect(findValidDevice([d], 'tok')).toBeNull();
  });

  it('rejects expiresAt: "garbage" (unparseable string)', () => {
    const d = {
      id: '1',
      label: 'P',
      tokenHash: hashToken('tok'),
      createdAt: future,
      expiresAt: 'garbage',
    };
    expect(findValidDevice([d], 'tok')).toBeNull();
  });

  it('accepts a valid future ISO expiresAt', () => {
    const d = { id: '1', label: 'P', tokenHash: hashToken('tok'), createdAt: future, expiresAt: future };
    expect(findValidDevice([d], 'tok')?.id).toBe('1');
  });

  it('honours an injected now', () => {
    const d = { id: '1', label: 'P', tokenHash: hashToken('tok'), createdAt: future, expiresAt: future };
    expect(findValidDevice([d], 'tok', Date.parse(future) + 1)).toBeNull();
    expect(findValidDevice([d], 'tok', Date.parse(future) - 1)).not.toBeNull();
  });

  // #2149 — Buffer.from(tokenHash) throws a TypeError for every non-string
  // primitive/object (verified: 123, null, undefined, {}, true all throw;
  // only an array-of-strings survives). findValidDevice runs in the
  // SYNCHRONOUS auth guard, so an unguarded throw here doesn't just fail to
  // authenticate the bad record — it aborts the loop for every record AFTER
  // it. That is a live availability defect, not only a hardening gap.
  //
  // This is the decisive regression test: the good record sits AFTER the
  // malformed one. A "fix" that only skips a bad tokenHash when it happens
  // to be the last entry would still pass a same-position test and still
  // brick every later device — so it must not be trusted here.
  it('findValidDevice skips a non-string tokenHash without throwing, and still matches a later good record', () => {
    const bad = {
      id: 'bad',
      label: 'P',
      tokenHash: 123 as unknown as string,
      createdAt: future,
      expiresAt: future,
    };
    const good = {
      id: 'good',
      label: 'P',
      tokenHash: hashToken('tok-good'),
      createdAt: future,
      expiresAt: future,
    };
    expect(() => findValidDevice([bad, good], 'tok-good')).not.toThrow();
    expect(findValidDevice([bad, good], 'tok-good')?.id).toBe('good');
  });

  it('findValidDevice skips other non-string tokenHash shapes without throwing (null, undefined, object, boolean)', () => {
    const shapes: unknown[] = [null, undefined, { a: 1 }, true];
    for (const shape of shapes) {
      const bad = {
        id: 'bad',
        label: 'P',
        tokenHash: shape as unknown as string,
        createdAt: future,
        expiresAt: future,
      };
      expect(() => findValidDevice([bad], 'anything')).not.toThrow();
      expect(findValidDevice([bad], 'anything')).toBeNull();
    }
  });
});

describe('clampTtlDays', () => {
  it('falls back to the 365-day default for a non-number or non-integer', () => {
    expect(clampTtlDays('nonsense')).toBe(365);
    expect(clampTtlDays(undefined)).toBe(365);
    expect(clampTtlDays(null)).toBe(365);
    expect(clampTtlDays(1.5)).toBe(365);
    expect(clampTtlDays(Number.NaN)).toBe(365);
  });

  // Clamps to the NEAREST bound, both directions. An operator hand-editing a
  // stored override to 0 is trying to shorten the lifetime; returning the
  // default would hand them the longest one instead.
  it('clamps below the floor up to 1, not to the default', () => {
    expect(clampTtlDays(0)).toBe(1);
    expect(clampTtlDays(-1)).toBe(1);
    expect(clampTtlDays(-100_000)).toBe(1);
  });

  it('clamps above the ceiling down to 400', () => {
    expect(clampTtlDays(401)).toBe(400);
    expect(clampTtlDays(100_000)).toBe(400);
  });

  it('passes an in-range value through untouched', () => {
    expect(clampTtlDays(1)).toBe(1);
    expect(clampTtlDays(30)).toBe(30);
    expect(clampTtlDays(365)).toBe(365);
    expect(clampTtlDays(400)).toBe(400);
  });

  // Links the two literal 365s that now live in different files. Paired with
  // registry.test.ts's literal assertion below, this is not a tautology: one
  // side is pinned to a literal there, so a future default change that misses
  // this fallback fails here.
  it('its fallback equals the registry default', async () => {
    const { KNOBS } = await import('../config/registry.js');
    const knob = KNOBS.find((k) => k.key === 'lan.deviceTokenTtlDays');
    expect(clampTtlDays('not-a-number')).toBe(knob?.default);
  });
});
