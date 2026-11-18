const { chromium } = require('playwright');
const OUT = __dirname + '/img/';
const TOKEN = process.argv[2];
(async () => {
  const b = await chromium.launch({ proxy: { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
  await ctx.addInitScript(() => { try { localStorage.setItem('ds-tour', '1'); localStorage.setItem('ds-hint-swipe', '1'); } catch (_) {} });
  const p = await ctx.newPage();
  const tap = (s) => p.evaluate((x) => document.querySelector(x).click(), s);
  const shot = async (n, wait) => { await p.waitForTimeout(wait || 1400); await p.screenshot({ path: OUT + n + '.png' }); };
  const noFab = () => p.evaluate(() => { const f = document.querySelector('.fab'); if (f) f.style.display = 'none'; const d = document.querySelector('.demobar'); if (d) d.style.display = 'none'; });
  // tenant page first (sends an "I've paid" so the landlord card shows)
  const t = await ctx.newPage();
  await t.goto('http://localhost:8080/doorstep/tenant.html?t=' + TOKEN); await t.waitForSelector('#paid', { timeout: 20000 }); await t.waitForTimeout(800);
  await t.screenshot({ path: OUT + 'tenant.png' });
  await t.fill('#p-note', 'Sent from my phone'); await t.evaluate(() => document.getElementById('paid').requestSubmit());
  await t.waitForSelector('[aria-label="Payment sent"]', { timeout: 20000 }); await t.evaluate(() => document.querySelector('[aria-label="Payment sent"]').scrollIntoView({ block: 'center' }));
  await t.waitForTimeout(600); await t.screenshot({ path: OUT + 'tenant-sent.png' });
  // landing
  await p.goto('http://localhost:8080/doorstep/'); await p.waitForSelector('.lp', { timeout: 20000 }); await shot('landing', 900);
  // demo
  await tap('.lp-cta [data-act=demo-login]'); await p.waitForSelector('.tabbar', { timeout: 20000 }); await p.waitForTimeout(1500);
  await noFab(); await shot('home');
  await p.evaluate(() => { const c = document.querySelector('.iecard'); c.scrollIntoView({ block: 'start' }); window.scrollBy(0, -70); }); await noFab(); await shot('income', 900);
  await p.evaluate(() => { const c = document.querySelector('.flow'); if (c) { c.scrollIntoView({ block: 'start' }); window.scrollBy(0, -70); } }); await noFab(); await shot('flow', 1600);
  await tap('.tab[data-tab=bills]'); await p.waitForTimeout(400); await p.evaluate(() => window.scrollTo(0, 0)); await noFab(); await shot('bills');
  await p.evaluate(() => { const c = document.querySelector('.section-h'); if (c) { c.scrollIntoView({ block: 'start' }); window.scrollBy(0, -80); } }); await noFab(); await shot('bills-list', 900);
  await tap('[data-act=bills-view][data-v=cal]'); await p.waitForTimeout(500); await p.evaluate(() => { document.querySelector('.cal').scrollIntoView({ block: 'start' }); window.scrollBy(0, -80); }); await noFab(); await shot('calendar');
  await tap('[data-act=bills-view][data-v=list]');
  await tap('.tab[data-tab=rent]'); await p.waitForTimeout(500); await p.evaluate(() => { const c = document.querySelector('.notices'); if (c) { c.scrollIntoView({ block: 'start' }); window.scrollBy(0, -90); } }); await noFab(); await shot('rent');
  await p.evaluate(() => { const c = [...document.querySelectorAll('#app .bill')].find((x) => /Maria/.test(x.innerText)); if (c) { c.scrollIntoView({ block: 'start' }); window.scrollBy(0, -90); } }); await noFab(); await shot('rent-history', 900);
  await tap('.tab[data-tab=upkeep]'); await p.waitForTimeout(500); await p.evaluate(() => window.scrollTo(0, 0)); await noFab(); await shot('house');
  await tap('.tab[data-tab=personal]'); await p.waitForTimeout(500); await p.evaluate(() => window.scrollTo(0, 0)); await noFab(); await shot('personal');
  // a bill detail sheet
  await tap('.tab[data-tab=bills]'); await p.waitForTimeout(400);
  await p.evaluate(() => { const c = [...document.querySelectorAll('[id^=bill-]')].find((x) => /Valley Electric/.test(x.innerText)); c.querySelector('[data-act=bill]').click(); });
  await p.waitForTimeout(1600); await shot('bill-detail', 600);
  await tap('[data-act=sheet-close]'); await p.waitForTimeout(400);
  // weekly story
  await p.evaluate(() => document.querySelector('[data-act=story-open]') ? document.querySelector('[data-act=story-open]').click() : null); await p.waitForTimeout(400);
  if (await p.$('.story')) { await p.evaluate(() => { document.querySelectorAll('.sbar i.on').forEach((n) => { n.style.animation = 'none'; n.style.width = '60%'; }); }); await shot('story', 1300);
    await p.evaluate(() => document.querySelector('.story-tap.next').click()); await p.evaluate(() => { document.querySelectorAll('.sbar i.on').forEach((n) => { n.style.animation = 'none'; n.style.width = '40%'; }); }); await shot('story2', 1300);
    await p.keyboard.press('Escape'); }
  // ask sheet (chat greeting, no AI call)
  await p.evaluate(() => document.querySelector('.fab').style.display = ''); await tap('.fab'); await p.waitForTimeout(1200); await shot('ask', 400);
  await b.close();
  console.log('done');
})();
