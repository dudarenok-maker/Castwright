import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  belongsToKey,
  planRenames,
  classifyVoiceGroup,
  rekeyCharacterNames,
} from '../repair-qwen-voice-uuid-keys.mjs';

test('belongsToKey matches base + variants but not prefix-siblings', () => {
  assert.equal(belongsToKey('qwen-dad.pt', 'qwen-dad'), true);
  assert.equal(belongsToKey('qwen-dad.json', 'qwen-dad'), true);
  assert.equal(belongsToKey('qwen-dad__angry.pt', 'qwen-dad'), true);
  assert.equal(belongsToKey('qwen-dad-2.pt', 'qwen-dad'), false);
  assert.equal(belongsToKey('qwen-dadx.pt', 'qwen-dad'), false);
});

test('planRenames re-keys all matching files, skips existing destinations', () => {
  const entries = ['qwen-a.pt', 'qwen-a.json', 'qwen-a__sad.pt', 'qwen-b.pt'];
  const plan = planRenames(entries, 'qwen-a', 'qwen-Z');
  assert.deepEqual(
    plan.map((p) => [p.from, p.to]).sort(),
    [
      ['qwen-a.json', 'qwen-Z.json'],
      ['qwen-a.pt', 'qwen-Z.pt'],
      ['qwen-a__sad.pt', 'qwen-Z__sad.pt'],
    ].sort(),
  );
  // destination already present → skip that file
  assert.deepEqual(planRenames(['qwen-a.pt', 'qwen-Z.pt'], 'qwen-a', 'qwen-Z'), []);
  assert.deepEqual(planRenames(entries, 'qwen-a', 'qwen-a'), []);
});

const ptSet = (...keys) => {
  const s = new Set(keys);
  return (k) => s.has(k);
};

test('classifyVoiceGroup: skip when no uuid; noop when name already the uuid key', () => {
  assert.equal(classifyVoiceGroup('qwen-x', [], ptSet('qwen-x')).action, 'skip');
  assert.equal(classifyVoiceGroup('qwen-U', ['U'], ptSet('qwen-U')).action, 'noop');
});

test('classifyVoiceGroup: uuid present + .pt at legacy name → consolidate (clean 19 + divergent 4 case)', () => {
  // The 19 clean voices (before migration) AND the 4 divergent voices reduce to
  // the same shape here: one uuid, .pt at the legacy name, uuid-key .pt missing.
  const c = classifyVoiceGroup('qwen-mr-forkle', ['Ct9G'], ptSet('qwen-mr-forkle'));
  assert.deepEqual(c, { action: 'consolidate', oldKey: 'qwen-mr-forkle', newKey: 'qwen-Ct9G' });
  // elwin-style: every row is a reused link in a cycle, but they agree on one uuid.
  const elwin = classifyVoiceGroup('qwen-elwin', ['F6'], ptSet('qwen-elwin'));
  assert.equal(elwin.action, 'consolidate');
  assert.equal(elwin.newKey, 'qwen-F6');
});

test('classifyVoiceGroup: flag when rows disagree on uuid / no .pt / both keys exist', () => {
  assert.equal(classifyVoiceGroup('qwen-x', ['A', 'B'], ptSet('qwen-x')).action, 'flag'); // ambiguous
  assert.equal(classifyVoiceGroup('qwen-ghost', ['U'], ptSet()).action, 'flag'); // no .pt anywhere
  assert.equal(classifyVoiceGroup('qwen-x', ['U'], ptSet('qwen-x', 'qwen-U')).action, 'flag'); // conflict
});

test('rekeyCharacterNames rewrites base + variant slot names', () => {
  const out = rekeyCharacterNames(
    {
      id: 'forkle',
      overrideTtsVoices: {
        qwen: { name: 'qwen-mr-forkle', variants: { whisper: { name: 'qwen-mr-forkle__whisper' } } },
      },
    },
    'qwen-mr-forkle',
    'qwen-Ct9G',
  );
  assert.equal(out.overrideTtsVoices.qwen.name, 'qwen-Ct9G');
  assert.equal(out.overrideTtsVoices.qwen.variants.whisper.name, 'qwen-Ct9G__whisper');
});
