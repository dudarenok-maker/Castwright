import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePush, helpMessage } from '../guard-commit-subjects.mjs';

const ZERO = '0'.repeat(40);
const line = (localSha, remoteSha = ZERO, remoteRef = 'refs/heads/feature') =>
  `refs/heads/feature ${localSha} ${remoteRef} ${remoteSha}`;

// listSubjects stub: maps a localSha to a fixed commit list.
const lister = (commits) => () => commits;

test('clean Conventional-Commits subjects pass', () => {
  const r = evaluatePush(line('aaa'), {
    listSubjects: lister([
      { sha: 'aaa', subject: 'feat(server): add narrator-default heuristic' },
      { sha: 'bbb', subject: 'docs(docs): update plan 221' },
      { sha: 'ccc', subject: 'chore: bump deps' },
    ]),
  });
  assert.equal(r.blocked, false);
  assert.equal(r.failures.length, 0);
});

test('the real bug: a leaked "@ " prefix (PS here-string) is blocked', () => {
  const r = evaluatePush(line('aaa'), {
    listSubjects: lister([
      { sha: 'aaa', subject: '@ feat(server): language-aware minor-cast fold buckets' },
    ]),
  });
  assert.equal(r.blocked, true);
  assert.equal(r.failures.length, 1);
  assert.equal(r.failures[0].sha, 'aaa');
  assert.match(r.failures[0].reason, /Conventional Commits/);
});

test('empty and bad-type subjects are blocked', () => {
  const r = evaluatePush(line('aaa'), {
    listSubjects: lister([
      { sha: 'aaa', subject: '' },
      { sha: 'bbb', subject: 'wip: random change' },
      { sha: 'ccc', subject: 'feat(unknown-scope): nope' },
    ]),
  });
  assert.equal(r.blocked, true);
  assert.equal(r.failures.length, 3);
});

test('merge / revert / fixup commits are exempt (git auto-generated)', () => {
  const r = evaluatePush(line('aaa'), {
    listSubjects: lister([
      { sha: 'aaa', subject: 'Merge pull request #856 from foo/bar' },
      { sha: 'bbb', subject: 'Revert "feat(server): x"' },
      { sha: 'ccc', subject: 'fixup! feat(server): x' },
    ]),
  });
  assert.equal(r.blocked, false);
});

test('a deletion (zero local sha) checks nothing', () => {
  let called = false;
  const r = evaluatePush(line(ZERO), {
    listSubjects: () => {
      called = true;
      return [];
    },
  });
  assert.equal(r.blocked, false);
  assert.equal(called, false);
});

test('a commit pushed on two refs is validated once', () => {
  const stdin = `${line('aaa')}\n${line('aaa')}`;
  let calls = 0;
  const r = evaluatePush(stdin, {
    listSubjects: () => {
      calls += 1;
      return [{ sha: 'dup', subject: '@ feat(server): x' }];
    },
  });
  // listSubjects runs per ref line, but the duplicate sha is only reported once
  assert.equal(calls, 2);
  assert.equal(r.failures.length, 1);
});

test('helpMessage names the offending sha + subject and shows the convention', () => {
  const msg = helpMessage([{ sha: 'abc123def456', subject: '@ feat(server): x', reason: 'r' }]);
  assert.match(msg, /abc123def/);
  assert.match(msg, /@ feat\(server\): x/);
  assert.match(msg, /Allowed types/);
  assert.match(msg, /--no-verify/);
});
