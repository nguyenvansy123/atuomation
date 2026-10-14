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
//       │                                 sau khi lọc theo CFG.namChupCanLay,
//       │                                 mã BN này không có ca Cone Beam
//       │                                 nào -> bỏ qua cả mã, sang mã khác)
//       │
//       └──► DANG_KIEM_TRA_CONE_BEAM     (mở Viewer TỪNG ca Cone Beam năm
//              │                          CFG.namChupCanLay, đọc độ dày lát
//              │                          cắt — TẢI TẤT CẢ ca đạt chuẩn
//              │                          <= CFG.doDayLatCatCanMm, không
//              │                          dừng lại ở ca đầu tiên)
//              │
//              ├──► BO_QUA_LAT_CAT_KHONG_DAT (không ca Cone Beam nào đạt
//              │                              độ dày lát cắt -> bỏ qua cả
//              │                              mã, KHÔNG tải Toàn cảnh)
//              │
//              └──► DANG_TAI_XUONG  (Có ít nhất 1 Cone Beam đạt & tải xong
//                     │              -> tải thêm Toàn cảnh (năm
//                     │              CFG.namChupCanLay) nếu có)
//                     │
//                     ├──► HOAN_TAT          (tải đủ, không lỗi)
//                     ├──► HOAN_TAT_MOT_PHAN (Cone Beam OK, Toàn cảnh lỗi/thiếu)
//                     └──► LOI                (Cone Beam lỗi thật, không phải
//                                              do sai độ dày lát cắt)
//
// CHẠY LẠI / RESUME: mã BN đã có trạng thái "chốt" ở cột Trạng thái
// (HOAN_TAT, HOAN_TAT_MOT_PHAN, BO_QUA_LAT_CAT_KHONG_DAT, KHONG_TIM_THAY,
// BO_QUA_KHONG_CO_CONE_BEAM — xem CFG.cacTrangThaiBoQuaKhongCanKiemTraLai)
// sẽ được BỎ QUA HOÀN TOÀN, không kiểm tra lại. CHỈ mã có trạng thái LOI
// (hoặc chưa từng chạy) mới được xử lý lại từ đầu.
//
// Cài đặt bằng CaiDat.cmd, nhập tài khoản trong config.json, rồi chạy
// Chay.cmd. Biến môi trường PACS_* được ưu tiên hơn config.json.
// =====================================================================

const { chromium } = require('playwright');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { docCauHinh } = require('./config');
const { PhienDangNhap, PhienHetHanError, LoiDangNhapError, kiemTraPhanHoiDangNhap } = require('./session');
const cauHinh = docCauHinh();

