// Manual real-server browser check for A-07 (browser recorder ingest) and
// B-02 (wizard happy path via Record tab -> ready cloned voice).
// Run: node e2e/manual/fs38-a07-b02-record-wizard.mjs
// Requires the real dev stack (npm start, LAN_HTTPS=1) — NOT mock mode.
import { chromium } from 'playwright';

const BASE = 'https://localhost:5363';
const FAKE_CLIP = 'C:\\fixtures\\fs38\\F1-clean-20s.wav';
const NAME = `A07-B02 Record ${Date.now()}`;

async function main() {
  const browser = await chromium.launch({
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${FAKE_CLIP}`,
    ],
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('[console error]', m.text()); });

  let capturedReq = null;
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/api/voice-library/clone-sample')) {
      capturedReq = req;
    }
  });
  let capturedRes = null;
  page.on('response', async (res) => {
    if (res.url().includes('/api/voice-library/clone-sample')) {
      capturedRes = { status: res.status(), body: await res.text().catch(() => '<unreadable>') };
    }
  });

  await page.goto(`${BASE}/#/voices`);
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'My voices', exact: true }).click();
  await page.waitForTimeout(500);
  await page.getByTestId('my-voices-clone-cta').first().click();
  await page.waitForSelector('[data-testid="clone-voice-wizard"]', { timeout: 10000 });

  // Switch to Record tab.
  await page.getByRole('tab', { name: 'Record' }).click();
  await page.waitForTimeout(300);

  // idle -> recording
  await page.getByRole('button', { name: 'Record' }).click();
  console.log('PHASE after click Record: recording button visible=', await page.getByRole('button', { name: 'Stop' }).isVisible());
  await page.waitForTimeout(11000); // speak >= 10s via fake audio capture
  await page.getByRole('button', { name: 'Stop' }).click();

  // recorded -> re-record button should appear
  await page.waitForTimeout(500);
  console.log('Re-record button visible=', await page.getByRole('button', { name: 'Re-record' }).isVisible().catch(() => false));

  // wait for ingest (real ffmpeg decode of webm/opus + real whisper transcript)
  try {
    await page.waitForFunction(() => {
      const ta = document.querySelector('textarea');
      return ta && ta.value && ta.value.length > 0;
    }, { timeout: 90000 });
  } catch (e) {
    console.log('INGEST TIMEOUT - dumping state');
    console.log('busy text visible=', await page.locator('text=Processing sample').isVisible().catch(() => false));
    console.log('error text=', await page.locator('.text-magenta').allTextContents().catch(() => []));
    console.log('capturedReq=', !!capturedReq, 'capturedRes=', capturedRes);
    await page.screenshot({ path: 'e2e/manual/_debug-ingest-timeout.png', fullPage: true });
    throw e;
  }
  const transcript = await page.evaluate(() => document.querySelector('textarea')?.value);
  console.log('TRANSCRIPT:', transcript);
  console.log('REQUEST captured:', !!capturedReq);
  if (capturedReq) {
    console.log('REQUEST method/url:', capturedReq.method(), capturedReq.url());
    console.log('REQUEST is multipart:', (capturedReq.headers()['content-type'] || '').includes('multipart/form-data'));
  }
  console.log('RESPONSE:', capturedRes?.status, (capturedRes?.body || '').slice(0, 400));

  // Phase 1 consent
  await page.getByLabel('person name').fill('B02 Recorded Speaker');
  await page.getByLabel('I attest').check();
  const continueBtn = page.getByRole('button', { name: 'Continue' });
  console.log('Continue enabled after consent=', await continueBtn.isEnabled());
  await continueBtn.click();

  // Phase 2: name + save
  let cloneReq = null, cloneRes = null;
  page.on('request', (req) => { if (req.method() === 'POST' && req.url().endsWith('/api/voice-library/clone')) cloneReq = req; });
  page.on('response', async (res) => { if (res.url().endsWith('/api/voice-library/clone')) cloneRes = { status: res.status(), body: await res.text().catch(() => '<unreadable>') }; });
  await page.getByTestId('clone-voice-wizard-name').fill(NAME);
  const saveBtn = page.getByTestId('clone-voice-wizard-save');
  console.log('Save button enabled=', await saveBtn.isEnabled());
  await saveBtn.click();
  await page.waitForTimeout(3000);
  console.log('clone req sent=', !!cloneReq, 'clone res=', cloneRes?.status, (cloneRes?.body || '').slice(0, 300));
  await page.screenshot({ path: 'e2e/manual/_debug-after-save.png', fullPage: true });
  await page.waitForSelector('[data-testid="clone-voice-wizard-done"]', { timeout: 240000 });
  const completionText = await page.locator('text=/Cloned "/').innerText().catch(() => '<not found>');
  console.log('COMPLETION SCREEN TEXT:', completionText);
  const playBtnVisible = await page.getByRole('button', { name: /Play preview|Stop preview/ }).isVisible().catch(() => false);
  console.log('Audition play control visible=', playBtnVisible);

  await page.getByTestId('clone-voice-wizard-done').click();
  await page.waitForTimeout(1000);

  // Find the new card + badge
  const cardText = await page.locator(`text=${NAME}`).first().isVisible().catch(() => false);
  console.log('New card visible in My voices=', cardText);

  await browser.close();
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
