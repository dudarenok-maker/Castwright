// Pulls every non-draft GitHub Release's body verbatim into docs/wiki/ as one
// page per version, plus a regenerated index page and _Sidebar.md section.
// Separate from sync-wiki.mjs (which just mirrors docs/wiki -> the wiki repo)
// because this one talks to the GitHub Releases API instead of git.
//
//   npm run wiki:release-notes
//
// Run manually after cutting a release (see CONTRIBUTING.md "Releasing"),
// then `npm run wiki:sync` to publish docs/wiki -> the wiki repo.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const WIKI_DIR = path.join(REPO_ROOT, 'docs', 'wiki');
const REPO_SLUG = 'dudarenok-maker/Castwright';
const RELEASE_PAGE_RE = /^Release-Notes-.+\.md$/;

export function releasePageFilename(tagName) {
  return `Release-Notes-${tagName}.md`;
}

export function formatDate(iso) {
  return iso.slice(0, 10);
}

export function renderReleasePage({ tagName, publishedAt, body }) {
  const url = `https://github.com/${REPO_SLUG}/releases/tag/${tagName}`;
  return `# Castwright ${tagName}

Released ${formatDate(publishedAt)}. [View on GitHub](${url}).

---

${body.trim()}
`;
}

export function renderIndexPage(releases) {
  const rows = releases
    .map(
      (r) =>
        `- [${r.tagName}](${releasePageFilename(r.tagName).replace(/\.md$/, '')}) — ${formatDate(r.publishedAt)}`,
    )
    .join('\n');
  return `# Release Notes

Full, unabridged release notes for every shipped version — copied verbatim
from each version's GitHub Release. For the shorter, user-facing summary
surfaced in the app, see [RELEASE_NOTES.md](https://github.com/${REPO_SLUG}/blob/main/RELEASE_NOTES.md).

${rows}
`;
}

// Replaces the `### {heading}` section of a wiki sidebar (its heading line
// through the line before the next `### `, or EOF) with `bodyLines`. Appends
// a new section at EOF if the heading isn't present yet.
export function upsertSidebarSection(sidebarText, heading, bodyLines) {
  const headingLine = `### ${heading}`;
  const lines = sidebarText.split('\n');
  const startIdx = lines.findIndex((line) => line.trim() === headingLine);
  const newSection = [headingLine, ...bodyLines];

  if (startIdx === -1) {
    const trimmed = sidebarText.replace(/\n+$/, '');
    return `${trimmed}\n\n${newSection.join('\n')}\n`;
  }

  let endIdx = lines.findIndex((line, i) => i > startIdx && line.startsWith('### '));
  if (endIdx === -1) endIdx = lines.length;

  const before = lines.slice(0, startIdx);
  const after = lines.slice(endIdx);
  const merged = [...before, ...newSection, ...(after.length ? ['', ...after] : [])];
  return merged.join('\n').replace(/\n{3,}/g, '\n\n');
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`generate-release-notes-wiki: ${cmd} ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function fetchReleases() {
  const out = run('gh', [
    'release',
    'list',
    '--repo',
    REPO_SLUG,
    '--json',
    'tagName,publishedAt,isDraft',
    '--limit',
    '1000',
  ]);
  return JSON.parse(out)
    .filter((r) => !r.isDraft)
    .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
}

function fetchReleaseBody(tagName) {
  const out = run('gh', ['release', 'view', tagName, '--repo', REPO_SLUG, '--json', 'body']);
  return JSON.parse(out).body;
}

function main() {
  const releases = fetchReleases();

  const wanted = new Set(releases.map((r) => releasePageFilename(r.tagName)));
  for (const entry of readdirSync(WIKI_DIR)) {
    if (RELEASE_PAGE_RE.test(entry) && !wanted.has(entry)) {
      rmSync(path.join(WIKI_DIR, entry));
    }
  }

  for (const release of releases) {
    const body = fetchReleaseBody(release.tagName);
    const page = renderReleasePage({ ...release, body });
    writeFileSync(path.join(WIKI_DIR, releasePageFilename(release.tagName)), page);
  }

  writeFileSync(path.join(WIKI_DIR, 'Release-Notes.md'), renderIndexPage(releases));

  const sidebarPath = path.join(WIKI_DIR, '_Sidebar.md');
  const sidebarLines = [
    '- [All releases](Release-Notes)',
    ...releases.map((r) => `- [${r.tagName}](${releasePageFilename(r.tagName).replace(/\.md$/, '')})`),
  ];
  const sidebar = readFileSync(sidebarPath, 'utf8');
  writeFileSync(sidebarPath, upsertSidebarSection(sidebar, 'Release Notes', sidebarLines));

  process.stdout.write(
    `generate-release-notes-wiki: wrote ${releases.length} release page(s) + index + sidebar\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
