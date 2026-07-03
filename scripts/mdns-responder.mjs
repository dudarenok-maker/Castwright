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
    one address per name (see primaryLanIp's known-limitation note above).

    RFC 6762 requires case-insensitive name comparison, so the match is done
    on lowercased names — but the answer echoes back `queriedName` exactly as
    received (not lowercased), matching conventional DNS/mDNS responder
    behaviour of preserving the queried name's original casing. */
export function buildAnswer(queriedName, configuredHostnames, primaryIp) {
  if (primaryIp === null) return null;
  const queriedNameLower = queriedName.toLowerCase();
  if (!configuredHostnames.some((hostname) => hostname.toLowerCase() === queriedNameLower)) return null;
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
      const questionNameLower = question.name.toLowerCase();
      if (!hostnames.some((hostname) => hostname.toLowerCase() === questionNameLower)) continue;
      try {
        const ip = await primaryLanIp();
        const answers = buildAnswer(question.name, hostnames, ip);
        if (answers) mdns.respond({ answers });
      } catch (err) {
        process.stderr.write(`[mdns-responder] failed to answer query for ${question.name}: ${err.message}\n`);
      }
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
