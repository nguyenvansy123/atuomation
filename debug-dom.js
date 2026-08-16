const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, storageState: './storageState.json' });
  const page = await context.newPage();
  const url = 'https://bvrhm.hosoyte.com/v2/#/HSBA/DsBenhAnChoKy?TrangThai=ChoDuyet';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(15000);
  console.log('URL:', page.url());
  const rows = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('button, a, span, div, i')];
    const result = [];
    for (const el of nodes) {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const cls = (el.className || '').toString();
      const role = el.getAttribute('role') || '';
      const aria = el.getAttribute('aria-label') || '';
      if (!text && !cls && !role && !aria) continue;
      const haystack = `${text} ${cls} ${role} ${aria}`;
      if (/G?i|g?i|Luu|luu|Ký|ký|Duyet|duyet|Xác|xac|CÓ|Có|tr?|approve|confirm|archive|btn|modal|dialog/i.test(haystack)) {
        result.push({ tag: el.tagName, text: text.slice(0, 120), cls: cls.slice(0, 120), role, aria: aria.slice(0,120) });
      }
    }
    return result.slice(0, 250);
  });
  console.log(JSON.stringify(rows, null, 2));
  const bodyText = await page.locator('body').textContent();
  console.log('BODY_SNIPPET_START');
  console.log((bodyText || '').slice(0, 5000));
  console.log('BODY_SNIPPET_END');
  await browser.close();
})();
