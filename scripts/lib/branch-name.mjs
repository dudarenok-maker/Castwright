// Shared branch-name parser for scripts that need to validate or build
// `<type>/<scope>-<slug>` branch names per CONTRIBUTING.md "Branch naming".
//
// Reuses the type + scope vocabulary from validate-commit-msg.mjs so commit
// messages and branches stay in sync: change the vocabulary in one place and
// both gates pick it up.

import { TYPES, CHORE_TYPE, SCOPES } from '../validate-commit-msg.mjs';

const ALL_TYPES = [...TYPES, CHORE_TYPE];
const TYPE_GROUP = `(?:${ALL_TYPES.join('|')})`;
const SCOPE_GROUP = `(?:${SCOPES.join('|')})`;

// Slug: lowercase alnum, hyphen-separated, must start with alnum.
// Examples: `batch-retry`, `voice-swatch-click`, `plan-38`.
const SLUG = `[a-z0-9][a-z0-9-]*`;

const BRANCH_PATTERN = new RegExp(`^(${TYPE_GROUP})/(${SCOPE_GROUP})-(${SLUG})$`);

export function parseBranchName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    return { ok: false, reason: 'empty branch name' };
  }
  const match = BRANCH_PATTERN.exec(name);
  if (!match) {
    return {
      ok: false,
      reason: `does not match <type>/<scope>-<slug> (types: ${ALL_TYPES.join('|')}; scopes: ${SCOPES.join('|')})`,
    };
  }
  return { ok: true, type: match[1], scope: match[2], slug: match[3] };
}

export { ALL_TYPES, SCOPES };
