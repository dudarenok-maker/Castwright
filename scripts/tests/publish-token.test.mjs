import test from 'node:test';
import assert from 'node:assert/strict';
import {
  comparePublishTokens,
  parsePublishToken,
  nonceInHistory,
  bumpToken,
  publishTokenRegex,
  PUBLISH_TOKEN_BASELINE_ERROR,
  PUBLISH_TOKEN_PUBLISHED_ERROR,
  PUBLISH_TOKEN_WORKING_ERROR,
} from '../publish-token.mjs';

// Nonces are padded to the parser's 6-char floor so cases stay readable as
// 'aaa'/'zzz' while remaining legal values. Padding is deterministic, so
// equality and inequality between cases are preserved exactly.
const T = (n, nonce) => TRAW(n, String(nonce).padEnd(6, 'x'));
// Unpadded, for the malformed-input cases that must reach the parser as-is.
const TRAW = (n, nonce) => `<p data-published-as="${n}" data-publish-id="${nonce}">x</p>`;
// Default lookups = the HEALTHY answers: the page's nonce is main's current one
// (in baseline history), and the working nonce was freshly minted (so it is NOT
// in baseline history). All three must be stated. Before `workingInBaseline`
// was added here, five tests reached the branch that reads it with the key
// absent — and two of those asserted GREEN, through the very fail-open this
// suite now pins. A test that omits a lookup is not testing the healthy path;
// it is testing whatever the missing key happens to coerce to.
// THREE KNOWN-EQUIVALENT MUTANTS. Each is unkillable because a stronger check
// runs AHEAD of it — defence in depth, where the outer guard subsumes the
// inner. A deletion sweep reports them as survivors on every run, so they are
// listed here with their reachability arguments to stop the next reviewer
// re-investigating a settled case. Do NOT "fix" the suite to kill them; that
// would mean weakening the guard that makes each unreachable.
//
//   A6  `!inBaseline && !inMine`  ->  `!inMine`
//       Distinguishable only at inBaseline=true, inMine=false. Reaching that
//       line requires baselineInMine=true (else the staleness STOP returned),
//       and the consistency guard rejects
//       `inBaseline && baselineInMine && !inMine`. So inBaseline implies
//       inMine there, and the two forms agree.
//
//   B1  function replacement  ->  string replacement (re-opens $& expansion)
//       Distinguishable only for a nonce containing a `$` pattern, which the
//       minted-nonce charset check ([A-Za-z0-9_-]) refuses first. Killing B1
//       would mean weakening that check.
//
//   D1  `w.n === b.n`  ->  `w.n <= b.n`   (the un-bumped gate)
//       Distinguishable only at w.n < b.n, and the REBASE gate immediately
//       above returns first for exactly that state.
const HEALTHY = {
  inBaseline: true,
  inMine: true,
  baselineInMine: true, // my branch DOES contain main's live view
  workingInBaseline: false, // my working nonce was freshly minted
};
const cmp = (o) => comparePublishTokens({ lookups: HEALTHY, ...o });
// Spread over HEALTHY, for cases that vary one or two answers and mean the
// rest to stay healthy. A bare `lookups: {...}` REPLACES the defaults, which is
// how five tests came to exercise a branch with a key missing.
const L = (over) => ({ lookups: { ...HEALTHY, ...over } });

test('1 ordinary first publish is green', () => {
  assert.deepEqual(cmp({ working: T(48, 'aaa'), published: T(47, 'zzz'), baseline: T(47, 'zzz') }), []);
});

test('2 same-branch re-publish is green', () => {
  // baseline 47, this branch published 48 (committed, so inMine), now 49.
  assert.deepEqual(
    cmp({
      working: T(49, 'bbb'),
      published: T(48, 'aaa'),
      baseline: T(47, 'zzz'),
      ...L({ inBaseline: false, inMine: true, workingInBaseline: false }),
    }),
    [],
  );
});

test('3 competing publish with identical counters is reported', () => {
  const e = cmp({
    working: T(49, 'bbb'),
    published: T(48, 'ccc'),
    baseline: T(47, 'zzz'),
    ...L({ inBaseline: false, inMine: false }),
  });
  assert.ok(e.some((x) => x.includes('another lane published')), e.join('|'));
});

