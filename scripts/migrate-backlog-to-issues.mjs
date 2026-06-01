#!/usr/bin/env node
// Bulk-migrate docs/BACKLOG.md items into GitHub issues (plan 166).
//
// Each backlog item (`<prefix>-<n>` — e.g. fs-1, srv-13) becomes ONE issue
// titled `<prefix>-<n> — <one-line what>`, labelled by area + MoSCoW tier +
// type. The `<prefix>-<n>` ID stays the canonical cross-reference; the issue
// `#NN` is the GitHub-native auto-close hook. The issue body is the canonical
// detail home; docs/BACKLOG.md is later thinned (scripts/thin-backlog.mjs) to
// a prioritized planning view that links here.
//
// Usage:
//   node scripts/migrate-backlog-to-issues.mjs            (dry-run — prints the manifest)
//   node scripts/migrate-backlog-to-issues.mjs --apply    (creates the issues via `gh`)
//   node scripts/migrate-backlog-to-issues.mjs --help
//
// Dry-run (the default) parses BACKLOG.md and prints exactly what it WOULD
// file — eyeball the manifest before --apply. --apply is IDEMPOTENT: it lists
// existing issues once and keys them by the `<prefix>-<n>` token parsed out of
// each title, so re-running never double-files (a re-worded "what" is fine —
// the ID token is the key). On --apply it writes docs/backlog-issue-map.json
// ({ "<prefix>-<n>": <issueNumber> }), the single source scripts/thin-backlog.mjs
// consumes.
//
// Struck-through / RESOLVED entries (e.g. srv-17) and ID-less prose are NOT
// filed — they're reported for the human tidy/archive pass that precedes the
// real run. The tidy pass (drop/merge/archive stale items) is human judgement,
// never scripted.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const BACKLOG_PATH = resolve(repoRoot, 'docs', 'BACKLOG.md');
const MAP_PATH = resolve(repoRoot, 'docs', 'backlog-issue-map.json');

// Throttle between `gh issue create` calls so a ~50-issue run stays well under
// GitHub's secondary rate limit on content creation.
const CREATE_THROTTLE_MS = 1500;
const RATE_LIMIT_BACKOFF_MS = 60000;

const LEADING_ID = /^`(fe|srv|side|ops|fs)-(\d+)`/; // a heading that leads with `id`

const TIER_FROM_SECTION = {
  Must: 'must',
  Should: 'should',
  Could: 'could',
  "Won't": 'wont',
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests — no `gh`, no filesystem).
// ---------------------------------------------------------------------------

// Parse the `<prefix>-<n>` token out of an issue title like
// "fs-1 — In-app upgrade pathway". Returns "fs-1" or null. This is the
// idempotency key: keying on the ID token (not the full title) means a
// re-worded "what" never produces a duplicate issue.
export function issueIdFromTitle(title) {
  if (typeof title !== 'string') return null;
  const m = /^\s*(fe|srv|side|ops|fs)-(\d+)\b/.exec(title);
  return m ? `${m[1]}-${m[2]}` : null;
}

// Strip a leading list-marker / strikethrough noise from a heading's title text.
function cleanTitle(text) {
  return text
    .replace(/^\s*[—–-]\s*/, '') // drop the "— " separator after the id token
    .replace(/~~(.+?)~~/g, '$1') // unwrap inline strikethrough (e.g. srv-4's resolved sub-chains)
    .trim();
}

