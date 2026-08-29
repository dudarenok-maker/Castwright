// #2632 N27/N29 — stop-app.ps1/.mjs used to hardcode :9000 in their
// orphan-sweep port list, which is wrong for a worktree running its sidecar
// on a different LOCAL_TTS_PORT: the sweep (a force-kill in stop-app.ps1, a
// warn in stop-app.mjs) targeted the PRIMARY checkout's sidecar instead of
// this checkout's own. Fix: read the actual owned port from
// .run/tts.owner.<port>.json (server/src/tts/sidecar-owner.ts's SidecarOwnerNote).
//
// N29: the note is absent in three routine states (after a clean shutdown,
// with autoStartSidecar off, or before a sidecar has ever claimed ownership
// this run) — falling back to the factory default 9000 there is itself the
// hazard, since 9000 is exactly the port a DIFFERENT checkout's sidecar is
// likely to own. So the fallback instead reads LOCAL_TTS_PORT out of this
// checkout's own server/.env, and only sweeps nothing (returns null) when
// that is unavailable too.
//
// Discovered by `npm run test:hooks` (node --test scripts/tests/*.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveSidecarSweepPort,
  buildPortsToSweep,
  resolveConfiguredServerPort,
  resolveConfiguredVitePort,
  getStopSummaryMessage,
} from '../lib/sidecar-sweep-port.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function withTempRunDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'sweep-port-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withTempServerEnv(contents, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'sweep-port-env-'));
  const envPath = join(dir, '.env');
  try {
    if (contents !== null) writeFileSync(envPath, contents);
    return fn(envPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('resolveSidecarSweepPort returns the per-checkout port recorded in tts.owner.<port>.json', () => {
  withTempRunDir((dir) => {
    writeFileSync(
      join(dir, 'tts.owner.9010.json'),
      JSON.stringify({ pid: process.pid, ppid: process.ppid, port: 9010, startedAt: '2026-08-25T00:00:00.000Z' }),
    );
    withTempServerEnv('LOCAL_TTS_PORT=9020\n', (envPath) => {
      // The live owner note wins over server/.env when both are present.
      assert.equal(resolveSidecarSweepPort(dir, envPath), 9010);
    });
  });
});

test('resolveSidecarSweepPort falls back to server/.env LOCAL_TTS_PORT when no tts.owner.<port>.json note exists', () => {
  withTempRunDir((dir) => {
    withTempServerEnv('PORT=8080\nLOCAL_TTS_PORT=9030\n', (envPath) => {
      assert.equal(resolveSidecarSweepPort(dir, envPath), 9030);
    });
  });
});

test('resolveSidecarSweepPort falls back to server/.env LOCAL_TTS_PORT when tts.owner.<port>.json is corrupt JSON', () => {
  withTempRunDir((dir) => {
    writeFileSync(join(dir, 'tts.owner.9040.json'), 'not valid json {{{');
    withTempServerEnv('LOCAL_TTS_PORT=9040\n', (envPath) => {
      assert.equal(resolveSidecarSweepPort(dir, envPath), 9040);
    });
  });
});

test('resolveSidecarSweepPort falls back to server/.env LOCAL_TTS_PORT when the recorded port is out of range', () => {
  withTempRunDir((dir) => {
    writeFileSync(
      join(dir, 'tts.owner.99999.json'),
      JSON.stringify({ pid: 1234, ppid: 1, port: 99999, startedAt: '2026-08-25T00:00:00.000Z' }),
    );
    withTempServerEnv('LOCAL_TTS_PORT=9050\n', (envPath) => {
      assert.equal(resolveSidecarSweepPort(dir, envPath), 9050);
    });
  });
});

test('resolveSidecarSweepPort falls back to server/.env LOCAL_TTS_PORT when two note files exist in the same run dir (#2641 shared-APP_RUN_DIR scenario)', () => {
  withTempRunDir((dir) => {
    // Two live notes (both have current process PID) = ambiguous, must fall back
    writeFileSync(
      join(dir, 'tts.owner.9010.json'),
      JSON.stringify({ pid: process.pid, ppid: 1, port: 9010, startedAt: '2026-08-25T00:00:00.000Z' }),
    );
    writeFileSync(
      join(dir, 'tts.owner.9011.json'),
      JSON.stringify({ pid: process.pid, ppid: 1, port: 9011, startedAt: '2026-08-25T00:00:01.000Z' }),
    );
    withTempServerEnv('LOCAL_TTS_PORT=9060\n', (envPath) => {
      // Two candidate notes, no way to tell which is current — must not
      // guess between them; fall back exactly as the zero-match case does.
      assert.equal(resolveSidecarSweepPort(dir, envPath), 9060);
    });
  });
});

test('resolveSidecarSweepPort returns null (sweep nothing) when neither the note nor server/.env yield a port', () => {
  withTempRunDir((dir) => {
    withTempServerEnv(null, (envPath) => {
      assert.equal(resolveSidecarSweepPort(dir, envPath), null);
    });
  });
});

test('resolveSidecarSweepPort returns null when server/.env has no LOCAL_TTS_PORT line', () => {
  withTempRunDir((dir) => {
    withTempServerEnv('PORT=8080\nWORKSPACE_DIR=../workspace\n', (envPath) => {
      assert.equal(resolveSidecarSweepPort(dir, envPath), null);
    });
  });
});

test('resolveSidecarSweepPort never returns the factory-default 9000 as a guess', () => {
  // #2632 N29: 9000 is exactly the value most likely to belong to a
  // DIFFERENT checkout's sidecar, so it must never come back as a blind
  // fallback — only as an explicit, sourced value.
  withTempRunDir((dir) => {
    withTempServerEnv(null, (envPath) => {
      assert.notEqual(resolveSidecarSweepPort(dir, envPath), 9000);
    });
    assert.notEqual(resolveSidecarSweepPort(dir), 9000);
  });
});

// #2632 N34 — call-site coverage, BEHAVIOURAL this time. Pass 6's source-text
// guard pinned the ASSIGNMENT (`const ttsPort = resolveSidecarSweepPort(...)`)
// but not the USE one line below — reverting `portsToSweep` to
// `[8080, 8443, 9000]` (resolver still called, result discarded) left that
// guard green. buildPortsToSweep() is the ENTIRE call-site computation
// (resolve + assemble), so testing it end-to-end via real temp files proves
// the resolved port actually reaches the swept list — there's no separate
// "call site" left to independently mutate away from the tested behaviour.
test('buildPortsToSweep includes the resolved sidecar port from tts.owner.<port>.json', () => {
  withTempRunDir((dir) => {
    writeFileSync(
      join(dir, 'tts.owner.9010.json'),
      JSON.stringify({ pid: process.pid, ppid: process.ppid, port: 9010, startedAt: '2026-08-25T00:00:00.000Z' }),
    );
    withTempServerEnv('LOCAL_TTS_PORT=9020\n', (envPath) => {
      assert.deepEqual(buildPortsToSweep([8080, 8443], dir, envPath), [8080, 8443, 9010]);
    });
  });
});

test('buildPortsToSweep includes the resolved sidecar port from server/.env fallback', () => {
  withTempRunDir((dir) => {
    withTempServerEnv('LOCAL_TTS_PORT=9030\n', (envPath) => {
      assert.deepEqual(buildPortsToSweep([8080, 8443], dir, envPath), [8080, 8443, 9030]);
    });
  });
});

test('buildPortsToSweep sweeps only the base ports when no sidecar port resolves', () => {
  withTempRunDir((dir) => {
    withTempServerEnv(null, (envPath) => {
      assert.deepEqual(buildPortsToSweep([8080, 8443], dir, envPath), [8080, 8443]);
    });
  });
});

// #2632 N46 — the PowerShell twin (Get-PortsToSweep) declares its BasePorts
// parameter [Parameter(Mandatory)] with no [AllowEmptyCollection()], which
// REJECTS an empty array at bind time in a checkout with neither
// .env.local nor a server/.env PORT line (the primary checkout's actual
// today-state). buildPortsToSweep takes a plain JS array, which has no such
// binding-stage validation, but this pins that the DEGRADE is correct on
// both sides of the empty-base-list cell so a future divergence between the
// two languages reddens here rather than only in PowerShell.
test('buildPortsToSweep returns an empty array when basePorts is empty and no sidecar port resolves', () => {
  withTempRunDir((dir) => {
    withTempServerEnv(null, (envPath) => {
      assert.deepEqual(buildPortsToSweep([], dir, envPath), []);
    });
  });
});

test('buildPortsToSweep returns just the sidecar port when basePorts is empty but LOCAL_TTS_PORT=9010 resolves', () => {
  withTempRunDir((dir) => {
    withTempServerEnv('LOCAL_TTS_PORT=9010\n', (envPath) => {
      assert.deepEqual(buildPortsToSweep([], dir, envPath), [9010]);
    });
  });
});

// Narrow structural check on top of the behavioural coverage above: proves
// stop-app.mjs's own call site actually feeds buildPortsToSweep's result to
// portsToSweep, rather than reassigning a literal array after calling it for
// its side effects. Deliberately does NOT pin the resolver/runDir/envPath
// identifiers (that brittleness — reddening on a plain rename — was pass 7's
// other finding about this same guard).
test('stop-app.mjs assigns portsToSweep from buildPortsToSweep(), not a hardcoded array', () => {
  const source = readFileSync(resolve(__dirname, '..', 'stop-app.mjs'), 'utf8');
  assert.match(
    source,
    /portsToSweep\s*=\s*buildPortsToSweep\(/,
    'stop-app.mjs must assign portsToSweep from buildPortsToSweep(...)',
  );
  assert.doesNotMatch(
    source,
    /portsToSweep\s*=\s*\[[^\]]*9000[^\]]*\]/,
    'stop-app.mjs must not hardcode a literal 9000 into the swept ports array',
  );
});

// #2632 N39 — the base-port half of the same hazard: stop-app.mjs used to
// pass a literal [8080, 8443] into buildPortsToSweep, which is the PRIMARY
// checkout's server port regardless of what THIS checkout is configured
// for. Pin the call site to resolve the server port via
// resolveConfiguredServerPort rather than hardcoding 8080 into the array
// buildPortsToSweep receives.
test('stop-app.mjs resolves its server base port via resolveConfiguredServerPort, not a hardcoded 8080', () => {
  const source = readFileSync(resolve(__dirname, '..', 'stop-app.mjs'), 'utf8');
  assert.match(
    source,
    /resolveConfiguredServerPort\(/,
    'stop-app.mjs must call resolveConfiguredServerPort(...) to resolve its own server port',
  );
  assert.doesNotMatch(
    source,
    /buildPortsToSweep\(\s*\[\s*8080\b/,
    'stop-app.mjs must not pass a hardcoded 8080 into buildPortsToSweep(...)',
  );
});

// #2632 N39 pass-8 follow-up — 8443 (LAN HTTPS) must never re-appear in
// basePorts either. It is not per-worktree offset by wt-new.mjs, and unlike
// PORT/LOCAL_TTS_PORT there is no way to resolve it safely: this launcher
// always spawns NODE_ENV=production, so listenWithAutoRebind can rebind
// LAN_HTTPS_PORT away from its configured value on conflict — a
// server/.env-derived guess could still name a port this checkout never
// bound, and there is no owner-note file (unlike .run/tts.owner.<port>.json) to
// settle it. basePorts must stay resolver-derived only, never a literal
// 8443 added back in.
test('stop-app.mjs never assembles a literal 8443 into basePorts', () => {
  const source = readFileSync(resolve(__dirname, '..', 'stop-app.mjs'), 'utf8');
  assert.doesNotMatch(
    source,
    /basePorts\s*=\s*serverPort\s*\?\s*\[serverPort,\s*8443\]/,
    'stop-app.mjs must not hardcode 8443 alongside the resolved server port',
  );
  assert.doesNotMatch(
    source,
    /\[\s*8443\s*\]/,
    'stop-app.mjs must not fall back to a literal [8443] array',
  );
});

// #2632 N36 — the server/.env tier must reject exactly what the server's own
// resolveSidecarPort() (server/src/tts/sidecar-owner.ts, N28) rejects, not a
// looser superset. A leading "+", exponent notation, hex, or a decimal point
// all pass Number() but must not resolve to a port here.
test('resolveSidecarSweepPort rejects LOCAL_TTS_PORT spellings the server rejects', () => {
  const invalidSpellings = ['+9010', '1e4', '0x2386', '9010.0'];
  for (const spelling of invalidSpellings) {
    withTempRunDir((dir) => {
      withTempServerEnv(`LOCAL_TTS_PORT=${spelling}\n`, (envPath) => {
        assert.equal(
          resolveSidecarSweepPort(dir, envPath),
          null,
          `expected LOCAL_TTS_PORT=${spelling} to resolve to null (server rejects it too)`,
        );
      });
    });
  }
});

test('resolveSidecarSweepPort accepts a leading-zero spelling the server also accepts', () => {
  withTempRunDir((dir) => {
    withTempServerEnv('LOCAL_TTS_PORT=007\n', (envPath) => {
      assert.equal(resolveSidecarSweepPort(dir, envPath), 7);
    });
  });
});

// #2632 N42 — process.loadEnvFile takes the LAST assignment of a duplicate
// key (later process.env[key] = value calls simply overwrite earlier ones);
// the sweep-port reader used to take the FIRST regex match instead, which
// meant a hand-edited server/.env with two LOCAL_TTS_PORT lines swept a
// port the server never actually bound to (harmful direction, same class of
// hazard N36 exists to prevent). This must take the last line, like the
// real loader does.
test('resolveSidecarSweepPort takes the LAST LOCAL_TTS_PORT line on a duplicate key, matching process.loadEnvFile', () => {
  withTempRunDir((dir) => {
    withTempServerEnv('LOCAL_TTS_PORT=9010\nLOCAL_TTS_PORT=9020\n', (envPath) => {
      assert.equal(resolveSidecarSweepPort(dir, envPath), 9020);
    });
  });
});

test('resolveConfiguredServerPort reads this checkout\'s own PORT from server/.env', () => {
  withTempServerEnv('PORT=8200\nWORKSPACE_DIR=../workspace\n', (envPath) => {
    assert.equal(resolveConfiguredServerPort(envPath), 8200);
  });
});

test('resolveConfiguredServerPort takes the LAST PORT line on a duplicate key', () => {
  withTempServerEnv('PORT=8080\nPORT=8200\n', (envPath) => {
    assert.equal(resolveConfiguredServerPort(envPath), 8200);
  });
});

test('resolveConfiguredServerPort returns null (sweep nothing) when server/.env has no PORT line', () => {
  withTempServerEnv('WORKSPACE_DIR=../workspace\n', (envPath) => {
    assert.equal(resolveConfiguredServerPort(envPath), null);
  });
});

test('resolveConfiguredServerPort prefers a shell-exported PORT over server/.env', () => {
  const prev = process.env.PORT;
  process.env.PORT = '8300';
  try {
    withTempServerEnv('PORT=8200\n', (envPath) => {
      assert.equal(resolveConfiguredServerPort(envPath), 8300);
    });
  } finally {
    if (prev === undefined) delete process.env.PORT;
    else process.env.PORT = prev;
  }
});

test('resolveConfiguredVitePort reads this checkout\'s own VITE_PORT from .env.local', () => {
  withTempServerEnv('VITE_PORT=5293\nPORT=8200\n', (envPath) => {
    assert.equal(resolveConfiguredVitePort(envPath), 5293);
  });
});

test('resolveConfiguredVitePort returns null (sweep nothing) when .env.local has no VITE_PORT line', () => {
  withTempServerEnv('PORT=8200\n', (envPath) => {
    assert.equal(resolveConfiguredVitePort(envPath), null);
  });
});

// #2632 N39 — stop-app.mjs used to hardcode [8080, 8443] as its base sweep
// ports, which is the PRIMARY checkout's server port regardless of what
// THIS checkout is actually configured for. Behavioural, not source-text:
// drives the real call site's inputs (a slot-1-shaped server/.env) through
// resolveConfiguredServerPort the same way stop-app.mjs's call site does,
// so a reversion back to a hardcoded 8080 has nowhere to hide.
test('resolveConfiguredServerPort resolves a worktree-shaped server/.env to its OWN port, not the primary\'s 8080', () => {
  withTempServerEnv('PORT=8090\nWORKSPACE_DIR=../castwright-workspace\nLOCAL_TTS_PORT=9010\n', (envPath) => {
    const resolved = resolveConfiguredServerPort(envPath);
    assert.equal(resolved, 8090);
    assert.notEqual(resolved, 8080);
  });
});

// #2632 N48 — process.loadEnvFile sets process.env keys, and on Windows
// process.env is case-insensitive, so a real `port=8090` or `Port=8090` line
// DOES set process.env.PORT there and the server binds :8090 from it. The
// key-matching regex here had no `i` flag, so it read `port=8090` as no
// match at all (null) — diverging from both the real Node loader AND from
// PowerShell's `-match`, which is case-insensitive by default and already
// resolved this correctly. Node was the wrong side, failing safe but wrong.
test('resolveConfiguredServerPort reads a lowercase/mixed-case PORT key, matching process.loadEnvFile on Windows', () => {
  withTempServerEnv('port=8090\n', (envPath) => {
    assert.equal(resolveConfiguredServerPort(envPath), 8090);
  });
  withTempServerEnv('Port=8095\n', (envPath) => {
    assert.equal(resolveConfiguredServerPort(envPath), 8095);
  });
});

test('resolveSidecarSweepPort prefers a shell-exported LOCAL_TTS_PORT over server/.env, mirroring process.loadEnvFile precedence', () => {
  const prev = process.env.LOCAL_TTS_PORT;
  process.env.LOCAL_TTS_PORT = '9100';
  try {
    withTempRunDir((dir) => {
      withTempServerEnv('LOCAL_TTS_PORT=9010\n', (envPath) => {
        assert.equal(resolveSidecarSweepPort(dir, envPath), 9100);
      });
    });
  } finally {
    if (prev === undefined) delete process.env.LOCAL_TTS_PORT;
    else process.env.LOCAL_TTS_PORT = prev;
  }
});

// #2632 N52 — a server/.env whose first bytes are a UTF-8 BOM (EF BB BF)
// decodes to a leading U+FEFF. process.loadEnvFile does NOT strip that BOM
// before parsing keys, so the BOM-prefixed first line's key is literally
// "<BOM>LOCAL_TTS_PORT" — the server's own resolveSidecarPort() never sees
// plain LOCAL_TTS_PORT and falls back to 9000. Measured directly against
// process.loadEnvFile (not assumed): with this exact byte layout,
// process.env.LOCAL_TTS_PORT stays undefined. A reader that resolves 9010
// here disagrees with what the server actually binds — the exact
// cross-checkout kill hazard this sweep exists to prevent.
function withTempServerEnvBytes(bytes, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'sweep-port-env-'));
  const envPath = join(dir, '.env');
  try {
    writeFileSync(envPath, bytes);
    return fn(envPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('resolveSidecarSweepPort returns null on a BOM-prefixed LOCAL_TTS_PORT line, matching process.loadEnvFile', () => {
  const bomBytes = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('LOCAL_TTS_PORT=9010\n', 'utf8'),
  ]);
  withTempRunDir((dir) => {
    withTempServerEnvBytes(bomBytes, (envPath) => {
      assert.equal(resolveSidecarSweepPort(dir, envPath), null);
    });
  });
});

test('resolveSidecarSweepPort still resolves LOCAL_TTS_PORT with no BOM present (control for the BOM cell)', () => {
  const noBomBytes = Buffer.from('LOCAL_TTS_PORT=9010\n', 'utf8');
  withTempRunDir((dir) => {
    withTempServerEnvBytes(noBomBytes, (envPath) => {
      assert.equal(resolveSidecarSweepPort(dir, envPath), 9010);
    });
  });
});

// #2632 N52 — a duplicate key whose LAST occurrence carries a trailing
// comment. Measured directly against process.loadEnvFile: it strips the
// inline `# comment` from an unquoted value and takes the LAST assignment,
// so `LOCAL_TTS_PORT=9010\nLOCAL_TTS_PORT=9011 # comment\n` resolves
// process.env.LOCAL_TTS_PORT to "9011". A reader whose regex requires the
// captured token to run to end-of-line (no trailing comment) fails to match
// that last line at all and silently falls back to the EARLIER value
// (9010) the server has already overwritten.
test('resolveSidecarSweepPort takes the LAST duplicate value even when it carries a trailing comment, matching process.loadEnvFile', () => {
  withTempRunDir((dir) => {
    withTempServerEnv('LOCAL_TTS_PORT=9010\nLOCAL_TTS_PORT=9011 # comment\n', (envPath) => {
      assert.equal(resolveSidecarSweepPort(dir, envPath), 9011);
    });
  });
});

// #2632 N53 — stop-app.mjs/.ps1 used to print "[OK] nothing to stop"
// unconditionally whenever no PID kill happened, even after a sweep
// reported a still-listening/undead port, or when zero ports even resolved
// for this checkout (so nothing was actually checked). Both are false
// reassurance distinct from "checked known ports and found them clear".
test('getStopSummaryMessage returns null when a PID kill happened (per-item lines already said so)', () => {
  assert.equal(getStopSummaryMessage(true, false, [8080]), null);
});

test('getStopSummaryMessage returns null when the sweep is incomplete (a kill failed / something still listens)', () => {
  assert.equal(getStopSummaryMessage(false, true, [8080]), null);
});

test('getStopSummaryMessage distinguishes "no ports resolved" from "checked and clear"', () => {
  assert.equal(
    getStopSummaryMessage(false, false, []),
    '[OK] nothing to stop (no ports resolved for this checkout)',
  );
  assert.equal(getStopSummaryMessage(false, false, [8080]), '[OK] nothing to stop');
});

// #2754 review finding — the regex /^tts\.owner\.\d+\.json$/ enforces
// digits-only for the port segment, but all existing test fixtures happened
// to already use clean port segments, so a mutant regex like /^tts\.owner\..*\.json$/
// (accepting ANY characters) would pass every test unchanged. This cell pins
// the digits-only requirement by creating a run dir with BOTH a valid note file
// AND a malformed one with a non-numeric port segment, asserting the malformed
// file is filtered out and the resolution still succeeds with the valid file.
test('resolveSidecarSweepPort filters out note files with non-numeric port segments (mutation-proof digits-only gate)', () => {
  withTempRunDir((dir) => {
    // Valid file with digits-only port segment
    writeFileSync(
      join(dir, 'tts.owner.9010.json'),
      JSON.stringify({ pid: 1234, ppid: 1, port: 9010, startedAt: '2026-08-25T00:00:00.000Z' }),
    );
    // Malformed file with letters in the port segment
    writeFileSync(
      join(dir, 'tts.owner.abc.json'),
      JSON.stringify({ pid: 5678, ppid: 1, port: 123, startedAt: '2026-08-25T00:00:01.000Z' }),
    );
    withTempServerEnv('LOCAL_TTS_PORT=9020\n', (envPath) => {
      // The malformed file should be filtered out by the regex, leaving exactly one valid file,
      // which resolves successfully to 9010 (not falling back to 9020).
      assert.equal(resolveSidecarSweepPort(dir, envPath), 9010);
    });
  });
});

test('resolveSidecarSweepPort filters out note files with mixed alphanumeric port segments', () => {
  withTempRunDir((dir) => {
    writeFileSync(
      join(dir, 'tts.owner.9010.json'),
      JSON.stringify({ pid: 1234, ppid: 1, port: 9010, startedAt: '2026-08-25T00:00:00.000Z' }),
    );
    // Malformed file with digits and letters mixed
    writeFileSync(
      join(dir, 'tts.owner.90a0.json'),
      JSON.stringify({ pid: 5678, ppid: 1, port: 123, startedAt: '2026-08-25T00:00:01.000Z' }),
    );
    withTempServerEnv('LOCAL_TTS_PORT=9020\n', (envPath) => {
      assert.equal(resolveSidecarSweepPort(dir, envPath), 9010);
    });
  });
});

test('resolveSidecarSweepPort filters out note files with non-alphanumeric characters in port segment', () => {
  withTempRunDir((dir) => {
    writeFileSync(
      join(dir, 'tts.owner.9010.json'),
      JSON.stringify({ pid: 1234, ppid: 1, port: 9010, startedAt: '2026-08-25T00:00:00.000Z' }),
    );
    // Malformed file with dash/hyphen in port segment
    writeFileSync(
      join(dir, 'tts.owner.90-10.json'),
      JSON.stringify({ pid: 5678, ppid: 1, port: 9010, startedAt: '2026-08-25T00:00:01.000Z' }),
    );
    withTempServerEnv('LOCAL_TTS_PORT=9020\n', (envPath) => {
      assert.equal(resolveSidecarSweepPort(dir, envPath), 9010);
    });
  });
});

test('resolveSidecarSweepPort filters out note files with empty port segment', () => {
  withTempRunDir((dir) => {
    writeFileSync(
      join(dir, 'tts.owner.9010.json'),
      JSON.stringify({ pid: 1234, ppid: 1, port: 9010, startedAt: '2026-08-25T00:00:00.000Z' }),
    );
    // Malformed file with empty port segment (just dots)
    writeFileSync(
      join(dir, 'tts.owner..json'),
      JSON.stringify({ pid: 5678, ppid: 1, port: 123, startedAt: '2026-08-25T00:00:01.000Z' }),
    );
    withTempServerEnv('LOCAL_TTS_PORT=9020\n', (envPath) => {
      assert.equal(resolveSidecarSweepPort(dir, envPath), 9010);
    });
  });
});

test('resolveSidecarSweepPort falls back to server/.env when run dir contains ONLY malformed note files', () => {
  withTempRunDir((dir) => {
    // Only malformed files, no valid digits-only note file
    writeFileSync(
      join(dir, 'tts.owner.abc.json'),
      JSON.stringify({ pid: 1234, ppid: 1, port: 123, startedAt: '2026-08-25T00:00:00.000Z' }),
    );
    writeFileSync(
      join(dir, 'tts.owner.90x0.json'),
      JSON.stringify({ pid: 5678, ppid: 1, port: 456, startedAt: '2026-08-25T00:00:01.000Z' }),
    );
    withTempServerEnv('LOCAL_TTS_PORT=9030\n', (envPath) => {
      // No valid files match the digits-only regex, so fall back to server/.env
      assert.equal(resolveSidecarSweepPort(dir, envPath), 9030);
    });
  });
});

test('#2754 — resolveSidecarSweepPort uses a stale note (dead PID) when it is the only one (orphan detection)', () => {
  // Concrete scenario: a server crashed hard (taskkill /T /F), leaving its sidecar
  // running and orphaned. The note has a dead PID, but its EXISTENCE is the signal
  // for the sweep to know "reap this port". If the resolver filters by PID liveness
  // on the read side, it loses the signal for orphan detection.
  withTempRunDir((dir) => {
    // Stale note: dead PID (99999 is virtually guaranteed never to be running)
    writeFileSync(
      join(dir, 'tts.owner.9010.json'),
      JSON.stringify({ pid: 99999, ppid: 1, port: 9010, startedAt: '2026-08-25T00:00:00.000Z' }),
    );
    withTempServerEnv('LOCAL_TTS_PORT=9020\n', (envPath) => {
      // The single note should be used (9010), not fall back to server/.env (9020),
      // even though its PID is dead. This is critical for `npm run stop` to detect
      // and reap an orphaned sidecar left by a hard-killed server.
      assert.equal(resolveSidecarSweepPort(dir, envPath), 9010);
    });
  });
});

test('#2754 — resolveSidecarSweepPort falls back to server/.env when two notes exist (ambiguous)', () => {
  withTempRunDir((dir) => {
    // Two notes, whether dead or live — the existence of multiple notes means
    // ambiguity and we cannot pick a winner. The sweep resolver cannot distinguish
    // which note represents the actual sidecar, so it falls back to server/.env.
    writeFileSync(
      join(dir, 'tts.owner.9010.json'),
      JSON.stringify({ pid: 99999, ppid: 1, port: 9010, startedAt: '2026-08-25T00:00:00.000Z' }),
    );
    writeFileSync(
      join(dir, 'tts.owner.9011.json'),
      JSON.stringify({ pid: 99998, ppid: 1, port: 9011, startedAt: '2026-08-25T00:00:01.000Z' }),
    );
    withTempServerEnv('LOCAL_TTS_PORT=9030\n', (envPath) => {
      // Two notes = ambiguous; fall back to server/.env (not the digits of either note).
      assert.equal(resolveSidecarSweepPort(dir, envPath), 9030);
    });
  });
});
