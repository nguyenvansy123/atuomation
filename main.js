const { chromium } = require('playwright');
const fs = require('fs');
const log = require('./logger');

const STORAGE_STATE_PATH = './storageState.json';
const LIST_PAGE_URL =
  'https://bvrhm.hosoyte.com/v2/#/HSBA/DsBenhAnChoKy?TrangThai=ChoDuyet';
const DETAIL_URL_TEMPLATE =
  'https://bvrhm.hosoyte.com/v2/#/HSBA/ChiTietBenhAn/{id}';

const HEADLESS = true;
const NAV_TIMEOUT_MS = 60_000;
const REQUIRED_DOC_NAME = 'Phiếu giao nhận hồ sơ bệnh án';

function formatApiDate(date) {
  return new Date(date).toISOString().slice(0, 19).replace('T', ' ');
}

function getFilterRange() {
  const from = new Date('2025-02-27T00:00:00');
  const to = new Date();
  to.setDate(to.getDate() + 1);
  return { from: formatApiDate(from), to: formatApiDate(to) };
}

const FILTERS = Object.freeze({
  isCapCuu: 'false',
  iBaoHiem: '2',
  NamVien: 'false',
  from: getFilterRange().from,
  to: getFilterRange().to,
  idKhoa: '00000000-0000-0000-0000-000000000000',
  idCanBo: 'undefined',
  maLoaiBenhAn: '',
  strsearch: '',
  iBADT: '2',
  MaTrangThaiNode: 'DONE',
  pageIndex: '1',
  pageSize: '50',
  Active: 'true',
  TrangThaiKy: 'ChoDuyet',
  idTruongKhoaKy: 'undefined',
  idNguoiDuyet: 'undefined',
});

function cleanLogValue(value) {
  if (value == null || value === '') return '(trống)';
  return String(value).replace(/\s+/g, ' ').trim();
}

function getRecordId(item) {
  return item?.Id || item?.id || item?.MaYTe || item?.MaBenhAn || item?.MABS;
}

function buildDetailUrl(item) {
  const id = getRecordId(item);
  if (!id) return null;
  return DETAIL_URL_TEMPLATE.replace('{id}', encodeURIComponent(id));
}

function normalizeText(str) {
  return String(str || '')
    .replace(/\s+/g, ' ')
    .replace(/\u00a0/g, ' ')
    .trim();
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

async function collectSidebarItems(page) {
  const selectors = [
    'aside',
    '.sidebar',
    '[class*="sidebar"]',
    '[role="navigation"]',
    '.left-menu',
    '.menu',
  ];

  for (const selector of selectors) {
    const count = await page.locator(selector).count();
    if (count > 0) {
      const texts = await page.locator(selector).allTextContents();
      return texts.flatMap((text) => String(text).split(/\n|\r/)).map(normalizeText).filter(Boolean);
    }
  }

  const bodyText = await page.locator('body').innerText();
  return bodyText.split(/\n|\r/).map(normalizeText).filter(Boolean);
}

async function evaluateSidebarState(page) {
  const sidebarItems = await collectSidebarItems(page);
  const listUnsign = sidebarItems.filter((item) => /chưa ký|chua ky/i.test(item));
  const requiredUnsign = sidebarItems.some(
    (item) => item.includes(REQUIRED_DOC_NAME) && /chưa ký|chua ky/i.test(item)
  );

  return {
    sidebarItems,
    hasUnsign: listUnsign.length > 0,
    requiredUnsign,
    totalUnsignCount: listUnsign.length,
    listUnsign,
  };
}

async function openDocumentRecord(page, item) {
  const detailUrl = buildDetailUrl(item);
  if (!detailUrl) {
    log.warn(item?.MaYTe || 'UNKNOWN', 'Không có ID hồ sơ để mở chi tiết.');
    return false;
  }

  await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT_MS }).catch(() => {});
  return true;
}

