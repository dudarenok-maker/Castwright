/* Plan 276 (fs-cast-readiness) — browser-level regression net for the
 * cast-time clone-readiness gate: `src/modals/clone-readiness-gate.tsx` +
 * its entry condition in `src/store/start-generation-flow.ts`.
 *
 * Mock-mode constraint, verified against `src/lib/api.ts` while writing this
 * spec: `mockCloneVoice` ALWAYS stamps `engines.qwen.status = 'ready'` and
 * ALWAYS fills a non-blank `master.transcript` (falling back to a canned
 * Whisper string when none is supplied), and no exported mock mutator
 * (`mockPatchVoiceLibrary`, `mockRetryCloneEngine`, `mockAssignLibraryVoice`)
 * can ever move a slot's status to `'failed'` or back to "never derived" —
 * see plan 276's own "Mock mirror" note: "None of MOCK_VOICE_LIBRARY_ENTRIES
 * carries a `failed` engine slot ... no public mock API can create one."
 * That rules out `derive-failed` here entirely, and it also rules out
 * driving a genuine "never derived" `no-transcript` state through the real
 * clone-capture UI or any public mock endpoint.
 *
 * `no-transcript` is reached anyway, via a NEW test-only hook added for this
 * spec: `window.__mockVoiceLibrary.overrideEntry(voiceUuid, patch)`
 * (`_overrideMockVoiceLibraryEntry` in src/lib/api.ts, wired from
 * src/main.tsx under the same DEV/e2e gate as the existing `__mockQueue`
 * hook). It merges `patch` onto the REAL `lib-cloned-demo` entry IN the mock
 * backing store — not a redux-only simulation — so `fetchVoiceLibrary()`'s
 * real (un-intercepted) round trip reports it as never-derived on Qwen
 * (`engines` has no `qwen` key) with a blank `master.transcript`, and the
 * "Add transcript" CTA's later PATCH still lands on a real, still-tracked
 * entry. (An earlier version of this spec tried to intercept
 * `store.dispatch` from Playwright instead: it doesn't work, because
 * `startGenerationFlow`'s internal `dispatch(fetchVoiceLibrary())` call
 * closes over the dispatch reference redux-thunk was composed with at
 * store-creation time, not a live re-read of `store.dispatch` — reassigning
 * the property is invisible to it. Recorded here so nobody retries it.)
 *
 * `derive-failed` ("Retry derive") is NOT exercised in this spec — see the
 * constraint above. Recorded in the on-box acceptance register rather than
 * faked with a new `failed`-slot fixture, which would also shift
 * `e2e/voice-library.spec.ts`'s hardcoded voice-card counts (6/7/8/9).
 *
 * Controls (not optional — plan 276's own test-plan note: steps 1-5 alone
 * pass against a check that always warns):
 *   A. The same broken-qwen cast, routed to Coqui instead of Qwen -> NO gate
 *      (the check is engine-aware, not a blanket "this voice is broken").
 *   B. A healthy cloned voice with BOTH cast slots present (clip + transcript
 *      intact) on a Coqui-routed character -> NO gate (rule 8 silence),
 *      reached through the real, un-intercepted mock fixture. */

import { test, expect, type Page } from '@playwright/test';
import {
  goToConfirm,
  confirmCastAndReachManuscript,
  waitForRouteReady,
  confirmTierPromptIfPresent,
} from './helpers';

const CLONE_LIBRARY_UUID = 'lib-cloned-demo';
const TEST_CHARACTER_ID = 'halloran';
const TEST_CHARACTER_NAME = 'Captain Halloran';

/* Deterministic ready-signal, mirroring e2e/start-generation-tier-prompt.spec.ts's
   own waitForQwenCastHydrated: `cast.characters` is `[]` on a cold route mount
   (documented there and in plan 276 Decision 5's "known bypasses"), so poll for
   Eliza's fixed `ttsEngine: 'qwen'` rather than racing the implicit hydration
   timing. */
async function waitForCastHydrated(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const store = (window as unknown as { __store__?: { getState(): unknown } }).__store__;
          if (!store) return false;
          const cast = (store.getState() as { cast: { characters: Array<{ ttsEngine?: string }> } })
            .cast;
          return (cast.characters ?? []).some((c) => c.ttsEngine === 'qwen');
        }),
      { timeout: 10_000 },
    )
    .toBe(true);
}

/* Gives the fixed `halloran` cast member (no ttsEngine of its own by default
   — see src/data/characters.ts) BOTH clone-capable cast slots pointing at the
   real `lib-cloned-demo` library entry, mirroring "#1933's /assign writes
   BOTH engine slots for every cloned entry" (plan 276's own "The problem"
   section). `ttsEngine` is set only when the caller passes one; omitting it
   lets the character ride the session default (`ui.ttsModelKey`), which is
   what "switch the session engine" (Control A/B) needs to actually change
   this character's routed engine. */
