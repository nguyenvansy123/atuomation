/**
 * login.js
 * -----------------------------------------------------------
 * Chạy 1 LẦN để đăng nhập thủ công (hoặc tự động) rồi lưu lại
 * session vào file storageState.json. Các script sau (main.js)
 * sẽ dùng file này để vào thẳng trang web mà không cần login lại.
 *
 * Chạy: node login.js
 * -----------------------------------------------------------
 */

const { chromium } = require('playwright');

// ==== CHỈNH LẠI CHO ĐÚNG WEBSITE CỦA BẠN ====
const LOGIN_URL = 'https://bvrhm.hosoyte.com/v2/#/HSBA/DsBenhAnChoKy?TrangThai=ChoDuyet';
const STORAGE_STATE_PATH = './storageState.json';

// Nếu muốn đăng nhập tự động, điền thông tin + selector vào đây.
// Nếu muốn tự tay đăng nhập (an toàn hơn, tránh lộ mật khẩu trong code),
// để trống 2 dòng dưới, script sẽ mở trình duyệt và CHỜ bạn đăng nhập
// xong rồi bấm Enter trong terminal.
const AUTO_LOGIN = false;
const USERNAME = process.env.SITE_USERNAME || '';
const PASSWORD = process.env.SITE_PASSWORD || '';

(async () => {
  const browser = await chromium.launch({ headless: false }); // headless:false để nhìn thấy màn hình login
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(LOGIN_URL, { waitUntil: 'load' });

  if (AUTO_LOGIN) {
    // ==== CHỈNH SELECTOR CHO ĐÚNG FORM LOGIN CỦA BẠN ====
    await page.fill('#username', USERNAME);
    await page.fill('#password', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForLoadState('networkidle');
  } else {
    console.log('>>> Trình duyệt đã mở. Hãy đăng nhập thủ công.');
    console.log('>>> Sau khi đăng nhập XONG, quay lại đây và nhấn Enter...');
    await new Promise((resolve) => {
      process.stdin.once('data', () => resolve());
    });
  }

  await context.storageState({ path: STORAGE_STATE_PATH });
  console.log(`Đã lưu session vào ${STORAGE_STATE_PATH}`);

  await browser.close();
  process.exit(0);
})();
