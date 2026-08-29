#!/usr/bin/env node
// scripts/check-audit.mjs
//
// Runs `npm audit --json` in a target directory and treats any advisory at
// `high` or `critical` severity as a gate failure unless it is waived in the
// committed `audit-waivers.json` file at repo root (#2434, scope decided in the
// parent's decision comment 2026-08-29).
//
//   root:   node scripts/check-audit.mjs            (full audit, no --omit)
//   server: node scripts/check-audit.mjs --omit-dev (production/runtime scope)
//
// --dir <path> runs npm audit in an arbitrary directory instead of the cwd.
// --omit-dev   passes --omit=dev through to npm audit.
//
// Exit codes:
//   0  everything at/above high is waived, and no waiver is expired.
//   1  a high/critical advisory is not covered by an active waiver.
//   2  a waiver entry in audit-waivers.json is past its expiry (must be renewed
//      or removed; an expired waiver also counts as absent for exit-1 matching).
//   3  the audit cannot be trusted - npm audit failed to run, or its --json
//      output could not be parsed. Fail closed: a gate that can't report is a
//      gate that must not report green.
//
// Severity threshold matches both #2424's and #1863's accepted baseline
// (`high: 0, critical: 0`): low/moderate noise is deliberately ignored.
// Root's tree is dev-only - omitting dev would make the gate vacuous - so root
// scans everything; server/ scans runtime scope only.

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectlyInvoked } from './lib/is-main-module.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Waivers live at repo root regardless of --dir or the calling cwd, so root
// and server legs read the same file.
const ROOT = resolve(__dirname, '..');
const WAIVERS_FILE = join(ROOT, 'audit-waivers.json');

// Severities that count as a gate failure (--audit-level=high).
const GATE_SEVERITIES = new Set(['high', 'critical']);

export function parseArgs(argv) {
  const args = { dir: null, omitDev: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') {
      args.dir = argv[++i];
      if (!args.dir) throw new Error('--dir requires a value');
    } else if (a === '--omit-dev') {
      args.omitDev = true;
    } else if (a === '-h' || a === '--help') {
      args.help = true;
    } else if (a.startsWith('--')) {
      throw new Error(`unknown flag: ${a}`);
    } else {
      throw new Error(`unexpected positional argument: ${a}`);
    }
  }
  return args;
}

function usage() {
  return [
    'Usage: node scripts/check-audit.mjs [--dir <path>] [--omit-dev]',
    '',
    '  --dir <path>  run npm audit in <path> instead of the current directory',
    '  --omit-dev    pass --omit=dev to npm audit (server/ runtime scope)',
  ].join('\n');
}

/** True for severities the gate refuses (npm audit --audit-level=high). */
export function isGateSeverity(severity) {
  return GATE_SEVERITIES.has(severity);
}

/** Collect every advisory GHSA id reachable from one vulnerabilities entry. */
export function collectAdvisoryIds(entry) {
  const ids = new Set();
  for (const v of entry?.via ?? []) {
    if (typeof v === 'string') {
      ids.add(v);
    } else if (v && typeof v.source === 'string') {
      ids.add(v.source);
    }
  }
  return ids;
}

/**
 * A waiver is expired when its `expiry` (YYYY-MM-DD) is earlier than today
 * (UTC). Malformed/missing expiry never expires - a bad entry still fails, but
 * via loading-time validation rather than by silently ignoring it.
 */
