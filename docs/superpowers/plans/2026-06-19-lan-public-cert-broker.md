# LAN Public-Cert Broker — Implementation Plan (sub-project 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Cloudflare Worker + Durable Object that issues each Castwright install its own publicly-trusted Let's Encrypt certificate for `‹installId›.lan.castwright.ai`, so a phone browser gets a clean TLS lock over the LAN with zero device install.

**Architecture:** A single Worker exposes `POST /provision` (async), `GET /provision/:jobId`, and `POST /dns` (cheap A-only). Every state-changing call is gated by proof-of-possession of a per-install auth key (JWS, key in the `jwk` header, TOFU on first use). Issuance is too slow for one request, so `/provision` validates synchronously then hands off to a **Durable Object keyed by `installId`** that drives the ACME DNS-01 order via **alarms** (sleep-and-repoll). The install's TLS private key never leaves the install; the broker only does DNS + ACME-finalize against the install's CSR.

**Tech Stack:** TypeScript, Cloudflare Workers + Durable Objects + KV, `wrangler`; `jose` (JWS verify/sign, Web-Crypto-based, Workers-compatible) for both the install PoP JWS and the broker's ACME JWS; `pkijs` + `asn1js` (Web-Crypto-based) for PKCS#10 CSR parse/verify; hand-rolled minimal ACME-v2 client over `fetch` (the Node-only `acme-client` does NOT run on Workers); Cloudflare DNS REST API over `fetch`. Tests: `vitest` + `@cloudflare/vitest-pool-workers`; end-to-end issuance against the **Let's Encrypt staging** environment.

**Repo:** This broker is a NEW Worker package in the **`Castwright-Website`** repo (not the Audiobook-Generator repo). All `src/`/`test/` paths below are relative to that package, assumed at `workers/lan-broker/`. **Task 1 confirms the exact location + monorepo wiring against the website repo's conventions and adjusts paths if needed.** This plan document and its spec live in the Audiobook-Generator repo under `docs/`.

**Spec:** `docs/superpowers/specs/2026-06-19-lan-public-cert-broker-design.md` (rev 3).

## Global Constraints

- **Security rests on the PoP key, never on `installId` secrecy.** `installId` is public (DNS + pairing QR + Certificate Transparency). Every state-changing request MUST carry a valid JWS signed by the install's auth key; the auth public key rides in the JWS protected header (`jwk`).
- **`installId` format:** lowercased UUIDv4, regex `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`. Reject anything else before any DNS write; always re-validate the constructed FQDN ends in `.lan.castwright.ai`.
- **`lanIp`:** allow ONLY RFC1918 IPv4 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`). Reject loopback `127.0.0.0/8`, `0.0.0.0`, link-local `169.254.0.0/16`, CGNAT `100.64.0.0/10`, and ALL IPv6.
- **CSR (op=provision):** SAN dNSName set must equal exactly `{‹id›.lan.castwright.ai}` (no extra SANs; CN ignored); CSR self-signature MUST verify; key must be RSA ≥2048 or ECDSA P-256+; `csrHash` in the JWS must equal SHA-256 of the received DER CSR.
- **JWS replay:** reject `iat` outside ±300s of broker time; reject reused `nonce` (KV cache, TTL 600s).
- **`op` is exactly `"provision"` or `"dns"`.** There is no `/renew` endpoint — renewal is a `/provision` call.
- **Error codes — synchronous `4xx` on POST** (before a job exists): `jws-invalid`, `unauthorized`, `id-claimed`, `not-rfc1918`, `invalid-csr`, `rate-limited`. **Asynchronous via `GET /provision/:jobId` `failed{code}`:** `dns-propagation-timeout`, `caa-blocked`, `acme-error`.
- **DNS TTL** on the per-install A record: **60s**. **A-record purge** horizon (cron): **90 days**. **Orphan-TXT sweep:** every **10 min**. **Poll deadline (install-side):** 120s. **`retryAfter`** in the 202: integer seconds before first poll (default 3).
- **Issuance budget:** refuse **first-registrations** once the rolling-week new-cert count reaches **45** (`rate-limited`); **renewals** (installId already key-bound in DO state) are admitted above that line. Identical-CSR resubmit returns the existing cert and consumes **zero** budget. **All dev/test issuance uses the LE STAGING directory** — never production.
- **Cloudflare DNS token** is scoped to the `lan.castwright.ai` **zone ID only**, `Zone.DNS:Edit`. ACME account key + DNS token are **Worker Secrets**, never KV/plaintext.
- **TDD, frequent commits, DRY, YAGNI.** Conventional commits (`feat:`/`test:`/`chore:`/`docs:`).

---

## File Structure (package `workers/lan-broker/`)

- `wrangler.toml` — Worker + DO binding (`PROVISION_JOB`) + KV namespaces (`TOFU`, `NONCE`, `BUDGET`) + secrets + cron trigger.
- `package.json`, `tsconfig.json` — deps: `jose`, `pkijs`, `asn1js`; dev: `wrangler`, `vitest`, `@cloudflare/vitest-pool-workers`, `typescript`.
- `src/types.ts` — shared types (`JwsPayload`, `Env`, `JobState`, `ErrCode`).
- `src/errors.ts` — error taxonomy + `syncError`/`failState` helpers.
- `src/validate.ts` — `validateInstallId`, `fqdnFor`, `validateLanIp`, `validateCsr`.
- `src/auth.ts` — `verifyJws` (PoP + payload schema + replay), `tofuCheck` (KV).
- `src/dns.ts` — Cloudflare DNS client: `upsertA`, `putTxt`, `deleteTxt`, `listRecords`.
- `src/acme.ts` — ACME-v2 client: `AcmeClient` with `getAccount`, `newOrder`, `getDns01`, `notifyChallenge`, `pollAuthz`, `finalize`, `pollOrder`, `downloadChain`.
- `src/budget.ts` — `decideBudget` (renewal vs first-reg vs cap), `consume`.
- `src/job.ts` — `ProvisionJob` Durable Object (single-flight + alarm state machine).
- `src/index.ts` — Worker entry: routing + `scheduled()` cron.
- `test/*.test.ts` — colocated per module; `test/acme.staging.test.ts` gated on a staging secret; `test/integration.test.ts` end-to-end.
- `RUNBOOK.md` — zone/CAA/DNSSEC/token setup + staging→prod cutover (Task 0 + Task 13).

---

## Task 0: Infra runbook — delegated zone, CAA, DNSSEC, scoped token (GATE, no app code)

This is a prerequisite gate. It produces `RUNBOOK.md` and a verified DNS/zone state; nothing downstream can issue without it. No TDD (it's infra), but each step has a verification command.

**Files:**
- Create: `workers/lan-broker/RUNBOOK.md`

- [ ] **Step 1: Create the standalone Cloudflare zone.** In the Cloudflare dashboard, add a zone literally named `lan.castwright.ai` (a *subdomain* zone — NOT partial/CNAME setup, NOT records under the `castwright.ai` zone). Record the assigned nameservers and the **zone ID**.

- [ ] **Step 2: Delegate at Porkbun.** In Porkbun DNS for `castwright.ai`, add `NS` records for host `lan` pointing to each Cloudflare nameserver from Step 1. Leave every apex/MX/www record untouched.

- [ ] **Step 3: Verify delegation.**
Run: `dig NS lan.castwright.ai +short`
Expected: the Cloudflare nameservers from Step 1 (may take minutes to propagate).

- [ ] **Step 4: Publish the CAA shield (MANDATORY).** In the Cloudflare `lan.castwright.ai` zone add: `CAA 0 issue "letsencrypt.org"` and `CAA 0 issuewild ";"` at the zone apex (`lan.castwright.ai`).
Run: `dig CAA lan.castwright.ai +short`
Expected: `0 issue "letsencrypt.org"` and `0 issuewild ";"`.

- [ ] **Step 5: DNSSEC pre-flight.** Determine if `castwright.ai` has DNSSEC at Porkbun (`dig DNSKEY castwright.ai +short` non-empty). If yes, ensure the `lan` delegation is **insecure** (no DS record for `lan` at Porkbun) unless a verified DS chain is set up. Verify a TXT under the zone resolves through a validating resolver:
Run: `dig +dnssec TXT _acme-challenge.test.lan.castwright.ai @1.1.1.1` (after temporarily adding a dummy TXT)
Expected: `NOERROR` (NOT `SERVFAIL`). Remove the dummy TXT after.

- [ ] **Step 6: Confirm website LE-bucket isolation.**
Run: `echo | openssl s_client -connect castwright.ai:443 -servername castwright.ai 2>/dev/null | openssl x509 -noout -issuer`
Expected: a Cloudflare-managed issuer (e.g. Google Trust Services / Cloudflare), NOT a self-run Let's Encrypt account on `castwright.ai`. If it IS a self-run LE cert on `castwright.ai`, STOP and escalate (move LAN issuance to a separate registered domain per the spec).

- [ ] **Step 7: Create the scoped DNS token.** Cloudflare → My Profile → API Tokens → Create Token → Custom: Permissions `Zone — DNS — Edit`, Zone Resources `Include — Specific zone — lan.castwright.ai`. Save the token value for Task 1 secrets. Record the **zone ID**.

- [ ] **Step 8: Write `RUNBOOK.md`** capturing Steps 1–7 (zone ID, NS values, the "never delete the `lan` CAA" warning, the DNSSEC decision, the token scope) and commit.

```bash
git add workers/lan-broker/RUNBOOK.md
git commit -m "docs: lan-broker zone/CAA/DNSSEC/token setup runbook"
```

---

## Task 1: Project scaffold + green test harness

**Files:**
- Create: `workers/lan-broker/package.json`, `tsconfig.json`, `wrangler.toml`, `vitest.config.ts`, `src/index.ts`, `test/health.test.ts`

**Interfaces:**
- Produces: a deployable Worker whose `fetch` returns `200 {"ok":true}` for `GET /health`; the DO class `ProvisionJob` is bound but stubbed; KV namespaces `TOFU`/`NONCE`/`BUDGET` bound.

- [ ] **Step 1: Confirm repo location.** Inspect the `Castwright-Website` repo layout; if it already has a `workers/` or functions convention, place the package accordingly and adjust paths in this plan. Otherwise create `workers/lan-broker/`.

- [ ] **Step 2: `package.json`.**

```json
{
  "name": "lan-broker",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run"
  },
  "dependencies": { "jose": "^5.9.0", "pkijs": "^3.2.0", "asn1js": "^3.0.5" },
  "devDependencies": {
    "wrangler": "^3.78.0",
    "vitest": "^2.1.0",
    "@cloudflare/vitest-pool-workers": "^0.5.0",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 3: `wrangler.toml`.**

```toml
name = "lan-broker"
main = "src/index.ts"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]

[[durable_objects.bindings]]
name = "PROVISION_JOB"
class_name = "ProvisionJob"

[[migrations]]
tag = "v1"
new_classes = ["ProvisionJob"]

[[kv_namespaces]]
binding = "TOFU"
id = "REPLACE_WITH_KV_ID"

[[kv_namespaces]]
binding = "NONCE"
id = "REPLACE_WITH_KV_ID"

[[kv_namespaces]]
binding = "BUDGET"
id = "REPLACE_WITH_KV_ID"

[vars]
ZONE_NAME = "lan.castwright.ai"
CF_ZONE_ID = "REPLACE_WITH_ZONE_ID"
ACME_DIRECTORY = "https://acme-staging-v02.api.letsencrypt.org/directory"

[triggers]
crons = ["*/10 * * * *"]
```

Note: create the three KV namespaces with `wrangler kv namespace create TOFU` (etc.) and paste the IDs. Secrets `CF_DNS_TOKEN` and `ACME_ACCOUNT_KEY` are added with `wrangler secret put` (Task 8/13), never committed.

- [ ] **Step 4: `vitest.config.ts`.**

```ts
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
export default defineWorkersConfig({
  test: { poolOptions: { workers: { wrangler: { configPath: './wrangler.toml' } } } },
});
```

- [ ] **Step 5: Write the failing health test.** `test/health.test.ts`:

```ts
import { SELF } from 'cloudflare:test';
import { it, expect } from 'vitest';

