// Publish-token comparator — executable draft for #2599.
//
// SEVEN designs preceded this. Three per-row content rules; a bare counter
// (cannot tell your re-publish from a rival's — same number); a branch name
// (inherited, renamed, degenerate under detached HEAD); a hand-minted nonce
// (goes stale, fails GREEN); and a nonce whose freshness was tested against
// `b.nonce` rather than against history (closed the hole by exactly one commit).
//
// The freshness question is NOT "does the page's nonce differ from main's". It
// is: **is the page's nonce already in the baseline's history while its counter
// is ahead of the baseline?** That is the signature of "somebody bumped without
// minting", at any depth, and it is what closes the class.

export const PUBLISH_TOKEN_BASELINE_ERROR =
  "Cannot verify the publish token: origin/main's live view is unavailable or " +
  'unreadable. Do not publish until this passes.';

export const PUBLISH_TOKEN_PUBLISHED_ERROR =
  'Cannot verify the publish token: the saved copy of the published page could ' +
  'not be read. Re-save it from the artifact URL and re-run.';

export const PUBLISH_TOKEN_WORKING_ERROR =
  'Cannot verify the publish token: the tracked live view could not be read.';

// A factory, not a shared mutable object. A `/g` regex carries `lastIndex`, and
// one stray `.test()` on a shared instance makes the next `matchAll` return zero
// matches — i.e. "this file has no token" for a file that has one.
export const publishTokenRegex = () =>
  /data-published-as="([^"]*)"\s+data-publish-id="([^"]*)"/g;

export function parsePublishToken(rawHtml) {
  // `null`/`undefined` mean "no copy" and are the caller's to diagnose — the
  // comparator answers each with its own named constant before parsing.
  if (rawHtml === null || rawHtml === undefined) return null;
  // Anything else non-string is NOT "this file has no token": it is a caller
  // that handed us the wrong kind of value, and `readFileSync` without an
  // encoding — which returns a Buffer — is the realistic way to get here.
  // Returning null routed that into "the tracked live view has none. Restore
  // it before publishing", sending an operator to repair a file that is
  // perfectly fine. Report it as malformed so the message names the real fault.
  if (typeof rawHtml !== 'string') {
    return {
      malformed: `expected HTML text but got ${rawHtml instanceof Uint8Array ? 'a Buffer — read the file with an encoding' : typeof rawHtml}`,
    };
  }
  const matches = [...rawHtml.matchAll(publishTokenRegex())];
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    return { malformed: `the publish token appears more than once (${matches.length} times)` };
  }
  const [, n, nonce] = matches[0];
  // Digit cap, not just "is an integer": past 2^53 `Number()` collapses
  // neighbouring counters onto one value, and `p.n > b.n` silently goes false —
  // losing the stale-nonce STOP. It also makes bumpToken's `+ 1` a no-op, so a
  // typo'd counter in main would tell every operator to bump, forever.
  if (!/^\d{1,15}$/.test(n)) {
    return { malformed: `the counter "${n}" is not a bare integer of 1-15 digits` };
  }
  // The nonce is interpolated into a `git log -S data-publish-id="<nonce>"`
  // anchor, so its charset is a correctness constraint, not a style one: a
  // quote or a space breaks out of the anchor. The 6-char floor keeps it from
  // matching half the repository. The leading-`-` clause is defence in depth
  // ONLY — the anchor prepends `data-publish-id="`, so the argv element always
  // starts with `d` and a nonce can never be read as a git flag. It is kept
  // against a future caller that searches the bare nonce; it is not what makes
  // today's call safe, and the earlier comment claiming otherwise was wrong.
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(nonce) || /^-/.test(nonce)) {
    return {
      malformed: `the nonce "${nonce}" must be 6-64 chars of [A-Za-z0-9_-] and may not start with "-"`,
    };
  }
  return { n: Number(n), nonce };
}

