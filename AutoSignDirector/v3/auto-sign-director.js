const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { chromium } = require('playwright');
const log = require('./logger');
const { docThongTinDangNhap } = require('./config');

const ORIGIN = 'https://bvrhm.hosoyte.com';
const LOGIN_PAGE_URL = `${ORIGIN}/v2/`;
const USERNAME_SELECTOR = 'form input[type="text"][autocomplete="username"]';
const PASSWORD_SELECTOR = 'form input[type="password"][autocomplete="current-password"]';
const SUBMIT_SELECTOR = 'form button[type="submit"]';
const LIST_URL = `${ORIGIN}/v2/#/HSBA/DsBenhAnChoKy?TrangThai=ChoKyTruongKhoa`;
const DOCUMENT_NAME = 'Phiếu giao nhận hồ sơ bệnh án';
const MEDICAL_CHART_NAME = 'Phiếu bệnh án';
const ADMINISTRATIVE_NAME = 'Thông tin hành chính';
const ALLOWED_UNSIGNED_NAMES = [DOCUMENT_NAME, ADMINISTRATIVE_NAME];
const SIGN_TITLE = 'Ký số Trưởng khoa ký ủy quyền Giám đốc';
const TIMEOUT = 30000;
const SEND_SETTLE_MS = 5000;
const LIST_RENDER_MS = 1500;
const DIALOGS = '.modal-dialog:visible, .swal2-popup:visible';
const RESULT_PATH = path.join(__dirname, 'logs', 'auto-sign-director.jsonl');
const STORAGE_STATE_PATH = path.join(__dirname, 'storageState.director.json');

function normalizeText(value) {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function isTargetListPage(value) {
  const url = new URL(value);
  const route = new URL(url.hash.slice(1), url.origin);
  return url.origin === ORIGIN && url.pathname === '/v2/' &&
    route.pathname === '/HSBA/DsBenhAnChoKy' &&
    route.searchParams.get('TrangThai') === 'ChoKyTruongKhoa';
}

function checkDocumentEligibility(documents) {
  const unsignedDocuments = documents.filter((item) => item.IsDaKySo === false)
    .map((item) => normalizeText(item.Ten));
  const blockingDocuments = unsignedDocuments.filter((name) => !ALLOWED_UNSIGNED_NAMES.includes(name));
  const nullStatusDocuments = documents.filter((item) => item.IsDaKySo === null)
    .map((item) => normalizeText(item.Ten));
  return {
    eligible: blockingDocuments.length === 0,
    reason: blockingDocuments.length
      ? `Phiếu khác chưa ký số: ${blockingDocuments.join(' | ')}`
      : 'API không có phiếu chưa ký số ngoài phiếu giao nhận và thông tin hành chính',
    unsignedDocuments,
    blockingDocuments,
    nullStatusDocuments,
  };
}

function parseOptions(args) {
  const options = { execute: false, limit: 0, login: false };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--execute') options.execute = true;
    else if (args[index] === '--login') options.login = true;
    else if (args[index] === '--limit') {
      const value = args[++index];
      if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error('--limit phải là số nguyên dương');
      }
      options.limit = Number(value);
    } else throw new Error(`Tham số không hỗ trợ: ${args[index]}`);
  }
  if (options.login && (options.execute || options.limit)) {
    throw new Error('--login chỉ dùng để lưu tài khoản, không dùng cùng --execute hoặc --limit');
  }
  return options;
}

async function isAuthenticated(page) {
  return page.evaluate(() => {
    const user = JSON.parse(localStorage.getItem('currentUser') || 'null');
    return !!user && (typeof user.Domain === 'string' || typeof user.Domain === 'number') &&
      String(user.Domain).trim().length > 0 &&
      typeof user.access_token === 'string' && user.access_token.trim().length > 0;
  });
}

