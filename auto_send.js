const fs = require('node:fs');
const { chromium } = require('playwright');
const { readFilterConfig } = require('./filter-config');
const log = require('./logger');

const STORAGE_STATE_PATH = './storageState.json';
const LOGIN_URL = 'https://bvrhm.hosoyte.com/v2/';
const LIST_PAGE_URL = 'https://bvrhm.hosoyte.com/v2/#/HSBA/DsBenhAnChoKy?TrangThai=ChoDuyet';
const DETAIL_URL_TEMPLATE = 'https://bvrhm.hosoyte.com/v2/#/view/HSBA/HsBenhAn/{id}/HSBA%2FDsBenhAnChoKy';
const NAV_TIMEOUT_MS = 60_000;
const DEFAULT_PAGE_SIZE = 50;

function normalizeFilters(filters = {}) {
  const next = { ...filters };

  if (!next.pageSize || Number(next.pageSize) <= 0) {
    next.pageSize = String(DEFAULT_PAGE_SIZE);
  }

  if (!next.NamVien || next.NamVien === 'false' || next.NamVien === false) {
    next.NamVien = 'iALL';
  }

  if (!next.TrangThaiKy) {
    next.TrangThaiKy = 'ChoDuyet';
  }

  if (!next.MaTrangThaiNode) {
    next.MaTrangThaiNode = 'DONE';
  }

  return next;
}

function normalizeText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\u00a0/g, ' ')
    .trim();
}

function getRecordId(item) {
  return item?.Id || item?.id || item?.MaYTe || item?.MaBenhAn || item?.MABS || null;
}

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

async function ensureAuthenticated(browser) {
  if (hasValidStoredUser()) {
    log.info('SYSTEM', 'Đã phát hiện session hợp lệ trong storageState.json. Tiếp tục xử lý.');
    return;
  }

  const loginContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const loginPage = await loginContext.newPage();

  log.info('SYSTEM', 'Chưa có session hợp lệ. Mở trang đăng nhập để bạn đăng nhập thủ công...');
  await loginPage.goto(LOGIN_URL, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });

  log.info('SYSTEM', 'Sau khi đăng nhập xong, hãy nhấn Enter trong terminal để script tiếp tục.');
  await new Promise((resolve) => {
    process.stdin.once('data', () => resolve());
  });

  await loginContext.storageState({ path: STORAGE_STATE_PATH });
  log.info('SYSTEM', `Đã lưu session mới vào ${STORAGE_STATE_PATH}.`);
  await loginContext.close();
}

async function getCurrentUser(page) {
  await page.waitForFunction(() => localStorage.getItem('currentUser'), null, {
    timeout: NAV_TIMEOUT_MS,
  });

  const currentUser = await page.evaluate(() => {
    const raw = localStorage.getItem('currentUser');
    return raw ? JSON.parse(raw) : null;
  });

  if (!currentUser?.Domain || !currentUser?.access_token) {
    throw new Error('Phiên đăng nhập không hợp lệ. Hãy chạy "node login.js" lại.');
  }

  return currentUser;
}

async function fetchListPage(context, currentUser, pageIndex, filters) {
  const domain = currentUser.Domain;
  const normalizedFilters = normalizeFilters(filters);
  const listUrl = new URL(`https://bvrhm.hosoyte.com/api/${domain}/dieutri/bachoduyetky`);
  const params = {
    ...normalizedFilters,
    pageIndex: String(pageIndex),
    pageSize: String(normalizedFilters.pageSize || DEFAULT_PAGE_SIZE),
  };

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    listUrl.searchParams.set(key, String(value));
  }

  log.info('SYSTEM', `Gọi API danh sách: ${listUrl.toString()}`);

  const response = await context.request.get(listUrl.toString(), {
    headers: { authorization: `Bearer ${currentUser.access_token}` },
    timeout: NAV_TIMEOUT_MS,
  });

  if (!response.ok()) {
    throw new Error(`API danh sách lỗi HTTP ${response.status()} ở trang ${pageIndex}.`);
  }

  const payload = await response.json();
  if (!payload || typeof payload !== 'object') {
    throw new Error(`API danh sách trả về dữ liệu không hợp lệ tại trang ${pageIndex}.`);
  }

  return {
    total: Number(payload.total) || 0,
    items: Array.isArray(payload.List) ? payload.List : [],
  };
}

async function openDetailPage(page, item) {
  const recordId = getRecordId(item);
  if (!recordId) return null;

  const detailUrl = DETAIL_URL_TEMPLATE.replace('{id}', encodeURIComponent(recordId));
  await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT_MS }).catch(() => {});
  return detailUrl;
}