// `lookups` supplies the FOUR history answers, so the comparator stays pure:
//   inBaseline        — is the PUBLISHED nonce in the BASELINE COMMIT's history?
//   inMine            — is the PUBLISHED nonce in HEAD's history?
//   baselineInMine    — is the BASELINE's OWN nonce in HEAD's history?
//                       i.e. does my branch contain main's live view? Green
//                       REQUIRES this. It is the working-side half of the
//                       invariant, and its absence was pass 5's Critical.
//   workingInBaseline — is the WORKING nonce in the baseline's history?
//                       (consulted only when w.n > b.n; see its guard below)
// Each is true | false | null, and null (the lookup itself failed) is never
// treated as false. Count them here whenever one is added: this comment said
// "two" while the code read three, and the third went unguarded because of it.
export function comparePublishTokens({
  working,
  published,
  baseline,
  lookups = {},
  allowBehind = false,
}) {
  // `= {}` only defaults `undefined`. A caller batching failed lookups can hand
  // us `null`, and destructuring that throws — which becomes whatever an
  // enclosing catch decides, including a pass.
  if (lookups === null || typeof lookups !== 'object') lookups = {};
  if (baseline === null || baseline === undefined) return [PUBLISH_TOKEN_BASELINE_ERROR];
  if (published === null || published === undefined) return [PUBLISH_TOKEN_PUBLISHED_ERROR];
  if (working === null || working === undefined) return [PUBLISH_TOKEN_WORKING_ERROR];

  const w = parsePublishToken(working);
  const p = parsePublishToken(published);
  const b = parsePublishToken(baseline);

  const malformed = [];
  for (const [label, parsed] of [
    ['tracked', w],
    ['published', p],
    ['origin/main', b],
  ]) {
    if (parsed && parsed.malformed) {
      malformed.push(`Publish token (${label}): ${parsed.malformed}. Fix it before publishing.`);
    }
  }
  if (malformed.length > 0) return malformed;

  if (!b) {
    return [
      'Publish token: origin/main carries none. It was seeded before this check shipped, so this is a revert or a deletion — do not publish; investigate.',
    ];
  }
  if (!w) return ['Publish token: the tracked live view has none. Restore it before publishing.'];
  if (!p) {
    return [
      'Publish token: the published page carries no publish token, but origin/main does. Most likely it was published from a branch that predates the token — check whether a lane branched before it landed. Otherwise the wrong file was published to this URL, or the page was clobbered. Do not publish over it until you know which.',
    ];
  }

  const behind = p.n < b.n;

  // Flag misuse is an invocation error, refused rather than ignored — the
  // --discharging unconsumed-name property.
  if (allowBehind && !behind) {
    return [
      `Publish token: --live-page-behind-main was passed, but the live page (${p.n}) is not behind origin/main (${b.n}). Remove the flag.`,
    ];
  }

  const { inBaseline, inMine, baselineInMine } = lookups;
  if (inBaseline === null || inBaseline === undefined || inMine === null || inMine === undefined) {
    return [
      "Publish token: could not search history for the published page's nonce. Do not publish until this passes.",
    ];
  }
  if (baselineInMine === null || baselineInMine === undefined) {
    return [
      "Publish token: could not search history for origin/main's own nonce. Do not publish until this passes.",
    ];
  }

  // Lookup consistency. If my branch contains origin/main's live view
  // (`baselineInMine`), then it contains main's history for that path, so
  // anything in main's history is in mine: `inBaseline && baselineInMine`
  // IMPLIES `inMine`. A caller reporting otherwise has wired a lookup to the
  // wrong ref or the wrong nonce — the live hazard here, since the delivery
  // plan currently wires ONE lookup where this function consumes four. Fail
  // closed: every downstream verdict is derived from these three answers, so a
  // contradiction among them makes all of them untrustworthy, not just one.
  if (inBaseline && baselineInMine && !inMine) {
    return [
      'Publish token: the history lookups contradict each other — the published nonce is in origin/main\'s history and origin/main\'s own nonce is in this branch\'s, yet the published nonce is reported absent here. A lookup is wired to the wrong ref or nonce. Fix the wiring; do not publish on these answers.',
    ];
  }

  // THE stale-nonce check, at any depth. A nonce already in the baseline's
  // history cannot legitimately carry a counter ahead of the baseline: that
  // means a lane bumped without minting, and every counter comparison below
  // would misattribute their publish to you.
  if (inBaseline && p.n > b.n) {
    return [
      `Publish token: the live page is at ${p.n}, ahead of origin/main (${b.n}), but its nonce ("${p.nonce}") is already in origin/main's history. A lane published without minting a new id. Do not publish over it — find that publish first.`,
    ];
  }
  // THE WORKING-SIDE invariant, and the one this design spent five review
  // passes without. Every other check governs the PUBLISHED nonce; nothing
  // related the working file to the baseline except a counter that the stale
  // lane increments itself — and the remedy at `w.n === b.n` told it to.
  //
  // The failure it closes, with no operator error anywhere in it: two lanes
  // branch from main at 47 and each stamps once (47 -> 48). B merges and
  // publishes. A runs the check for the first time, is told "the same as
  // origin/main — bump", obeys, and gets GREEN over a page it never saw. The
  // summary strip and footer revert; the ROWS are identical, so every existing
  // mechanical check is blind. That is the 2026-07-31/08-01 incident.
  //
  // `!baselineInMine` is that staleness, stated positively: origin/main's own
  // live-view nonce is not in my history, so my branch does not contain the
  // page I am about to publish over. It is checked BEFORE the counters because
  // it is the stronger fact — counters are the thing being lied to — and
  // before `!inBaseline && !inMine` so a stale lane hears "rebase" rather than
  // a rival-publish diagnosis it cannot act on.
  //
  // NOT a rejected design: this is the same history-backed question the
  // surviving invariant already asks, pointed at (b.nonce, HEAD) instead of
  // (p.nonce, baseline). No branch name, no hand-maintained value.
  if (!baselineInMine) {
    return [
      `Publish token: origin/main's live-view nonce ("${b.nonce}") is not in this branch's history — your branch does not contain the live view that is currently on main. REBASE; do not bump. Bumping past it publishes your copy over whatever landed in between.`,
    ];
  }

  if (!inBaseline && !inMine) {
    if (p.nonce === w.nonce) {
      return [
        `Publish token: the live page carries this branch's nonce ("${p.nonce}") but it is not committed yet, so it cannot be found in history. Commit the bump, then re-run.`,
      ];
    }
    return [
      `Publish token: the live page's nonce ("${p.nonce}") is in neither origin/main's history nor this branch's — another lane published since your baseline. Rebase, re-read the live page, and re-run. Do not publish.`,
    ];
  }

  // Production side of the same invariant: if the working file's nonce is
  // already in the baseline's history, it was not freshly minted.
  //
  // `workingInBaseline` is the THIRD lookup, and it gets the same fail-closed
  // treatment as the other two. It is guarded HERE rather than beside them
  // because it is only consulted in this state; hoisting it would demand a git
  // call the other branches never need. Reading it bare — as `&& lookups.x` —
  // made a FAILED lookup indistinguishable from "the nonce is fresh", so a git
  // error turned this STOP into a silent pass. That is the same fail-green
  // shape this file's header claims is closed, and the header said "the two
  // history answers" while the code consulted three.
  if (w.n > b.n) {
    const { workingInBaseline } = lookups;
    if (workingInBaseline === null || workingInBaseline === undefined) {
      return [
        "Publish token: could not search history for the tracked live view's nonce. Do not publish until this passes.",
      ];
    }
    if (workingInBaseline) {
      return [
        `Publish token: the tracked live view bumped the counter to ${w.n} but its nonce ("${w.nonce}") is already in origin/main's history — it was not freshly minted. Run \`node scripts/stamp-publish-token.mjs\`.`,
      ];
    }
  }

  // Un-minted, detectable with NO history lookup at all: the counter advanced
  // while the nonce did not. This is the same corruption guard 15 exists to
  // catch, one commit earlier — reachable before either nonce has been
  // committed, which is exactly when history cannot see it.
  if (p.nonce === w.nonce && w.n > p.n) {
    return [
      `Publish token: the tracked live view advanced the counter to ${w.n} but kept the published page's nonce ("${w.nonce}") — the counter was bumped without minting. Run \`node scripts/stamp-publish-token.mjs\`, which does both.`,
    ];
  }

  // Rebase OUTRANKS behind: in the overlap state the other order hands the
  // operator the mute flag while un-rebased.
  if (w.n < b.n) {
    return [
      `Publish token: the tracked live view is at ${w.n} but origin/main is at ${b.n} — your branch predates main. REBASE; do not bump. Publishing from here would overwrite whatever landed in between.`,
    ];
  }
  if (w.n === b.n) {
    return [
      `Publish token: the tracked live view is at ${w.n}, the same as origin/main. Run \`node scripts/stamp-publish-token.mjs\` to bump the counter and mint a new id — an unbumped publish is untracked.`,
    ];
  }
  if (behind && !allowBehind) {
    return [
      `Publish token: the live page is at ${p.n} but origin/main is at ${b.n} — the page is BEHIND main. A bump merged without publishing, or a publish was reverted. Confirm which, then re-run with --live-page-behind-main.`,
    ];
  }
  if (w.n <= p.n) {
    return [
      `Publish token: the tracked live view is at ${w.n}, not ahead of your own last publish (${p.n}). Run \`node scripts/stamp-publish-token.mjs\` again.`,
    ];
  }
  return [];
}

