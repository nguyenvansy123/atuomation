# AutoDownload độc lập (Windows)

## Cài trên máy khác

1. Giải nén bộ AutoDownload vào thư mục có quyền ghi, ví dụ `D:\AutoDownload`.
2. Cài **Node.js LTS, phiên bản 22 trở lên** từ https://nodejs.org/.
3. Bấm đúp **CaiDat.cmd**, cần Internet để tải thư viện và Chromium.
4. Mở `config.json` bằng Notepad, nhập `user` và `pass` của tài khoản PACS.
   Giữ dấu ngoặc kép; nếu mật khẩu có `"` hoặc `\`, viết lần lượt `\"` hoặc `\\`.
5. Mở `danh_sach.xlsx`, sheet **Sheet1**, nhập mã BN vào **cột A từ dòng 2**.
   Đặt mã BN ở dạng Text để giữ số 0 đầu. Các cột B–H dành cho kết quả.
6. **Đóng Excel**, bấm **Chay.cmd**. Phim được lưu vào `downloads\<mã BN>`.

Cài đặt lại không ghi đè cấu hình hoặc Excel đã có. Không cần chạy server,
main.js hay phần giao diện của dự án gốc. Giữ cửa sổ lệnh mở trong khi chạy.

## Cấu hình

```json
{
  "user": "",
  "pass": "",
  "excelFile": "danh_sach.xlsx",
  "thuMucTai": "downloads"
}
```

Đường dẫn tương đối tính từ thư mục AutoDownload; cũng có thể dùng đường dẫn
tuyệt đối. Biến môi trường `PACS_USER`, `PACS_PASS`, `PACS_EXCEL`,
`PACS_THU_MUC_TAI` được ưu tiên hơn cấu hình. Không chia sẻ `config.json`
vì có mật khẩu. Bộ phát hành không kèm tài khoản hay dữ liệu bệnh nhân.

## Luồng và chạy lại

Giữ nguyên luồng: chờ tìm kiếm 30 giây, chỉ lấy phim chụp năm **2026**,
kiểm tra và tải tất cả Cone Beam đạt điều kiện lát cắt, sau đó tải Toàn cảnh
khi đúng chỉ định. Zip được tải trực tiếp qua API, ghi từng khối xuống đĩa.
Khi bắt đầu yêu cầu tải zip, đồng hồ tổng không cắt ngang; bộ canh không nhận
dữ liệu 2 phút chỉ hoạt động sau khi server trả về phản hồi tải.

Kết quả được lưu vào Excel sau mỗi mã. Chạy lại bỏ qua các trạng thái đã chốt
(kể cả `HOAN_TAT_MOT_PHAN` và các trạng thái bỏ qua); xử lý lại mã `LOI` hoặc
chưa xử lý. Không đổi quy tắc này khi tách bộ độc lập.

## Tự đăng nhập lại khi chạy lâu

- Đăng nhập chủ động sau **6 giờ**, trước khi xử lý mã BN tiếp theo;
  không cắt ngang một phim đang tải để đăng nhập.
- Nếu bị chuyển về trang login, mất token hoặc API trả **HTTP 401**,
  tự đăng nhập bằng tài khoản trong cấu hình và tìm lại **cùng mã BN**.
  Các phim đã tải xong trong lần chạy hiện tại được giữ lại, không tải lại.
- Mỗi lần xử lý mã cho phép tối đa **2 lần phục hồi phiên**. Nếu đăng nhập
  thất bại hoặc phiên tiếp tục hết hạn, ghi lỗi mã hiện tại vào Excel và
  dừng với thông báo, thay vì chạy tiếp rồi đánh dấu lỗi hàng loạt.
  Giữ đường dẫn phim đã tải; loại phim bị gián đoạn mang trạng thái `LOI`
  để không bị coi nhầm là đã tải đủ khi chạy lại.
- HTTP 403 (không đủ quyền) và lỗi mạng/server không được coi là hết phiên.

Sau khi cài bằng CaiDat.cmd, chạy `npm test` trong thư mục này để kiểm tra
phục hồi phiên. Kiểm thử dùng dữ liệu giả và trang local, không dùng tài khoản
PACS thật và không thay đổi danh sách bệnh nhân.

## Chuyển danh sách cũ

Sao chép Excel cũ vào bộ mới **chỉ khi Excel và script đều đã dừng**. Nếu cần
giữ phim cũ, sao chép cả `downloads`. Đường dẫn phim trong Excel có thể là
đường dẫn của máy cũ: với mã cần thử lại, file không tồn tại ở đường dẫn đó
có thể được tải lại. Các mã có trạng thái đã chốt vẫn bị bỏ qua.

## Lỗi thường gặp

- Thiếu Node.js/thư viện/trình duyệt: chạy lại CaiDat.cmd, đọc lỗi trên màn hình.
- Thiếu tài khoản: điền config.json hoặc biến môi trường.
- Không đọc/ghi được Excel: đóng Excel, kiểm tra tên sheet và quyền ghi.
- Không truy cập được PACS: kiểm tra kết nối từ máy mới đến
  `http://113.161.41.190:8088/` và API tại cổng `740`.
- Có thể chạy thủ công bằng `npm start`. Sau cài đặt bằng CaiDat.cmd, đặt
  `PLAYWRIGHT_BROWSERS_PATH` tới thư mục `.browsers` của bộ này trước khi chạy
  thủ công; Chay.cmd đã làm việc đó.
