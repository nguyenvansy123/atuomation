/**
 * capture-discharge-paper.js
 * -----------------------------------------------------------
 * Truy cập trang "Giấy ra viện" và lưu lại TOÀN BỘ giao diện
 * (HTML + CSS + ảnh) thành 1 file HTML độc lập, mở offline được.
 *
 * File HTML xuất ra kèm sẵn 1 thanh công cụ nhỏ để:
 *   - Bật/tắt chế độ chỉnh sửa (sửa trực tiếp thông tin trên giấy)
 *   - Tải xuống bản HTML đã chỉnh
 *   - In / xuất PDF
 *
 * Yêu cầu: đã đăng nhập và có storageState.json (chạy node login.js trước).
 *
 * Chạy:
 *   node capture-discharge-paper.js
 *   node capture-discharge-paper.js "https://bvrhm.hosoyte.com/BenhAn/HS603_benh_an/BA15_06/?idBa=XXXX"
 * -----------------------------------------------------------
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const STORAGE_STATE_PATH = './storageState.json';

// URL mặc định (có thể truyền URL khác qua tham số dòng lệnh)
const DEFAULT_URL =
  'https://bvrhm.hosoyte.com/BenhAn/HS603_benh_an/BA15_06/?idBa=8c4d1ea4-4ed1-49d8-95c9-e71faff9a07d';

const TARGET_URL = process.argv[2] || DEFAULT_URL;
const OUTPUT_DIR = path.join(__dirname, 'captured');
const OUTPUT_PATH = path.join(OUTPUT_DIR, 'giay-ra-vien.html');

const HEADLESS = false; // false để nhìn thấy trình duyệt, true để chạy ẩn
const NAV_TIMEOUT_MS = 60_000;

// Thời gian chờ để BẠN TỰ MỞC giấy ra viện trong trình duyệt trước khi lấy giao diện.
// Hết thời gian này (hoặc bạn nhấn Enter sớm) thì script mới chụp giao diện.
const MANUAL_WAIT_MS = 20_000;

/**
 * Thanh công cụ chỉnh sửa được nhúng vào file HTML xuất ra.
 * Không phụ thuộc mạng, chạy hoàn toàn offline trong trình duyệt.
 */
const EDITOR_TOOLBAR = `
<div id="__editor_toolbar__" style="position:fixed;top:10px;right:10px;z-index:2147483647;
  background:#1f2937;color:#fff;border-radius:8px;padding:8px 10px;font-family:Segoe UI,Arial,sans-serif;
  font-size:13px;box-shadow:0 4px 14px rgba(0,0,0,.3);display:flex;gap:8px;align-items:center">
  <span style="opacity:.8">Giấy ra viện:</span>
  <button type="button" data-act="edit" style="cursor:pointer;border:0;border-radius:6px;padding:6px 10px;background:#2563eb;color:#fff">Bật chỉnh sửa</button>
  <button type="button" data-act="save" style="cursor:pointer;border:0;border-radius:6px;padding:6px 10px;background:#16a34a;color:#fff">Tải HTML</button>
  <button type="button" data-act="print" style="cursor:pointer;border:0;border-radius:6px;padding:6px 10px;background:#6b7280;color:#fff">In / PDF</button>
</div>
<style>@media print{#__editor_toolbar__{display:none !important}}</style>
<script>
(function () {
  var bar = document.getElementById('__editor_toolbar__');
  var editing = false;
  bar.addEventListener('click', function (e) {
    var btn = e.target.closest('button');
    if (!btn) return;
    var act = btn.getAttribute('data-act');
    if (act === 'edit') {
      editing = !editing;
      document.body.contentEditable = editing ? 'true' : 'false';
      btn.textContent = editing ? 'Tắt chỉnh sửa' : 'Bật chỉnh sửa';
      btn.style.background = editing ? '#dc2626' : '#2563eb';
    } else if (act === 'save') {
      var wasEditing = document.body.contentEditable === 'true';
      document.body.contentEditable = 'false';
      var clone = document.documentElement.cloneNode(true);
      var t = clone.querySelector('#__editor_toolbar__');
      if (t) t.remove();
      var html = '<!DOCTYPE html>\\n' + clone.outerHTML;
      document.body.contentEditable = wasEditing ? 'true' : 'false';
      var blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'giay-ra-vien-da-chinh.html';
      a.click();
      URL.revokeObjectURL(a.href);
    } else if (act === 'print') {
      window.print();
    }
  });
})();
</script>
`;

