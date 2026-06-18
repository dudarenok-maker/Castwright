/* srv-33 (plan 188) — per-device access tokens for the companion, layered on
   srv-20's shared-secret guard.

   srv-20 enables LAN auth via a single shared secret (LAN_AUTH_TOKEN). srv-33
   adds individually-revocable per-device tokens that the guard ALSO accepts —
   so you can hand a token to a phone and later revoke just that phone without
   rotating the shared secret for every device. Backward-compatible: the shared
   secret keeps working unchanged.

   Storage: one workspace-level JSON file (device-tokens.json). We persist only
   the SHA-256 of each token (never the raw token — minted once, shown once).
   An in-memory cache keeps the guard SYNCHRONOUS (no async middleware), loaded
   lazily and refreshed on every mutation. */

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { deviceTokensJsonPath } from './paths.js';
import { writeJsonAtomic } from './state-io.js';

export interface DeviceTokenRecord {
  id: string;
  label: string;
  /** SHA-256 hex of the raw token. The raw token is never stored. */
  tokenHash: string;
  createdAt: string;
  lastSeenAt?: string;
  revoked?: boolean;
}

/** Device record minus the secret hash — safe to return from the API. */
export interface PublicDevice {
  id: string;
  label: string;
  createdAt: string;
  lastSeenAt?: string;
  revoked: boolean;
}

interface DeviceTokensFile {
  schema: 1;
  devices: DeviceTokenRecord[];
}

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Find the non-revoked device whose token hash matches `rawToken`, comparing
 *  hashes with a timing-safe equal. Pure — no IO. */
export function findValidDevice(
  devices: readonly DeviceTokenRecord[],
  rawToken: string,
): DeviceTokenRecord | null {
  const h = Buffer.from(hashToken(rawToken));
  for (const d of devices) {
    if (d.revoked) continue;
    const dh = Buffer.from(d.tokenHash);
    if (dh.length === h.length && timingSafeEqual(dh, h)) return d;
  }
  return null;
}

export function redactDevice(d: DeviceTokenRecord): PublicDevice {
  return {
    id: d.id,
    label: d.label,
    createdAt: d.createdAt,
    ...(d.lastSeenAt !== undefined ? { lastSeenAt: d.lastSeenAt } : {}),
    revoked: d.revoked === true,
  };
}

/* --- IO + in-memory cache ------------------------------------------------- */

let cache: DeviceTokenRecord[] | null = null;

function loadSync(): DeviceTokenRecord[] {
  if (cache) return cache;
  const path = deviceTokensJsonPath();
  if (!existsSync(path)) return (cache = []);
  try {
    const f = JSON.parse(readFileSync(path, 'utf8')) as DeviceTokensFile;
    cache = Array.isArray(f.devices) ? f.devices : [];
  } catch {
    cache = [];
  }
  return cache;
}

async function persist(devices: DeviceTokenRecord[]): Promise<void> {
  cache = devices;
  await writeJsonAtomic(deviceTokensJsonPath(), { schema: 1, devices });
}

/** Sync token check used by the LAN guard (cache-backed). */
export function isValidDeviceToken(rawToken: string): boolean {
  return findValidDevice(loadSync(), rawToken) !== null;
}

/** Mint a new per-device token. Returns the raw token ONCE (only its hash is
 *  stored); callers must surface it to the user immediately. */
export async function createDevice(
  label: string,
): Promise<{ device: PublicDevice; token: string }> {
  const devices = [...loadSync()];
  const token = randomBytes(32).toString('hex');
  const record: DeviceTokenRecord = {
    id: randomBytes(8).toString('hex'),
    label: label.trim().slice(0, 64) || 'Device',
    tokenHash: hashToken(token),
    createdAt: new Date().toISOString(),
  };
  devices.push(record);
  await persist(devices);
  return { device: redactDevice(record), token };
}

/** Revoke a device by id. Returns false if no such device. */
export async function revokeDevice(id: string): Promise<boolean> {
  const devices = loadSync();
  const idx = devices.findIndex((d) => d.id === id);
  if (idx < 0) return false;
  const next = devices.map((d, i) => (i === idx ? { ...d, revoked: true } : d));
  await persist(next);
  return true;
}

export function listDevices(): PublicDevice[] {
  return loadSync().map(redactDevice);
}

/** Test hook — clears the in-memory cache so a fresh workspace is re-read. */
export function _resetDeviceTokenCacheForTests(): void {
  cache = null;
}
