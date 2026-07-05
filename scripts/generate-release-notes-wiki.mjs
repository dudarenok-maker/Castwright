// Pulls every non-draft GitHub Release's body verbatim into docs/wiki/ as one
// page per version, plus a regenerated index page and _Sidebar.md section.
// Separate from sync-wiki.mjs (which just mirrors docs/wiki -> the wiki repo)
// because this one talks to the GitHub Releases API instead of git.
//
//   npm run wiki:release-notes
//
// Run manually after cutting a release (see CONTRIBUTING.md "Releasing"),
// then `npm run wiki:sync` to publish docs/wiki -> the wiki repo.
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCommand } from './lib/run-command.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const WIKI_DIR = path.join(REPO_ROOT, 'docs', 'wiki');
const REPO_SLUG = 'dudarenok-maker/Castwright';
// Only matches pages this script itself generates (Release-Notes-v1.2.3.md
// etc.) — deliberately narrower than "any Release-Notes-*.md" so a future
// hand-authored page (e.g. Release-Notes-FAQ.md) in that namespace survives
// the stale-page sweep below instead of being silently deleted.
export const RELEASE_PAGE_RE = /^Release-Notes-v\d[\w.-]*\.md$/;

export function releasePageFilename(tagName) {
  return `Release-Notes-${tagName}.md`;
}

export function formatDate(iso) {
  return iso.slice(0, 10);
}

// No leading H1 here: GitHub's wiki UI already renders a page-title header
// derived from the filename, and the release body itself often carries its
// own "# Castwright X.Y.Z" H1 — a template header here stacked a third,
// redundant heading on top of both.
export function renderReleasePage({ tagName, publishedAt, body }) {
  const url = `https://github.com/${REPO_SLUG}/releases/tag/${tagName}`;
  return `Released ${formatDate(publishedAt)}. [View on GitHub](${url}).

---

${reflowHardWrappedMarkdown(body.trim())}
`;
}

// Older release bodies were hand-wrapped at ~70-80 columns (a soft-break
// newline mid-paragraph or mid-list-item). GitHub's Releases page reflows
// that back into normal paragraphs, but the wiki renders each wrapped line
// as its own visible line — joins wrapped continuation lines back into one
// logical line per paragraph/list-item/blockquote. Code fences, headings,
// list-item start lines, table rows, and horizontal rules pass through
// untouched; blank lines reset the joining. A no-op on already-unwrapped
// bodies (nothing to join), so safe to apply uniformly to every release.
export function reflowHardWrappedMarkdown(markdown) {
  // Some fetched release bodies use CRLF. A trailing \r defeats the
  // blockquote regex's `(.*)$` anchor below (`.` excludes line terminators,
  // so it can never reach `$` past a stray \r) — the match then silently
  // fails and falls through to the plain-paragraph join path, which leaks a
  // literal "> " into the joined text instead of stripping it. Normalize
  // once up front so every check below works on a single line-ending style.
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inFence = false;
  let inComment = false;
  let mode = null; // null | 'listItem' | 'para' | 'blockquote'

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      out.push(line);
      inFence = !inFence;
      mode = null;
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    if (inComment) {
      out.push(line);
      if (line.includes('-->')) inComment = false;
      continue;
    }
    if (line.includes('<!--')) {
      out.push(line);
      if (!line.includes('-->')) inComment = true;
      mode = null;
      continue;
    }
    if (line.trim() === '') {
      out.push(line);
      mode = null;
      continue;
    }
    if (
      /^#{1,6}\s/.test(line) ||
      /^\s*(\*\*\*+|---+|___+|===+)\s*$/.test(line) ||
      /^\s*\|/.test(line)
    ) {
      out.push(line);
      mode = null;
      continue;
    }
    // A 4+ space indent is CommonMark's indented-code-block trigger — never
    // reflow it (this project's list-item continuations only ever use a
    // 2-space hanging indent, so this can't misfire on real content here).
    if (/^ {4,}\S/.test(line)) {
      out.push(line);
      mode = null;
      continue;
    }

    const blockquoteMatch = line.match(/^>\s?(.*)$/);
    if (blockquoteMatch) {
      const content = blockquoteMatch[1].trim();
      if (content === '') {
        // A bare "> " line is a paragraph break *within* the blockquote —
        // not continuable content, so it must reset mode like a blank line
        // does, or the next quoted paragraph would silently merge into
        // this one and lose its own "> " marker.
        out.push(line);
        mode = null;
        continue;
      }
      if (mode === 'blockquote' && out.length) {
        out[out.length - 1] = `${out[out.length - 1]} ${content}`;
      } else {
        out.push(line);
        mode = 'blockquote';
      }
      continue;
    }

    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      out.push(line);
      mode = 'listItem';
      continue;
    }

    // Lazy continuation: a plain-text line directly under a list item (no
    // blank line) is CommonMark/GFM's own lazy-continuation rule — it
    // already renders as part of that item's paragraph, so joining it here
    // matches, not changes, real rendering.
    if ((mode === 'listItem' || mode === 'para') && out.length) {
      out[out.length - 1] = `${out[out.length - 1]} ${line.trim()}`;
      mode = 'para';
    } else {
      out.push(line.trim());
      mode = 'para';
    }
  }
  return out.join('\n');
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
  const joined = merged.join('\n');
  // When the replaced section is last in the file (no `after`), `merged`
  // has no trailing "" element to preserve a final newline — add one so
  // re-running this against its own prior output stays idempotent.
  return joined.endsWith('\n') ? joined : `${joined}\n`;
}

function run(cmd, args) {
  return runCommand('generate-release-notes-wiki', cmd, args);
}

// Newest-first; equal timestamps sort as equal (ties keep gh's own
// already-newest-first list order, since Array#sort is stable) rather than
// arbitrarily flipping depending on comparator-call order.
export function compareReleasesNewestFirst(a, b) {
  if (a.publishedAt === b.publishedAt) return 0;
  return a.publishedAt < b.publishedAt ? 1 : -1;
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
    .sort(compareReleasesNewestFirst);
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
