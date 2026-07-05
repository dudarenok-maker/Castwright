#!/usr/bin/env node
// Read-only rollout tool (ops-25 rollout step 7): spot-check every open
// type:feature issue for (a) a cleanly parseable _What:_/_Benefit:_ bullet
// pair and (b) a title that leads with the <prefix>-<n> ID token — both are
// things backlog-sync.mjs depends on to render a real row instead of a
// placeholder or a silent skip (spec §D open risk #2). Reuses the exact
// parser/regex backlog-sync.mjs uses at generation time, so "parses here"
// == "will render correctly there."

import { execFileSync } from 'node:child_process';
import { parseWhatBenefit } from './backlog-sync.mjs';

// Mirrors backlog-sync.mjs's private LEADING_ID/idAndTitleFromTitle — kept
// as a local copy rather than an import since that regex isn't part of
// backlog-sync.mjs's exported (tested) surface.
const LEADING_ID = /^(fe|srv|side|ops|fs|app)-(\d+)\s*—\s*(.*)$/;

function info(msg) { process.stdout.write(`${msg}\n`); }

function listOpenFeatureIssues() {
  const raw = execFileSync('gh', ['issue', 'list', '--state', 'open', '--label', 'type:feature', '--limit', '200', '--json', 'number,title,body,labels'], { encoding: 'utf8' });
  return JSON.parse(raw);
}

function main() {
  const issues = listOpenFeatureIssues();
  const idProblems = issues.filter((i) => !LEADING_ID.test(i.title.trim()));
  // moscow:wont issues render via a different path (renderWont — title/url
  // only, no What/Benefit) and are excluded from the bullet check below.
  const wontOrNoTier = (i) => {
    const moscowLabel = i.labels.map((l) => l.name).find((n) => n.startsWith('moscow:'));
    return !moscowLabel || moscowLabel === 'moscow:wont';
  };
  const bulletProblems = issues.filter((i) => {
    if (wontOrNoTier(i)) return false;
    const { what, benefit } = parseWhatBenefit(i.body);
    return !what || !benefit;
  });

  info(`${issues.length} open type:feature issue(s) checked.`);

  if (idProblems.length) {
    info(`\n${idProblems.length} issue(s) have a title that doesn't lead with <prefix>-<n> — backlog-sync.mjs silently SKIPS these (they'll just be missing from docs/BACKLOG.md, no placeholder):`);
    for (const p of idProblems) info(`  #${p.number} "${p.title}"`);
  }
  if (bulletProblems.length) {
    info(`\n${bulletProblems.length} issue(s) are missing a _What:_/_Benefit:_ bullet — backlog-sync.mjs renders a visible placeholder for these:`);
    for (const p of bulletProblems) {
      const { what, benefit } = parseWhatBenefit(p.body);
      info(`  #${p.number} "${p.title}"  missing: ${!what ? 'What ' : ''}${!benefit ? 'Benefit' : ''}`);
    }
  }
  if (!idProblems.length && !bulletProblems.length) {
    info('[OK] every issue has a parseable <prefix>-<n> title and a _What:_/_Benefit:_ bullet pair.');
  }
}

main();
