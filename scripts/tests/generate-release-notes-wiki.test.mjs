import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDate,
  releasePageFilename,
  renderReleasePage,
  renderIndexPage,
  upsertSidebarSection,
  compareReleasesNewestFirst,
  RELEASE_PAGE_RE,
} from '../generate-release-notes-wiki.mjs';

test('formatDate truncates an ISO timestamp to YYYY-MM-DD', () => {
  assert.equal(formatDate('2026-07-04T00:23:51Z'), '2026-07-04');
});

test('releasePageFilename embeds the tag verbatim', () => {
  assert.equal(releasePageFilename('v1.10.0'), 'Release-Notes-v1.10.0.md');
});

test('renderReleasePage embeds the tag, date, GitHub link, and verbatim body', () => {
  const page = renderReleasePage({
    tagName: 'v1.10.0',
    publishedAt: '2026-07-04T00:23:51Z',
    body: 'Some **release** body.\n',
  });
  assert.match(page, /^Released 2026-07-04/);
  assert.doesNotMatch(page, /^# /);
  assert.match(
    page,
    /\[View on GitHub\]\(https:\/\/github\.com\/dudarenok-maker\/Castwright\/releases\/tag\/v1\.10\.0\)/,
  );
  assert.match(page, /Some \*\*release\*\* body\./);
});

test('renderIndexPage lists every release newest-first with a date and links RELEASE_NOTES.md', () => {
  const index = renderIndexPage([
    { tagName: 'v1.10.0', publishedAt: '2026-07-04T00:23:51Z' },
    { tagName: 'v1.9.0', publishedAt: '2026-06-20T22:15:54Z' },
  ]);
  assert.match(index, /- \[v1\.10\.0\]\(Release-Notes-v1\.10\.0\) — 2026-07-04/);
  assert.match(index, /- \[v1\.9\.0\]\(Release-Notes-v1\.9\.0\) — 2026-06-20/);
  assert.match(index, /RELEASE_NOTES\.md/);
  // Preserves caller-supplied order rather than re-sorting.
  assert.ok(index.indexOf('v1.10.0') < index.indexOf('v1.9.0'));
});

test('upsertSidebarSection replaces an existing section in place', () => {
  const sidebar = [
    '### Core journey',
    '- [Home](Home)',
    '',
    '### Release Notes',
    '- [stale link](Stale)',
    '',
    '### Full breadth',
    '- [Voice Engines](Voice-Engines)',
    '',
  ].join('\n');

  const updated = upsertSidebarSection(sidebar, 'Release Notes', [
    '- [All releases](Release-Notes)',
    '- [v1.10.0](Release-Notes-v1.10.0)',
  ]);

  assert.match(updated, /### Core journey\n- \[Home\]\(Home\)/);
  assert.match(updated, /### Release Notes\n- \[All releases\]\(Release-Notes\)\n- \[v1\.10\.0\]\(Release-Notes-v1\.10\.0\)/);
  assert.doesNotMatch(updated, /Stale/);
  assert.match(updated, /### Full breadth\n- \[Voice Engines\]\(Voice-Engines\)/);
});

test('upsertSidebarSection appends a new section at the end when absent', () => {
  const sidebar = ['### Full breadth', '- [Voice Engines](Voice-Engines)', ''].join('\n');

  const updated = upsertSidebarSection(sidebar, 'Release Notes', [
    '- [All releases](Release-Notes)',
  ]);

  assert.match(updated, /### Full breadth\n- \[Voice Engines\]\(Voice-Engines\)/);
  assert.match(updated, /### Release Notes\n- \[All releases\]\(Release-Notes\)\n$/);
});

test('upsertSidebarSection handles a section that runs to end-of-file (no trailing section)', () => {
  const sidebar = ['### Release Notes', '- [old](Old)'].join('\n');

  const updated = upsertSidebarSection(sidebar, 'Release Notes', ['- [new](New)']);

  assert.equal(updated.trim(), '### Release Notes\n- [new](New)');
});

test('upsertSidebarSection does not collapse a pre-existing double-blank-line elsewhere in the file', () => {
  const sidebar = [
    '### Core journey',
    '- [Home](Home)',
    '',
    '',
    '### Release Notes',
    '- [stale link](Stale)',
    '',
    '### Full breadth',
    '- [Voice Engines](Voice-Engines)',
    '',
  ].join('\n');

  const updated = upsertSidebarSection(sidebar, 'Release Notes', ['- [new](New)']);

  // The intentional double-blank between Core journey and Release Notes
  // (untouched, pre-existing content) survives — only the spliced section
  // itself is replaced.
  assert.match(updated, /- \[Home\]\(Home\)\n\n\n### Release Notes/);
});

test('upsertSidebarSection is idempotent (re-running against its own output is a no-op) when the section is last in the file', () => {
  const sidebar = ['### Full breadth', '- [Voice Engines](Voice-Engines)', ''].join('\n');
  const bodyLines = ['- [All releases](Release-Notes)', '- [v1.10.0](Release-Notes-v1.10.0)'];

  const first = upsertSidebarSection(sidebar, 'Release Notes', bodyLines);
  const second = upsertSidebarSection(first, 'Release Notes', bodyLines);

  assert.equal(second, first);
  assert.ok(first.endsWith('\n'), 'result should end with a trailing newline');
});

test('RELEASE_PAGE_RE matches generated version pages but not hand-authored ones sharing the prefix', () => {
  assert.match('Release-Notes-v1.10.0.md', RELEASE_PAGE_RE);
  assert.match('Release-Notes-v1.2.2.md', RELEASE_PAGE_RE);
  assert.doesNotMatch('Release-Notes-FAQ.md', RELEASE_PAGE_RE);
  assert.doesNotMatch('Release-Notes.md', RELEASE_PAGE_RE);
});

test('compareReleasesNewestFirst sorts newest-first and is antisymmetric on ties', () => {
  const a = { tagName: 'v1.1.0', publishedAt: '2026-05-17T22:36:24Z' };
  const b = { tagName: 'v1.0.0', publishedAt: '2026-05-17T05:02:16Z' };
  assert.equal(compareReleasesNewestFirst(a, b), -1);
  assert.equal(compareReleasesNewestFirst(b, a), 1);

  const tie1 = { tagName: 'v1.0.0', publishedAt: '2026-05-17T05:02:16Z' };
  const tie2 = { tagName: 'v1.0.1', publishedAt: '2026-05-17T05:02:16Z' };
  assert.equal(compareReleasesNewestFirst(tie1, tie2), 0);
  assert.equal(compareReleasesNewestFirst(tie2, tie1), 0);
});
