const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  PhienDangNhap, PhienHetHanError, LoiDangNhapError, kiemTraPhanHoiDangNhap,
} = require('../session');

const env = { PACS_USER: process.env.PACS_USER, PACS_PASS: process.env.PACS_PASS };
process.env.PACS_USER = 'test-user';
process.env.PACS_PASS = 'test-pass';
const { CFG, phien, goiApi, taiMotDongCoThoiHan, xuLyMaBN, ketQuaTongHopLoai } = require('../AutoDownload');
for (const [key, value] of Object.entries(env)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function fakePage() {
  const page = new EventEmitter();
  page.address = CFG.urlTimKiem;
  page.token = 'old-token';
  page.logins = 0;
  page.searches = [];
  page.url = () => page.address;
  page.evaluate = async (fn) => {
    if (fn.toString().includes('removeItem')) {
      page.token = null;
      return;
    }
    return page.token;
  };
  page.locator = () => ({
    isVisible: async () => page.address === CFG.urlLogin,
    count: async () => 0,
  });
  page.goto = async (url) => { page.address = url; };
  page.fill = async (selector, value) => {
    if (selector === CFG.selOTimKiem) page.searches.push(value);
  };
  page.click = async () => {
    page.logins++;
    page.address = CFG.urlTimKiem;
    page.token = 'fresh-token';
  };
  page.waitForSelector = async () => {};
  page.getByRole = () => ({ first: () => ({ click: async () => {} }) });
  page.keyboard = { press: async () => {} };
  return page;
}

function session(page) {
  const manager = new PhienDangNhap(CFG);
  manager.lanDangNhapCuoi = Date.now();
  manager.theoDoi(page);
  return manager;
}

function mockFetch(t, handler) {
  const original = global.fetch;
  global.fetch = handler;
  t.after(() => { global.fetch = original; });
}

function overrideConfig(t, values) {
  const original = {};
  for (const [key, value] of Object.entries(values)) {
    original[key] = CFG[key];
    CFG[key] = value;
  }
  t.after(() => Object.assign(CFG, original));
}

test('valid session does not log in again', async () => {
  const page = fakePage();
  const manager = session(page);
  assert.equal(await manager.xuLyVoiDangNhapLai(page, 'TEST', async () => 'OK'), 'OK');
  assert.equal(page.logins, 0);
});

test('six-hour threshold triggers login before processing the next patient', async () => {
  const page = fakePage();
  const manager = session(page);
  manager.lanDangNhapCuoi = Date.now() - CFG.dangNhapLaiSauMs - 1;
  await manager.xuLyVoiDangNhapLai(page, 'TEST', async () => {
    assert.equal(page.logins, 1);
    assert.equal(page.token, 'fresh-token');
  });
});

test('missing token and login redirect recover the same patient', async () => {
  for (const expired of ['token', 'redirect']) {
    const page = fakePage();
    const manager = session(page);
    if (expired === 'token') page.token = null;
    else page.address = CFG.urlLogin;
    let attempts = 0;
    assert.equal(await manager.xuLyVoiDangNhapLai(page, 'TEST', async () => ++attempts), 1);
    assert.equal(page.logins, 1);
    assert.equal(attempts, 1);
  }
});

test('UI HTTP 401 is detected even if its token and URL still look valid', async () => {
  const page = fakePage();
  const manager = session(page);
  manager.theoDoi(page);
  assert.equal(page.listenerCount('response'), 1);
  page.emit('response', { status: () => 401, url: () => `${CFG.urlApi}/image` });
  await manager.xuLyVoiDangNhapLai(page, 'TEST', async () => 'OK');
  assert.equal(page.logins, 1);
  await manager.kiemTra(page);
});

test('unrelated origins and HTTP 403 do not trigger login', async () => {
  const page = fakePage();
  const manager = session(page);
  page.emit('response', { status: () => 401, url: () => 'https://example.org/image' });
  page.emit('response', { status: () => 403, url: () => `${CFG.urlApi}/image` });
  await manager.kiemTra(page);
  await kiemTraPhanHoiDangNhap(new Response(null, { status: 403 }), 'test');
  assert.equal(page.logins, 0);
});

test('API HTTP 401 cancels the response body and preserves its error type', async () => {
  let cancelled = false;
  await assert.rejects(
    kiemTraPhanHoiDangNhap({
      status: 401, body: { cancel: async () => { cancelled = true; } },
    }, 'test'),
    PhienHetHanError
  );
  assert.equal(cancelled, true);
});

test('API expiry reauthenticates and retries the action with the fresh token', async (t) => {
  const page = fakePage();
  const manager = session(page);
  const tokens = [];
  mockFetch(t, async (_url, options) => {
    tokens.push(options.headers.authorization);
    return new Response(null, { status: page.token === 'old-token' ? 401 : 200 });
  });
  const response = await manager.xuLyVoiDangNhapLai(page, 'TEST', () =>
    goiApi(`${CFG.urlApi}/test`, {
      headers: { authorization: `Bearer ${page.token}` },
    }, 'TEST', 'test')
  );
  assert.equal(response.status, 200);
  assert.equal(page.logins, 1);
  assert.deepEqual(tokens, ['Bearer old-token', 'Bearer fresh-token']);
});

test('ordinary API/network errors retain the normal failure path', async (t) => {
  const page = fakePage();
  const manager = session(page);
  let networkFailure = false;
  mockFetch(t, async () => {
    if (networkFailure) throw new Error('network failed');
    return new Response('Forbidden', { status: 403 });
  });
  await assert.rejects(manager.xuLyVoiDangNhapLai(page, 'TEST', () =>
    goiApi(`${CFG.urlApi}/test`, {}, 'TEST', 'test')
  ), /HTTP 403/);
  networkFailure = true;
  await assert.rejects(manager.xuLyVoiDangNhapLai(page, 'TEST', () =>
    goiApi(`${CFG.urlApi}/test`, {}, 'TEST', 'test')
  ), /network failed/);
  assert.equal(page.logins, 0);
});

test('a UI timeout followed by a login redirect is recovered immediately', async () => {
  const page = fakePage();
  const manager = session(page);
  let attempts = 0;
  assert.equal(await manager.xuLyVoiDangNhapLai(page, 'TEST', async () => {
    attempts++;
    if (attempts === 1) {
      page.address = CFG.urlLogin;
      throw new Error('locator timeout');
    }
    return 'OK';
  }), 'OK');
  assert.equal(attempts, 2);
  assert.equal(page.logins, 1);
});

test('persistent expiry stops after two recovery logins and keeps partial results', async () => {
  const page = fakePage();
  const manager = session(page);
  const completed = [{ loai: 'CONE_BEAM', ok: true, duongDan: 'completed.zip' }];
  let attempts = 0;
  await assert.rejects(manager.xuLyVoiDangNhapLai(page, 'TEST', async () => {
    attempts++;
    const error = new PhienHetHanError('expired');
    error.chiTiet = completed;
    throw error;
  }), (error) => {
    assert.ok(error instanceof LoiDangNhapError);
    assert.deepEqual(error.chiTiet, completed);
    return true;
  });
  assert.equal(page.logins, 2);
  assert.equal(attempts, 3);
});

test('failed recovery login is fatal and preserves completed study metadata', async () => {
  const page = fakePage();
  const manager = session(page);
  const completed = [{ loai: 'CONE_BEAM', ok: true, duongDan: 'completed.zip' }];
  page.click = async () => { throw new Error('login unavailable'); };
  await assert.rejects(manager.xuLyVoiDangNhapLai(page, 'TEST', async () => {
    const error = new PhienHetHanError('expired');
    error.chiTiet = completed;
    throw error;
  }), (error) => {
    assert.ok(error instanceof LoiDangNhapError);
    assert.match(error.message, /login unavailable/);
    assert.deepEqual(error.chiTiet, completed);
    return true;
  });
});

test('an interrupted type remains retryable while keeping its completed file paths', () => {
  const completed = { loai: 'CONE_BEAM', ok: true, duongDan: 'completed.zip' };
  const interrupted = { loai: 'CONE_BEAM', ok: false, boQua: false, hetPhien: true };
  assert.deepEqual(ketQuaTongHopLoai([completed, interrupted], 'CONE_BEAM'), {
    trangThai: 'LOI', duongDanGop: 'completed.zip',
  });
  assert.deepEqual(ketQuaTongHopLoai([completed], 'CONE_BEAM'), {
    trangThai: 'OK', duongDanGop: 'completed.zip',
  });
});

test('redirect during patient search is not misclassified as no data', async (t) => {
  overrideConfig(t, { doiSauKhiTimKiemMs: 0 });
  const page = fakePage();
  const manager = session(page);
  let navigations = 0;
  page.goto = async (url) => {
    navigations++;
    page.address = navigations === 1 ? CFG.urlLogin : url;
  };
  const result = await manager.xuLyVoiDangNhapLai(page, 'TEST', () =>
    xuLyMaBN('TEST', page, {})
  );
  assert.equal(page.logins, 1);
  assert.deepEqual(page.searches, ['TEST']);
  assert.equal(result.trangThai, 'KHONG_TIM_THAY');
});

test('HTTP 401 during the search wait does not silently skip the patient', async (t) => {
  overrideConfig(t, { doiSauKhiTimKiemMs: 0 });
  const page = fakePage();
  const manager = phien;
  manager.lanDangNhapCuoi = Date.now();
  phien.theoDoi(page);
  let searches = 0;
  page.keyboard.press = async () => {
    if (++searches === 1) {
      page.emit('response', { status: () => 401, url: () => `${CFG.urlApi}/search` });
    }
  };
  const result = await manager.xuLyVoiDangNhapLai(page, 'TEST', () =>
    xuLyMaBN('TEST', page, {})
  );
  assert.equal(page.logins, 1);
  assert.equal(searches, 2);
  assert.deepEqual(page.searches, ['TEST', 'TEST']);
  assert.equal(result.trangThai, 'KHONG_TIM_THAY');
});

test('completed downloads are not repeated when another study expires', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pacs-session-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  overrideConfig(t, { thuMucTai: directory });
  const page = fakePage();
  const manager = session(page);
  let downloads = 0;
  let unauthorized = 0;
  mockFetch(t, async (url, options) => {
    if (url.includes('get-patient-image')) {
      const sid = new URL(url).searchParams.get('sID');
      if (sid === 'S2' && options.headers.authorization === 'Bearer old-token') {
        unauthorized++;
        return new Response(null, { status: 401 });
      }
      return Response.json({ data: { studyList: [{
        studyID: sid,
        seriesList: [{ stackId: sid, dcmFileCount: 1, seriesIndex: 0 }],
      }] } });
    }
    downloads++;
    return new Response(Buffer.from('UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==', 'base64'));
  });
  const paths = await manager.xuLyVoiDangNhapLai(page, 'TEST', async () => {
    const result = [];
    for (const sid of ['S1', 'S2']) {
      result.push(await taiMotDongCoThoiHan(
        page, 'TEST', 'TEST', { ma: 'TOAN_CANH', ten: 'Toan canh' },
        { evaluate: async () => ({ sid }) }, { choTenFile: sid }
      ));
    }
    return result;
  });
  assert.equal(unauthorized, 1);
  assert.equal(page.logins, 1);
  assert.equal(downloads, 2);
  assert.equal(paths.length, 2);
  assert.ok(paths.every((file) => fs.existsSync(file)));
  await phien.kiemTra(page);
});