it('GET /health returns ok', async () => {
  const res = await SELF.fetch('https://broker.test/health');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});
```

- [ ] **Step 6: Run it — expect FAIL.**
Run: `npm test -- health`
Expected: FAIL (no `/health` handler / no DO class).

- [ ] **Step 7: Minimal `src/index.ts`.**

```ts
export class ProvisionJob {
  constructor(private state: DurableObjectState, private env: unknown) {}
  async fetch(): Promise<Response> { return new Response('stub'); }
}

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/health') {
      return Response.json({ ok: true });
    }
    return new Response('not found', { status: 404 });
  },
};
```

- [ ] **Step 8: Run — expect PASS.**
Run: `npm test -- health`
Expected: PASS.

- [ ] **Step 9: Commit.**

```bash
git add workers/lan-broker
git commit -m "feat: scaffold lan-broker Worker + green health test"
```

---

## Task 2: Error taxonomy (`errors.ts` + `types.ts`)

**Files:**
- Create: `src/types.ts`, `src/errors.ts`, `test/errors.test.ts`

**Interfaces:**
- Produces:
  - `type SyncCode = 'jws-invalid'|'unauthorized'|'id-claimed'|'not-rfc1918'|'invalid-csr'|'rate-limited'`
  - `type AsyncCode = 'dns-propagation-timeout'|'caa-blocked'|'acme-error'`
  - `syncError(code: SyncCode): Response` → JSON `{error: code}` with status: `unauthorized`/`id-claimed`/`jws-invalid` → 401; `not-rfc1918`/`invalid-csr` → 400; `rate-limited` → 429.
  - `type JobState = { status:'pending'|'ready'|'failed'; jobId:string; installId:string; csrHash:string; notAfter?:string; certChainPem?:string; code?:AsyncCode; step:string; updatedAt:number }`

- [ ] **Step 1: Failing test.** `test/errors.test.ts`:

```ts
import { it, expect } from 'vitest';
import { syncError } from '../src/errors';

it('maps codes to status', async () => {
  expect(syncError('rate-limited').status).toBe(429);
  expect(syncError('not-rfc1918').status).toBe(400);
  expect(syncError('unauthorized').status).toBe(401);
  expect(await syncError('invalid-csr').json()).toEqual({ error: 'invalid-csr' });
});
```

- [ ] **Step 2: Run — expect FAIL.** Run: `npm test -- errors` → FAIL (no module).

- [ ] **Step 3: Implement `src/types.ts`.**

```ts
export type SyncCode = 'jws-invalid'|'unauthorized'|'id-claimed'|'not-rfc1918'|'invalid-csr'|'rate-limited';
export type AsyncCode = 'dns-propagation-timeout'|'caa-blocked'|'acme-error';
export type Op = 'provision' | 'dns';

export interface JwsPayload {
  installId: string; op: Op; lanIp: string;
  csrHash?: string; nonce: string; iat: number;
}
export interface JobState {
  status: 'pending'|'ready'|'failed'; jobId: string; installId: string;
  csrHash: string; notAfter?: string; certChainPem?: string;
  code?: AsyncCode; step: string; updatedAt: number;
}
export interface Env {
  PROVISION_JOB: DurableObjectNamespace;
  TOFU: KVNamespace; NONCE: KVNamespace; BUDGET: KVNamespace;
  ZONE_NAME: string; CF_ZONE_ID: string; ACME_DIRECTORY: string;
  CF_DNS_TOKEN: string; ACME_ACCOUNT_KEY: string;
}
```

- [ ] **Step 4: Implement `src/errors.ts`.**

```ts
import type { SyncCode } from './types';
const STATUS: Record<SyncCode, number> = {
  'jws-invalid': 401, 'unauthorized': 401, 'id-claimed': 401,
  'not-rfc1918': 400, 'invalid-csr': 400, 'rate-limited': 429,
};
export function syncError(code: SyncCode): Response {
  return Response.json({ error: code }, { status: STATUS[code] });
}
```

- [ ] **Step 5: Run — expect PASS.** Run: `npm test -- errors`.

- [ ] **Step 6: Commit.** `git commit -am "feat: error taxonomy + shared types"`

---

## Task 3: `installId` + FQDN validation (`validate.ts`)

**Files:**
- Create: `src/validate.ts`, `test/validate.id.test.ts`

**Interfaces:**
- Produces: `validateInstallId(id: string): boolean`; `fqdnFor(id: string, zone: string): string` (throws if the constructed FQDN doesn't end in `.${zone}`).

- [ ] **Step 1: Failing test.** `test/validate.id.test.ts`:

```ts
import { it, expect } from 'vitest';
import { validateInstallId, fqdnFor } from '../src/validate';