async function checkReceiverSignedInDetail(page, currentUser, recordId) {
  return page.evaluate(
    async ({ recordId, domain, token }) => {
      const url = `https://bvrhm.hosoyte.com/api/${domain}/hsdikembenhan/hsDiKem/${encodeURIComponent(recordId)}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        return { found: false, reason: `http_${response.status}` };
      }

      const text = await response.text();
      let payload = text;
      try {
        payload = JSON.parse(text);
      } catch (error) {
        // ignore
      }

      const items = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.List)
          ? payload.List
          : Array.isArray(payload?.data)
            ? payload.data
            : [];

      const matched = items.find((item) => {
        const maViTri = String(item?.MaViTri ?? item?.maViTri ?? '').replace(/\s+/g, ' ').trim();
        const tenViTri = String(item?.TenViTri ?? item?.tenViTri ?? '').replace(/\s+/g, ' ').trim();
        const combinedText = `${maViTri} ${tenViTri}`;
        const isReceiver = maViTri === 'NguoiNhanHoSo' || /NguoiNhanHoSo|Người nhận hồ sơ/i.test(combinedText);
        return isReceiver && item?.IsDaKy === true;
      });

      return matched ? { found: true, item: matched } : { found: false, count: items.length };
    },
    { recordId, domain: currentUser.Domain, token: currentUser.access_token }
  );
}

async function sendSignedRecordToManager(context, currentUser, recordId) {
  const userId = currentUser.id || currentUser.Id || currentUser.userId || null;
  if (!recordId) {
    return { ok: false, reason: 'missing_record_id' };
  }

  if (!userId) {
    return { ok: false, reason: 'missing_user_id' };
  }

  const url = `https://bvrhm.hosoyte.com/api/${currentUser.Domain}/dieutri//${recordId}/guitruongkhoa?idBenhAn=${recordId}&idCanBo=${userId}&action=4`;

  try {
    const response = await context.request.fetch(url, {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${currentUser.access_token}`,
        'Content-Type': 'application/json',
      },
      timeout: NAV_TIMEOUT_MS,
    });

    const text = await response.text();
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      // keep raw text when not JSON
    }

    if (!response.ok()) {
      return { ok: false, status: response.status(), body: parsed };
    }

    return { ok: true, status: response.status(), body: parsed };
  } catch (error) {
    return { ok: false, reason: 'request_failed', error: error.message };
  }
}

async function processRecord(page, context, currentUser, item) {
  const recordId = getRecordId(item);
  const recordKey = normalizeText(item?.MaYTe || item?.MaBenhAn || item?.id || 'UNKNOWN');
  const patientName = normalizeText(item?.HoTenBenhNhan || item?.HoTenBN || '');

  if (!recordId) {
    log.warn(recordKey, `Bỏ qua hồ sơ vì không có ID. Họ tên: ${patientName || '(không rõ)'}`);
    return { status: 'skip_missing_id' };
  }

  log.info(recordKey, `Mở chi tiết hồ sơ ${recordId}. Họ tên: ${patientName || '(không rõ)'}`);
  await openDetailPage(page, item);

  const check = await checkReceiverSignedInDetail(page, currentUser, recordId);
  if (!check.found) {
    log.info(
      recordKey,
      `Bỏ qua hồ sơ ${recordId}: chưa có vị trí "Người nhận hồ sơ" với IsDaKy=true trong phiếu giao nhận hồ sơ bệnh án. ${check.reason ? `Reason: ${check.reason}` : `Số phần tử: ${check.count ?? 0}`}`
    );
    return { status: 'skip_not_signed' };
  }

  log.info(
    recordKey,
    `Phát hiện Người nhận hồ sơ đã ký trong chi tiết hồ sơ ${recordId}. IdHSDiKemBA=${check.item?.IdHSDiKemBA || check.item?.Id || '(không rõ)'}`
  );

  const sendResult = await sendSignedRecordToManager(context, currentUser, recordId);
  if (!sendResult.ok) {
    log.error(
      recordKey,
      `Gửi trưởng khoa thất bại cho hồ sơ ${recordId}. Kết quả: ${JSON.stringify(sendResult)}`
    );
    return { status: 'send_failed', result: sendResult };
  }

  log.info(
    recordKey,
    `Đã gửi trưởng khoa thành công cho hồ sơ ${recordId}. Kết quả: ${JSON.stringify(sendResult)}`
  );
  return { status: 'sent', result: sendResult };
}

async function main() {
  const browser = await chromium.launch({ headless: false });

  try {
    await ensureAuthenticated(browser);

    const context = await browser.newContext({
      storageState: STORAGE_STATE_PATH,
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();

    log.info('SYSTEM', 'Mở trang danh sách hồ sơ để lấy account/token hiện tại...');
    await page.goto(LIST_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    const currentUser = await getCurrentUser(page);

    const filters = readFilterConfig();
    const pageSize = Number(filters.pageSize || DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE;

    let pageIndex = 1;
    let total = 0;

    while (true) {
      const pageData = await fetchListPage(context, currentUser, pageIndex, filters);
      const items = Array.isArray(pageData.items) ? pageData.items : [];
      total = Number(pageData.total) || total || 0;

      if (!items.length) {
        log.info('SYSTEM', `Trang ${pageIndex} không còn dữ liệu. Dừng xử lý.`);
        break;
      }

      log.info('SYSTEM', `=== Xử lý trang ${pageIndex}${total ? `/${Math.ceil(total / pageSize)}` : ''} ===`);

      for (const item of items) {
        await processRecord(page, context, currentUser, item);
      }

      if (total > 0 && pageIndex * pageSize >= total) {
        log.info('SYSTEM', `Đã hết trang cuối cùng (${pageIndex}). Dừng xử lý.`);
        break;
      }

      if (items.length < pageSize) {
        log.info('SYSTEM', `Trang ${pageIndex} có ít hơn pageSize hồ sơ, coi như trang cuối. Dừng xử lý.`);
        break;
      }

      pageIndex += 1;
      log.info('SYSTEM', `Chuyển sang trang ${pageIndex} để tiếp tục.`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  log.error('SYSTEM', `Lỗi tổng thể: ${error.message}`);
  process.exitCode = 1;
});
