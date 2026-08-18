const fs = require('fs');
const path = require('path');

const logPath = path.join(__dirname, 'logs', 'network-capture-1787019100229.json');
const outPath = path.join(__dirname, 'logs', 'api-summary-1787019100229.json');

const raw = fs.readFileSync(logPath, 'utf8');
const data = JSON.parse(raw);
const reqs = Array.isArray(data.requests) ? data.requests : [];

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

function isApiRequest(url) {
  return /\/api\//i.test(url);
}

const apiRequests = reqs.filter((r) => isApiRequest(r.url || ''));

const summary = {
  totalRequests: reqs.length,
  apiRequests: apiRequests.length,
  domain: [...new Set(apiRequests.map((r) => {
    try {
      return new URL(r.url).hostname;
    } catch {
      return null;
    }
  }).filter(Boolean))],
  byPath: {},
  signRelated: [],
  successfulSignFlows: [],
  notes: [
    'File này chứa toàn bộ request/response khi người dùng thao tác trên màn hình.',
    'Khi thấy các response có trường IsDaKy=true, ViTriChuaKy=[] và UrlFileKySo ..._da_ky.pdf là dấu hiệu hồ sơ đã ký thành công.',
    'Endpoint /api/79415/hsdikembenhan/<id> là nguồn dữ liệu chính để xác định trạng thái ký của từng hồ sơ.'
  ]
};

for (const r of apiRequests) {
  const u = new URL(r.url);
  const key = `${r.method} ${u.pathname}`;
  summary.byPath[key] = (summary.byPath[key] || 0) + 1;
}

const signKeywords = [
  'getThongTinKy',
  'getViTriKyDiKem',
  'getViTriKyPhieuTTHCByIdBenhAn',
  'chukys',
  'guitruongkhoa',
  'lankhams',
  'hsdikembenhan',
  'hsbenhan',
  'HSBAFileHTMLPDF'
];

for (const r of apiRequests) {
  const text = `${r.url || ''} ${r.responseBodyText || ''}`;
  const matches = signKeywords.some((k) => text.toLowerCase().includes(k.toLowerCase()));
  if (!matches) continue;

  summary.signRelated.push({
    method: r.method,
    status: r.status,
    url: normalizeUrl(r.url),
    hasBody: Boolean(r.responseBodyText),
    bodyPreview: String(r.responseBodyText || '').slice(0, 800)
  });
}

for (const r of apiRequests) {
  const body = String(r.responseBodyText || '');
  if (!body.includes('IsDaKy')) continue;

  const parsed = (() => {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  })();

  const current = Array.isArray(parsed) ? parsed : [parsed];
  const hasSignedRecord = current.some((item) => {
    if (!item || typeof item !== 'object') return false;
    return item.IsDaKy === true || item.IsDaKySo === true || item.ViTriChuaKy === '[]' || item.ViTriChuaKy === [];
  });

  if (hasSignedRecord) {
    summary.successfulSignFlows.push({
      method: r.method,
      status: r.status,
      url: normalizeUrl(r.url),
      bodyPreview: body.slice(0, 1000)
    });
  }
}

fs.writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf8');

console.log('=== API SUMMARY ===');
console.log('total requests:', summary.totalRequests);
console.log('total API requests:', summary.apiRequests);
console.log('domain:', summary.domain);
console.log('important paths:');
for (const [key, count] of Object.entries(summary.byPath)) {
  if (key.includes('/api/79415/dieutri/bachoduyetky') || key.includes('/api/79415/hsdikembenhan') || key.includes('/api/79415/chukys') || key.includes('/api/79415/hsbenhan')) {
    console.log(' -', key, 'x', count);
  }
}
console.log('sign related count:', summary.signRelated.length);
console.log('successful sign flow count:', summary.successfulSignFlows.length);
console.log('saved to:', outPath);
