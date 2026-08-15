const { chromium } = require('playwright');
const fs = require('fs');

const STORAGE_STATE_PATH = './storageState.json';
const APP_URL = 'https://bvrhm.hosoyte.com/v2/#/HSBA/DsBenhAnChoKy?TrangThai=ChoDuyet';

function hasValidStoredUser() {
  if (!fs.existsSync(STORAGE_STATE_PATH)) return false;

  try {
    const raw = fs.readFileSync(STORAGE_STATE_PATH, 'utf8');
    const state = JSON.parse(raw);
    const origin = state.origins?.find((item) => item.origin === 'https://bvrhm.hosoyte.com');
    const localStorage = origin?.localStorage || [];
    const currentUser = localStorage.find((item) => item.name === 'currentUser');
    if (!currentUser?.value) return false;

    const parsed = JSON.parse(currentUser.value);
    return Boolean(parsed?.access_token && parsed?.Domain);
  } catch (error) {
    return false;
  }
}

(async () => {
  if (!hasValidStoredUser()) {
    console.log('Chưa có session hợp lệ. Hãy chạy: node login.js');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    storageState: STORAGE_STATE_PATH,
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  console.log('Đã mở app bằng session đã lưu. Bây giờ bạn có thể đặt lệnh automation cho phần ký hồ sơ.');

  // Ví dụ các bước sau này bạn tự viết tiếp:
  // await page.locator('...').click();
  // await page.locator('...').fill('...');
  // await page.getByText('...').click();

  // Giữ browser mở để bạn test thủ công hoặc debug từng bước.
  console.log('Nhấn Ctrl+C để dừng browser.');
  await new Promise(() => {});
})();
