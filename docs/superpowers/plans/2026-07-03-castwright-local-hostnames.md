# Friendly LAN hostnames (castwright.local / castwright.dev.local) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the raw LAN-IP URLs `npm run dev:lan` / `npm run start:lan` print today with memorable, LAN-resolvable hostnames — `https://castwright.dev.local:5173` (Vite dev server) and `https://castwright.local:8443` (built Node bundle) — reachable from any mDNS-capable LAN device (iOS/Android/macOS), automatically, with no new manual step.

**Architecture:** A new custom mDNS responder (`scripts/mdns-responder.mjs`, using the `multicast-dns` package) answers A-record queries for the configured hostname with the dev box's single current primary LAN IPv4 address. `dev:lan` runs it as a third `concurrently` leg; `start:lan`'s responder is owned by the Node **server** itself (not the fire-and-forget `start-app-prod.mjs` launcher), spawned/reaped exactly like the existing TTS sidecar via the server's real `shutdown()` handler, gated by a `NODE_ENV=production` discriminator so the server-side spawn never double-fires during `dev:lan` (which also sets `LAN_HTTPS=1` for its server leg). Certificate coverage for both hostnames is additive configuration on the two cert-generation paths that already exist (`vite-plugin-mkcert`, `scripts/setup-lan-certs.mjs`).

**Tech Stack:** Node.js (ESM scripts + TypeScript server), `multicast-dns` (new dependency), Vite 8 (`vite-plugin-mkcert`), Express, `concurrently`, Vitest (server) + `node:test` (root scripts).

## Global Constraints

Copied verbatim (in effect) from `docs/superpowers/specs/2026-07-03-castwright-local-hostnames-design.md` (reviewed across 3 adversarial rounds — see its commit history). Every task below implicitly inherits these:

- **Scope:** only `npm run dev:lan` (→ `castwright.dev.local`) and `npm run start:lan` (→ `castwright.local`). Plain `npm run dev` / `npm run start` and the `npm start` + `server/.env` `LAN_HTTPS=1` path (`start-app.ps1`) are explicitly untouched — Non-goals in the spec.
- **No publicly-trusted certs** for these names (`.local` is RFC 6762 reserved) — always relies on the existing mkcert local root CA + its existing one-time per-device trust step (`npm run install:cert-mobile`).
- **No guaranteed Windows-LAN-peer resolution** — a known, documented gap; LAN-IP URL is always the fallback.
- **IPv4-only.** No AAAA/IPv6 records.
- **mDNS answers use a single "primary LAN IP"** (the OS's default-route interface, via the "connect a UDP socket to an external address, read back the local address" trick) — **never** `enumerateLanIps()` (that helper is correct for cert SANs, wrong for mDNS answers — see spec Component 1). This is a known, accepted best-effort limitation under VPN/dual-homed LANs, tracked as follow-up **ops-21** (issue [#1239](https://github.com/dudarenok-maker/Castwright/issues/1239)) — not part of this plan.
- **`start:lan`'s responder is server-owned**, gated on `lanHttps && process.env.NODE_ENV === 'production'` (NOT `lanHttps` alone — that would double-spawn during `dev:lan`, running an unwanted second, unowned `castwright.local` responder process that `dev:lan`'s `concurrently` never advertises or reaps — see the Task 4 file header for why this is about an unwanted extra process, not a literal port-5353 collision: `multicast-dns` binds with `reuseAddr: true` by default, so two responders on one box coexist rather than erroring). Spawned inside `listenerCallback` in `server/src/index.ts`, reaped in the existing `shutdown()` handler alongside `sidecarSupervisor?.stop()`.
- **`dev:lan`'s responder is a `concurrently` leg**, not server-owned.
- **Non-fatal everywhere:** a responder bind failure — realistically `EACCES` (permission denied) or multicast blocked by a firewall/OS policy, not a same-machine port conflict (see above) — must never take down `dev:lan` or `start:lan` — the existing LAN-IP URLs keep working exactly as today.
- **`multicast-dns` pinned to latest at implementation time** (`^7.2.5` as of this plan) — confirm current latest with `npm view multicast-dns version` before Task 1 Step 1, so this doesn't need an immediate follow-up bump.

---

## File Structure

**New files:**
- `scripts/mdns-responder.mjs` — the mDNS responder: `primaryLanIp()`, `buildAnswer()` (pure, exported, unit-tested) + a CLI entrypoint (`--name <hostname>`, repeatable) that wires them to the `multicast-dns` socket.
- `scripts/tests/mdns-responder.test.mjs` — `node:test` coverage for `primaryLanIp` / `buildAnswer`.
- `scripts/tests/setup-lan-certs.test.mjs` — `node:test` coverage for the new `buildCertHosts()` export (no existing test file for this script today).
- `server/src/mdns-owner.ts` — server-owned responder lifecycle: `shouldSpawnMdnsResponder()` (the `NODE_ENV` discriminator, pure) + `spawnMdnsResponder()` (spawn/kill wrapper), mirroring `bind-host.ts`'s scope and `spawn-sidecar.ts`'s injectable-dependency shape.
- `server/src/mdns-owner.test.ts` — Vitest coverage, mirroring `bind-host.test.ts`'s style.
- `docs/features/239-castwright-local-hostnames.md` — regression plan doc.

