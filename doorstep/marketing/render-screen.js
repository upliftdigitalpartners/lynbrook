const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  await p.goto('file://' + __dirname + '/pamphlet.html'); await p.waitForTimeout(800);
  await p.pdf({ path: __dirname + '/Doorstep-Pamphlet-SCREEN.pdf', format: 'Letter', printBackground: true, preferCSSPageSize: true });
  await b.close();
})();
