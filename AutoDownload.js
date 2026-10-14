// Điểm chạy tương thích; bộ độc lập nằm trong thư mục AutoDownload.
// Giữ danh_sach.xlsx và downloads theo thư mục chạy hiện tại.
process.env.PACS_EXCEL ||= require('path').resolve('danh_sach.xlsx');
process.env.PACS_THU_MUC_TAI ||= require('path').resolve('downloads');
require('./AutoDownload/AutoDownload').chay();