test('4 STALE nonce one commit deep is reported (pass-4 Critical 1)', () => {
  // main: (46,n46) then (47,n47). Z branched at n46, bumped to 48 without
  // minting, published (48,'n46'). n46 IS in baseline history.
  const e = cmp({
    working: T(48, 'mine'),
    published: T(48, 'n46'),
    baseline: T(47, 'n47'),
    ...L({ inBaseline: true, inMine: true }),
  });
  assert.ok(e.some((x) => x.includes('without minting')), e.join('|'));
  assert.ok(!e.some((x) => x.includes('your own last publish')), 'must not misattribute');
});

test('5 STALE nonce at arbitrary depth is reported', () => {
  const e = cmp({
    working: T(60, 'mine'),
    published: T(59, 'n12'),
    baseline: T(50, 'n50'),
    ...L({ inBaseline: true, inMine: true }),
  });
  assert.ok(e.some((x) => x.includes('without minting')), e.join('|'));
});

test('6 un-minted WORKING file is reported', () => {
  const e = cmp({
    working: T(49, 'zzz'),
    published: T(48, 'zzz'),
    baseline: T(48, 'zzz'),
    ...L({ inBaseline: true, inMine: true, workingInBaseline: true }),
  });
  assert.ok(e.some((x) => x.includes('not freshly minted')), e.join('|'));
});

test('7 un-rebased branch is told to REBASE, not to bump', () => {
  const e = cmp({ working: T(48, 'bbb'), published: T(49, 'zzz'), baseline: T(49, 'zzz') });
  assert.ok(e.some((x) => x.toUpperCase().includes('REBASE')), e.join('|'));
  assert.ok(!e.some((x) => x.includes('bump the counter')), e.join('|'));
});

test('8 rebase outranks behind when BOTH apply', () => {
  const e = cmp({ working: T(47, 'bbb'), published: T(46, 'yyy'), baseline: T(50, 'zzz') });
  assert.ok(e.some((x) => x.toUpperCase().includes('REBASE')), e.join('|'));
  assert.ok(!e.some((x) => x.includes('--live-page-behind-main')), e.join('|'));
});

test('9 unbumped working file is told to bump', () => {
  const e = cmp({ working: T(47, 'zzz'), published: T(47, 'zzz'), baseline: T(47, 'zzz') });
  assert.ok(e.some((x) => x.includes('bump the counter')), e.join('|'));
});

test('10 forgetting to bump for round two of your OWN cycle is reported', () => {
  const e = cmp({
    working: T(48, 'aaa'),
    published: T(48, 'aaa'),
    baseline: T(47, 'zzz'),
    // 'aaa' was minted on this branch: in HEAD's history, not in the baseline's.
    ...L({ inBaseline: false, inMine: true, workingInBaseline: false }),
  });
  assert.ok(e.some((x) => x.includes('your own last publish')), e.join('|'));
});

test('11 live page BEHIND main is reported', () => {
  const e = cmp({ working: T(49, 'bbb'), published: T(46, 'yyy'), baseline: T(47, 'zzz') });
  assert.ok(e.some((x) => x.includes('BEHIND')), e.join('|'));
});

test('12 --live-page-behind-main CLEARS the behind state (pass-4 Critical 2)', () => {
  assert.deepEqual(
    cmp({
      working: T(49, 'bbb'),
      published: T(46, 'yyy'),
      baseline: T(47, 'zzz'),
      allowBehind: true,
    }),
    [],
  );
});

test('13 --live-page-behind-main is an ERROR when the page is not behind', () => {
  const e = cmp({
    working: T(49, 'bbb'),
    published: T(48, 'zzz'),
    baseline: T(48, 'zzz'),
    allowBehind: true,
  });
  assert.ok(e.some((x) => x.includes('--live-page-behind-main')), e.join('|'));
});

test('14 your OWN uncommitted publish is diagnosed as such', () => {
  const e = cmp({
    working: T(49, 'bbb'),
    published: T(49, 'bbb'),
    baseline: T(48, 'zzz'),
    ...L({ inBaseline: false, inMine: false }),
  });
  assert.ok(e.some((x) => x.includes('commit')), e.join('|'));
  assert.ok(!e.some((x) => x.includes('another lane published')), e.join('|'));
});