async function processDocument(page, item) {
  const itemKey = cleanLogValue(item.MaYTe || item.id || item.MaBenhAn || 'UNKNOWN');
  const patientName = cleanLogValue(item.HoTenBenhNhan || item.HoTenBN || '');

  const sidebarState = await evaluateSidebarState(page);

  if (!sidebarState.hasUnsign) {
    log.pendingReview(itemKey, `Không thấy mục nào có chữ "chưa ký" trong sidebar. Cần xem lại. Họ tên: ${patientName}`);
    return 'can_xem_lai';
  }

  if (sidebarState.totalUnsignCount > 1 || !sidebarState.requiredUnsign) {
    log.incomplete(
      itemKey,
      `Sidebar có mục chưa ký không chỉ là "${REQUIRED_DOC_NAME}". Họ tên: ${patientName}. Mục chưa ký: ${sidebarState.listUnsign.join(' | ')}`
    );
    return 'chua_hoan_thien';
  }

  await page.getByText(REQUIRED_DOC_NAME, { exact: false }).first().click().catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT_MS }).catch(() => {});

  const senderSigner = page.locator('button[title*="ký người giao hồ sơ" i], button[title*="ky nguoi giao ho so" i]').first();
  if (await senderSigner.count()) {
    log.incomplete(itemKey, `Phát hiện nút "ký người giao hồ sơ" trên mục "${REQUIRED_DOC_NAME}". Họ tên: ${patientName}`);
    return 'chua_hoan_thien';
  }

  const receiverSigner = page.locator('button[title*="Ký số Người nhận hồ sơ" i], button[title*="Ký số người nhận hồ sơ" i], button[title*="ký số người nhận hồ sơ" i]').first();
  if (!(await receiverSigner.count())) {
    log.pendingReview(itemKey, `Không thấy nút ký số người nhận hồ sơ trên "${REQUIRED_DOC_NAME}". Họ tên: ${patientName}`);
    return 'can_xem_lai';
  }

  await receiverSigner.click();
  await page.waitForTimeout(800);

  const signFileButton = page
    .locator('button.btn.btn-sm.btn-warning:has-text("Ký File"), button:has-text("Ký File")')
    .first();

  if (await signFileButton.count()) {
    await signFileButton.click();
    await page.waitForTimeout(800);
  }

  const confirmButton = page.locator('button:has-text("Đồng ý"), button:has-text("OK")').first();
  if (await confirmButton.count()) {
    await confirmButton.click();
    await page.waitForTimeout(1200);
  }

  log.signed(itemKey, `Đã ký hồ sơ thành công cho ${patientName}.`);
  return 'da_ky_ho_so';
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

    log.info('SYSTEM', `=== Bắt đầu xử lý hồ sơ ngoại trú từ ${FILTERS.from} đến ${FILTERS.to} ===`);
    await page.goto(LIST_PAGE_URL, {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT_MS,
    });

    const currentUser = await getCurrentUser(page);
    const { total, items } = await fetchItems(context, currentUser);
    log.info('SYSTEM', `Bộ lọc tìm thấy ${total} hồ sơ; xử lý ${items.length} hồ sơ trong trang hiện tại.`);

    for (const item of items) {
      const itemKey = cleanLogValue(item.MaYTe || item.id || item.MaBenhAn || 'UNKNOWN');
      const patientName = cleanLogValue(item.HoTenBenhNhan || item.HoTenBN || '');

      log.info(itemKey, `Bắt đầu xử lý hồ sơ: ${patientName}`);

      try {
        const opened = await openDocumentRecord(page, item);
        if (!opened) {
          log.pendingReview(itemKey, `Không mở được chi tiết hồ sơ. Họ tên: ${patientName}`);
          continue;
        }

        await processDocument(page, item);
      } catch (error) {
        log.error(itemKey, `Lỗi khi xử lý hồ sơ: ${error.message}`);
      }
    }

    log.info('SYSTEM', '=== Hoàn tất xử lý hồ sơ ===');
  } finally {
    await browser.close();
  }
})();