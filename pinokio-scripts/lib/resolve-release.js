// Resolve AND checkout the latest PUBLISHED Castwright release tag.
// Pure functions (unit-tested) + a CLI (acceptance-tested) at the bottom.
//
// CLI (invoked by pinokio-scripts/install.js + pinokio-scripts/update.js as a SINGLE shell.run
// step — `node pinokio-scripts/lib/resolve-release.js`): git-fetches tags, resolves the
// latest published release, `git checkout`s it, and guards that the checked-out
// tree actually contains the pinokio scripts. Doing fetch+checkout INSIDE the
// node process avoids fragile cross-step Pinokio variable capture and
// cross-shell `$(...)` substitution. Exits non-zero with a clear message when no
// release is published yet, or when the resolved release predates Pinokio support.

const REPO = 'dudarenok-maker/Castwright';
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const SEMVER_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

/**
 * Map a fetch outcome to a resolution decision. Pure.
 * @param {{status:number, body:any}} outcome
 * @returns {{kind:'tag', tag:string} | {kind:'none'} | {kind:'fallback'}}
 */
function latestReleaseTag(outcome) {
  if (outcome.status === 200 && outcome.body && typeof outcome.body.tag_name === 'string') {
    return { kind: 'tag', tag: outcome.body.tag_name };
  }
  if (outcome.status === 404) return { kind: 'none' };
  return { kind: 'fallback' };
}

/**
 * Highest vX.Y.Z tag from a list, or null. Pure.
 * @param {string[]} tagNames
 * @returns {string|null}
 */
function highestSemverTag(tagNames) {
  const parsed = tagNames
    .map((name) => {
      const m = SEMVER_TAG.exec(name);
      return m ? { name, parts: [Number(m[1]), Number(m[2]), Number(m[3])] } : null;
    })
    .filter(Boolean);
  if (parsed.length === 0) return null;
  parsed.sort(
    (a, b) => b.parts[0] - a.parts[0] || b.parts[1] - a.parts[1] || b.parts[2] - a.parts[2],
  );
  return parsed[0].name;
}

module.exports = { latestReleaseTag, highestSemverTag };

// ---- CLI (acceptance-tested, not unit-tested) ----
const { execFileSync } = require('node:child_process');
const { existsSync, readdirSync, unlinkSync } = require('node:fs');
const path = require('node:path');
// #2216 — scripts/git-env.mjs is ESM; this file is CommonJS
// ("type": "commonjs" in pinokio-scripts/package.json). `require()` of an
// ESM module is supported unflagged since Node 22.12 (this repo's engines
// floor is >=22.22.0, and Pinokio's installer conda-installs nodejs=24), so
// this requires the ESM file directly rather than duplicating
// GIT_ENV_SCRUB_KEYS into a second, CommonJS-only copy that could drift from
// the original. This file always runs from inside a full checkout of this
// repo (resolveTag()/main() below assume `scripts/` and other repo files
// exist relative to cwd), so the relative path is safe.
const { scrubGitEnv } = require(path.join(__dirname, '..', '..', 'scripts', 'git-env.mjs'));

/** Resolve the tag to check out: API → published tag, 404 → exit, error → local fallback. */
async function resolveTag() {
  let outcome = { status: 0, body: null };
  try {
    const res = await fetch(LATEST_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'castwright-pinokio' },
    });
    outcome = { status: res.status, body: res.status === 200 ? await res.json() : null };
  } catch {
    outcome = { status: 0, body: null };
  }
  const decision = latestReleaseTag(outcome);
  if (decision.kind === 'tag') return decision.tag;
  if (decision.kind === 'none') {
    process.stderr.write(
      'No published Castwright release found yet. A Pinokio install requires at least ' +
        'one published GitHub release. Please try again once a release is available.\n',
    );
    process.exit(2);
  }
  // fallback: highest local git tag
  const tags = execFileSync('git', ['tag', '--list'], {
    encoding: 'utf8',
    env: scrubGitEnv(),
    windowsHide: true,
  })
    .split('\n')
    .map((t) => t.trim())
    .filter(Boolean);
  const best = highestSemverTag(tags);
  if (!best) {
    process.stderr.write(
      'GitHub Releases API unreachable and no local vX.Y.Z tag to fall back to.\n',
    );
    process.exit(3);
  }
  process.stderr.write(`[resolve-release] API unreachable; falling back to local tag ${best}\n`);
  return best;
}

const REQUIREMENTS_DIR = path.join('server', 'tts-sidecar', 'requirements');

/**
 * Force a fresh re-checkout of server/tts-sidecar/requirements/*.txt from the
 * index. `git checkout <tag>` alone is a no-op for these files on a clone
 * whose working tree already has stale CRLF bytes: text=auto's clean filter
 * normalizes CRLF->LF before comparing to the LF blob, so git considers the
 * file unchanged and never rewrites it on disk (see .gitattributes and
 * #2588 pass-2/#2596). Deleting the files first removes that "unchanged"
 * comparison target, so the following checkout re-materializes them from the
 * index using the .gitattributes eol=lf pin. Scoped to REQUIREMENTS_DIR so it
 * cannot touch anything else in the tree.
 * @param {string} [cwd]
 */
function renormalizeRequirementsCrlf(cwd = process.cwd()) {
  const dir = path.join(cwd, REQUIREMENTS_DIR);
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.txt')) unlinkSync(path.join(dir, name));
  }
  execFileSync('git', ['checkout', '--', REQUIREMENTS_DIR], {
    cwd,
    stdio: 'inherit',
    env: scrubGitEnv(),
    windowsHide: true,
  });
}

module.exports.renormalizeRequirementsCrlf = renormalizeRequirementsCrlf;

async function main() {
  execFileSync('git', ['fetch', '--tags', '--force'], {
    stdio: 'inherit',
    env: scrubGitEnv(),
    windowsHide: true,
  });
  const tag = await resolveTag();
  process.stderr.write(`[resolve-release] checking out ${tag}\n`);
  execFileSync('git', ['checkout', tag], {
    stdio: 'inherit',
    env: scrubGitEnv(),
    windowsHide: true,
  });
  renormalizeRequirementsCrlf();
  // Guard against a release that predates Pinokio support: git checkout to such a
  // tag would DELETE pinokio-scripts/ from the tree, breaking Start/Stop/Update.
  if (!existsSync('pinokio-scripts/start.js')) {
    process.stderr.write(
      `[resolve-release] release ${tag} predates Pinokio support (pinokio-scripts/ scripts absent ` +
        `after checkout). Update Pinokio or wait for the next release that includes them.\n`,
    );
    process.exit(4);
  }
  process.stdout.write(tag);
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`[resolve-release] ${e.message}\n`);
    process.exit(1);
  });
}
