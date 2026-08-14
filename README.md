# Browser Automation - Khung sườn (scaffold)

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
