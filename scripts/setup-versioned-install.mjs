#!/usr/bin/env node
/* fs-1 — ONE-TIME conversion from a single-checkout install (v1.5.x) to the
   versioned-directory layout the in-app upgrade needs.

   1.5.x has no upgrade endpoints, so the jump INTO 1.6.0 is manual: extract the
   1.6.0 zip, then run this once to lay out:

     <install>/launch.mjs            (copied from the release; the stable entry)
     <install>/.current-version      ("1.6.0")
     <install>/releases/v1.6.0/      (the extracted release == this --source)
     <install>/workspace/            (moved from the old audiobook-workspace)
     <install>/venv/                 (moved from the old tts-sidecar/.venv)
     <install>/models/kokoro/        (moved from the old voices/kokoro weights)

   From 1.6.0 on, upgrades are one-click in the Account tab; this script is only
   ever run once. DRY-RUN by default — pass --apply to actually move files.

   Usage:
     node scripts/setup-versioned-install.mjs --install <dir> [--source <dir>] [--from <dir>] [--apply]
       --source  extracted 1.6.0 release dir (default: this script's repo root)
       --from    existing 1.5.x checkout to relocate workspace/venv/weights from
                 (default: same as --source)
       --install target install root to create
*/

import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Pure planner — returns the ordered op list WITHOUT touching disk, so the unit
 * test can assert the layout decisions. `optional: true` ops are skipped at
 * apply time when their source is missing (a fresh install with no old data).
 */
export function computeSetupPlan({ version, source, install, from }) {
  const releaseDir = join(install, 'releases', `v${version}`);
  const oldRoot = from ?? source;
  return [
    { op: 'mkdir', dest: join(install, 'releases'), why: 'release container' },
    { op: 'copyDir', src: source, dest: releaseDir, why: 'install the release code' },
    { op: 'writeFile', dest: join(install, '.current-version'), content: version, why: 'point the launcher at this release' },
    { op: 'copyFile', src: join(releaseDir, 'launch.mjs'), dest: join(install, 'launch.mjs'), why: 'place the stable launcher at the install root' },
    { op: 'moveDir', src: join(oldRoot, 'audiobook-workspace'), dest: join(install, 'workspace'), optional: true, why: 'relocate the library OUT of the release tree' },
    { op: 'moveDir', src: join(oldRoot, 'server', 'tts-sidecar', '.venv'), dest: join(install, 'venv'), optional: true, why: 'share the python venv across releases' },
    { op: 'moveDir', src: join(oldRoot, 'server', 'tts-sidecar', 'voices', 'kokoro'), dest: join(install, 'models', 'kokoro'), optional: true, why: 'share the ~330 MB Kokoro weights across releases' },
  ];
}

function readVersion(sourceDir) {
  const pkg = JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf8'));
  if (!pkg.version) throw new Error(`No version field in ${join(sourceDir, 'package.json')}`);
  return pkg.version;
}

function parseArgs(argv) {
  const args = { apply: false, source: null, install: null, from: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--source') args.source = argv[++i];
    else if (a === '--install') args.install = argv[++i];
    else if (a === '--from') args.from = argv[++i];
  }
  return args;
}

function applyOp(op, apply, log) {
  if (op.op === 'moveDir' && op.optional && !existsSync(op.src)) {
    log(`  [skip] ${op.op} ${op.src} → ${op.dest} (source absent — ${op.why})`);
    return;
  }
  if ((op.op === 'copyDir' || op.op === 'moveDir' || op.op === 'copyFile') && existsSync(op.dest)) {
    log(`  [skip] ${op.op} → ${op.dest} (already exists — idempotent)`);
    return;
  }
  log(`  ${apply ? '[do]  ' : '[plan]'} ${op.op} ${op.src ? op.src + ' → ' : ''}${op.dest}  (${op.why})`);
  if (!apply) return;
  switch (op.op) {
    case 'mkdir':
      mkdirSync(op.dest, { recursive: true });
      break;
    case 'writeFile':
      mkdirSync(dirname(op.dest), { recursive: true });
      writeFileSync(op.dest, op.content, 'utf8');
      break;
    case 'copyFile':
      mkdirSync(dirname(op.dest), { recursive: true });
      cpSync(op.src, op.dest);
      break;
    case 'copyDir':
      mkdirSync(dirname(op.dest), { recursive: true });
      cpSync(op.src, op.dest, { recursive: true });
      break;
    case 'moveDir':
      mkdirSync(dirname(op.dest), { recursive: true });
      renameSync(op.src, op.dest);
      break;
    default:
      throw new Error(`unknown op ${op.op}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = resolve(args.source ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  if (!args.install) {
    process.stderr.write('Error: --install <dir> is required.\n');
    process.exit(2);
  }
  const install = resolve(args.install);
  const from = args.from ? resolve(args.from) : source;
  const version = readVersion(source);
  const releaseDir = join(install, 'releases', `v${version}`);

  const log = (m) => process.stdout.write(`${m}\n`);
  log(`[setup] ${args.apply ? 'APPLYING' : 'DRY-RUN (pass --apply to execute)'}`);
  log(`[setup] source=${source}  from=${from}  install=${install}  version=${version}`);

  if (existsSync(releaseDir)) {
    process.stderr.write(`Error: ${releaseDir} already exists — refusing to overwrite an installed release.\n`);
    process.exit(1);
  }

  for (const op of computeSetupPlan({ version, source, install, from })) {
    applyOp(op, args.apply, log);
  }
  log(args.apply ? '[setup] done.' : '[setup] dry-run complete — re-run with --apply to execute.');
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) main();