// ----------------------------- CẤU HÌNH ------------------------------
const CFG = {
  // --- Excel đầu vào/đầu ra ---
  // Có thể đổi file/thư mục qua biến môi trường mà không cần sửa code, vd:
  //   $env:PACS_EXCEL="danh_sach_2.xlsx"; node AutoDownload.js
  excelFile: cauHinh.excelFile,
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

  thuMucTai: cauHinh.thuMucTai,

  // --- Đăng nhập VRPACS-RIS (CLOUD PACS) ---
  urlLogin: 'http://113.161.41.190:8088/login',
  user: cauHinh.user,
  pass: cauHinh.pass,
  selEmail: '#Email',
  selPass: '#Password',
  selNutLogin: 'button[type="submit"]',
  dangNhapLaiSauMs: 6 * 60 * 60000, // đăng nhập chủ động giữa các mã, không cắt ngang phim đang tải
  soLanDangNhapLaiKhiHetPhien: 2,

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

  // --- Lọc theo năm chụp ---
  // Chỉ xét các dòng có "Thời gian chụp" thuộc năm này (áp dụng cho cả
  // Cone Beam lẫn Toàn cảnh). Dòng không đọc được ngày tháng hợp lệ cũng
  // bị loại (an toàn — không chắc đúng năm thì không lấy).
  namChupCanLay: 2026,

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
  // Viewer giờ CHỈ còn dùng để đọc độ dày lát cắt của Cone Beam (menu "☰"
  // hiện ra = dấu hiệu viewer đã sẵn sàng). Việc tải file KHÔNG còn bấm
  // nút "Download serie" trên giao diện nữa — xem phần "Tải trực tiếp qua
  // API" bên dưới.
  selNutMenuViewer: 'button.ant-dropdown-trigger:has(span[aria-label="menu"])',

  // --- Tải trực tiếp qua API của server (thay cho bấm "Download serie") ---
  // Nút "Download serie" trên giao diện bắt TRÌNH DUYỆT gom toàn bộ file
  // zip vào RAM rồi mới lưu: file Cone Beam 500MB-1GB rất dễ thất bại, lại
  // hay bị server trả lỗi 429 (quá tải) khi viewer còn đang tải ảnh song
  // song — lúc đó bảng "Dowload manager" vẫn hiện 100% nhưng KHÔNG có dung
  // lượng và không có file nào được tải. Vì vậy script gọi thẳng 2 API mà
  // chính nút đó dùng, và GHI TỪNG KHÚC dữ liệu xuống đĩa (không giữ trong
  // RAM), nên tải được file lớn tuỳ ý:
  //   1) GET  {urlApi}/vrpacs-file/get-patient-image?sID=<sid> -> lấy seID
  //   2) POST {urlApi}/vrpacs-scu/series-download  body {"seID": ...} -> zip
  // (token đăng nhập lấy từ localStorage của trang web đang mở).
  urlApi: 'http://113.161.41.190:740',
  timeoutKhongNhanDuLieuMs: 2 * 60000, // quá 2 phút không nhận thêm byte nào -> coi là treo, huỷ lần tải này
  soLanThuLaiKhiServerQuaTai: 5,       // server trả 429 (quá tải) -> đợi rồi thử lại tối đa ngần này lần
  doiKhiServerQuaTaiMs: 30000,         // đợi 30s trước mỗi lần thử lại khi gặp 429

  // --- Các khoảng chờ (ms) để dữ liệu kịp tải trước khi thao tác tiếp ---
  // Cone Beam là file nặng (200MB - ~1GB), viewer cần nhiều thời gian hơn để
  // tải dữ liệu ảnh trước khi đọc được độ dày lát cắt, nên có độ trễ riêng.
  doiSauKhiTimKiemMs: 30000,      // đợi sau khi tìm kiếm mã BN, trang hay bị lag nên cần chờ lâu để bảng tải xong hết
  doiSauKhiMoViewerMs: 5000,      // đợi sau khi tab Viewer mở xong
  doiThemChoConeBeamMs: 20000,    // đợi thêm riêng cho Cone Beam (file nặng, có ca lên tới 500-600 ảnh nên cần nhiều thời gian hơn)

  soLanThuLai: 3,             // số lần thử lại khi xử lý 1 mã BN bị lỗi
  headless: false,            // false = nhìn thấy trình duyệt chạy

  // Đồng hồ canh giờ TỔNG cho các bước TRƯỚC khi tải file (mở viewer +
  // kiểm tra lát cắt + gọi API), để dù bị treo ở bước nào cũng sẽ bị buộc
  // dừng (đóng tab + huỷ), không bao giờ treo vô thời hạn. Khi file ĐÃ bắt
  // đầu tải thì đồng hồ này KHÔNG cắt ngang nữa (file ~1GB mạng chậm có
  // thể lâu); trường hợp treo thật sự (không nhận thêm dữ liệu) do
  // timeoutKhongNhanDuLieuMs xử lý.
  timeoutTongTheMotLanTaiMs: 40 * 60000, // 40 phút
  soLanThuLaiKhiTaiThatBai: 2,           // thử lại tối đa 2 lần nếu 1 lần tải bị treo/thất bại

  // --- Xử lý khi trang Viewer bị lỗi không tải được (web bị lỗi/quá tải) ---
  // Nếu mở Viewer mà dữ liệu không lên được: đợi 3 phút rồi mở lại, lặp
  // tối đa số lần dưới đây; vẫn không được thì bỏ qua, chuyển sang phim/
  // mã BN khác.
  soLanThuLaiKhiTrangKhongLoad: 3,     // tổng số lần thử mở trang Viewer (1 lần đầu + 2 lần lại)
  doiTruocKhiThuLaiTrangMs: 3 * 60000, // đợi 3 phút trước khi mở lại
  timeoutChoTrangSanSangMs: 20000,     // chờ tối đa mỗi lần thử để trang Viewer sẵn sàng (menu "☰" hiện ra)

  // --- Các trạng thái đã "chốt" kết quả, KHÔNG cần kiểm tra lại khi chạy
  // lại script, dù không phải lúc nào cũng tải được file (vd không có
  // Cone Beam, không tìm thấy mã BN, hay độ dày lát cắt không đạt). Chỉ
  // có trạng thái LOI (lỗi thật) mới được thử lại ở lần chạy sau.
  cacTrangThaiBoQuaKhongCanKiemTraLai: [
    'HOAN_TAT',
    'HOAN_TAT_MOT_PHAN',
    'BO_QUA_LAT_CAT_KHONG_DAT',
    'KHONG_TIM_THAY',
    'BO_QUA_KHONG_CO_CONE_BEAM',
  ],
};
// =====================================================================

const nghi = (ms) => new Promise((r) => setTimeout(r, ms));
const phien = new PhienDangNhap(CFG);
const daTaiTrongLanChay = new Set();

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
  await phien.dangNhap(page);
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

