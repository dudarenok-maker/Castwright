/* Companion to `scripts/recover-missing-character.mjs`. Covers:

   - parseArgs:    arg shape, defaults, error paths.
   - toKebabId:    naming convention (matches analyzer ids).
   - buildCharacter: shape against the Character schema in openapi.yaml.
   - findDialogueReattributions: pattern coverage for the dialogue-tag scan.
   - main (--apply): end-to-end write against a fixture book dir.

   We deliberately do NOT exercise the dry-run console output past a smoke
   check — the test verifies that files DO get written in --apply and DO NOT
   get written in dry-run. Stdout shape can change without breaking the
   recovery flow. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseArgs,
  toKebabId,
  buildCharacter,
  buildChangeLogEntry,
  findDialogueReattributions,
  main,
} from '../recover-missing-character.mjs';

test('parseArgs collects bookDir + --name + --gender + --role', () => {
  const opts = parseArgs(['/some/book', '--name', 'Sela', '--gender', 'female', '--role', 'Bodyguard']);
  assert.equal(opts.bookDir, '/some/book');
  assert.equal(opts.name, 'Sela');
  assert.equal(opts.gender, 'female');
  assert.equal(opts.role, 'Bodyguard');
  assert.equal(opts.apply, false);
  assert.equal(opts.ageRange, 'adult');
});

test('parseArgs --apply flips the apply flag', () => {
  const opts = parseArgs(['/some/book', '--name', 'X', '--gender', 'male', '--role', 'R', '--apply']);
  assert.equal(opts.apply, true);
});

test('parseArgs rejects unknown flags', () => {
  assert.throws(() => parseArgs(['/x', '--frobnicate']), /unknown flag/);
});

test('parseArgs rejects multiple positional args', () => {
  assert.throws(() => parseArgs(['/a', '/b', '--name', 'X', '--gender', 'male', '--role', 'R']), /exactly one positional/);
});

test('toKebabId matches the analyzer id convention', () => {
  /* Phase 0a emits kebab-case ids stripped of accents and punctuation. A
     manual recovery using the same convention means a future re-analysis
     with the Layer-2 fix in place would produce the same id and merge
     cleanly without orphaning the manual entry. */
  assert.equal(toKebabId('Sela'), 'sela');
  assert.equal(toKebabId('Garrow'), 'garrow');
  assert.equal(toKebabId("Mr. Casper"), 'mr-casper');
  assert.equal(toKebabId('Councillor Reld'), 'councillor-reld');
  assert.equal(toKebabId('Sir Astin'), 'sir-astin');
  assert.equal(toKebabId('  Hespa  '), 'hespa');
});

test('buildCharacter produces a Character-shaped entry with the required fields', () => {
  const c = buildCharacter({
    id: 'sela',
    name: 'Sela',
    role: 'Bodyguard',
    gender: 'female',
    ageRange: 'adult',
  });
  assert.equal(c.id, 'sela');
  assert.equal(c.name, 'Sela');
  assert.equal(c.role, 'Bodyguard');
  assert.equal(c.gender, 'female');
  assert.equal(c.ageRange, 'adult');
  assert.equal(c.voiceState, 'unassigned');
  assert.equal(c.lines, 0);
  assert.equal(c.scenes, 0);
  assert.deepEqual(c.attributes, []);
  assert.deepEqual(c.evidence, []);
  /* tone is a four-axis 0-100 envelope — the cast editor expects all four. */
  assert.deepEqual(Object.keys(c.tone).sort(), ['authority', 'emotion', 'pace', 'warmth']);
  /* No matchedFrom on a manual entry — that field is for series-prior carries. */
  assert.equal(c.matchedFrom, undefined);
});

test('buildCharacter falls back to a generated description when none given', () => {
  const c = buildCharacter({ id: 'x', name: 'X', role: 'Mentor', gender: 'male', ageRange: 'adult' });
  assert.match(c.description, /Mentor.*manually recovered/i);
});

test('findDialogueReattributions catches "<Name> said" in a narrator tag sentence', () => {
  /* The PRECEDING sentence is the dialogue; the matching narrator sentence
     is the tag. The script proposes flipping the dialogue's characterId. */
  const sentences = [
    { id: 100, chapterId: 1, characterId: 'narrator', text: '"WE HAVE TO go,"' },
    { id: 101, chapterId: 1, characterId: 'narrator', text: 'Garrow said, his hand on the doorknob.' },
  ];
  const found = findDialogueReattributions(sentences, 'Garrow');
  assert.equal(found.length, 1);
  assert.equal(found[0].dialogueSentenceId, 100);
  assert.equal(found[0].tagSentenceId, 101);
});

