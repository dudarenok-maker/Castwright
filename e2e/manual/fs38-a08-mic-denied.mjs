// Manual real-server browser check for A-08 (mic-permission denial falls
// back to Upload) WITH its control (mic granted -> no fallback copy).
// Run: node e2e/manual/fs38-a08-mic-denied.mjs
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = 'https://localhost:5363';
const FIXTURE = 'C:\\fixtures\\fs38\\F1-clean-20s.wav';
const DENIED_COPY = 'Mic access was blocked. Enable microphone permission or use the Upload tab instead.';

async function openWizardRecordTab(page) {
  await page.goto(`${BASE}/#/voices`);
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'My voices', exact: true }).click();
  await page.waitForTimeout(500);
  await page.getByTestId('my-voices-clone-cta').first().click();
  await page.waitForSelector('[data-testid="clone-voice-wizard"]', { timeout: 10000 });
  await page.getByRole('tab', { name: 'Record' }).click();
  await page.waitForTimeout(300);
}

async function runDeniedCase() {
  console.log('\n=== CASE: mic permission DENIED ===');
  const browser = await chromium.launch();
  // No --use-fake-ui-for-media-stream and no permission grant -> getUserMedia
  // rejects (NotAllowedError), driving VoiceRecorder into its `denied` phase.
  const context = await browser.newContext({ ignoreHTTPSErrors: true, permissions: [] });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

  await openWizardRecordTab(page);
  await page.getByRole('button', { name: 'Record' }).click();
  await page.waitForTimeout(1500);

  const deniedCopyVisible = await page.getByText(DENIED_COPY).isVisible().catch(() => false);
  console.log('Denied copy visible=', deniedCopyVisible);
  const tryAgainVisible = await page.getByRole('button', { name: 'Try again' }).isVisible().catch(() => false);
  console.log('Try again button visible=', tryAgainVisible);

  // Modal must not be dead: Upload tab still present + functional.
  await page.getByRole('tab', { name: 'Upload' }).click();
  await page.waitForTimeout(300);
  const uploadInputVisible = await page.getByLabel('Upload audio').isVisible().catch(() => false);
  console.log('Upload input visible after switching tabs=', uploadInputVisible);

  const buf = readFileSync(FIXTURE);
  await page.getByLabel('Upload audio').setInputFiles({ name: 'F1-clean-20s.wav', mimeType: 'audio/wav', buffer: buf });
  await page.waitForFunction(() => {
    const ta = document.querySelector('textarea');
    return ta && ta.value && ta.value.length > 0;
  }, { timeout: 30000 });
  const transcript = await page.evaluate(() => document.querySelector('textarea')?.value);
  console.log('Upload-tab ingest succeeded after denial, transcript=', transcript?.slice(0, 60));

  console.log('Console errors during denied flow:', consoleErrors);

  await browser.close();
}

async function runGrantedControlCase() {
  console.log('\n=== CONTROL: mic permission GRANTED (fake device) ===');
  const browser = await chromium.launch({
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${FIXTURE}`,
    ],
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await openWizardRecordTab(page);
  await page.getByRole('button', { name: 'Record' }).click();
  await page.waitForTimeout(1500);

  const deniedCopyVisible = await page.getByText(DENIED_COPY).isVisible().catch(() => false);
  console.log('Denied copy visible (should be false)=', deniedCopyVisible);
  const stopVisible = await page.getByRole('button', { name: 'Stop' }).isVisible().catch(() => false);
  console.log('Stop button visible (recording in progress)=', stopVisible);
  await page.getByRole('button', { name: 'Stop' }).click().catch(() => {});

  await browser.close();
}

async function main() {
  await runDeniedCase();
  await runGrantedControlCase();
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
