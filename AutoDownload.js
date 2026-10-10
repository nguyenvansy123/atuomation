// =====================================================================
// AutoDownload.js
// Tự động tải phim (ảnh X-quang / Cone Beam) theo danh sách mã bệnh
// nhân (BN) trong Excel, chạy trên hệ thống VRPACS-RIS (CLOUD PACS)
// tại http://113.161.41.190:8088
//
// LUỒNG XỬ LÝ (STATE MACHINE) cho MỖI mã BN — đây là phần cốt lõi để
// dễ theo dõi/ gỡ lỗi. Mỗi mã BN đi qua đúng 1 trong các nhánh sau,
// mọi bước chuyển đều được in ra console và ghi vào Excel:
//
//   CHUA_XU_LY
//       │
//       ▼
//   DANG_TIM_KIEM  (nhập mã BN vào ô tìm kiếm, đọc bảng kết quả)
//       │
//       ├──► KHONG_TIM_THAY              (không có dòng kết quả nào)
//       │
//       ├──► BO_QUA_KHONG_CO_CONE_BEAM   (CONE BEAM LÀ ĐIỀU KIỆN BẮT BUỘC:
//       │                                 mã BN này không có ca Cone Beam
//       │                                 nào -> bỏ qua cả mã, sang mã khác)
//       │
//       └──► DANG_KIEM_TRA_CONE_BEAM     (mở Viewer từng ca Cone Beam, đọc
//              │                          độ dày lát cắt — chỉ đạt nếu
//              │                          <= CFG.doDayLatCatCanMm)
//              │
//              ├──► BO_QUA_LAT_CAT_KHONG_DAT (không ca Cone Beam nào đạt
//              │                              độ dày lát cắt -> bỏ qua cả
//              │                              mã, KHÔNG tải Toàn cảnh)
//              │
//              └──► DANG_TAI_XUONG  (Cone Beam đã đạt & tải xong -> tải
//                     │              thêm Toàn cảnh nếu có)
//                     │
//                     ├──► HOAN_TAT          (tải đủ, không lỗi)
//                     ├──► HOAN_TAT_MOT_PHAN (Cone Beam OK, Toàn cảnh lỗi/thiếu)
//                     └──► LOI                (Cone Beam lỗi thật, không phải
//                                              do sai độ dày lát cắt)
//
// Yêu cầu cài đặt trước khi chạy:
//   npm install playwright exceljs
//   npx playwright install chromium
//
// Khuyến nghị bảo mật: không hard-code mật khẩu thật trong file này khi
// commit lên git — có thể đặt qua biến môi trường, ví dụ:
//   $env:PACS_USER="..."; $env:PACS_PASS="..."; node AutoDownload.js
// =====================================================================

const { chromium } = require('playwright');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

