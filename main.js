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
const PAGE_SIZE = 50;

// TEST: giới hạn số hồ sơ xử lý để kiểm tra trước khi chạy full.
// Đặt null (hoặc 0) để chạy toàn bộ danh sách như bình thường.
const TEST_LIMIT = 50;

function formatApiDate(date) {
  return new Date(date).toISOString().slice(0, 19).replace('T', ' ');
}

function getFilterRange() {
  const from = new Date('2025-02-27T00:00:00');
  const to = new Date();
  to.setDate(to.getDate() + 1);
  return { from: formatApiDate(from), to: formatApiDate(to) };
}

// Gọi 1 lần duy nhất, dùng chung cho cả FILTERS lẫn log
const { from: FILTER_FROM, to: FILTER_TO } = getFilterRange();

const BASE_FILTERS = Object.freeze({
  isCapCuu: 'false',
  iBaoHiem: '2',
  NamVien: 'false',
  from: FILTER_FROM,
  to: FILTER_TO,
  idKhoa: '00000000-0000-0000-0000-000000000000',
  idCanBo: 'undefined',
  maLoaiBenhAn: '',
  strsearch: '',
  iBADT: '2',
  MaTrangThaiNode: 'DONE',
  pageSize: String(PAGE_SIZE),
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

/**
 * Gọi API lấy 1 trang dữ liệu theo pageIndex.
 */
async function fetchItemsPage(context, currentUser, pageIndex) {
  const url = new URL(
    `https://bvrhm.hosoyte.com/api/${currentUser.Domain}/dieutri/bachoduyetky`
  );
  const filters = { ...BASE_FILTERS, pageIndex: String(pageIndex) };
  for (const [key, value] of Object.entries(filters)) {
    url.searchParams.set(key, value);
  }

  const response = await context.request.get(url.toString(), {
    headers: { authorization: `Bearer ${currentUser.access_token}` },
    timeout: NAV_TIMEOUT_MS,
  });
  if (!response.ok()) {
    throw new Error(`API danh sách trả về HTTP ${response.status()} (trang ${pageIndex}).`);
  }

  const payload = await response.json();
  if (!Array.isArray(payload.List)) {
    throw new Error(`API danh sách không trả về trường List hợp lệ (trang ${pageIndex}).`);
  }
  return { total: Number(payload.total) || 0, items: payload.List };
}

/**
 * FIX: Lặp qua toàn bộ các trang cho đến khi lấy đủ `total` bản ghi,
 * thay vì chỉ lấy 50 bản ghi đầu tiên rồi dừng.
 */
async function fetchAllItems(context, currentUser) {
  const allItems = [];
  let pageIndex = 1;
  let total = 0;

  while (true) {
    const page = await fetchItemsPage(context, currentUser, pageIndex);
    // total = page.total;
    total = 50;
    allItems.push(...page.items);

    log.info(
      'SYSTEM',
      `Đã tải trang ${pageIndex}: +${page.items.length} hồ sơ (tổng cộng ${allItems.length}/${total}).`
    );

    if (page.items.length === 0 || allItems.length >= total) break;
    pageIndex += 1;
  }

  return { total, items: allItems };
}

async function evaluateSidebarState(page) {
  const sidebarState = await page.evaluate((requiredDocName) => {
    const lists = Array.from(document.querySelectorAll('ul.toc-list li')).filter(
      (li) => !li.hasAttribute('hidden')
    );

    const items = lists
      .map((listItem) => {
        const anchors = Array.from(listItem.querySelectorAll('a'));
        if (anchors.length === 0) return null;

        const text = anchors
          .map((anchor) => anchor.textContent.replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .join(' | ');
        const hasUnsigned = /chưa ký|chua ky/i.test(text);
        const anchorCount = anchors.length;
        const isRequired = text.includes(requiredDocName) ||
          (anchors[0]?.getAttribute('title') || '').includes(requiredDocName);

        return { text, anchorCount, hasUnsigned, isRequired };
      })
      .filter(Boolean);

    const requiredUnsign = items.filter(
      (item) => item.hasUnsigned && item.isRequired && item.anchorCount === 1
    );
    const ignoredUnsign = items.filter(
      (item) => item.hasUnsigned && !(item.isRequired && item.anchorCount === 1)
    );

    return {
      sidebarItems: items.map((item) => item.text),
      unsignedItems: items.filter((item) => item.hasUnsigned).map((item) => item.text),
      hasUnsign: requiredUnsign.length > 0,
      totalUnsignCount: requiredUnsign.length,
      listUnsign: requiredUnsign.map((item) => item.text),
      ignoredUnsign: ignoredUnsign.map((item) => item.text),
      ignoredUnsignCount: ignoredUnsign.length,
      listIgnoredUnsign: ignoredUnsign.map((item) => item.text),
    };
  }, REQUIRED_DOC_NAME);

  return sidebarState;
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

  if (sidebarState.ignoredUnsignCount > 0) {
    log.info(
      itemKey,
      `Bỏ qua các mục chưa ký không liên quan: ${sidebarState.listIgnoredUnsign.join(' | ')}. Họ tên: ${patientName}`
    );
  }

  if (!sidebarState.hasUnsign) {
    log.pendingReview(
      itemKey,
      `Không thấy mục "${REQUIRED_DOC_NAME}" đang ở trạng thái "chưa ký" trong sidebar. Họ tên: ${patientName}`
    );
    return 'can_xem_lai';
  }

  if (sidebarState.totalUnsignCount > 1) {
    log.incomplete(
      itemKey,
      `Sidebar có hơn 1 mục "${REQUIRED_DOC_NAME}" ở trạng thái chưa ký. Họ tên: ${patientName}. Mục chưa ký: ${sidebarState.listUnsign.join(' | ')}`
    );
    return 'chua_hoan_thien';
  }

  // FIX: không nuốt lỗi im lặng — kiểm tra element tồn tại trước khi click,
  // và log rõ nếu không click được thay vì chạy tiếp như không có chuyện gì.
  const docLink = page.getByText(REQUIRED_DOC_NAME, { exact: false }).first();
  if ((await docLink.count()) === 0) {
    log.pendingReview(
      itemKey,
      `Không tìm thấy liên kết "${REQUIRED_DOC_NAME}" trong sidebar để mở. Họ tên: ${patientName}`
    );
    return 'can_xem_lai';
  }
  try {
    await docLink.click();
  } catch (error) {
    log.error(itemKey, `Không click được vào "${REQUIRED_DOC_NAME}": ${error.message}`);
    return 'can_xem_lai';
  }
  await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT_MS }).catch(() => {});

  const senderSigner = page.locator(
    'button[title*="ký người giao hồ sơ" i], button[title*="ky nguoi giao ho so" i]'
  ).first();
  if (await senderSigner.count()) {
    log.incomplete(itemKey, `Phát hiện nút "ký người giao hồ sơ" trên mục "${REQUIRED_DOC_NAME}". Họ tên: ${patientName}`);
    return 'chua_hoan_thien';
  }

  const receiverSigner = page.locator(
    'button[title*="Ký số Người nhận hồ sơ" i], button[title*="Ký số người nhận hồ sơ" i], button[title*="ký số người nhận hồ sơ" i]'
  ).first();
  if (!(await receiverSigner.count())) {
    log.pendingReview(itemKey, `Không thấy nút ký số người nhận hồ sơ trên "${REQUIRED_DOC_NAME}". Họ tên: ${patientName}`);
    return 'can_xem_lai';
  }

  try {
    await receiverSigner.click();
  } catch (error) {
    log.error(itemKey, `Không click được nút ký số người nhận hồ sơ: ${error.message}`);
    return 'can_xem_lai';
  }
  await page.waitForTimeout(800);

  const signFileButton = page
    .locator('button.btn.btn-sm.btn-warning:has-text("Ký File"), button:has-text("Ký File")')
    .first();

  if (await signFileButton.count()) {
    try {
      await signFileButton.click();
    } catch (error) {
      log.error(itemKey, `Không click được nút "Ký File": ${error.message}`);
      return 'can_xem_lai';
    }
    await page.waitForTimeout(800);
  }

  const confirmButton = page.locator('button:has-text("Đồng ý"), button:has-text("OK")').first();
  if (await confirmButton.count()) {
    try {
      await confirmButton.click();
    } catch (error) {
      log.error(itemKey, `Không click được nút xác nhận (Đồng ý/OK): ${error.message}`);
      return 'can_xem_lai';
    }
    await page.waitForTimeout(1200);
  }

  // FIX: xác nhận việc ký thực sự thành công bằng cách đọc lại sidebar,
  // thay vì mặc định thành công chỉ vì đã click xong các nút.
  const afterSignState = await evaluateSidebarState(page);
  if (afterSignState.hasUnsign) {
    log.incomplete(
      itemKey,
      `Đã thao tác ký nhưng "${REQUIRED_DOC_NAME}" vẫn đang ở trạng thái chưa ký sau khi xác nhận. Họ tên: ${patientName}`
    );
    return 'chua_hoan_thien';
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

    log.info('SYSTEM', `=== Bắt đầu xử lý hồ sơ ngoại trú từ ${FILTER_FROM} đến ${FILTER_TO} ===`);
    await page.goto(LIST_PAGE_URL, {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT_MS,
    });

    const currentUser = await getCurrentUser(page);
    const { total, items } = await fetchAllItems(context, currentUser);
    log.info('SYSTEM', `Bộ lọc tìm thấy ${total} hồ sơ; đã tải đủ ${items.length} hồ sơ để xử lý.`);

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