test('findDialogueReattributions catches multiple verbs', () => {
  const sentences = [
    { id: 1, chapterId: 1, characterId: 'narrator', text: '"Get back!"' },
    { id: 2, chapterId: 1, characterId: 'narrator', text: 'Sela growled at the intruder.' },
    { id: 3, chapterId: 1, characterId: 'narrator', text: '"Mind yourself,"' },
    { id: 4, chapterId: 1, characterId: 'narrator', text: 'Sela warned.' },
  ];
  const found = findDialogueReattributions(sentences, 'Sela');
  assert.equal(found.length, 2);
  assert.deepEqual(
    found.map((r) => r.dialogueSentenceId).sort(),
    [1, 3],
  );
});

test('findDialogueReattributions does NOT cross chapter boundaries', () => {
  /* Phase 1 sentence ids are per-chapter scoped; a tag in ch2 can never
     refer to a dialogue line in ch1. The preceding-sentence rule must check
     chapterId equality. */
  const sentences = [
    { id: 99, chapterId: 1, characterId: 'narrator', text: '"Dialogue from ch1."' },
    { id: 1, chapterId: 2, characterId: 'narrator', text: 'Garrow said in chapter 2.' },
  ];
  const found = findDialogueReattributions(sentences, 'Garrow');
  assert.equal(found.length, 0);
});

test('findDialogueReattributions returns empty for a name not in the manuscript', () => {
  const sentences = [
    { id: 1, chapterId: 1, characterId: 'narrator', text: '"go,"' },
    { id: 2, chapterId: 1, characterId: 'narrator', text: 'Brann said.' },
  ];
  const found = findDialogueReattributions(sentences, 'Sela');
  assert.equal(found.length, 0);
});

test('findDialogueReattributions only flips narrator-attributed tag sentences', () => {
  /* If the model already attributed the tag sentence to someone (Wren
     observing "Garrow growled"), we don't want to flip the preceding
     dialogue — that's not a tag, it's a third-party observation. */
  const sentences = [
    { id: 1, chapterId: 1, characterId: 'wren', text: '"Watch out!"' },
    { id: 2, chapterId: 1, characterId: 'wren', text: 'I heard Garrow growled below.' },
  ];
  const found = findDialogueReattributions(sentences, 'Garrow');
  assert.equal(found.length, 0);
});

test('findDialogueReattributions ignores substring false positives at word boundaries', () => {
  /* "growth" must not match "grow". "Grizela" must not match "Sela" as a
     speaker name (different person). Word-boundary check on both ends. */
  const sentences = [
    { id: 1, chapterId: 1, characterId: 'narrator', text: '"plant,"' },
    { id: 2, chapterId: 1, characterId: 'narrator', text: 'Sela said as Grizela watched the growth.' },
  ];
  const found = findDialogueReattributions(sentences, 'Sela');
  /* Should hit on the "Sela said" prefix, not the "Grizela" substring. */
  assert.equal(found.length, 1);
  assert.equal(found[0].dialogueSentenceId, 1);
});

test('buildChangeLogEntry records the manual addition with the right type + actor', () => {
  const entry = buildChangeLogEntry({ name: 'Sela', id: 'sela', role: 'Bodyguard', reattributedCount: 3 });
  assert.equal(entry.type, 'character_manually_added');
  assert.equal(entry.actor, 'user-script');
  assert.match(entry.title, /Sela/);
  assert.match(entry.note, /3 dialogue/);
  assert.equal(typeof entry.id, 'number');
  assert.equal(typeof entry.at, 'string');
});

test('buildChangeLogEntry note says "no dialogue" when count is 0', () => {
  const entry = buildChangeLogEntry({ name: 'Sela', id: 'sela', role: 'Bodyguard', reattributedCount: 0 });
  assert.match(entry.note, /No dialogue/i);
});