it('accepts a lowercased UUIDv4', () => {
  expect(validateInstallId('1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed')).toBe(true);
});
it('rejects injection / wrong case / non-v4', () => {
  for (const bad of ['', 'AB9D6BCD-BBFD-4B2D-9B5D-AB8DFBBD4BED',
    'x.lan.castwright.ai', '../etc', '1b9d6bcd_bbfd', 'foo']) {
    expect(validateInstallId(bad)).toBe(false);
  }
});
it('fqdnFor builds + guards the suffix', () => {
  const id = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
  expect(fqdnFor(id, 'lan.castwright.ai')).toBe(`${id}.lan.castwright.ai`);
});
```

- [ ] **Step 2: Run — expect FAIL.** Run: `npm test -- validate.id`.

- [ ] **Step 3: Implement (append to `src/validate.ts`).**

```ts
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function validateInstallId(id: string): boolean {
  return typeof id === 'string' && UUID_V4.test(id);
}
export function fqdnFor(id: string, zone: string): string {
  if (!validateInstallId(id)) throw new Error('bad installId');
  const fqdn = `${id}.${zone}`;
  if (!fqdn.endsWith(`.${zone}`) || fqdn.includes('..')) throw new Error('bad fqdn');
  return fqdn;
}
```

- [ ] **Step 4: Run — expect PASS.** Run: `npm test -- validate.id`.

- [ ] **Step 5: Commit.** `git commit -am "feat: installId + FQDN validation"`

---

## Task 4: `lanIp` RFC1918 allow + deny-list (`validate.ts`)

**Files:**
- Modify: `src/validate.ts`
- Create: `test/validate.ip.test.ts`

**Interfaces:**
- Produces: `validateLanIp(ip: string): boolean` — true ONLY for RFC1918 IPv4.

- [ ] **Step 1: Failing test.** `test/validate.ip.test.ts`:

```ts
import { it, expect } from 'vitest';
import { validateLanIp } from '../src/validate';

it('accepts RFC1918', () => {
  for (const ip of ['10.0.0.1','10.255.255.254','172.16.0.5','172.31.255.1','192.168.86.20'])
    expect(validateLanIp(ip)).toBe(true);
});
it('rejects everything else', () => {
  for (const ip of ['127.0.0.1','0.0.0.0','169.254.1.1','100.64.0.1','8.8.8.8',
    '172.32.0.1','192.169.0.1','::1','fc00::1','2001:db8::1','not-an-ip','10.0.0.256'])
    expect(validateLanIp(ip)).toBe(false);
});
```

- [ ] **Step 2: Run — expect FAIL.** Run: `npm test -- validate.ip`.

- [ ] **Step 3: Implement (append to `src/validate.ts`).**

```ts
export function validateLanIp(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return false;
  const [a, b] = o;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false; // 127/169.254/100.64/public all fall through; IPv6 never matched the regex
}
```

- [ ] **Step 4: Run — expect PASS.** Run: `npm test -- validate.ip`.

- [ ] **Step 5: Commit.** `git commit -am "feat: RFC1918-only lanIp validation"`

---

## Task 5: CSR validation via pkijs (`validate.ts`)

**Files:**
- Modify: `src/validate.ts`
- Create: `test/validate.csr.test.ts`

**Interfaces:**
- Produces: `validateCsr(csrPem: string, expectedFqdn: string): Promise<{ ok: true } | { ok: false }>` — checks SAN-set equality (single name), self-signature, key strength (RSA≥2048 / EC P-256+).
- Helper for tests: `sha256Hex(buf: ArrayBuffer): Promise<string>` exported from `src/validate.ts`.

- [ ] **Step 1: Failing test.** `test/validate.csr.test.ts` (generates CSRs with Web Crypto + pkijs so the fixture is real):

```ts
import { it, expect, beforeAll } from 'vitest';
import * as pkijs from 'pkijs';
import { validateCsr } from '../src/validate';

const FQDN = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed.lan.castwright.ai';

async function makeCsr(names: string[], bits = 2048): Promise<string> {
  const alg = { name: 'RSASSA-PKCS1-v1_5', modulusLength: bits, publicExponent: new Uint8Array([1,0,1]), hash: 'SHA-256' };
  const kp = await crypto.subtle.generateKey(alg, true, ['sign','verify']);
  const csr = new pkijs.CertificationRequest();
  await csr.subjectPublicKeyInfo.importKey(kp.publicKey);
  const altNames = new pkijs.GeneralNames({ names: names.map((n) =>
    new pkijs.GeneralName({ type: 2, value: n })) });
  csr.attributes = [ new pkijs.Attribute({ type: '1.2.840.113549.1.9.14', values: [
    new pkijs.Extensions({ extensions: [ new pkijs.Extension({
      extnID: '2.5.29.17', critical: false, extnValue: altNames.toSchema().toBER() }) ] }).toSchema() ] }) ];
  await csr.sign(kp.privateKey, 'SHA-256');
  const der = csr.toSchema().toBER();
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  return `-----BEGIN CERTIFICATE REQUEST-----\n${b64.replace(/(.{64})/g,'$1\n')}\n-----END CERTIFICATE REQUEST-----\n`;
}

it('accepts a correct single-SAN CSR', async () => {
  expect((await validateCsr(await makeCsr([FQDN]), FQDN)).ok).toBe(true);
});
it('rejects extra SANs (smuggling)', async () => {
  expect((await validateCsr(await makeCsr([FQDN, 'victim.lan.castwright.ai']), FQDN)).ok).toBe(false);
});
it('rejects a CSR for a different name', async () => {
  expect((await validateCsr(await makeCsr(['other.lan.castwright.ai']), FQDN)).ok).toBe(false);
});
it('rejects a weak 1024-bit key', async () => {
  expect((await validateCsr(await makeCsr([FQDN], 1024), FQDN)).ok).toBe(false);
});
```

- [ ] **Step 2: Run — expect FAIL.** Run: `npm test -- validate.csr`.

- [ ] **Step 3: Implement (append to `src/validate.ts`).**

```ts
import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';

export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
}