async function autoLogin(page, credentials) {
  await page.goto(LOGIN_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const username = page.locator(USERNAME_SELECTOR);
  await username.waitFor({ state: 'visible', timeout: TIMEOUT });
  await page.fill(USERNAME_SELECTOR, credentials.user);
  await page.fill(PASSWORD_SELECTOR, credentials.pass);
  await page.click(SUBMIT_SELECTOR);
  let outcome;
  try {
    outcome = await page.waitForFunction(() => {
      const user = JSON.parse(localStorage.getItem('currentUser') || 'null');
      if (user && (typeof user.Domain === 'string' || typeof user.Domain === 'number') &&
          String(user.Domain).trim().length > 0 &&
          typeof user.access_token === 'string' && user.access_token.trim().length > 0) {
        return 'ok';
      }
      if (/incorrect/i.test(document.body.innerText || '')) return 'error';
      return false;
    }, null, { timeout: 45000 });
  } catch (error) {
    throw new Error(`Đăng nhập tự động không thành công: ${error.message}`, { cause: error });
  }
  if (outcome !== 'ok') {
    const detail = await page.evaluate(() => {
      const element = Array.from(document.querySelectorAll('div')).find(
        (node) => node.children.length === 0 && /incorrect/i.test(node.textContent || '')
      );
      return element ? element.textContent.trim() : '';
    });
    throw new Error(`Đăng nhập tự động không thành công${detail ? `: ${detail}` : ''}`);
  }
}

async function saveLoginSession(context, page, storagePath = STORAGE_STATE_PATH) {
  if (new URL(page.url()).origin !== ORIGIN) {
    throw new Error('Không ở website hồ sơ y tế; không lưu phiên đăng nhập');
  }
  if (!await isAuthenticated(page)) {
    throw new Error('Chưa đăng nhập thành công; không lưu phiên. Hãy kiểm tra tài khoản trong config.json.');
  }
  await context.storageState({ path: storagePath });
}

async function waitForDialog(page) {
  const dialogs = page.locator(DIALOGS);
  await dialogs.first().waitFor({ timeout: TIMEOUT });
  if (await dialogs.count() !== 1) throw new Error('Có nhiều hộp thoại; không tự động xác nhận');
  return dialogs.first();
}

async function recordsOnPage(page) {
  return page.locator('#tblBenhNhan tr').evaluateAll((rows) => rows.flatMap((row) => {
    const anchor = row.querySelector('a[href*="HsBenhAn/"]');
    if (!anchor) return [];
    const url = new URL(anchor.getAttribute('href'), location.href);
    const id = url.href.match(/HsBenhAn\/([0-9a-f-]{36})(?:\/|$)/i)?.[1];
    if (!id || url.origin !== location.origin) return [];
    return [{ id, href: url.href, name: anchor.textContent.replace(/\s+/g, ' ').trim() }];
  }));
}

async function listFingerprint(page) {
  return page.locator('#tblBenhNhan').evaluate((body) =>
    Array.from(body.querySelectorAll('a[href*="HsBenhAn/"]'))
      .map((anchor) => anchor.getAttribute('href')).join('|')
  );
}

async function navigatePagination(page, label) {
  const link = page.locator(`ngb-pagination a[aria-label="${label}"]`);
  if (await link.count() !== 1) throw new Error(`Không tìm thấy phân trang ${label}`);
  const disabled = await link.evaluate((element) =>
    element.getAttribute('aria-disabled') === 'true' ||
    element.closest('li')?.classList.contains('disabled')
  );
  if (disabled) return false;
  const before = await listFingerprint(page);
  const [response] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes('/dieutri/bachoduyetky') &&
      response.request().method() === 'GET', { timeout: TIMEOUT }),
    link.click(),
  ]);
  if (!response.ok()) throw new Error(`Tải trang danh sách thất bại: HTTP ${response.status()}`);
  await page.waitForFunction((previous) => {
    const body = document.querySelector('#tblBenhNhan');
    if (!body) return false;
    const anchors = body.querySelectorAll('a[href*="HsBenhAn/"]');
    // Bảng bị làm trống ngay sau khi bấm phân trang rồi mới hiện trang mới;
    // phải chờ có dòng mới (khác trang cũ) để không đọc nhầm bảng rỗng.
    if (!anchors.length) return false;
    const current = Array.from(anchors).map((anchor) => anchor.getAttribute('href')).join('|');
    return current !== previous;
  }, before, { timeout: TIMEOUT });
  return true;
}

