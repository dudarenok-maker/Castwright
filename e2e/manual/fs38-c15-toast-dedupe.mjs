// Manual real-server browser check for C-15 — cloned-voice-broken toast
// fires live, immediately, with a help link, and dedupes per chapter.
// Precondition (done via API before running this): the book's Narrator is
// cast to a REVOKED cloned voice (Broken) on both engine slots.
//
// This version assumes Chapter 1 may already be in a `failed` state from a
// prior run of this same script (idempotent: every attempt re-triggers a
// fresh generation attempt via the reason-picker dialog).
import { chromium } from 'playwright';

const BASE = 'https://localhost:5363';
const BOOK_ID = 'qa-throwaway__standalones__the-coalfall-commission';

function toastLocator(page) {
  return page.locator('[role="status"] p');
}

async function clearStartGates(page) {
  for (let i = 0; i < 3; i++) {
    await page.waitForTimeout(700);
    const proceedBtn = page.getByRole('button', { name: /Proceed anyway/i });
    if (await proceedBtn.isVisible().catch(() => false)) {
      console.log('  gate: Voice Readiness -> Proceed anyway');
      await proceedBtn.click();
      continue;
    }
    const startGenBtn = page.getByRole('button', { name: /Start generating/i });
    if (await startGenBtn.isVisible().catch(() => false)) {
      console.log('  gate: Choose voice model -> Start generating');
      await startGenBtn.click();
      continue;
    }
    break;
  }
}

async function submitRegenerateDialog(page) {
  await page.waitForTimeout(500);
  const dialogHeading = page.getByText('WHAT CHANGED?');
  if (!(await dialogHeading.isVisible().catch(() => false))) return false;
  await page.getByText('Quality issue — try again', { exact: true }).click();
  await page.waitForTimeout(200);
  const submitBtn = page.getByRole('button', { name: /^Regenerate$/ });
  await submitBtn.click();
  await clearStartGates(page);
  return true;
}

async function clickChapterRetryOrRegenerate(page, chapterLabel) {
  const row = page.locator('button', { hasText: chapterLabel }).first();
  await row.click();
  await page.waitForTimeout(500);
  const retryBtn = page.getByRole('button', { name: /Retry/ }).first();
  if (await retryBtn.isVisible().catch(() => false)) {
    await retryBtn.click();
    return submitRegenerateDialog(page);
  }
  const regenBtn = page.getByRole('button', { name: /Regenerate/i }).first();
  if (await regenBtn.isVisible().catch(() => false)) {
    await regenBtn.click();
    return submitRegenerateDialog(page);
  }
  const resumeBtn = page.getByRole('button', { name: /Resume generation/i });
  if (await resumeBtn.isVisible().catch(() => false)) {
    await resumeBtn.click();
    await clearStartGates(page);
    return true;
  }
  return false;
}

async function dismissAllToasts(page) {
  await page.evaluate(() => {
    document.querySelectorAll('[role="status"] button[aria-label="Dismiss notification"]').forEach((b) => b.click());
  });
  await page.waitForTimeout(400);
}

// Matches the specific cloned-voice-broken failure toast, ignoring unrelated
// toasts (e.g. the generic "Added to queue" notice fired when a shared
// queue is busy with other concurrent work on this box).
async function waitForFailureToast(page, maxMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const texts = await toastLocator(page).allTextContents().catch(() => []);
    const match = texts.filter((t) => /failed|Cloned voice/i.test(t));
    if (match.length > 0) return { texts: match, allTexts: texts, elapsedMs: Date.now() - t0 };
    await page.waitForTimeout(300);
  }
  return { texts: [], allTexts: [], elapsedMs: Date.now() - t0 };
}