// Trích thời gian chụp (vd "09/10/2026 16:06") từ nội dung 1 dòng kết
// quả. Trả về { nam, choTenFile } hoặc null nếu không đọc được. Dùng để
// lọc theo CFG.namChupCanLay và để ghi thời điểm chụp vào tên file tải về
// (đặc biệt hữu ích khi 1 mã BN có nhiều ca Cone Beam cùng tải).
function trichThoiGianChup(vanBanGoc) {
  const khop = String(vanBanGoc ?? '').match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
  if (!khop) return null;
  const [, ngay, thang, nam, gio, phut] = khop;
  return {
    nam: Number(nam),
    choTenFile: `${nam}-${thang}-${ngay} ${gio}h${phut}`,
  };
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
  await phien.kiemTra(page);
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
  phien.theoDoi(popup);
  try {
    await popup.goto(url);
    return popup;
  } catch (e) {
    await popup.close().catch(() => {});
    throw e;
  }
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
      await phien.kiemTra(popup);
      const nutMenu = popup.locator(CFG.selNutMenuViewer).first();
      await nutMenu.waitFor({ state: 'visible', timeout: CFG.timeoutChoTrangSanSangMs });
      return popup; // trang đã sẵn sàng
    } catch (e) {
      try {
        await phien.kiemTra(popup);
        await phien.kiemTra(page);
      } finally {
        await popup.close().catch(() => {});
      }
      if (e instanceof PhienHetHanError) throw e;
      loiCuoi = e;
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

// Lấy token đăng nhập hiện tại từ localStorage của trang web (luôn đọc
// mới mỗi lần vì trang web tự làm mới token định kỳ).
async function layToken(page) {
  await phien.kiemTra(page);
  const token = await page.evaluate(() => localStorage.getItem('token'));
  if (!token) throw new PhienHetHanError('Không lấy được token đăng nhập (phiên đăng nhập có thể đã hết hạn)');
  return token;
}

// Gọi API, tự đợi rồi thử lại khi server báo quá tải (HTTP 429). Lỗi HTTP
// khác thì ném lỗi kèm nội dung ngắn gọn để ghi vào Excel.
async function goiApi(url, options, ma, moTa) {
  for (let lan = 1; ; lan++) {
    const res = await fetch(url, options);
    await kiemTraPhanHoiDangNhap(res, moTa);
    if (res.status === 429 && lan < CFG.soLanThuLaiKhiServerQuaTai) {
      await res.body?.cancel().catch(() => {});
      await demNguoc(
        `[${ma}] Server báo quá tải (429) khi ${moTa}, đợi rồi thử lại (lần ${lan}/${CFG.soLanThuLaiKhiServerQuaTai})`,
        CFG.doiKhiServerQuaTaiMs
      );
      continue;
    }
    if (!res.ok) {
      const noiDung = (await res.text().catch(() => '')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      throw new Error(`${moTa}: HTTP ${res.status} ${noiDung.slice(0, 150)}`);
    }
    return res;
  }
}

// Tìm series ảnh cần tải của 1 ca chụp (sid lấy từ dòng kết quả). Bỏ qua
// các series không có ảnh (vd "PdfResult" — file kết quả PDF đính kèm),
// lấy series ảnh đầu tiên — giống series mà nút "Download serie" ở
// thumbnail đầu tiên của viewer vẫn tải.
async function layThongTinSeries(sid, token, ma, signal) {
  const res = await goiApi(
    `${CFG.urlApi}/vrpacs-file/get-patient-image?sID=${encodeURIComponent(sid)}`,
    { headers: { authorization: `Bearer ${token}` }, signal },
    ma,
    'lấy thông tin series'
  );
  const json = await res.json();
  const study = (json?.data?.studyList || []).find((s) => String(s.studyID) === String(sid));
  if (!study) throw new Error(`Không tìm thấy ca chụp sID=${sid} trong dữ liệu server trả về`);
  const seriesAnh = (study.seriesList || [])
    .filter((s) => Number(s.dcmFileCount) > 0 && s.stackId)
    .sort((a, b) => (a.seriesIndex ?? 0) - (b.seriesIndex ?? 0));
  if (seriesAnh.length === 0) throw new Error(`Ca chụp sID=${sid} không có series ảnh nào để tải`);
  return { seID: seriesAnh[0].stackId, soAnh: Number(seriesAnh[0].dcmFileCount) };
}

// Kiểm tra file zip đã tải về có đầy đủ không: phải bắt đầu bằng chữ ký
// "PK" và có bản ghi kết thúc zip (End Of Central Directory, chữ ký
// PK\x05\x06) ở cuối file. File bị cắt ngang giữa chừng sẽ thiếu phần này.
function kiemTraZipHopLe(duongDan) {
  const kichThuoc = fs.statSync(duongDan).size;
  if (kichThuoc < 22) return false;
  const fd = fs.openSync(duongDan, 'r');
  try {
    const dau = Buffer.alloc(2);
    fs.readSync(fd, dau, 0, 2, 0);
    if (dau.toString('latin1') !== 'PK') return false;
    const soByteCuoi = Math.min(kichThuoc, 65557); // EOCD 22 byte + comment tối đa 65535 byte
    const cuoi = Buffer.alloc(soByteCuoi);
    fs.readSync(fd, cuoi, 0, soByteCuoi, kichThuoc - soByteCuoi);
    return cuoi.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) !== -1;
  } finally {
    fs.closeSync(fd);
  }
}

// Tải file zip của 1 series thẳng từ server, ghi TỪNG KHÚC xuống đĩa (không
// giữ cả file trong RAM) nên tải được file lớn (500MB - ~1GB). Ghi vào file
// tạm ".part" trước, chỉ đổi tên thành file thật khi đã tải xong và kiểm
// tra zip hợp lệ — tránh để lại file hỏng/thiếu mà tưởng là đã xong.
async function taiZipTrucTiep(seID, token, duongDan, ma, nhanLoai, soAnh, controller) {
  const fileTam = `${duongDan}.part`;
  const res = await goiApi(
    `${CFG.urlApi}/vrpacs-scu/series-download`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ seID }),
      signal: controller.signal,
    },
    ma,
    `tải ${nhanLoai}`
  );

  const batDau = Date.now();
  let daNhan = 0;
  let lanCuoiCoDuLieu = Date.now();
  let lanInCuoi = 0;
  const inTienDo = () => {
    const mb = daNhan / 1048576;
    const giay = Math.max((Date.now() - batDau) / 1000, 0.001);
    process.stdout.write(
      `\r  ⬇ [${ma}] Đang tải ${nhanLoai} (${soAnh} ảnh): ${mb.toFixed(1)} MB - ${(mb / giay).toFixed(1)} MB/s - ${Math.floor(giay)}s        `
    );
  };
  const demByte = new Transform({
    transform(chunk, _enc, cb) {
      daNhan += chunk.length;
      lanCuoiCoDuLieu = Date.now();
      if (Date.now() - lanInCuoi > 1000) {
        lanInCuoi = Date.now();
        inTienDo();
      }
      cb(null, chunk);
    },
  });
  // Quá lâu không nhận thêm byte nào -> huỷ lần tải (treo thật sự).
  const idCanhTreo = setInterval(() => {
    if (Date.now() - lanCuoiCoDuLieu > CFG.timeoutKhongNhanDuLieuMs) {
      controller.abort(new Error(`Quá ${CFG.timeoutKhongNhanDuLieuMs / 1000}s không nhận thêm dữ liệu khi tải ${nhanLoai}`));
    }
  }, 5000);

  try {
    await pipeline(Readable.fromWeb(res.body), demByte, fs.createWriteStream(fileTam));
  } catch (e) {
    fs.rmSync(fileTam, { force: true });
    const lyDo = controller.signal.aborted && controller.signal.reason instanceof Error ? controller.signal.reason : e;
    throw new Error(`Tải ${nhanLoai} bị gián đoạn sau ${(daNhan / 1048576).toFixed(1)} MB: ${lyDo.message}`);
  } finally {
    clearInterval(idCanhTreo);
    inTienDo();
    process.stdout.write('\n');
  }

  if (daNhan === 0 || !kiemTraZipHopLe(fileTam)) {
    fs.rmSync(fileTam, { force: true });
    throw new Error(`File ${nhanLoai} tải về không hợp lệ/không đầy đủ (${(daNhan / 1048576).toFixed(1)} MB)`);
  }
  fs.rmSync(duongDan, { force: true });
  fs.renameSync(fileTam, duongDan);
  return daNhan;
}

