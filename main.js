const { chromium } = require('playwright');
const fs = require('fs');
const log = require('./logger');

const STORAGE_STATE_PATH = './storageState.json';
const LIST_PAGE_URL =
  'https://bvrhm.hosoyte.com/v2/#/HSBA/DsBenhAnChoKy?TrangThai=ChoDuyet';

const HEADLESS = true;
const NAV_TIMEOUT_MS = 60_000;
const FILTERS = Object.freeze({
  isCapCuu: 'false',
  iBaoHiem: '2',
  NamVien: 'false',
  from: '2025-02-27T00:00:00',
  to: '2025-12-30T23:59:59',
  idKhoa: '00000000-0000-0000-0000-000000000000',
  idCanBo: 'undefined',
  maLoaiBenhAn: '',
  strsearch: '',
  iBADT: '2',
  MaTrangThaiNode: 'DONE',
  pageIndex: '1',
  pageSize: '10',
  Active: 'true',
  TrangThaiKy: 'ChoDuyet',
  idTruongKhoaKy: 'undefined',
  idNguoiDuyet: 'undefined',
});
function cleanLogValue(value) {
  if (value == null || value === '') return '(trống)';
  return String(value).replace(/\s+/g, ' ').trim();
}

async function getCurrentUser(page) {
  await page.waitForFunction(() => localStorage.getItem('currentUser'), null, {
    timeout: NAV_TIMEOUT_MS,
  });
  const currentUser = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('currentUser'))
  );

  if (!currentUser?.Domain || !currentUser?.access_token) {
    throw new Error('Phiên đăng nhập không hợp lệ. Hãy chạy "node login.js" lại.');
  }
  return currentUser;
}

async function fetchItems(context, currentUser) {
  const url = new URL(
    `https://bvrhm.hosoyte.com/api/${currentUser.Domain}/dieutri/bachoduyetky`
  );
  for (const [key, value] of Object.entries(FILTERS)) {
    url.searchParams.set(key, value);
  }

  const response = await context.request.get(url.toString(), {
    headers: { authorization: `Bearer ${currentUser.access_token}` },
    timeout: NAV_TIMEOUT_MS,
  });
  if (!response.ok()) {
    throw new Error(`API danh sách trả về HTTP ${response.status()}.`);
  }

  const payload = await response.json();
  if (!Array.isArray(payload.List)) {
    throw new Error('API danh sách không trả về trường List hợp lệ.');
  }
  return { total: Number(payload.total) || 0, items: payload.List };
}

(async () => {
    if (!fs.existsSync(STORAGE_STATE_PATH)) {
      throw new Error(`Không tìm thấy ${STORAGE_STATE_PATH}. Hãy chạy "node login.js" trước.`);
    }
  
    const browser = await chromium.launch({ headless: HEADLESS });
  
    try {
      const context = await browser.newContext({
        storageState: STORAGE_STATE_PATH,
        ignoreHTTPSErrors: true,
      });
      const page = await context.newPage();
  
      log.info('SYSTEM', '=== Bắt đầu đọc thử 10 hồ sơ, không thay đổi dữ liệu ===');
      await page.goto(LIST_PAGE_URL, {
        waitUntil: 'domcontentloaded',
        timeout: NAV_TIMEOUT_MS,
      });
  
      const currentUser = await getCurrentUser(page);
      const { total, items } = await fetchItems(context, currentUser);
      log.info('SYSTEM', `Bộ lọc tìm thấy ${total} hồ sơ; đọc trang đầu ${items.length} hồ sơ.`);
  
      for (const item of items) {
        const maYTe = cleanLogValue(item.MaYTe);
        const hoTen = cleanLogValue(item.HoTenBenhNhan || item.HoTenBN);
        const ngayVaoVien = cleanLogValue(item.NgayVaoVien);
        log.info(maYTe, `Mã y tế: ${maYTe} | Họ tên: ${hoTen} | Ngày vào viện: ${ngayVaoVien}`);
      }
  
      log.info('SYSTEM', `=== Hoàn tất đọc ${items.length} hồ sơ ===`);
    } finally {
      await browser.close();
    }
})();