// Chờ tới khi người dùng nhấn Enter, hoặc hết thời gian ms (cái nào đến trước).
function waitForEnterOrTimeout(ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.stdin.removeListener('data', onData);
      process.stdin.pause();
      resolve();
    };
    const onData = () => finish();
    const timer = setTimeout(finish, ms);
    process.stdin.resume();
    process.stdin.once('data', onData);
  });
}

async function isLoginScreen(page) {
  // App Angular hiển thị form đăng nhập khi session hết hạn.
  return page.evaluate(() => {
    if (document.querySelector('.not-authenticated')) return true;
    const bodyText = document.body ? document.body.innerText : '';
    return /vui lòng cung cấp tài khoản|Đăng nhập/i.test(bodyText) &&
      !!document.querySelector('input[name="password"], input[type="password"]');
  });
}

async function inlineAssets(page) {
  // Nội tuyến CSS + đưa link ảnh/tài nguyên về đường dẫn tuyệt đối.
  // Xử lý cả nội dung bên trong các iframe (trang in giấy ra viện thường
  // được render trong iframe) để bản chụp có đầy đủ nội dung như trên màn hình.
  return page.evaluate(async () => {
    async function inlineStylesheets(doc) {
      const links = Array.from(
        doc.querySelectorAll('link[rel="stylesheet"][href]')
      );
      for (const link of links) {
        try {
          const href = link.href;
          const res = await fetch(href);
          let css = await res.text();
          css = css.replace(
            /url\(\s*(['"]?)([^'")]+)\1\s*\)/g,
            (match, quote, url) => {
              if (/^(data:|https?:|#)/i.test(url)) return match;
              try {
                return `url("${new URL(url, href).href}")`;
              } catch {
                return match;
              }
            }
          );
          const style = doc.createElement('style');
          style.setAttribute('data-inlined-from', href);
          style.textContent = css;
          link.replaceWith(style);
        } catch (err) {
          // Không tải được thì giữ nguyên thẻ link
        }
      }

      // Đưa ảnh về URL tuyệt đối để mở offline vẫn thấy
      doc.querySelectorAll('img[src]').forEach((img) => {
        try {
          img.src = img.src;
        } catch {}
      });

      // Bảo đảm có thẻ <base> để tài nguyên còn lại resolve đúng
      if (doc.head && !doc.querySelector('base')) {
        const base = doc.createElement('base');
        base.href = doc.baseURI;
        doc.head.prepend(base);
      }
    }

    // 1) Xử lý document chính
    await inlineStylesheets(document);

    // 2) Xử lý từng iframe cùng nguồn, nhúng nội dung vào srcdoc
    const iframes = Array.from(document.querySelectorAll('iframe'));
    for (const frame of iframes) {
      let innerDoc = null;
      try {
        innerDoc = frame.contentDocument;
      } catch {
        innerDoc = null; // iframe khác nguồn, không truy cập được
      }
      if (!innerDoc || !innerDoc.documentElement) continue;
      try {
        await inlineStylesheets(innerDoc);
        const innerHtml =
          '<!DOCTYPE html>\n' + innerDoc.documentElement.outerHTML;
        frame.setAttribute('srcdoc', innerHtml);
        frame.removeAttribute('src'); // tránh tải lại từ mạng khi mở offline
      } catch (err) {
        // Bỏ qua iframe không xử lý được
      }
    }

    return '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
  });
}

(async () => {
  if (!fs.existsSync(STORAGE_STATE_PATH)) {
    console.error(
      `Không tìm thấy ${STORAGE_STATE_PATH}. Hãy chạy "node login.js" để đăng nhập trước.`
    );
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    storageState: STORAGE_STATE_PATH,
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT_MS);

  console.log(`Đang mở: ${TARGET_URL}`);
  await page.goto(TARGET_URL, { waitUntil: 'load' });

  // Chờ trang render xong (báo cáo thường tải dữ liệu bằng ajax)
  try {
    await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT_MS });
  } catch {
    // Bỏ qua nếu mạng không bao giờ "idle"
  }
  await page.waitForTimeout(1500);

  // Nếu session hết hạn, trang Angular sẽ hiển thị form đăng nhập.
  if (await isLoginScreen(page)) {
    if (HEADLESS) {
      console.error(
        '\nSession đã hết hạn (trang hiển thị màn hình đăng nhập).\n' +
          'Hãy chạy "node login.js" để đăng nhập lại rồi thử lại.'
      );
      await browser.close();
      process.exit(1);
    }
    console.log(
      '\n>>> Session đã hết hạn. Hãy ĐĂNG NHẬP trong cửa sổ trình duyệt vừa mở.'
    );
    console.log('>>> Đăng nhập xong, quay lại đây và nhấn Enter để tiếp tục...');
    await new Promise((resolve) => process.stdin.once('data', () => resolve()));

    // Lưu lại session mới để lần sau khỏi đăng nhập
    await context.storageState({ path: STORAGE_STATE_PATH });
    console.log(`Đã cập nhật session vào ${STORAGE_STATE_PATH}`);

    console.log('Đang mở lại trang giấy ra viện...');
    await page.goto(TARGET_URL, { waitUntil: 'load' });
    try {
      await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT_MS });
    } catch {}
    await page.waitForTimeout(1500);
  }

  // Để BẠN tự mở / điều chỉnh giấy ra viện cho đúng trước khi chụp giao diện.
  if (!HEADLESS) {
    const seconds = Math.round(MANUAL_WAIT_MS / 1000);
    console.log(
      `\n>>> Hãy MỞ / điều chỉnh GIẤY RA VIỆN trong trình duyệt cho đúng.`
    );
    console.log(
      `>>> Sẽ tự động lấy giao diện sau ${seconds}s, hoặc nhấn Enter để lấy ngay...`
    );
    await waitForEnterOrTimeout(MANUAL_WAIT_MS);
  } else {
    await page.waitForTimeout(MANUAL_WAIT_MS);
  }

  // Chờ thêm một nhịp cho phần vừa mở render xong
  try {
    await page.waitForLoadState('networkidle', { timeout: 10_000 });
  } catch {}
  await page.waitForTimeout(500);

  // Giấy ra viện thường mở ở TAB/CỬA SỔ MỚI khi bấm xem/in.
  // Chọn tab được mở gần nhất (không phải about:blank) để chụp đúng nội dung.
  const pages = context.pages().filter((p) => {
    const u = p.url();
    return u && u !== 'about:blank';
  });
  const capturePage = pages.length ? pages[pages.length - 1] : page;
  try {
    await capturePage.bringToFront();
  } catch {}
  console.log(`\nSố tab đang mở: ${context.pages().length}`);
  context.pages().forEach((p, i) => console.log(`  tab[${i}] ${p.url()}`));
  console.log(`Sẽ chụp tab: ${capturePage.url()}`);

  // Chẩn đoán: liệt kê các frame để biết nội dung giấy nằm ở đâu
  const frames = capturePage.frames();
  console.log(`Số frame trên tab được chụp: ${frames.length}`);
  frames.forEach((f, i) => {
    console.log(`  [${i}] ${f.url()}`);
  });

  console.log('Đang nội tuyến CSS và tài nguyên...');
  let html = await inlineAssets(capturePage);

  // Nhúng thanh công cụ chỉnh sửa vào trước </body>
  if (html.includes('</body>')) {
    html = html.replace('</body>', `${EDITOR_TOOLBAR}\n</body>`);
  } else {
    html += EDITOR_TOOLBAR;
  }

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  fs.writeFileSync(OUTPUT_PATH, html, 'utf8');

  console.log(`\nĐã lưu giao diện giấy ra viện vào:\n  ${OUTPUT_PATH}`);
  console.log(
    'Mở file đó bằng trình duyệt, bấm "Bật chỉnh sửa" để sửa thông tin, rồi "Tải HTML" để lưu bản mới.'
  );

  await browser.close();
  process.exit(0);
})().catch((err) => {
  console.error('Lỗi:', err);
  process.exit(1);
});