test('main --apply writes cast.json + manuscript-edits.json + change-log.json against a fixture book', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'recover-char-test-'));
  try {
    const bookDir = join(tmp, 'book');
    const audioDir = join(bookDir, '.audiobook');
    mkdirSync(audioDir, { recursive: true });
    writeFileSync(
      join(audioDir, 'cast.json'),
      JSON.stringify({
        characters: [
          { id: 'narrator', name: 'Narrator', role: 'Third-person observer', voiceState: 'unassigned' },
        ],
      }),
    );
    writeFileSync(
      join(audioDir, 'manuscript-edits.json'),
      JSON.stringify({
        sentences: [
          { id: 1, chapterId: 1, characterId: 'narrator', text: '"Stand down,"', confidence: 0.8 },
          { id: 2, chapterId: 1, characterId: 'narrator', text: 'Sela said, leveling her sword.', confidence: 0.98 },
          { id: 3, chapterId: 1, characterId: 'narrator', text: '"For now."', confidence: 0.85 },
          { id: 4, chapterId: 1, characterId: 'narrator', text: 'Sela added quietly.', confidence: 0.97 },
        ],
      }),
    );

    await main([bookDir, '--name', 'Sela', '--gender', 'female', '--role', 'Bodyguard', '--apply']);

    const cast = JSON.parse(readFileSync(join(audioDir, 'cast.json'), 'utf8'));
    const sela = cast.characters.find((c) => c.id === 'sela');
    assert.ok(sela, 'Sela must be appended to cast.json');
    assert.equal(sela.name, 'Sela');
    assert.equal(sela.gender, 'female');
    assert.equal(sela.role, 'Bodyguard');
    assert.equal(sela.voiceState, 'unassigned');

    const edits = JSON.parse(readFileSync(join(audioDir, 'manuscript-edits.json'), 'utf8'));
    /* Sentences 1 and 3 are the dialogue lines preceding the "Sela said" / "Sela added" tags. */
    const flipped = edits.sentences.filter((s) => s.characterId === 'sela').map((s) => s.id).sort();
    assert.deepEqual(flipped, [1, 3]);
    /* The tag sentences themselves remain narrator-attributed — they are
       prose describing who spoke, not dialogue. */
    assert.equal(edits.sentences[1].characterId, 'narrator');
    assert.equal(edits.sentences[3].characterId, 'narrator');

    const changeLog = JSON.parse(readFileSync(join(audioDir, 'change-log.json'), 'utf8'));
    assert.equal(changeLog.events.length, 1);
    assert.equal(changeLog.events[0].type, 'character_manually_added');
    assert.match(changeLog.events[0].note, /2 dialogue/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('main dry-run does NOT touch any file', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'recover-char-dryrun-'));
  try {
    const bookDir = join(tmp, 'book');
    const audioDir = join(bookDir, '.audiobook');
    mkdirSync(audioDir, { recursive: true });
    const initialCast = { characters: [{ id: 'narrator', name: 'Narrator' }] };
    writeFileSync(join(audioDir, 'cast.json'), JSON.stringify(initialCast));
    writeFileSync(
      join(audioDir, 'manuscript-edits.json'),
      JSON.stringify({ sentences: [{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Sela said.', confidence: 1 }] }),
    );

    /* Capture stdout — main() logs the plan in dry-run; we don't assert on
       text but we do verify the function completes without throwing. */
    await main([bookDir, '--name', 'Sela', '--gender', 'female', '--role', 'Bodyguard']);

    const cast = JSON.parse(readFileSync(join(audioDir, 'cast.json'), 'utf8'));
    assert.equal(cast.characters.length, 1, 'cast.json must not be modified in dry-run');
    assert.equal(existsSync(join(audioDir, 'change-log.json')), false, 'change-log.json must not be created in dry-run');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('main refuses to double-add an existing id', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'recover-char-dup-'));
  try {
    const bookDir = join(tmp, 'book');
    const audioDir = join(bookDir, '.audiobook');
    mkdirSync(audioDir, { recursive: true });
    writeFileSync(
      join(audioDir, 'cast.json'),
      JSON.stringify({ characters: [{ id: 'sela', name: 'Sela' }] }),
    );
    writeFileSync(join(audioDir, 'manuscript-edits.json'), JSON.stringify({ sentences: [] }));

    /* process.exit propagates as an exception we can catch by stubbing — but
       the easier path is to verify the failure by capturing console.error +
       the exit code. We override process.exit temporarily. */
    const origExit = process.exit;
    const origErr = console.error;
    let captured = '';
    console.error = (msg) => {
      captured += String(msg);
    };
    let exitCode = null;
    process.exit = (code) => {
      exitCode = code;
      throw new Error('__test_exit__');
    };
    try {
      await main([bookDir, '--name', 'Sela', '--gender', 'female', '--role', 'Bodyguard', '--apply']);
    } catch (err) {
      if (err.message !== '__test_exit__') throw err;
    } finally {
      process.exit = origExit;
      console.error = origErr;
    }
    assert.equal(exitCode, 1);
    assert.match(captured, /already exists/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
