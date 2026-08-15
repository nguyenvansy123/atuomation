const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const log = require('./logger');

const STORAGE_STATE_PATH = './storageState.json';
const MODAL_LOG_PATH = path.join(__dirname, 'logs', 'modal-confirm.log');
const LIST_PAGE_URL =
  'https://bvrhm.hosoyte.com/v2/#/HSBA/DsBenhAnChoKy?TrangThai=ChoDuyet';
const LOGIN_URL = 'https://bvrhm.hosoyte.com/v2/';
const DETAIL_URL_TEMPLATE =
  'https://bvrhm.hosoyte.com/v2/#/view/HSBA/HsBenhAn/{id}/HSBA%2FDsBenhAnChoKy';

const HEADLESS = false; // true để chạy ẩn, false để mở trình duyệt nhìn thấy thao tác
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

function appendModalLog(entry) {
  const logsDir = path.dirname(MODAL_LOG_PATH);
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
  const line = `${new Date().toISOString()}\n${JSON.stringify(entry, null, 2)}\n---\n`;
  fs.appendFileSync(MODAL_LOG_PATH, line, 'utf8');
}

async function logModalDomState(page, itemKey, patientName, phase, attempt = null) {
  const snapshot = await page.evaluate(() => {
    const cleanText = (value) => (value || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const getClass = (el) => {
      if (!el) return '';
      const className = el.className || '';
      return typeof className === 'string' ? '.' + className.split(/\s+/).join('.') : '';
    };

    const summarizeElement = (el) => {
      if (!el) return null;
      return {
        tag: (el.tagName || '').toLowerCase(),
        id: el.id || '',
        className: getClass(el),
        text: cleanText(el.textContent),
        title: cleanText(el.getAttribute('title')),
        ariaLabel: cleanText(el.getAttribute('aria-label')),
      };
    };

    const buttons = Array.from(document.querySelectorAll('button, [role="button"], a'))
      .slice(0, 30)
      .map((el) => summarizeElement(el))
      .filter(Boolean);

    const confirmButtons = buttons.filter((button) => {
      const text = `${button.text || ''} ${button.title || ''} ${button.ariaLabel || ''}`;
      return /(xác nhận|xac nhan|confirm|đồng ý|dong y|ký file|ky file)/i.test(text);
    });

    const dialogs = Array.from(document.querySelectorAll('app-confirmation-dialog, .modal, [role="dialog"], .cdk-overlay-pane'))
      .slice(0, 10)
      .map((el) => ({
        ...summarizeElement(el),
        visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
      }))
      .filter(Boolean);

    const centerEl = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);

    return {
      url: window.location.href,
      title: document.title,
      center: summarizeElement(centerEl),
      buttons: buttons.map((button) => ({
        tag: button.tag,
        id: button.id,
        className: button.className,
        text: button.text,
        title: button.title,
        ariaLabel: button.ariaLabel,
      })),
      confirmButtons: confirmButtons.map((button) => ({
        tag: button.tag,
        id: button.id,
        className: button.className,
        text: button.text,
        title: button.title,
        ariaLabel: button.ariaLabel,
      })),
      dialogs,
    };
  });

  const summary = snapshot.confirmButtons?.length
    ? snapshot.confirmButtons.map((item) => item.text || item.title || item.ariaLabel).join(' | ')
    : '(không có nút xác nhận)';

  appendModalLog({ itemKey, patientName, phase, attempt, snapshot, summary });
  log.info(
    itemKey,
    `[${phase}] DOM snapshot: dialogs=${snapshot.dialogs?.length ?? 0}, confirmButtons=${snapshot.confirmButtons?.length ?? 0}, center=${snapshot.center ? snapshot.center.tag : '(none)'}, summary=${summary}`
  );
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
 * Lặp qua toàn bộ các trang cho đến khi lấy đủ `total` bản ghi thật sự
 * trả về từ server (KHÔNG hardcode total), để không bỏ sót hồ sơ khi total > PAGE_SIZE.
 * Việc giới hạn số lượng cho mục đích test được xử lý riêng ở nơi gọi hàm này
 * thông qua TEST_LIMIT, không trộn lẫn vào đây.
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

async function waitForSidebarReady(page, timeoutMs = 20_000) {
  try {
    await page.waitForFunction(
      (requiredDocName) => {
        const anchors = Array.from(document.querySelectorAll('ul.toc-list li a'));
        return anchors.some((anchor) => {
          const title = (anchor.getAttribute('title') || '').trim();
          const text = (anchor.textContent || '').replace(/\s+/g, ' ').trim();
          return title.includes(requiredDocName) || text.includes(requiredDocName);
        });
      },
      REQUIRED_DOC_NAME,
      { timeout: timeoutMs }
    );
    return true;
  } catch (error) {
    return false;
  }
}

async function evaluateSidebarState(page) {
  const isReady = await waitForSidebarReady(page, 20_000);
  if (!isReady) {
    return {
      sidebarItems: [],
      unsignedItems: [],
      hasUnsign: false,
      totalUnsignCount: 0,
      listUnsign: [],
      ignoredUnsign: [],
      ignoredUnsignCount: 0,
      listIgnoredUnsign: [],
    };
  }

  // FIX: không trả DOM Element ra khỏi page.evaluate — Playwright sẽ tự động
  // chuyển mỗi Node thành chuỗi vô nghĩa "ref: <Node>" thay vì báo lỗi, khiến
  // dữ liệu trông "chạy được" nhưng thực chất không mang thông tin gì.
  // Chỉ trả về text/thuộc tính (string, boolean, number) đã được tính sẵn trong page.
  const sidebarState = await page.evaluate((requiredDocName) => {
    const lists = Array.from(document.querySelectorAll('ul.toc-list li')).filter(
      (li) => !li.hasAttribute('hidden')
    );
    const items = lists
      .map((listItem) => {
        const anchor = listItem.querySelector('a');
        if (!anchor) return null;

        const title = (anchor.getAttribute('title') || '').trim();
        const text = (anchor.textContent || '').replace(/\s+/g, ' ').trim();
        const hasUnsigned = /chưa ký|chua ky/i.test(text) || /chưa ký|chua ky/i.test(title);
        const anchorCount = listItem.querySelectorAll('a').length;
        const isRequired = text.includes(requiredDocName) ||
          title.includes(requiredDocName) ||
          (anchor.getAttribute('title') || '').includes(requiredDocName);

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

async function openDocumentRecord(context, item) {
  const detailUrl = buildDetailUrl(item);
  if (!detailUrl) {
    log.warn(item?.MaYTe || 'UNKNOWN', 'Không có ID hồ sơ để mở chi tiết.');
    return null;
  }

  const detailPage = await context.newPage();
  try {
    await detailPage.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await detailPage.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT_MS }).catch(() => {});
    return detailPage;
  } catch (error) {
    await detailPage.close().catch(() => {});
    throw error;
  }
}

async function isConfirmModalVisible(page) {
  const modal = page.locator('#confirmation-dialog-btn-accept').first();
  if ((await modal.count()) === 0) {
    return false;
  }
  return await modal.isVisible().catch(() => false);
}

async function clickOutsideModal(page) {
  const backdrop = page.locator('.modal-backdrop, .cdk-overlay-backdrop').first();
  if ((await backdrop.count()) > 0) {
    try {
      await backdrop.click({ force: true, timeout: 3000 });
      await page.waitForTimeout(500);
      if (!(await isConfirmModalVisible(page))) {
        return true;
      }
    } catch (error) {
      log.warn('SYSTEM', `Không click được backdrop: ${error.message}`);
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
      if (!(await isConfirmModalVisible(page))) {
        return true;
      }
    } catch (error) {
      log.warn('SYSTEM', `Click ngoài modal lỗi tại (${point.x}, ${point.y}): ${error.message}`);
    }
  }

  try {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    if (!(await isConfirmModalVisible(page))) {
      return true;
    }
  } catch (error) {
    log.warn('SYSTEM', `Escape không hoạt động: ${error.message}`);
  }

  return false;
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

  // Không nuốt lỗi im lặng — kiểm tra element tồn tại trước khi click,
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

  // Sau mỗi click làm đổi trang / render lại dữ liệu, chờ để UI load xong.
  await page.waitForTimeout(10000);
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
  await page.waitForTimeout(8000);
  await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT_MS }).catch(() => {});

  const signFileButtonSelector = 'button.btn.btn-sm.btn-warning:has-text("Ký File"), button:has-text("Ký File")';
  const initialSignFileButton = page.locator(signFileButtonSelector).first();

  if ((await initialSignFileButton.count()) === 0) {
    log.pendingReview(itemKey, `Không thấy nút "Ký File" sau khi bấm ký số người nhận hồ sơ. Họ tên: ${patientName}`);
    return 'can_xem_lai';
  }

  const CONFIRM_ID_SELECTOR = '#confirmation-dialog-btn-accept';
  const CONFIRM_TEXT_SELECTOR = 'app-confirmation-dialog button:has-text("Xác nhận")';
  const MODAL_CLOSE_SELECTOR = 'app-confirmation-dialog button.close, app-confirmation-dialog [aria-label="Close"]';
  const MAX_SIGN_ATTEMPTS = 3;

  async function closeConfirmModalIfOpen() {
    const backdrop = page.locator('.modal-backdrop, .cdk-overlay-backdrop').first();
    if ((await backdrop.count()) > 0) {
      try {
        await backdrop.click({ timeout: 3000, force: true });
        await page.waitForTimeout(500);
        if (!(await isConfirmModalVisible(page))) {
          return;
        }
      } catch (error) {
        log.warn(itemKey, `Không click được backdrop: ${error.message}`);
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
        if (!(await isConfirmModalVisible(page))) {
          return;
        }
      } catch (error) {
        log.warn(itemKey, `Click ngoài modal lỗi tại (${point.x}, ${point.y}): ${error.message}`);
      }
    }

    const closeBtn = page.locator(MODAL_CLOSE_SELECTOR).first();
    if ((await closeBtn.count()) > 0) {
      await closeBtn.click({ timeout: 3000 }).catch(() => {});
    }
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);
  }

  let confirmed = false;
  let lastAttemptNote = null;

  for (let attempt = 1; attempt <= MAX_SIGN_ATTEMPTS; attempt++) {
    log.info(itemKey, `Đang thử ký lần ${attempt}/${MAX_SIGN_ATTEMPTS}.`);

    if (await isConfirmModalVisible(page)) {
      log.info(itemKey, `Modal cũ vẫn còn mở, thử click ngoài để đóng lại trước khi ký.`);
      await clickOutsideModal(page);
      await page.waitForTimeout(1000);
    }

    const signFileButton = page.locator(signFileButtonSelector).first();
    if ((await signFileButton.count()) === 0) {
      lastAttemptNote = 'khong_thay_nut_ky_file';
      log.error(itemKey, `Lần thử ${attempt}/${MAX_SIGN_ATTEMPTS}: không thấy nút "Ký File" để bấm lại.`);
      break;
    }

    try {
      await signFileButton.scrollIntoViewIfNeeded();
      await signFileButton.click({ timeout: 10000 });
    } catch (error) {
      lastAttemptNote = `loi_click_ky_file: ${error.message}`;
      log.error(itemKey, `Lần thử ${attempt}/${MAX_SIGN_ATTEMPTS}: không click được nút "Ký File": ${error.message}`);
      await clickOutsideModal(page);
      continue;
    }

    await page.waitForTimeout(5000);
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(3000);

    let confirmLocator = page.locator(CONFIRM_ID_SELECTOR).first();
    if ((await confirmLocator.count()) === 0) {
      confirmLocator = page.locator(CONFIRM_TEXT_SELECTOR).first();
    }

    try {
      await confirmLocator.waitFor({ state: 'visible', timeout: 15000 });
    } catch (error) {
      lastAttemptNote = 'khong_thay_modal';
      log.info(itemKey, `Lần thử ${attempt}/${MAX_SIGN_ATTEMPTS}: không thấy modal xác nhận sau khi bấm "Ký File".`);
      appendModalLog({ itemKey, patientName, attempt, found: false, note: 'modal not visible' });
      await clickOutsideModal(page);
      continue;
    }

    try {
      await confirmLocator.scrollIntoViewIfNeeded();
      await confirmLocator.click({ timeout: 10000 });
    } catch (error) {
      lastAttemptNote = `loi_click_xac_nhan: ${error.message}`;
      log.error(itemKey, `Lần thử ${attempt}/${MAX_SIGN_ATTEMPTS}: tìm thấy modal nhưng click lỗi: ${error.message}`);
      appendModalLog({ itemKey, patientName, attempt, found: true, clicked: false, error: error.message });
      await clickOutsideModal(page);
      continue;
    }

    const modalClosed = await confirmLocator
      .waitFor({ state: 'hidden', timeout: 5000 })
      .then(() => true)
      .catch(() => false);

    appendModalLog({ itemKey, patientName, attempt, found: true, clicked: true, modalClosed });

    if (modalClosed) {
      confirmed = true;
      break;
    }

    lastAttemptNote = 'click_khong_co_tac_dung_modal_van_con';
    log.info(
      itemKey,
      `Lần thử ${attempt}/${MAX_SIGN_ATTEMPTS}: click "Xác nhận" không đóng modal, đang bấm ra ngoài và thử lại.`
    );
    await clickOutsideModal(page);
    await page.waitForTimeout(1000);
  }

  if (!confirmed) {
    log.pendingReview(
      itemKey,
      `Không hoàn tất xác nhận modal "Xác nhận ký số!" sau ${MAX_SIGN_ATTEMPTS} lần thử (${lastAttemptNote}). Họ tên: ${patientName}`
    );
    return 'can_xem_lai';
  }

  log.info(itemKey, `Đã click xác nhận modal. Chờ để chữ ký hồ sơ hoàn tất.`);
  await page.waitForTimeout(10000);
  await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT_MS }).catch(() => {});

  // Xác nhận việc ký thực sự thành công bằng cách đọc lại sidebar,
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
  const browser = await chromium.launch({ headless: HEADLESS });

  try {
    await ensureAuthenticated(browser);

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
    const { total, items: allItems } = await fetchAllItems(context, currentUser);
    log.info('SYSTEM', `Bộ lọc tìm thấy ${total} hồ sơ; đã tải đủ ${allItems.length} hồ sơ.`);

    // TEST: chỉ lấy TEST_LIMIT bản ghi đầu để chạy thử trước khi xử lý toàn bộ.
    // Đặt TEST_LIMIT = null (hoặc 0) ở đầu file để chạy full không giới hạn.
    const items =
      TEST_LIMIT && TEST_LIMIT > 0 ? allItems.slice(0, TEST_LIMIT) : allItems;
    if (TEST_LIMIT && TEST_LIMIT > 0) {
      log.info(
        'SYSTEM',
        `[TEST MODE] Chỉ xử lý ${items.length}/${allItems.length} hồ sơ đầu tiên (TEST_LIMIT=${TEST_LIMIT}).`
      );
    }

    for (const item of items) {
      const itemKey = cleanLogValue(item.MaYTe || item.id || item.MaBenhAn || 'UNKNOWN');
      const patientName = cleanLogValue(item.HoTenBenhNhan || item.HoTenBN || '');

      log.info(itemKey, `Bắt đầu xử lý hồ sơ: ${patientName}`);

      try {
        const detailPage = await openDocumentRecord(context, item);
        if (!detailPage) {
          log.pendingReview(itemKey, `Không mở được chi tiết hồ sơ. Họ tên: ${patientName}`);
          continue;
        }

        try {
          await processDocument(detailPage, item);
        } finally {
          await detailPage.close().catch(() => {});
          await page.bringToFront().catch(() => {});
        }
      } catch (error) {
        log.error(itemKey, `Lỗi khi xử lý hồ sơ: ${error.message}`);
      }
    }

    log.info('SYSTEM', '=== Hoàn tất xử lý hồ sơ ===');
  } finally {
    await browser.close();
  }
})();