async function setClonedCastSlot(page: Page, ttsEngine?: 'qwen' | 'coqui'): Promise<void> {
  await page.evaluate(
    ({ characterId, libraryUuid, ttsEngine }) => {
      const store = (
        window as unknown as { __store__: { getState(): unknown; dispatch(a: unknown): void } }
      ).__store__;
      const state = store.getState() as { cast: { characters: Array<Record<string, unknown>> } };
      const next = state.cast.characters.map((c) => {
        if (c.id !== characterId) return c;
        const updated: Record<string, unknown> = {
          ...c,
          overrideTtsVoices: {
            qwen: { name: `qwen-${libraryUuid}`, libraryUuid, provenance: 'cloned' },
            coqui: { name: `xtts-${libraryUuid}`, libraryUuid, provenance: 'cloned' },
          },
        };
        if (ttsEngine) updated.ttsEngine = ttsEngine;
        else delete updated.ttsEngine;
        return updated;
      });
      store.dispatch({ type: 'cast/setCharacters', payload: next });
    },
    { characterId: TEST_CHARACTER_ID, libraryUuid: CLONE_LIBRARY_UUID, ttsEngine },
  );
  await expect
    .poll(() =>
      page.evaluate(
        ({ characterId }) => {
          const store = (window as unknown as { __store__: { getState(): unknown } }).__store__;
          const chars = (
            store.getState() as {
              cast: {
                characters: Array<{ id: string; overrideTtsVoices?: { qwen?: { libraryUuid?: string } } }>;
              };
            }
          ).cast.characters;
          return chars.find((c) => c.id === characterId)?.overrideTtsVoices?.qwen?.libraryUuid;
        },
        { characterId: TEST_CHARACTER_ID },
      ),
    )
    .toBe(CLONE_LIBRARY_UUID);
}

/* `unresolvable-uuid` (#2054) needs no mock-backend fixture at all — it is a
   property of the CHARACTER's own cast slot (a missing/empty libraryUuid),
   never looked up against the voice-library entry, so it is reachable here
   exactly like `setClonedCastSlot` above, just with the uuid blanked out. */
async function setClonedCastSlotWithUnresolvableUuid(page: Page, ttsEngine?: 'qwen' | 'coqui'): Promise<void> {
  await page.evaluate(
    ({ characterId, ttsEngine }) => {
      const store = (
        window as unknown as { __store__: { getState(): unknown; dispatch(a: unknown): void } }
      ).__store__;
      const state = store.getState() as { cast: { characters: Array<Record<string, unknown>> } };
      const next = state.cast.characters.map((c) => {
        if (c.id !== characterId) return c;
        const updated: Record<string, unknown> = {
          ...c,
          overrideTtsVoices: {
            qwen: { name: 'broken-uuid-voice', libraryUuid: '', provenance: 'cloned' },
          },
        };
        if (ttsEngine) updated.ttsEngine = ttsEngine;
        else delete updated.ttsEngine;
        return updated;
      });
      store.dispatch({ type: 'cast/setCharacters', payload: next });
    },
    { characterId: TEST_CHARACTER_ID, ttsEngine },
  );
  await expect
    .poll(() =>
      page.evaluate(
        ({ characterId }) => {
          const store = (window as unknown as { __store__: { getState(): unknown } }).__store__;
          const chars = (
            store.getState() as {
              cast: { characters: Array<{ id: string; overrideTtsVoices?: { qwen?: { name?: string } } }> };
            }
          ).cast.characters;
          return chars.find((c) => c.id === characterId)?.overrideTtsVoices?.qwen?.name;
        },
        { characterId: TEST_CHARACTER_ID },
      ),
    )
    .toBe('broken-uuid-voice');
}

async function setSessionModelKey(page: Page, modelKey: string): Promise<void> {
  await page.evaluate((modelKey) => {
    const store = (window as unknown as { __store__: { dispatch(a: unknown): void } }).__store__;
    store.dispatch({ type: 'ui/setTtsModelKey', payload: modelKey });
  }, modelKey);
}

/* Forces `lib-cloned-demo` (the REAL mock fixture, in place) into a
   never-derived-on-Qwen state with a blank transcript — while Coqui
   (`xtts`) stays genuinely ready — mirroring the walkthrough's "ingested a
   clip without a transcript, assigned while on Coqui" starting state. Uses
   the `window.__mockVoiceLibrary` test hook (see the module doc comment
   above) rather than touching redux, so every `fetchVoiceLibrary()` call —
   including the second "Approve cast" pass, after the "Add transcript" CTA's
   PATCH has fixed the entry — reads this same real backing store. */
async function primeNeverDerivedQwenSlot(page: Page): Promise<void> {
  await page.evaluate((libraryUuid) => {
    const hook = (
      window as unknown as {
        __mockVoiceLibrary: { overrideEntry(uuid: string, patch: Record<string, unknown>): void };
      }
    ).__mockVoiceLibrary;
    hook.overrideEntry(libraryUuid, {
      master: {
        clipFile: 'master.wav',
        sampleRate: 24_000,
        durationSeconds: 12,
        transcript: '',
        transcriptSource: 'whisper',
        captureMethod: 'record',
      },
      engines: { xtts: { status: 'ready', coquiVersion: '0.27.2' } },
    });
  }, CLONE_LIBRARY_UUID);
}

