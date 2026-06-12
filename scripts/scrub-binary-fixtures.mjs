// One-off: scrub the Hollow Tide names from the TEXT entries inside binary epub fixtures
// (the codemod can't reach inside a zip). Usage: node scripts/scrub-binary-fixtures.mjs <epub...>
import { createRequire } from 'node:module';
import { scrubText } from './scrub-the Hollow Tide.mjs';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const AdmZip = require(resolve(process.cwd(), 'server/node_modules/adm-zip'));

for (const path of process.argv.slice(2)) {
  const zip = new AdmZip(path);
  let changed = false;
  for (const entry of zip.getEntries()) {
    if (!/\.(opf|ncx|xhtml|html|htm|xml)$/i.test(entry.entryName)) continue;
    const text = entry.getData().toString('utf8');
    const scrubbed = scrubText(text);
    if (scrubbed !== text) {
      zip.updateFile(entry.entryName, Buffer.from(scrubbed, 'utf8'));
      changed = true;
      console.log(`  scrubbed ${entry.entryName} in ${path}`);
    }
  }
  if (changed) {
    zip.writeZip(path);
    console.log(`rewrote ${path}`);
  } else {
    console.log(`no the Hollow Tide text in ${path}`);
  }
}