async function collectRecords(page, limit) {
  const records = new Map();
  if (!(await recordsOnPage(page)).length) return [];
  await navigatePagination(page, 'First');
  const fingerprints = new Set();
  for (;;) {
    const rows = await recordsOnPage(page);
    const fingerprint = rows.map((record) => record.id).join('|');
    if (fingerprints.has(fingerprint)) throw new Error('Phân trang lặp lại; dừng để tránh bỏ sót hồ sơ');
    fingerprints.add(fingerprint);
    for (const record of rows) {
      records.set(record.id, record);
      if (limit && records.size >= limit) return [...records.values()];
    }
    if (!await navigatePagination(page, 'Next')) return [...records.values()];
  }
}

// Bấm nút tìm kiếm để tải lại dữ liệu theo đúng bộ lọc đang đặt, không reload trang.
async function refreshList(page) {
  const search = page.locator('button.btn.btn-success.btn-sm:visible')
    .filter({ has: page.locator('i.fa-search') });
  if (await search.count() !== 1) throw new Error('Không xác định duy nhất nút tìm kiếm của danh sách');
  const [response] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes('/dieutri/bachoduyetky') &&
      response.request().method() === 'GET', { timeout: TIMEOUT }),
    search.click(),
  ]);
  if (!response.ok()) throw new Error(`Tải lại danh sách thất bại: HTTP ${response.status()}`);
  await page.locator('#tblBenhNhan').waitFor({ state: 'attached' });
  await page.waitForTimeout(LIST_RENDER_MS);
}

async function openMedicalChart(page, recordId) {
  await page.bringToFront();
  const chart = page.locator(`ul.toc-list a[title="${MEDICAL_CHART_NAME}"]`).or(
    page.locator('ul.toc-list a').filter({ hasText: /^Phiếu bệnh án\s*(?:\([^)]*\))?$/i })
  );
  await chart.first().waitFor({ state: 'visible', timeout: TIMEOUT });
  if (await chart.count() !== 1) throw new Error('Không xác định duy nhất mục Phiếu bệnh án để kiểm tra');
  log.info(recordId, 'Đang mở Phiếu bệnh án và chờ API danh sách phiếu của hồ sơ');
  const [response] = await Promise.all([
    page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.origin === ORIGIN &&
        url.pathname.endsWith(`/hsdikembenhan/hsDiKem/${recordId}`) &&
        response.request().method() === 'GET';
    }, { timeout: TIMEOUT }),
    chart.click(),
  ]);
  if (!response.ok()) throw new Error(`API sau khi mở Phiếu bệnh án HTTP ${response.status()}`);
  await page.waitForFunction((name) =>
    Array.from(document.querySelectorAll('ul.toc-list li.active a')).some((anchor) =>
      anchor.getAttribute('title') === name ||
      (anchor.textContent || '').replace(/\s+/g, ' ').trim().replace(/\s*\([^)]*\)$/, '') === name
    ), MEDICAL_CHART_NAME, { timeout: TIMEOUT });
  return parseDocuments(await response.json());
}

function parseDocuments(result) {
  const payload = typeof result === 'string' ? JSON.parse(result) : result;
  const documents = Array.isArray(payload) ? payload : [payload];
  if (!documents.length || documents.some((item) =>
    !item || typeof item.Ten !== 'string' || !normalizeText(item.Ten) ||
    (typeof item.IsDaKySo !== 'boolean' && item.IsDaKySo !== null)
  )) throw new Error('API tài liệu phải có Ten và IsDaKySo dạng boolean hoặc null');
  return documents;
}

function targetDocument(documents) {
  const targets = documents.filter((document) => normalizeText(document.Ten) === DOCUMENT_NAME);
  if (targets.length !== 1) throw new Error('Cần đúng một phiếu giao nhận; không chọn phiếu trùng tên');
  if (typeof targets[0].IsDaKySo !== 'boolean') {
    throw new Error('Phiếu giao nhận chưa có trạng thái IsDaKySo rõ ràng; không ký/gửi hồ sơ');
  }
  return targets[0];
}

