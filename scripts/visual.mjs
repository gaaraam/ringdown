#!/usr/bin/env node
// Fixed seed, system fonts, local assets, isolated Chrome profile. No LLM or external service.
// Mirrors the reference's three-screen light/dark capture workflow using installed Chrome.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createPlayServer } from '../src/play/server.ts';

const out = fileURLToPath(new URL('../docs/screenshots/', import.meta.url));
mkdirSync(out, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), 'ringdown-visual-'));
const app = createPlayServer({ gitSha: 'visual', dataDir, clock: () => new Date('2026-11-17T00:00:00Z') });
const base = await app.listen(0);
let browser;
const errors = [];
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--hide-scrollbars', '--disable-gpu', '--force-color-profile=srgb'] });
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, colorScheme: theme, locale: 'ko-KR', timezoneId: 'Asia/Seoul', reducedMotion: 'reduce' });
    const page = await context.newPage();
    const capture = async name => {
      await page.mouse.move(0, 0);
      await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
      await page.screenshot({ animations: 'disabled', path: `${out}${theme}-${name}.png` });
    };
    page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    await page.goto(base);
    await page.locator('#personas button').first().waitFor({ state: 'attached' });
    await page.locator('#theme').selectOption(theme);
    await page.locator('[data-view="playground"]').click();
    await page.locator('#mode').selectOption('human');
    await page.locator('#start').click();
    await page.waitForFunction(() => !document.querySelector('#say').disabled);
    await page.locator('#say').fill('네, 진행해 주세요.');
    await page.locator('#send').click();
    await page.waitForFunction(() => document.querySelectorAll('.msg.user').length === 1 && !document.querySelector('#say').disabled);
    await page.evaluate(() => { document.querySelector('#messages').scrollTop = 0; });
    await capture('playground');
    // Keep the same human call: a real input guard rejection is visible without altering packs.
    await page.locator('#say').fill('다시는 전화하지 마세요.');
    await page.locator('#send').click();
    await page.waitForFunction(() => document.querySelector('#call-status').textContent === '통화 완료');
    await page.locator('[data-view="calls"]').click();
    await page.evaluate(() => {
      const rejected = document.querySelector('.msg:has(.rejection)');
      const message = rejected ?? document.querySelectorAll('.msg.agent')[2];
      if (message) {
        message.querySelector('details').open = true;
        document.querySelector('#messages').scrollTop = message.offsetTop - document.querySelector('#messages').offsetTop - 12;
      }
    });
    await capture('calls');

    await page.locator('[data-view="soundcheck"]').click();
    await page.locator('#run-matrix').click();
    await page.locator('[data-cell-persona]').first().waitFor({ timeout: 10000 }).catch(async error => { console.error(await page.locator('#notice').textContent()); throw error; });
    await capture('soundcheck');
    // Cell navigation must open a real deterministic call, not just a pretty heatmap.
    await page.locator('[data-cell-persona]').first().click();
    await page.waitForFunction(() => document.querySelector('#page-title').textContent === 'Calls' && document.querySelector('#call-status').textContent === '통화 완료');
    if (await page.locator('#notice').isVisible()) throw new Error(await page.locator('#notice').innerText());
    // A multi-seed cell opens a picker before replay.
    await page.locator('[data-view="soundcheck"]').click();
    await page.locator('#matrix-seeds').fill('1, 7');
    await page.locator('#run-matrix').click();
    await page.waitForFunction(() => document.querySelector('.report-head p').textContent.includes('120통화'));
    await page.locator('[data-cell-persona]').first().click();
    await page.locator('#cell-dialog[open]').waitFor();
    await page.locator('#cell-calls button').last().click();
    await page.waitForFunction(() => document.querySelector('#call-status').textContent === '통화 완료');
    // Operator campaign creation uses the UI and real RuleBrain calls. Dark captures reuse
    // the same persisted data; no extra campaign or wall clock changes the screenshots.
    await page.locator('[data-view="campaigns"]').click();
    await page.locator('#campaign-pack').waitFor();
    if (theme === 'light') {
      await page.locator('#campaign-pack').selectOption({ index: 1 });
      await page.locator('#campaign-form [name="fault"]').selectOption('lost-ack');
      await page.locator('#run-campaign').click();
      await page.waitForFunction(() => document.querySelector('#campaign-progress').textContent.includes('30 / 30통화'));
      // Verify a subset campaign, with a different fault and seed.
      await page.locator('#all-personas').uncheck();
      await page.locator('#campaign-personas input').first().check();
      await page.locator('#campaign-form [name="fault"]').selectOption('down');
      await page.locator('#campaign-form [name="seed"]').fill('8');
      await page.locator('#run-campaign').click();
      await page.waitForFunction(() => document.querySelector('#campaign-progress').textContent.includes('1 / 1통화'));
      await page.locator('[data-view="overview"]').click();
      await page.locator('#overview-filter').waitFor();
      await page.locator('[data-view="campaigns"]').click();
      await page.locator('#campaign-pack').waitFor();
    }
    await capture('ops-campaigns');
    await page.locator('[data-view="overview"]').click();
    await page.locator('.outcome-bars').waitFor();
    await capture('ops-overview');
    await page.locator('[data-view="inbox"]').click();
    await page.locator('#inbox-filter').waitFor();
    await page.locator('#inbox-filter [name="kind"]').selectOption('confirmation');
    await page.locator('#inbox-filter button').click();
    await page.locator('#resolve-form').waitFor();
    await page.waitForFunction(() => document.querySelector('#state').textContent.includes('업무 반영 상태'));
    if (!(await page.locator('#state').innerText()).includes('반영됨')) throw new Error('Missing stored write confirmation');
    await capture('ops-inbox');
    await page.locator('#state a[href^="#history/"]').click();
    await page.locator('.ops-transcript').waitFor();
    if (await page.locator('.developer-details').getAttribute('open') !== null) throw new Error('Developer trace should start collapsed');
    await capture('ops-history');
    await page.locator('.developer-details > summary').click();
    await page.locator('.developer-details .steps').first().waitFor();
    // Search and resolve must work beyond static screenshots.
    await page.locator('[data-view="history"]').click();
    await page.locator('#history-filter').waitFor();
    await page.locator('#history-filter [name="q"]').fill('S-1001');
    await page.locator('#history-filter button').first().click();
    await page.waitForFunction(() => document.querySelector('#view-history tbody')?.rows.length === 2);
    if (theme === 'dark') {
      await page.locator('[data-view="inbox"]').click();
      await page.locator('#resolve-form').waitFor();
      await page.locator('#resolve-form [name="assignee"]').fill('운영 담당');
      await page.locator('#resolve-form [name="note"]').fill('고객 안내 완료');
      await page.locator('#resolve-form [name="status"]').selectOption('resolved');
      await page.locator('#resolve-form button').click();
      await page.waitForFunction(() => !document.querySelector('#resolve-form button')?.disabled);
      await page.locator('#inbox-filter [name="status"]').selectOption('resolved');
      await page.locator('#inbox-filter button').click();
      await page.waitForFunction(() => document.querySelector('#resolve-form [name="note"]')?.value === '고객 안내 완료');
      await page.reload();
      await page.locator('#inbox-filter').waitFor();
      await page.locator('#inbox-filter [name="status"]').selectOption('resolved');
      await page.locator('#inbox-filter button').click();
      await page.waitForFunction(() => document.querySelector('#resolve-form [name="assignee"]')?.value === '운영 담당');
    }
    // Narrow viewport must remain usable without horizontal page overflow.
    await page.setViewportSize({ width: 390, height: 844 });
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Mobile page overflows');
    for (const view of ['overview', 'inbox', 'history', 'campaigns']) {
      await page.locator(`[data-view="${view}"]`).click();
      await page.waitForFunction(view => !document.querySelector(`#view-${view}`).hidden, view);
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error(`Mobile ${view} overflows`);
    }
    await page.locator('[data-view="playground"]').click();
    await page.locator('#persona').selectOption({ index: 1 });
    await context.close();
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(`Captured 14 screens in ${out}; human stepping, auto trace, heatmap navigation, campaigns, search, resolution persistence and mobile overflow checks passed.`);
} finally {
  await browser?.close();
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
}
