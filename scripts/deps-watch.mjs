// scripts/deps-watch.mjs
// Pure helpers for the ops-17 deps-watch. NO IO here. Unit-tested under
// scripts/tests/deps-watch.test.mjs (npm run test:hooks). The sticky comment
// lives on #4726 (#4696); #790 is the KGP issue, tracked by hand. The KGP-plugin
// signal was retired (#4649): only the catch-up nudge (direct/dev deps behind
// `latest`) remains.

export const STICKY_MARKER = '<!-- ops-17-deps-watch -->';

/**
 * -1/0/1 by numeric semver core; prerelease/build metadata ignored.
 * Known limitation: collapses prerelease ordering, so `1.0.0` vs `1.0.0-beta`
 * compares EQUAL (stable-over-prerelease is under-reported). Revisit if a dep
 * pins a `-beta`/`-dev`. Build metadata is dropped too, so `10.1.0+1` vs
 * `10.1.0` also compares EQUAL. Unlike the prerelease case this IS reachable
 * here: the workflow runs `flutter pub outdated --json --show-all` with no
 * `--prereleases`, so prereleases never reach `latest`, but a `+N`-only
 * republish does — and won't count as behind even though `latest` changed.
 */
export function compareSemver(a, b) {
  const core = (v) => String(v).split('+')[0].split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const pa = core(a);
  const pb = core(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** `flutter pub outdated --json --show-all` -> Map<name,{kind,current,latest}>. */
export function parseOutdated(jsonTextOrObj) {
  const data = typeof jsonTextOrObj === 'string' ? JSON.parse(jsonTextOrObj) : jsonTextOrObj;
  const map = new Map();
  for (const pkg of data.packages ?? []) {
    map.set(pkg.package, {
      kind: pkg.kind ?? 'transitive',
      current: pkg.current?.version ?? null,
      latest: pkg.latest?.version ?? null,
    });
  }
  return map;
}

/** direct/dev packages whose latest exceeds current. */
export function computeBehind(pkgMap) {
  const behind = [];
  for (const [name, p] of pkgMap) {
    if ((p.kind === 'direct' || p.kind === 'dev') && p.current && p.latest && compareSemver(p.latest, p.current) > 0) {
      behind.push({ name, kind: p.kind, current: p.current, latest: p.latest });
    }
  }
  return behind;
}

export function exitCodeFor(behind) {
  return behind.length ? 1 : 0;
}

/** The single sticky comment (by marker), or null. Found even if a human
 *  commented after it — so the orchestrator never creates a duplicate. Only a
 *  github-actions[bot] comment that STARTS with the marker counts, so a human
 *  quote-reply of it is never PATCHed. */
export function findSticky(comments, marker = STICKY_MARKER) {
  return (
    comments.find(
      (c) => (c.body || '').startsWith(marker) && c.user?.login === 'github-actions[bot]',
    ) || null
  );
}

/** The gh-api REST request for refreshing the sticky: PATCH the existing
 *  comment by its NUMERIC id, else POST a new one to the issue. */
export function stickyRequest(existing, repo, issue) {
  return existing
    ? { method: 'PATCH', path: `repos/${repo}/issues/comments/${existing.id}` }
    : { method: 'POST', path: `repos/${repo}/issues/${issue}/comments` };
}

/** The exact `gh api` argv that writes the sticky comment (method + body field). */
export function stickyWriteArgs(req, body) {
  return ['api', req.path, '--method', req.method, '-f', `body=${body}`];
}

/** The human-visible markdown (used for both the job summary and sticky body). */
export function renderBody({ behind, today }) {
  const lines = [`### ops-17 deps watch — updated ${today}`, ''];
  lines.push(`#### Direct/dev deps behind latest (${behind.length})`);
  if (behind.length) {
    lines.push('| package | kind | current | latest |', '|---|---|---|---|');
    for (const b of behind) lines.push(`| \`${b.name}\` | ${b.kind} | ${b.current} | ${b.latest} |`);
  } else {
    lines.push('_None — all direct/dev deps current._');
  }
  return lines.join('\n');
}

export const renderSummary = renderBody;

export function renderSticky(args) {
  return [STICKY_MARKER, '', renderBody(args)].join('\n');
}
