// scripts/deps-watch.mjs
// Pure helpers for the ops-17 deps-watch (#790). NO IO here — see
// scripts/deps-watch-run.mjs for the orchestrator. Unit-tested under
// scripts/tests/deps-watch.test.mjs (npm run test:hooks).

export const KGP_PLUGINS = ['audio_session', 'flutter_foreground_task', 'mobile_scanner'];
export const STICKY_MARKER = '<!-- ops-17-deps-watch -->';

/**
 * -1/0/1 by numeric semver core; prerelease/build metadata ignored.
 * Known limitation: collapses prerelease ordering, so `1.0.0` vs `1.0.0-beta`
 * compares EQUAL (stable-over-prerelease is under-reported). Safe for the three
 * KGP plugins (all pinned at stable). Revisit if a plugin pins a `-beta`/`-dev`.
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

/** Read `name: ^x.y.z` (or bare `x.y.z`) pins for the requested names. */
export function parsePins(pubspecText, names) {
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // names are a param — never trust them raw in a RegExp
  const pins = {};
  for (const name of names) {
    const m = pubspecText.match(new RegExp(`^\\s*${escape(name)}:\\s*\\^?([0-9][^\\s#]*)`, 'm'));
    if (m) pins[name] = m[1];
  }
  return pins;
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

/** Per-plugin {pin, latest, ahead}; an absent package is treated as at-pin. */
export function computePluginStatus(pkgMap, pins, plugins = KGP_PLUGINS) {
  return plugins.map((name) => {
    const pin = pins[name] ?? null;
    const latest = pkgMap.get(name)?.latest ?? pin;
    const ahead = !!(pin && latest && compareSemver(latest, pin) > 0);
    return { name, pin, latest, ahead };
  });
}

export function extractState(commentBody) {
  if (!commentBody) return {};
  const m = commentBody.match(/<!--\s*state:\s*([\s\S]*?)\s*-->/);
  if (!m) return {};
  try {
    return JSON.parse(m[1]);
  } catch {
    return {};
  }
}

export function buildState(pluginStatus) {
  const state = {};
  for (const s of pluginStatus) state[s.name] = { latest: s.latest, ahead: s.ahead };
  return state;
}

/** Plugins that are ahead now but were not ahead in the prior state. */
export function computeTransitions(pluginStatus, priorState) {
  return pluginStatus.filter((s) => s.ahead && !priorState[s.name]?.ahead).map((s) => s.name);
}

/** The single sticky comment (by marker), or null. Found even if a human
 *  commented after it — so the orchestrator never creates a duplicate. */
export function findSticky(comments, marker = STICKY_MARKER) {
  return comments.find((c) => (c.body || '').includes(marker)) || null;
}

/** The gh-api REST request for refreshing the sticky: PATCH the existing
 *  comment by its NUMERIC id, else POST a new one to the issue. */
export function stickyRequest(existing, repo, issue) {
  return existing
    ? { method: 'PATCH', path: `repos/${repo}/issues/comments/${existing.id}` }
    : { method: 'POST', path: `repos/${repo}/issues/${issue}/comments` };
}

/** The human-visible markdown (used for both the job summary and sticky body). */
export function renderBody({ pluginStatus, behind, today }) {
  const anyAhead = pluginStatus.some((s) => s.ahead);
  const lines = [`### ops-17 deps watch — updated ${today}`, ''];
  if (anyAhead) {
    const names = pluginStatus
      .filter((s) => s.ahead)
      .map((s) => `\`${s.name}\` (pin ${s.pin} → latest ${s.latest})`)
      .join(', ');
    lines.push(`> ⚠️ **A KGP plugin has a newer version: ${names}.**`);
    lines.push('> A newer version is **not** proof it removed KGP — verify: bump locally → `flutter build apk --release` → confirm the KGP warning is gone.');
    lines.push('');
  } else {
    lines.push('_All three KGP plugins are still at their pin — no migrated release yet (blocked upstream, ops-17)._');
    lines.push('');
  }
  lines.push('| KGP plugin | pin | latest | newer? |', '|---|---|---|---|');
  for (const s of pluginStatus) {
    lines.push(`| \`${s.name}\` | ${s.pin ?? '?'} | ${s.latest ?? '?'} | ${s.ahead ? '**yes**' : 'no'} |`);
  }
  lines.push('', `#### Direct/dev deps behind latest (${behind.length})`);
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
  const state = buildState(args.pluginStatus);
  return [STICKY_MARKER, `<!-- state: ${JSON.stringify(state)} -->`, '', renderBody(args)].join('\n');
}

export function renderTransitionComment(transitions, pluginStatus, mention = '@dudarenok-maker') {
  if (!transitions.length) return null;
  const items = transitions.map((name) => {
    const s = pluginStatus.find((x) => x.name === name);
    return `- \`${name}\`: pin ${s.pin} → latest ${s.latest}`;
  });
  return [
    `${mention} — ops-17: a KGP plugin now has a newer version. Verify whether it removed KGP (built-in Kotlin / AGP 9):`,
    '',
    ...items,
    '',
    'Recipe: bump locally → `flutter build apk --release` → if the KGP warning is gone, bump the pin, drop the escape-hatch flags + the `app.yml` Trip-B flag assertion, and close #790.',
  ].join('\n');
}