export function isExpired(waiver, today = new Date()) {
  if (!waiver || typeof waiver.expiry !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(waiver.expiry);
  if (!m) return false;
  const expiry = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const now = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return expiry < now;
}

/**
 * Cross-check the audit report against the waiver list.
 *
 * @param {Record<string, any>} vulnerabilities  npm audit's `vulnerabilities`
 * @param {Array<{ghsaId:string,expiry:string}>} waivers
 * @returns {{missing: {package:string, advisories:string[]}[], expired: string[]}}
 */
export function gateFailures(vulnerabilities, waivers) {
  const expired = waivers
    .filter((w) => isExpired(w))
    .map((w) => (w && typeof w.ghsaId === 'string' ? w.ghsaId : '(blank/unknown ghsaId)'));
  // An expired waiver is treated as if it does not exist: the advisory it once
  // covered is unwaived again until the waiver is renewed with a fresh look.
  const active = new Set(
    waivers
      .filter((w) => w && typeof w.ghsaId === 'string' && !isExpired(w))
      .map((w) => w.ghsaId),
  );

  const missing = [];
  for (const [pkg, entry] of Object.entries(vulnerabilities ?? {})) {
    if (!entry || !isGateSeverity(entry.severity)) continue;
    const advisories = [...collectAdvisoryIds(entry)];
    if (advisories.length === 0) {
      // high/critical with no attributable advisory id - fail closed rather
      // than let an unmatchable entry pass silently.
      missing.push({ package: pkg, advisories: [] });
      continue;
    }
    const unwaived = advisories.filter((id) => !active.has(id));
    if (unwaived.length > 0) missing.push({ package: pkg, advisories: unwaived });
  }
  return { missing, expired };
}

/** Run `npm audit --json` in a directory; return status + captured output. */
export function runNpmAudit({ dir, omitDev = false } = {}) {
  const args = ['audit', '--json', '--audit-level=high'];
  if (omitDev) args.push('--omit=dev');
  // npm is a .cmd shim on Windows; Node refuses to spawn a .cmd directly
  // (EINVAL) unless routed through a shell (same idiom as check-import-cycles).
  const command = `npm ${args.map((a) => `"${a}"`).join(' ')}`;
  const result = spawnSync(command, {
    cwd: dir,
    encoding: 'utf8',
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ?? null,
  };
}

/**
 * Parse npm audit's --json stdout into its `vulnerabilities` map. npm exits 1
 * when it finds advisories, but still prints the JSON on stdout, so the exit
 * code is not a reliable signal - the parsed report is.
 */
export function parseAuditOutput(stdout) {
  const trimmed = (stdout ?? '').trim();
  if (trimmed.length === 0) return {};
  const parsed = JSON.parse(trimmed);
  const vulns = parsed && parsed.vulnerabilities ? parsed.vulnerabilities : parsed;
  return vulns && typeof vulns === 'object' ? vulns : {};
}

export function loadWaivers(file = WAIVERS_FILE) {
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${file} must be an array of {ghsaId, package, reason, expiry}`);
  return parsed;
}

export function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`check-audit: ${err.message}\n\n${usage()}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const dir = args.dir ? resolve(args.dir) : process.cwd();

  let waivers;
  try {
    waivers = loadWaivers();
  } catch (err) {
    process.stderr.write(`check-audit: FAILED to load audit-waivers.json - ${err.message}\n`);
    return 3;
  }

  const { stdout, stderr, error } = runNpmAudit({ dir, omitDev: args.omitDev });
  if (error) {
    process.stderr.write(`check-audit: FAILED to run npm audit - ${error.message}\n`);
    return 3;
  }

  let vulnerabilities;
  try {
    vulnerabilities = parseAuditOutput(stdout);
  } catch (err) {
    process.stderr.write(`check-audit: FAILED to parse npm audit JSON - ${err.message}\n`);
    if (stderr) process.stderr.write(`${stderr}\n`);
    return 3;
  }

  const { missing, expired } = gateFailures(vulnerabilities, waivers);

  if (expired.length > 0) {
    process.stderr.write(
      `check-audit: FAIL - ${expired.length} waiver(s) in audit-waivers.json are past their expiry and must be renewed or removed:\n` +
        expired.map((g) => `  ${g}`).join('\n') +
        '\n',
    );
    return 2;
  }

  if (missing.length > 0) {
    process.stderr.write(
      `check-audit: FAIL - ${missing.length} high/critical vulnerabilit${missing.length === 1 ? 'y' : 'ies'} not waived:\n`,
    );
    for (const m of missing) {
      process.stderr.write(`  ${m.package}${m.advisories.length ? ` (${m.advisories.join(', ')})` : ''}\n`);
    }
    return 1;
  }

  process.stdout.write(`check-audit: OK - no unwaived high/critical advisories in ${dir}.\n`);
  return 0;
}

if (isDirectlyInvoked(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}