// Manual real-server browser check for A-09 (consent gates Continue).
// Run: node e2e/manual/fs38-a09-consent-gate.mjs
// Requires the real dev stack running (npm start with LAN_HTTPS=1) — NOT mock mode.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = 'https://localhost:5363';
const FIXTURE = 'C:\\fixtures\\fs38\\F1-clean-20s.wav';

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('[console error]', m.text()); });

  await page.goto(`${BASE}/#/voices`);
  await page.waitForTimeout(2000);
  await page.getByRole('button', { name: 'My voices', exact: true }).click();
  await page.waitForTimeout(800);
  await page.getByTestId('my-voices-clone-cta').first().click();
  await page.waitForSelector('[data-testid="clone-voice-wizard"]', { timeout: 10000 });

  // Upload tab is default. Upload the real fixture (real ffmpeg decode, real Whisper).
  const buf = readFileSync(FIXTURE);
  await page.getByLabel('Upload audio').setInputFiles({ name: 'F1-clean-20s.wav', mimeType: 'audio/wav', buffer: buf });

  // Wait for candidate ingest (real Whisper transcript takes a few seconds).
  await page.waitForFunction(() => {
    const ta = document.querySelector('textarea');
    return ta && ta.value && ta.value.length > 0;
  }, { timeout: 30000 });
  const transcript = await page.evaluate(() => document.querySelector('textarea')?.value);
  console.log('TRANSCRIPT:', transcript);

  const continueBtn = page.getByRole('button', { name: 'Continue' });

  // Step 1: name empty -> disabled
  console.log('STEP1 name-empty disabled=', await continueBtn.isDisabled());

  // Step 2: name filled, attest unchecked -> disabled
  await page.getByLabel('person name').fill('A09 Tester');
  console.log('STEP2 name-only disabled=', await continueBtn.isDisabled());

  // relationship default check
  const relVal = await page.getByLabel('relationship').inputValue();
  console.log('RELATIONSHIP default=', relVal);

  // attest sentence text
  const sentence = await page.locator('#clone-attest-sentence').innerText();
  console.log('ATTEST SENTENCE=', JSON.stringify(sentence));

  // Step 3: tick attest -> enabled
  await page.getByLabel('I attest').check();
  console.log('STEP3 attested enabled=', await continueBtn.isEnabled());

  // Step 4: untick -> disabled again
  await page.getByLabel('I attest').uncheck();
  console.log('STEP4 unattested disabled=', await continueBtn.isDisabled());

  await browser.close();
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
