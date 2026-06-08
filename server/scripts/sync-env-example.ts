import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderManagedBlock, BEGIN, END } from '../src/config/env-example.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = join(root, '.env.example');
const src = readFileSync(file, 'utf8');
const block = renderManagedBlock();
const b = src.indexOf(BEGIN);
const e = src.indexOf(END);
let next;
if (b !== -1 && e !== -1) {
  next = src.slice(0, b) + block + src.slice(e + END.length);
} else {
  next = src.replace(/\s*$/, '') + '\n\n' + block + '\n';
}
const check = process.argv.includes('--check');
if (check) {
  if (src !== next) {
    console.error('.env.example is out of sync with the config registry. Run: npm run config:sync');
    process.exit(1);
  }
  console.log('.env.example in sync ✓');
} else {
  writeFileSync(file, next);
  console.log('.env.example synced ✓');
}
