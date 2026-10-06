import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import {
  USER_SETTINGS_PATH,
  _resetUserSettingsCache,
  acknowledgeDroppedEndpointEntries,
  droppedEndpointEntriesAcknowledgedPath,
  invalidEndpointsArchivePath,
  listDroppedEndpointEntries,
  readUserSettings,
} from './user-settings.js';

const ARCHIVE = invalidEndpointsArchivePath();
const ACK = droppedEndpointEntriesAcknowledgedPath();

beforeEach(() => {
  if (existsSync(USER_SETTINGS_PATH)) rmSync(USER_SETTINGS_PATH, { force: true });
  rmSync(ARCHIVE, { force: true, recursive: true });
  rmSync(ACK, { force: true, recursive: true });
  _resetUserSettingsCache();
});
afterAll(() => {
  if (existsSync(USER_SETTINGS_PATH)) rmSync(USER_SETTINGS_PATH, { force: true });
  rmSync(ARCHIVE, { force: true, recursive: true });
  rmSync(ACK, { force: true, recursive: true });
  _resetUserSettingsCache();
});

async function quietly(body: () => Promise<void>): Promise<void> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await body();
  } finally {
    warn.mockRestore();
  }
}

describe('listDroppedEndpointEntries / acknowledgeDroppedEndpointEntries (#3084 F5)', () => {
  it('lists a dropped endpoint entry with a code, not a message, and never the rejected value', async () => {
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify({ analyzerEndpoints: [{ id: 'Bad_Id', name: 'Lab', baseUrl: 'not a url' }] }));
    _resetUserSettingsCache();
    await quietly(async () => {
      await readUserSettings();
      const [entry] = await listDroppedEndpointEntries();
      expect(entry).toMatchObject({ kind: 'endpoint', endpointId: 'Bad_Id', name: 'Lab' });
      expect(typeof entry.archiveId).toBe('string');
      /* zod 4.4.3 (server/package.json "zod": "^4", installed 4.4.3): a .url()
         failure is code "invalid_format" (message "Invalid URL"), not the zod-3
         "invalid_string" this test asserted before — review item 4. */
      expect(entry.issues.some((c) => c.endsWith(': invalid_format'))).toBe(true);
      /* No-echo: zod's own message never contains the submitted value either
         ("Invalid URL" names no URL), but assert on the submitted value's
         absence directly rather than on today's exact zod wording, which is
         not this test's contract to pin. */
      expect(entry.issues.join(' ')).not.toContain('not a url');
      expect(JSON.stringify(entry)).not.toContain('not a url');
    });
  });

  it('lists a dropped key entry with the origin only, never the key, and asserts its issues', async () => {
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify({ analyzerEndpointKeys: { lab: { origin: 99, key: 'sk-listed-secret-1' } } }));
    _resetUserSettingsCache();
    await quietly(async () => {
      await readUserSettings();
      const [entry] = await listDroppedEndpointEntries();
      expect(entry).toMatchObject({ kind: 'key', endpointId: 'lab' });
      expect(entry.origin).toBeUndefined(); // origin itself (99) failed its own schema check
      /* #3084 F5 review, item 8 (~6250) — this case previously asserted no
         issues content at all. `origin: 99` fails endpointKeyEntrySchema's
         `z.string()` check on `origin`, so the code names that field. */
      expect(entry.issues).toEqual(['origin: invalid_type']);
      expect(JSON.stringify(entry)).not.toContain('sk-listed-secret-1');
    });
  });

  it('a dropped key entry\'s archive line and the acknowledged-hashes sidecar hold no substring of the key, and no hash is computed over it (#3084 F5 review pass 2, item 2)', async () => {
    const KEY = 'sk-no-material-on-disk-secret-1';
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify({ analyzerEndpointKeys: { lab: { origin: 99, key: KEY } } }));
    _resetUserSettingsCache();
    await quietly(async () => {
      await readUserSettings();
      const [entry] = await listDroppedEndpointEntries();
      /* Not `droppedEntryContentHash(entry)` (the raw value, which holds KEY) —
         computed over the origin-only projection plus the endpoint id instead,
         so a hash of the raw key never exists anywhere, including in memory
         long enough to write it. Built the same way `canonicalStringify`
         would (sorted keys), so this genuinely matches what a raw-entry hash
         would put on disk if the mutation in Step 5's table were applied —
         not a string that merely looks plausible. */
      const wrongHash = createHash('sha256').update('{"key":' + JSON.stringify(KEY) + ',"origin":99}').digest('hex');
      const archiveText = readFileSync(ARCHIVE, 'utf8');
      expect(archiveText).not.toContain(KEY);
      expect(archiveText).not.toContain(wrongHash);
      await acknowledgeDroppedEndpointEntries([entry.archiveId as string]);
      const sidecarText = readFileSync(ACK, 'utf8');
      expect(sidecarText).not.toContain(KEY);
      expect(sidecarText).not.toContain(wrongHash);
      expect(await listDroppedEndpointEntries()).toEqual([]);
    });
  });

  it('acknowledgement is keyed on content hash, not on the archiveId that happens to be current, so it survives the archive being re-created with a fresh archiveId (#3084 F5 review pass 2, item 4)', async () => {
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify({ analyzerEndpoints: [{ id: 'Hashkey_Bad', name: 'H', baseUrl: 'nope' }] }));
    _resetUserSettingsCache();
    await quietly(async () => {
      await readUserSettings();
      const [first] = await listDroppedEndpointEntries();
      await acknowledgeDroppedEndpointEntries([first.archiveId as string]);
      expect(await listDroppedEndpointEntries()).toEqual([]);
      /* Delete the archive itself (not just reset the cache): the on-disk
         hash-dedupe (Task 3b.6, review item 5) has nothing left to match, so
         the next cold read re-archives the SAME entry under a BRAND NEW
         archiveId — exactly the case that distinguishes hash-keyed
         acknowledgement from id-keyed. Under id-keyed acknowledgement this
         entry would reappear here, because the id the sidecar remembers no
         longer names any current line. */
      rmSync(ARCHIVE, { force: true });
      _resetUserSettingsCache();
      await readUserSettings();
      const after = await listDroppedEndpointEntries();
      expect(after).toEqual([]);
      const onDiskNow = JSON.parse(readFileSync(ARCHIVE, 'utf8').trimEnd()) as { archiveId: string };
      expect(onDiskNow.archiveId).not.toBe(first.archiveId);
    });
  });

  it('an unarchived pending entry is listed with archiveId null', async () => {
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify({ analyzerEndpoints: [{ id: 'Pending_Bad', name: 'P', baseUrl: 'nope' }] }));
    mkdirSync(ARCHIVE);
    _resetUserSettingsCache();
    await quietly(async () => {
      await readUserSettings();
      const [entry] = await listDroppedEndpointEntries();
      expect(entry).toMatchObject({ archiveId: null, endpointId: 'Pending_Bad' });
    });
  });

  it('a name over 80 characters is capped in the summary (review item 10)', async () => {
    const longName = 'x'.repeat(200);
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify({ analyzerEndpoints: [{ id: 'Long_Name', name: longName, baseUrl: 'nope' }] }));
    _resetUserSettingsCache();
    await quietly(async () => {
      await readUserSettings();
      const [entry] = await listDroppedEndpointEntries();
      expect(entry.name).toHaveLength(80);
      expect(entry.name).toBe(longName.slice(0, 80));
    });
  });

  it('acknowledging an archiveId hides it, and it stays hidden across a simulated restart for the SAME unchanged entry, with no new archive line written (#3084 F5 review, item 5)', async () => {
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify({ analyzerEndpoints: [{ id: 'Ack_Bad', name: 'A', baseUrl: 'nope' }] }));
    _resetUserSettingsCache();
    await quietly(async () => {
      await readUserSettings();
      const [first] = await listDroppedEndpointEntries();
      await acknowledgeDroppedEndpointEntries([first.archiveId as string]);
      expect(await listDroppedEndpointEntries()).toEqual([]);
      const archiveLinesBefore = readFileSync(ARCHIVE, 'utf8').trimEnd().split('\n').length;
      /* Simulated restart: a cold cache re-reading the SAME on-disk settings
         file. Task 3b.6's per-process archivedDrops Set would be empty here
         (a real restart), so this is exactly the case item 5 fixes. */
      _resetUserSettingsCache();
      await readUserSettings();
      expect(await listDroppedEndpointEntries()).toEqual([]);
      const archiveLinesAfter = readFileSync(ARCHIVE, 'utf8').trimEnd().split('\n').length;
      expect(archiveLinesAfter).toBe(archiveLinesBefore); // no duplicate line for the same hash
    });
  });

  it('a MODIFIED bad entry (different content, same id) is listed again even after the original was acknowledged', async () => {
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify({ analyzerEndpoints: [{ id: 'Changed_Bad', name: 'Before', baseUrl: 'nope' }] }));
    _resetUserSettingsCache();
    await quietly(async () => {
      await readUserSettings();
      const [first] = await listDroppedEndpointEntries();
      await acknowledgeDroppedEndpointEntries([first.archiveId as string]);
      writeFileSync(USER_SETTINGS_PATH, JSON.stringify({ analyzerEndpoints: [{ id: 'Changed_Bad', name: 'After', baseUrl: 'still nope' }] }));
      _resetUserSettingsCache();
      await readUserSettings();
      const after = await listDroppedEndpointEntries();
      expect(after).toHaveLength(1);
      expect(after[0].name).toBe('After');
      expect(after[0].archiveId).not.toBe(first.archiveId);
    });
  });

  it('acknowledging twice keeps the first acknowledgement (union, not replace) (#3084 F5 review, item 8)', async () => {
    writeFileSync(
      USER_SETTINGS_PATH,
      JSON.stringify({
        analyzerEndpoints: [
          { id: 'Union_A', name: 'A', baseUrl: 'nope-a' },
          { id: 'Union_B', name: 'B', baseUrl: 'nope-b' },
        ],
      }),
    );
    _resetUserSettingsCache();
    await quietly(async () => {
      await readUserSettings();
      const [a, b] = await listDroppedEndpointEntries();
      await acknowledgeDroppedEndpointEntries([a.archiveId as string]);
      await acknowledgeDroppedEndpointEntries([b.archiveId as string]);
      expect(await listDroppedEndpointEntries()).toEqual([]);
    });
  });

  it('two concurrent acknowledge calls do not lose either one (serialised through writeChain, review item 6)', async () => {
    writeFileSync(
      USER_SETTINGS_PATH,
      JSON.stringify({
        analyzerEndpoints: [
          { id: 'Race_A', name: 'A', baseUrl: 'nope-a' },
          { id: 'Race_B', name: 'B', baseUrl: 'nope-b' },
        ],
      }),
    );
    _resetUserSettingsCache();
    await quietly(async () => {
      await readUserSettings();
      const [a, b] = await listDroppedEndpointEntries();
      await Promise.all([
        acknowledgeDroppedEndpointEntries([a.archiveId as string]),
        acknowledgeDroppedEndpointEntries([b.archiveId as string]),
      ]);
      expect(await listDroppedEndpointEntries()).toEqual([]);
    });
  });

  it('acknowledging an unknown or null archiveId is a no-op, not a refusal', async () => {
    await expect(acknowledgeDroppedEndpointEntries(['does-not-exist'])).resolves.toBeUndefined();
  });

  it('GET /api/user/settings exposes droppedEndpointEntries and refuses it on the general PUT', async () => {
    const { default: request } = await import('supertest');
    process.env.WORKSPACE_DIR = dirname(USER_SETTINGS_PATH);
    const [{ userSettingsRouter }] = await Promise.all([import('../routes/user-settings.js')]);
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use('/api/user/settings', userSettingsRouter);
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify({ analyzerEndpoints: [{ id: 'Route_Bad', name: 'R', baseUrl: 'nope' }] }));
    _resetUserSettingsCache();
    await quietly(async () => {
      const get = await request(app).get('/api/user/settings');
      expect(get.body.droppedEndpointEntries).toHaveLength(1);
      const put = await request(app).put('/api/user/settings').send({ droppedEndpointEntries: [] });
      expect(put.status).toBe(200);
      expect((await request(app).get('/api/user/settings')).body.droppedEndpointEntries).toHaveLength(1);
      /* The acknowledge route's malformed-body refusal matches every other
         refusal in this file: { error, code, issues }. */
      const bad = await request(app).post('/api/user/settings/dropped-endpoint-entries/acknowledge').send({ archiveIds: 'not-an-array' });
      expect(bad.status).toBe(400);
      expect(bad.body).toMatchObject({ error: 'Invalid payload.', code: 'invalid' });
      expect(bad.body.issues[0]).toMatchObject({ path: ['archiveIds'] });
    });
  });
});
