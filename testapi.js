const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const STORAGE_STATE_PATH = path.join(__dirname, 'storageState.json');
const TARGET_URL = 'https://bvrhm.hosoyte.com/v2/#/HSBA/DsBenhAnChoKy?TrangThai=ChoDuyet';

function getAccessTokenFromStorageState() {
  try {
    if (!fs.existsSync(STORAGE_STATE_PATH)) {
      return null;
    }

    const raw = fs.readFileSync(STORAGE_STATE_PATH, 'utf8');
    const state = JSON.parse(raw);
    const origin = (state.origins || []).find((item) => item.origin === 'https://bvrhm.hosoyte.com');
    const currentUser = (origin?.localStorage || []).find((item) => item.name === 'currentUser');

    if (!currentUser?.value) {
      return null;
    }

    const parsed = JSON.parse(currentUser.value);
    return parsed?.access_token || null;
  } catch (error) {
    console.error('Không đọc được token từ storageState.json:', error.message);
    return null;
  }
}

async function ensureLoggedIn(page, tokenFromFile) {
  const currentUserFromPage = await page.evaluate(() => {
    try {
      const raw = localStorage.getItem('currentUser');
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return null;
    }
  });

  if (currentUserFromPage?.access_token || tokenFromFile) {
    console.log('Session đã có sẵn, tiếp tục inject UI.');
    return;
  }

  console.log('Chưa có session hợp lệ. Mở trang đăng nhập để bạn login thủ công...');
  await page.goto('https://bvrhm.hosoyte.com/v2/', { waitUntil: 'domcontentloaded', timeout: 120000 });
  console.log('Sau khi đăng nhập xong, nhấn Enter trong terminal để tiếp tục.');
  await new Promise((resolve) => {
    process.stdin.once('data', () => resolve());
  });
}