// ----------------------------- CẤU HÌNH ------------------------------
const CFG = {
  // --- Excel đầu vào/đầu ra ---
  excelFile: 'danh_sach.xlsx',
  sheetName: 'Sheet1',
  hangDauTien: 2,            // dòng 1 là tiêu đề
  colMa: 1,                  // cột A: mã bệnh nhân
  colTrangThai: 2,           // cột B: trạng thái tổng (state cuối cùng)
  colToanCanhTrangThai: 3,   // cột C: trạng thái phim "Toàn cảnh"
  colToanCanhFile: 4,        // cột D: đường dẫn file "Toàn cảnh"
  colConeBeamTrangThai: 5,   // cột E: trạng thái phim "Cone Beam"
  colConeBeamFile: 6,        // cột F: đường dẫn file "Cone Beam"
  colGhiChu: 7,              // cột G: ghi chú lỗi (nếu có)
  colCapNhatLuc: 8,          // cột H: thời gian cập nhật gần nhất

  thuMucTai: 'downloads',

  // --- Đăng nhập VRPACS-RIS (CLOUD PACS) ---
  urlLogin: 'http://113.161.41.190:8088/login',
  user: process.env.PACS_USER || '79415_khth',
  pass: process.env.PACS_PASS || 'Rhm@123',
  selEmail: '#Email',
  selPass: '#Password',
  selNutLogin: 'button[type="submit"]',

  // --- Trang danh sách / tìm kiếm ca chụp ---
  urlTimKiem: 'http://113.161.41.190:8088/',
  selOTimKiem: 'input[placeholder^="Mã bệnh nhân"]',
  selDongKetQua: 'tbody tr',
  // Mặc định bộ lọc ngày chỉ là "Hôm nay" -> PHẢI bấm nút này mới tìm ra
  // được các ca chụp của những ngày trước đó.
  textNutTatCaNgay: 'Tất cả',
  // Cột tên bệnh nhân là ô <td> duy nhất có style "font-weight: bold" —
  // dùng cách này để lấy tên thay vì dựa vào thứ tự cột (dễ lệch index).
  selTenBenhNhanTrongDong: 'td[style*="font-weight: bold"] span',
  // Nhãn "Chỉ định:" trong bảng "Thông tin bệnh nhân" chi tiết (hiện ra
  // khi bấm vào 1 dòng) — dùng để xác nhận lại đúng loại phim Toàn cảnh.
  textNhanChiDinh: 'Chỉ định:',
  doiSauKhiBamDongMs: 1000, // đợi bảng chi tiết load sau khi bấm vào 1 dòng

  // --- Lọc loại phim cần tải ---
  // Mỗi dòng kết quả được so khớp (không phân biệt hoa/thường, không dấu)
  // với danh sách từ khóa dưới đây. Khớp 1 trong các từ khóa là nhận.
  // Chỉnh sửa tại đây nếu cần thêm/bớt loại phim.
  // LƯU Ý: "xq-p02" đã bị bỏ khỏi từ khóa Cone Beam vì đó thực chất là mã
  // máy chụp Toàn cảnh (2D, không có "Slice thickness"), dùng chung từ khóa
  // sẽ khiến dòng Toàn cảnh bị nhận nhầm thành Cone Beam và báo lỗi.
  loaiPhimCanTai: [
    { ma: 'TOAN_CANH', ten: 'Toàn cảnh', tuKhoa: ['toàn cảnh'] },
    { ma: 'CONE_BEAM', ten: 'Cone Beam', tuKhoa: ['cone beam'] },
  ],

  // --- Mở trực tiếp tab Viewer bằng URL (ổn định hơn double-click) ---
  // Viewer dùng URL dạng /viewer/?params=<base64 của JSON {sid,svid,pCode,
  // serverSelected}>. "sid"/"svid" lấy từ thuộc tính data-* của từng dòng
  // kết quả; "serverSelected" là danh sách ID máy đang chọn ở thanh bên
  // trái (mặc định chọn hết). Nếu sau này không mở được viewer, hãy double
  // -click 1 dòng bất kỳ, copy mảng "serverSelected" trong URL mới mở ra
  // rồi cập nhật lại mảng dưới đây.
  serverSelectedMacDinh: [4, 22, 6, 90, 7, 8, 21, 20, 1, 14, 60, 83, 80],

  // --- Điều kiện lọc riêng cho Cone Beam ---
  // Chỉ tải Cone Beam nếu độ dày lát cắt (Slice thickness) hiển thị trong
  // Viewer <= giá trị này (mm). Dày hơn -> bỏ qua, không tải.
  selDoDayLatCat: '#SliceThickness',
  doDayLatCatCanMm: 0.15,
  saiSoDoDayLatCatMm: 0.01, // dung sai làm tròn số thực (vd: 0.1501mm vẫn tính là đạt)
  // Ca Cone Beam nặng (nhiều ảnh, vd 500-600 ảnh) có thể mất hơn 15s để
  // chữ "Slice thickness" hiện ra, nên để thời gian chờ rộng rãi.
  timeoutDoDayLatCatMs: 40000,

  // --- Trong tab Viewer (xem phim) ---
  selNutMenuViewer: 'button.ant-dropdown-trigger:has(span[aria-label="menu"])',
  textTaiXuong: 'Download serie',
  textNutQuanLyTai: 'Dowload manager', // đúng là có lỗi chính tả trên giao diện gốc
  textTieuDeBangQuanLyTai: 'Tải xuống',
  selMucTaiTrongBangQuanLy: 'div[class*="download_item__"]',
  selNutTaiVeTrongBangQuanLy: 'button:has(span[aria-label="cloud-download"])',

  // --- Các khoảng chờ (ms) để dữ liệu kịp tải trước khi thao tác tiếp ---
  // Cone Beam là file nặng (~200MB+), viewer cần nhiều thời gian hơn để
  // tải dữ liệu ảnh trước khi bấm nút, nên có thêm độ trễ riêng.
  doiSauKhiTimKiemMs: 30000,      // đợi sau khi tìm kiếm mã BN, trang hay bị lag nên cần chờ lâu để bảng tải xong hết
  doiSauKhiMoViewerMs: 5000,      // đợi sau khi tab Viewer mở xong
  doiSauKhiBamMenuMs: 1500,       // đợi sau khi bấm menu "☰"
  doiSauKhiBamTaiXuongMs: 2000,   // đợi sau khi bấm "Download serie"
  doiThemChoConeBeamMs: 20000,    // đợi thêm riêng cho Cone Beam (file nặng, có ca lên tới 500-600 ảnh nên cần nhiều thời gian hơn)
  doiSauKhi100PhanTramMs: 2000,   // đợi 1 chút sau khi thanh tiến trình đạt 100% rồi mới bấm nút tải về
  doiSauKhiTaiXongMs: 3000,       // đợi sau khi file đã lưu xong mới đóng tab / sang file khác

  soLanThuLai: 3,             // số lần thử lại khi xử lý 1 mã BN bị lỗi
  timeoutChoNenFileMs: 300000, // chờ tối đa 5 phút để server nén file (tới 100%) — Cone Beam nặng nên cần lâu hơn
  timeoutTaiVeMs: 30000,       // chờ tối đa khi bấm nút tải file về máy
  headless: false,            // false = nhìn thấy trình duyệt chạy

  // Đồng hồ canh giờ TỔNG cho 1 lần tải (mở viewer + kiểm tra + tải).
  // Có trường hợp dữ liệu trên server không đầy đủ: nén tới 100% nhưng
  // file không bao giờ tải xuống được, các cơ chế thử lại khác (vốn chỉ
  // xử lý "trang không load được") không cứu được tình huống này, khiến
  // script treo rất lâu ở 1 mã BN. Mốc này đảm bảo dù bị treo ở bước nào
  // cũng sẽ bị buộc dừng (đóng tab) sau tối đa ngần này phút, không bao
  // giờ treo vô thời hạn.
  timeoutTongTheMotLanTaiMs: 8 * 60000, // 8 phút
  soLanThuLaiKhiTaiThatBai: 2,          // thử lại tối đa 2 lần nếu 1 lần tải bị treo/thất bại kiểu trên

  // --- Xử lý khi trang Viewer bị lỗi không tải được (web bị lỗi/quá tải) ---
  // Nếu mở Viewer mà dữ liệu không lên được: đợi 3 phút rồi mở lại, lặp
  // tối đa số lần dưới đây; vẫn không được thì bỏ qua, chuyển sang phim/
  // mã BN khác.
  soLanThuLaiKhiTrangKhongLoad: 3,     // tổng số lần thử mở trang Viewer (1 lần đầu + 2 lần lại)
  doiTruocKhiThuLaiTrangMs: 3 * 60000, // đợi 3 phút trước khi mở lại
  timeoutChoTrangSanSangMs: 20000,     // chờ tối đa mỗi lần thử để trang Viewer sẵn sàng (menu "☰" hiện ra)
};
// =====================================================================