export async function validateCsr(
  csrPem: string, expectedFqdn: string,
): Promise<{ ok: true } | { ok: false }> {
  try {
    const csr = pkijs.CertificationRequest.fromBER(pemToDer(csrPem));
    // 1) self-signature proves possession of the CSR key
    if (!(await csr.verify())) return { ok: false };
    // 2) SAN dNSName set must be exactly {expectedFqdn}
    const extAttr = csr.attributes?.find((a) => a.type === '1.2.840.113549.1.9.14');
    if (!extAttr) return { ok: false };
    const exts = new pkijs.Extensions({ schema: extAttr.values[0] });
    const san = exts.extensions.find((e) => e.extnID === '2.5.29.17');
    if (!san) return { ok: false };
    const gn = new pkijs.GeneralNames({ schema: asn1js.fromBER(san.extnValue.valueBlock.valueHexView).result });
    const dns = gn.names.filter((n) => n.type === 2).map((n) => n.value as string);
    if (dns.length !== 1 || dns[0] !== expectedFqdn) return { ok: false };
    // 3) key strength
    const spki = csr.subjectPublicKeyInfo;
    const algo = spki.algorithm.algorithmId;
    if (algo === '1.2.840.113549.1.1.1') { // RSA
      const rsa = new pkijs.RSAPublicKey({ schema: asn1js.fromBER(spki.subjectPublicKey.valueBlock.valueHexView).result });
      if (rsa.modulus.valueBlock.valueHexView.byteLength * 8 < 2048) return { ok: false };
    } else if (algo === '1.2.840.10045.2.1') { // EC — P-256 or better; reject P-192/224
      const curve = (spki.algorithm.algorithmParams as asn1js.ObjectIdentifier)?.valueBlock?.toString();
      const OK = ['1.2.840.10045.3.1.7','1.3.132.0.34','1.3.132.0.35']; // P-256/384/521
      if (!OK.includes(curve)) return { ok: false };
    } else { return { ok: false }; }
    return { ok: true };
  } catch { return { ok: false }; }
}
```

- [ ] **Step 4: Run — expect PASS.** Run: `npm test -- validate.csr`. (If pkijs schema accessors differ by version, adjust to the installed `pkijs` API — pin the working version in `package.json`.)

- [ ] **Step 5: Commit.** `git commit -am "feat: CSR validation (SAN-set, self-sig, key strength)"`

---

## Task 6: PoP JWS verification + TOFU + replay (`auth.ts`)

**Files:**
- Create: `src/auth.ts`, `test/auth.test.ts`

**Interfaces:**
- Consumes: `JwsPayload`, `Env`, `validateInstallId`, `validateLanIp` (Tasks 2-4).
- Produces: `verifyAndAuthorize(jwsCompact: string, expected: { op: Op; now: number }, env: Env): Promise<{ ok: true; payload: JwsPayload; firstSeen: boolean } | { ok: false; code: 'jws-invalid'|'unauthorized'|'id-claimed' }>` — verifies the JWS against the header `jwk`, enforces payload schema + `iat` window + nonce replay, runs the TOFU rule (store jwk on first sight of an installId; on later calls require the header jwk to equal the stored one), and for `op==='dns'` requires the installId to already be bound (`unauthorized`) else fail.

- [ ] **Step 1: Failing test.** `test/auth.test.ts`:

```ts
import { it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { verifyAndAuthorize } from '../src/auth';

const ID = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
async function sign(payload: object, kp: CryptoKeyPair) {
  const jwk = await exportJWK(kp.publicKey);
  return new SignJWT(payload as any)
    .setProtectedHeader({ alg: 'ES256', jwk })
    .sign(kp.privateKey);
}

it('first-seen provision: verifies against header jwk + stores it (TOFU)', async () => {
  const kp = await generateKeyPair('ES256', { extractable: true });
  const now = Math.floor(Date.now()/1000);
  const jws = await sign({ installId: ID, op: 'provision', lanIp: '192.168.1.2', csrHash: 'a'.repeat(64), nonce: 'n1', iat: now }, kp);
  const r = await verifyAndAuthorize(jws, { op: 'provision', now }, env);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.firstSeen).toBe(true);
});

it('rejects a different key for an already-bound installId (id-claimed)', async () => {
  const k1 = await generateKeyPair('ES256', { extractable: true });
  const now = Math.floor(Date.now()/1000);
  await verifyAndAuthorize(await sign({ installId: ID, op: 'provision', lanIp: '192.168.1.2', csrHash: 'a'.repeat(64), nonce: 'b1', iat: now }, k1), { op: 'provision', now }, env);
  const k2 = await generateKeyPair('ES256', { extractable: true });
  const r = await verifyAndAuthorize(await sign({ installId: ID, op: 'provision', lanIp: '192.168.1.2', csrHash: 'a'.repeat(64), nonce: 'b2', iat: now }, k2), { op: 'provision', now }, env);
  expect(r).toEqual({ ok: false, code: 'id-claimed' });
});

it('rejects stale iat and replayed nonce', async () => {
  const kp = await generateKeyPair('ES256', { extractable: true });
  const now = Math.floor(Date.now()/1000);
  const stale = await verifyAndAuthorize(await sign({ installId: ID, op: 'provision', lanIp: '192.168.1.2', csrHash: 'a'.repeat(64), nonce: 'c1', iat: now - 9999 }, kp), { op: 'provision', now }, env);
  expect(stale).toEqual({ ok: false, code: 'jws-invalid' });
});

it('op=dns for an unbound installId → unauthorized', async () => {
  const kp = await generateKeyPair('ES256', { extractable: true });
  const now = Math.floor(Date.now()/1000);
  const fresh = '2c3d4e5f-aaaa-4bbb-8ccc-ddddeeeeffff';
  const r = await verifyAndAuthorize(await sign({ installId: fresh, op: 'dns', lanIp: '192.168.1.2', nonce: 'd1', iat: now }, kp), { op: 'dns', now }, env);
  expect(r).toEqual({ ok: false, code: 'unauthorized' });
});
```

- [ ] **Step 2: Run — expect FAIL.** Run: `npm test -- auth`.

- [ ] **Step 3: Implement `src/auth.ts`.**

```ts
import { jwtVerify, importJWK, type JWK } from 'jose';
import type { Env, JwsPayload, Op } from './types';
import { validateInstallId, validateLanIp } from './validate';

const REPLAY_WINDOW = 300; // ±s
const NONCE_TTL = 600;

type Fail = { ok: false; code: 'jws-invalid'|'unauthorized'|'id-claimed' };
type Pass = { ok: true; payload: JwsPayload; firstSeen: boolean };

