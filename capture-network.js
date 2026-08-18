const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const TARGET_URL = process.env.TARGET_URL || 'https://bvrhm.hosoyte.com/v2/#/HSBA/DsBenhAnChoKy?TrangThai=ChoDuyet';
const OUTPUT_DIR = path.join(__dirname, 'logs');
const OUTPUT_FILE = path.join(OUTPUT_DIR, `api-capture-${Date.now()}.json`);
const WAIT_AFTER_LOAD_MS = Number(process.env.WAIT_AFTER_LOAD_MS || 15000);

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function safeJsonParse(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    return raw;
  }
}

function truncate(value, max = 20000) {
  if (value == null) return null;
  const text = String(value);
  return text.length > max ? text.slice(0, max) + '... [truncated]' : text;
}

(async () => {
  ensureDir(OUTPUT_DIR);

  const browser = await chromium.launch({
    headless: false,
  });

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    recordHar: false,
  });

  const page = await context.newPage();
  const requests = [];
  const requestMeta = new Map();

  page.on('request', (request) => {
    const method = request.method();
    const url = request.url();
    const headers = request.headers();
    const postData = request.postData ? request.postData() : null;

    requestMeta.set(request, {
      timestamp: new Date().toISOString(),
      method,
      url,
      headers,
      postData,
      type: 'request',
    });
  });

  page.on('response', async (response) => {
    const request = response.request();
    const meta = requestMeta.get(request) || {
      timestamp: new Date().toISOString(),
      method: request.method(),
      url: request.url(),
      headers: request.headers(),
      postData: request.postData ? request.postData() : null,
      type: 'request',
    };

    let bodyText = null;
    let bodyJson = null;

    try {
      const rawText = await response.text();
      bodyText = truncate(rawText, 30000);
      bodyJson = safeJsonParse(rawText);
    } catch (error) {
      bodyText = `[Không đọc được body: ${error.message}]`;
    }

    requests.push({
      ...meta,
      type: 'response',
      status: response.status(),
      statusText: response.statusText(),
      responseHeaders: response.headers(),
      contentType: response.headers()['content-type'] || '',
      responseBodyText: bodyText,
      responseBodyJson: bodyJson,
    });
  });

  console.log('Mở trình duyệt và truy cập:', TARGET_URL);

  try {
    await page.goto(TARGET_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 120000,
    });

    await page.waitForTimeout(WAIT_AFTER_LOAD_MS);

    const summary = requests
      .map((item) => ({
        method: item.method,
        url: item.url,
        status: item.status,
        type: item.contentType,
      }));

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(summary, null, 2), 'utf8');

    console.log('\n=== Tổng hợp request đã lưu ===');
    console.log(`Số request/response ghi được: ${summary.length}`);
    console.log(`File lưu: ${OUTPUT_FILE}`);

    if (summary.length === 0) {
      console.log('Không thấy request nào được gửi trong thời gian chờ. Có thể site chưa gọi API hoặc bạn đang ở trang login.');
    } else {
      summary.forEach((item, index) => {
        console.log(`${index + 1}. ${item.method} ${item.status} ${item.url}`);
      });
    }

    console.log('\nBạn có thể mở file JSON này để xem chi tiết toàn bộ response body.');
    console.log('Nếu cần, hãy đổi TARGET_URL bằng URL trang cụ thể hoặc login xong rồi chạy lại.');
  } catch (error) {
    console.error('Lỗi khi mở trang:', error.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
