#!/usr/bin/env node
// Stamp the on-box register live view's publish token: bump the counter and
// mint a fresh id, atomically, in one command.
//
// WHY THIS EXISTS AT ALL. The token is `data-published-as="<counter>"
// data-publish-id="<nonce>"`. Two of the eight designs that preceded it failed
// because a human was expected to maintain part of that pair by hand — and a
// hand-maintained identity goes stale, which fails in the GREEN direction: a
// competing lane whose stale value happens to match yours reads as your own
// earlier publish. Bumping the counter without minting a new id is the same
// failure with an extra step. So the rule is: nothing hand-edits this token.
// Run this instead. `scripts/check-onbox-register.mjs`'s remedies name this
// command precisely so no runbook line ever says "bump it by one".
//
// Usage:
//   node scripts/stamp-publish-token.mjs            # stamp the live view
//   node scripts/stamp-publish-token.mjs --check    # report, change nothing
//   node scripts/stamp-publish-token.mjs --file X   # stamp some other file
//
// Exit codes: 0 stamped (or --check found a token), 1 refused.

import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bumpToken, parsePublishToken } from './publish-token.mjs';
import { isDirectlyInvoked } from './lib/is-main-module.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_FILE = 'docs/testing/onbox-acceptance-register-live-view.html';

// 12 lowercase hex. The parser admits [A-Za-z0-9_-]{6,64}; 12 is chosen well
// above the floor so a nonce is not plausibly confusable with the abbreviated
// commit SHAs this page quotes in its own changelog prose. The history lookup
// anchors on `data-publish-id="<nonce>"` so a collision is not a correctness
// bug, but keeping the two shapes distinct keeps the logs readable.
export const mintNonce = () => randomBytes(6).toString('hex');

// The genesis case: the file has no token yet, so there is nothing to bump.
// This is the ONLY path that creates a token, and it exists so that even the
// first one is machine-written — an operator typing the seed by hand is how a
// malformed or too-short id would enter the file, and the seed is the one
// value every later comparison is anchored to.
const SEED_AFTER = /(<h1[^>]*>[\s\S]*?<\/h1>)/;

export function seedToken(html, mint = mintNonce) {
  if (parsePublishToken(html) !== null) {
    throw new Error('stamp-publish-token: this file already has a token; stamp it, do not seed it.');
  }
  if (!SEED_AFTER.test(html)) {
    throw new Error('stamp-publish-token: no <h1> found to anchor the seed token to.');
  }
  const nonce = mint();
  // A hidden <div>, not a <meta>: this file is a body fragment (the publisher
  // supplies <html>/<head>), and <meta> is not valid outside <head>. And an
  // ATTRIBUTE pair rather than an HTML comment, because checkLiveView's first
  // action is stripHtmlComments — a comment-carried token is invisible to the
  // very function that has to read it. The explanatory comment beside it is
  // stripped harmlessly; the attributes are not.
  const marker =
    `\n  <!-- Publish token. NEVER hand-edit: run \`npm run stamp:publish-token\`.\n` +
    `       The counter orders publishes; the id proves which branch produced one.\n` +
    `       Attributes, not a comment: checkLiveView blanks comments before reading. -->\n` +
    `  <div hidden data-published-as="1" data-publish-id="${nonce}"></div>\n`;
  return { html: html.replace(SEED_AFTER, `$1\n${marker}`), n: 1, nonce };
}

function main(argv) {
  const fileArg = argv.indexOf('--file');
  const rel = fileArg !== -1 ? argv[fileArg + 1] : DEFAULT_FILE;
  if (fileArg !== -1 && !rel) {
    process.stderr.write('stamp-publish-token: --file needs a path.\n');
    return 1;
  }
  const abs = resolve(REPO_ROOT, rel);

  let html;
  try {
    html = readFileSync(abs, 'utf8');
  } catch (err) {
    process.stderr.write(`stamp-publish-token: cannot read ${rel}: ${err.message}\n`);
    return 1;
  }

  const existing = parsePublishToken(html);

  if (argv.includes('--check')) {
    if (existing === null) {
      process.stdout.write(`stamp-publish-token: ${rel} has NO publish token (needs seeding).\n`);
      return 1;
    }
    if (existing.malformed) {
      process.stderr.write(`stamp-publish-token: ${rel} token is malformed — ${existing.malformed}\n`);
      return 1;
    }
    process.stdout.write(
      `stamp-publish-token: ${rel} is at ${existing.n} (id ${existing.nonce}).\n`,
    );
    return 0;
  }

  let result;
  try {
    result = existing === null ? seedToken(html) : bumpToken(html, mintNonce);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 1;
  }

  writeFileSync(abs, result.html);
  const verb = existing === null ? 'SEEDED' : 'stamped';
  process.stdout.write(
    `stamp-publish-token: ${verb} ${rel} -> ${result.n} (id ${result.nonce}).\n` +
      `Commit this before running check:onbox-register --against-published — an\n` +
      `uncommitted stamp cannot be found in history, and the check says so.\n`,
  );
  return 0;
}

// Via the shared helper, not a hand-rolled comparison: a naive form silently
// evaluates false through a junction (this repo junctions worktrees), so main()
// would never run and the process would exit 0 with no output — a vacuous
// green rather than a visible failure. See scripts/lib/is-main-module.mjs (#2291).
//
// And `process.exitCode = ...` rather than `process.exit(main())`: exit()
// terminates before Node flushes pending async stdout, which is synchronous on
// Windows but ASYNCHRONOUS on POSIX — this script prints three lines, so
// exit() would truncate its own tail on a Linux/macOS runner while looking
// perfect locally.
if (isDirectlyInvoked(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