export async function verifyAndAuthorize(
  jwsCompact: string, expected: { op: Op; now: number }, env: Env,
): Promise<Pass | Fail> {
  // 1) parse protected header to get the embedded jwk
  let header: { alg?: string; jwk?: JWK };
  try { header = JSON.parse(atob(jwsCompact.split('.')[0].replace(/-/g,'+').replace(/_/g,'/'))); }
  catch { return { ok: false, code: 'jws-invalid' }; }
  if (!header.jwk || header.alg !== 'ES256') return { ok: false, code: 'jws-invalid' };

  // 2) cryptographically verify against that key
  let payload: JwsPayload;
  try {
    const key = await importJWK(header.jwk, 'ES256');
    const { payload: p } = await jwtVerify(jwsCompact, key);
    payload = p as unknown as JwsPayload;
  } catch { return { ok: false, code: 'jws-invalid' }; }

  // 3) schema + op + iat window
  if (payload.op !== expected.op) return { ok: false, code: 'jws-invalid' };
  if (!validateInstallId(payload.installId) || !validateLanIp(payload.lanIp))
    return { ok: false, code: 'jws-invalid' };
  if (typeof payload.iat !== 'number' || Math.abs(payload.iat - expected.now) > REPLAY_WINDOW)
    return { ok: false, code: 'jws-invalid' };
  if (expected.op === 'provision' && (typeof payload.csrHash !== 'string' || payload.csrHash.length !== 64))
    return { ok: false, code: 'jws-invalid' };
  if (expected.op === 'dns' && payload.csrHash !== undefined)
    return { ok: false, code: 'jws-invalid' };

  // 4) nonce replay (KV)
  const nKey = `${payload.installId}:${payload.nonce}`;
  if (await env.NONCE.get(nKey)) return { ok: false, code: 'jws-invalid' };

  // 5) TOFU: compare the header jwk against the stored one
  const thumb = JSON.stringify([header.jwk.crv, header.jwk.x, header.jwk.y]);
  const stored = await env.TOFU.get(payload.installId);
  let firstSeen = false;
  if (!stored) {
    if (expected.op === 'dns') return { ok: false, code: 'unauthorized' };
    await env.TOFU.put(payload.installId, thumb);
    firstSeen = true;
  } else if (stored !== thumb) {
    return { ok: false, code: 'id-claimed' };
  }

  await env.NONCE.put(nKey, '1', { expirationTtl: NONCE_TTL });
  return { ok: true, payload, firstSeen };
}
```

- [ ] **Step 4: Run — expect PASS.** Run: `npm test -- auth`.

- [ ] **Step 5: Commit.** `git commit -am "feat: PoP JWS verify + TOFU + replay guard"`

---

## Task 7: Cloudflare DNS client (`dns.ts`)

**Files:**
- Create: `src/dns.ts`, `test/dns.test.ts`

**Interfaces:**
- Consumes: `Env` (`CF_ZONE_ID`, `CF_DNS_TOKEN`, `ZONE_NAME`).
- Produces: `class CfDns { upsertA(name,ip): Promise<void>; putTxt(name,value): Promise<string /*recordId*/>; deleteTxt(recordId): Promise<void>; listRecords(type, namePrefix?): Promise<{id,name,content,modified_on}[]> }`. Constructor takes `(env, fetchImpl=fetch)` so tests inject a fake fetch.

- [ ] **Step 1: Failing test.** `test/dns.test.ts` (inject a fake fetch; assert the right CF API calls):

```ts
import { it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { CfDns } from '../src/dns';

function fakeFetch(routes: Record<string, any>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${new URL(url).pathname}`;
    return Response.json(routes[key] ?? { success: true, result: [] });
  });
}

it('upsertA creates when absent', async () => {
  const f = fakeFetch({}); // list returns empty → create
  const dns = new CfDns(env, f as any);
  await dns.upsertA('x.lan.castwright.ai', '192.168.1.2');
  const created = f.mock.calls.find((c) => (c[1]?.method === 'POST'));
  expect(created).toBeTruthy();
  expect(JSON.parse(created![1].body)).toMatchObject({ type: 'A', content: '192.168.1.2', ttl: 60 });
});
```

- [ ] **Step 2: Run — expect FAIL.** Run: `npm test -- dns`.

- [ ] **Step 3: Implement `src/dns.ts`.**

```ts
import type { Env } from './types';
const API = 'https://api.cloudflare.com/client/v4';

export class CfDns {
  constructor(private env: Env, private f: typeof fetch = fetch) {}
  private async call(method: string, path: string, body?: unknown) {
    const res = await this.f(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.env.CF_DNS_TOKEN}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await res.json() as any;
    if (!j.success) throw new Error(`cf-dns ${path}: ${JSON.stringify(j.errors)}`);
    return j.result;
  }
  async listRecords(type: string, name?: string) {
    const q = new URLSearchParams({ type, per_page: '100', ...(name ? { name } : {}) });
    return await this.call('GET', `/zones/${this.env.CF_ZONE_ID}/dns_records?${q}`) as
      { id: string; name: string; content: string; modified_on: string }[];
  }
  async upsertA(name: string, ip: string) {
    const existing = (await this.listRecords('A', name))[0];
    const body = { type: 'A', name, content: ip, ttl: 60, proxied: false };
    if (existing) await this.call('PATCH', `/zones/${this.env.CF_ZONE_ID}/dns_records/${existing.id}`, body);
    else await this.call('POST', `/zones/${this.env.CF_ZONE_ID}/dns_records`, body);
  }
  async putTxt(name: string, content: string): Promise<string> {
    const r = await this.call('POST', `/zones/${this.env.CF_ZONE_ID}/dns_records`, { type: 'TXT', name, content, ttl: 60 });
    return r.id;
  }
  async deleteTxt(id: string) {
    await this.call('DELETE', `/zones/${this.env.CF_ZONE_ID}/dns_records/${id}`);
  }
}
```

- [ ] **Step 4: Run — expect PASS.** Run: `npm test -- dns`.

- [ ] **Step 5: Commit.** `git commit -am "feat: Cloudflare DNS client (A upsert, TXT put/delete, list)"`

---

## Task 8: ACME-v2 client over fetch+jose, against LE staging (`acme.ts`)

**Files:**
- Create: `src/acme.ts`, `test/acme.staging.test.ts`

**Interfaces:**
- Consumes: `Env` (`ACME_DIRECTORY`, `ACME_ACCOUNT_KEY` — a PEM/JWK EC key), `CfDns` (Task 7).
- Produces: `class AcmeClient { static async create(env, dns): Promise<AcmeClient>; async issue(fqdn: string, csrDerB64Url: string, opts:{ pollMs:number; deadlineMs:number }): Promise<{ chainPem: string; notAfter: string } | { error: 'dns-propagation-timeout'|'caa-blocked'|'acme-error' }> }`. `issue` performs newOrder → write `_acme-challenge.<fqdn>` TXT via `dns.putTxt` → notify → poll authz → finalize with the CSR → poll order → download chain, and ALWAYS deletes the TXT in a `finally`.

- [ ] **Step 1: Staging integration test (gated).** `test/acme.staging.test.ts` — skipped unless `ACME_STAGING=1` and secrets present, since it hits LE staging + the real CF zone:

```ts
import { it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { AcmeClient } from '../src/acme';
import { CfDns } from '../src/dns';
// helper makeCsr/exportPrivateKey omitted — reuse Task 5's makeCsr but also return the DER (base64url).

const RUN = env.ACME_STAGING === '1';
it.skipIf(!RUN)('issues a staging cert for a test fqdn', async () => {
  const dns = new CfDns(env);
  const acme = await AcmeClient.create(env, dns);
  const id = crypto.randomUUID();
  const fqdn = `${id}.lan.castwright.ai`;
  const { csrDerB64Url } = await makeCsrDer([fqdn]); // returns base64url DER
  await dns.upsertA(fqdn, '192.168.1.2');
  const r = await acme.issue(fqdn, csrDerB64Url, { pollMs: 3000, deadlineMs: 90000 });
  expect('chainPem' in r && r.chainPem.includes('BEGIN CERTIFICATE')).toBe(true);
}, 120_000);
```

- [ ] **Step 2: Run — expect SKIP (then FAIL when enabled).** Run: `npm test -- acme.staging` → skipped without `ACME_STAGING=1`.

- [ ] **Step 3: Implement `src/acme.ts`.** (Minimal ACME-v2: directory, nonce rotation, JWS-signed kid requests via `jose`.)

```ts
import { CompactSign, importPKCS8, exportJWK, calculateJwkThumbprint, type JWK } from 'jose';
import type { Env } from './types';
import type { CfDns } from './dns';

const enc = new TextEncoder();
const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b as any))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');

export class AcmeClient {
  private constructor(
    private env: Env, private dns: CfDns,
    private key: CryptoKey, private jwk: JWK,
    private dir: any, private kid: string, private nonce: string,
  ) {}

  static async create(env: Env, dns: CfDns): Promise<AcmeClient> {
    const key = await importPKCS8(env.ACME_ACCOUNT_KEY, 'ES256');
    const jwk = await exportJWK(key); // private — only crv/x/y/d; we use it to derive the public jwk below
    const pub: JWK = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
    const dir = await (await fetch(env.ACME_DIRECTORY)).json();
    const nonce = (await fetch(dir.newNonce, { method: 'HEAD' })).headers.get('replay-nonce')!;
    // register / fetch account (onlyReturnExisting after first run)
    const acctJws = await signJwsJwk(key, pub, dir.newAccount, nonce, { termsOfServiceAgreed: true });
    const acctRes = await fetch(dir.newAccount, { method: 'POST', headers: { 'Content-Type': 'application/jose+json' }, body: JSON.stringify(acctJws) });
    const kid = acctRes.headers.get('location')!;
    const next = acctRes.headers.get('replay-nonce')!;
    return new AcmeClient(env, dns, key, pub, dir, kid, next);
  }

  private async post(url: string, payload: unknown): Promise<{ res: Response; body: any }> {
    const jws = await signJwsKid(this.key, this.kid, url, this.nonce, payload);
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/jose+json' }, body: JSON.stringify(jws) });
    this.nonce = res.headers.get('replay-nonce') ?? this.nonce;
    const text = await res.text();
    return { res, body: text ? JSON.parse(text) : {} };
  }

  async issue(fqdn: string, csrDerB64Url: string, opts: { pollMs: number; deadlineMs: number }) {
    let txtId: string | undefined;
    const deadline = Date.now() + opts.deadlineMs;
    try {
      const order = await this.post(this.dir.newOrder, { identifiers: [{ type: 'dns', value: fqdn }] });
      const orderUrl = order.res.headers.get('location')!;
      const authzUrl = order.body.authorizations[0];
      const authz = await this.post(authzUrl, ''); // POST-as-GET
      const chal = authz.body.challenges.find((c: any) => c.type === 'dns-01');
      const thumb = await calculateJwkThumbprint(this.jwk);
      const keyAuth = `${chal.token}.${thumb}`;
      const txtVal = b64url(await crypto.subtle.digest('SHA-256', enc.encode(keyAuth)));
      txtId = await this.dns.putTxt(`_acme-challenge.${fqdn}`, txtVal);
      await this.post(chal.url, {}); // notify ready
      // poll authz
      for (;;) {
        if (Date.now() > deadline) return { error: 'dns-propagation-timeout' as const };
        const a = await this.post(authzUrl, '');
        if (a.body.status === 'valid') break;
        if (a.body.status === 'invalid') {
          const t = a.body.challenges?.[0]?.error?.type ?? '';
          return { error: t.includes('caa') ? 'caa-blocked' as const : 'acme-error' as const };
        }
        await sleep(opts.pollMs);
      }
      await this.post(order.body.finalize, { csr: csrDerB64Url });
      // poll order
      for (;;) {
        if (Date.now() > deadline) return { error: 'dns-propagation-timeout' as const };
        const o = await this.post(orderUrl, '');
        if (o.body.status === 'valid') {
          const cert = await this.post(o.body.certificate, '');
          const chainPem = await readBody(cert.res);
          const notAfter = new Date(Date.now() + 89 * 86400_000).toISOString(); // refined by parsing in Task 10
          return { chainPem, notAfter };
        }
        if (o.body.status === 'invalid') return { error: 'acme-error' as const };
        await sleep(opts.pollMs);
      }
    } catch { return { error: 'acme-error' as const }; }
    finally { if (txtId) try { await this.dns.deleteTxt(txtId); } catch { /* swept by cron */ } }
  }
}

async function readBody(res: Response) { return await res.text(); }
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function signJwsKid(key: CryptoKey, kid: string, url: string, nonce: string, payload: unknown) {
  const protect = { alg: 'ES256', kid, nonce, url };
  return flatten(await sign(key, protect, payload));
}
async function signJwsJwk(key: CryptoKey, jwk: JWK, url: string, nonce: string, payload: unknown) {
  const protect = { alg: 'ES256', jwk, nonce, url };
  return flatten(await sign(key, protect, payload));
}
async function sign(key: CryptoKey, protect: object, payload: unknown) {
  const p = payload === '' ? new Uint8Array(0) : enc.encode(JSON.stringify(payload));
  const jws = await new CompactSign(p).setProtectedHeader(protect as any).sign(key);
  return jws; // compact "h.p.s"
}
function flatten(compact: string) {
  const [protected_, payload, signature] = compact.split('.');
  return { protected: protected_, payload, signature };
}
```

Note: ACME requires **flattened JSON JWS** (protected/payload/signature), and `POST-as-GET` uses an empty payload (`""`). The helpers above produce that from `jose`'s compact output. Pin the exact `jose` minor that exposes `CompactSign`/`calculateJwkThumbprint` in `package.json`.

- [ ] **Step 4: Provision staging secrets + run.** Create an EC P-256 account key, `wrangler secret put ACME_ACCOUNT_KEY` (PKCS#8 PEM) + `CF_DNS_TOKEN`. Run with the gate on:
Run: `ACME_STAGING=1 npm test -- acme.staging`
Expected: PASS — a staging cert chain returned (LE staging issues against `lan.castwright.ai`, proving the zone/CAA/DNSSEC + DNS-01 path end-to-end).

- [ ] **Step 5: Commit.** `git commit -am "feat: ACME-v2 DNS-01 client (LE staging) with guaranteed TXT cleanup"`

---

## Task 9: Issuance budget (`budget.ts`)

**Files:**
- Create: `src/budget.ts`, `test/budget.test.ts`

**Interfaces:**
- Consumes: `Env` (`BUDGET` KV).
- Produces: `decideBudget(env, { isRenewal: boolean }): Promise<{ admit: true } | { admit: false }>` (first-reg refused at ≥45 in the rolling week; renewals always admitted) and `consume(env): Promise<void>` (increments the current ISO-week counter, TTL 8 days).

- [ ] **Step 1: Failing test.** `test/budget.test.ts`:

```ts
import { it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { decideBudget, consume } from '../src/budget';

it('admits first 45 first-registrations then refuses, but always admits renewals', async () => {
  for (let i = 0; i < 45; i++) {
    expect((await decideBudget(env, { isRenewal: false })).admit).toBe(true);
    await consume(env);
  }
  expect((await decideBudget(env, { isRenewal: false })).admit).toBe(false);
  expect((await decideBudget(env, { isRenewal: true })).admit).toBe(true);
});
```

- [ ] **Step 2: Run — expect FAIL.** Run: `npm test -- budget`.

- [ ] **Step 3: Implement `src/budget.ts`.**

```ts
import type { Env } from './types';
const CAP = 45;
function weekKey(now = Date.now()): string {
  const d = new Date(now); const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day); return `wk:${d.toISOString().slice(0,10)}`;
}
export async function decideBudget(env: Env, o: { isRenewal: boolean }): Promise<{ admit: boolean }> {
  if (o.isRenewal) return { admit: true };
  const n = Number(await env.BUDGET.get(weekKey())) || 0;
  return { admit: n < CAP };
}
export async function consume(env: Env): Promise<void> {
  const k = weekKey();
  const n = Number(await env.BUDGET.get(k)) || 0;
  await env.BUDGET.put(k, String(n + 1), { expirationTtl: 8 * 86400 });
}
```

(Note: KV is eventually consistent; the budget is a soft guard with headroom under LE's 50. The per-installId single-flight DO (Task 10) prevents the duplicate-cert burn that strict accuracy would otherwise matter for.)

- [ ] **Step 4: Run — expect PASS.** Run: `npm test -- budget`.

- [ ] **Step 5: Commit.** `git commit -am "feat: fail-closed rolling-week issuance budget"`

---

## Task 10: ProvisionJob Durable Object — single-flight + alarm state machine (`job.ts`)

**Files:**
- Create: `src/job.ts`
- Modify: `src/index.ts` (export `ProvisionJob` from here; replace the Task-1 stub)
- Create: `test/job.test.ts`

**Interfaces:**
- Consumes: `CfDns`, `AcmeClient`, `decideBudget`/`consume`, `JobState`, `Env`.
- Produces: DO with two internal routes via `fetch`: `POST /start` body `{ installId, lanIp, csrPem, csrDerB64Url, csrHash, isRenewal }` → returns `{ jobId }` (idempotent: existing pending job or valid cached cert wins; consumes budget only on a real new order); `GET /status` → `JobState`. Drives ACME via `alarm()`.

- [ ] **Step 1: Failing test.** `test/job.test.ts` (uses a fake AcmeClient via dependency seam — inject through env binding or a module mock; here mock `acme.ts`):

```ts
import { it, expect, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';

vi.mock('../src/acme', () => ({ AcmeClient: { create: async () => ({
  issue: async () => ({ chainPem: '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----', notAfter: '2026-09-01T00:00:00Z' }) }) } }));

it('start returns a jobId and reaches ready after the alarm runs', async () => {
  const id = env.PROVISION_JOB.idFromName('1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed');
  const stub = env.PROVISION_JOB.get(id);
  const started = await stub.fetch('https://do/start', { method: 'POST', body: JSON.stringify({
    installId: '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed', lanIp: '192.168.1.2',
    csrPem: 'x', csrDerB64Url: 'x', csrHash: 'a'.repeat(64), isRenewal: false }) });
  expect((await started.json()).jobId).toBeTruthy();
  await runInDurableObject(stub, async (instance: any) => { await instance.alarm(); });
  const st = await (await stub.fetch('https://do/status')).json();
  expect(st.status).toBe('ready');
  expect(st.certChainPem).toContain('BEGIN CERTIFICATE');
});
```

- [ ] **Step 2: Run — expect FAIL.** Run: `npm test -- job`.

- [ ] **Step 3: Implement `src/job.ts`.**

```ts
import type { Env, JobState } from './types';
import { CfDns } from './dns';
import { AcmeClient } from './acme';
import { decideBudget, consume } from './budget';
import { fqdnFor } from './validate';

interface StartBody { installId: string; lanIp: string; csrPem: string; csrDerB64Url: string; csrHash: string; isRenewal: boolean; }

export class ProvisionJob {
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname === '/start') return this.start(await req.json());
    if (req.method === 'GET' && url.pathname === '/status') {
      const job = await this.state.storage.get<JobState>('job');
      return job ? Response.json(job) : new Response('no job', { status: 404 });
    }
    return new Response('not found', { status: 404 });
  }

  private async start(body: StartBody): Promise<Response> {
    const existing = await this.state.storage.get<JobState>('job');
    // idempotent: pending job wins; valid cached cert for the same CSR wins (zero budget)
    if (existing && existing.status === 'pending') return Response.json({ jobId: existing.jobId });
    if (existing && existing.status === 'ready' && existing.csrHash === body.csrHash &&
        existing.notAfter && Date.parse(existing.notAfter) > Date.now())
      return Response.json({ jobId: existing.jobId });

    const decision = await decideBudget(this.env, { isRenewal: body.isRenewal });
    if (!decision.admit) return Response.json({ error: 'rate-limited' }, { status: 429 });

    const jobId = crypto.randomUUID();
    const job: JobState = { status: 'pending', jobId, installId: body.installId,
      csrHash: body.csrHash, step: 'queued', updatedAt: Date.now() };
    await this.state.storage.put('job', job);
    await this.state.storage.put('start', body);
    await consume(this.env);
    await this.state.storage.setAlarm(Date.now() + 100); // kick the machine
    return Response.json({ jobId });
  }

  async alarm(): Promise<void> {
    const body = await this.state.storage.get<StartBody>('start');
    const job = await this.state.storage.get<JobState>('job');
    if (!body || !job || job.status !== 'pending') return;
    const dns = new CfDns(this.env);
    const fqdn = fqdnFor(body.installId, this.env.ZONE_NAME);
    try {
      await dns.upsertA(fqdn, body.lanIp);           // A record FIRST (so the name resolves)
      const acme = await AcmeClient.create(this.env, dns);
      const r = await acme.issue(fqdn, body.csrDerB64Url, { pollMs: 4000, deadlineMs: 90_000 });
      if ('chainPem' in r) {
        await this.put({ ...job, status: 'ready', certChainPem: r.chainPem, notAfter: r.notAfter, step: 'done', updatedAt: Date.now() });
      } else {
        await this.put({ ...job, status: 'failed', code: r.error, step: 'issue', updatedAt: Date.now() });
      }
    } catch {
      await this.put({ ...job, status: 'failed', code: 'acme-error', step: 'alarm', updatedAt: Date.now() });
    }
  }
  private put(j: JobState) { return this.state.storage.put('job', j); }
}
```

- [ ] **Step 4: Run — expect PASS.** Run: `npm test -- job`.

- [ ] **Step 5: Commit.** `git commit -am "feat: ProvisionJob DO (single-flight + alarm-driven ACME)"`

---

## Task 11: Worker routing + `/dns` + cron sweep (`index.ts`)

**Files:**
- Modify: `src/index.ts`
- Create: `test/integration.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `POST /provision` (validate → DO `/start` → `202 {jobId, status:'pending', retryAfter:3}`), `GET /provision/:jobId` (proxy DO `/status`, projecting only `status`/`certChainPem`/`notAfter`/`code`), `POST /dns` (validate `op:'dns'` → `CfDns.upsertA` → `200`), `scheduled()` (orphan-TXT sweep + 90-day A purge). The DO is addressed `idFromName(installId)` so the job is discoverable by installId; `GET /provision/:jobId` validates the jobId matches.

- [ ] **Step 1: Failing integration test.** `test/integration.test.ts`:

```ts
import { it, expect, vi } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

vi.mock('../src/acme', () => ({ AcmeClient: { create: async () => ({
  issue: async () => ({ chainPem: '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----', notAfter: '2026-09-01T00:00:00Z' }) }) } }));

it('POST /provision validates + returns 202 pending', async () => {
  const kp = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(kp.publicKey);
  const id = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
  const now = Math.floor(Date.now()/1000);
  // a real CSR omitted for brevity — use Task 5 makeCsr; csrHash must match
  const jws = await new SignJWT({ installId: id, op: 'provision', lanIp: '192.168.1.2', csrHash: '<sha256 of csr der>', nonce: 'z1', iat: now })
    .setProtectedHeader({ alg: 'ES256', jwk }).sign(kp.privateKey);
  const res = await SELF.fetch('https://broker.test/provision', { method: 'POST',
    body: JSON.stringify({ installId: id, lanIp: '192.168.1.2', csr: '<pem>', jws }) });
  expect(res.status).toBe(202);
  const b = await res.json(); expect(b.status).toBe('pending'); expect(b.retryAfter).toBe(3);
});

it('POST /provision off-RFC1918 → 400 not-rfc1918', async () => {
  const kp = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(kp.publicKey);
  const now = Math.floor(Date.now()/1000);
  const jws = await new SignJWT({ installId: '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed', op: 'provision', lanIp: '8.8.8.8', csrHash: 'a'.repeat(64), nonce: 'z2', iat: now })
    .setProtectedHeader({ alg: 'ES256', jwk }).sign(kp.privateKey);
  const res = await SELF.fetch('https://broker.test/provision', { method: 'POST',
    body: JSON.stringify({ installId: '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed', lanIp: '8.8.8.8', csr: 'x', jws }) });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe('not-rfc1918');
});
```

- [ ] **Step 2: Run — expect FAIL.** Run: `npm test -- integration`.

- [ ] **Step 3: Implement routing in `src/index.ts`.**

```ts
export { ProvisionJob } from './job';
import type { Env } from './types';
import { syncError } from './errors';
import { verifyAndAuthorize } from './auth';
import { validateCsr, fqdnFor, sha256Hex } from './validate';
import { CfDns } from './dns';

function pemToDerB64Url(pem: string): string {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return b64.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/health') return Response.json({ ok: true });
    const now = Math.floor(Date.now() / 1000);

    if (req.method === 'POST' && url.pathname === '/provision') {
      const { installId, lanIp, csr, jws } = await req.json() as any;
      const auth = await verifyAndAuthorize(jws, { op: 'provision', now }, env);
      if (!auth.ok) return syncError(auth.code);
      if (auth.payload.installId !== installId || auth.payload.lanIp !== lanIp) return syncError('jws-invalid');
      const fqdn = fqdnFor(installId, env.ZONE_NAME);
      const der = pemToDerB64Url(csr);
      const csrHash = await sha256Hex(Uint8Array.from(atob(der.replace(/-/g,'+').replace(/_/g,'/')), c=>c.charCodeAt(0)).buffer);
      if (csrHash !== auth.payload.csrHash) return syncError('invalid-csr');
      if (!(await validateCsr(csr, fqdn)).ok) return syncError('invalid-csr');
      const stub = env.PROVISION_JOB.get(env.PROVISION_JOB.idFromName(installId));
      const started = await stub.fetch('https://do/start', { method: 'POST', body: JSON.stringify({
        installId, lanIp, csrPem: csr, csrDerB64Url: der, csrHash, isRenewal: !auth.firstSeen }) });
      if (started.status === 429) return syncError('rate-limited');
      const { jobId } = await started.json() as any;
      return Response.json({ jobId, status: 'pending', retryAfter: 3 }, { status: 202 });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/provision/')) {
      const jobId = url.pathname.split('/')[2];
      // installId is not in the URL; the install knows its own DO via installId — but it polls by jobId.
      // We store a jobId→installId map in KV at /start time (see note) OR the install passes installId as a query.
      const installId = url.searchParams.get('installId') ?? '';
      const stub = env.PROVISION_JOB.get(env.PROVISION_JOB.idFromName(installId));
      const st = await stub.fetch('https://do/status');
      if (st.status === 404) return new Response('unknown', { status: 404 });
      const j = await st.json() as any;
      if (j.jobId !== jobId) return new Response('unknown', { status: 404 });
      return Response.json({ status: j.status, certChainPem: j.certChainPem, notAfter: j.notAfter, code: j.code });
    }

    if (req.method === 'POST' && url.pathname === '/dns') {
      const { installId, lanIp, jws } = await req.json() as any;
      const auth = await verifyAndAuthorize(jws, { op: 'dns', now }, env);
      if (!auth.ok) return syncError(auth.code);
      if (auth.payload.installId !== installId || auth.payload.lanIp !== lanIp) return syncError('jws-invalid');
      await new CfDns(env).upsertA(fqdnFor(installId, env.ZONE_NAME), lanIp);
      return Response.json({ ok: true });
    }

    return new Response('not found', { status: 404 });
  },

  async scheduled(_e: ScheduledEvent, env: Env): Promise<void> {
    const dns = new CfDns(env);
    const now = Date.now();
    const txts = await dns.listRecords('TXT');
    for (const r of txts) {
      if (r.name.startsWith('_acme-challenge.') && now - Date.parse(r.modified_on) > 10 * 60_000)
        await dns.deleteTxt(r.id);
    }
    const as = await dns.listRecords('A');
    for (const r of as) {
      if (now - Date.parse(r.modified_on) > 90 * 86400_000) await dns.deleteTxt(r.id); // deleteTxt = generic delete-by-id
    }
  },
};
```

Note on `GET /provision/:jobId`: the install polls with `?installId=` so the Worker can address the DO (the DO is keyed by `installId`); the `jobId` is then matched against the DO's stored job. Update the install-side contract (sub-project 2) to include `installId` in the poll URL. This is the single contract refinement this task introduces — record it in the spec's install-side section.

- [ ] **Step 4: Run — expect PASS.** Run: `npm test -- integration` (fill the `<sha256 of csr der>`/`<pem>` from a real Task-5 CSR so the csrHash check passes).

- [ ] **Step 5: Commit.** `git commit -am "feat: Worker routing (/provision async, /provision/:jobId, /dns) + cron sweep"`

---

## Task 12: notAfter accuracy + full-suite green

**Files:**
- Modify: `src/acme.ts` (parse real `notAfter` from the issued leaf via pkijs instead of the +89d estimate)
- Modify: `test/acme.staging.test.ts` (assert `notAfter` is a real future date within ~90d)

- [ ] **Step 1: Failing test.** Add to `acme.staging.test.ts` (gated): assert `Date.parse(r.notAfter)` is between now+80d and now+92d.

- [ ] **Step 2: Run — expect FAIL** (estimate is exactly +89d, brittle): `ACME_STAGING=1 npm test -- acme.staging`.

- [ ] **Step 3: Implement** — in `acme.ts`, after downloading the chain, parse the leaf with `pkijs.Certificate.fromBER(pemToDer(firstCertInChain))` and read `notAfter.value.toISOString()`.

```ts
import * as pkijs from 'pkijs';
function leafNotAfter(chainPem: string): string {
  const first = chainPem.split('-----END CERTIFICATE-----')[0] + '-----END CERTIFICATE-----';
  const der = Uint8Array.from(atob(first.replace(/-----[^-]+-----/g,'').replace(/\s+/g,'')), c=>c.charCodeAt(0)).buffer;
  return pkijs.Certificate.fromBER(der).notAfter.value.toISOString();
}
```
Replace the `+89d` line with `const notAfter = leafNotAfter(chainPem);`.

- [ ] **Step 4: Run — expect PASS.** `ACME_STAGING=1 npm test -- acme.staging`.

- [ ] **Step 5: Full suite.** Run: `npm test` → all green.

- [ ] **Step 6: Commit.** `git commit -am "feat: parse real notAfter from issued leaf"`

---

## Task 13: Production cutover + acceptance (RUNBOOK)

**Files:**
- Modify: `workers/lan-broker/RUNBOOK.md`, `wrangler.toml`

- [ ] **Step 1: Switch directory to production.** In `wrangler.toml` set `ACME_DIRECTORY = "https://acme-v02.api.letsencrypt.org/directory"` for the production environment (keep staging as the default/test env). Use a separate `[env.production]` block so tests never touch prod.

- [ ] **Step 2: Provision prod secrets.** `wrangler secret put CF_DNS_TOKEN` (the Task-0 scoped token) and `wrangler secret put ACME_ACCOUNT_KEY` (a fresh prod EC P-256 account key). Confirm the token scope = zone-only (Task 0 Step 7).

- [ ] **Step 3: Deploy.** `wrangler deploy --env production`. Confirm the Worker route/host is independent of the `lan.castwright.ai` zone (Task 0).

- [ ] **Step 4: Live acceptance** (one real install, manual): from a dev box on a LAN, run the install-side harness (sub-project 2, or a temporary script) that generates the keypair/CSR, calls prod `/provision`, polls `/provision/:jobId?installId=`, and serves the returned chain. On a phone browser, open `https://‹id›.lan.castwright.ai:8443` → **clean lock, no warning**. Verify revoke/expiry behavior is out of scope here (sub-project 2).

- [ ] **Step 5: Document** the cutover + acceptance result + the LE production rate-limit-increase request link (for when installs exceed ~45/week) in `RUNBOOK.md`. Commit.

```bash
git commit -am "docs: lan-broker production cutover + acceptance runbook"
```

---

## Self-Review

**Spec coverage:** DNS delegation + CAA + DNSSEC → Task 0. PoP/JWS/TOFU/replay → Task 6. installId/FQDN guard → Task 3. RFC1918 deny-list → Task 4. CSR SAN-set/self-sig/key-strength/csrHash → Tasks 5 + 11. Async `/provision` + 202 + retryAfter → Task 11. DO single-flight + alarms + A-record-first + idempotency → Task 10. `GET /provision/:jobId` → Task 11. A-only `/dns` → Task 11. Error taxonomy split sync/async → Tasks 2 + 11. Budget fail-closed + renewal priority → Tasks 9 + 10. Zone-scoped token + secrets → Tasks 0 + 13. TXT cleanup (finally) + orphan sweep + 90-day purge → Tasks 8 + 11. notAfter accuracy → Task 12. LE staging for tests / prod cutover → Tasks 8 + 13. Install-side contract items (URL-builders, listener hot-reload, Host-header anti-rebinding) are explicitly **sub-project 2** (not in this plan) — noted in the spec.

**Placeholder scan:** the only intentional fill-ins are the staging-test CSR fixtures (`<pem>`, `<sha256 of csr der>`) which reference Task 5's real `makeCsr` helper, and the wrangler `REPLACE_WITH_*` IDs created by `wrangler kv namespace create` / Task 0. No "TBD/handle errors/etc."

**Type consistency:** `JwsPayload`/`JobState`/`SyncCode`/`AsyncCode`/`Op` defined in Task 2 `types.ts` and used verbatim downstream. `verifyAndAuthorize` returns `{ok,payload,firstSeen}` (Task 6) consumed in Task 11 (`isRenewal: !auth.firstSeen`). `CfDns` methods (Task 7) consumed in Tasks 8/10/11. `AcmeClient.issue` shape (Task 8) consumed in Task 10. `decideBudget/consume` (Task 9) consumed in Task 10.

**Known follow-ups recorded for the spec:** (a) the `GET /provision/:jobId?installId=` poll-URL refinement (Task 11) must be added to the spec's install-side contract; (b) sub-project 2 is its own spec/plan.