function signaturePosition(document, code) {
  const positions = document.HSDiKemViTriKy;
  if (!Array.isArray(positions)) {
    throw new Error(`API ${document.Ten} thiếu HSDiKemViTriKy; không xác minh được chữ ký`);
  }
  const matches = positions.filter((item) => item?.MaViTri === code);
  if (matches.length !== 1 || typeof matches[0].IsDaKy !== 'boolean') {
    throw new Error(`API ${document.Ten} phải có đúng một vị trí ${code} với IsDaKy boolean`);
  }
  return matches[0].IsDaKy;
}

function transferSignatureState(document) {
  return {
    senderSigned: signaturePosition(document, 'NguoiGiaoHoSo'),
    receiverSigned: signaturePosition(document, 'NguoiNhanHoSo'),
  };
}

function administrativeSignatureState(documents) {
  const matches = documents.filter((item) => normalizeText(item.Ten) === ADMINISTRATIVE_NAME);
  if (matches.length !== 1) throw new Error('Cần đúng một mục Thông tin hành chính để kiểm tra Bác sĩ/Trưởng khoa');
  return {
    doctorSigned: signaturePosition(matches[0], 'BacSi'),
    departmentHeadSigned: signaturePosition(matches[0], 'TruongKhoa'),
  };
}

async function acceptAction(page, action) {
  const dialog = await waitForDialog(page);
  const text = normalizeText(await dialog.innerText());
  const matches = action === 'sign'
    ? /(?:xác nhận.*ký|ký.*xác nhận)/i.test(text) && !/gửi|cảnh báo|thiếu chữ ký/i.test(text)
    : /xác nhận gửi (?:gửi\s+)?(?:khth\s+)?(?:bệnh án|hồ sơ)/i.test(text) &&
      !/thiếu chữ ký|chưa hoàn thành ký|cần hoàn thiện/i.test(text);
  if (!matches) throw new Error(`Hộp thoại không đúng thao tác ${action}: ${text}`);
  const button = dialog.locator(
    '#confirmation-dialog-btn-accept, button.swal2-confirm'
  );
  const accept = await button.count() === 1 ? button : dialog.getByRole('button', {
    name: /^(Đồng ý|Xác nhận|CÓ|OK)$/i,
  });
  if (await accept.count() !== 1) throw new Error('Không xác định duy nhất nút xác nhận');
  await accept.click();
  await dialog.waitFor({ state: 'hidden', timeout: TIMEOUT });
}

