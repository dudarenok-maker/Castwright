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
//   2  either: (a) a waiver entry in audit-waivers.json is past its expiry
//      (must be renewed or removed; an expired waiver also counts as absent
//      for exit-1 matching), or (b) CLI argument parsing failed (unknown flag
//      or missing required value).
//   3  the audit cannot be trusted - npm audit failed to run, or its --json
//      output could not be parsed, or audit-waivers.json could not be loaded.
//      Fail closed: a gate that can't report is a gate that must not report green.
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

/**
 * Collect advisory GHSA ids and their source packages from one vulnerabilities
 * entry. Returns a map from GHSA id to a set of package names that are the
 * source of that advisory (for waivers to check).
 *
 * For direct advisory objects in via[], the source package is the entry's own
 * package (determined by the caller). For transitive advisories (via entries
 * that are package name strings), the source is the referenced package.
 *
 * Filtering excludes only those explicitly marked below the gate severity
 * threshold (moderate/low/info). If an advisory object doesn't carry its own
 * severity info, it is collected anyway (conservative approach).
 *
 * Cycle detection: track visited packages to avoid infinite recursion on
 * circular dependency chains.
 */
export function collectAdvisoryIds(entry, vulnerabilities = {}, sourcePackage = null, visited = new Set()) {
  // Map from GHSA id to Set of source packages (for waiver checking)
  const idToSourcePackages = new Map();

  for (const v of entry?.via ?? []) {
    if (typeof v === 'string') {
      // This is a package name (e.g., "lodash"). Resolve it in the
      // vulnerabilities map to find its advisory ids.
      if (!visited.has(v)) {
        visited.add(v);
        // Find the first vulnerabilities entry for this package
        let pkgEntry = null;
        for (const [key, vEntry] of Object.entries(vulnerabilities)) {
          if (key === v || key.startsWith(`${v}@`)) {
            pkgEntry = vEntry;
            break;
          }
        }
        if (pkgEntry) {
          // Recursively collect advisory ids from the referenced package.
          // This package is the source of the advisory.
          const transitiveIds = collectAdvisoryIds(pkgEntry, vulnerabilities, v, visited);
          for (const [id, sources] of transitiveIds) {
            if (!idToSourcePackages.has(id)) {
              idToSourcePackages.set(id, new Set());
            }
            for (const src of sources) {
              idToSourcePackages.get(id).add(src);
            }
          }
        }
      }
    } else if (v && typeof v.url === 'string') {
      // This is an advisory object. Extract GHSA id from the url field.
      // Skip ONLY if it explicitly has a severity below the gate threshold.
      // If severity is missing, include it anyway (conservative).
      if (v.severity && !isGateSeverity(v.severity)) continue;
      const match = v.url.match(/GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i);
      if (match) {
        const id = match[0];
        if (!idToSourcePackages.has(id)) {
          idToSourcePackages.set(id, new Set());
        }
        // If sourcePackage is set, this advisory came from a transitive dep
        if (sourcePackage) {
          idToSourcePackages.get(id).add(sourcePackage);
        }
      }
    }
  }
  return idToSourcePackages;
}

/**
 * A waiver is expired when its `expiry` (YYYY-MM-DD) is today or earlier
 * (UTC). Fail-closed: any missing, non-string, or malformed expiry is treated
 * as expired (invalid). This ensures waivers cannot silently persist forever
 * due to malformed dates or missing fields. Validate calendar dates strictly
 * to catch auto-rollover (e.g., month 13 or day 45).
 */
export function isExpired(waiver, today = new Date()) {
  // Fail-closed: missing waiver or missing/non-string expiry = expired
  if (!waiver || typeof waiver.expiry !== 'string') return true;

  // Parse the expiry date string with strict validation
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(waiver.expiry);
  if (!m) return true; // Malformed: does not match YYYY-MM-DD format

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);

  // Validate that the parsed components represent a valid calendar date
  // by constructing a Date and verifying it round-trips back to the same values.
  // This catches invalid dates like 2026-13-45 where JS Date would auto-rollover.
  const expiry = new Date(Date.UTC(year, month - 1, day));
  if (expiry.getUTCFullYear() !== year ||
      expiry.getUTCMonth() !== month - 1 ||
      expiry.getUTCDate() !== day) {
    return true; // Invalid calendar date (auto-rollover detected)
  }

  // Compare: expiry must be strictly AFTER today to be valid (not yet expired)
  const now = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  return expiry <= now; // Expired if expiry is today or earlier
}

/**
 * Cross-check the audit report against the waiver list.
 *
 * @param {Record<string, any>} vulnerabilities  npm audit's `vulnerabilities`
 * @param {Array<{ghsaId:string,package:string,expiry:string}>} waivers
 * @returns {{missing: {package:string, advisories:string[]}[], expired: string[]}}
 */