// Parse BACKLOG.md into a structured list. Pure: takes the markdown string,
// returns { items, skipped, warnings }.
//
//   items:    [{ id, prefix, num, tier, title, body, tracking }]
//   skipped:  [{ id, reason }]  — resolved/struck entries, reported not filed
//   warnings: [string]          — anything that parsed oddly (no tier, etc.)
export function parseBacklogItems(markdown) {
  const lines = String(markdown).split(/\r?\n/);
  const items = [];
  const skipped = [];
  const warnings = [];

  let tier = null; // current MoSCoW bucket

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // MoSCoW section heading: "## Must — …", "## Won't (this round) — …".
    const section = /^##\s+(Must|Should|Could|Won't)\b/.exec(line);
    if (section) {
      tier = TIER_FROM_SECTION[section[1]] ?? null;
      continue;
    }
    if (/^##\s+Retired numbering\b/.test(line)) {
      tier = null; // everything after this is bookkeeping, not items
      continue;
    }

    // Candidate item heading: ### or #### whose text leads with `<id>`.
    const heading = /^(#{3,4})\s+(.*\S)\s*$/.exec(line);
    if (!heading) continue;
    const headingText = heading[2];

    const idMatch = LEADING_ID.exec(headingText);
    if (!idMatch) continue; // sub-group title (e.g. "### Audio & playback") — not an item

    const id = `${idMatch[1]}-${idMatch[2]}`;
    const afterId = headingText.slice(idMatch[0].length);
    const titleText = cleanTitle(afterId);

    // Resolved / struck-through entries are kept in BACKLOG.md for history and
    // must NOT be auto-filed. Signal: the word RESOLVED, or the title portion
    // STARTS with strikethrough (srv-17). srv-4 has inline ~~jsdom~~ mid-title
    // but isn't resolved, so we check the *start* not mere presence.
    const isResolved = /\bRESOLVED\b/.test(headingText) || /^\s*~~/.test(afterId);
    if (isResolved) {
      skipped.push({ id, reason: 'resolved / struck-through — leave for the human tidy pass' });
      continue;
    }

    if (!tier) {
      warnings.push(`${id}: item heading found outside a MoSCoW section — skipped.`);
      continue;
    }

    // Capture the body: every line up to the next heading, the next "---" rule,
    // or an ID-less italic shipped-note paragraph ("_`fs-2` … shipped …"),
    // which sits between items and must not bleed into this item's body.
    const bodyLines = [];
    for (let j = i + 1; j < lines.length; j++) {
      const b = lines[j];
      if (/^#{2,4}\s/.test(b)) break;
      if (/^---\s*$/.test(b)) break;
      if (/^_`/.test(b)) break; // standalone shipped-note paragraph
      bodyLines.push(b);
    }
    const body = bodyLines.join('\n').trim();
    // "tracking item" / "pure tracking" are the precise phrases the genuine
    // watchdog items (fe-4, srv-4) use; broader words like "watchdog" alone
    // false-positive on engine items that merely mention one (e.g. side-11).
    const tracking = /\b(tracking item|pure tracking)\b/i.test(body);

    items.push({ id, prefix: idMatch[1], num: Number(idMatch[2]), tier, title: titleText, body, tracking });
  }

  return { items, skipped, warnings };
}

// Build the issue title, body, and label set for one parsed item.
export function issuePayload(item) {
  const title = `${item.id} — ${item.title}`;
  const labels = [`area:${item.prefix}`, `moscow:${item.tier}`];
  if (item.tracking) labels.push('type:chore', 'tracking');
  else labels.push('type:feature');
  const tierName = { must: 'Must', should: 'Should', could: 'Could', wont: "Won't" }[item.tier];
  const body = `${item.body}\n\n---\nBacklog: \`${item.id}\` · MoSCoW: ${tierName}`;
  return { title, body, labels };
}

// ---------------------------------------------------------------------------
// Side-effecting glue (gh CLI). Mirrors scripts/bump-version.mjs.
// ---------------------------------------------------------------------------

function info(msg) {
  process.stdout.write(`${msg}\n`);
}
function die(msg) {
  process.stderr.write(`[FAIL] ${msg}\n`);
  process.exit(1);
}
function gh(args, opts = {}) {
  return execFileSync('gh', args, {
    cwd: repoRoot,
    stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
  });
}
function ghAvailable() {
  const r = spawnSync('gh', ['--version'], { stdio: 'ignore' });
  return !r.error && r.status === 0;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseArgs(argv) {
  const out = { apply: false };
  for (const a of argv) {
    if (a === '--apply') out.apply = true;
    else if (a === '--help' || a === '-h') {
      info(
        'Usage: node scripts/migrate-backlog-to-issues.mjs [--apply]\n' +
          '  (no flag) dry-run — parse BACKLOG.md and print the manifest\n' +
          '  --apply   create the issues via `gh` (idempotent) + write docs/backlog-issue-map.json',
      );
      process.exit(0);
    } else die(`Unknown argument: ${a}`);
  }
  return out;
}

// Existing issues → { "<prefix>-<n>": number } so re-runs skip already-filed items.
function listExistingById() {
  const json = gh(
    ['issue', 'list', '--state', 'all', '--limit', '500', '--json', 'number,title'],
    { capture: true },
  );
  const byId = new Map();
  const titles = [];
  for (const issue of JSON.parse(json)) {
    titles.push({ number: issue.number, title: issue.title });
    const id = issueIdFromTitle(issue.title);
    if (id) byId.set(id, issue.number);
  }
  return { byId, titles };
}

// `gh issue create` prints the new issue URL on stdout; the trailing path
// segment is the number.
function issueNumberFromUrl(stdout) {
  const m = /\/issues\/(\d+)\s*$/.exec(String(stdout).trim());
  return m ? Number(m[1]) : null;
}

async function createIssue({ title, body, labels }) {
  const args = ['issue', 'create', '--title', title, '--body', body];
  for (const l of labels) args.push('--label', l);
  try {
    return issueNumberFromUrl(gh(args, { capture: true }));
  } catch (err) {
    const text = `${err?.stdout ?? ''}${err?.stderr ?? ''}${err?.message ?? ''}`;
    if (/rate limit|secondary|\b403\b/i.test(text)) {
      info(`[RATE] hit a rate limit creating "${title}". Backing off ${RATE_LIMIT_BACKOFF_MS / 1000}s, then one retry…`);
      await sleep(RATE_LIMIT_BACKOFF_MS);
      return issueNumberFromUrl(gh(args, { capture: true }));
    }
    throw err;
  }
}

function printManifest({ items, skipped, warnings }) {
  info(`Parsed ${items.length} migratable item(s) from docs/BACKLOG.md:\n`);
  for (const item of items) {
    const { labels } = issuePayload(item);
    info(`  ${item.id.padEnd(8)} [${labels.join(', ')}]  ${item.title}`);
  }
  if (skipped.length) {
    info(`\nNOT filed (left for the human tidy/archive pass):`);
    for (const s of skipped) info(`  ${s.id.padEnd(8)} ${s.reason}`);
  }
  if (warnings.length) {
    info(`\nWarnings:`);
    for (const w of warnings) info(`  ! ${w}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(BACKLOG_PATH)) die(`Not found: ${BACKLOG_PATH}`);

  const parsed = parseBacklogItems(readFileSync(BACKLOG_PATH, 'utf8'));
  printManifest(parsed);

  if (!args.apply) {
    info(`\n[DRY-RUN] Nothing created. Re-run with --apply to file these issues.`);
    process.exit(0);
  }

  if (!ghAvailable()) {
    die('`gh` not found. Install the GitHub CLI + `gh auth login`, then re-run with --apply.');
  }

  info(`\n[APPLY] Reconciling against existing issues…`);
  const { byId, titles } = listExistingById();
  const map = {};
  let created = 0;
  let reused = 0;

  for (const item of parsed.items) {
    if (byId.has(item.id)) {
      map[item.id] = byId.get(item.id);
      reused++;
      continue;
    }
    const payload = issuePayload(item);
    // Collision guard: an existing issue with the same wording but a title that
    // lost its `<prefix>-<n>` prefix would slip past the id-key dedup.
    const dup = titles.find(
      (t) => issueIdFromTitle(t.title) === null && t.title.toLowerCase().includes(item.title.toLowerCase()),
    );
    if (dup) {
      info(`  ! possible duplicate of #${dup.number} ("${dup.title}") — its title lost the ${item.id} prefix? Filing anyway.`);
    }
    const number = await createIssue(payload);
    if (number == null) die(`Created an issue for ${item.id} but couldn't parse its number from gh output.`);
    map[item.id] = number;
    created++;
    info(`  + ${item.id} → #${number}`);
    await sleep(CREATE_THROTTLE_MS);
  }

  // Sort the map by id for a stable, reviewable diff.
  const sorted = Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(MAP_PATH, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
  info(`\n[OK] created ${created}, reused ${reused}. Wrote ${MAP_PATH}.`);
  info(`     Next: node scripts/thin-backlog.mjs (dry-run) to rewrite BACKLOG.md to the thin form.`);
  process.exit(0);
}

// Guard so tests can import the pure helpers without running the migration
// (realpath argv[1] to survive symlinked temp dirs — see bump-version.mjs).
const invokedHref = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (invokedHref && import.meta.url === invokedHref) {
  await main();
}
