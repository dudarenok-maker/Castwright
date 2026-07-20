#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const flags = process.argv.slice(2);
const res = spawnSync(
  'npx',
  ['tsx', 'server/src/analyzer/attribution-eval/run-eval-cli.ts', ...flags],
  { stdio: 'inherit', cwd: ROOT, shell: true },
);
process.exit(res.status ?? 1);
