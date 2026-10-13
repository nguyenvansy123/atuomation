const fs = require('fs');
const path = require('path');

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 22) {
    throw new Error('Can Node.js 22 tro len. Cai Node.js LTS tu https://nodejs.org/');
  }
  if (process.argv.includes('--check')) return;

  const fileConfig = path.join(__dirname, 'config.json');
  if (!fs.existsSync(fileConfig)) {
    fs.copyFileSync(path.join(__dirname, 'config.example.json'), fileConfig);
  }
  const fileExcel = path.join(__dirname, 'danh_sach.xlsx');
  if (!fs.existsSync(fileExcel)) {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.addRow([
      'Ma BN', 'Trang thai', 'Toan canh - Trang thai', 'Toan canh - File',
      'Cone Beam - Trang thai', 'Cone Beam - File', 'Ghi chu', 'Cap nhat luc',
    ]);
    ws.getColumn(1).numFmt = '@';
    await wb.xlsx.writeFile(fileExcel);
  }
  console.log('Da chuan bi config.json va danh_sach.xlsx; khong ghi de file da co.');
}

main().catch((loi) => {
  console.error(`Cai dat that bai: ${loi.message}`);
  process.exitCode = 1;
});
