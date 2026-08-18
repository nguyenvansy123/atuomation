const fs = require('fs');
const path = require('path');

const input = path.join(__dirname, 'logs', 'network-capture-1787019100229.json');
const out = path.join(__dirname, 'logs', 'api-workflow-map.json');

const raw = fs.readFileSync(input, 'utf8');
const data = JSON.parse(raw);
const reqs = Array.isArray(data.requests) ? data.requests : [];

function parseBody(body) {
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function safeString(value) {
  if (value == null) return '';
  return String(value).slice(0, 400);
}

const groups = {
  auth: [],
  list: [],
  config: [],
  detail: [],
  signStatus: [],
  signToken: [],
  action: [],
  unknown: []
};

for (const r of reqs) {
  const url = r.url || '';
  const body = r.responseBodyText || '';

  if (/\/oauth\/token/i.test(url)) groups.auth.push(r);
  else if (/\/api\/accounts\/user\//i.test(url)) groups.auth.push(r);
  else if (/\/api\/\d+\/config/i.test(url)) groups.config.push(r);
  else if (/\/api\/\d+\/dieutri\/bachoduyetky/i.test(url)) groups.list.push(r);
  else if (/\/api\/\d+\/hsbenhan\//i.test(url) || /\/api\/\d+\/hsdikembenhan\//i.test(url) || /\/api\/\d+\/HSBAFileHTMLPDF\//i.test(url)) groups.detail.push(r);
  else if (/getThongTinKy|getViTriKy|ViTriChuaKy|IsDaKy|UrlFileKySo|chukys|guitruongkhoa/i.test(url + body)) groups.signStatus.push(r);
  else if (/chukys/i.test(url)) groups.signToken.push(r);
  else if (/guitruongkhoa|action=4|action=|Delete/i.test(url + body)) groups.action.push(r);
  else groups.unknown.push(r);
}

const workflow = {
  overview: {
    totalRequests: reqs.length,
    apiRequests: reqs.filter((r) => /\/api\//i.test(r.url)).length,
    description: 'Trang đang làm workflow xác nhận ký hồ sơ bệnh án và gửi lên cấp tiếp theo.'
  },
  steps: [
    {
      step: 1,
      name: 'Xác thực và tải cấu hình',
      apis: groups.auth.concat(groups.config).map((r) => ({
        method: r.method,
        status: r.status,
        url: r.url,
        notes: 'Lấy user hiện tại và cấu hình quyền/loại hồ sơ.'
      }))
    },
    {
      step: 2,
      name: 'Load danh sách chờ duyệt',
      apis: groups.list.map((r) => ({
        method: r.method,
        status: r.status,
        url: r.url,
        notes: 'Danh sách hồ sơ đang chờ ký duyệt.'
      }))
    },
    {
      step: 3,
      name: 'Mở hồ sơ chi tiết và kiểm tra trạng thái ký',
      apis: groups.detail.map((r) => ({
        method: r.method,
        status: r.status,
        url: r.url,
        notes: 'Kiểm tra IsDaKy, ViTriChuaKy, UrlFileKySo, vị trí ký từng hồ sơ.'
      }))
    },
    {
      step: 4,
      name: 'Lấy chữ ký và quyền ký',
      apis: groups.signToken.map((r) => ({
        method: r.method,
        status: r.status,
        url: r.url,
        notes: 'Lấy thông tin chữ ký, role, quyền tài khoản khi ký hồ sơ.'
      }))
    },
    {
      step: 5,
      name: 'Thao tác gửi/duyệt hồ sơ',
      apis: groups.action.map((r) => ({
        method: r.method,
        status: r.status,
        url: r.url,
        notes: 'Gửi hồ sơ tới cấp tiếp theo hoặc hành động xử lý ký.'
      }))
    }
  ],
  evidenceOfSignedDocument: [
    {
      field: 'IsDaKy',
      meaning: 'Trạng thái hồ sơ đã ký hay chưa.'
    },
    {
      field: 'ViTriChuaKy',
      meaning: 'Vị trí còn chưa ký. Nếu array rỗng nghĩa là tất cả vị trí đã ký.'
    },
    {
      field: 'UrlFileKySo',
      meaning: 'Đường dẫn file PDF đã ký số; nếu có thì hồ sơ đã được ký thành công.'
    }
  ],
  sampleSuccessSignals: [
    'IsDaKy: true',
    'ViTriChuaKy: []',
    'UrlFileKySo: ..._da_ky.pdf',
    'DELETE .../guitruongkhoa?...action=4'
  ]
};

fs.writeFileSync(out, JSON.stringify(workflow, null, 2), 'utf8');
console.log('Saved workflow map to:', out);
console.log('Total API requests:', workflow.overview.apiRequests);
console.log('Workflow steps:', workflow.steps.length);
