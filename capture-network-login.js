const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const TARGET_URL = process.env.TARGET_URL || 'https://bvrhm.hosoyte.com/v2/#/HSBA/DsBenhAnChoKy?TrangThai=ChoDuyet';
const LOGIN_URL = process.env.LOGIN_URL || 'https://bvrhm.hosoyte.com/v2/';
const OUTPUT_DIR = path.join(__dirname, 'logs');
const WAIT_AFTER_LOGIN_MS = Number(process.env.WAIT_AFTER_LOGIN_MS || 20000);
const OUTPUT_FILE = path.join(OUTPUT_DIR, `network-capture-${Date.now()}.json`);

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function safeParseJson(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    return raw;
  }
}

function truncate(str, maxLen = 30000) {
  if (str == null) return null;
  const text = String(str);
  return text.length > maxLen ? text.slice(0, maxLen) + '... [trimmed]' : text;
}

function waitForEnter() {
  return new Promise((resolve) => {
    console.log('\nBạn đã đăng nhập xong? Nhấn Enter để bắt toàn bộ request API hiện tại...');
    process.stdin.once('data', () => resolve());
  });
}

(async () => {
  ensureDir(OUTPUT_DIR);
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  const collected = [];
  const requestInfoByRequest = new Map();

  page.on('request', (request) => {
    requestInfoByRequest.set(request, {
      time: new Date().toISOString(),
      method: request.method(),
      url: request.url(),
      headers: request.headers(),
      postData: request.postData ? request.postData() : null,
      resourceType: request.resourceType(),
    });
  });

  page.on('response', async (response) => {
    const request = response.request();
    const base = requestInfoByRequest.get(request) || {
      time: new Date().toISOString(),
      method: request.method(),
      url: request.url(),
      headers: request.headers(),
      postData: request.postData ? request.postData() : null,
      resourceType: request.resourceType(),
    };

    let bodyText = null;
    let bodyJson = null;

    try {
      const raw = await response.text();
      bodyText = truncate(raw, 40000);
      bodyJson = safeParseJson(raw);
    } catch (error) {
      bodyText = `[Không đọc được body: ${error.message}]`;
    }

    collected.push({
      ...base,
      status: response.status(),
      statusText: response.statusText(),
      responseHeaders: response.headers(),
      contentType: response.headers()['content-type'] || '',
      responseBodyText: bodyText,
      responseBodyJson: bodyJson,
    });
  });

  try {
    console.log('Mở trang login...');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });

    console.log('Mở trang mục tiêu...');
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });

    await waitForEnter();

    console.log('Đang chờ trang gọi API trong', WAIT_AFTER_LOGIN_MS / 1000, 'giây...');
    await page.waitForTimeout(WAIT_AFTER_LOGIN_MS);

    const summary = collected.map((item) => ({
      time: item.time,
      method: item.method,
      status: item.status,
      url: item.url,
      contentType: item.contentType,
      resourceType: item.resourceType,
    }));

    const outputData = {
      capturedAt: new Date().toISOString(),
      targetUrl: TARGET_URL,
      totalRequests: collected.length,
      requests: collected,
    };

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(outputData, null, 2), 'utf8');

    console.log('\n=== Kết quả bắt API ===');
    console.log(`Tổng request/response ghi được: ${collected.length}`);
    console.log(`File lưu ở: ${OUTPUT_FILE}`);

    if (summary.length === 0) {
      console.log('Không ghi nhận request nào trong thời gian đó. Có thể trang chưa gọi API hoặc bạn chưa login đúng.');
    } else {
      summary.forEach((item, index) => {
        console.log(`${index + 1}. ${item.method} ${item.status} ${item.url}`);
      });
    }

    console.log('\nBạn có thể mở file JSON này để đọc body, payload, và dữ liệu trả về để phân tích.');
  } catch (error) {
    console.error('Lỗi:', error.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
