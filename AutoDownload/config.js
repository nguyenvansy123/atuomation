const fs = require('fs');
const path = require('path');

function docCauHinh() {
  const file = path.join(__dirname, 'config.json');
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const lay = (bien, khoa, macDinh = '') => {
    const giaTri = process.env[bien] ?? config[khoa] ?? macDinh;
    if (typeof giaTri !== 'string' || !giaTri.trim()) {
      throw new Error(`Thieu hoac sai ${khoa}. Nhap trong config.json hoac dat ${bien}.`);
    }
    return giaTri;
  };
  return {
    user: lay('PACS_USER', 'user'),
    pass: lay('PACS_PASS', 'pass'),
    excelFile: path.resolve(__dirname, lay('PACS_EXCEL', 'excelFile', 'danh_sach.xlsx')),
    thuMucTai: path.resolve(__dirname, lay('PACS_THU_MUC_TAI', 'thuMucTai', 'downloads')),
  };
}

module.exports = { docCauHinh };