async function signAndSend(page, record, execute) {
  const documents = await openMedicalChart(page, record.id);
  const check = checkDocumentEligibility(documents);
  log.info(record.id, `${check.reason}. IsDaKySo=false: ${check.unsignedDocuments.join(' | ') || '(không có)'}`);
  if (!check.eligible) return { status: 'skipped', note: check.reason, check };
  const target = targetDocument(documents);
  if (target.IsDaKySo) {
    return { status: 'skipped', note: 'API cho biết phiếu đã ký; cần kiểm tra thủ công chữ ký theo vai trò', check };
  }
  const initialSignature = transferSignatureState(target);
  if (!initialSignature.senderSigned || initialSignature.receiverSigned) {
    return {
      status: 'skipped',
      note: 'Phiếu giao nhận chưa đủ điều kiện: người giao phải đã ký và người nhận phải chưa ký',
      check,
      initialSignature,
    };
  }
  const initialAdministrativeSignature = administrativeSignatureState(documents);
  if (!initialAdministrativeSignature.doctorSigned || initialAdministrativeSignature.departmentHeadSigned) {
    return {
      status: 'skipped',
      note: 'Thông tin hành chính chưa đúng điều kiện: Bác sĩ phải đã ký và Trưởng khoa phải chưa ký',
      check,
      initialSignature,
      initialAdministrativeSignature,
    };
  }
  log.info(record.id, 'Đủ điều kiện giao/nhận và Bác sĩ/Trưởng khoa; giữ Phiếu bệnh án để ký ủy quyền');
  const sign = page.locator(`button[title="${SIGN_TITLE}"]`).or(
    page.getByRole('button', { name: SIGN_TITLE, exact: true })
  ).and(page.locator('button:visible'));
  const send = page.locator('button[title="Gửi ký hồ sơ"]').or(
    page.getByRole('button', { name: 'Gửi ký hồ sơ', exact: true })
  ).and(page.locator('button:visible'));
  await sign.or(send).first().waitFor({ state: 'visible', timeout: TIMEOUT });
  const sendReady = await send.count() > 0;
  if (sendReady) {
    if (await send.count() !== 1 || !await send.isEnabled()) {
      throw new Error('Không có duy nhất nút Gửi ký hồ sơ đang hiển thị và được phép bấm');
    }
    log.info(record.id, 'Nút Gửi ký hồ sơ đã có; không ký ủy quyền lại');
  } else if (await sign.count() !== 1 || !await sign.isEnabled()) {
    throw new Error('Không có duy nhất nút ký trưởng khoa/ủy quyền được phép bấm');
  }
  if (!execute) {
    return {
      status: 'test_ready',
      note: sendReady
        ? 'Đủ điều kiện API, nút gửi đã có trên Phiếu bệnh án; không ký lại và không gửi trong chế độ kiểm tra'
        : 'Đủ điều kiện API, tìm thấy nút ký ủy quyền trên Phiếu bệnh án; không bấm ký/gửi',
      check,
      initialSignature,
      initialAdministrativeSignature,
      sendReady,
    };
  }
  if (!sendReady) {
    await sign.click();
    log.info(record.id, 'Đã bấm ký ủy quyền; đang chờ hộp thoại xác nhận ký');
    await acceptAction(page, 'sign');
  }
  log.info(record.id, 'Đang chờ nút Gửi ký hồ sơ (title hoặc tên nút), không chờ IsDaKySo toàn phiếu');
  try {
    await send.first().waitFor({ state: 'visible', timeout: TIMEOUT });
  } catch (error) {
    throw new Error(`Đã xác nhận ký ủy quyền nhưng nút Gửi ký hồ sơ chưa xuất hiện: ${error.message}`, {
      cause: error,
    });
  }
  if (await send.count() !== 1 || !await send.isEnabled()) {
    throw new Error('Đã ký nhưng không có duy nhất nút Gửi ký hồ sơ đang hiển thị và được phép bấm');
  }
  try {
    log.info(record.id, 'Đã tìm thấy nút Gửi ký hồ sơ; đang bấm gửi và chờ xác nhận');
    await send.click();
    await acceptAction(page, 'send');
  } catch (error) {
    const sendError = new Error(`Không hoàn tất gửi sau khi đã ký: ${error.message}`, { cause: error });
    sendError.sendAttempted = true;
    throw sendError;
  }
  return {
    status: 'send_confirmed',
    note: 'Nút gửi đã sẵn sàng, đạt điều kiện giao/nhận và đã xác nhận gửi; đang kiểm tra lại danh sách từ máy chủ',
    check,
    initialSignature,
    initialAdministrativeSignature,
    signedThisRun: !sendReady,
  };
}

