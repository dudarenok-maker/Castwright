import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isUuidKeyedQwenRow,
  sampleScopeForRow,
  selectStaleBaseSampleFiles,
} from '../invalidate-stale-qwen-base-samples.mjs';

test('isUuidKeyedQwenRow: true only when qwen.name == qwen-<voiceUuid>', () => {
  assert.equal(
    isUuidKeyedQwenRow({ id: 'a', voiceUuid: 'kudc6', overrideTtsVoices: { qwen: { name: 'qwen-kudc6' } } }),
    true,
  );
  // legacy name-keyed row — uuid present but name still the old key → NOT re-keyed
  assert.equal(
    isUuidKeyedQwenRow({ id: 'a', voiceUuid: 'kudc6', overrideTtsVoices: { qwen: { name: 'qwen-char-a' } } }),
    false,
  );
  // no uuid at all
  assert.equal(
    isUuidKeyedQwenRow({ id: 'a', overrideTtsVoices: { qwen: { name: 'qwen-char-a' } } }),
    false,
  );
  // no qwen slot
  assert.equal(isUuidKeyedQwenRow({ id: 'a', voiceUuid: 'kudc6' }), false);
});

test('sampleScopeForRow: voiceId wins, else char-<id>', () => {
  assert.equal(sampleScopeForRow({ id: 'sophie', voiceId: 'v_sophie' }), 'v_sophie');
  assert.equal(sampleScopeForRow({ id: 'mr-sweeney' }), 'char-mr-sweeney');
});

test('bug #1411 code-review follow-up: sampleScopeForRow book-scopes the char-<id> fallback', () => {
  assert.equal(
    sampleScopeForRow({ id: 'narrator' }, 'book-alpha'),
    'char-book-alpha__narrator',
  );
  assert.notEqual(
    sampleScopeForRow({ id: 'narrator' }, 'book-alpha'),
    sampleScopeForRow({ id: 'narrator' }, 'book-beta'),
  );
  // A persisted voiceId still wins over bookId (deliberate cross-book reuse).
  assert.equal(
    sampleScopeForRow({ id: 'narrator', voiceId: 'v_narrator' }, 'book-alpha'),
    'v_narrator',
  );
});

test('bug #1411 code-review follow-up: selectStaleBaseSampleFiles matches a re-keyed voiceId-less row by its OWN book', () => {
  const rows = [
    {
      id: 'narrator',
      bookId: 'book-alpha',
      voiceUuid: 'kudc6',
      overrideTtsVoices: { qwen: { name: 'qwen-kudc6' } },
    },
  ];
  const fileNames = [
    'char-book-alpha__narrator-qwen3-tts-0.6b-aaa111.mp3', // DELETE: this book's stranded base
    'char-book-beta__narrator-qwen3-tts-0.6b-bbb222.mp3', // KEEP: an unrelated book's narrator
    'char-narrator-qwen3-tts-0.6b-ccc333.mp3', // KEEP: pre-#1411 unscoped file, not this row's scope
  ];
  const got = selectStaleBaseSampleFiles({ rows, fileNames, modelKeys: ['qwen3-tts-0.6b'] });
  assert.deepEqual(got, ['char-book-alpha__narrator-qwen3-tts-0.6b-aaa111.mp3']);
});

test('selectStaleBaseSampleFiles: deletes base samples of re-keyed voices, keeps variants/legacy/others, no prefix-collision', () => {
  const rows = [
    { id: 'mr-sweeney', voiceUuid: 'kudc6', overrideTtsVoices: { qwen: { name: 'qwen-kudc6' } } },
    { id: 'sophie', voiceId: 'v_sophie', voiceUuid: 'MR', overrideTtsVoices: { qwen: { name: 'qwen-MR' } } },
    { id: 'forkle', voiceUuid: 'x', overrideTtsVoices: { qwen: { name: 'qwen-forkle-legacy' } } }, // not re-keyed
    { id: 'mr', voiceUuid: 'mm', overrideTtsVoices: { qwen: { name: 'qwen-mm' } } }, // collision probe
  ];
  const fileNames = [
    'char-mr-sweeney-qwen3-tts-0.6b-pbohlk.mp3', // DELETE: sweeney base
    'char-mr-sweeney__angry-qwen3-tts-0.6b-3emkc1.mp3', // KEEP: emotion variant
    'v_sophie-qwen3-tts-0.6b-aaa111.mp3', // DELETE: sophie base via voiceId scope
    'char-sophie-qwen3-tts-0.6b-bbb222.mp3', // KEEP: not sophie's scope (voiceId set)
    'char-forkle-qwen3-tts-0.6b-ccc333.mp3', // KEEP: forkle not re-keyed
    'char-mr-qwen3-tts-0.6b-ddd444.mp3', // DELETE: char 'mr' base
    'char-other-qwen3-tts-0.6b-eee555.mp3', // KEEP: no matching row
  ];
  const got = selectStaleBaseSampleFiles({ rows, fileNames, modelKeys: ['qwen3-tts-0.6b'] }).sort();
  assert.deepEqual(got, [
    'char-mr-qwen3-tts-0.6b-ddd444.mp3',
    'char-mr-sweeney-qwen3-tts-0.6b-pbohlk.mp3',
    'v_sophie-qwen3-tts-0.6b-aaa111.mp3',
  ]);
  // explicit collision guard: char-mr's prefix must NOT swallow char-mr-sweeney's base
  assert.ok(!got.includes('char-mr-sweeney-qwen3-tts-0.6b-pbohlk.mp3') === false);
});