// Mở viewer của Cone Beam để đọc độ dày lát cắt (không đạt thì ném
// BoQuaError), sau đó ĐÓNG viewer ngay (để viewer ngừng tải ảnh song song,
// tránh làm server quá tải lúc tải file và giải phóng RAM).
async function kiemTraLatCatConeBeam(page, ma, dongLocator, hopHuy) {
  const popup = await moViewerVaCho(page, ma, dongLocator);
  hopHuy.popup = popup;
  try {
    // Cone Beam là file nặng nên cần đợi thêm để viewer tải đủ dữ liệu
    // trước khi đọc được độ dày lát cắt.
    await demNguoc(`[${ma}] Đang chờ tải thêm dữ liệu Cone Beam (file nặng)`, CFG.doiThemChoConeBeamMs);
    await phien.kiemTra(popup);

    // Chỉ tải nếu độ dày lát cắt <= ngưỡng cho phép, dày hơn thì bỏ qua
    // (không phải lỗi — chỉ là phim này không đạt điều kiện).
    const doDayThucTe = await layDoDayLatCat(popup);
    const dungYeuCau = doDayThucTe <= CFG.doDayLatCatCanMm + CFG.saiSoDoDayLatCatMm;
    if (!dungYeuCau) {
      throw new BoQuaError(
        `Độ dày lát cắt ${doDayThucTe}mm (cần <= ${CFG.doDayLatCatCanMm}mm) -> bỏ qua, không tải`
      );
    }
    console.log(`  [${ma}] Độ dày lát cắt ${doDayThucTe}mm -> đạt, tiến hành tải.`);
  } catch (e) {
    await phien.kiemTra(popup);
    throw e;
  } finally {
    await popup.close().catch(() => {});
    hopHuy.popup = null;
  }
}

// Tải 1 dòng kết quả: (nếu là Cone Beam thì mở viewer kiểm tra độ dày lát
// cắt trước, không đạt thì bỏ qua) -> tải zip trực tiếp qua API -> lưu
// file với tên "mã BN - tên BN - loại phim - thời gian chụp.zip". Trả về
// đường dẫn file đã lưu.
// `thoiGianChup` (tuỳ chọn): object từ trichThoiGianChup(), dùng để ghi
// thời điểm chụp vào tên file (phân biệt nhiều ca Cone Beam cùng mã BN).
// `hopHuy` (tuỳ chọn): nơi gọi (đồng hồ canh giờ) dùng để ép đóng tab
// viewer / huỷ lần tải đang chạy khi quá hạn.
async function taiMotDong(page, ma, tenBN, loai, dongLocator, thoiGianChup, hopHuy = {}) {
  const controller = new AbortController();
  hopHuy.controller = controller;

  const phanThoiGian = thoiGianChup ? ` - ${thoiGianChup.choTenFile}` : '';
  const tenFile = lamSachTenFile(`${ma} - ${tenBN} - ${loai.ten}${phanThoiGian}.zip`);
  const duongDan = path.join(CFG.thuMucTai, ma, tenFile);
  if (daTaiTrongLanChay.has(duongDan) && fs.existsSync(duongDan) && kiemTraZipHopLe(duongDan)) {
    console.log(`  [${ma}] Giữ phim đã tải xong trong lần chạy này: ${duongDan}`);
    return duongDan;
  }

  if (loai.ma === 'CONE_BEAM') {
    await kiemTraLatCatConeBeam(page, ma, dongLocator, hopHuy);
  }
  if (controller.signal.aborted) throw new Error('Lần tải đã bị huỷ');

  const { sid } = await dongLocator.evaluate((el) => JSON.parse(el.getAttribute('data')));
  const token = await layToken(page);
  const { seID, soAnh } = await layThongTinSeries(sid, token, ma, controller.signal);

  fs.mkdirSync(path.dirname(duongDan), { recursive: true });

  hopHuy.dangTaiFile = true;
  const soByte = await taiZipTrucTiep(seID, token, duongDan, ma, loai.ten, soAnh, controller);
  daTaiTrongLanChay.add(duongDan);
  console.log(`  [${ma}] Đã lưu ${(soByte / 1048576).toFixed(1)} MB -> ${duongDan}`);
  return duongDan;
}

