const fs = require('node:fs');
const path = require('node:path');

/**
 * Đọc tài khoản đăng nhập tự động cho website hồ sơ y tế.
 * Ưu tiên biến môi trường HOSOYTE_USER/HOSOYTE_PASS, sau đó tới
 * config.json (xem config.example.json). File config.json chứa mật
 * khẩu, không chia sẻ và không đưa vào Git.
 */
function docThongTinDangNhap() {
  const file = path.join(__dirname, 'config.json');
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const lay = (bien, khoa) => {
    const giaTri = process.env[bien] ?? config[khoa];
    if (typeof giaTri !== 'string' || !giaTri.trim()) {
      throw new Error(
        `Thieu tai khoan dang nhap. Tao ${path.basename(file)} (xem config.example.json) hoac dat bien moi truong ${bien}.`
      );
    }
    return giaTri.trim();
  };
  return {
    user: lay('HOSOYTE_USER', 'user'),
    pass: lay('HOSOYTE_PASS', 'pass'),
  };
}

module.exports = { docThongTinDangNhap };