async function main() {
  // Guard: ensure we're only running against a throwaway book, not real user data.
  // The script fires real chapter regenerations and expects them to fail.
  if (!BOOK_ID.includes('qa-throwaway')) {
    console.error(`FATAL: BOOK_ID does not contain 'qa-throwaway' — refusing to run against non-throwaway book. Got: ${BOOK_ID}`);
    process.exit(1);
  }

  const browser = await chromium.launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  await page.goto(`${BASE}/#/books/${BOOK_ID}/generate`);
  await page.waitForTimeout(2500);

  console.log('=== ATTEMPT 1: Chapter 1 (first failure in this run) ===');
  await dismissAllToasts(page);
  const t0 = Date.now();
  const ok1 = await clickChapterRetryOrRegenerate(page, 'Chapter 1');
  console.log('attempt1 dialog handled=', ok1);
  if (!ok1) {
    console.error('FAIL: attempt1 retry/regenerate button never fired (ok1=false) — dedupe cannot be measured without a first failure');
    process.exit(1);
  }
  const r1 = await waitForFailureToast(page);
  console.log(`Failure toast (attempt1) after ${Date.now() - t0}ms:`, r1.texts, '| all toasts seen:', r1.allTexts);
  if (r1.texts.length === 0) {
    console.error('FAIL: attempt1 failure toast never appeared — dedupe cannot be measured without a first failure to dedupe against');
    process.exit(1);
  }

  await page.waitForTimeout(1000);
  const ch1Row = page.locator('button', { hasText: 'Chapter 1' }).first();
  await ch1Row.click().catch(() => {});
  await page.waitForTimeout(500);
  const moreHelp = page.getByRole('link', { name: 'More help' }).first();
  const moreHelpVisible = await moreHelp.isVisible({ timeout: 5000 }).catch(() => false);
  const helpHref = moreHelpVisible ? await moreHelp.getAttribute('href').catch(() => null) : null;
  console.log('More help visible=', moreHelpVisible, 'href=', helpHref);
  if (moreHelpVisible) {
    await moreHelp.click();
    await page.waitForTimeout(1000);
    console.log('URL after clicking More help:', page.url());
    const helpTitle = await page.getByText("Cloned voice can't render as itself").first().innerText().catch(() => '<not found>');
    console.log('Help view title found:', helpTitle);
    await page.goBack();
    await page.waitForTimeout(1500);
  }

  console.log('\n=== ATTEMPT 2: SAME chapter (Chapter 1) again -> dedupe expected ===');
  // DO NOT dismiss toasts — we need to measure whether attempt 2 bumps the
  // existing toast (dedupe) or creates a second one (no dedupe).
  const toastsBeforeAttempt2 = await toastLocator(page).allTextContents().catch(() => []);
  const failureToastsBeforeAttempt2 = toastsBeforeAttempt2.filter((t) => /failed|Cloned voice/i.test(t));
  console.log(`  toasts before attempt2: ${failureToastsBeforeAttempt2.length} failure-class toast(s)`);
  if (failureToastsBeforeAttempt2.length === 0) {
    console.error('FAIL: no failure toast present before attempt2 — attempt1\'s toast must still be visible for dedupe to have anything to bump. Without this, a fresh toast after attempt2 would falsely read as "dedupe held".');
    process.exit(1);
  }

  const ok2 = await clickChapterRetryOrRegenerate(page, 'Chapter 1');
  console.log('attempt2 dialog handled=', ok2);
  if (!ok2) {
    console.error('FAIL: attempt2 retry/regenerate button never fired (ok2=false)');
    process.exit(1);
  }

  const r2 = await waitForFailureToast(page, 30000);
  if (r2.texts.length === 0) {
    console.error('FAIL: attempt2 failure toast never appeared after 30s');
    process.exit(1);
  }

  const toastsAfterAttempt2 = await toastLocator(page).allTextContents().catch(() => []);
  const failureToastsAfterAttempt2 = toastsAfterAttempt2.filter((t) => /failed|Cloned voice/i.test(t));
  console.log(`  toasts after attempt2: ${failureToastsAfterAttempt2.length} failure-class toast(s)`);

  // Dedupe assertion: should still have exactly 1 failure toast (bumped via dedupeKey),
  // NOT 2 (which would mean dedupe failed and a second toast was added).
  if (failureToastsAfterAttempt2.length !== 1) {
    console.error(`FAIL: dedupe did not hold — expected 1 failure toast after attempt2, got ${failureToastsAfterAttempt2.length}`);
    console.error('toasts after attempt2:', failureToastsAfterAttempt2);
    process.exit(1);
  }
  console.log('✓ PASS: dedupe held — same-chapter retry bumped existing toast (count stayed at 1)');

  console.log('\n=== ATTEMPT 3: DIFFERENT chapter (Chapter 2 "The Knock") -> new toast expected ===');
  await dismissAllToasts(page);
  const ok3 = await clickChapterRetryOrRegenerate(page, 'The Knock');
  console.log('attempt3 dialog handled=', ok3);
  const r3 = await waitForFailureToast(page, 60000);
  console.log(`Failure toast (attempt3, different chapter) after ${r3.elapsedMs}ms:`, r3.texts, '| all toasts seen:', r3.allTexts);

  console.log('\nConsole errors collected:', consoleErrors);
  await browser.close();
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
