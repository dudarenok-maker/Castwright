/* Freeze a confirmed workspace book into a committed samples/ tree for fs-22.
   Usage: node scripts/capture-sample-book.mjs "<bookDir>" <slug>

   Copies the manuscript + .audiobook/{state.json,cast.json,manuscript-edits.json}
   + the qwen voice files referenced by cast.json, stamps a Kokoro fallback preset
   onto every character, and STRIPS audio + the analysis cache (it rebuilds from
   manuscript-edits.json on first generate) + machine-specific cover bytes.
   Re-runnable. Prints a manifest and warns when any character is still undesigned
   (= do NOT commit the bundle yet). */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickKokoroPreset } from './lib/kokoro-fallback.mjs';

const [, , bookDir, slug] = process.argv;
if (!bookDir || !slug) {
  console.error('Usage: node scripts/capture-sample-book.mjs "<bookDir>" <slug>');
  process.exit(1);
}

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(repoRoot, 'samples', slug);
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, '.audiobook'), { recursive: true });
mkdirSync(join(out, 'voices', 'qwen'), { recursive: true });

// 1. state.json — strip cover bytes ref; keep identity + chapters; cast confirmed.
const state = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
const cleanState = { ...state, castConfirmed: true };
delete cleanState.coverImage;
writeFileSync(join(out, '.audiobook', 'state.json'), JSON.stringify(cleanState, null, 2));

// 2. Manuscript file (whatever state.json points at).
copyFileSync(join(bookDir, state.manuscriptFile), join(out, state.manuscriptFile));

// 3. manuscript-edits.json (attribution) — verbatim.
const editsSrc = join(bookDir, '.audiobook', 'manuscript-edits.json');
if (existsSync(editsSrc)) copyFileSync(editsSrc, join(out, '.audiobook', 'manuscript-edits.json'));

// 4. cast.json — stamp a Kokoro fallback preset onto every character + pull voices.
const cast = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'cast.json'), 'utf8'));
// bookDir = <workspace>/books/<Author>/<Series>/<Title> → 4 levels up = workspace root.
const workspaceRoot = dirname(dirname(dirname(dirname(bookDir))));
const qwenDir = join(workspaceRoot, 'voices', 'qwen');
const pulled = [];
const copyVoice = (name) => {
  for (const ext of ['pt', 'json']) {
    const f = `${name}.${ext}`;
    if (existsSync(join(qwenDir, f))) {
      copyFileSync(join(qwenDir, f), join(out, 'voices', 'qwen', f));
      pulled.push(f);
    }
  }
};
for (const c of cast.characters) {
  c.overrideTtsVoices = c.overrideTtsVoices || {};
  c.overrideTtsVoices.kokoro = {
    name: pickKokoroPreset({ gender: c.gender, ageRange: c.ageRange, id: c.id }),
  };
  const qwenName = c.overrideTtsVoices.qwen?.name;
  if (qwenName) {
    copyVoice(qwenName);
    for (const v of Object.values(c.overrideTtsVoices.qwen?.variants || {})) {
      if (v?.name) copyVoice(v.name);
    }
  }
}
writeFileSync(join(out, '.audiobook', 'cast.json'), JSON.stringify(cast, null, 2));

// 5. README licensing note.
writeFileSync(
  join(out, 'README.md'),
  '# The Coalfall Commission (bundled sample)\n\n' +
    'An original Castwright work, all rights reserved. Bundled as the fs-22 ' +
    'generate-able demo book. No audio ships — the demo runs the real pipeline ' +
    'locally (the analysis cache rebuilds from manuscript-edits.json on the first generate).\n',
);

const designed = cast.characters.filter((c) => c.overrideTtsVoices?.qwen?.name).length;
console.log(
  `Captured ${slug}: ${cast.characters.length} characters (${designed} Qwen-designed), ${pulled.length} voice files pulled → samples/${slug}/`,
);
if (designed < cast.characters.length) {
  console.warn(
    `WARNING: ${cast.characters.length - designed} character(s) have NO Qwen voice — ` +
      `do NOT commit this bundle until every character is designed.`,
  );
}