export function gateFailures(vulnerabilities, waivers) {
  const expired = waivers
    .filter((w) => isExpired(w))
    .map((w) => (w && typeof w.ghsaId === 'string' ? w.ghsaId : '(blank/unknown ghsaId)'));
  // An expired waiver is treated as if it does not exist: the advisory it once
  // covered is unwaived again until the waiver is renewed with a fresh look.
  // Build a map of {ghsaId}_{package} for active waivers to match both fields.
  const active = new Map(
    waivers
      .filter((w) => w && typeof w.ghsaId === 'string' && typeof w.package === 'string' && !isExpired(w))
      .map((w) => [`${w.ghsaId}|${w.package}`, true]),
  );

  const missing = [];
  for (const [pkg, entry] of Object.entries(vulnerabilities ?? {})) {
    if (!entry || !isGateSeverity(entry.severity)) continue;
    const pkgBase = pkg.split('@')[0] || pkg;
    const idToSources = collectAdvisoryIds(entry, vulnerabilities, pkgBase);

    if (idToSources.size === 0) {
      // high/critical with no attributable advisory id - fail closed rather
      // than let an unmatchable entry pass silently.
      missing.push({ package: pkg, advisories: [] });
      continue;
    }

    // For each advisory, check if there's an active waiver for this package
    // or any of its source packages (for transitive dependencies).
    const unwaived = [];
    for (const [id, sourcePackages] of idToSources) {
      // Check if the advisory is waived for either the direct package or
      // any of its source packages (for transitive dependencies)
      const isWaived = active.has(`${id}|${pkgBase}`) ||
        [...sourcePackages].some((src) => active.has(`${id}|${src}`));
      if (!isWaived) unwaived.push(id);
    }

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
 *
 * Fail closed: if the output is empty or does not have a valid `vulnerabilities`
 * key (indicating an error response like { error: {...} } or { error: "..." }),
 * throw an error rather than laundering it as an empty vulnerabilities map.
 * A gate that can't verify is a gate that must not report green. Empty output
 * indicates npm failed or produced no output, both of which are untrustworthy.
 */
export function parseAuditOutput(stdout) {
  const trimmed = (stdout ?? '').trim();
  if (trimmed.length === 0) {
    throw new Error('npm audit produced no output - audit report is empty or npm failed to run');
  }
  const parsed = JSON.parse(trimmed);
  // Real npm audit reports always have a `vulnerabilities` key, even if empty.
  // Error responses (e.g., ENOLOCK, registry unreachable) have an `error` key instead.
  if (!parsed || typeof parsed !== 'object' || !('vulnerabilities' in parsed)) {
    throw new Error(
      parsed && parsed.error
        ? `npm audit returned an error: ${typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error)}`
        : 'npm audit output is missing the vulnerabilities key - output is not a valid audit report',
    );
  }
  const vulns = parsed.vulnerabilities;
  return vulns && typeof vulns === 'object' ? vulns : {};
}

/**
 * Load and validate waivers. Each entry must be an object with:
 *   ghsaId (string): the GHSA advisory id
 *   package (string): the package name the waiver applies to
 *   reason (string): justification for the waiver
 *   expiry (string): YYYY-MM-DD date when the waiver expires
 *
 * Fail closed: any entry missing required fields or with a malformed expiry
 * causes the entire waivers file to be rejected.
 */
export function loadWaivers(file = WAIVERS_FILE) {
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${file} must be an array of {ghsaId, package, reason, expiry}`);

  // Validate each entry - fail closed if any entry is malformed
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    if (!entry || typeof entry !== 'object') {
      throw new Error(`${file} entry ${i} is not an object`);
    }
    if (typeof entry.ghsaId !== 'string' || !entry.ghsaId) {
      throw new Error(`${file} entry ${i} missing or invalid ghsaId`);
    }
    if (typeof entry.package !== 'string' || !entry.package) {
      throw new Error(`${file} entry ${i} missing or invalid package`);
    }
    if (typeof entry.reason !== 'string' || !entry.reason) {
      throw new Error(`${file} entry ${i} missing or invalid reason`);
    }
    if (typeof entry.expiry !== 'string' || !entry.expiry) {
      throw new Error(`${file} entry ${i} missing or invalid expiry`);
    }
    // Validate expiry format strictly
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(entry.expiry);
    if (!m) {
      throw new Error(`${file} entry ${i} expiry '${entry.expiry}' does not match YYYY-MM-DD format`);
    }
    // Validate it's a real calendar date (reject auto-rollover)
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day) {
      throw new Error(`${file} entry ${i} expiry '${entry.expiry}' is not a valid calendar date`);
    }
  }

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