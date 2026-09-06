// Follow-up check: My-voices card badge/state-chip + Preview control for an
// already-persisted cloned voice (B-01/B-02 UI half). Reuses an entry created
// by an earlier run rather than re-cloning.
import { chromium } from 'playwright';

const BASE = 'https://localhost:5363';
const VOICE_NAME = process.argv[2] || 'A07-B02 Record';

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  let sampleReq = null, sampleRes = null;
  page.on('request', (req) => { if (req.url().includes('/sample') && req.method() === 'POST') sampleReq = req.url(); });
  page.on('response', async (res) => { if (res.url().includes('/sample') && res.request().method() === 'POST') sampleRes = { status: res.status(), ct: res.headers()['content-type'] }; });

  await page.goto(`${BASE}/#/voices`);
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'My voices', exact: true }).click();
  await page.waitForTimeout(800);

  // Find the heading text and walk up to find sibling badges via full-page text scan instead.
  const bodyText = await page.locator('main, body').first().innerText().catch(() => '');
  const idx = bodyText.indexOf(VOICE_NAME);
  console.log('Card found in page text:', idx !== -1);
  const snippet = idx !== -1 ? bodyText.slice(idx, idx + 300) : '(not found)';
  console.log('Snippet around card:\n', snippet);

  // First card in the grid is the newest (our target voice, per the snippet above).
  const allPreview = page.locator('button:has-text("Preview")');
  console.log('Preview button count=', await allPreview.count());
  const previewBtn = allPreview.first();
  console.log('Preview button visible=', await previewBtn.isVisible().catch(() => false));
  await previewBtn.click({ timeout: 10000, force: true }).catch((e) => console.log('preview click failed:', e.message));
  await page.waitForTimeout(4000);
  console.log('sample request fired=', !!sampleReq, sampleReq);
  console.log('sample response=', sampleRes);

  await page.screenshot({ path: 'e2e/manual/_debug-card.png', fullPage: true });
  await browser.close();
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
