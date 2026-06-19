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
