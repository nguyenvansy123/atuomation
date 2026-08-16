const fs = require('node:fs');
const path = require('node:path');

const FILTER_CONFIG_PATH = path.join(__dirname, 'filter-config.json');
const SEND_STORE_FILTER_CONFIG_PATH = path.join(__dirname, 'send-store-filter-config.json');

function formatApiDate(dateValue) {
  if (!dateValue) return '';
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return String(dateValue);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
}

function getDefaultFilters() {
  const from = new Date('2025-02-27T00:00:00');
  const to = new Date();
  to.setDate(to.getDate() + 1);

  return Object.freeze({
    pageSize: '10',
    from: formatApiDate(from),
    to: formatApiDate(to),
    iBaoHiem: '2',
    isCapCuu: 'false',
    NamVien: 'false',
    idKhoa: '00000000-0000-0000-0000-000000000000',
    maLoaiBenhAn: '',
    strsearch: '',
    Active: 'true',
    TrangThaiKy: 'ChoDuyet',
    MaTrangThaiNode: 'DONE',
    idTruongKhoaKy: 'undefined',
    idNguoiDuyet: 'undefined',
    idCanBo: 'undefined',
    iBADT: '2',
  });
}

function getDefaultSendStoreFilters() {
  const from = new Date('2026-01-01T00:00:00');
  const to = new Date('2026-08-16T23:59:59');

  return Object.freeze({
    pageSize: '10',
    from: formatApiDate(from),
    to: formatApiDate(to),
    iBaoHiem: '2',
    isCapCuu: 'false',
    NamVien: 'iALL',
    idKhoa: '00000000-0000-0000-0000-000000000000',
    idKhoaDieuTri: '00000000-0000-0000-0000-000000000000',
    maLoaiBenhAn: '',
    strsearch: '',
    Active: 'true',
    TrangThaiKy: 'ChoDuyet',
    MaTrangThaiNode: 'DONE',
    idTruongKhoaKy: 'undefined',
    idNguoiDuyet: 'undefined',
    idCanBo: 'undefined',
    iBADT: '2',
  });
}

function safeReadConfig(configPath) {
  try {
    if (!fs.existsSync(configPath)) return {};
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    return {};
  }
}

function readFilterConfig() {
  const defaults = getDefaultFilters();
  const saved = safeReadConfig(FILTER_CONFIG_PATH);
  return { ...defaults, ...saved };
}

function saveFilterConfig(filters) {
  const merged = { ...getDefaultFilters(), ...(filters || {}) };
  fs.writeFileSync(FILTER_CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

function normalizeSendStoreFilters(filters = {}) {
  const defaults = getDefaultSendStoreFilters();
  const merged = { ...defaults, ...(filters || {}) };

  if (!merged.idKhoaDieuTri && merged.idKhoa) {
    merged.idKhoaDieuTri = merged.idKhoa;
  }

  if (!merged.idKhoa && merged.idKhoaDieuTri) {
    merged.idKhoa = merged.idKhoaDieuTri;
  }

  if (merged.NamVien == null) {
    merged.NamVien = defaults.NamVien;
  }

  if (!merged.pageSize) {
    merged.pageSize = defaults.pageSize;
  }

  return merged;
}

function readSendStoreFilterConfig() {
  const saved = safeReadConfig(SEND_STORE_FILTER_CONFIG_PATH);
  return normalizeSendStoreFilters(saved);
}

function saveSendStoreFilterConfig(filters) {
  const merged = normalizeSendStoreFilters(filters);
  fs.writeFileSync(SEND_STORE_FILTER_CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

module.exports = {
  FILTER_CONFIG_PATH,
  SEND_STORE_FILTER_CONFIG_PATH,
  getDefaultFilters,
  getDefaultSendStoreFilters,
  readFilterConfig,
  saveFilterConfig,
  readSendStoreFilterConfig,
  saveSendStoreFilterConfig,
  normalizeSendStoreFilters,
  formatApiDate,
};