async function goToManuscript(page: Page): Promise<void> {
  await goToConfirm(page);
  await confirmCastAndReachManuscript(page);
  await waitForRouteReady(page);
  await waitForCastHydrated(page);
}

async function clickApproveCast(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Approve cast.*start generating/i }).click();
  await expect(page).toHaveURL(/#\/books\/.+\/generate/, { timeout: 5_000 });
}

test.describe('Plan 276 — cast-time clone-readiness gate', () => {
  test('no-transcript: names character/engine/reason, Add transcript clears it, a second pass starts generation', async ({
    page,
  }) => {
    await goToManuscript(page);
    await setClonedCastSlot(page, 'qwen');
    await primeNeverDerivedQwenSlot(page);

    await clickApproveCast(page);

    const gate = page.getByTestId('clone-readiness-gate');
    await expect(gate).toBeVisible({ timeout: 5_000 });
    const row = page.getByTestId(`clone-readiness-row-${TEST_CHARACTER_ID}`);
    await expect(row).toBeVisible();
    await expect(row.getByText(TEST_CHARACTER_NAME, { exact: true })).toBeVisible();
    await expect(row.getByText('Qwen', { exact: true })).toBeVisible();
    await expect(row.getByText(/no reference transcript/i)).toBeVisible();

    await row.getByRole('button', { name: 'Add transcript' }).click();
    await row.locator('textarea[aria-label="transcript"]').fill('A recorded reference line for Mum.');
    await row.getByRole('button', { name: 'Save transcript' }).click();

    /* The fix landed — this character's row drops out of the (still open)
       gate. */
    await expect(row).toBeHidden({ timeout: 5_000 });
    await gate.getByRole('button', { name: 'Cancel' }).click();
    await expect(gate).toBeHidden();

    /* Second pass: back to the manuscript view, click the same CTA again.
       The interceptor already restored itself, so this fetch reads the
       REAL (now-patched) backing store. */
    await page.getByRole('button', { name: 'Manuscript', exact: true }).click();
    await expect(page).toHaveURL(/#\/books\/.+\/manuscript/, { timeout: 5_000 });
    await waitForRouteReady(page);

    await clickApproveCast(page);
    await expect(gate).toBeHidden();
    /* Eliza's fixed ttsEngine: 'qwen' means every run still opens the
       voice-model tier prompt once the clone gate has nothing to say —
       confirm it (same helper the tier-prompt spec uses) so generation
       actually starts. */
    await confirmTierPromptIfPresent(page);
    await expect(page.locator('span', { hasText: /^Generating$/ }).first()).toBeVisible({
      timeout: 20_000,
    });
  });

  test('Control A: the same broken-Qwen cast produces NO gate once routed to Coqui', async ({ page }) => {
    await goToManuscript(page);
    await setClonedCastSlot(page); // no per-character ttsEngine -> rides the session default
    await setSessionModelKey(page, 'coqui-xtts-v2');
    await primeNeverDerivedQwenSlot(page); // same broken Qwen slot as the main-path test

    await clickApproveCast(page);
    await confirmTierPromptIfPresent(page);

    await expect(page.getByTestId('clone-readiness-gate')).toBeHidden();
    await expect(page.locator('span', { hasText: /^Generating$/ }).first()).toBeVisible({
      timeout: 20_000,
    });
  });

  test('unresolvable-uuid: names character/engine/reason, offers "Assign a different voice"', async ({
    page,
  }) => {
    await goToManuscript(page);
    await setClonedCastSlotWithUnresolvableUuid(page, 'qwen');

    await clickApproveCast(page);

    const gate = page.getByTestId('clone-readiness-gate');
    await expect(gate).toBeVisible({ timeout: 5_000 });
    const row = page.getByTestId(`clone-readiness-row-${TEST_CHARACTER_ID}`);
    await expect(row).toBeVisible();
    await expect(row.getByText(TEST_CHARACTER_NAME, { exact: true })).toBeVisible();
    await expect(row.getByText('Qwen', { exact: true })).toBeVisible();
    await expect(row.getByText(/doesn.t specify which voice to use/i)).toBeVisible();
    await expect(row.getByRole('button', { name: 'Assign a different voice' })).toBeVisible();
  });

  test('Control B: a healthy cloned voice with both cast slots stays silent on its Coqui-routed character', async ({
    page,
  }) => {
    await goToManuscript(page);
    await setClonedCastSlot(page); // no per-character ttsEngine -> rides the session default
    await setSessionModelKey(page, 'coqui-xtts-v2');
    /* No interceptor here — `lib-cloned-demo` reaches the client exactly as
       the real (un-intercepted) mock fixture defines it: qwen AND xtts both
       `ready`, transcript `'demo'`. Rule 8 silence. */

    await clickApproveCast(page);
    await confirmTierPromptIfPresent(page);

    await expect(page.getByTestId('clone-readiness-gate')).toBeHidden();
    await expect(page.locator('span', { hasText: /^Generating$/ }).first()).toBeVisible({
      timeout: 20_000,
    });
  });
});
