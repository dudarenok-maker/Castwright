import { describe, it, expect } from 'vitest';
import { parseCertIps, computeCertHealth } from './lan-cert-health.js';

describe('parseCertIps', () => {
  it('extracts IP SANs from the comma-joined subjectAltName string, ignoring DNS', () => {
    const san = 'DNS:localhost, IP Address:127.0.0.1, IP Address:192.168.1.42';
    expect(parseCertIps(san)).toEqual(['127.0.0.1', '192.168.1.42']);
  });
  it('returns [] for undefined', () => {
    expect(parseCertIps(undefined)).toEqual([]);
  });
});

describe('computeCertHealth', () => {
  const now = new Date('2026-07-14T00:00:00Z');
  const base = { certExists: true, keyExists: true, currentLanIps: [] as string[], now };

  it('missing when cert file absent', () => {
    expect(computeCertHealth({ ...base, certExists: false, parsed: null }).health).toBe('missing');
  });
  it('missing when key file absent', () => {
    expect(computeCertHealth({ ...base, keyExists: false, parsed: null }).health).toBe('missing');
  });
  it('missing when files present but unparseable (parsed null)', () => {
    expect(computeCertHealth({ ...base, parsed: null }).health).toBe('missing');
  });
  it('expired when notAfter is in the past', () => {
    const parsed = { notAfter: new Date('2020-01-01T00:00:00Z'), ips: ['192.168.1.42'] };
    expect(computeCertHealth({ ...base, parsed }).health).toBe('expired');
  });
  it('healthy when present, unexpired', () => {
    const parsed = { notAfter: new Date('2099-01-01T00:00:00Z'), ips: ['192.168.1.42'] };
    expect(computeCertHealth({ ...base, parsed }).health).toBe('healthy');
  });
  it('reports uncoveredIps but stays healthy when a current IP is not in SANs', () => {
    const parsed = { notAfter: new Date('2099-01-01T00:00:00Z'), ips: ['192.168.1.42'] };
    const r = computeCertHealth({ ...base, parsed, currentLanIps: ['192.168.1.42', '10.0.0.9'] });
    expect(r.health).toBe('healthy');
    expect(r.uncoveredIps).toEqual(['10.0.0.9']);
  });
  it('empty uncoveredIps when the cert is missing (nothing to compare)', () => {
    const r = computeCertHealth({ ...base, certExists: false, parsed: null, currentLanIps: ['10.0.0.9'] });
    expect(r.uncoveredIps).toEqual([]);
  });
});
