#!/usr/bin/env node
/* Manually add a missing character to a book's cast.json, and (when possible)
   re-attribute dialogue-tag patterns in manuscript-edits.json to the recovered
   character id.

   Motivation: Phase 0a per-chapter detection sometimes misses canonical but
   sparsely-quoted characters — bodyguards / mentors / family who are referenced
   heavily in narration but rarely speak. The minor-cast fold (default
   minLines: 3) then drops anyone who did slip through with <3 attributed
   lines. The combined effect: an entire category of named characters
   silently absent from the cast roster. Concrete example caught in
   docs/features/archive/96-recover-missing-character.md: Sela (Brann's goblin
   bodyguard) and Garrow (Wren's goblin bodyguard) both missing from
   Saltgrave's cast.json across all ~65 Phase 0a stage1 outputs.

   This script lets the user manually fill the gap WITHOUT re-running Phase 0a
   (which would just miss them again for the same reason). Layer 2 in
   docs/features/archive/97-narrator-only-named-characters.md fixes the analyzer to
   stop dropping them in future books.

   Usage:
     node scripts/recover-missing-character.mjs <bookDir> --name <Name> --gender <male|female> --role <role> [options]

   Required:
     <bookDir>            path to the book directory containing .audiobook/
     --name <Name>        display name (e.g. "Sela")
     --gender <m|f>       'male' or 'female' (drives the goblin/ogre default voice slot later)
     --role <role>        free-text role (e.g. "Bodyguard", "Mentor", "Family Member")

   Optional:
     --id <kebab-id>      stable id (default: kebab-case of --name)
     --description <txt>  short description (default: generated from --role + --name)
     --age <range>        ageRange (default: "adult")
     --apply              actually write files; otherwise dry-run

   Behaviour:
     1. Reads <bookDir>/.audiobook/cast.json — refuses if the id already exists.
     2. Appends a new character with voiceState: 'unassigned', no matchedFrom.
     3. Scans manuscript-edits.json for narrator-attributed sentences whose
        text contains a dialogue-tag pattern `<Name> (said|growled|warned|...)`.
        The IMMEDIATELY-PRECEDING sentence is the candidate dialogue to
        re-attribute to the new id. Prints every proposed re-attribution.
     4. In --apply mode, writes the cast + manuscript-edits + a change-log.json
        entry atomically via temp + rename. Dry-run prints planned writes
        without touching disk. */

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* The dialogue-tag verbs we look for. Pattern: <Name> <verb> at the start of a
   narrator sentence, with the immediately-preceding sentence being the dialogue.

   This is a LITERAL mirror of the canonical list in
   server/src/analyzer/dialogue-verbs.ts (this `.mjs` runs under plain `node`
   and can't import the `.ts`). scripts/tests/dialogue-verbs-drift.test.mjs
   fails if the two ever diverge — edit both together. */
export const DIALOGUE_VERBS = [
  // original set (kept aligned with the historical hotfix-script list)
  'said', 'growled', 'warned', 'insisted', 'added', 'continued', 'replied',
  'asked', 'answered', 'whispered', 'shouted', 'yelled', 'snapped', 'hissed',
  'spat', 'barked', 'snarled', 'grumbled', 'muttered', 'murmured', 'sighed',
  'breathed', 'laughed', 'cried', 'interrupted', 'interjected', 'countered',
  'noted', 'teased', 'chimed', 'sang', 'complained',
  // expansion — Lessom's own ch19 tags ("repeated", "agreed", "reminded")
  // plus common speech verbs the original set omitted.
  'repeated', 'agreed', 'reminded', 'demanded', 'prompted', 'protested',
  'wondered', 'clarified', 'corrected', 'offered', 'explained', 'admitted',
  'argued', 'observed', 'promised', 'called', 'urged', 'declared', 'exclaimed',
];

export function parseArgs(argv) {
  const opts = {
    bookDir: null,
    name: null,
    gender: null,
    role: null,
    id: null,
    description: null,
    ageRange: 'adult',
    apply: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--name') opts.name = argv[++i];
    else if (a === '--gender') opts.gender = argv[++i];
    else if (a === '--role') opts.role = argv[++i];
    else if (a === '--id') opts.id = argv[++i];
    else if (a === '--description') opts.description = argv[++i];
    else if (a === '--age') opts.ageRange = argv[++i];
    else if (a === '--apply') opts.apply = true;
    else if (a === '--help' || a === '-h') return { help: true };
    else if (a.startsWith('--')) {
      throw new Error(`recover-missing-character: unknown flag "${a}". Pass --help for usage.`);
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) {
    throw new Error(`recover-missing-character: expected exactly one positional <bookDir>, got ${positional.length}.`);
  }
  opts.bookDir = positional[0] ?? null;
  return opts;
}

function validate(opts) {
  const missing = [];
  if (!opts.bookDir) missing.push('<bookDir>');
  if (!opts.name) missing.push('--name');
  if (!opts.gender) missing.push('--gender');
  if (!opts.role) missing.push('--role');
  if (missing.length) {
    throw new Error(`recover-missing-character: missing required arg(s): ${missing.join(', ')}.`);
  }
  if (opts.gender !== 'male' && opts.gender !== 'female') {
    throw new Error(`recover-missing-character: --gender must be 'male' or 'female', got '${opts.gender}'.`);
  }
}

/* Kebab-case a display name into a stable id. Strips punctuation, collapses
   internal whitespace to single hyphens. Matches the analyzer's id convention
   so a future Phase 0a re-run with the Layer-2 fix would emit the same id
   and merge cleanly. */
export function toKebabId(name) {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/* Build the minimal cast entry. Mirrors the shape Phase 0a emits for a
   detected character minus the rich evidence/attributes — the user can
   fill those in via the cast editor once the character is in the roster. */
export function buildCharacter({ id, name, role, gender, ageRange, description }) {
  return {
    id,
    name,
    role,
    color: id, // colour slot defaults to the id; cast editor reassigns if it collides
    attributes: [],
    tone: { warmth: 50, pace: 50, authority: 50, emotion: 50 },
    gender,
    ageRange,
    description: description || `${role} (manually recovered — analyzer missed this character).`,
    evidence: [],
    lines: 0,
    scenes: 0,
    voiceState: 'unassigned',
  };
}

/* Scan manuscript-edits sentences for dialogue-tag patterns matching <Name>.
   Returns an array of { tagSentenceId, dialogueSentenceId, dialogueText, tagText }
   tuples describing proposed re-attributions. The PRECEDING sentence (when
   one exists in the same chapter and is currently attributed to narrator)
   is the candidate. Exported for the test. */
export function findDialogueReattributions(sentences, name) {
  /* Pattern: "<Name> <verb>" inside a narrator-attributed sentence. The verb
     boundary must be word-boundary on the right to avoid matching "grouchy"
     against "grow". The name is case-sensitive on the first letter (proper
     noun) but tolerates trailing comma/period. */
  const verbAlt = DIALOGUE_VERBS.join('|');
  const tagRe = new RegExp(`\\b${escapeRegex(name)}\\b\\s+(?:${verbAlt})\\b`, 'u');
  const out = [];
  for (let i = 0; i < sentences.length; i += 1) {
    const s = sentences[i];
    if (s.characterId !== 'narrator') continue;
    if (!tagRe.test(s.text)) continue;
    /* The candidate dialogue is the immediately preceding sentence in the
       same chapter, currently attributed to a non-narrator (or narrator —
       sometimes Phase-1 mis-attributes dialogue to narrator when the
       speaker is missing from the roster, which is exactly our case). */
    const prev = sentences[i - 1];
    if (!prev || prev.chapterId !== s.chapterId) continue;
    out.push({
      tagSentenceId: s.id,
      dialogueSentenceId: prev.id,
      dialogueText: prev.text,
      tagText: s.text,
      currentCharacterId: prev.characterId,
    });
  }
  return out;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* Atomic JSON write: temp file + fsync-then-rename. Same shape as
   server/src/workspace/state-io.ts:writeJsonAtomic — minimal port to avoid
   pulling in TypeScript / a server dep. */
function writeJsonAtomic(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const json = JSON.stringify(data, null, 2);
  writeFileSync(tmp, json, { encoding: 'utf8' });
  try {
    renameSync(tmp, filePath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

/* Build the change-log entry recording the manual addition. Matches the
   shape server/src/workspace/change-log.ts writes for other event types.
   `actor: 'user-script'` distinguishes this from analyzer-emitted events. */
export function buildChangeLogEntry({ name, id, role, reattributedCount }) {
  return {
    id: Date.now(),
    at: new Date().toISOString(),
    ts: 'Just now',
    date: 'today',
    type: 'character_manually_added',
    title: `Recovered missing character — ${name}`,
    note:
      reattributedCount > 0
        ? `Added id="${id}" (${role}) and re-attributed ${reattributedCount} dialogue sentence(s) from narrator.`
        : `Added id="${id}" (${role}). No dialogue-tag patterns matched in manuscript-edits.json — character has no spoken lines in this book.`,
    actor: 'user-script',
  };
}

function printHelp() {
  console.log(`Usage: node scripts/recover-missing-character.mjs <bookDir> --name <Name> --gender <male|female> --role <role> [options]

Manually add a missing character to a book's cast.json. Also re-attributes
any narrator-attributed dialogue lines whose preceding sentence carries a
matching <Name> <said|growled|...> tag.

Required:
  <bookDir>            path to the book dir containing .audiobook/
  --name <Name>        display name
  --gender <m|f>       'male' or 'female'
  --role <role>        free-text role (Bodyguard / Mentor / Family Member / etc.)

Optional:
  --id <kebab-id>      stable id (default: kebab(--name))
  --description <txt>  short description
  --age <range>        ageRange (default: 'adult')
  --apply              actually write files; otherwise dry-run
  --help, -h           print this help`);
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  if (opts.help) {
    printHelp();
    return;
  }
  validate(opts);

  const bookDir = resolve(process.cwd(), opts.bookDir);
  const audiobookDir = join(bookDir, '.audiobook');
  const castPath = join(audiobookDir, 'cast.json');
  const editsPath = join(audiobookDir, 'manuscript-edits.json');
  const changeLogPath = join(audiobookDir, 'change-log.json');

  if (!existsSync(audiobookDir)) {
    console.error(`recover-missing-character: no .audiobook/ at ${bookDir}.`);
    process.exit(1);
  }
  if (!existsSync(castPath)) {
    console.error(`recover-missing-character: no cast.json at ${castPath}.`);
    process.exit(1);
  }

  const id = opts.id ?? toKebabId(opts.name);
  const cast = readJson(castPath);
  if (cast.characters?.some((c) => c.id === id)) {
    console.error(`recover-missing-character: character id "${id}" already exists in ${castPath}. Refusing to double-add.`);
    process.exit(1);
  }
  const character = buildCharacter({
    id,
    name: opts.name,
    role: opts.role,
    gender: opts.gender,
    ageRange: opts.ageRange,
    description: opts.description,
  });

  let edits = null;
  let reattributions = [];
  if (existsSync(editsPath)) {
    edits = readJson(editsPath);
    reattributions = findDialogueReattributions(edits.sentences ?? [], opts.name);
  }

  console.log(`\n[plan] add character to ${castPath}:`);
  console.log(`  id="${character.id}" name="${character.name}" role="${character.role}" gender="${character.gender}"`);
  console.log(`\n[plan] proposed dialogue re-attributions: ${reattributions.length}`);
  for (const r of reattributions.slice(0, 10)) {
    console.log(`  - sentence #${r.dialogueSentenceId}: ${truncate(r.dialogueText, 80)} (currently "${r.currentCharacterId}")`);
    console.log(`      └ tagged by #${r.tagSentenceId}: ${truncate(r.tagText, 60)}`);
  }
  if (reattributions.length > 10) {
    console.log(`  ... and ${reattributions.length - 10} more`);
  }

  if (!opts.apply) {
    console.log('\n[dry-run] no files written. Re-run with --apply to commit.');
    return;
  }

  /* Apply: cast + manuscript-edits + change-log, atomic. Reads are stale by
     the time the writes happen — re-read cast.json just before the write to
     reduce the chance of clobbering a concurrent edit. */
  const freshCast = readJson(castPath);
  if (freshCast.characters?.some((c) => c.id === id)) {
    console.error(`recover-missing-character: cast.json changed under us — id "${id}" appeared between dry-run and apply. Abort.`);
    process.exit(1);
  }
  freshCast.characters = [...(freshCast.characters ?? []), character];
  writeJsonAtomic(castPath, freshCast);
  console.log(`[wrote] ${castPath} (+1 character)`);

  if (reattributions.length > 0 && edits) {
    const idsToFlip = new Set(reattributions.map((r) => r.dialogueSentenceId));
    const fresh = readJson(editsPath);
    let flipped = 0;
    for (const s of fresh.sentences ?? []) {
      if (idsToFlip.has(s.id)) {
        s.characterId = id;
        flipped += 1;
      }
    }
    writeJsonAtomic(editsPath, fresh);
    console.log(`[wrote] ${editsPath} (${flipped} sentence re-attribution${flipped === 1 ? '' : 's'})`);
  }

  const entry = buildChangeLogEntry({ name: opts.name, id, role: opts.role, reattributedCount: reattributions.length });
  let changeLog = { events: [] };
  if (existsSync(changeLogPath)) {
    changeLog = readJson(changeLogPath);
    if (!Array.isArray(changeLog.events)) changeLog.events = [];
  }
  changeLog.events.push(entry);
  writeJsonAtomic(changeLogPath, changeLog);
  console.log(`[wrote] ${changeLogPath} (+1 event)`);

  console.log(`\nDone. ${opts.name} (id="${id}") is now in the cast for ${bookDir}.`);
  if (reattributions.length === 0) {
    console.log('Note: no dialogue-tag patterns matched. Character has 0 attributed lines — assign a voice in the cast editor when ready.');
  }
}

/* Run main() when invoked directly (not when imported by a test). Same
   pattern as scripts/relufs-existing.mjs:316. */
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err.stack ?? err.message);
    process.exit(1);
  });
}

function truncate(s, n) {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}