**Modified files:**
- `scripts/setup-lan-certs.mjs` — extract `buildCertHosts(ips)` (new export) and add `castwright.local` / `castwright.dev.local` to the mkcert SAN list.
- `vite.config.ts` — `mkcert({ hosts: ['castwright.dev.local'] })` + `server.allowedHosts`.
- `server/src/index.ts` — import + module-scoped handle + spawn call inside `listenerCallback` + kill call inside `shutdown()`.
- `package.json` — `multicast-dns` dependency; `dev:lan` gets a third `concurrently` leg AND its kill flag changes from `-k` to `--kill-others-on-fail` (see Task 6 — required so a graceful mDNS bind-failure exit doesn't take down the other two legs).
- `scripts/print-cert-install-instructions.mjs` — print the two new friendly URLs.
- `docs/features/INDEX.md`, `docs/release-notes-next.md`, `RELEASE_NOTES.md` — docs wrap-up.

---

### Task 1: `scripts/mdns-responder.mjs` — the mDNS responder

**Files:**
- Modify: `package.json` (add `multicast-dns` dependency)
- Create: `scripts/mdns-responder.mjs`
- Test: `scripts/tests/mdns-responder.test.mjs`

**Interfaces:**
- Produces: `primaryLanIp(createSocket?: () => Socket): Promise<string | null>`, `buildAnswer(queriedName: string, configuredHostnames: string[], primaryIp: string | null): Array<{name: string, type: 'A', ttl: number, data: string}> | null` — both exported from `scripts/mdns-responder.mjs`. No other task consumes these directly (the CLI wires them internally); Task 4/5 spawn this file as a **subprocess**, never import it.

- [ ] **Step 1: Confirm the latest `multicast-dns` version and add the dependency**

Run: `npm view multicast-dns version`
Expected: prints a version like `7.2.5` (or newer — use whatever it prints).

Open `package.json` and add the dependency in the `dependencies` block (alphabetical, between `html-to-image` and `qrcode` — matching the existing precedent of `qrcode`, itself a root-script runtime dependency, not a devDependency):

```json
    "html-to-image": "^1.11.13",
    "multicast-dns": "^7.2.5",
    "qrcode": "^1.5.4",
```

(Use the exact version `npm view` printed, not necessarily `7.2.5` verbatim.)

Run: `npm install`
Expected: installs cleanly, `package-lock.json` updates.

- [ ] **Step 2: Write the failing tests**

Create `scripts/tests/mdns-responder.test.mjs`:

```js
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test scripts/tests/mdns-responder.test.mjs`
Expected: FAIL — `Cannot find module '../mdns-responder.mjs'` (the file doesn't exist yet).

- [ ] **Step 4: Implement `scripts/mdns-responder.mjs`**

```js
#!/usr/bin/env node
/* Friendly LAN hostnames (castwright.local / castwright.dev.local) — mDNS
   responder. See docs/superpowers/specs/2026-07-03-castwright-local-hostnames-design.md.

   Answers standard mDNS A-record queries for the exact hostname(s) it was
   told to serve, with the OS's current primary LAN IPv4 address. Never
   answers for any other name. A bind failure — realistically EACCES or
   multicast blocked by a firewall/OS policy, NOT "another mDNS responder
   already has the port" (multicast-dns binds with reuseAddr:true, so
   same-box responders coexist rather than colliding) — is logged and the
   process exits 0 — non-fatal to the caller (dev:lan's concurrently leg, or
   the server's mdns-owner); the existing LAN-IP URL keeps working exactly
   as before this feature existed. */

import dgram from 'node:dgram';
import mdnsFactory from 'multicast-dns';

const ANSWER_TTL_SECONDS = 120;

/** The OS's current primary outbound IPv4 address (the interface it would
    use to reach an external address) — NOT every detected interface. This
    intentionally does NOT reuse enumerateLanIps() (scripts/setup-lan-certs.mjs):
    that helper returns every non-internal IPv4 interface, which is fine for
    a cert's SAN list (an extra SAN is inert) but wrong for an mDNS answer,
    where an extra A-record actively misdirects a client to whichever
    interface it picks (e.g. a Docker Desktop/WSL/VPN virtual adapter).

    Uses the standard "connect a UDP socket to an external address, read
    back the local address the OS bound" trick — no packets are actually
    sent (UDP connect() just consults the routing table). Resolves null if
    no route exists (e.g. the box is fully offline).

    Known limitation (accepted for v1, tracked as ops-21, issue #1239): this
    picks the OS's default-route interface, which can still be wrong under
    an active VPN or a dual-homed LAN. A misdirected connection just times
    out and the tester falls back to the existing LAN-IP URL — not a new
    failure mode. */
export function primaryLanIp(createSocket = () => dgram.createSocket('udp4')) {
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    const socket = createSocket();
    socket.once('error', () => {
      socket.close();
      finish(null);
    });
    try {
      socket.connect(80, '8.8.8.8', () => {
        const address = socket.address();
        socket.close();
        finish(address?.address ?? null);
      });
    } catch {
      finish(null);
    }
  });
}

/** Pure: build the mDNS answer array for a query, or null if this responder
    doesn't serve the queried name (or has no address to answer with). Every
    answer is a single A-record — this responder never returns more than
    one address per name (see primaryLanIp's known-limitation note above). */
export function buildAnswer(queriedName, configuredHostnames, primaryIp) {
  if (primaryIp === null) return null;
  if (!configuredHostnames.includes(queriedName)) return null;
  return [{ name: queriedName, type: 'A', ttl: ANSWER_TTL_SECONDS, data: primaryIp }];
}

function parseHostnames(argv) {
  const names = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--name' && argv[i + 1]) {
      names.push(argv[i + 1]);
      i++;
    }
  }
  return names;
}

async function main() {
  const hostnames = parseHostnames(process.argv.slice(2));
  if (hostnames.length === 0) {
    process.stderr.write('[mdns-responder] no --name given, nothing to serve\n');
    process.exit(1);
  }

  const mdns = mdnsFactory();

  /* Exit 0 (not a nonzero failure code) on a handled bind failure — dev:lan's
     `concurrently --kill-others-on-fail` (Task 6) only tears down the other
     legs on a NONZERO exit, so this graceful "I couldn't bind, moving on"
     path must not look like a crash to concurrently. An actual crash
     (uncaught exception) still exits nonzero and correctly signals a real
     problem.

     `multicast-dns` binds with `reuseAddr: true` by default, so a second
     responder on the same box does NOT collide on port 5353 — this only
     fires for a real bind failure (EACCES / a firewall or OS policy
     blocking multicast), not "another mDNS responder is already running". */
  mdns.once('error', (err) => {
    process.stderr.write(
      `[mdns-responder] could not bind (permission denied, or multicast blocked by a ` +
        `firewall/OS policy): ${err.message}\n` +
        `[mdns-responder] friendly hostname(s) [${hostnames.join(', ')}] will NOT resolve — ` +
        `the existing LAN-IP URL still works.\n`,
    );
    process.exit(0);
  });

  // Check hostname membership BEFORE touching the network — most inbound
  // mDNS traffic on a real LAN is for names this responder doesn't serve
  // (other devices' own advertisements), so primaryLanIp()'s socket
  // open/connect/close should only run for a query we're actually going to
  // answer, not for every foreign A-query the responder happens to see.
  mdns.on('query', async (query) => {
    for (const question of query.questions ?? []) {
      if (question.type !== 'A') continue;
      if (!hostnames.includes(question.name)) continue;
      const ip = await primaryLanIp();
      const answers = buildAnswer(question.name, hostnames, ip);
      if (answers) mdns.respond({ answers });
    }
  });

  process.stdout.write(`[mdns-responder] serving ${hostnames.join(', ')}\n`);
}

// CLI entrypoint — mirrors the invokedDirectly check scripts/setup-lan-certs.mjs
// already uses, so both scripts stay consistent.
if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('mdns-responder.mjs')
) {
  await main();
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test scripts/tests/mdns-responder.test.mjs`
Expected: PASS — 6 tests, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json scripts/mdns-responder.mjs scripts/tests/mdns-responder.test.mjs
git commit -m "feat(ops): add mDNS responder for friendly LAN hostnames"
```

---

### Task 2: `scripts/setup-lan-certs.mjs` — extend the mkcert SAN list

**Files:**
- Modify: `scripts/setup-lan-certs.mjs`
- Test: `scripts/tests/setup-lan-certs.test.mjs` (new — no existing test file for this script)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `buildCertHosts(ips: string[]): string[]` — exported from `scripts/setup-lan-certs.mjs`. Not consumed by any other task in this plan (Task 3's `vite.config.ts` change is independent — `vite-plugin-mkcert` manages its own cert via its own `hosts` option, per the spec's "independent code path" note).

- [ ] **Step 1: Write the failing tests**

Create `scripts/tests/setup-lan-certs.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/tests/setup-lan-certs.test.mjs`
Expected: FAIL — `buildCertHosts is not a function` (not exported yet).

- [ ] **Step 3: Implement `buildCertHosts` and wire it in**

In `scripts/setup-lan-certs.mjs`, add this new exported function directly after the existing `enumerateLanIps` export (so the two related host-list helpers sit together):

```js
/** The mkcert SAN list: localhost + loopback + the friendly hostnames
    (castwright.local / castwright.dev.local) + every detected LAN IPv4.
    An unused SAN is inert (unlike an mDNS answer, where returning every
    interface actively misdirects a client — see scripts/mdns-responder.mjs's
    primaryLanIp(), which deliberately does NOT reuse enumerateLanIps() for
    that reason). Extracted as a pure function so the hosts list is
    unit-testable without invoking the real mkcert binary. */
export function buildCertHosts(ips) {
  return ['localhost', '127.0.0.1', 'castwright.local', 'castwright.dev.local', ...ips];
}
```

Then find this existing block inside `setupLanCerts()`:

```js
  const ips = enumerateLanIps();
  const hosts = ['localhost', '127.0.0.1', ...ips];
  log(`generating cert for hosts: ${hosts.join(', ')}`);
```

Replace the middle line so it calls the new function:

```js
  const ips = enumerateLanIps();
  const hosts = buildCertHosts(ips);
  log(`generating cert for hosts: ${hosts.join(', ')}`);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/tests/setup-lan-certs.test.mjs`
Expected: PASS — 2 tests, 0 failures.

- [ ] **Step 5: Run the full hooks suite to confirm no regression**

Run: `npm run test:hooks`
Expected: PASS (this runs every `scripts/tests/*.test.mjs` file, including the two new ones).

- [ ] **Step 6: Commit**

```bash
git add scripts/setup-lan-certs.mjs scripts/tests/setup-lan-certs.test.mjs
git commit -m "feat(ops): add castwright.local/dev.local to the LAN cert SAN list"
```

---

### Task 3: `vite.config.ts` — dev-server cert + allowed-hosts

**Files:**
- Modify: `vite.config.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (independent config change).
- Produces: nothing consumed by later tasks — this is a leaf config change.

- [ ] **Step 1: Add `castwright.dev.local` to the mkcert plugin's hosts**

Find this line in `vite.config.ts`:

```ts
  const plugins: PluginOption[] = [react(), tailwindcss()];
  if (useHttps) plugins.push(mkcert());
```

Replace with:

```ts
  const plugins: PluginOption[] = [react(), tailwindcss()];
  // ops (castwright-local-hostnames) — castwright.dev.local joins the
  // plugin's default localhost + detected-IP SAN list (additive — confirmed
  // against the plugin's own README: "Custom hosts, default value is
  // `localhost` + `local ip addrs`").
  if (useHttps) plugins.push(mkcert({ hosts: ['castwright.dev.local'] }));
```

- [ ] **Step 2: Add `castwright.dev.local` to `server.allowedHosts`**

Find this block:

```ts
    server: {
      // Bind to IPv4 loopback by default. Vite 5 defaults to host:'localhost',
      // and on Node 18+ that resolves to ::1 (IPv6) only — Chrome on Windows
      // then burns its Happy-Eyeballs IPv4 timeout before falling back, so
      // the first paint stalls for several seconds. Pinning to 127.0.0.1
      // matches the Node + TTS sidecars (both loopback-only) and removes
      // the stall. `npm run dev:lan` overrides via CLI `--host 0.0.0.0`
      // for LAN access from mobile / tablet devices.
      host: '127.0.0.1',
      port: vitePort,
      open: !useHttps, // skip auto-open in LAN mode — user is on a mobile device
      proxy: {
```

Add one new key, `allowedHosts`, right after `open`:

```ts
      host: '127.0.0.1',
      port: vitePort,
      open: !useHttps, // skip auto-open in LAN mode — user is on a mobile device
      // ops (castwright-local-hostnames) — Vite 8's DNS-rebinding guard only
      // allows localhost/IP-literal Host headers by default; a bare hostname
      // needs to be listed explicitly. Only set in LAN mode — plain `npm run
      // dev` (loopback-only) is untouched.
      allowedHosts: useHttps ? ['castwright.dev.local'] : undefined,
      proxy: {
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS — no new type errors.

- [ ] **Step 4: Commit**

```bash
git add vite.config.ts
git commit -m "feat(ops): serve castwright.dev.local from the Vite LAN HTTPS dev server"
```

---

### Task 4: `server/src/mdns-owner.ts` — server-owned responder lifecycle

**Files:**
- Create: `server/src/mdns-owner.ts`
- Test: `server/src/mdns-owner.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks directly (spawns Task 1's `scripts/mdns-responder.mjs` as a subprocess by path, not by import).
- Produces: `shouldSpawnMdnsResponder(lanHttps: boolean, env?: NodeJS.ProcessEnv): boolean` and `spawnMdnsResponder(hostname: string, repoRoot: string, opts?: {spawnFn?: typeof spawn, warn?: (...args: unknown[]) => void, platform?: NodeJS.Platform}): MdnsResponderHandle | null`, where `interface MdnsResponderHandle { child: ChildProcess; kill: () => void }` — both exported from `server/src/mdns-owner.ts`. Task 5 imports both plus the `MdnsResponderHandle` type.

- [ ] **Step 1: Write the failing tests**

Create `server/src/mdns-owner.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { shouldSpawnMdnsResponder, spawnMdnsResponder } from './mdns-owner.js';

interface FakeChild extends EventEmitter {
  pid: number;
}

function makeFakeChild(pid = 4242): FakeChild {
  const ee = new EventEmitter() as FakeChild;
  ee.pid = pid;
  return ee;
}

describe('shouldSpawnMdnsResponder (ops — castwright-local-hostnames)', () => {
  it('is false when lanHttps is false, regardless of NODE_ENV', () => {
    expect(shouldSpawnMdnsResponder(false, { NODE_ENV: 'production' })).toBe(false);
  });

  it('is true for the start:lan shape: lanHttps=true AND NODE_ENV=production', () => {
    expect(shouldSpawnMdnsResponder(true, { NODE_ENV: 'production' })).toBe(true);
  });

  it('is false for the dev:lan server-leg shape: lanHttps=true but NODE_ENV unset — the exact double-spawn bug round-2 review caught', () => {
    expect(shouldSpawnMdnsResponder(true, {})).toBe(false);
  });

  it('is false when NODE_ENV is set but not production', () => {
    expect(shouldSpawnMdnsResponder(true, { NODE_ENV: 'development' })).toBe(false);
  });
});

describe('spawnMdnsResponder', () => {
  it('spawns node with the script path and --name flag', () => {
    const spawnFn = vi.fn(() => makeFakeChild());
    spawnMdnsResponder('castwright.local', '/repo', {
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      warn: vi.fn(),
    });
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnFn.mock.calls[0] as [string, string[]];
    expect(cmd).toBe(process.execPath);
    expect(args).toContain('--name');
    expect(args).toContain('castwright.local');
    expect(args[0]).toContain('mdns-responder.mjs');
  });

  it('returns null and warns when spawning throws', () => {
    const spawnFn = vi.fn(() => {
      throw new Error('ENOENT');
    });
    const warn = vi.fn();
    const handle = spawnMdnsResponder('castwright.local', '/repo', {
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      warn,
    });
    expect(handle).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns when the child exits nonzero shortly after spawn (e.g. a missing/broken script) instead of leaking a dead handle silently', () => {
    const child = makeFakeChild(4242);
    const spawnFn = vi.fn(() => child);
    const warn = vi.fn();
    const handle = spawnMdnsResponder('castwright.local', '/repo', {
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      warn,
    });
    expect(handle).not.toBeNull();
    child.emit('exit', 1, null);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('castwright.local');
  });

  it('does NOT warn on a clean exit(0) (the responder's own graceful bind-failure path)', () => {
    const child = makeFakeChild(4242);
    const spawnFn = vi.fn(() => child);
    const warn = vi.fn();
    spawnMdnsResponder('castwright.local', '/repo', {
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      warn,
    });
    child.emit('exit', 0, null);
    expect(warn).not.toHaveBeenCalled();
  });

  it('kill() on win32 shells out to taskkill /T /F /PID', () => {
    const child = makeFakeChild(4242);
    const spawnFn = vi.fn(() => child);
    const handle = spawnMdnsResponder('castwright.local', '/repo', {
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      warn: vi.fn(),
      platform: 'win32',
    });
    expect(handle).not.toBeNull();
    spawnFn.mockClear();
    handle!.kill();
    expect(spawnFn).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', '4242', '/T', '/F'],
      expect.objectContaining({ stdio: 'ignore' }),
    );
  });

  it('kill() on non-win32 sends SIGTERM directly to the child', () => {
    const child = makeFakeChild(4242);
    const killSpy = vi.fn();
    (child as unknown as { kill: typeof killSpy }).kill = killSpy;
    const spawnFn = vi.fn(() => child);
    const handle = spawnMdnsResponder('castwright.local', '/repo', {
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      warn: vi.fn(),
      platform: 'linux',
    });
    expect(handle).not.toBeNull();
    handle!.kill();
    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run src/mdns-owner.test.ts`
Expected: FAIL — `Cannot find module './mdns-owner.js'`.
(10 tests will be defined at this point — 4 for `shouldSpawnMdnsResponder`, 6 for `spawnMdnsResponder`.)

- [ ] **Step 3: Implement `server/src/mdns-owner.ts`**

```ts
/* Friendly LAN hostnames (ops — castwright-local-hostnames spec) — the
   server-owned mDNS responder for castwright.local.

   Spawns scripts/mdns-responder.mjs as a child process, following the same
   "server owns the child, the launcher does not" pattern already used for
   the TTS sidecar (spawn-sidecar.ts) — start-app-prod.mjs spawns the server
   itself detached and exits immediately, so it can't own anything with a
   lifecycle beyond its own.

   NODE_ENV, not LAN_HTTPS, is the discriminator: dev:lan ALSO sets
   LAN_HTTPS=1 for its server leg (so its own concurrently leg can serve
   castwright.dev.local), but must NOT also get a server-spawned
   castwright.local responder — that would spin up an extra, unwanted
   process for a hostname dev:lan never advertises, one that dev:lan's own
   `concurrently` doesn't own or reap on Ctrl+C (multicast-dns binds with
   reuseAddr:true, so this is NOT a port-5353 collision — both responders
   would happily coexist; the problem is the orphaned extra process, not a
   bind error). start-app-prod.mjs sets NODE_ENV=production on the server
   child's env; the server's plain `tsx watch` dev script never does.

   scripts/mdns-responder.mjs is intentionally NOT part of the release
   manifest (scripts/build-release-zip.mjs). To be precise about what DOES
   ship: `start:lan`'s own script + start-app-prod.mjs ARE in the manifest,
   so a packaged install can technically invoke `npm run start:lan` — but
   scripts/setup-lan-certs.mjs and scripts/print-cert-install-instructions.mjs
   (the ONLY way to generate the LAN cert) are NOT shipped, so that path was
   already a dead end before this feature: server/src/index.ts's own
   existing missing-cert check (`LAN_HTTPS=1 set but cert files are missing`)
   exits the process before ever reaching the mDNS spawn call added here. A
   packaged install genuinely running start:lan is a pre-existing, unrelated
   gap this plan doesn't touch — this responder simply follows the same
   dev-checkout-only boundary its cert-generation dependency already has. */

import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

export interface MdnsResponderHandle {
  child: ChildProcess;
  kill: () => void;
}

/** True only for the start:lan shape (lanHttps AND NODE_ENV=production) —
    false for dev:lan's server leg (lanHttps but NODE_ENV unset/dev), which
    already gets its own castwright.dev.local responder via the concurrently
    leg in package.json and must not also get a server-spawned one. */
export function shouldSpawnMdnsResponder(
  lanHttps: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return lanHttps && env.NODE_ENV === 'production';
}

/** Spawn scripts/mdns-responder.mjs as a child process advertising `hostname`.
    Never throws — a spawn failure is logged and returns null, matching the
    responder script's own "never fatal to the caller" contract. */
export function spawnMdnsResponder(
  hostname: string,
  repoRoot: string,
  opts: {
    spawnFn?: typeof spawn;
    warn?: (...args: unknown[]) => void;
    platform?: NodeJS.Platform;
  } = {},
): MdnsResponderHandle | null {
  const { spawnFn = spawn, warn = console.warn, platform = process.platform } = opts;
  const scriptPath = resolve(repoRoot, 'scripts', 'mdns-responder.mjs');

  let child: ChildProcess;
  try {
    child = spawnFn(process.execPath, [scriptPath, '--name', hostname], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch (err) {
    warn(`[mdns] failed to spawn responder for ${hostname}:`, err);
    return null;
  }

  child.once('error', (err) => {
    warn(`[mdns] responder for ${hostname} reported an error:`, err);
  });
  /* The 'error' handler above only catches a SYNCHRONOUS spawn throw (e.g.
     a bad node binary). A child that starts fine but then crashes (e.g.
     "Cannot find module" if the responder script or a dependency is
     missing) exits ASYNCHRONOUSLY with a nonzero code — without this, that
     failure is silent: the caller holds a handle to an already-dead child
     and is never told. A clean exit(0) (the responder's own graceful
     bind-failure path — see scripts/mdns-responder.mjs) is NOT a failure
     and does not warn. */
  child.once('exit', (code) => {
    if (code !== 0 && code !== null) {
      warn(`[mdns] responder for ${hostname} exited unexpectedly (code=${code})`);
    }
  });

  return {
    child,
    kill: () => {
      const pid = child.pid;
      if (typeof pid !== 'number') return;
      if (platform === 'win32') {
        spawnFn('taskkill', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } else {
        child.kill('SIGTERM');
      }
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run src/mdns-owner.test.ts`
Expected: PASS — 10 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add server/src/mdns-owner.ts server/src/mdns-owner.test.ts
git commit -m "feat(server): add server-owned mDNS responder lifecycle for start:lan"
```

---

### Task 5: Wire the server-owned responder into `server/src/index.ts`

**Files:**
- Modify: `server/src/index.ts`

**Interfaces:**
- Consumes: `shouldSpawnMdnsResponder`, `spawnMdnsResponder`, `type MdnsResponderHandle` from `./mdns-owner.js` (Task 4).
- Produces: nothing consumed by later tasks — this is the integration point.

- [ ] **Step 1: Import the new module**

Find this import block near the top of `server/src/index.ts`:

```ts
import {
  enforceSingleSidecarOwner,
  releaseSidecarOwnership,
} from './tts/sidecar-owner.js';
import { detectQwenInstallStateOnDisk } from './tts/qwen-install-detect.js';
```

Add a new import directly after it:

```ts
import {
  enforceSingleSidecarOwner,
  releaseSidecarOwnership,
} from './tts/sidecar-owner.js';
import { detectQwenInstallStateOnDisk } from './tts/qwen-install-detect.js';
import {
  shouldSpawnMdnsResponder,
  spawnMdnsResponder,
  type MdnsResponderHandle,
} from './mdns-owner.js';
```

- [ ] **Step 2: Add the module-scoped handle**

Find:

```ts
let sidecarSupervisor: SidecarSupervisor | null = null;
```

Add directly after it:

```ts
let sidecarSupervisor: SidecarSupervisor | null = null;
/* ops (castwright-local-hostnames) — mirrors sidecarSupervisor above: only
   ever set for start:lan (see shouldSpawnMdnsResponder), reaped in
   shutdown() alongside the sidecar. */
let mdnsResponderHandle: MdnsResponderHandle | null = null;
```

- [ ] **Step 3: Spawn the responder inside `listenerCallback`**

Find the end of `listenerCallback`:

```ts
  /* srv-2 — start the periodic per-book state.json backup sweep (no-op when
     disabled in user-settings). Timers are unref()'d so they never hold the
     process open on their own. */
  startBackupScheduler();
};
```

Add the spawn call directly before the closing `};`:

```ts
  /* srv-2 — start the periodic per-book state.json backup sweep (no-op when
     disabled in user-settings). Timers are unref()'d so they never hold the
     process open on their own. */
  startBackupScheduler();

  /* ops (castwright-local-hostnames) — server-owned castwright.local mDNS
     responder, start:lan only. NODE_ENV, not lanHttps, is the discriminator:
     dev:lan's server leg ALSO sets LAN_HTTPS=1 (so its Vite half can serve
     castwright.dev.local), so gating on lanHttps alone would spin up an
     extra, unwanted castwright.local responder here during dev:lan — a
     process dev:lan's own concurrently neither advertises nor reaps (NOT a
     port-5353 collision: multicast-dns binds with reuseAddr:true, so two
     responders on one box coexist rather than erroring). See mdns-owner.ts
     + the design spec. */
  if (shouldSpawnMdnsResponder(lanHttps)) {
    mdnsResponderHandle = spawnMdnsResponder('castwright.local', repoRoot);
  }
};
```

- [ ] **Step 4: Reap the responder in `shutdown()`**

Find (the full function, including its two existing comment blocks — match verbatim):

```ts
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  stopBackupScheduler();
  console.log(`[server] ${signal} received, tearing down sidecar...`);
  /* #1030 — release our :9000 ownership note so the next boot (or another
     stack) sees the port as free. No-op if we never claimed it (autoStart off)
     or a same-lineage reload already took it over. */
  releaseSidecarOwnership(runDir);
  /* stop() sets the supervisor's stopped flag BEFORE reaping the child, so the
     child's exit can't trigger a respawn race during shutdown. */
  const reap = sidecarSupervisor?.stop() ?? Promise.resolve();
  void reap.finally(() => process.exit(0));
}
```

Replace with (only the added `mdnsResponderHandle?.kill();` line — everything else unchanged):

```ts
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  stopBackupScheduler();
  console.log(`[server] ${signal} received, tearing down sidecar...`);
  /* #1030 — release our :9000 ownership note so the next boot (or another
     stack) sees the port as free. No-op if we never claimed it (autoStart off)
     or a same-lineage reload already took it over. */
  releaseSidecarOwnership(runDir);
  /* stop() sets the supervisor's stopped flag BEFORE reaping the child, so the
     child's exit can't trigger a respawn race during shutdown. */
  const reap = sidecarSupervisor?.stop() ?? Promise.resolve();
  mdnsResponderHandle?.kill();
  void reap.finally(() => process.exit(0));
}
```

- [ ] **Step 5: Typecheck and run the server test suite**

Run: `npm run typecheck`
Expected: PASS — no new type errors.

Run: `npm run test:server`
Expected: PASS — no regressions (this wiring has no dedicated test of its own; the logic it calls is already covered by `server/src/mdns-owner.test.ts` from Task 4).

- [ ] **Step 6: Commit**

```bash
git add server/src/index.ts
git commit -m "feat(server): spawn the castwright.local mDNS responder on start:lan boot"
```

---

### Task 6: `package.json` — wire the responder into `dev:lan`

**Files:**
- Modify: `package.json`

**Interfaces:**
- Consumes: `scripts/mdns-responder.mjs` (Task 1), invoked as a CLI, not imported.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the third `concurrently` leg and switch the kill flag**

Find:

```json
    "dev:lan": "cross-env VITE_HTTPS=1 concurrently -k -n frontend,server -c blue,magenta \"vite --host 0.0.0.0\" \"cross-env LAN_HTTPS=1 npm --prefix server run dev\"",
```

Replace with:

```json
    "dev:lan": "cross-env VITE_HTTPS=1 concurrently --kill-others-on-fail -n frontend,server,mdns -c blue,magenta,yellow \"vite --host 0.0.0.0\" \"cross-env LAN_HTTPS=1 npm --prefix server run dev\" \"node scripts/mdns-responder.mjs --name castwright.dev.local\"",
```

(`-k`/`--kill-others` tears down every leg the moment ANY leg exits, for ANY reason — including the mDNS responder's own graceful `process.exit(0)` on a handled bind failure, per Task 1 Step 4's comment. `--kill-others-on-fail` only tears the others down on a NONZERO exit, so a real crash in any of the three legs still correctly kills the rest, but a clean bind-failure exit from the responder no longer takes Vite and the server down with it.

This does mean the `frontend` and `server` legs also lose `-k`'s "tear the others down on ANY exit, including a clean one" behavior — in practice neither is expected to exit cleanly during normal `dev:lan` use (both are long-running dev servers), so this is a low-risk, largely theoretical trade-off, not a functional regression; called out here for completeness rather than left implicit. `--kill-signal`/`--kill-others-on-fail` only govern what `concurrently` does when ONE leg exits on its own — a direct Ctrl+C is delivered by the terminal to the whole process group regardless of that flag, so all three legs are expected to still exit together on Ctrl+C; this is exactly what Task 8's manual acceptance step 4 confirms on a real run rather than something asserted here as already proven.)

- [ ] **Step 2: Sanity-check the script is valid JSON and shells correctly**

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json', 'utf8')); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "feat(ops): serve castwright.dev.local from dev:lan (3rd concurrently leg)"
```

---

### Task 7: `scripts/print-cert-install-instructions.mjs` — surface the new URLs

**Files:**
- Modify: `scripts/print-cert-install-instructions.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing consumed by later tasks — terminal output only, no existing test file for this script (untested today; this plan doesn't add test infra for a print-only helper, matching existing precedent).

- [ ] **Step 1: Add the friendly-hostname lines to the LAN URLs section**

Find:

```js
rule('LAN URLs');
line(`Vite dev (HMR):     ${viteUrl}        (run with: npm run dev:lan)`);
line(`Node prod bundle:   ${nodeUrl}        (run with: npm run start:lan)`);
if (lanIps.length > 1) {
  line('');
  line(`Other LAN IPs:  ${lanIps.slice(1).join(', ')}`);
}
```

Replace with:

```js
rule('LAN URLs');
line(`Vite dev (HMR):     ${viteUrl}        (run with: npm run dev:lan)`);
line(`Node prod bundle:   ${nodeUrl}        (run with: npm run start:lan)`);
line('');
line('Friendly hostnames (same servers, once dev:lan / start:lan is running):');
line('  https://castwright.dev.local:5173   (Vite dev)');
line('  https://castwright.local:8443       (Node prod bundle)');
line('  iOS / Android / macOS resolve .local names automatically. A Windows LAN');
line('  peer may need Bonjour installed to resolve them — the LAN-IP URLs above');
line('  always work as a fallback.');
if (lanIps.length > 1) {
  line('');
  line(`Other LAN IPs:  ${lanIps.slice(1).join(', ')}`);
}
```

- [ ] **Step 2: Manually verify the output looks right**

Run: `npm run install:cert-mobile`
Expected: the "LAN URLs" section prints both the existing IP-based URLs AND the two new `castwright.dev.local` / `castwright.local` lines, followed by the Windows-peer note.

- [ ] **Step 3: Commit**

```bash
git add scripts/print-cert-install-instructions.mjs
git commit -m "docs(ops): print the friendly castwright.local URLs from install:cert-mobile"
```

---

### Task 8: Docs wrap-up + full verify

**Files:**
- Create: `docs/features/239-castwright-local-hostnames.md`
- Modify: `docs/features/INDEX.md`, `docs/release-notes-next.md`, `RELEASE_NOTES.md`

**Interfaces:**
- Consumes: nothing (documentation only).
- Produces: nothing.

- [ ] **Step 1: Create the regression plan doc**

Create `docs/features/239-castwright-local-hostnames.md`:

```markdown
---
status: active
shipped: null
owner: null
---

# Friendly LAN hostnames (castwright.local / castwright.dev.local)

> Status: active
> Key files: `scripts/mdns-responder.mjs`, `scripts/setup-lan-certs.mjs`, `server/src/mdns-owner.ts`, `server/src/index.ts`, `vite.config.ts`, `package.json` (`dev:lan`)
> URL surface: `https://castwright.dev.local:5173` (dev:lan), `https://castwright.local:8443` (start:lan)
> OpenAPI ops: none

## Benefit / Rationale

- **User:** LAN testing (phone/tablet) now uses a memorable, stable hostname instead of a raw IP that changes on every DHCP renewal.
- **Technical:** no new infrastructure — reuses the existing mkcert LAN-cert machinery (`scripts/setup-lan-certs.mjs`, `vite-plugin-mkcert`) and the existing server-owned child-process lifecycle pattern (mirrors the TTS sidecar).
- **Architectural:** establishes a "server owns its own LAN-facing helper processes, the fire-and-forget launcher does not" pattern (`server/src/mdns-owner.ts`) that any future LAN-mode helper process should follow instead of trying to hang off `start-app-prod.mjs`.

## Architectural impact

- **New seams:** `server/src/mdns-owner.ts` (`shouldSpawnMdnsResponder`, `spawnMdnsResponder`); `scripts/mdns-responder.mjs` (`primaryLanIp`, `buildAnswer`); `buildCertHosts()` export on `scripts/setup-lan-certs.mjs`.
- **Invariants preserved:** `dev:lan` / `start:lan` LAN-IP URLs are unaffected and remain the fallback in every failure mode (responder bind failure, stale cert, Windows LAN peer). Plain `npm run dev` / `npm run start` are untouched.
- **Migration story:** n/a — no persisted data shape changes.
- **Reversibility:** revert the `dev:lan` script line and the `shouldSpawnMdnsResponder` gate in `server/src/index.ts`; both hostnames simply stop resolving and the existing LAN-IP flow is unaffected. No cleanup needed elsewhere — a stale cert SAN entry or an unused `multicast-dns` dependency is harmless.

## Invariants to preserve

1. `shouldSpawnMdnsResponder` in `server/src/mdns-owner.ts` must stay gated on `lanHttps && NODE_ENV === 'production'`, not `lanHttps` alone — gating on `lanHttps` alone spins up an extra, unwanted `castwright.local` responder process during `dev:lan` (its server leg also sets `LAN_HTTPS=1`) that `dev:lan`'s own `concurrently` neither advertises nor reaps on Ctrl+C. (Not a literal port-5353 collision — `multicast-dns` binds with `reuseAddr:true`, so two responders on one box coexist rather than erroring; the harm is the orphaned extra process, not a bind failure.)
2. `scripts/mdns-responder.mjs`'s `primaryLanIp()` must stay a single address, never reuse `enumerateLanIps()` — that helper returns every non-internal IPv4 interface, correct for cert SANs (an unused SAN is inert) but wrong for an mDNS answer (an extra A-record can misdirect a client).
3. `dev:lan`'s `concurrently` invocation must keep `--kill-others-on-fail`, not `-k`/`--kill-others` — the mDNS leg's graceful bind-failure exit (code 0) must not be treated as a reason to tear down the Vite/server legs.

## Test plan

### Automated coverage

- `node:test` (`scripts/tests/mdns-responder.test.mjs`) — `primaryLanIp` resolves the OS-bound address or null on no-route; `buildAnswer` returns a single-address A-record for a configured hostname, null for an unconfigured one, null with no primary IP.
- `node:test` (`scripts/tests/setup-lan-certs.test.mjs`) — `buildCertHosts` always includes `localhost`/`127.0.0.1`/both friendly hostnames, appends detected LAN IPs after them.
- Vitest server (`server/src/mdns-owner.test.ts`) — `shouldSpawnMdnsResponder` pins the `NODE_ENV` discriminator (the dev:lan double-spawn regression case explicitly covered); `spawnMdnsResponder` pins the spawn args, the null-on-throw path, and both `kill()` branches (win32 `taskkill`, POSIX `SIGTERM`).

No e2e coverage — this is dev/LAN tooling, not shipped product behavior reachable from `npm run test:e2e`'s mock-mode Vite instance.

### Manual acceptance walkthrough

1. Run `npm run install:cert-mobile` (regenerates the LAN cert with the new SANs; one-time per LAN-IP change, same as today).
2. Run `npm run dev:lan`. Confirm the terminal shows three `concurrently` legs (`frontend`, `server`, `mdns`) all starting cleanly.
3. From a real phone/tablet on the same LAN (iOS or Android), browse to `https://castwright.dev.local:5173`. Expected: loads with no certificate warning (once the mkcert root CA is trusted on that device, per the existing `install:cert-mobile` flow), same app as the raw LAN-IP URL.
4. Stop `dev:lan` (Ctrl+C). Confirm all three processes exit.
5. Run `npm run build && npm run start:lan`. From the same phone/tablet, browse to `https://castwright.local:8443`. Expected: loads with no certificate warning.
6. Stop `start:lan` (Ctrl+C or `npm run stop:prod`). Confirm the server process AND the spawned mDNS responder child both exit (no orphaned `node scripts/mdns-responder.mjs` process left running — check via Task Manager / `ps`).
7. (Optional, confirms the non-fatal-degrade path) A real bind failure is hard to force on demand — `multicast-dns` binds with `reuseAddr:true`, so simply starting a second process on UDP :5353 does NOT reproduce a conflict (both coexist). Instead, temporarily edit `scripts/mdns-responder.mjs`'s `main()` to call `process.exit(0)` immediately after parsing `--name` (simulating the graceful bind-failure path without needing a real `EACCES`/blocked-multicast condition), then run `npm run dev:lan`. Expected: the `mdns` leg exits immediately with code 0; the `frontend` and `server` legs keep running unaffected (this is the exact behavior Task 6's `-k` → `--kill-others-on-fail` change exists to guarantee). Revert the temporary edit afterward.

## Out of scope

- Robust per-interface / multi-address mDNS answers under a VPN or dual-homed LAN — tracked as **ops-21** ([#1239](https://github.com/dudarenok-maker/Castwright/issues/1239)).
- The `npm start` + `server/.env` `LAN_HTTPS=1` path (`start-app.ps1`) — keeps today's LAN-IP-only behavior, no friendly hostname.
- Publicly-trusted certificates for `.local` names — impossible per RFC 6762 / CA/Browser Forum rules. See [`project_lan_public_cert_broker`] for the separate `lan.castwright.ai` effort that solves the zero-install-trust problem for a real (non-`.local`) domain.

## Ship notes

(Filled in once this PR merges.)
```

- [ ] **Step 2: Add the INDEX.md entry**

In `docs/features/INDEX.md`, under `### K. Cross-cutting invariants`, add a new bullet (placed after the `157 — Default-bind the HTTP server to loopback (srv-19)` entry, since both touch `server/src/index.ts`'s LAN-HTTPS boot path):

```markdown
- [239 — Friendly LAN hostnames (castwright.local / castwright.dev.local)](239-castwright-local-hostnames.md) — `active`. Replaces the raw LAN-IP URLs `dev:lan`/`start:lan` print with mDNS-resolved friendly hostnames — a new `scripts/mdns-responder.mjs` (using `multicast-dns`) answers A-record queries with the dev box's single current primary LAN IPv4 address (deliberately NOT `enumerateLanIps()`'s full interface list, which is safe for cert SANs but not for mDNS answers). `dev:lan` runs it as a third `concurrently` leg; `start:lan`'s responder is server-owned (`server/src/mdns-owner.ts`), spawned/reaped exactly like the TTS sidecar via the server's real `shutdown()` handler, gated on `NODE_ENV=production` so it never double-spawns during `dev:lan` (which also sets `LAN_HTTPS=1` for its server leg). Cert coverage is additive on the two existing mkcert paths (`vite-plugin-mkcert`, `scripts/setup-lan-certs.mjs`). Always degrades to the existing LAN-IP URL — a responder bind failure, a stale cert, or an unresolving Windows LAN peer are all non-fatal. Follow-up (more robust multi-address mDNS answers under VPN/dual-homed LANs) tracked as ops-21 (#1239).
```

- [ ] **Step 3: Append the technical release note**

In `docs/release-notes-next.md`, add a new bullet under the current in-progress `v1.10.0` section (append to the end of the existing bullet list, before the next `# Castwright` version heading):

```markdown
- **Friendly LAN hostnames.** `dev:lan`/`start:lan` now serve `https://castwright.dev.local:5173` / `https://castwright.local:8443` alongside the existing raw-IP URLs, via a new mDNS responder (`scripts/mdns-responder.mjs`) — no new manual step, resolves automatically from iOS/Android/macOS LAN devices. Plan [239](features/239-castwright-local-hostnames.md).
```

- [ ] **Step 4: Append the brand-voice release note**

In `RELEASE_NOTES.md`, add a new bullet to the top `# Castwright 1.10.0` section (append after the existing bullet list, before the `# Castwright 1.9.0` heading):

```markdown
- **A name instead of a number, on your own network.** Testing on your phone or tablet now points at `castwright.local` (or `castwright.dev.local` while developing) instead of a raw address that changes every time your router hands out a new one.
```

- [ ] **Step 5: Run the full verify battery**

Run: `npm run verify`
Expected: PASS — typecheck + all tests (including the new `scripts/tests/mdns-responder.test.mjs`, `scripts/tests/setup-lan-certs.test.mjs`, `server/src/mdns-owner.test.ts`) + e2e + build all green.

- [ ] **Step 6: Commit**

```bash
git add docs/features/239-castwright-local-hostnames.md docs/features/INDEX.md docs/release-notes-next.md RELEASE_NOTES.md
git commit -m "docs(docs): regression plan + release notes for friendly LAN hostnames"
```