const nghi = (ms) => new Promise((r) => setTimeout(r, ms));

// Lỗi riêng để đánh dấu "chủ động bỏ qua" (ví dụ do không đúng độ dày lát
// cắt) — khác với lỗi thật sự, không cần thử lại.
class BoQuaError extends Error {}

// Đếm ngược trong lúc chờ, in ra console để biết script đang làm gì thay
// vì im lặng trông như bị treo (đặc biệt hữu ích với các bước chờ dài).
async function demNguoc(nhan, tongMs) {
  let conLai = tongMs;
  while (conLai > 0) {
    const giay = Math.ceil(conLai / 1000);
    process.stdout.write(`\r  ⏳ ${nhan}... còn ${giay}s        `);
    const cho = Math.min(1000, conLai);
    await nghi(cho);
    conLai -= cho;
  }
  process.stdout.write(`\r  ✓ ${nhan} - xong.                        \n`);
}

// Bỏ dấu tiếng Việt + chuyển về chữ thường, dùng để so khớp từ khóa
// không phụ thuộc hoa/thường hay dấu.
function chuanHoa(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase();
}

async function dangNhap(page) {
  await page.goto(CFG.urlLogin);
  await page.fill(CFG.selEmail, CFG.user);
  await page.fill(CFG.selPass, CFG.pass);
  await page.click(CFG.selNutLogin);
  // KHÔNG dùng waitForLoadState('networkidle') vì trang này có request nền
  // liên tục (SignalR, polling...) nên mạng không bao giờ "rảnh" đủ lâu,
  // sẽ luôn bị timeout. Thay vào đó chờ đúng ô tìm kiếm ở trang chính xuất
  // hiện — đây là dấu hiệu chắc chắn đăng nhập đã thành công.
  await page.waitForSelector(CFG.selOTimKiem, { timeout: 60000 });
}

// Lấy tên bệnh nhân của 1 dòng kết quả (dựa vào ô có style font-weight:
// bold, không dựa vào thứ tự cột vì dễ lệch khi bảng thay đổi).
async function layTenBenhNhan(dongLocator) {
  const ten = await dongLocator
    .locator(CFG.selTenBenhNhanTrongDong)
    .first()
    .innerText()
    .catch(() => '');
  return ten.trim() || 'KHONG_RO_TEN';
}