async function injectApiTestUI(page) {
  await page.evaluate(async () => {
    const already = document.getElementById('api-test-menu-root');
    if (already) {
      already.remove();
    }

    const root = document.createElement('div');
    root.id = 'api-test-menu-root';
    root.style.position = 'fixed';
    root.style.top = '12px';
    root.style.right = '12px';
    root.style.width = '460px';
    root.style.maxWidth = 'calc(100vw - 24px)';
    root.style.background = '#fff';
    root.style.border = '1px solid #d1d5db';
    root.style.borderRadius = '10px';
    root.style.boxShadow = '0 10px 30px rgba(0,0,0,0.15)';
    root.style.zIndex = '999999';
    root.style.fontFamily = 'Arial, sans-serif';
    root.style.padding = '12px';
    root.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <strong style="font-size:14px;">API Test</strong>
        <button id="api-test-close" style="border:1px solid #ccc;background:#f3f4f6;border-radius:6px;padding:4px 8px;cursor:pointer;">Đóng</button>
      </div>

      <div style="display:flex;flex-direction:column;gap:10px;">
        <div style="display:grid;grid-template-columns:120px 1fr 100px;gap:8px;align-items:center;">
          <label style="font-size:12px;font-weight:700;">1. DS hồ sơ</label>
          <input id="api-list-url" value="https://bvrhm.hosoyte.com/api/79415/dieutri/bachoduyetky?isCapCuu=false&iBaoHiem=2&NamVien=iALL&from=01/01/2026&to=07/31/2026&idKhoa=00000000-0000-0000-0000-000000000000&idCanBo=undefined&maLoaiBenhAn=&strsearch=&iBADT=2&MaTrangThaiNode=DONE&pageIndex=1&pageSize=10&Active=true&TrangThaiKy=ChoDuyet&idTruongKhoaKy=undefined&idNguoiDuyet=undefined" style="width:100%;min-height:34px;border:1px solid #d1d5db;border-radius:6px;padding:6px 8px;" />
          <button data-api="list" style="min-height:34px;border:1px solid #93c5fd;background:#eff6ff;color:#1d4ed8;border-radius:6px;font-weight:700;cursor:pointer;">Gọi API</button>
        </div>

        <div style="display:grid;grid-template-columns:120px 1fr 100px;gap:8px;align-items:center;">
          <label style="font-size:12px;font-weight:700;">2. Mở hồ sơ</label>
          <input id="api-detail-url" value="https://bvrhm.hosoyte.com/api/79415/hsbenhan/ba8ff0d0-cd19-4034-b40a-b4410afdac67" style="width:100%;min-height:34px;border:1px solid #d1d5db;border-radius:6px;padding:6px 8px;" />
          <button data-api="detail" style="min-height:34px;border:1px solid #93c5fd;background:#eff6ff;color:#1d4ed8;border-radius:6px;font-weight:700;cursor:pointer;">Gọi API</button>
        </div>

        <div style="display:grid;grid-template-columns:120px 1fr 100px;gap:8px;align-items:center;">
          <label style="font-size:12px;font-weight:700;">3. Giao nhận</label>
          <input id="api-sign-url" value="https://bvrhm.hosoyte.com/api/79415/dieutri//e27af326-e9af-40a6-8063-45af44709944/guitruongkhoa?idBenhAn=e27af326-e9af-40a6-8063-45af44709944&idCanBo=5464b473-9f1c-4826-a7bd-a77bfc2ebc5f&action=4" style="width:100%;min-height:34px;border:1px solid #d1d5db;border-radius:6px;padding:6px 8px;" />
          <button data-api="sign" style="min-height:34px;border:1px solid #fbbf24;background:#fef3c7;color:#92400e;border-radius:6px;font-weight:700;cursor:pointer;">Gọi API</button>
        </div>
      </div>

      <pre id="api-test-output" style="margin-top:12px;background:#111827;color:#e5e7eb;border-radius:8px;padding:10px;min-height:140px;white-space:pre-wrap;overflow:auto;font-size:12px;line-height:1.5;">Chưa có kết quả API.</pre>
    `;

    document.body.appendChild(root);

    const output = document.getElementById('api-test-output');
    const closeBtn = document.getElementById('api-test-close');
    closeBtn.addEventListener('click', () => root.remove());

    const getToken = () => {
      try {
        const raw = localStorage.getItem('currentUser');
        if (!raw) return '';
        const parsed = JSON.parse(raw);
        return parsed?.access_token || '';
      } catch (error) {
        return '';
      }
    };

    async function callApi(url, method = 'GET', body = null) {
      const token = getToken();
      if (!token) {
        output.textContent = 'Không tìm thấy token trong localStorage. Hãy đăng nhập trước khi gọi API.';
        return;
      }

      output.textContent = `Đang gọi ${method} ${url} ...`;
      try {
        const response = await fetch(url, {
          method,
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: method === 'GET' || method === 'HEAD' ? undefined : body ? JSON.stringify(body) : undefined,
        });

        let data;
        try {
          data = await response.json();
        } catch (error) {
          data = await response.text();
        }

        output.textContent = JSON.stringify({ status: response.status, ok: response.ok, data }, null, 2);
      } catch (error) {
        output.textContent = `Lỗi khi gọi API: ${error.message}`;
      }
    }

    document.querySelectorAll('[data-api]').forEach((button) => {
      button.addEventListener('click', () => {
        const mode = button.getAttribute('data-api');
        if (mode === 'list') {
          const url = document.getElementById('api-list-url').value.trim();
          callApi(url, 'GET');
        }

        if (mode === 'detail') {
          const url = document.getElementById('api-detail-url').value.trim();
          callApi(url, 'GET');
        }

        if (mode === 'sign') {
          const url = document.getElementById('api-sign-url').value.trim();
          callApi(url, 'DELETE');
        }
      });
    });
  }, {});
}

(async () => {
  const tokenFromFile = getAccessTokenFromStorageState();
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, storageState: STORAGE_STATE_PATH });
  const page = await context.newPage();

  console.log('Mở trang target...');
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });

  await ensureLoggedIn(page, tokenFromFile);

  if (!tokenFromFile) {
    const refreshedToken = getAccessTokenFromStorageState();
    if (!refreshedToken) {
      console.log('Không có token hợp lệ trong storageState.json. Hãy login vào web rồi chạy lại script.');
      await page.goto('https://bvrhm.hosoyte.com/v2/', { waitUntil: 'domcontentloaded', timeout: 120000 });
      await new Promise(() => {});
      return;
    }
  }

  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await injectApiTestUI(page);

  console.log('Menu test API đã được chèn vào trang web target.');
  console.log('Giữ cửa sổ browser mở để dùng chức năng test API.');
  await new Promise(() => {});
})();