test('15 tokenless published page names the transition case', () => {
  const e = cmp({ working: T(48, 'bbb'), published: '<p>no token</p>', baseline: T(47, 'zzz') });
  assert.ok(e.some((x) => x.includes('no publish token')), e.join('|'));
  assert.ok(e.some((x) => x.includes('predates')), e.join('|'));
});

test('16 tokenless BASELINE is an explicit error, never a pass', () => {
  assert.ok(cmp({ working: T(48, 'b'), published: T(47, 'z'), baseline: '<p>x</p>' }).length > 0);
});

test('17 baseline/published/working unresolvable get DIFFERENT constants', () => {
  assert.deepEqual(cmp({ working: T(48, 'b'), published: T(47, 'z'), baseline: null }), [
    PUBLISH_TOKEN_BASELINE_ERROR,
  ]);
  assert.deepEqual(cmp({ working: T(48, 'b'), published: null, baseline: T(47, 'z') }), [
    PUBLISH_TOKEN_PUBLISHED_ERROR,
  ]);
  assert.deepEqual(cmp({ working: null, published: T(47, 'z'), baseline: T(47, 'z') }), [
    PUBLISH_TOKEN_WORKING_ERROR,
  ]);
  assert.notEqual(PUBLISH_TOKEN_BASELINE_ERROR, PUBLISH_TOKEN_PUBLISHED_ERROR);
  assert.notEqual(PUBLISH_TOKEN_BASELINE_ERROR, PUBLISH_TOKEN_WORKING_ERROR);
});

test('18 an unresolvable ancestry lookup fails closed', () => {
  const e = cmp({
    working: T(49, 'b'),
    published: T(48, 'a'),
    baseline: T(47, 'z'),
    ...L({ inBaseline: null, inMine: null }),
  });
  // NOT `length > 0`: null is falsy, so dropping the guard falls through to
  // "another lane published" -- still non-empty, still "passing". Assert the
  // SPECIFIC failure, or the test cannot tell failing closed from failing wrong.
  assert.ok(e.some((x) => x.includes('could not search history')), e.join('|'));
});

test('18b a lookup that is null for ONE ref only still fails closed', () => {
  // Spread over HEALTHY so exactly ONE answer is null. A bare `lookups: {...}`
  // here also dropped `workingInBaseline`/`baselineInMine`, and their guards
  // then satisfied the assertion — the test passed while the guard it NAMES
  // could be deleted. Asserting the specific message closes the rest of that
  // gap: "could not search history" alone is emitted by three different guards.
  for (const over of [
    { inBaseline: null, inMine: true },
    { inBaseline: true, inMine: null },
    { inBaseline: false, inMine: null },
  ]) {
    const e = cmp({ working: T(49, 'b'), published: T(48, 'a'), baseline: T(47, 'z'), ...L(over) });
    assert.ok(
      e.some((x) => x.includes("could not search history for the published page's nonce")),
      `${JSON.stringify(over)} -> ${e.join('|')}`,
    );
  }
});

// --- The THIRD lookup. Regression cover for the pass-5 Critical: it was read
// as a bare `&& lookups.workingInBaseline`, so a FAILED lookup (null) and an
// ABSENT one both coerced to false and the STOP became a silent pass. Five
// existing tests reached this branch with the key missing; two asserted [].
test('18c a null workingInBaseline fails CLOSED, never green', () => {
  const e = cmp({
    working: T(49, 'ccc'),
    published: T(48, 'bbb'),
    baseline: T(47, 'aaa'),
    ...L({ inBaseline: false, inMine: true, workingInBaseline: null }),
  });
  assert.notDeepEqual(e, [], 'a failed working-nonce lookup must not pass');
  assert.ok(e.some((x) => x.includes('could not search history')), e.join('|'));
});

test('18d an ABSENT workingInBaseline fails closed too', () => {
  // Distinct from 18c: `undefined` is what a caller wired for the two-lookup
  // signature supplies, and it must not read as "freshly minted".
  const e = comparePublishTokens({
    working: T(49, 'ccc'),
    published: T(48, 'bbb'),
    baseline: T(47, 'aaa'),
    lookups: { inBaseline: false, inMine: true },
  });
  assert.notDeepEqual(e, []);
  assert.ok(e.some((x) => x.includes('could not search history')), e.join('|'));
});