// true = nonce is in <ref>'s history for that path. false = it is not.
// null = the lookup itself failed. HEAD/<sha> explicitly, never --all: the
// baseline fetch means --all would see a rival's freshly-fetched commit.
//
// THREE git semantics here are load-bearing, and getting any of them wrong
// flips the answer in the PERMISSIVE direction for every STOP this gates.
// (Two were found by pass 5 and the third by pass 6, in this same call — count
// them here whenever one is added, and see the four-lookup comment above for
// why an out-of-date count in a comment is not a cosmetic defect.)
//
//   --full-history — a pathspec'd `git log` applies default history
//   simplification: at a merge that is TREESAME to one parent for that path,
//   only that parent is walked. Resolving a live-view conflict by taking one
//   side wholesale — the single most likely resolution, and the exact accident
//   this ticket exists for — makes the merge TREESAME and PRUNES the other
//   lane's commit out of the answer. `false` then means "pruned", not "absent".
//
//   the anchor — `-S` is a SUBSTRING search, not a whole-value match. A bare
//   six-hex nonce collides with the abbreviated commit SHAs this very file
//   quotes in its own changelog prose, so a rival's nonce could be "found" in
//   your history because you cited an unrelated SHA that contains it. Searching
//   for the full `data-publish-id="<nonce>"` makes the match positional as well
//   as textual. `parsePublishToken` constrains the nonce charset so the anchor
//   cannot be broken out of.
//   --diff-merges=first-parent — `git log` computes NO diff for a merge commit
//   unless asked, so pickaxe never inspects one. A nonce born in a CONFLICT
//   RESOLUTION therefore reads as absent from the very history that contains
//   it. That is not exotic here: this repo mandates merge commits (squash and
//   rebase merge are disabled), the live view is the file lanes race, and the
//   natural resolution IS a re-stamp — so the token ends up in neither parent.
//   `--full-history` does not cover this; it cures pruning, not merge diffing.
//   Paired with `-s`, which suppresses the patch body while leaving pickaxe
//   SELECTION untouched — without it every lookup streams a full diff of a
//   250 KB file through stdout.
export function nonceInHistory(repoRoot, liveViewPath, nonce, ref, gitRunner) {
  const anchored = `data-publish-id="${nonce}"`;
  const result = gitRunner(
    [
      'log',
      '--oneline',
      '-s',
      '--full-history',
      '--diff-merges=first-parent',
      '-S',
      anchored,
      ref,
      '--',
      liveViewPath,
    ],
    repoRoot,
  );
  if (result.error) return null;
  if (result.status !== 0) return null;
  if (typeof result.stdout !== 'string') return null;
  return result.stdout.trim() !== '';
}

