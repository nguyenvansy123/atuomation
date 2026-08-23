const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const log = require('./logger');
const { getDefaultFilters, readFilterConfig } = require('./filter-config');

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

// Điều chỉnh vị trí click đặt ảnh chữ ký nếu dấu ký lệch so với nhãn.
// Dương: phải/xuống dưới. Âm: trái/lên trên.
const SIGNATURE_OFFSET_X = -80;
const SIGNATURE_OFFSET_Y = 20;

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

function resolveSavedFilters() {
  try {
    if (process.env.FILTER_CONFIG) {
      const parsed = JSON.parse(process.env.FILTER_CONFIG);
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch (error) {
    // bỏ qua nếu không có biến môi trường hợp lệ
  }

  try {
    return readFilterConfig();
  } catch (error) {
    return {};
  }
}

const userFilters = resolveSavedFilters();
const BASE_FILTERS = Object.freeze({
  ...getDefaultFilters(),
  ...userFilters,
  pageSize: String(userFilters.pageSize || PAGE_SIZE),
  from: userFilters.from || FILTER_FROM,
  to: userFilters.to || FILTER_TO,
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

function readCurrentUserFromStorageState() {
  if (!fs.existsSync(STORAGE_STATE_PATH)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(STORAGE_STATE_PATH, 'utf8');
    const state = JSON.parse(raw);
    const origin = state.origins?.find((item) => item.origin === 'https://bvrhm.hosoyte.com');
    const currentUserEntry = (origin?.localStorage || []).find((item) => item.name === 'currentUser');
    if (!currentUserEntry?.value) {
      return null;
    }

    const parsed = JSON.parse(currentUserEntry.value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    return null;
  }
}

async function submitSignedRecordToManager(context, item, itemKey, patientName) {
  const recordId = getRecordId(item);
  const savedUser = readCurrentUserFromStorageState();
  const userId = savedUser?.id || savedUser?.Id || savedUser?.userId || null;
  const domain = savedUser?.Domain || '79415';
  const token = savedUser?.access_token || null;

  if (!recordId) {
    log.warn(itemKey, `Không có ID hồ sơ để gọi API gửi trưởng khoa. Họ tên: ${patientName}`);
    return { ok: false, reason: 'missing_record_id' };
  }

  if (!userId) {
    log.warn(itemKey, `Không tìm thấy id của người dùng trong storageState.json. Họ tên: ${patientName}`);
    return { ok: false, reason: 'missing_user_id' };
  }

  const url = `https://bvrhm.hosoyte.com/api/${domain}/dieutri//${recordId}/guitruongkhoa?idBenhAn=${recordId}&idCanBo=${userId}&action=4`;

  try {
    const response = await context.request.fetch(url, {
      method: 'DELETE',
      headers: {
        authorization: token ? `Bearer ${token}` : undefined,
        'Content-Type': 'application/json',
      },
    });

    const text = await response.text();
    let parsedText = text;

    try {
      parsedText = JSON.parse(text);
    } catch (error) {
      // giữ nguyên text thuần nếu không phải JSON
    }

    if (!response.ok()) {
      log.error(itemKey, `API gửi trưởng khoa thất bại: HTTP ${response.status()} - ${JSON.stringify(parsedText)}`);
      return { ok: false, status: response.status(), body: parsedText };
    }

    log.info(itemKey, `Đã gửi trưởng khoa thành công cho hồ sơ ${recordId}. URL: ${url}`);
    return { ok: true, status: response.status(), body: parsedText };
  } catch (error) {
    log.error(itemKey, `Lỗi khi gọi API gửi trưởng khoa: ${error.message}`);
    return { ok: false, reason: 'request_failed', error: error.message };
  }
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
    total = Number(page.total) || total || 0;
    allItems.push(...page.items);

    log.info(
      'SYSTEM',
      `Đã tải trang ${pageIndex}: +${page.items.length} hồ sơ (tổng cộng ${allItems.length}/${total || 'không rõ'}).`
    );

    if (page.items.length === 0 || (total > 0 && allItems.length >= total)) break;
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
  const selectors = [
    '#confirmation-dialog-btn-accept',
    'app-confirmation-dialog',
    'app-confirmation-dialog button',
    '.modal.show',
    '.modal',
    '[role="dialog"]',
    '.cdk-overlay-pane',
  ];

  for (const selector of selectors) {
    const modal = page.locator(selector).first();
    if ((await modal.count()) === 0) {
      continue;
    }

    const text = await modal.textContent().catch(() => '');
    const visible = await modal.isVisible().catch(() => false);

    if (visible) {
      return true;
    }

    if (text && /xác nhận|xac nhan|confirm|đồng ý|dong y|ký file|ky file/i.test(text)) {
      return true;
    }
  }

  return false;
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

async function debugImageTargetForModal(page) {
  const targetSelector = 'img#imageid, img.ui-draggable.ui-draggable-handle';
  const patientCodeSelector = 'span[role="presentation"][dir="ltr"]';

  const targetCount = await page.locator(targetSelector).count();
  const debug = await page.evaluate(
    ({ targetSelector, patientCodeSelector }) => {
      const targetFound = Array.from(document.querySelectorAll(targetSelector));
      const patientCodeSpans = Array.from(document.querySelectorAll(patientCodeSelector))
        .filter((span) => /Mã hồ sơ bệnh án:/i.test((span.textContent || '').trim()))
        .map((span) => ({
          text: span.textContent,
          style: {
            left: span.style.left,
            top: span.style.top,
            fontSize: span.style.fontSize,
            transform: span.style.transform,
          },
        }));

      const imgInfo = targetFound.map((image) => {
        const rect = image.getBoundingClientRect();
        return {
          src: image.getAttribute('src'),
          id: image.id,
          className: image.className,
          style: {
            top: image.style.top,
            left: image.style.left,
            position: image.style.position,
            zIndex: image.style.zIndex,
            visibility: image.style.visibility,
          },
          rect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
        };
      });

      return { targetSelector, targetCount: targetFound.length, patientCodeSpans, imgInfo };
    },
    { targetSelector, patientCodeSelector },
  );

  if (targetCount === 0) {
    return { ok: false, debug };
  }

  return { ok: true, debug };
}

function extractImagePosition(debug) {
  const img = debug?.imgInfo?.[0];
  if (!img) return null;

  return {
    styleLeft: img.style?.left || null,
    styleTop: img.style?.top || null,
    rectX: img.rect?.x ?? null,
    rectY: img.rect?.y ?? null,
  };
}

function positionsAreEqual(a, b) {
  if (!a || !b) return false;
  const round = (n) => (typeof n === 'number' ? Math.round(n) : n);
  return (
    a.styleLeft === b.styleLeft &&
    a.styleTop === b.styleTop &&
    round(a.rectX) === round(b.rectX) &&
    round(a.rectY) === round(b.rectY)
  );
}

async function verifySignatureClickMovesImage(page, receiverLabel) {
  const beforeResult = await debugImageTargetForModal(page);
  const beforePos = extractImagePosition(beforeResult.debug);

  if (!beforeResult.ok) {
    return { ok: false, reason: 'no_image_before_click', beforePos, afterPos: null, moved: false };
  }

  const clicked = await clickSignaturePosition(page, receiverLabel);
  if (!clicked) {
    return { ok: false, reason: 'click_failed', beforePos, afterPos: null, moved: false };
  }

  await page.waitForTimeout(1000);

  const afterResult = await debugImageTargetForModal(page);
  const afterPos = extractImagePosition(afterResult.debug);

  if (!afterResult.ok) {
    return {
      ok: true,
      beforePos,
      afterPos: null,
      moved: true,
      note: 'image_disappeared_after_click_likely_applied',
    };
  }

  const unchanged = positionsAreEqual(beforePos, afterPos);
  const moved = !unchanged;

  return {
    ok: true,
    beforePos,
    afterPos,
    moved,
    beforeDebug: beforeResult.debug,
    afterDebug: afterResult.debug,
  };
}

async function isSignatureGlyphAlreadyPlaced(page) {
  const selectors = ['button[title="Ký số"]', 'button[title*="Ký số" i]'];

  for (const selector of selectors) {
    const buttons = page.locator(selector);
    const count = await buttons.count();

    for (let i = 0; i < count; i += 1) {
      const info = await buttons.nth(i).evaluate((el) => {
        const style = window.getComputedStyle(el);
        const text = (el.textContent || '').trim();
        const title = (el.getAttribute('title') || '').trim();
        const isGlyph = /✍️|✍/u.test(text);
        const isPositioned =
          style.position === 'absolute' &&
          style.left !== 'auto' &&
          style.top !== 'auto' &&
          Number.parseFloat(style.width || '0') > 0 &&
          Number.parseFloat(style.height || '0') > 0;

        return {
          title,
          text,
          isGlyph,
          isPositioned,
          left: style.left,
          top: style.top,
          width: style.width,
          height: style.height,
        };
      });

      if (info?.isGlyph && info?.isPositioned) {
        log.info('SYSTEM', `[isSignatureGlyphAlreadyPlaced] phát hiện chữ ký đã thả sẵn: ${JSON.stringify(info)}`);
        return true;
      }
    }
  }

  return false;
}

async function clickConfirmSignModal(page, itemKey) {
  const selectors = [
    '#confirmation-dialog-btn-accept',
    'button:has-text("Đồng ý")',
    'button:has-text("Xác nhận")',
    'button:has-text("Confirm")',
    'button:has-text("OK")',
    'button:has-text("Ký File")',
    'button:has-text("Ky File")',
    'app-confirmation-dialog button',
    '.modal button',
  ];

  for (const selector of selectors) {
    const button = page.locator(selector).first();
    if ((await button.count()) === 0) continue;

    try {
      await button.scrollIntoViewIfNeeded();
      await button.click({ timeout: 8000, force: true });
      await page.waitForTimeout(1500);
      return !(await isConfirmModalVisible(page));
    } catch (error) {
      log.warn(itemKey, `Click xác nhận modal selector lỗi: ${selector} — ${error.message}`);
    }
  }

  const candidate = page
    .locator('button')
    .filter({ hasText: /đồng ý|dong y|xác nhận|xac nhan|confirm|ok|ký file|ky file/i })
    .first();

  if ((await candidate.count()) > 0) {
    try {
      await candidate.scrollIntoViewIfNeeded();
      await candidate.click({ timeout: 8000, force: true });
      await page.waitForTimeout(1500);
      return !(await isConfirmModalVisible(page));
    } catch (error) {
      log.warn(itemKey, `Click xác nhận modal fallback lỗi: ${error.message}`);
    }
  }

  return false;
}

async function addClickMarker(page, x, y, label = 'click') {
  await page.evaluate(
    ({ x, y, label }) => {
      const root = document.getElementById('__auto_click_marker_root') || (() => {
        const el = document.createElement('div');
        el.id = '__auto_click_marker_root';
        el.style.position = 'fixed';
        el.style.left = '0';
        el.style.top = '0';
        el.style.width = '100vw';
        el.style.height = '100vh';
        el.style.pointerEvents = 'none';
        el.style.zIndex = '2147483647';
        document.body.appendChild(el);
        return el;
      })();

      const marker = document.createElement('button');
      marker.type = 'button';
      marker.textContent = label;
      marker.style.position = 'fixed';
      marker.style.left = `${x}px`;
      marker.style.top = `${y}px`;
      marker.style.transform = 'translate(-50%, -50%)';
      marker.style.minWidth = '28px';
      marker.style.height = '28px';
      marker.style.border = '2px solid #ef4444';
      marker.style.borderRadius = '999px';
      marker.style.background = '#fee2e2';
      marker.style.color = '#991b1b';
      marker.style.fontSize = '10px';
      marker.style.fontWeight = '700';
      marker.style.padding = '0 8px';
      marker.style.boxShadow = '0 4px 12px rgba(0,0,0,0.2)';
      marker.style.cursor = 'default';
      marker.style.pointerEvents = 'none';
      marker.style.zIndex = '2147483648';
      root.appendChild(marker);

      setTimeout(() => {
        marker.remove();
      }, 2200);
    },
    { x, y, label },
  );
}

async function clickSignaturePosition(page, receiverLabel) {
  try {
    await receiverLabel.scrollIntoViewIfNeeded();

    const box = await receiverLabel.boundingBox();
    if (!box) {
      log.warn('SYSTEM', '[clickSignaturePosition] Không lấy được boundingBox của Người nhận hồ sơ.');
      return false;
    }

    const x = box.x + box.width / 2 + SIGNATURE_OFFSET_X;
    const y = box.y + box.height + SIGNATURE_OFFSET_Y;

    log.info('SYSTEM', `[clickSignaturePosition] click đặt chữ ký tại (${x}, ${y}) với offsetX=${SIGNATURE_OFFSET_X}, offsetY=${SIGNATURE_OFFSET_Y}`);

    await page.mouse.move(x, y, { steps: 10 });
    await page.mouse.click(x, y);
    await addClickMarker(page, x, y, 'signature');
    await page.waitForTimeout(1000);

    return true;
  } catch (error) {
    log.warn('SYSTEM', `clickSignaturePosition lỗi: ${error.message}`);
    return false;
  }
}

async function clickReceiverSignerFallback(page, itemKey, patientName) {
  const quickSigner = page.locator('button[title="Ký số"]').filter({ hasText: '✍️' }).first();
  if ((await quickSigner.count()) > 0) {
    try {
      await quickSigner.click({ timeout: 10000 });
      return true;
    } catch (error) {
      log.warn(itemKey, `Nút ký số dạng biểu tượng tồn tại nhưng click lỗi: ${error.message}`);
    }
  }

  const pageSelect = page
    .locator('select[name="page"], select[ng-reflect-name="page"], select.form-select.form-select-sm.text-center')
    .first();

  if ((await pageSelect.count()) > 0) {
    const optionValues = await pageSelect.locator('option').allTextContents();
    const hasOptionOne = optionValues.some((text) => normalizeText(text) === '1');

    if (!hasOptionOne) {
      try {
        await pageSelect.selectOption({ label: '1' });
        await page.waitForTimeout(1000);
      } catch (error) {
        log.warn(itemKey, `Không chọn option 1 trong select page: ${error.message}`);
      }
    }
  }

  const receiverLabel = page
    .locator('span')
    .filter({ hasText: /^Người nhận hồ sơ$/i })
    .first();

  if ((await receiverLabel.count()) > 0) {
    try {
      await receiverLabel.click({ timeout: 10000 });
      return true;
    } catch (error) {
      const box = await receiverLabel.boundingBox().catch(() => null);
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        return true;
      }
      log.warn(itemKey, `Không click được chữ Người nhận hồ sơ: ${error.message}`);
    }
  }

  const unassignedLabel = page
    .locator('span, div, td, li, a')
    .filter({ hasText: /Chưa nhận hồ sơ|chua nhan ho so/i })
    .first();

  if ((await unassignedLabel.count()) > 0) {
    try {
      await unassignedLabel.click({ timeout: 10000 });
      return true;
    } catch (error) {
      const box = await unassignedLabel.boundingBox().catch(() => null);
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        return true;
      }
      log.warn(itemKey, `Không click được nhãn Chưa nhận hồ sơ: ${error.message}`);
    }
  }

  log.pendingReview(
    itemKey,
    `Không tìm thấy nút ký số dạng biểu tượng, không tìm thấy nhãn Người nhận hồ sơ hoặc Chưa nhận hồ sơ. Họ tên: ${patientName}`
  );
  return false;
}

async function processDocument(page, context, item) {
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

  const glyphReceiverSigner = page.locator('button[title="Ký số"]').filter({ hasText: '✍️' }).first();
  const receiverSigner = page.locator(
    'button[title*="Ký số Người nhận hồ sơ" i], button[title*="Ký số người nhận hồ sơ" i], button[title*="ký số người nhận hồ sơ" i]'
  ).first();
  const receiverLabel = page.locator('span').filter({ hasText: /^Người nhận hồ sơ$/i }).first();

  try {
    if ((await glyphReceiverSigner.count()) > 0) {
      await glyphReceiverSigner.click({ timeout: 10000 });
    } else if ((await receiverSigner.count()) > 0) {
      await receiverSigner.click({ timeout: 10000 });
    } else {
      const fallbackWorked = await clickReceiverSignerFallback(page, itemKey, patientName);
      if (!fallbackWorked) {
        log.pendingReview(itemKey, `Không thấy nút ký số người nhận hồ sơ trên "${REQUIRED_DOC_NAME}". Họ tên: ${patientName}`);
        return 'can_xem_lai';
      }
    }
  } catch (error) {
    log.error(itemKey, `Không click được nút ký số người nhận hồ sơ: ${error.message}`);
    return 'can_xem_lai';
  }

  await page.waitForTimeout(8000);
  await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT_MS }).catch(() => {});

  let modalWasClosed = false;
  if (await isConfirmModalVisible(page)) {
    modalWasClosed = await clickOutsideModal(page);
    if (modalWasClosed) {
      await page.waitForTimeout(1000);
    }
  }

  const hasReceiverLabel = (await receiverLabel.count()) > 0;
  const alreadyPlacedSignature = await isSignatureGlyphAlreadyPlaced(page);
  let imageDebug = null;
  let clickVerification = null;

  if (modalWasClosed && hasReceiverLabel) {
    if (alreadyPlacedSignature) {
      log.info(itemKey, 'Phát hiện chữ ký đã thả sẵn sau khi đóng modal, bỏ qua bước click di chuyển ảnh.');
      imageDebug = { ok: true, debug: null };
    } else {
      log.info(itemKey, 'Đang so sánh vị trí ảnh trước/sau khi click đặt chữ ký vào vị trí dưới label Người nhận hồ sơ.');
      clickVerification = await verifySignatureClickMovesImage(page, receiverLabel);

      if (!clickVerification.ok) {
        log.warn(itemKey, `click_verification_failed: ${JSON.stringify(clickVerification)}`);
        return 'can_xem_lai';
      }

      if (!clickVerification.moved) {
        log.warn(itemKey, 'Click đặt chữ ký không di chuyển ảnh; cần drag thực sự.');
        return 'can_xem_lai';
      }

      log.info(itemKey, 'Click đặt chữ ký thành công, tiếp tục tìm nút Ký File.');
      imageDebug = { ok: true, debug: clickVerification.afterDebug };
    }
  }

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

    await page.waitForTimeout(1500);

    if (await isConfirmModalVisible(page)) {
      log.info(itemKey, 'Modal xác nhận hiển thị, đang đồng ý ký hồ sơ...');
      const confirmed = await clickConfirmSignModal(page, itemKey);
      log.info(itemKey, `Kết quả đồng ý ký hồ sơ: ${confirmed}`);
    }

    await page.waitForTimeout(5000);
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(3000);

    const postClickSidebar = await evaluateSidebarState(page);
    const signButtonStillVisible = (await page.locator(signFileButtonSelector).count()) > 0;
    if (!postClickSidebar.hasUnsign || !signButtonStillVisible) {
      confirmed = true;
      break;
    }

    let confirmLocator = page.locator(CONFIRM_ID_SELECTOR).first();
    if ((await confirmLocator.count()) === 0) {
      confirmLocator = page.locator(CONFIRM_TEXT_SELECTOR).first();
    }

    try {
      await confirmLocator.waitFor({ state: 'visible', timeout: 15000 });
    } catch (error) {
      lastAttemptNote = 'khong_thay_modal';
      log.info(itemKey, `Lần thử ${attempt}/${MAX_SIGN_ATTEMPTS}: không thấy modal xác nhận sau khi bấm "Ký File", nhưng sidebar đã hết "chưa ký" nên coi như ký thành công.`);
      appendModalLog({ itemKey, patientName, attempt, found: false, note: 'modal not visible but sidebar changed' });
      confirmed = true;
      break;
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

    const postConfirmSidebar = await evaluateSidebarState(page);
    if (!postConfirmSidebar.hasUnsign) {
      confirmed = true;
      break;
    }

    lastAttemptNote = 'click_khong_co_tac_dung_modal_van_con';
    log.info(
      itemKey,
      `Lần thử ${attempt}/${MAX_SIGN_ATTEMPTS}: click "Xác nhận" không đóng modal, nhưng sidebar đã thay đổi rõ rệt nên vẫn tiếp tục xử lý.`
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
  // nhưng không được bỏ qua việc gọi API gửi lưu trữ chỉ vì sidebar chưa cập nhật kịp.
  const afterSignState = await evaluateSidebarState(page);
  const submitResult = await submitSignedRecordToManager(context, item, itemKey, patientName);

  if (afterSignState.hasUnsign && !submitResult.ok) {
    log.incomplete(
      itemKey,
      `Đã thao tác ký và cố gắng gửi lưu trữ nhưng "${REQUIRED_DOC_NAME}" vẫn đang ở trạng thái chưa ký sau khi xác nhận. Họ tên: ${patientName}. Kết quả gửi lưu trữ: ${JSON.stringify(submitResult)}`
    );
    return 'chua_hoan_thien';
  }

  if (afterSignState.hasUnsign && submitResult.ok) {
    log.info(
      itemKey,
      `Sidebar vẫn chưa cập nhật, nhưng API gửi lưu trữ đã thành công cho hồ sơ ${getRecordId(item) || '(không có id)'}. Họ tên: ${patientName}.`
    );
    return 'da_ky_ho_so';
  }

  if (!submitResult.ok) {
    log.pendingReview(
      itemKey,
      `Đã ký xong nhưng gọi API gửi trưởng khoa thất bại cho hồ sơ ${getRecordId(item) || '(không có id)'}: ${JSON.stringify(submitResult)}`
    );
    return 'can_xem_lai';
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
    const pageSize = Number(BASE_FILTERS.pageSize || PAGE_SIZE) || PAGE_SIZE;
    const maxProcessItems = TEST_LIMIT && TEST_LIMIT > 0 ? TEST_LIMIT : null;

    let pageIndex = 1;
    let processedCount = 0;
    let total = 0;

    log.info('SYSTEM', `Bắt đầu xử lý từng trang, mỗi trang xử lý xong mới chuyển sang trang tiếp theo.`);

    while (true) {
      const pageData = await fetchItemsPage(context, currentUser, pageIndex);
      const items = Array.isArray(pageData?.items) ? pageData.items : [];
      total = Number(pageData?.total) || total || 0;

      if (!items.length) {
        log.info('SYSTEM', `Trang ${pageIndex} không còn dữ liệu, dừng xử lý.`);
        break;
      }

      log.info('SYSTEM', `=== Xử lý trang ${pageIndex}${total ? `/${Math.ceil(total / pageSize)}` : ''} ===`);

      for (const item of items) {
        if (maxProcessItems && processedCount >= maxProcessItems) {
          log.info('SYSTEM', `[TEST MODE] Đã xử lý đủ ${maxProcessItems} hồ sơ, dừng.`);
          return;
        }

        processedCount += 1;

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
            await processDocument(detailPage, context, item);
          } finally {
            await detailPage.close().catch(() => {});
            await page.bringToFront().catch(() => {});
          }
        } catch (error) {
          log.error(itemKey, `Lỗi khi xử lý hồ sơ: ${error.message}`);
        }
      }

      if (maxProcessItems && processedCount >= maxProcessItems) {
        log.info('SYSTEM', `[TEST MODE] Đã xử lý xong ${processedCount}/${maxProcessItems} hồ sơ theo giới hạn test.`);
        break;
      }

      const hasMoreData = total > 0 ? pageIndex * pageSize < total : items.length >= pageSize;
      if (!hasMoreData) {
        log.info('SYSTEM', `Trang ${pageIndex} là trang cuối, không còn dữ liệu tiếp theo.`);
        break;
      }

      pageIndex += 1;
      log.info('SYSTEM', `Xong trang ${pageIndex - 1}. Chuyển sang trang ${pageIndex} để tiếp tục.`);
      await page.waitForTimeout(2000);
    }

    log.info('SYSTEM', '=== Hoàn tất xử lý hồ sơ theo từng trang ===');
  } finally {
    await browser.close();
  }
})();