test('18e workingInBaseline false is genuinely green (the guard is not always-on)', () => {
  assert.deepEqual(
    comparePublishTokens({
      working: T(49, 'ccc'),
      published: T(48, 'bbb'),
      baseline: T(47, 'aaa'),
      ...L({ inBaseline: false, inMine: true, workingInBaseline: false }),
    }),
    [],
  );
});

test('18f the working-nonce lookup is only consulted when w.n > b.n', () => {
  // At w.n === b.n the un-bumped verdict must win, WITHOUT demanding the third
  // lookup — otherwise every caller pays a git call on a state that cannot use it.
  //
  // `workingInBaseline: null` is what gives this test teeth. Inheriting the
  // healthy `false` made the second assertion unfalsifiable: a `w.n >= b.n`
  // mutant would consult the lookup, find `false`, decline to STOP, and fall
  // through to the same verdict — so the test passed while the boundary it is
  // named for could be moved. `null` is the one value whose consultation is
  // VISIBLE, because reading it is required to fail closed.
  const e = comparePublishTokens({
    working: T(47, 'zzz'),
    published: T(47, 'zzz'),
    baseline: T(47, 'zzz'),
    ...L({ inBaseline: true, inMine: true, workingInBaseline: null }),
  });
  assert.ok(e.some((x) => x.includes('same as origin/main')), e.join('|'));
  assert.ok(!e.some((x) => x.includes('could not search history')), e.join('|'));
});

// --- C1: the working-side invariant. Pass 5's Critical, and the shape four
// earlier passes never reached because EVERY green-asserting test used
// inMine: true — so "the live page is in main's history but not in mine" was
// never once evaluated.
test('18g STALE LANE: told to bump, obeys, and must NOT go green', () => {
  // Two lanes branch from main at 47; each stamps once (47 -> 48). B merges and
  // publishes. A has never rebased and has never seen B's page.
  const asA = { published: T(48, 'nonceB'), baseline: T(48, 'nonceB') };
  const lanes = L({ inBaseline: true, inMine: false, baselineInMine: false });

  const step1 = cmp({ working: T(48, 'nonceA'), ...asA, ...lanes });
  assert.ok(step1.length > 0, 'a stale lane must not be waved through');
  assert.ok(step1.some((x) => x.toUpperCase().includes('REBASE')), step1.join('|'));
  // The pass-5 Critical was that the advice here was "bump", and obeying it
  // produced green. Both halves are now pinned.
  assert.ok(!step1.some((x) => x.includes('bump the counter')), step1.join('|'));

  const step2 = cmp({ working: T(49, 'nonceA2'), ...asA, ...lanes });
  assert.notDeepEqual(step2, [], 'bumping must not clear a staleness STOP');
});

test('18g2 the staleness STOP outranks the both-absent one, not just the counters', () => {
  // The OTHER half of the ordering claim beside the !baselineInMine guard. 18g
  // pins that it precedes the COUNTER gates; nothing pinned that it precedes
  // the both-absent gate, so moving it below that one survived mutation. Both
  // messages say "rebase", so this is message SELECTION rather than a
  // correctness hole — but an unpinned ordering claim is one edit from being
  // false, and the comment asserts it.
  const e = cmp({
    working: T(49, 'mine'),
    published: T(48, 'other'),
    baseline: T(47, 'mainn'),
    ...L({ inBaseline: false, inMine: false, baselineInMine: false }),
  });
  assert.ok(
    e.some((x) => x.includes("origin/main's live-view nonce")),
    `staleness must be diagnosed ahead of "another lane published": ${e.join('|')}`,
  );
  assert.ok(!e.some((x) => x.includes('another lane published')), e.join('|'));
});

test('18h green REQUIRES the baseline nonce to be in my history', () => {
  const base = { working: T(49, 'ccc'), published: T(48, 'bbb'), baseline: T(47, 'aaa') };
  assert.deepEqual(cmp({ ...base, ...L({ inBaseline: false, inMine: true }) }), []);
  // flipping ONLY baselineInMine must break it
  assert.notDeepEqual(
    cmp({ ...base, ...L({ inBaseline: false, inMine: true, baselineInMine: false }) }),
    [],
  );
});

