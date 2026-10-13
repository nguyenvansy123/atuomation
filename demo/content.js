const AUTO_PAGE_RE = /\/HSBA\/DsBenhAnChoKy/i;
const ALLOWED_DOC_NAMES = ['Phiếu giao nhận hồ sơ bệnh án', 'Thông tin hành chính'];
const ACTIVE_KEY = 'hsba_auto_active';
const JOB_KEY = 'hsba_auto_job_v1';
let capturedAuthorization = '';
let processing = false;

function normalizeText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function visible(element) {
  return !!element && element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== 'hidden';
}

async function ensureActive(runId) {
  const stored = await chrome.storage.local.get([ACTIVE_KEY, JOB_KEY]);
  if (!stored[ACTIVE_KEY] || stored[JOB_KEY]?.runId !== runId ||
      stored[JOB_KEY]?.status !== 'running') throw new Error('Đã dừng xử lý');
}

async function waitFor(predicate, runId, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await ensureActive(runId);
    const value = predicate();
    if (value) return value;
    await wait(300);
  }
  throw new Error('Quá thời gian chờ giao diện');
}

function getRecordLinks() {
  const seen = new Set();
  return Array.from(document.querySelectorAll('a[href]')).flatMap((anchor) => {
    const href = new URL(anchor.getAttribute('href'), location.href);
    const match = href.href.match(/HsBenhAn\/([0-9a-f-]{36})/i);
    if (href.origin !== location.origin || !match || seen.has(match[1])) return [];
    seen.add(match[1]);
    return [{ recordId: match[1], name: normalizeText(anchor.innerText), href: href.href }];
  });
}

function isJwtLike(value) {
  return typeof value === 'string' && /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(value);
}

function getAuthorizationHeader() {
  if (capturedAuthorization) return capturedAuthorization;
  for (const store of [window.localStorage, window.sessionStorage]) {
    const direct = store.getItem('ls.bearerToken');
    if (isJwtLike(direct)) return `Bearer ${direct}`;
    for (let i = 0; i < store.length; i++) {
      const value = store.getItem(store.key(i));
      if (isJwtLike(value)) return `Bearer ${value}`;
      let parsed;
      try {
        parsed = JSON.parse(value);
      } catch {
        continue;
      }
      const token = parsed?.token || parsed?.access_token || parsed?.accessToken || parsed?.id_token;
      if (isJwtLike(token)) return `Bearer ${token}`;
    }
  }
  throw new Error('Không tìm thấy Authorization; hãy đăng nhập và tải lại trang');
}

async function fetchDocuments(recordId, runId) {
  await ensureActive(runId);
  const response = await fetch(
    `https://bvrhm.hosoyte.com/api/79415/hsdikembenhan/hsDiKem/${recordId}`,
    {
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json', Authorization: getAuthorizationHeader() },
      signal: AbortSignal.timeout(20000)
    }
  );
  if (!response.ok) throw new Error(`API HTTP ${response.status}`);
  let payload = await response.json();
  if (typeof payload === 'string') payload = JSON.parse(payload);
  const items = Array.isArray(payload) ? payload : [payload];
  if (items.some((item) => !item || typeof item.Ten !== 'string' || typeof item.IsDaKySo !== 'boolean')) {
    throw new Error('API trả về cấu trúc tài liệu không hợp lệ');
  }
  return items;
}

function allowedDocuments(items) {
  return items.filter((item) => ALLOWED_DOC_NAMES.includes(normalizeText(item.Ten)));
}

function findDocument(name) {
  return Array.from(document.querySelectorAll('a')).find((anchor) =>
    visible(anchor) && [anchor.getAttribute('title'), anchor.innerText]
      .some((value) => normalizeText(value) === normalizeText(name)));
}

function findButton(predicate) {
  return Array.from(document.querySelectorAll('button, a[role="button"], input[type="button"], input[type="submit"]'))
    .find((button) => visible(button) && !button.disabled &&
      button.getAttribute('aria-disabled') !== 'true' &&
      predicate(normalizeText(`${button.getAttribute('title') || ''} ${button.innerText || button.value || ''}`).toLowerCase()));
}

function signingButton() {
  return findButton((text) => text.includes('ký số') && text.includes('trưởng khoa') &&
    (text.includes('ủy quyền') || text.includes('ky u quyen')));
}

function sendingButton() {
  return findButton((text) => text.includes('gửi ký hồ sơ'));
}

function confirmation(action) {
  let modals = Array.from(document.querySelectorAll('.modal-dialog')).filter(visible);
  if (!modals.length) modals = Array.from(document.querySelectorAll('[role="dialog"]')).filter(visible);
  if (!modals.length) return null;
  const matches = modals.filter((modal) => {
    const text = normalizeText(modal.innerText).toLowerCase();
    return action === 'sign'
      ? text.includes('ký') && !text.includes('gửi')
      : text.includes('gửi') && text.includes('hồ sơ');
  });
  if (!matches.length) return null;
  if (matches.length !== 1) throw new Error('Có nhiều hộp thoại xác nhận cùng thao tác; không tự động xác nhận');
  const modal = matches[0];
  const accept = modal.querySelector('#confirmation-dialog-btn-accept, button.btn-primary');
  if (!visible(accept) || accept.disabled) return null;
  return { modal, accept };
}

async function dismissModal(dialog, runId) {
  const cancel = dialog.modal.querySelector(
    '#confirmation-dialog-btn-cancel, button.btn-secondary, button[data-dismiss="modal"], button.close, .close'
  );
  if (!visible(cancel) || cancel.disabled) throw new Error('Không tìm thấy nút hủy hộp thoại test');
  await ensureActive(runId);
  cancel.click();
  await waitFor(() => !visible(dialog.modal), runId);
}

