#!/usr/bin/env node
// README demo: one human-mode gaga-seller call under lost-ack, then its trace.
// Fixed seed, installed Chrome, RuleBrain + mock only. Writes docs/screenshots/demo.gif.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import gifenc from 'gifenc';
import { createPlayServer } from '../src/play/server.ts';

const { GIFEncoder, quantize, applyPalette } = gifenc;
const out = fileURLToPath(new URL('../docs/screenshots/demo.gif', import.meta.url));
const W = 1280, H = 960;
const dataDir = mkdtempSync(join(tmpdir(), 'ringdown-demo-'));
const app = createPlayServer({ gitSha: 'demo', dataDir, clock: () => new Date('2026-11-17T00:00:00Z') });
const base = await app.listen(0);
const frames = [];
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--hide-scrollbars', '--disable-gpu', '--force-color-profile=srgb'] });
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: 'light', locale: 'ko-KR', timezoneId: 'Asia/Seoul', reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.on('pageerror', error => { throw error; });
  const frame = async ms => {
    await page.mouse.move(0, 0);
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); });
    const png = await page.screenshot({ animations: 'disabled' });
    frames.push({ png, ms });
  };
  const say = async (text, ms = 1800) => {
    const users = await page.locator('.msg.user').count();
    await page.locator('#say').fill(text);
    await frame(900);
    await page.locator('#send').click();
    await page.waitForFunction(n => document.querySelectorAll('.msg.user').length === n + 1
      && (!document.querySelector('#say').disabled || document.querySelector('#call-status').textContent === '통화 완료'), users);
    await frame(ms);
  };

  await page.goto(base);
  await page.locator('#personas button').first().waitFor({ state: 'attached' });
  await page.locator('#theme').selectOption('light');
  await page.locator('[data-view="playground"]').click();
  await page.locator('#pack').selectOption('gaga-seller');
  await page.locator('#fault').selectOption('lost-ack');
  await page.locator('#seed').fill('7');
  await page.locator('#mode').selectOption('human');
  await frame(1400);
  await page.locator('#start').click();
  await page.waitForFunction(() => !document.querySelector('#say').disabled);
  await frame(1800);
  await say('네, 제가 운영해요.');
  await say('3천 원으로 해 주세요.');
  await say('네, 진행해 주세요.', 2600);
  // Open the write turn's trace: lost ack, same idempotency key, state check.
  await page.evaluate(() => {
    const box = document.querySelector('#messages');
    const traces = [...box.querySelectorAll('.msg.agent details')];
    const write = traces.find(d => d.textContent.includes('seller.setReturnPolicy 호출')) ?? traces.at(-1);
    if (write) {
      write.open = true;
      const attempt = [...write.querySelectorAll('*')].find(el => el.children.length === 0 && el.textContent.includes('setReturnPolicy') && el.textContent.includes('호출'));
      const anchor = attempt ?? write.closest('.msg');
      box.scrollTop = anchor.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 12;
    }
  });
  await frame(3000);
  // Then the attempts: lost ack, retry with the same idempotency key.
  await page.evaluate(() => {
    const box = document.querySelector('#messages');
    box.querySelectorAll('.msg.agent details').forEach(d => { d.open = true; });
    const anchor = [...box.querySelectorAll('.trace-item b')].find(b => /호출 #2 시도 결과/.test(b.textContent))?.closest('.trace-item');
    if (anchor) box.scrollTop = anchor.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 12;
  });
  await frame(5000);

  // Decode PNGs in the page to avoid an image dependency.
  const decoder = await context.newPage();
  const enc = GIFEncoder();
  for (const [i, { png, ms }] of frames.entries()) {
    if (process.env.DEMO_FRAMES) writeFileSync(join(process.env.DEMO_FRAMES, `${i}.png`), png);
    const rgba = await decoder.evaluate(async b64 => {
      const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
      const c = new OffscreenCanvas(img.width, img.height); const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      return Array.from(g.getImageData(0, 0, img.width, img.height).data);
    }, png.toString('base64'));
    const data = Uint8Array.from(rgba);
    const palette = quantize(data, 256);
    enc.writeFrame(applyPalette(data, palette), W, H, { palette, delay: ms });
  }
  enc.finish();
  writeFileSync(out, enc.bytes());
  console.log(`${frames.length} frames → ${out} (${Math.round(enc.bytes().length / 1024)} KiB)`);
} finally {
  await browser?.close();
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
}