test('18i a null baselineInMine fails CLOSED', () => {
  const e = cmp({
    working: T(49, 'ccc'),
    published: T(48, 'bbb'),
    baseline: T(47, 'aaa'),
    ...L({ inBaseline: false, inMine: true, baselineInMine: null }),
  });
  assert.notDeepEqual(e, []);
  assert.ok(e.some((x) => x.includes('could not search history')), e.join('|'));
});

test('18j the ENTIRE green region requires baselineInMine (enumeration)', () => {
  // The reviewer found C1 by enumerating the green region and reading it: one
  // shape announced inMine=false on the green path. Making the enumeration a
  // test means the next such gap surfaces mechanically instead of depending on
  // whether a reviewer imagined the right input.
  const vals = [true, false];
  let green = 0;
  for (const n of [[47, 47, 47], [48, 47, 47], [49, 48, 47], [48, 48, 47], [49, 46, 47]]) {
    for (const inBaseline of vals)
      for (const inMine of vals)
        for (const baselineInMine of vals)
          for (const workingInBaseline of vals)
            for (const allowBehind of vals) {
              const out = comparePublishTokens({
                working: T(n[0], 'wwwwww'),
                published: T(n[1], 'pppppp'),
                baseline: T(n[2], 'bbbbbb'),
                lookups: { inBaseline, inMine, baselineInMine, workingInBaseline },
                allowBehind,
              });
              if (out.length === 0) {
                green++;
                assert.equal(baselineInMine, true, `GREEN without baselineInMine: ${JSON.stringify(n)}`);
                assert.ok(n[0] > n[2], `GREEN without w.n > b.n: ${JSON.stringify(n)}`);
                assert.ok(n[0] > n[1], `GREEN without w.n > p.n: ${JSON.stringify(n)}`);
                assert.equal(workingInBaseline, false, 'GREEN with an un-minted working nonce');
              }
            }
  }
  assert.ok(green > 0, 'the enumeration must actually reach green, or it proves nothing');
});

test('18m a counter bumped WITHOUT minting is caught with no history lookup', () => {
  // The default lookups put inBaseline=true, which makes the HISTORY-backed
  // guard fire first — and its message also contains "without minting", so an
  // earlier version of this test passed while the guard it is named for could
  // be deleted outright. inBaseline=false is what actually reaches it.
  const e = cmp({
    working: T(48, 'same'),
    published: T(47, 'same'),
    baseline: T(47, 'aaa'),
    ...L({ inBaseline: false }),
  });
  // Assert on the half of the message that is UNIQUE to this guard, not on the
  // phrase both guards share.
  assert.ok(
    e.some((x) => x.includes("kept the published page's nonce")),
    e.join('|'),
  );
  assert.ok(!e.some((x) => x.includes("already in origin/main's history")), e.join('|'));
});

test('18m2 the two un-minted guards are distinguishable, not interchangeable', () => {
  // 170 is history-backed and speaks about the LIVE PAGE vs origin/main; 243
  // needs no lookup and speaks about the WORKING file vs the live page. Both
  // say "without minting", which is why one could stand in for the other.
  const historyBacked = cmp({
    working: T(49, 'mine'),
    published: T(48, 'same'),
    baseline: T(47, 'same'),
    ...L({ inBaseline: true }),
  });
  assert.ok(historyBacked.some((x) => x.includes("already in origin/main's history")));
  assert.ok(!historyBacked.some((x) => x.includes("kept the published page's nonce")));
});

test('18n lookups: null fails closed instead of throwing', () => {
  // `= {}` defaults only undefined; a caller batching failed lookups hands null.
  const e = comparePublishTokens({
    working: T(49, 'ccc'),
    published: T(48, 'bbb'),
    baseline: T(47, 'aaa'),
    lookups: null,
  });
  assert.notDeepEqual(e, []);
  assert.ok(e.some((x) => x.includes('could not search history')), e.join('|'));
});

test('18k contradictory lookups (a mis-wired caller) fail closed', () => {
  // inBaseline && baselineInMine IMPLIES inMine. The delivery plan wires one
  // lookup where four are consumed, so this is the live mis-wiring hazard.
  const e = cmp({
    working: T(49, 'ccc'),
    published: T(48, 'bbb'),
    baseline: T(47, 'aaa'),
    ...L({ inBaseline: true, inMine: false, baselineInMine: true }),
  });
  assert.notDeepEqual(e, []);
  assert.ok(e.some((x) => x.includes('contradict each other')), e.join('|'));
});

