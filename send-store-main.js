const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const log = require('./logger');
const { readSendStoreFilterConfig } = require('./filter-config');

const STORAGE_STATE_PATH = './storageState.json';
const LIST_PAGE_URL = 'https://bvrhm.hosoyte.com/v2/#/HSBA/DsBenhAnChoKy?TrangThai=ChoDuyet';
const LOGIN_URL = 'https://bvrhm.hosoyte.com/v2/';
const NAV_TIMEOUT_MS = 60_000;
const PAGE_SIZE = 50;
const HEADLESS = false;
const TEST_LIMIT = 20;
const MAX_PAGE_TURNS = 20;
const SKIPPED_PATIENTS_PATH = path.join(__dirname, 'logs', 'skipped-patients.json');

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').replace(/\u00a0/g, ' ').trim();
}

function formatApiDate(date) {
  return new Date(date).toISOString().slice(0, 19).replace('T', ' ');
}

function getFilterRange() {
  const from = new Date('2025-02-27T00:00:00');
  const to = new Date();
  to.setDate(to.getDate() + 1);
  return { from: formatApiDate(from), to: formatApiDate(to) };
}

const { from: FILTER_FROM, to: FILTER_TO } = getFilterRange();

function getSavedFilters() {
  try {
    if (process.env.SEND_STORE_FILTER_CONFIG) {
      const parsed = JSON.parse(process.env.SEND_STORE_FILTER_CONFIG);
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch (error) {
    // ignore
  }

  try {
    return readSendStoreFilterConfig();
  } catch (error) {
    return {};
  }
}

const filterConfig = getSavedFilters();

function pickDisplayValue(item, keys) {
  for (const key of keys) {
    const value = item?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}

function cleanLogValue(value) {
  if (value == null || value === '') return '(trống)';
  return String(value).replace(/\s+/g, ' ').trim();
}

function saveSkippedPatient(patientKey, patientName, reason) {
  try {
    const logsDir = path.dirname(SKIPPED_PATIENTS_PATH);
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    let items = [];
    if (fs.existsSync(SKIPPED_PATIENTS_PATH)) {
      try {
        const raw = fs.readFileSync(SKIPPED_PATIENTS_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) items = parsed;
      } catch (error) {
        items = [];
      }
    }

    const entry = {
      patientKey,
      patientName: patientName || '(không rõ)',
      reason,
      savedAt: new Date().toISOString(),
    };

    const exists = items.some((item) => item.patientKey === patientKey || (item.patientName && item.patientName === patientName));
    if (!exists) {
      items.push(entry);
      fs.writeFileSync(SKIPPED_PATIENTS_PATH, JSON.stringify(items, null, 2), 'utf8');
    }
  } catch (error) {
    log.warn('SYSTEM', `Không lưu được hồ sơ bỏ qua vào file log: ${error.message}`);
  }
}

function markSkippedPatient(skippedPatients, patient, reason) {
  const patientKey = patient?.patientKey || normalizeText(patient?.patientName || patient?.maYTe || 'unknown');
  const patientName = patient?.patientName || patient?.maYTe || '(không rõ)';

  if (!skippedPatients.has(patientKey)) {
    skippedPatients.add(patientKey);
    saveSkippedPatient(patientKey, patientName, reason);
    log.warn('SYSTEM', `Bỏ qua hồ sơ lưu không được: ${patientName} (${patientKey}) - ${reason}`);
  }
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

  const currentUser = await page.evaluate(() => JSON.parse(localStorage.getItem('currentUser')));
  if (!currentUser?.Domain || !currentUser?.access_token) {
    throw new Error('Phiên đăng nhập không hợp lệ. Hãy chạy "node login.js" lại.');
  }

  return currentUser;
}

async function waitForUiFullyLoaded(page, waitMs = 10_000) {
  await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(waitMs);
  await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT_MS }).catch(() => {});

  const waitSelectors = [
    'table.table',
    '#tblBenhNhan',
    'tr:has(input.my-checks)',
    'button:has-text("Gửi lưu trữ")',
  ];

  for (const selector of waitSelectors) {
    try {
      await page.waitForSelector(selector, { timeout: 20_000 });
      break;
    } catch (error) {
      // thử chờ gần đủ UI nhưng không chặn script nếu selector chưa có ngay
    }
  }
}

async function applyFilterToPage(page, filters) {
  const mergedFilters = { ...readSendStoreFilterConfig(), ...(filters || {}) };
  log.info('SYSTEM', 'Bước 2: điền filter theo file filter-config.json lên giao diện web...');

  const formatDateForInput = (dateString, useNativeDateInput = false) => {
    if (!dateString) return '';

    const raw = String(dateString).trim();
    const [dayPart, timePart] = raw.split(' ');
    const isoDate = dayPart || raw;
    const date = new Date(isoDate.includes('/') ? isoDate.split('/').reverse().join('-') : isoDate.replace(' ', 'T'));

    if (Number.isNaN(date.getTime())) {
      return raw;
    }

    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');

    if (useNativeDateInput) {
      return `${yyyy}-${mm}-${dd}`;
    }

    const renderedTime = timePart ? ` ${timePart}` : '';
    return `${dd}/${mm}/${yyyy}${renderedTime}`;
  };

  const fromValueNative = formatDateForInput(mergedFilters.from || '2026-01-01 00:00:00', true);
  const toValueNative = formatDateForInput(mergedFilters.to || '2026-08-14 23:59:59', true);
  const fromValueDisplay = formatDateForInput(mergedFilters.from || '2026-01-01 00:00:00', false);
  const toValueDisplay = formatDateForInput(mergedFilters.to || '2026-08-14 23:59:59', false);

  const nativeDateInputs = page.locator('input[type="date"]');
  const customDateInputs = page.locator('app-date-time-picker input, input[name*="date"], input[placeholder*="dd/mm/yyyy"], input[placeholder*="yyyy"], input:not([type="hidden"]):not([type="date"])');

  if ((await nativeDateInputs.count()) >= 2) {
    await nativeDateInputs.nth(0).fill(fromValueNative, { timeout: 5000 }).catch(() => {});
    await nativeDateInputs.nth(1).fill(toValueNative, { timeout: 5000 }).catch(() => {});
  }

  if ((await customDateInputs.count()) >= 2) {
    await customDateInputs.nth(0).fill(fromValueDisplay, { timeout: 5000 }).catch(() => {});
    await customDateInputs.nth(1).fill(toValueDisplay, { timeout: 5000 }).catch(() => {});
  }

  const rowSizeValue = String(mergedFilters.pageSize || PAGE_SIZE);
  const rowSizeSelect = page.locator('select').filter({ has: page.locator('option') }).first();
  const rowSizeOption = page.locator('select option').filter({ hasText: rowSizeValue }).first();
  if ((await rowSizeSelect.count()) > 0 && (await rowSizeOption.count()) > 0) {
    await rowSizeSelect.selectOption({ label: (await rowSizeOption.textContent()) || rowSizeValue }).catch(() => {});
  }

  const khoaId = mergedFilters.idKhoaDieuTri || mergedFilters.idKhoa || '00000000-0000-0000-0000-000000000000';
  const statusValue = mergedFilters.TrangThaiKy || 'ChoDuyet';

  const selects = page.locator('select');
  const selectCount = await selects.count();
  for (let i = 0; i < selectCount; i += 1) {
    const select = selects.nth(i);
    const options = select.locator('option');
    const optionCount = await options.count();

    let matched = false;
    for (let j = 0; j < optionCount; j += 1) {
      const option = options.nth(j);
      const value = (await option.getAttribute('value')) || '';
      const text = normalizeText(await option.textContent().catch(() => ''));

      const isKhoaMatch = value === khoaId || (text.toLowerCase().includes('khoa') && value);
      if (isKhoaMatch && value) {
        await select.selectOption({ value }).catch(() => {});
        matched = true;
        break;
      }
    }

    if (matched) continue;

    for (let j = 0; j < optionCount; j += 1) {
      const option = options.nth(j);
      const value = (await option.getAttribute('value')) || '';
      const text = normalizeText(await option.textContent().catch(() => ''));
      const normalizedStatus = statusValue.toLowerCase();
      const statusMatch = value && (value.toLowerCase().includes(normalizedStatus) || text.toLowerCase().includes(normalizedStatus) || text.toLowerCase().includes('chờ') || text.toLowerCase().includes('duyệt'));
      if (statusMatch) {
        await select.selectOption({ value }).catch(() => {});
        break;
      }
    }
  }

  const statusSelect = page.locator('select').filter({ hasText: 'Chờ' }).first();
  if ((await statusSelect.count()) > 0) {
    const statusOptions = statusSelect.locator('option');
    const optionCount = await statusOptions.count();
    for (let i = 0; i < optionCount; i += 1) {
      const option = statusOptions.nth(i);
      const value = (await option.getAttribute('value')) || '';
      const text = normalizeText(await option.textContent().catch(() => ''));
      if (value === statusValue || text.toLowerCase().includes(statusValue.toLowerCase()) || text.toLowerCase().includes('chờ') || text.toLowerCase().includes('duyệt')) {
        await statusSelect.selectOption({ value: value || text }).catch(() => {});
        break;
      }
    }
  }

  const searchButtons = [
    page.locator('button:has-text("Tìm")'),
    page.locator('button:has-text("Lọc")'),
    page.locator('button:has-text("Tìm kiếm")'),
    page.locator('button i.fa-search').locator('..'),
    page.locator('button.btn-success.btn-sm'),
  ];
  for (const btn of searchButtons) {
    const count = await btn.count();
    if (count > 0) {
      try {
        await btn.first().click({ timeout: 5000 });
        break;
      } catch (error) {
        // bỏ qua nếu click không thành công
      }
    }
  }

  await page.waitForTimeout(3000);
  log.info('SYSTEM', `Đã áp dụng filter từ config: ${JSON.stringify({ from: fromValueDisplay, to: toValueDisplay, khoaId, statusValue, pageSize: rowSizeValue })}`);
}
function getPatientKey(row) {
  const text = normalizeText(row?.patientName || row?.maYTe || row?.recordId || '');
  return text || `row-${Math.random().toString(16).slice(2)}`;
}

async function getPatientRows(page) {
  const rows = page.locator('tbody#tblBenhNhan tr');
  const count = await rows.count();
  const result = [];

  for (let i = 0; i < count; i += 1) {
    const row = rows.nth(i);
    const cells = row.locator('td');
    const cellCount = await cells.count();
    if (cellCount < 1) continue;

    const patientNameCell = row.locator('td').nth(1);
    const patientText = normalizeText(await patientNameCell.textContent().catch(() => ''));
    const link = row.locator('a[href*="/view/HSBA/HsBenhAn/"]');
    const linkText = normalizeText(await link.first().textContent().catch(() => ''));
    const patientName = linkText || patientText || `BN_${i + 1}`;
    const maYTeCell = row.locator('td').first();
    const maYTeText = normalizeText(await maYTeCell.textContent().catch(() => ''));
    const sendButton = row.locator('button:has-text("Gửi lưu trữ")').first();
    const buttonCount = await sendButton.count();

    const patient = {
      patientName,
      maYTe: maYTeText,
      patientKey: getPatientKey({ patientName, maYTe: maYTeText }),
      sendArchiveButton: buttonCount ? sendButton : null,
    };

    if (buttonCount) {
      result.push(patient);
    }
  }

  return result;
}

async function clickOutsideModal(page) {
  const backdrop = page.locator('.modal-backdrop, .swal2-container, .modal, [role="dialog"]').first();
  if ((await backdrop.count()) > 0) {
    try {
      await backdrop.click({ force: true, timeout: 2000 });
      await page.waitForTimeout(500);
      return;
    } catch (error) {
      // thử phương án tiếp theo
    }
  }

  const viewport = page.viewportSize() || { width: 1280, height: 800 };
  const points = [
    { x: 5, y: 5 },
    { x: viewport.width - 5, y: 5 },
    { x: 5, y: viewport.height - 5 },
    { x: viewport.width - 5, y: viewport.height - 5 },
  ];

  for (const point of points) {
    try {
      await page.mouse.click(point.x, point.y);
      await page.waitForTimeout(500);
      return;
    } catch (error) {
      // thử điểm khác
    }
  }

  try {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  } catch (error) {
    // bỏ qua nếu không có modal
  }
}

async function clickConfirmButton(page) {
  const selectors = [
    'button.swal2-confirm',
    'button:has-text("CÓ")',
    'button:has-text("Có")',
    '.btn.btn-info:has-text("Xác nhận")',
    'button:has-text("Xác nhận")',
  ];

  for (const selector of selectors) {
    const button = page.locator(selector).first();
    const count = await button.count();
    if (count > 0) {
      try {
        await button.click({ timeout: 5000 });
        return true;
      } catch (error) {
        // thử selector kế tiếp
      }
    }
  }

  return false;
}

async function findNextPageButton(page) {
  const candidates = [
    page.locator('button:has-text("Next")').first(),
    page.locator('button:has-text("Sau")').first(),
    page.locator('a:has-text("Next")').first(),
    page.locator('a:has-text("Sau")').first(),
    page.locator('.page-item.active + .page-item a').first(),
    page.locator('button[aria-label="Next"]').first(),
  ];

  for (const candidate of candidates) {
    const count = await candidate.count();
    if (count > 0) {
      try {
        await candidate.click({ timeout: 5000 });
        return true;
      } catch (error) {
        // bỏ qua nếu không bấm được
      }
    }
  }

  return false;
}

async function clickArchiveAndHandle(page, row, skippedPatients) {
  const patientKey = row.patientKey;
  const name = row.patientName;

  try {
    await row.sendArchiveButton.click({ timeout: 10_000 });
  } catch (error) {
    log.warn('SYSTEM', `Timeout khi bấm "Gửi lưu trữ" cho ${name}. Tạo trạng thái lưu không thành công và bỏ qua hồ sơ: ${error.message}`);
    markSkippedPatient(skippedPatients, row, `click timeout: ${error.message}`);
    await clickOutsideModal(page);
    return 'failed_click';
  }

  await page.waitForTimeout(1500);

  const warningDialog = page.locator('.modal-dialog, .swal2-popup, [role="dialog"]').first();
  const modalCount = await warningDialog.count();
  if (modalCount === 0) {
    log.warn('SYSTEM', `Không thấy modal khi bấm gửi lưu trữ cho ${name}. Đây là hồ sơ lưu không thành công, bỏ qua để tìm bệnh nhân mới.`);
    markSkippedPatient(skippedPatients, row, 'không thấy modal sau khi click');
    await clickOutsideModal(page);
    return 'failed_click';
  }

  const modalText = normalizeText(await page.locator('.modal-body, .swal2-html-container').first().textContent().catch(() => ''));
  const isWarning = /Cảnh báo|Phiếu chưa hoàn thành ký|thiếu chữ ký|có:/i.test(modalText);

  if (isWarning) {
    log.info('SYSTEM', `Modal cảnh báo cho bệnh nhân ${name}: ${modalText}`);
    markSkippedPatient(skippedPatients, row, `modal cảnh báo: ${modalText}`);
    await clickOutsideModal(page);
    return 'warning';
  }

  const confirmClicked = await clickConfirmButton(page);
  if (!confirmClicked) {
    log.warn('SYSTEM', `Không bấm được nút xác nhận gửi lưu trữ cho ${name}. Hồ sơ này sẽ bị bỏ qua để tránh lặp lại.`);
    markSkippedPatient(skippedPatients, row, 'không bấm được nút xác nhận');
    await clickOutsideModal(page);
    return 'failed_click';
  }

  await page.waitForTimeout(3000);
  const stillHasArchiveButton = (await page.locator('button:has-text("Gửi lưu trữ")').count()) > 0;
  if (stillHasArchiveButton) {
    log.info('SYSTEM', `Gửi lưu trữ thành công cho ${name}. Trang đã reload và tiếp tục xử lý.`);
    await page.waitForTimeout(2000);
    return 'success';
  }

  log.info('SYSTEM', `Gửi lưu trữ xong cho ${name}. Kết thúc xử lý hiện tại.`);
  return 'success';
}

async function processCurrentPage(page, skippedPatients) {
  let processed = false;

  while (true) {
    const rows = await getPatientRows(page);
    if (!rows.length) break;

    let foundAction = false;
    for (const row of rows) {
      if (skippedPatients.has(row.patientKey)) continue;
      if (!row.sendArchiveButton) continue;

      foundAction = true;
      processed = true;
      const result = await clickArchiveAndHandle(page, row, skippedPatients);

      if (result === 'warning' || result === 'failed_click') {
        continue;
      }

      if (result === 'success') {
        await page.waitForTimeout(2000);
        break;
      }
    }

    if (!foundAction) break;
    const hasRemainingButtons = (await page.locator('button:has-text("Gửi lưu trữ")').count()) > 0;
    if (!hasRemainingButtons) break;
    await page.waitForTimeout(2000);
  }

  return processed;
}

(async () => {
  const browser = await chromium.launch({ headless: HEADLESS });

  try {
    await ensureAuthenticated(browser);

    const context = await browser.newContext({
      storageState: STORAGE_STATE_PATH,
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();

    log.info('SYSTEM', `=== Bắt đầu xử lý DOM từ ${FILTER_FROM} đến ${FILTER_TO} ===`);
    await page.goto(LIST_PAGE_URL, {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT_MS,
    });

    log.info('SYSTEM', 'Bước 1: chờ trình duyệt load xong UI và dữ liệu trong 10 giây...');
    await waitForUiFullyLoaded(page, 10_000);

    const currentUser = await getCurrentUser(page);
    log.info('SYSTEM', `User hiện tại: ${currentUser?.Domain || 'unknown'}`);

    await applyFilterToPage(page, filterConfig);
    await page.waitForTimeout(2000);

    const skippedPatients = new Set();
    let pageTurn = 0;

    while (pageTurn < MAX_PAGE_TURNS) {
      const rows = await getPatientRows(page);
      log.info('SYSTEM', `Trang hiện tại có ${rows.length} hồ sơ có nút "Gửi lưu trữ".`);

      if (!rows.length) {
        const moved = await findNextPageButton(page);
        if (!moved) break;
        pageTurn += 1;
        await page.waitForTimeout(3000);
        continue;
      }

      const processedAny = await processCurrentPage(page, skippedPatients);
      if (!processedAny) {
        const moved = await findNextPageButton(page);
        if (!moved) break;
        pageTurn += 1;
        await page.waitForTimeout(3000);
        continue;
      }

      await page.waitForTimeout(2000);
      pageTurn += 1;
    }

    log.info('SYSTEM', '=== Hoàn tất xử lý theo DOM ===');
  } catch (error) {
    log.error('SYSTEM', `Lỗi tổng quát: ${error.message}`);
  } finally {
    await browser.close();
  }
})();