async function verifySigned(recordId, name, previousUnsigned, runId) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const documents = allowedDocuments(await fetchDocuments(recordId, runId));
    const sameName = documents.filter((item) => normalizeText(item.Ten) === name);
    if (!sameName.length) throw new Error('Tài liệu biến mất khỏi API sau khi ký');
    const remaining = sameName.filter((item) => !item.IsDaKySo).length;
    if (remaining < previousUnsigned) return documents;
    await wait(1000);
  }
  throw new Error(`API chưa xác nhận ký thành công: ${name}`);
}

async function processRecord(message) {
  const { record, runId, testMode } = message;
  const result = {
    recordId: record.recordId,
    itemName: record.name,
    testMode,
    signedDocuments: [],
    testedDocuments: [],
    alreadySigned: [],
    sendButtonFound: false,
    sendConfirmed: false,
    sendVerified: false,
    error: false,
    checkedAt: new Date().toISOString(),
    note: ''
  };
  try {
    if (!new RegExp(`HsBenhAn/${record.recordId}`, 'i').test(location.href)) {
      throw new Error('Tab không mở đúng hồ sơ yêu cầu');
    }
    await waitFor(() => document.readyState === 'complete', runId);
    await wait(10000);
    let documents = allowedDocuments(await fetchDocuments(record.recordId, runId));
    if (!documents.length) throw new Error('Không có tài liệu thuộc hai loại được phép ký');
    result.alreadySigned = documents.filter((item) => item.IsDaKySo).map((item) => item.Ten);
    const pendingNames = [...new Set(documents.filter((item) => !item.IsDaKySo).map((item) => normalizeText(item.Ten)))];
    if (!pendingNames.length) {
      result.note = 'Tài liệu đã ký từ trước; không gửi theo quy tắc đã chọn';
      return result;
    }
    for (const name of pendingNames) {
      const unsigned = documents.filter((item) => normalizeText(item.Ten) === name && !item.IsDaKySo).length;
      // A title alone cannot identify one of multiple same-name documents safely.
      if (documents.filter((item) => normalizeText(item.Ten) === name).length > 1) {
        throw new Error(`Có nhiều tài liệu cùng tên: ${name}; cần chọn theo ID`);
      }
      if (!unsigned) continue;
      const anchor = await waitFor(() => findDocument(name), runId);
      await ensureActive(runId);
      anchor.click();
      await wait(4000);
      const sign = await waitFor(signingButton, runId);
      await ensureActive(runId);
      sign.click();
      const dialog = await waitFor(() => confirmation('sign'), runId);
      if (testMode) {
        await dismissModal(dialog, runId);
        result.testedDocuments.push(name);
      } else {
        await ensureActive(runId);
        dialog.accept.click();
        documents = await verifySigned(record.recordId, name, unsigned, runId);
        result.signedDocuments.push(name);
        await waitFor(() => !visible(dialog.modal), runId);
      }
    }
    if (!testMode) {
      documents = allowedDocuments(await fetchDocuments(record.recordId, runId));
      if (!documents.length || documents.some((item) => !item.IsDaKySo)) {
        throw new Error('Chưa xác minh tất cả tài liệu theo quy tắc đã ký; không gửi');
      }
      if (!result.signedDocuments.length) throw new Error('Lượt này chưa ký tài liệu nào; không gửi');
    }
    const send = await waitFor(sendingButton, runId);
    result.sendButtonFound = true;
    if (testMode) {
      result.note = 'TEST OK: tìm được bước ký và nút gửi; không xác nhận ký, không bấm gửi';
      return result;
    }
    await ensureActive(runId);
    send.click();
    const dialog = await waitFor(() => confirmation('send'), runId);
    await ensureActive(runId);
    dialog.accept.click();
    result.sendConfirmed = true;
    result.note = 'API đã xác nhận ký; đã bấm xác nhận gửi ký hồ sơ. Chưa xác minh kết quả gửi từ máy chủ.';
    await waitFor(() => !visible(dialog.modal), runId);
  } catch (error) {
    result.error = true;
    result.note = `Lỗi: ${error.message}`;
    console.error('[HSBA Auto]', record.recordId, error);
  }
  return result;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'hsba-auto-start') {
    if (!AUTO_PAGE_RE.test(location.href)) {
      sendResponse({ ok: false, reason: 'not_target_page' });
      return false;
    }
    Promise.resolve().then(() => chrome.runtime.sendMessage({
      type: 'hsba-queue-start',
      records: getRecordLinks()
    })).then(sendResponse).catch((error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }
  if (message?.type !== 'hsba-worker-process') return false;
  if (processing) {
    sendResponse({ ok: false, message: 'Tab này đang xử lý hồ sơ' });
    return false;
  }
  processing = true;
  sendResponse({ ok: true });
  processRecord(message).then((result) => chrome.runtime.sendMessage({
    type: 'hsba-worker-result', runId: message.runId, result
  })).catch((error) => console.error('[HSBA Auto] Không gửi được kết quả', error));
  return false;
});

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== location.origin) return;
  if (event.data?.__hsba_auth__ && typeof event.data.authorization === 'string') {
    capturedAuthorization = event.data.authorization;
  }
});
const authScript = document.createElement('script');
authScript.src = chrome.runtime.getURL('inject.js');
authScript.onload = () => authScript.remove();
authScript.onerror = () => console.error('[HSBA Auto] Không nạp được script thu nhận Authorization');
(document.head || document.documentElement).appendChild(authScript);
chrome.runtime.sendMessage({ type: 'hsba-worker-ready' })
  .catch((error) => console.error('[HSBA Auto] Không kết nối được bộ điều phối', error));