export function bumpToken(html, mintNonce) {
  const parsed = parsePublishToken(html);
  if (parsed === null) throw new Error('stamp-publish-token: no publish token found in the live view.');
  if (parsed.malformed) throw new Error(`stamp-publish-token: ${parsed.malformed}`);
  const n = parsed.n + 1;
  // The counter is capped at 15 digits by the parser, so a bump AT the cap
  // would write a 16-digit token that this module's own reader then rejects —
  // wedging the check permanently, because stamping again needs a parseable
  // token to bump. Refuse instead, while the file is still valid. Unreachable
  // with an honest counter; reachable via a typo'd counter that merged.
  if (!/^\d{1,15}$/.test(String(n))) {
    throw new Error(
      `stamp-publish-token: bumping ${parsed.n} would exceed the 15-digit counter cap. Fix the counter in the file first.`,
    );
  }
  const nonce = mintNonce();
  // Validate the MINTED value against the same rule the parser enforces, or a
  // stamper can write a token its own reader rejects — and `mintNonce` is
  // caller-supplied, so nothing else constrains it.
  if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(nonce) || /^-/.test(nonce)) {
    throw new Error(`stamp-publish-token: minted nonce ${JSON.stringify(nonce)} is not 6-64 chars of [A-Za-z0-9_-].`);
  }
  // A FUNCTION replacement, not a string. String.replace expands `$&`, `$'`,
  // "$`" and `$1` in its replacement, so a minted nonce containing any of them
  // would splice the surrounding markup back into the attribute — corrupting
  // the file into a token that still parses. The charset check above already
  // excludes `$`; this makes the corruption unreachable rather than merely
  // unlikely, because the two constraints are independent.
  const next = html.replace(
    publishTokenRegex(),
    () => `data-published-as="${n}" data-publish-id="${nonce}"`,
  );
  return { html: next, n, nonce };
}