test('HTTP 401 on the ZIP download itself reauthenticates without leaving a partial file', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pacs-zip-session-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  overrideConfig(t, { thuMucTai: directory });
  const page = fakePage();
  const manager = session(page);
  let requests = 0;
  mockFetch(t, async (url) => {
    if (url.includes('get-patient-image')) {
      return Response.json({ data: { studyList: [{
        studyID: 'S1', seriesList: [{ stackId: 'S1', dcmFileCount: 1 }],
      }] } });
    }
    if (++requests === 1) return new Response(null, { status: 401 });
    return new Response(Buffer.from('UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==', 'base64'));
  });
  const file = await manager.xuLyVoiDangNhapLai(page, 'TEST', () =>
    taiMotDongCoThoiHan(page, 'TEST', 'TEST', { ma: 'TOAN_CANH', ten: 'Toan canh' },
      { evaluate: async () => ({ sid: 'S1' }) }, { choTenFile: 'S1' })
  );
  assert.equal(page.logins, 1);
  assert.equal(requests, 2);
  assert.ok(fs.existsSync(file));
  assert.equal(fs.existsSync(`${file}.part`), false);
});

test('real Chromium recovers redirects, UI 401 and scheduled renewal on a local test site', async (t) => {
  const http = require('node:http');
  const server = http.createServer((req, res) => {
    if (req.url === '/unauthorized') {
      res.writeHead(401);
      res.end();
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url === '/login') {
      res.end(`<script>
        if(localStorage.getItem('token')) location.replace('/');
      </script>
      <input id="Email"><input id="Password" type="password">
      <button type="submit" onclick="localStorage.setItem('token', 'fresh-token'); location.replace('/')">Login</button>`);
    } else {
      res.end(`<script>
        if(!localStorage.getItem('token')) location.replace('/login');
      </script>
      <input placeholder="Ma benh nhan">`);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())));
  const originalPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  process.env.PLAYWRIGHT_BROWSERS_PATH = originalPath || path.join(__dirname, '..', '.browsers');
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    if (originalPath === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = originalPath;
  });
  const page = await browser.newPage();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const manager = new PhienDangNhap({
    ...CFG,
    urlLogin: `${origin}/login`,
    urlApi: origin,
    selOTimKiem: 'input[placeholder="Ma benh nhan"]',
  });
  await manager.dangNhap(page);
  await manager.kiemTra(page);

  await page.evaluate(() => localStorage.removeItem('token'));
  await page.goto(origin);
  await page.waitForURL(`${origin}/login`);
  assert.equal(await manager.xuLyVoiDangNhapLai(page, 'TEST', async () => 'same-patient'), 'same-patient');
  assert.equal(page.url(), `${origin}/`);

  const unauthorized = page.waitForResponse((res) => res.status() === 401);
  await page.evaluate(() => fetch('/unauthorized'));
  await unauthorized;
  await manager.xuLyVoiDangNhapLai(page, 'TEST', async () => 'OK');
  await manager.kiemTra(page);

  manager.lanDangNhapCuoi = Date.now() - CFG.dangNhapLaiSauMs - 1;
  await manager.xuLyVoiDangNhapLai(page, 'TEST', async () => 'OK');
  assert.equal(await page.evaluate(() => localStorage.getItem('token')), 'fresh-token');
});
