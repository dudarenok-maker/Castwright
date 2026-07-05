import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDate,
  releasePageFilename,
  renderReleasePage,
  renderIndexPage,
  upsertSidebarSection,
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
  assert.match(page, /^# Castwright v1\.10\.0/);
  assert.match(page, /Released 2026-07-04/);
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