async function isRecordInList(page, listUrl, recordId) {
  return page.evaluate(async ({ listUrl, recordId }) => {
    const user = JSON.parse(localStorage.getItem('currentUser') || 'null');
    if (!user?.access_token) throw new Error('Phiên đăng nhập không hợp lệ khi xác minh gửi');
    const url = new URL(listUrl);
    url.searchParams.set('pageSize', '50');
    let scanned = 0;
    const fingerprints = new Set();
    for (let pageIndex = 1; ; pageIndex++) {
      url.searchParams.set('pageIndex', String(pageIndex));
      const response = await fetch(url.href, {
        cache: 'no-store', credentials: 'include',
        headers: { Authorization: `Bearer ${user.access_token}` },
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error(`API xác minh gửi HTTP ${response.status}`);
      const payload = await response.json();
      if (!Array.isArray(payload.List) ||
          !/^\d+$/.test(String(payload.total)) || !Number.isSafeInteger(Number(payload.total)) ||
          Number(payload.total) < 0) throw new Error('API xác minh gửi không có List/total hợp lệ');
      const ids = payload.List.map((item) => item?.Id || item?.id);
      if (ids.some((id) => typeof id !== 'string' || !id)) {
        throw new Error('API danh sách không có ID hồ sơ hợp lệ; không thể xác minh gửi');
      }
      if (ids.some((id) => id.toLowerCase() === recordId.toLowerCase())) return true;
      scanned += ids.length;
      if (scanned > Number(payload.total)) throw new Error('API danh sách có total không nhất quán');
      if (scanned >= Number(payload.total)) return false;
      if (!ids.length) throw new Error('API danh sách kết thúc trước total; không thể xác minh gửi');
      const fingerprint = ids.join('|');
      if (fingerprints.has(fingerprint)) throw new Error('API lặp trang khi xác minh gửi');
      fingerprints.add(fingerprint);
    }
  }, { listUrl, recordId });
}

async function verifySent(page, listUrl, recordId) {
  if (!listUrl) throw new Error('Chưa thu được API bộ lọc danh sách; không thể xác minh gửi');
  const deadline = Date.now() + TIMEOUT;
  while (Date.now() < deadline) {
    if (!await isRecordInList(page, listUrl, recordId)) return;
    await page.waitForTimeout(1000);
  }
  throw new Error('Hồ sơ vẫn còn trong danh sách đã lọc sau khi gửi; cần kiểm tra thủ công');
}

async function run(options) {
  const browser = await chromium.launch({ headless: false });
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const hasSession = fs.existsSync(STORAGE_STATE_PATH);
    const context = await browser.newContext(
      options.login || !hasSession ? {} : { storageState: STORAGE_STATE_PATH }
    );
    context.setDefaultTimeout(TIMEOUT);
    const listPage = await context.newPage();
    if (options.login || !hasSession) {
      log.info('DIRECTOR', 'Đang đăng nhập tự động bằng tài khoản trong config.json/ biến môi trường...');
      await autoLogin(listPage, docThongTinDangNhap());
      await saveLoginSession(context, listPage);
      log.info('DIRECTOR', 'Đã đăng nhập tự động và lưu phiên vào storageState.director.json.');
      if (options.login) return;
    }
    let listApiUrl;
    listPage.on('response', (response) => {
      const url = new URL(response.url());
      if (url.origin === ORIGIN && url.pathname.endsWith('/dieutri/bachoduyetky') &&
          response.request().method() === 'GET' && response.ok()) {
        listApiUrl = url.href;
      }
    });
    await listPage.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    log.info('DIRECTOR', options.execute
      ? 'CHẾ ĐỘ KÝ THẬT: sẽ ký trưởng khoa/ủy quyền và gửi ký hồ sơ.'
      : 'CHẾ ĐỘ KIỂM TRA: không bấm ký và không gửi hồ sơ.');
    await input.question('Đặt bộ lọc trên Danh sách chờ ký (Trưởng khoa) và tải danh sách. Nhấn Enter để bắt đầu: ');
    if (!isTargetListPage(listPage.url())) {
      throw new Error('Phải ở Danh sách chờ ký (Trưởng khoa), TrangThai=ChoKyTruongKhoa');
    }
    await listPage.locator('#tblBenhNhan').waitFor();
    if (!listApiUrl) throw new Error('Hãy tải danh sách bằng bộ lọc trước khi bắt đầu; chưa có API danh sách');
    // Chốt danh sách trước khi gửi để việc hồ sơ rời danh sách không làm lệch phân trang.
    const processed = new Set();
    const processRecord = async (record) => {
      processed.add(record.id);
      if (!isTargetListPage(listPage.url())) {
        throw new Error('Trang danh sách đã đổi khỏi ChoKyTruongKhoa; dừng xử lý');
      }
      const result = { recordId: record.id, name: record.name, execute: options.execute };
      let detail;
      try {
        // Kiểm tra bằng API danh sách, không lật trang trên giao diện.
        if (!await isRecordInList(listPage, listApiUrl, record.id)) {
          Object.assign(result, { status: 'skipped', note: 'Hồ sơ không còn trong danh sách đã lọc' });
        } else {
          detail = await context.newPage();
          await detail.goto(record.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
          Object.assign(result, await signAndSend(detail, record, options.execute));
          if (result.status === 'send_confirmed') {
            log.info(record.id, `Đã bấm xác nhận gửi; chờ ${SEND_SETTLE_MS / 1000}s để hệ thống xử lý`);
            await listPage.waitForTimeout(SEND_SETTLE_MS);
            await verifySent(listPage, listApiUrl, record.id);
            Object.assign(result, {
              status: 'sent_verified',
              note: 'Đã xác nhận gửi sau bước ký ủy quyền hoặc dùng nút gửi sẵn có, xác minh hồ sơ rời danh sách đã lọc',
            });
          }
        }
      } catch (error) {
        result.stopRequired = result.status === 'send_confirmed' || error.sendAttempted === true ||
          (browser.isConnected() && !listPage.isClosed() && await listPage.locator(DIALOGS).count() > 0);
        Object.assign(result, { status: 'error', note: error.message });
        log.error(record.id, error.message);
        if (browser.isConnected() && detail && !detail.isClosed()) {
          await detail.screenshot({
            path: path.join(__dirname, 'logs', `director-error-${record.id}-${Date.now()}.png`),
            fullPage: true,
          }).catch((screenshotError) => log.warn(record.id, `Không chụp được lỗi: ${screenshotError.message}`));
        }
      } finally {
        if (detail && !detail.isClosed()) await detail.close();
      }
      result.checkedAt = new Date().toISOString();
      fs.appendFileSync(RESULT_PATH, `${JSON.stringify(result)}\n`, 'utf8');
      log.info(record.id, `${result.status}: ${result.note}`);
      if (result.stopRequired) {
        throw new Error('Kết quả gửi chưa rõ hoặc hộp thoại danh sách còn mở. Dừng để kiểm tra thủ công.');
      }
      if (!browser.isConnected() || listPage.isClosed()) throw new Error('Trình duyệt đã đóng; dừng xử lý');
    };
    for (let round = 1; ; round++) {
      if (round > 1) {
        log.info('DIRECTOR', 'Đã xử lý hết danh sách đã chốt; bấm tìm kiếm để lấy dữ liệu mới');
        await refreshList(listPage);
      }
      const collected = await collectRecords(listPage, options.limit ? options.limit + processed.size : 0);
      let records = collected.filter((record) => !processed.has(record.id));
      if (options.limit) records = records.slice(0, options.limit - processed.size);
      if (!records.length) {
        log.info('DIRECTOR', `Không còn hồ sơ mới. Đã xử lý ${processed.size} hồ sơ.`);
        break;
      }
      // Chốt danh sách của lượt này trước khi gửi để việc hồ sơ rời danh sách không làm lệch phân trang.
      log.info('DIRECTOR', `Lượt ${round}: danh sách có ${collected.length} hồ sơ, đã xử lý trước đó ${collected.length - records.length}, mới ${records.length}. Không thay đổi bộ lọc khi đang chạy.`);
      for (const record of records) await processRecord(record);
      if (options.limit && processed.size >= options.limit) break;
    }
  } finally {
    input.close();
    await browser.close();
  }
}

function main(args = process.argv.slice(2)) {
  return Promise.resolve().then(() => run(parseOptions(args))).catch((error) => {
    log.error('DIRECTOR', error.stack || error.message);
    process.exitCode = 1;
  });
}

if (require.main === module) main();

module.exports = {
  main,
  DOCUMENT_NAME, SIGN_TITLE, checkDocumentEligibility, parseOptions, targetDocument,
  collectRecords, refreshList, signAndSend, acceptAction,
  isRecordInList,
  STORAGE_STATE_PATH, saveLoginSession, autoLogin, isAuthenticated,
  LIST_URL, isTargetListPage,
  parseDocuments,
  MEDICAL_CHART_NAME, openMedicalChart,
  transferSignatureState,
  ADMINISTRATIVE_NAME, administrativeSignatureState,
};