test('18l bumpToken REFUSES a nonce its own parser would reject', () => {
  const src = TRAW(47, 'zzzxxx');
  for (const bad of ['ab', '', 'a b', '-Sx', 'has"q', '$&$`', null, 42]) {
    assert.throws(
      () => bumpToken(src, () => bad),
      /minted nonce/,
      `mintNonce -> ${JSON.stringify(bad)} must be refused`,
    );
  }
  // A stamper that writes a token its own reader rejects would wedge the check
  // permanently, so the round trip is the real assertion.
  const { html } = bumpToken(src, () => 'abc123');
  assert.deepEqual(parsePublishToken(html), { n: 48, nonce: 'abc123' });
});

test('18p a tokenless WORKING file is reported (the guard-sweep survivor)', () => {
  // The other guard a deletion sweep found unprotected: nothing asserted the
  // tokenless-working STOP positively, so it could be removed with the suite
  // still green. Distinct from 18o, which is about a non-string value.
  const e = cmp({ working: '<p>no token here</p>', published: T(48, 'bbb'), baseline: T(47, 'aaa') });
  assert.ok(e.some((x) => x.includes('the tracked live view has none')), e.join('|'));
});

test('18o a non-string copy names the CALLER\'s fault, not a missing token', () => {
  // `readFileSync` without an encoding returns a Buffer. That used to parse as
  // null, i.e. "this file has no token", and the comparator then told the
  // operator to restore a file that was perfectly fine.
  const asBuffer = Buffer.from(T(48, 'aaa'), 'utf8');
  const parsed = parsePublishToken(asBuffer);
  assert.ok(parsed && parsed.malformed, 'a Buffer must not read as "no token"');
  assert.match(parsed.malformed, /Buffer/);

  const e = cmp({ working: asBuffer, published: T(47, 'zzz'), baseline: T(47, 'zzz') });
  assert.ok(e.some((x) => x.includes('encoding')), e.join('|'));
  assert.ok(!e.some((x) => x.includes('Restore it')), `must not blame the file: ${e.join('|')}`);

  // ...while a genuinely absent copy keeps its own distinct diagnosis.
  assert.deepEqual(parsePublishToken(null), null);
  assert.deepEqual(parsePublishToken(undefined), null);
});

test('19 malformed tokens are errors, not skips', () => {
  const bad = (w) => cmp({ working: w, published: T(1, 'z'), baseline: T(1, 'z') });
  assert.ok(
    bad(`<p data-published-as="abc" data-publish-id="a">x</p>`).some((x) =>
      x.includes('not a bare integer'),
    ),
  );
  assert.ok(bad(TRAW(2, '')).some((x) => x.includes('nonce')));
  assert.ok(bad(T(2, 'a') + T(3, 'b')).some((x) => x.includes('more than once')));

  // The nonce is spliced into a `git log -S data-publish-id="<nonce>"` anchor,
  // so each of these is an injection or a match-everything hazard, not a nit.
  // Each of these is 6+ chars, so it must be rejected by its OWN rule rather
  // than by the length floor. '-Sfoo' was 5 chars, which made the leading-dash
  // clause dead code that no test could distinguish from the floor.
  for (const evil of ['a bcde', '-Sfooo', 'has"quo', "has'quo", '$&$`xy', 'aaa.bbb', 'aaa/bbb']) {
    assert.ok(
      bad(TRAW(2, evil)).some((x) => x.includes('nonce')),
      `nonce ${JSON.stringify(evil)} must be rejected`,
    );
  }
  // 2^53 collapses neighbouring counters onto one Number, losing a STOP.
  assert.ok(
    bad(TRAW(2, 'aaaaaa').replace('"2"', '"9007199254740993"')).some((x) =>
      x.includes('1-15 digits'),
    ),
  );
});

