# Browser Automation - Khung sườn (scaffold)

## Auto ký Trưởng khoa / ủy quyền Giám đốc

Script độc lập [auto-sign-director.js](./auto-sign-director.js), không thay đổi
[main.js](./main.js) hay bản extension [demo/content.js](./demo/content.js).
Dùng tài khoản riêng, không dùng hay ghi đè phiên đăng nhập của script cũ.
Đăng nhập tài khoản Trưởng khoa/ủy quyền Giám đốc:

```powershell
node auto-sign-director.js --login
```

Lệnh này mở trình duyệt với phiên trống. Đăng nhập bằng tài khoản cần ký,
rồi nhấn Enter tại terminal để lưu riêng vào `storageState.director.json`.
Chỉ lưu khi có thông tin phiên đăng nhập hợp lệ; không thực hiện ký/gửi.
File phiên riêng được loại khỏi Git vì chứa thông tin xác thực.
Khi cần đổi tài khoản hoặc phiên hết hạn, chạy lại lệnh trên. Phiên
`storageState.json` của script cũ được giữ nguyên. Không kết hợp `--login`
với `--execute` hoặc `--limit`.

Chạy kiểm tra trước (không bấm ký, không gửi):

```powershell
node auto-sign-director.js --limit 5
```

Script mở trực tiếp [Danh sách chờ ký (Trưởng khoa)](https://bvrhm.hosoyte.com/v2/#/HSBA/DsBenhAnChoKy?TrangThai=ChoKyTruongKhoa).
Chỉ cho phép chạy tại trang có `TrangThai=ChoKyTruongKhoa`, không chạy trên
danh sách `ChoDuyet`. Đặt bộ lọc như mong muốn và tải danh sách, rồi nhấn Enter
tại terminal. Không đổi bộ lọc
hoặc thao tác ký/gửi thủ công trong lúc script chạy.

Chạy ký thật, nên thử một hồ sơ trước:

```powershell
node auto-sign-director.js --execute --limit 1
```

Bỏ `--limit` để xử lý toàn bộ danh sách đã lọc. Script chốt ID trên tất cả
trang trước khi ký, sau đó kiểm tra từng hồ sơ còn trong danh sách bằng API (không lật
trang trên giao diện) để tránh bỏ sót khi gửi làm thay đổi phân trang.

Quy tắc:

- Mở hồ sơ, đưa tab lên màn hình và tự bấm mục **Phiếu bệnh án (chưa ký)**
  trên thanh bên (khác với **Phiếu giao nhận hồ sơ bệnh án**). Chờ mục này
  được chọn và nhận phản hồi API `/api/{Domain}/hsdikembenhan/hsDiKem/{recordId}`
  do thao tác mở phiếu phát sinh; không kiểm tra ngay khi chưa mở Phiếu bệnh án.
  Kiểm tra **tất cả phiếu**, chỉ **Phiếu giao nhận hồ sơ bệnh án** và
  **Thông tin hành chính** được phép có `IsDaKySo === false`. Nếu bất kỳ
  phiếu nào khác có giá trị `false`, bỏ qua hồ sơ trước khi mở phiếu giao
  nhận, ghi rõ tên phiếu chưa ký. Không dùng thông báo của nút **Kiểm tra**
  làm điều kiện đủ thay cho API.
- Các phiếu có `IsDaKySo === true` được ghi nhận đã ký số. Giá trị `null`
  không thuộc danh sách `false` theo quy tắc này và được ghi riêng, không
  tự coi là đã ký. Kiểu dữ liệu lạ hoặc thiếu trường vẫn gây lỗi rõ ràng.
- Trước khi ký ủy quyền, kiểm tra phiếu giao nhận qua `HSDiKemViTriKy` của API:
  đúng một vị trí `MaViTri="NguoiGiaoHoSo"` có `IsDaKy=true` và đúng một
  vị trí `MaViTri="NguoiNhanHoSo"` có `IsDaKy=false` mới đủ điều kiện.
  Người giao chưa ký hoặc người nhận đã ký thì bỏ qua, không ký/gửi.
  Chữ ký người giao là điều kiện có sẵn, không phải chữ ký ủy quyền Giám đốc.
- Chỉ khi đạt quy tắc API và điều kiện giao/nhận mới mở phiếu giao nhận.
  Nếu **Gửi ký hồ sơ** đã hiển thị và được phép bấm thì không ký ủy quyền
  lại. Nếu chưa có nút gửi thì bấm đúng nút có title hoặc tên truy cập
  **Ký số Trưởng khoa ký ủy quyền Giám đốc**, xác nhận ký rồi chờ nút gửi.
  Theo luồng này, nút gửi sẵn sàng là tín hiệu giao diện để tiếp tục;
  script không xác minh chữ ký ủy quyền bằng một trường API riêng.
  Không ký Thông tin hành chính, không dùng nút người giao/người nhận và
  không tự đặt ảnh chữ ký.
  Không chờ `IsDaKySo` toàn phiếu thành `true`, vì người nhận còn chưa ký.
  Không dùng riêng ảnh chữ ký hoặc `UrlFileKySo` làm bằng chứng đã ký.
  Thiếu/trùng vị trí hoặc `IsDaKy` không phải boolean thì báo lỗi, không gửi.
  Chỉ chấp nhận hộp thoại xác nhận gửi phù hợp, không chấp nhận cảnh báo.
  Nút gửi có thể chỉ có biểu tượng máy bay giấy và xuất hiện sau khi ký:
  script tìm theo `title="Gửi ký hồ sơ"` hoặc tên truy cập tương ứng,
  chỉ bấm khi có đúng một nút hiển thị và được phép bấm. Terminal ghi rõ
  từng bước chờ xác nhận ký ủy quyền, tìm nút gửi và kiểm tra lại API.
  Các phiếu khác có thể có `IsDaKySo: null`; điều này không làm hỏng việc
  đọc danh sách và không bị quy đổi thành đã ký/chưa ký. Riêng phiếu giao
  nhận phải có trạng thái boolean rõ ràng; nếu `null` thì không ký/gửi.
- Sau khi nút gửi xuất hiện, đọc lại API và kiểm tra toàn bộ
  phiếu cùng hai vị trí ký một lần nữa trước khi gửi. Nếu có phiếu khác
  chuyển sang `false`, người giao không còn đã ký hoặc người nhận đã ký,
  không gửi hồ sơ. Thông tin hành chính có thể vẫn `false` theo quy tắc
  đã chọn, nhưng script không tự xác nhận các cảnh báo của hệ thống.
- Kiểm tra lại API danh sách với bộ lọc đã chọn: chỉ ghi nhận hoàn tất
  khi hồ sơ không còn trong danh sách. Nếu đã xác nhận gửi nhưng không
  xác minh được, dừng chạy để kiểm tra thủ công, không tự gửi lại.
- Phiếu trùng tên hoặc API báo toàn phiếu đã ký: không ký/gửi lại;
  cần kiểm tra thủ công chữ ký theo vai trò. Người giao đã ký từ trước
  không phải lý do bỏ qua: đó là điều kiện bắt buộc để xử lý ký ủy quyền/gửi.

Kết quả nối thêm vào `logs/auto-sign-director.jsonl`; lỗi được ghi bằng logger
hiện có và chụp ảnh trang chi tiết trong `logs`. Các file này chứa thông tin
hồ sơ, cần bảo quản như dữ liệu y tế. Chế độ kiểm tra chỉ kiểm tra điều kiện
và nút ký, không chứng minh rằng thao tác ký/gửi thật sẽ thành công.
Kết quả có `check.unsignedDocuments`, `check.blockingDocuments` và
`check.nullStatusDocuments` để đối chiếu điều kiện từ API.
Kết quả gửi có thêm `postSignSignature.senderSigned` và
`postSignSignature.receiverSigned` để đối chiếu hai vị trí ký trước khi gửi.
`signedThisRun` cho biết lượt này có bấm ký ủy quyền hay dùng nút gửi sẵn có.

Kiểm thử bằng giao diện/API giả lập, không gọi máy chủ bệnh viện:

```powershell
node --test tests\auto-sign-director.test.js
```

## Bộ tải phim độc lập

Phần tải phim theo Excel được tách riêng trong [AutoDownload](./AutoDownload/README.md).
Dùng `AutoDownload\CaiDat.cmd` để cài, điền `AutoDownload\config.json`, rồi
chạy `AutoDownload\Chay.cmd`. Không cần cài hoặc chạy giao diện/server của dự án này.
Điểm chạy cũ `node AutoDownload.js` vẫn sử dụng Excel và downloads theo thư mục
chạy hiện tại, nhưng tài khoản lấy từ cấu hình riêng hoặc biến môi trường.

## Cài đặt (chạy 1 lần)

```bash
npm install playwright
npx playwright install chromium
```

## Cách chạy

1. **Đăng nhập & lưu session** (chỉ cần làm lại khi session hết hạn):
   ```bash
   node login.js
   ```
   Trình duyệt sẽ mở lên, bạn đăng nhập thủ công, quay lại terminal nhấn Enter.
   Session được lưu vào `storageState.json`.

2. **Chạy xử lý chính**:
   ```bash
   node main.js
   ```
   Script sẽ: lấy danh sách mục → mở 9 tab song song → xử lý từng mục →
   lưu kết quả hợp lệ vào `output.jsonl` → ghi log vào `logs/YYYY-MM-DD.log`.

## Những chỗ BẮT BUỘC phải chỉnh lại trong `main.js`

| Việc | Ở đâu |
|---|---|
| URL trang danh sách | `LIST_URL` |
| URL trang chi tiết | `DETAIL_URL_TEMPLATE` |
| Selector lấy danh sách id | `fetchItemList()` |
| Selector trích xuất dữ liệu | `extractData()` |
| Quy tắc "thiếu" / "sai" | `validateData()` |
| Nơi lưu dữ liệu hợp lệ | `saveData()` |

## Lên lịch chạy định kỳ nhiều lần/ngày

**Trên Linux/macOS** — dùng cron. Ví dụ chạy lúc 8h, 12h, 16h mỗi ngày:
```bash
crontab -e
# thêm dòng:
0 8,12,16 * * * cd /duong-dan/den/browser-automation && /usr/bin/node main.js >> logs/cron.log 2>&1
```

**Trên Windows** — dùng Task Scheduler, action chạy:
```
node.exe main.js
```
với "Start in" trỏ vào thư mục project.

## Lưu ý quan trọng

- `waitUntil: 'load'` chờ trang tải xong toàn bộ (HTML, CSS, ảnh...). Nếu dữ liệu
  bạn cần được load bằng AJAX/JS SAU KHI trang đã "load" xong, hãy đổi thành
  `'networkidle'` (chờ đến khi không còn request mạng nào trong 500ms), hoặc dùng
  `page.waitForSelector('#field-ten')` để chờ đúng phần tử chứa dữ liệu xuất hiện.
- Nếu session đăng nhập hết hạn giữa chừng, script sẽ lỗi khi load trang (bị
  redirect về trang login). Nên kiểm tra thêm: sau khi `goto()`, check xem URL
  hiện tại có phải trang login không, nếu có thì dừng lại và báo cần đăng nhập lại.
- 9 tab chạy song song sẽ dùng khá nhiều RAM/CPU. Nếu máy yếu hoặc web giới hạn
  request, có thể giảm `NUM_WORKERS` xuống.
- File `output.jsonl`: mỗi dòng là 1 object JSON, dễ đọc lại bằng bất kỳ ngôn
  ngữ nào (hoặc import vào Excel/Google Sheets).