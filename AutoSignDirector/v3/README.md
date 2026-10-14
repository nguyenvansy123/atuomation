# AutoSignDirector độc lập (Windows)

Tự động ký **Trưởng khoa ký ủy quyền Giám đốc** và **Gửi ký hồ sơ** trên
`https://bvrhm.hosoyte.com`, theo danh sách *Chờ ký (Trưởng khoa)*.

## Cài trên máy khác

1. Chép cả thư mục **AutoSignDirector** (hoặc giải nén `AutoSignDirector-Windows.zip`)
   vào nơi có quyền ghi, ví dụ `D:\AutoSignDirector`.
2. Cài **Node.js LTS, phiên bản 22 trở lên** từ https://nodejs.org/.
3. Bấm đúp **CaiDat.cmd** (cần Internet để tải thư viện và Chromium, chỉ làm 1 lần).
4. Tạo file `config.json` (chép từ `config.example.json`) và điền tài khoản Trưởng khoa/ủy
   quyền Giám đốc, hoặc đặt biến môi trường `HOSOYTE_USER`/`HOSOYTE_PASS`.
5. Bấm đúp **DangNhap.cmd**: script **tự đăng nhập** bằng tài khoản trong `config.json`
   rồi lưu phiên vào `storageState.director.json`. File này chứa thông tin đăng nhập,
   **không chia sẻ**. Chạy lại khi phiên hết hạn.
6. Bấm **KiemTra.cmd** để chạy thử (không ký, không gửi), rồi **Chay.cmd** để ký và gửi thật.

## Cách chạy

| File | Tác dụng |
| --- | --- |
| `CaiDat.cmd` | Cài thư viện và Chromium vào thư mục này (1 lần). |
| `DangNhap.cmd` | Tự đăng nhập bằng `config.json` và lưu tài khoản; chạy lại khi hết phiên hoặc đổi tài khoản. |
| `KiemTra.cmd` | Chế độ kiểm tra, **không ký và không gửi**. |
| `Chay.cmd` | **Ký và gửi thật** toàn bộ hồ sơ trong danh sách đã lọc. |

Với `KiemTra.cmd` và `Chay.cmd`, trình duyệt mở *Danh sách chờ ký (Trưởng khoa)*.
Đặt bộ lọc, tải danh sách rồi nhấn Enter ở cửa sổ lệnh để bắt đầu. Không đổi bộ lọc,
không thao tác ký/gửi thủ công và không đóng trình duyệt khi đang chạy.

Có thể giới hạn số hồ sơ, nên thử 1 hồ sơ trước:

```
Chay.cmd --limit 1
```

Tương đương dòng lệnh: `node auto-sign-director.js [--execute] [--limit N]` và
`node auto-sign-director.js --login` (đặt `PLAYWRIGHT_BROWSERS_PATH` tới thư mục
`.browsers` trước khi chạy thủ công; các file `.cmd` đã làm việc đó). Tài khoản đăng
nhập tự động đọc từ `config.json` hoặc biến môi trường `HOSOYTE_USER`/`HOSOYTE_PASS`.

## Luồng xử lý mỗi hồ sơ

1. Mở hồ sơ, giữ **Phiếu bệnh án** đang mở và đọc API các phiếu.
2. Chỉ **Phiếu giao nhận** và **Thông tin hành chính** được phép chưa ký; phiếu khác
   chưa ký thì bỏ qua. Cần: Bác sĩ đã ký, Trưởng khoa chưa ký (Thông tin hành chính);
   người giao đã ký, người nhận chưa ký (Phiếu giao nhận). Không đạt thì bỏ qua.
3. Bấm **Ký số Trưởng khoa ký ủy quyền Giám đốc**, xác nhận, chờ nút **Gửi ký hồ sơ**.
   Nếu nút gửi đã có sẵn thì không ký lại.
4. Bấm gửi, xác nhận (hộp thoại "Bạn xác nhận gửi … bệnh án này?" → **Đồng ý**; cảnh báo
   thiếu chữ ký không bao giờ bị xác nhận), chờ 5 giây, kiểm tra API danh sách xem hồ sơ
   đã rời danh sách, đóng tab rồi sang hồ sơ kế tiếp.
5. Hết danh sách đã chốt, script bấm nút tìm kiếm (kính lúp xanh) để lấy dữ liệu mới
   theo đúng bộ lọc, xử lý hồ sơ mới; hồ sơ đã xử lý không bị xử lý lại. Dừng khi
   không còn hồ sơ mới.

Nếu kết quả gửi chưa rõ hoặc còn hộp thoại mở, script dừng để kiểm tra thủ công và
không tự gửi lại.

## Kết quả và dữ liệu

- `logs\auto-sign-director.jsonl`: kết quả từng hồ sơ; `logs\YYYY-MM-DD.log`: nhật ký;
  `logs\director-error-*.png`: ảnh chụp khi lỗi. Các file này chứa thông tin bệnh nhân,
  hãy bảo quản như dữ liệu y tế và không gửi ra ngoài.
- Bộ phát hành không kèm phiên đăng nhập, log hay dữ liệu bệnh nhân.

## Kiểm thử

Sau khi cài, chạy `npm test` trong thư mục này. Kiểm thử dùng giao diện/API giả lập,
không gọi máy chủ bệnh viện và không ký/gửi thật.

## Lỗi thường gặp

- Thiếu Node.js/thư viện/trình duyệt: chạy lại `CaiDat.cmd`, đọc lỗi trên màn hình.
- "Thieu tai khoan dang nhap": tạo `config.json` hoặc đặt `HOSOYTE_USER`/`HOSOYTE_PASS`.
- "Đăng nhập tự động không thành công": kiểm tra lại tài khoản/mật khẩu trong `config.json`.
- Không tìm thấy nút ký/gửi hoặc phiên hết hạn: chạy lại `DangNhap.cmd`.
- Không vào được website: kiểm tra mạng từ máy mới đến `https://bvrhm.hosoyte.com`.