test('20 nonceInHistory pins the ref and never uses --all', () => {
  const calls = [];
  const runner = (args) => {
    calls.push(args.join(' '));
    return { status: 0, stdout: 'commit abc\n' };
  };
  assert.equal(nonceInHistory('/repo', 'live.html', 'k7f2a9', 'deadbeef', runner), true);
  assert.ok(!calls[0].includes('--all'), '--all would find a fetched rival commit');

  // ORDER and the `--` separator, not just "these substrings appear". A ref
  // placed after `--` is a pathspec, and silently matches nothing.
  const argv = argvOf();
  const sep = argv.indexOf('--');
  assert.ok(sep > 0, 'the pathspec separator must be present');
  assert.ok(argv.indexOf('deadbeef') < sep, 'the ref must precede --');
  assert.ok(argv.indexOf('live.html') > sep, 'the path must follow --');

  // C2: without --full-history a pathspec'd log prunes merge parents, so
  // "absent" and "pruned" collapse into one answer — permissive for every STOP.
  assert.ok(argv.includes('--full-history'), '--full-history is load-bearing');

  // Pass 6 / F1: git computes NO diff for a merge commit unless asked, so a
  // nonce born in a conflict resolution reads as ABSENT from the history that
  // contains it — and absent is the permissive answer for the STOPs this
  // gates. This repo mandates merge commits, so it is a routine state.
  assert.ok(
    argv.some((a) => a.startsWith('--diff-merges=')),
    'merge commits must be diffed or a re-stamped conflict resolution is invisible',
  );
  // -s suppresses the patch body; without it every lookup streams a full diff
  // of a 250 KB file. It must NOT be one of the flags that also drops the
  // pickaxe selection.
  assert.ok(argv.includes('-s'), 'the patch body must be suppressed');

  // C3: -S is a SUBSTRING search, so the query must carry the attribute anchor
  // rather than the bare nonce — six hex chars otherwise match a quoted SHA.
  assert.ok(
    argv.includes('data-publish-id="k7f2a9"'),
    `the search must be anchored to the attribute, got: ${argv.join(' ')}`,
  );
  assert.ok(!argv.includes('k7f2a9'), 'the bare nonce must not be the query');
});

// Captures argv as an ARRAY — joining to a string hides adjacency and order.
function argvOf() {
  let seen = null;
  nonceInHistory('/repo', 'live.html', 'k7f2a9', 'deadbeef', (args) => {
    seen = args;
    return { status: 0, stdout: 'x\n' };
  });
  return seen;
}

test('21 nonceInHistory returns null on git failure — each channel ALONE', () => {
  // Previously ONE stub set status:128 AND error, so either clause could be
  // deleted with the test still green. Three channels, three cases.
  const call = (r) => nonceInHistory('/repo', 'live.html', 'kkkkkk', 'HEAD', () => r);
  assert.equal(call({ status: 0, stdout: '', error: new Error('spawn') }), null, 'error alone');
  assert.equal(call({ status: 128, stdout: '' }), null, 'nonzero status alone');
  assert.equal(call({ status: 0 }), null, 'missing stdout must not throw, and must not pass');
  // ...and the true/false contract still holds on success.
  assert.equal(call({ status: 0, stdout: '' }), false);
  assert.equal(call({ status: 0, stdout: 'commit abc\n' }), true);
});

test('22 bumpToken increments and mints, touching nothing else', () => {
  const before =
    '<h1>Register</h1>\n<p data-published-as="47" data-publish-id="zzzxxx">x</p>\n<p>47</p>';
  const { html, n, nonce } = bumpToken(before, () => 'newid1');
  assert.equal(n, 48);
  assert.equal(nonce, 'newid1');
  assert.match(html, /data-published-as="48"/);
  assert.ok(html.includes('<p>47</p>'), 'a bare 47 elsewhere must survive');
  assert.ok(html.includes('<h1>Register</h1>'));
});

test('23 bumpToken refuses no-token and two-token files', () => {
  assert.throws(() => bumpToken('<p>nothing</p>', () => 'x'), /no publish token/);
  assert.throws(() => bumpToken(T(1, 'a') + T(2, 'b'), () => 'x'), /more than once/);
});

test('24 the regex factory has no lastIndex leak', () => {
  const html = T(5, 'abc');
  // A stray .test() on a SHARED /g object would poison the next matchAll. The
  // factory makes that impossible; prove the factory is actually a factory.
  const r = publishTokenRegex();
  r.test(html);
  assert.notEqual(r.lastIndex, 0, 'sanity: a /g regex does carry lastIndex');
  assert.equal(parsePublishToken(html).n, 5, 'parse must be unaffected');
});
