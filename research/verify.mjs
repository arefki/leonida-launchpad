// Browser verification for Leonida Launchpad (localhost + local RPC proxy).
// Run: node verify.mjs  (needs the proxy on :8545 and http server on :8080)
import { chromium } from '/home/hatch/workspace/makefun/token-radar-01-research/node_modules/playwright/index.mjs';
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:8080/?rpc=http://127.0.0.1:8545';
const SHOT = '/home/hatch/workspace/ammora-builder/screenshots';
fs.mkdirSync(SHOT, { recursive: true });

const consoleErrors = [];
const pageErrors = [];

const browser = await chromium.launch({
  executablePath: '/home/hatch/.cache/ms-playwright/chromium-1148/chrome-linux/chrome',
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(String(e)));

console.log('opening', BASE);
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });

// 1. Network pill shows a live block number
await page.waitForFunction(
  () => document.getElementById('net-status')?.textContent.includes('block'),
  { timeout: 120000 },
);
console.log('NET:', await page.locator('#net-status').textContent());

// 2. Discover: launch cards appear
await page.waitForSelector('#launch-list .card', { timeout: 180000 });
await page.waitForTimeout(15000); // let card states fill in
const nLaunches = await page.locator('#launch-list .card').count();
console.log('LAUNCH CARDS:', nLaunches);
console.log('SCAN STATUS:', await page.locator('#scan-status').textContent());
const firstCard = await page.locator('#launch-list .card h3').first().textContent();
console.log('FIRST CARD:', firstCard);
const rpcErr = await page.locator('#launch-list .curve-state', { hasText: 'RPC error' }).count();
const named = await page.locator('#launch-list .token-name', { hasText: '(' }).count();
console.log('CARDS WITH RPC-ERROR STATE:', rpcErr, '| CARDS WITH RESOLVED TOKEN NAME:', named);
const firstState = await page.locator('#launch-list .curve-state').first().textContent();
console.log('FIRST CARD STATE:', firstState);
await page.screenshot({ path: `${SHOT}/01-discover.png`, fullPage: true });

// 3. Configs tab
await page.click('[data-tab="configs"]');
await page.waitForSelector('#config-list .card', { timeout: 180000 });
await page.waitForTimeout(5000);
const nConfigs = await page.locator('#config-list .card').count();
console.log('CONFIG CARDS:', nConfigs);
console.log('CONFIGS STATUS:', await page.locator('#configs-status').textContent());
// Page through all older Configs until Config #6 appears.
for (let i = 0; i < 5; i++) {
  const moreVisible = await page.locator('#btn-more-configs').isVisible();
  if (!moreVisible) break;
  await page.click('#btn-more-configs');
  await page.waitForTimeout(8000);
}
const nConfigsAll = await page.locator('#config-list .card').count();
console.log('CONFIG CARDS (ALL PAGES):', nConfigsAll);
const blockedBadge = await page.locator('#config-list .badge-blocked').count();
console.log('BLOCKED (#6) BADGES:', blockedBadge);
await page.screenshot({ path: `${SHOT}/02-configs.png`, fullPage: true });

// 4. Trade tab: load a real active curve + quote
await page.click('[data-tab="trade"]');
await page.fill('#trade-curve', '0xdaa9edb6a432f947adb7d4bbaf30b3c114efcd76');
await page.click('#btn-load-curve');
await page.waitForFunction(
  () => document.getElementById('trade-state')?.textContent.includes('Reserves'),
  { timeout: 180000 },
);
console.log('TRADE STATE LOADED');
await page.screenshot({ path: `${SHOT}/03-trade-state.png`, fullPage: true });
await page.fill('#trade-amount', '0.001');
await page.click('#btn-quote');
await page.waitForFunction(
  () => document.getElementById('trade-quote')?.textContent.includes('Quote:'),
  { timeout: 180000 },
);
console.log('QUOTE:', (await page.locator('#trade-quote').textContent()).slice(0, 300));
await page.screenshot({ path: `${SHOT}/04-trade-quote.png`, fullPage: true });

// 5. Create tab
await page.click('[data-tab="create"]');
await page.waitForTimeout(2000);
const nOpts = await page.locator('#create-config option').count();
console.log('CREATE CONFIG OPTIONS:', nOpts);
await page.screenshot({ path: `${SHOT}/05-create.png`, fullPage: true });

// 6. About tab
await page.click('[data-tab="about"]');
await page.waitForTimeout(1000);
await page.screenshot({ path: `${SHOT}/06-about.png`, fullPage: true });

console.log('CONSOLE ERRORS:', consoleErrors.length);
for (const e of consoleErrors) console.log('  [console.error]', e.slice(0, 300));
console.log('PAGE ERRORS:', pageErrors.length);
for (const e of pageErrors) console.log('  [pageerror]', e.slice(0, 300));

await browser.close();
console.log('VERIFY DONE');