// Loại bỏ ký tự không hợp lệ trong tên file Windows: \ / : * ? " < > |
function lamSachTenFile(s) {
  return String(s).replace(/[\\/:*?"<>|]/g, '_').trim();
}

// Đọc độ dày lát cắt (vd: "Slice thickness: 0.3000 mm") hiển thị trong
// Viewer, trả về số mm (float). Chỉ áp dụng cho ảnh dạng khối (Cone Beam/
// CT) — nếu không thấy chữ này nghĩa là phim không có thông tin lát cắt.
async function layDoDayLatCat(popup) {
  const el = popup.locator(CFG.selDoDayLatCat).first();
  await el.waitFor({ state: 'visible', timeout: CFG.timeoutDoDayLatCatMs });
  const text = await el.innerText();
  const khop = text.match(/([\d.]+)\s*mm/i);
  if (!khop) throw new Error(`Không đọc được độ dày lát cắt từ: "${text}"`);
  return parseFloat(khop[1]);
}

// Bấm vào 1 dòng kết quả rồi đọc đúng mục "Chỉ định:" trong bảng "Thông
// tin bệnh nhân" chi tiết (đáng tin cậy hơn cột Chỉ định rút gọn trong
// bảng danh sách), xác nhận có đúng là phim Toàn cảnh không. Cùng 1 máy
// (XQ-P02/XQ-P03...) có thể được dùng cho nhiều loại chỉ định khác nhau
// nên không thể chỉ dựa vào mã máy.
async function xacNhanChiDinhToanCanh(page, dongLocator, loaiToanCanh) {
  await dongLocator.click({ force: true });
  await page.waitForTimeout(CFG.doiSauKhiBamDongMs);
  const doanChiDinh = page.locator('p', { hasText: CFG.textNhanChiDinh }).first();
  const coHienThi = await doanChiDinh.isVisible().catch(() => false);
  if (!coHienThi) return false; // không đọc được -> coi như chưa xác nhận được, bỏ qua cho an toàn
  const noiDung = chuanHoa(await doanChiDinh.innerText().catch(() => ''));
  return loaiToanCanh.tuKhoa.some((tk) => noiDung.includes(chuanHoa(tk)));
}

// Mở thẳng tab Viewer bằng URL dựng từ dữ liệu của dòng kết quả (ổn định
// hơn double-click, vốn hay bị lệch do bảng tự làm mới liên tục).
async function moTabViewer(page, ma, dongLocator) {
  const thongTinDong = await dongLocator.evaluate((el) => JSON.parse(el.getAttribute('data')));
  const url = await page.evaluate(
    ({ goc, thamSo }) => `${goc}viewer/?params=${btoa(JSON.stringify(thamSo))}`,
    {
      goc: CFG.urlTimKiem,
      thamSo: {
        sid: thongTinDong.sid,
        svid: thongTinDong.svID,
        pCode: ma,
        serverSelected: CFG.serverSelectedMacDinh,
      },
    }
  );
  const popup = await page.context().newPage();
  await popup.goto(url);
  return popup;
}

// Mở Viewer và chờ trang thật sự sẵn sàng (menu "☰" hiện ra). Trang web
// đôi khi bị lỗi không tải được dữ liệu — khi đó đóng tab, đợi 3 phút rồi
// mở lại, lặp tối đa CFG.soLanThuLaiKhiTrangKhongLoad lần; vẫn không được
// thì ném lỗi để nơi gọi bỏ qua phim này / chuyển sang mã BN khác.
async function moViewerVaCho(page, ma, dongLocator) {
  let loiCuoi = null;
  for (let lan = 1; lan <= CFG.soLanThuLaiKhiTrangKhongLoad; lan++) {
    const popup = await moTabViewer(page, ma, dongLocator);
    try {
      await popup.waitForLoadState('domcontentloaded');
      await demNguoc(`[${ma}] Đang chờ Viewer khởi tạo & tải dữ liệu ảnh`, CFG.doiSauKhiMoViewerMs);
      const nutMenu = popup.locator(CFG.selNutMenuViewer).first();
      await nutMenu.waitFor({ state: 'visible', timeout: CFG.timeoutChoTrangSanSangMs });
      return popup; // trang đã sẵn sàng
    } catch (e) {
      loiCuoi = e;
      await popup.close().catch(() => {});
      const conLan = lan < CFG.soLanThuLaiKhiTrangKhongLoad;
      console.log(`  [${ma}] Trang Viewer không tải được (lần ${lan}/${CFG.soLanThuLaiKhiTrangKhongLoad})`);
      if (conLan) {
        await demNguoc(`[${ma}] Web bị lỗi, đợi trước khi thử mở lại`, CFG.doiTruocKhiThuLaiTrangMs);
      } else {
        console.log(`  [${ma}] Đã thử đủ số lần, bỏ qua.`);
      }
    }
  }
  throw new Error(
    `Không mở được trang Viewer sau ${CFG.soLanThuLaiKhiTrangKhongLoad} lần thử: ${loiCuoi?.message}`
  );
}

// Mở bảng "Dowload manager" (nếu đang đóng) để theo dõi % tiến độ nén
// file phía server.
async function moBangQuanLyTaiNeuChuaMo(popup) {
  const daMo = await popup
    .getByText(CFG.textTieuDeBangQuanLyTai, { exact: true })
    .first()
    .isVisible()
    .catch(() => false);
  if (!daMo) {
    await popup.getByRole('button', { name: new RegExp(CFG.textNutQuanLyTai, 'i') }).first().click({ timeout: 15000 });
  }
}

// Chờ mục tải mới nhất trong bảng "Dowload manager" đạt 100%, sau đó bấm
// nút "cloud-download" để thật sự tải file về máy, trả về Download object.
async function choTaiXongVaLayFile(popup, ma) {
  const mucTai = popup.locator(CFG.selMucTaiTrongBangQuanLy).last();
  await mucTai.waitFor({ state: 'visible', timeout: 20000 });

  const batDau = Date.now();
  const hetHan = batDau + CFG.timeoutChoNenFileMs;
  let dat100 = false;
  while (Date.now() < hetHan) {
    const phanTram = (await mucTai.locator('.ant-progress-text').first().innerText().catch(() => '')) || '0%';
    const giayDaCho = Math.floor((Date.now() - batDau) / 1000);
    process.stdout.write(`\r  ⏳ [${ma}] Đang nén file phía server... ${phanTram} (đã chờ ${giayDaCho}s)        `);
    if (phanTram.trim() === '100%') {
      dat100 = true;
      break;
    }
    await nghi(2000);
  }
  process.stdout.write('\n');
  if (!dat100) throw new Error('Quá thời gian chờ server nén file (chưa đạt 100%)');

  // Đợi thêm 1 chút để nút tải về chắc chắn đã bật (tránh bấm hụt ngay
  // lúc thanh tiến trình vừa chạm 100%).
  await popup.waitForTimeout(CFG.doiSauKhi100PhanTramMs);

  const nutTaiVe = mucTai.locator(CFG.selNutTaiVeTrongBangQuanLy).first();
  const [download] = await Promise.all([
    popup.waitForEvent('download', { timeout: CFG.timeoutTaiVeMs }),
    nutTaiVe.click(),
  ]);
  return download;
}

// Mở viewer của 1 dòng kết quả (tự thử lại nếu web bị lỗi không tải
// được, xem moViewerVaCho) -> (nếu là Cone Beam thì kiểm tra độ dày lát
// cắt trước, không đúng thì bỏ qua) -> bấm menu "☰" -> "Download serie"
// -> chờ nén xong 100% -> bấm tải về -> lưu file với tên "mã BN - tên BN
// - loại phim.<đuôi file>". Trả về đường dẫn file đã lưu.
// `hopChuaPopup` (tuỳ chọn): nếu truyền vào, hàm sẽ gán tab Viewer vừa mở
// vào đó để nơi gọi (đồng hồ canh giờ) có thể ép đóng tab khi quá hạn.
async function taiMotDong(page, ma, tenBN, loai, dongLocator, hopChuaPopup) {
  const popup = await moViewerVaCho(page, ma, dongLocator);
  if (hopChuaPopup) hopChuaPopup.popup = popup;
  try {
    // Cone Beam là file nặng (~200MB+) nên cần đợi thêm để viewer tải đủ
    // dữ liệu trước khi thao tác, tránh bấm khi trang chưa sẵn sàng.
    if (loai.ma === 'CONE_BEAM') {
      await demNguoc(`[${ma}] Đang chờ tải thêm dữ liệu Cone Beam (file nặng)`, CFG.doiThemChoConeBeamMs);

      // Chỉ tải nếu độ dày lát cắt <= ngưỡng cho phép, dày hơn thì bỏ qua
      // (không phải lỗi — chỉ là phim này không đạt điều kiện).
      const doDayThucTe = await layDoDayLatCat(popup);
      const dungYeuCau = doDayThucTe <= CFG.doDayLatCatCanMm + CFG.saiSoDoDayLatCatMm;
      if (!dungYeuCau) {
        throw new BoQuaError(
          `Độ dày lát cắt ${doDayThucTe}mm (cần <= ${CFG.doDayLatCatCanMm}mm) -> bỏ qua, không tải`
        );
      }
    }

    // moViewerVaCho() đã xác nhận menu "☰" hiển thị nên bấm thẳng luôn.
    const nutMenu = popup.locator(CFG.selNutMenuViewer).first();
    await nutMenu.click();
    await popup.waitForTimeout(CFG.doiSauKhiBamMenuMs);

    const nutTaiXuong = popup.getByText(CFG.textTaiXuong, { exact: true });
    await nutTaiXuong.waitFor({ state: 'visible', timeout: 10000 });
    await nutTaiXuong.click({ force: true });
    await popup.waitForTimeout(CFG.doiSauKhiBamTaiXuongMs);

    await moBangQuanLyTaiNeuChuaMo(popup);
    const download = await choTaiXongVaLayFile(popup, ma);

    const duoiFile = path.extname(download.suggestedFilename()) || '.zip';
    const tenFile = lamSachTenFile(`${ma} - ${tenBN} - ${loai.ten}${duoiFile}`);
    const duongDan = path.join(CFG.thuMucTai, ma, tenFile);
    fs.mkdirSync(path.dirname(duongDan), { recursive: true });
    await download.saveAs(duongDan);
    // Đợi thêm 1 chút để chắc chắn file đã ghi xong hoàn toàn trước khi
    // đóng tab và chuyển sang mã/loại phim tiếp theo.
    await popup.waitForTimeout(CFG.doiSauKhiTaiXongMs);
    return duongDan;
  } finally {
    await popup.close().catch(() => {});
  }
}

// Bọc taiMotDong() với 2 lớp an toàn:
//  1) Đồng hồ canh giờ TỔNG (timeoutTongTheMotLanTaiMs): nếu quá hạn (vd
//     dữ liệu server không đầy đủ, nén tới 100% nhưng không bao giờ tải
//     xuống được) thì BUỘC đóng tab Viewer và coi là lỗi, không để treo.
//  2) Thử lại tối đa soLanThuLaiKhiTaiThatBai lần cho các lỗi tải THẬT
//     (không áp dụng cho BoQuaError — vd sai độ dày lát cắt thì không
//     cần thử lại, dù thử bao nhiêu lần kết quả cũng vậy).
async function taiMotDongCoThoiHan(page, ma, tenBN, loai, dongLocator) {
  let loiCuoi = null;

  for (let lan = 1; lan <= CFG.soLanThuLaiKhiTaiThatBai; lan++) {
    const hopChuaPopup = { popup: null };
    let idHetGio;
    const hetGio = new Promise((_, reject) => {
      idHetGio = setTimeout(async () => {
        console.log(
          `  [${ma}] Quá thời hạn ${CFG.timeoutTongTheMotLanTaiMs / 60000} phút khi tải "${loai.ten}" ` +
            `(có thể do dữ liệu trên server không đầy đủ) -> buộc đóng tab.`
        );
        await hopChuaPopup.popup?.close().catch(() => {});
        reject(new Error(`Quá thời hạn ${CFG.timeoutTongTheMotLanTaiMs / 60000} phút khi tải "${loai.ten}"`));
      }, CFG.timeoutTongTheMotLanTaiMs);
    });

    try {
      return await Promise.race([
        taiMotDong(page, ma, tenBN, loai, dongLocator, hopChuaPopup),
        hetGio,
      ]);
    } catch (e) {
      if (e instanceof BoQuaError) throw e; // không đạt điều kiện (vd lát cắt) -> không cần thử lại, báo luôn cho nơi gọi
      loiCuoi = e;
      const conLan = lan < CFG.soLanThuLaiKhiTaiThatBai;
      console.log(
        `  [${ma}] Tải "${loai.ten}" thất bại (lần ${lan}/${CFG.soLanThuLaiKhiTaiThatBai}): ${e.message}` +
          (conLan ? ' -> thử lại.' : ' -> bỏ cuộc.')
      );
    } finally {
      clearTimeout(idHetGio);
    }
  }

  throw new Error(`Không tải được "${loai.ten}" sau ${CFG.soLanThuLaiKhiTaiThatBai} lần thử: ${loiCuoi?.message}`);
}

// ---- STATE MACHINE xử lý 1 mã BN ----
// Trả về { trangThai, chiTiet } trong đó chiTiet là mảng kết quả tải
// theo từng loại phim: [{ loai, ok, duongDan|loi }, ...]
async function xuLyMaBN(ma, page) {
  let trangThai = 'CHUA_XU_LY';
  const doiTrangThai = (tt) => {
    trangThai = tt;
    console.log(`  [${ma}] -> ${tt}`);
  };

  doiTrangThai('DANG_TIM_KIEM');
  await page.goto(CFG.urlTimKiem);
  await page.fill(CFG.selOTimKiem, ma);
  // QUAN TRỌNG: bộ lọc ngày mặc định chỉ là "Hôm nay" -> phải bấm "Tất cả"
  // thì mới tìm ra phim của những ngày trước đó.
  await page.getByRole('button', { name: CFG.textNutTatCaNgay, exact: true }).first().click();
  await page.keyboard.press('Enter');
  await demNguoc(`[${ma}] Đang chờ dữ liệu tìm kiếm tải xong`, CFG.doiSauKhiTimKiemMs);

  const soDong = await page.locator(CFG.selDongKetQua).count();
  if (soDong === 0) {
    doiTrangThai('KHONG_TIM_THAY');
    return { trangThai, chiTiet: [] };
  }

  // Xác định riêng các dòng Cone Beam và Toàn cảnh + lấy tên bệnh nhân
  // (Cone Beam là ĐIỀU KIỆN BẮT BUỘC — xem bên dưới)
  const loaiConeBeam = CFG.loaiPhimCanTai.find((l) => l.ma === 'CONE_BEAM');
  const loaiToanCanh = CFG.loaiPhimCanTai.find((l) => l.ma === 'TOAN_CANH');
  const dongConeBeam = [];
  const dongToanCanh = [];
  let tenBN = '';
  for (let i = 0; i < soDong; i++) {
    const dong = page.locator(CFG.selDongKetQua).nth(i);
    const vanBan = chuanHoa(await dong.innerText());
    if (!tenBN) tenBN = await layTenBenhNhan(dong);
    if (loaiConeBeam.tuKhoa.some((tk) => vanBan.includes(chuanHoa(tk)))) dongConeBeam.push(i);

    // Với Toàn cảnh: cùng 1 máy (XQ-P02/XQ-P03...) có thể được dùng cho
    // nhiều loại chỉ định khác nhau, nên bấm vào dòng để đọc đúng mục
    // "Chỉ định:" ở bảng "Thông tin bệnh nhân" chi tiết, xác nhận chắc
    // chắn trước khi nhận đây là phim Toàn cảnh.
    if (loaiToanCanh.tuKhoa.some((tk) => vanBan.includes(chuanHoa(tk)))) {
      const dungLaToanCanh = await xacNhanChiDinhToanCanh(page, dong, loaiToanCanh);
      if (dungLaToanCanh) {
        dongToanCanh.push(i);
      } else {
        console.log(`  [${ma}] Dòng ${i + 1}: Chỉ định không khớp "Toàn cảnh" khi xác nhận lại -> bỏ qua`);
      }
    }
  }

  // QUAN TRỌNG: mã BN không có Cone Beam nào -> bỏ qua NGAY mã này, không
  // tải gì cả (kể cả Toàn cảnh), chuyển sang mã BN tiếp theo.
  if (dongConeBeam.length === 0) {
    doiTrangThai('BO_QUA_KHONG_CO_CONE_BEAM');
    return { trangThai, chiTiet: [] };
  }

  // Thử lần lượt từng dòng Cone Beam cho tới khi gặp 1 dòng đạt độ dày
  // lát cắt yêu cầu (taiMotDong tự kiểm tra và ném BoQuaError nếu không
  // đạt). Dòng đạt điều kiện đầu tiên sẽ được tải luôn trong bước này.
  doiTrangThai('DANG_KIEM_TRA_CONE_BEAM');
  const chiTiet = [];
  let coConeBeamDat = false;
  let coLoiThatConeBeam = false;
  for (const i of dongConeBeam) {
    try {
      const dong = page.locator(CFG.selDongKetQua).nth(i);
      const duongDan = await taiMotDongCoThoiHan(page, ma, tenBN, loaiConeBeam, dong);
      chiTiet.push({ loai: 'CONE_BEAM', ten: loaiConeBeam.ten, ok: true, boQua: false, duongDan });
      console.log(`  [${ma}] Đã tải "${loaiConeBeam.ten}": ${duongDan}`);
      coConeBeamDat = true;
      break;
    } catch (e) {
      const boQua = e instanceof BoQuaError;
      if (!boQua) coLoiThatConeBeam = true;
      chiTiet.push({ loai: 'CONE_BEAM', ten: loaiConeBeam.ten, ok: false, boQua, loi: e.message });
      console.log(`  [${ma}] ${boQua ? 'Bỏ qua' : 'Lỗi khi tải'} "${loaiConeBeam.ten}": ${e.message}`);
    }
  }

  // Không có dòng Cone Beam nào đạt (sai độ dày lát cắt hoặc lỗi thật)
  // -> bỏ qua NGAY mã này, không tải Toàn cảnh, chuyển sang mã BN tiếp theo.
  if (!coConeBeamDat) {
    doiTrangThai(coLoiThatConeBeam ? 'LOI' : 'BO_QUA_LAT_CAT_KHONG_DAT');
    return { trangThai, chiTiet };
  }

  // Cone Beam đã đạt điều kiện -> tải thêm Toàn cảnh nếu có (không bắt buộc)
  doiTrangThai('DANG_TAI_XUONG');
  for (const i of dongToanCanh) {
    try {
      const dong = page.locator(CFG.selDongKetQua).nth(i);
      const duongDan = await taiMotDongCoThoiHan(page, ma, tenBN, loaiToanCanh, dong);
      chiTiet.push({ loai: 'TOAN_CANH', ten: loaiToanCanh.ten, ok: true, boQua: false, duongDan });
      console.log(`  [${ma}] Đã tải "${loaiToanCanh.ten}": ${duongDan}`);
    } catch (e) {
      const boQua = e instanceof BoQuaError;
      chiTiet.push({ loai: 'TOAN_CANH', ten: loaiToanCanh.ten, ok: false, boQua, loi: e.message });
      console.log(`  [${ma}] ${boQua ? 'Bỏ qua' : 'Lỗi khi tải'} "${loaiToanCanh.ten}": ${e.message}`);
    }
  }

  const toanCanhLoi = chiTiet.some((c) => c.loai === 'TOAN_CANH' && !c.ok);
  doiTrangThai(toanCanhLoi ? 'HOAN_TAT_MOT_PHAN' : 'HOAN_TAT');

  return { trangThai, chiTiet };
}

// Lấy kết quả đại diện cho 1 loại phim trong chiTiet: ưu tiên lần tải
// thành công, nếu không có thì lấy lần thử gần nhất (vì Cone Beam có thể
// có nhiều lần thử trước khi đạt độ dày lát cắt).
function timKetQuaLoai(chiTiet, maLoai) {
  const khop = chiTiet.filter((c) => c.loai === maLoai);
  if (khop.length === 0) return undefined;
  return khop.find((c) => c.ok) || khop[khop.length - 1];
}

function trangThaiLoai(c) {
  if (!c) return 'KHONG_CO';
  if (c.ok) return 'OK';
  if (c.boQua) return 'BO_QUA';
  return 'LOI';
}

function ghiKetQuaVaoExcel(ws, r, { trangThai, chiTiet }) {
  const tc = timKetQuaLoai(chiTiet, 'TOAN_CANH');
  const cb = timKetQuaLoai(chiTiet, 'CONE_BEAM');

  ws.getCell(r, CFG.colTrangThai).value = trangThai;
  ws.getCell(r, CFG.colToanCanhTrangThai).value = trangThaiLoai(tc);
  ws.getCell(r, CFG.colToanCanhFile).value = tc && tc.ok ? tc.duongDan : '';
  ws.getCell(r, CFG.colConeBeamTrangThai).value = trangThaiLoai(cb);
  ws.getCell(r, CFG.colConeBeamFile).value = cb && cb.ok ? cb.duongDan : '';
  ws.getCell(r, CFG.colGhiChu).value = chiTiet
    .filter((c) => !c.ok)
    .map((c) => `${c.ten}: ${c.loi}`)
    .join(' | ');
  ws.getCell(r, CFG.colCapNhatLuc).value = new Date();
}

(async () => {
  fs.mkdirSync(CFG.thuMucTai, { recursive: true });

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(CFG.excelFile);
  const ws = wb.getWorksheet(CFG.sheetName);

  const browser = await chromium.launch({ headless: CFG.headless });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  await dangNhap(page);

  const tongDong = ws.rowCount;
  for (let r = CFG.hangDauTien; r <= tongDong; r++) {
    const ma = String(ws.getCell(r, CFG.colMa).value ?? '').trim();
    if (!ma) continue;
    // Bỏ qua mã đã hoàn tất (cho phép dừng/chạy lại không tải trùng)
    if (ws.getCell(r, CFG.colTrangThai).value === 'HOAN_TAT') continue;

    console.log(`\n[${r - CFG.hangDauTien + 1}/${tongDong - CFG.hangDauTien + 1}] Mã BN ${ma}: CHUA_XU_LY`);

    let ketQua = { trangThai: 'LOI', chiTiet: [] };
    for (let lan = 1; lan <= CFG.soLanThuLai; lan++) {
      try {
        ketQua = await xuLyMaBN(ma, page);
        break;
      } catch (e) {
        console.log(`  [${ma}] Lỗi lần thử ${lan}/${CFG.soLanThuLai}: ${e.message}`);
        ketQua = { trangThai: 'LOI', chiTiet: [{ loai: 'CHUNG', ten: 'Chung', ok: false, loi: `Lần ${lan}: ${e.message}` }] };
        await nghi(2000);
      }
    }

    ghiKetQuaVaoExcel(ws, r, ketQua);
    await wb.xlsx.writeFile(CFG.excelFile); // lưu ngay sau mỗi mã (nhớ ĐÓNG file Excel khi chạy)
    console.log(`  => Kết quả mã ${ma}: ${ketQua.trangThai}`);
    await nghi(1000);
  }

  await browser.close();
  console.log('\nXong!');
})();