// Bọc taiMotDong() với 2 lớp an toàn:
//  1) Đồng hồ canh giờ TỔNG (timeoutTongTheMotLanTaiMs) cho các bước
//     TRƯỚC khi tải (mở viewer, kiểm tra lát cắt, gọi API): quá hạn thì
//     BUỘC đóng tab Viewer + huỷ và coi là lỗi, không để treo. Khi file
//     ĐÃ bắt đầu tải thì KHÔNG cắt ngang nữa (file 1GB mạng chậm có thể
//     lâu) — lúc đó chỉ bộ canh treo timeoutKhongNhanDuLieuMs (không nhận
//     thêm byte nào) mới được huỷ.
//  2) Thử lại tối đa soLanThuLaiKhiTaiThatBai lần cho các lỗi tải THẬT
//     (không áp dụng cho BoQuaError — vd sai độ dày lát cắt thì không
//     cần thử lại, dù thử bao nhiêu lần kết quả cũng vậy).
async function taiMotDongCoThoiHan(page, ma, tenBN, loai, dongLocator, thoiGianChup) {
  let loiCuoi = null;

  for (let lan = 1; lan <= CFG.soLanThuLaiKhiTaiThatBai; lan++) {
    const hopHuy = { popup: null, controller: null, dangTaiFile: false };
    let idHetGio;
    const hetGio = new Promise((_, reject) => {
      idHetGio = setTimeout(async () => {
        if (hopHuy.dangTaiFile) {
          console.log(
            `\n  [${ma}] Đã quá ${CFG.timeoutTongTheMotLanTaiMs / 60000} phút nhưng file "${loai.ten}" vẫn đang nhận dữ liệu -> để tải tiếp.`
          );
          return;
        }
        const loi = new Error(`Quá thời hạn ${CFG.timeoutTongTheMotLanTaiMs / 60000} phút khi tải "${loai.ten}"`);
        console.log(`\n  [${ma}] ${loi.message} -> buộc dừng.`);
        hopHuy.controller?.abort(loi);
        await hopHuy.popup?.close().catch(() => {});
        reject(loi);
      }, CFG.timeoutTongTheMotLanTaiMs);
    });

    try {
      return await Promise.race([
        taiMotDong(page, ma, tenBN, loai, dongLocator, thoiGianChup, hopHuy),
        hetGio,
      ]);
    } catch (e) {
      if (e instanceof BoQuaError) throw e; // không đạt điều kiện (vd lát cắt) -> không cần thử lại, báo luôn cho nơi gọi
      if (e instanceof PhienHetHanError) throw e;
      await phien.kiemTra(page);
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

// Kiểm tra 1 file đã tải trước đó còn tồn tại trên đĩa và không rỗng hay
// không — dùng để quyết định có thể tái sử dụng (bỏ qua tải lại) hay phải
// tải lại (vd: file bị xoá tay, hoặc thư mục downloads bị dọn dẹp).
function kiemTraFileDaTonTai(duongDan) {
  if (!duongDan || typeof duongDan !== 'string') return false;
  try {
    const stat = fs.statSync(duongDan);
    return stat.isFile() && stat.size > 0;
  } catch (e) {
    return false;
  }
}

// Giống kiemTraFileDaTonTai() nhưng áp dụng cho ô Excel có thể chứa
// NHIỀU đường dẫn file nối bằng " | " (vd nhiều ca Cone Beam đạt chuẩn).
// Chỉ coi là "đã có sẵn" khi TẤT CẢ các file trong danh sách đều còn tồn
// tại; nếu thiếu dù chỉ 1 file, sẽ tải lại toàn bộ loại phim đó.
function kiemTraTatCaFileDaTonTai(duongDanGop) {
  if (!duongDanGop || typeof duongDanGop !== 'string') return false;
  const danhSach = duongDanGop
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
  if (danhSach.length === 0) return false;
  return danhSach.every(kiemTraFileDaTonTai);
}

// ---- STATE MACHINE xử lý 1 mã BN ----
// `daCoSan` (tuỳ chọn): trạng thái + đường dẫn file đã ghi trong Excel từ
// lần chạy trước, dùng để BỎ QUA tải lại loại phim nào đã có sẵn file hợp
// lệ trên đĩa (đặc biệt quan trọng với Cone Beam — file rất nặng), chỉ
// tải lại loại phim nào trước đó bị lỗi/chưa có.
// Trả về { trangThai, chiTiet } trong đó chiTiet là mảng kết quả tải
// theo từng loại phim: [{ loai, ok, duongDan|loi }, ...]
async function xuLyMaBN(ma, page, daCoSan) {
  let trangThai = 'CHUA_XU_LY';
  const doiTrangThai = (tt) => {
    trangThai = tt;
    console.log(`  [${ma}] -> ${tt}`);
  };

  doiTrangThai('DANG_TIM_KIEM');
  await page.goto(CFG.urlTimKiem);
  await phien.kiemTra(page);
  await page.fill(CFG.selOTimKiem, ma);
  // QUAN TRỌNG: bộ lọc ngày mặc định chỉ là "Hôm nay" -> phải bấm "Tất cả"
  // thì mới tìm ra phim của những ngày trước đó.
  await page.getByRole('button', { name: CFG.textNutTatCaNgay, exact: true }).first().click();
  await page.keyboard.press('Enter');
  await demNguoc(`[${ma}] Đang chờ dữ liệu tìm kiếm tải xong`, CFG.doiSauKhiTimKiemMs);
  await phien.kiemTra(page);

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

  // Kiểm tra Excel: loại phim nào ở lần chạy trước đã ghi "OK" VÀ file đó
  // vẫn còn tồn tại trên đĩa (không rỗng) thì coi như đã xong, BỎ QUA
  // không tải lại (đặc biệt quan trọng với Cone Beam — file rất nặng).
  // Nếu file bị mất/xoá, vẫn sẽ tự động tải lại như bình thường.
  const coneBeamDaCoSan = daCoSan?.coneBeam?.trangThai === 'OK' && kiemTraTatCaFileDaTonTai(daCoSan.coneBeam.duongDan);
  const toanCanhDaCoSan = daCoSan?.toanCanh?.trangThai === 'OK' && kiemTraTatCaFileDaTonTai(daCoSan.toanCanh.duongDan);
  if (coneBeamDaCoSan) {
    console.log(`  [${ma}] Cone Beam đã có file hợp lệ từ lần chạy trước (${daCoSan.coneBeam.duongDan}) -> bỏ qua, không tải lại.`);
  }
  if (toanCanhDaCoSan) {
    console.log(`  [${ma}] Toàn cảnh đã có file hợp lệ từ lần chạy trước (${daCoSan.toanCanh.duongDan}) -> bỏ qua, không tải lại.`);
  }

  let tenBN = '';
  const thoiGianTheoDong = {};
  for (let i = 0; i < soDong; i++) {
    const dong = page.locator(CFG.selDongKetQua).nth(i);
    const vanBanGoc = await dong.innerText();
    const vanBan = chuanHoa(vanBanGoc);
    if (!tenBN) tenBN = await layTenBenhNhan(dong);

    // Lọc theo năm chụp (áp dụng cho cả Cone Beam lẫn Toàn cảnh): dòng
    // không thuộc năm cần lấy, hoặc không đọc được ngày tháng hợp lệ, thì
    // bỏ qua luôn, không xét tiếp cho cả 2 loại phim.
    const thoiGianChup = trichThoiGianChup(vanBanGoc);
    thoiGianTheoDong[i] = thoiGianChup;
    if (!thoiGianChup) {
      console.log(`  [${ma}] Dòng ${i + 1}: không đọc được thời gian chụp -> bỏ qua (an toàn).`);
      continue;
    }
    if (thoiGianChup.nam !== CFG.namChupCanLay) {
      continue;
    }

    if (!coneBeamDaCoSan && loaiConeBeam.tuKhoa.some((tk) => vanBan.includes(chuanHoa(tk)))) dongConeBeam.push(i);

    // Với Toàn cảnh: cùng 1 máy (XQ-P02/XQ-P03...) có thể được dùng cho
    // nhiều loại chỉ định khác nhau, nên bấm vào dòng để đọc đúng mục
    // "Chỉ định:" ở bảng "Thông tin bệnh nhân" chi tiết, xác nhận chắc
    // chắn trước khi nhận đây là phim Toàn cảnh. Bỏ qua bước này luôn nếu
    // Toàn cảnh đã có file từ trước, đỡ tốn thời gian bấm/xác nhận.
    if (!toanCanhDaCoSan && loaiToanCanh.tuKhoa.some((tk) => vanBan.includes(chuanHoa(tk)))) {
      const dungLaToanCanh = await xacNhanChiDinhToanCanh(page, dong, loaiToanCanh);
      if (dungLaToanCanh) {
        dongToanCanh.push(i);
      } else {
        console.log(`  [${ma}] Dòng ${i + 1}: Chỉ định không khớp "Toàn cảnh" khi xác nhận lại -> bỏ qua`);
      }
    }
  }

  const chiTiet = [];
  let coConeBeamDat = false;
  let coLoiThatConeBeam = false;

  if (coneBeamDaCoSan) {
    chiTiet.push({
      loai: 'CONE_BEAM',
      ten: loaiConeBeam.ten,
      ok: true,
      boQua: false,
      duongDan: daCoSan.coneBeam.duongDan,
    });
    coConeBeamDat = true;
  } else {
    // QUAN TRỌNG: mã BN không có Cone Beam nào (năm CFG.namChupCanLay) ->
    // bỏ qua NGAY mã này, không tải gì cả (kể cả Toàn cảnh), chuyển sang
    // mã BN tiếp theo.
    if (dongConeBeam.length === 0) {
      doiTrangThai('BO_QUA_KHONG_CO_CONE_BEAM');
      return { trangThai, chiTiet: [] };
    }

    // Kiểm tra TẤT CẢ các ca Cone Beam tìm được (không dừng ở ca đầu tiên
    // đạt chuẩn) — ca nào đạt độ dày lát cắt yêu cầu thì tải, ca nào không
    // đạt thì bỏ qua (taiMotDong tự kiểm tra và ném BoQuaError nếu không
    // đạt), tiếp tục xét hết toàn bộ danh sách.
    doiTrangThai('DANG_KIEM_TRA_CONE_BEAM');
    for (const i of dongConeBeam) {
      try {
        const dong = page.locator(CFG.selDongKetQua).nth(i);
        const duongDan = await taiMotDongCoThoiHan(page, ma, tenBN, loaiConeBeam, dong, thoiGianTheoDong[i]);
        chiTiet.push({ loai: 'CONE_BEAM', ten: loaiConeBeam.ten, ok: true, boQua: false, duongDan });
        console.log(`  [${ma}] Đã tải "${loaiConeBeam.ten}": ${duongDan}`);
        coConeBeamDat = true;
        // KHÔNG dừng lại — tiếp tục kiểm tra/tải các ca Cone Beam còn lại.
      } catch (e) {
        if (e instanceof PhienHetHanError) {
          e.chiTiet = [...chiTiet, {
            loai: 'CONE_BEAM', ten: loaiConeBeam.ten, ok: false, boQua: false,
            hetPhien: true, loi: e.message,
          }];
          throw e;
        }
        const boQua = e instanceof BoQuaError;
        if (!boQua) coLoiThatConeBeam = true;
        chiTiet.push({ loai: 'CONE_BEAM', ten: loaiConeBeam.ten, ok: false, boQua, loi: e.message });
        console.log(`  [${ma}] ${boQua ? 'Bỏ qua' : 'Lỗi khi tải'} "${loaiConeBeam.ten}": ${e.message}`);
      }
    }

    // Không có ca Cone Beam nào đạt (sai độ dày lát cắt hoặc lỗi thật)
    // -> bỏ qua NGAY mã này, không tải Toàn cảnh, chuyển sang mã BN tiếp theo.
    if (!coConeBeamDat) {
      doiTrangThai(coLoiThatConeBeam ? 'LOI' : 'BO_QUA_LAT_CAT_KHONG_DAT');
      return { trangThai, chiTiet };
    }
  }

  // Cone Beam đã đạt điều kiện (mới tải hoặc tái sử dụng file cũ) -> tải
  // thêm Toàn cảnh nếu có (không bắt buộc)
  doiTrangThai('DANG_TAI_XUONG');
  if (toanCanhDaCoSan) {
    chiTiet.push({
      loai: 'TOAN_CANH',
      ten: loaiToanCanh.ten,
      ok: true,
      boQua: false,
      duongDan: daCoSan.toanCanh.duongDan,
    });
  } else {
    for (const i of dongToanCanh) {
      try {
        const dong = page.locator(CFG.selDongKetQua).nth(i);
        const duongDan = await taiMotDongCoThoiHan(page, ma, tenBN, loaiToanCanh, dong, thoiGianTheoDong[i]);
        chiTiet.push({ loai: 'TOAN_CANH', ten: loaiToanCanh.ten, ok: true, boQua: false, duongDan });
        console.log(`  [${ma}] Đã tải "${loaiToanCanh.ten}": ${duongDan}`);
      } catch (e) {
        if (e instanceof PhienHetHanError) {
          e.chiTiet = [...chiTiet, {
            loai: 'TOAN_CANH', ten: loaiToanCanh.ten, ok: false, boQua: false,
            hetPhien: true, loi: e.message,
          }];
          throw e;
        }
        const boQua = e instanceof BoQuaError;
        chiTiet.push({ loai: 'TOAN_CANH', ten: loaiToanCanh.ten, ok: false, boQua, loi: e.message });
        console.log(`  [${ma}] ${boQua ? 'Bỏ qua' : 'Lỗi khi tải'} "${loaiToanCanh.ten}": ${e.message}`);
      }
    }
  }

  const toanCanhLoi = chiTiet.some((c) => c.loai === 'TOAN_CANH' && !c.ok);
  doiTrangThai(toanCanhLoi ? 'HOAN_TAT_MOT_PHAN' : 'HOAN_TAT');

  return { trangThai, chiTiet };
}

// Tổng hợp kết quả của 1 loại phim trong chiTiet thành:
//  - trangThai: 'OK' (có ít nhất 1 lần tải thành công, không bị gián đoạn
//    do hết phiên), 'BO_QUA' (mọi lần
//    thử đều bị bỏ qua, không có lỗi thật), 'LOI' (có lỗi thật, không ca
//    nào thành công), 'KHONG_CO' (không có entry nào — không tìm thấy).
//  - duongDanGop: TẤT CẢ đường dẫn file đã tải thành công, nối bằng " | "
//    (1 loại phim giờ có thể có NHIỀU file, vd nhiều ca Cone Beam đạt
//    chuẩn cùng lúc).
function ketQuaTongHopLoai(chiTiet, maLoai) {
  const khop = chiTiet.filter((c) => c.loai === maLoai);
  if (khop.length === 0) return { trangThai: 'KHONG_CO', duongDanGop: '' };

  const daTai = khop.filter((c) => c.ok);
  if (daTai.length > 0) {
    return {
      trangThai: khop.some((c) => c.hetPhien) ? 'LOI' : 'OK',
      duongDanGop: daTai.map((c) => c.duongDan).join(' | '),
    };
  }

  const coLoiThat = khop.some((c) => !c.boQua);
  return { trangThai: coLoiThat ? 'LOI' : 'BO_QUA', duongDanGop: '' };
}

// Ghi kết quả vào Excel. `daCoSan` là trạng thái/đường dẫn đã đọc được
// TRƯỚC khi xử lý (xem main loop) — nếu lần chạy này không đụng gì tới
// 1 loại phim (vd: tìm kiếm lỗi/không ra kết quả ngay từ bước đầu, nên
// chiTiet không có entry cho loại đó), GIỮ NGUYÊN giá trị cũ trong Excel
// thay vì ghi đè thành KHONG_CO/rỗng, tránh mất thông tin file đã tải
// thành công từ trước.
function ghiKetQuaVaoExcel(ws, r, { trangThai, chiTiet }, daCoSan) {
  const tc = ketQuaTongHopLoai(chiTiet, 'TOAN_CANH');
  const cb = ketQuaTongHopLoai(chiTiet, 'CONE_BEAM');
  const coDuLieuToanCanh = chiTiet.some((c) => c.loai === 'TOAN_CANH');
  const coDuLieuConeBeam = chiTiet.some((c) => c.loai === 'CONE_BEAM');

  ws.getCell(r, CFG.colTrangThai).value = trangThai;

  if (coDuLieuToanCanh || !daCoSan?.toanCanh?.trangThai) {
    ws.getCell(r, CFG.colToanCanhTrangThai).value = tc.trangThai;
    ws.getCell(r, CFG.colToanCanhFile).value = tc.duongDanGop;
  }
  if (coDuLieuConeBeam || !daCoSan?.coneBeam?.trangThai) {
    ws.getCell(r, CFG.colConeBeamTrangThai).value = cb.trangThai;
    ws.getCell(r, CFG.colConeBeamFile).value = cb.duongDanGop;
  }

  // Chỉ ghi lại Ghi chú nếu lần chạy này thực sự có xử lý gì đó (chiTiet
  // không rỗng); nếu không, giữ nguyên ghi chú cũ thay vì xoá trắng do
  // chưa kịp chạm tới bước nào (vd lỗi ngay từ bước tìm kiếm).
  if (chiTiet.length > 0) {
    ws.getCell(r, CFG.colGhiChu).value = chiTiet
      .filter((c) => !c.ok)
      .map((c) => `${c.ten}: ${c.loi}`)
      .join(' | ');
  }
  ws.getCell(r, CFG.colCapNhatLuc).value = new Date();
}

async function main() {
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
    // Bỏ qua mã đã có trạng thái "chốt" từ lần chạy trước (không phải lỗi
    // thật) — cho phép dừng/chạy lại mà không mất công kiểm tra lại các
    // mã này. CHỈ trạng thái LOI (hoặc chưa xử lý) mới được thử lại.
    const trangThaiDaGhi = ws.getCell(r, CFG.colTrangThai).value;
    if (CFG.cacTrangThaiBoQuaKhongCanKiemTraLai.includes(trangThaiDaGhi)) continue;

    // Đọc trạng thái + đường dẫn file đã ghi từ lần chạy trước (nếu có):
    // dùng để BỎ QUA tải lại loại phim nào đã tải thành công (file còn
    // tồn tại), CHỈ tải lại loại phim nào trước đó bị lỗi/chưa có.
    const daCoSan = {
      coneBeam: {
        trangThai: ws.getCell(r, CFG.colConeBeamTrangThai).value,
        duongDan: ws.getCell(r, CFG.colConeBeamFile).value,
      },
      toanCanh: {
        trangThai: ws.getCell(r, CFG.colToanCanhTrangThai).value,
        duongDan: ws.getCell(r, CFG.colToanCanhFile).value,
      },
    };

    console.log(`\n[${r - CFG.hangDauTien + 1}/${tongDong - CFG.hangDauTien + 1}] Mã BN ${ma}: CHUA_XU_LY`);

    let ketQua = { trangThai: 'LOI', chiTiet: [] };
    let loiDangNhap = null;
    for (let lan = 1; lan <= CFG.soLanThuLai; lan++) {
      try {
        ketQua = await phien.xuLyVoiDangNhapLai(page, ma, () => xuLyMaBN(ma, page, daCoSan));
        break;
      } catch (e) {
        console.log(`  [${ma}] Lỗi lần thử ${lan}/${CFG.soLanThuLai}: ${e.message}`);
        ketQua = { trangThai: 'LOI', chiTiet: [
          ...(e.chiTiet || []),
          { loai: 'CHUNG', ten: 'Chung', ok: false, loi: `Lần ${lan}: ${e.message}` },
        ] };
        if (e instanceof LoiDangNhapError) {
          loiDangNhap = e;
          break;
        }
        await nghi(2000);
      }
    }

    ghiKetQuaVaoExcel(ws, r, ketQua, daCoSan);
    await wb.xlsx.writeFile(CFG.excelFile); // lưu ngay sau mỗi mã (nhớ ĐÓNG file Excel khi chạy)
    console.log(`  => Kết quả mã ${ma}: ${ketQua.trangThai}`);
    if (loiDangNhap) {
      await browser.close();
      throw loiDangNhap;
    }
    await nghi(1000);
  }

  await browser.close();
  console.log('\nXong!');
}

function chay() {
  main().catch((loi) => {
    console.error(`\nAutoDownload dung vi loi: ${loi.message}`);
    process.exit(1);
  });
}

if (require.main === module) chay();

module.exports = { chay, CFG, phien, goiApi, taiMotDongCoThoiHan, xuLyMaBN, ketQuaTongHopLoai };
