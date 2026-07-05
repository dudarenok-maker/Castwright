#!/usr/bin/env node
// Regenerate docs/BACKLOG.md from the GitHub Projects board (ops-25 / #1321).
// Queries type:feature issues on the board with Status != Done via GraphQL,
// groups by moscow:* label, and renders the thin planning-view row format
// (What/Benefit parsed verbatim out of each issue body — never duplicated
// free text here). Won't items (moscow:wont) are included regardless of
// board Status. See docs/superpowers/specs/2026-07-05-github-issues-kanban-design.md §D.
//
// Usage:
//   node scripts/backlog-sync.mjs            (dry-run — prints a diff)
//   node scripts/backlog-sync.mjs --apply    (rewrites docs/BACKLOG.md)
//   node scripts/backlog-sync.mjs --help
//
// NOTE on scope: this generator groups only by moscow:* tier. The hand-written
// per-tier framing paragraphs and the curated sub-group headings (e.g. "###
// Differentiation — the moats, made marketable") that exist in the current
// docs/BACKLOG.md are NOT reproduced — they're editorial curation the board has
// no way to express, and preserving them would mean hand-patching the generated
// file forever, defeating the point of generating it. The first --apply run's
// diff will look like a large rewrite that drops them; that's expected. Only
// the three tier headings + the Retired-numbering section stay as static prose.

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests — no `gh`, no network).
// ---------------------------------------------------------------------------

// Parse the '- _What:_ ...' / '- _Benefit...:_ ...' bullets out of an issue
// body — the same bullet shape scripts/thin-backlog.mjs already parses.
export function parseWhatBenefit(body) {
  const lines = String(body ?? '').split(/\r?\n/);
  const strip = (line) =>
    line ? line.trim().replace(/^- _[^:]*:_\s*/, '').trim() : null;
  const whatLine = lines.find((l) => /^- _What\b/.test(l.trim()));
  const benefitLine = lines.find((l) => /^- _Benefit\b/.test(l.trim()));
  return { what: strip(whatLine), benefit: strip(benefitLine) };
}

// Order two issues by their board Priority field (lower number = higher
// priority, appears first); an issue with no Priority set sorts after every
// prioritized issue; two un-prioritized issues tiebreak by issue number.
// This is the resolution to the spec's §D open risk on intra-tier
// ordering — a real Priority field, not a fallback to issue-number-only
// sort (see the plan's Global Constraints).
function compareByPriority(a, b) {
  const ap = a.priority ?? null;
  const bp = b.priority ?? null;
  if (ap !== null && bp !== null && ap !== bp) return ap - bp;
  if (ap !== null && bp === null) return -1;
  if (ap === null && bp !== null) return 1;
  return a.number - b.number;
}

// Group open, non-Done type:feature issues by moscow:* tier, each tier
// sorted by Priority. Ignores 'wont' (rendered separately, regardless of
// Status) and any issue with no recognized tier (surfaced by the
// parseability audit, scripts/audit-issue-parseability.mjs — never
// silently dropped in the real query path, see Task 3).
export function groupByMoscow(issues) {
  const groups = { must: [], should: [], could: [] };
  for (const issue of issues) {
    if (!groups[issue.moscow]) continue;
    groups[issue.moscow].push(issue);
  }
  for (const tier of Object.keys(groups)) {
    groups[tier].sort(compareByPriority);
  }
  return groups;
}

const TIER_HEADING = {
  must: '## Must — the beta → full-product spine (marketability & discoverability)',
  should: '## Should — important, not blocking ship',
  could: '## Could — nice to have, low-cost win',
};

const HEADER = `# Backlog (MoSCoW)

The prioritized planning view, **generated from the GitHub Projects board**
by \`npm run backlog:sync\` (ops-25) — do not hand-edit; edit the linked issue
and re-run the sync instead. Each item maps to exactly one GitHub issue — the
**canonical detail home** (What / Acceptance / Key files / Depends on /
Benefit). This file lists only \`type:feature\` issues whose board Status is
not \`Done\`; bugs and \`type:chore\` issues live on the board's "Bugs & Chores"
view instead and never appear here. See
[CONTRIBUTING.md "Issues"](../CONTRIBUTING.md#issues).

**Item IDs are permanent.** Each item carries a \`<prefix>-<n>\` ID — \`fe\`
(frontend), \`srv\` (server), \`side\` (TTS sidecar), \`ops\` (CI / build /
dev-tooling), \`fs\` (full-stack), or \`app\` (Android companion app). IDs are
assigned once and **never reused or renumbered**; gaps are expected.

**Priority = position.** Ordering within a tier follows each issue's numeric
\`Priority\` field on the board (lower number = higher priority, appears
first) — set it via the board UI or \`gh project item-edit --field-id
<priorityFieldId> --number <n>\` to reprioritize, then re-run \`npm run
backlog:sync\`. An issue with no \`Priority\` set sorts after every
prioritized issue in its tier.`;

const RETIRED_NUMBERING = `## Retired numbering

The old per-bucket \`Could #N\` / \`Should #N\` numbering was retired on
2026-05-25 in favour of the permanent \`<prefix>-<n>\` IDs above (it renumbered
on every ship, so external references rotted). Any code comment or plan doc
still citing a bare \`Could/Should/Must #N\` is either (a) a stale
pre-2026-05-25 reference — resolve it by matching the comment's described
feature to an item above or to its shipping plan — or (b) **plan-internal**
numbering of the form \`plan <NN> Should #M\`, which is frozen and correct.
Don't reintroduce bare-number backlog references.`;

function renderItem(issue) {
  const { what, benefit } = parseWhatBenefit(issue.body);
  const lines = [
    `#### \`${issue.id}\` — ${issue.title} ([#${issue.number}](${issue.url}))`,
    '',
  ];
  lines.push(
    what
      ? `- _What:_ ${what}`
      : `- _What:_ _(no _What:_ bullet found in #${issue.number} — fix the issue body, see the parseability audit)_`,
  );
  lines.push(
    benefit
      ? `- _Benefit:_ ${benefit}`
      : `- _Benefit:_ _(no _Benefit:_ bullet found in #${issue.number} — fix the issue body, see the parseability audit)_`,
  );
  lines.push(`_Full detail + acceptance:_ [#${issue.number}](${issue.url}).`, '');
  return lines.join('\n');
}

function renderWont(issue) {
  return `- \`${issue.id}\` — ${issue.title} ([#${issue.number}](${issue.url})).`;
}

// Render the full docs/BACKLOG.md contents.
// groups: output of groupByMoscow(). wontIssues: [{id,number,title,url}].
export function renderBacklogMd({ groups, wontIssues }) {
  const out = [HEADER, '', '---', ''];
  for (const tier of ['must', 'should', 'could']) {
    out.push(TIER_HEADING[tier], '');
    for (const issue of groups[tier]) out.push(renderItem(issue));
  }
  out.push("## Won't (this round) — explicitly parked", '');
  for (const issue of [...wontIssues].sort((a, b) => a.number - b.number)) {
    out.push(renderWont(issue), '');
  }
  out.push(RETIRED_NUMBERING, '');
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}
