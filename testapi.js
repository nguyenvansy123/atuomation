const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const STORAGE_STATE_PATH = path.join(__dirname, 'storageState.json');

const TARGET_URL =
  'https://bvrhm.hosoyte.com/v2/#/HSBA/DsBenhAnChoKy?TrangThai=ChoDuyet';

const LOGIN_URL =
  'https://bvrhm.hosoyte.com/v2/';

const API_ORIGIN =
  'https://bvrhm.hosoyte.com';


// ============================================================
// ĐỌC ACCESS TOKEN
// ============================================================

function getAccessTokenFromStorageState() {
  try {
    if (!fs.existsSync(STORAGE_STATE_PATH)) {
      return null;
    }

    const raw = fs.readFileSync(
      STORAGE_STATE_PATH,
      'utf8'
    );

    const state = JSON.parse(raw);

    const origin = (state.origins || []).find(
      (item) =>
        item.origin === API_ORIGIN
    );

    const currentUser = (
      origin?.localStorage || []
    ).find(
      (item) =>
        item.name === 'currentUser'
    );

    if (!currentUser?.value) {
      return null;
    }

    const parsed =
      JSON.parse(currentUser.value);

    return parsed?.access_token || null;

  } catch (error) {

    console.error(
      'Không đọc được token từ storageState.json:',
      error.message
    );

    return null;
  }
}


// ============================================================
// KIỂM TRA LOGIN
// ============================================================

async function ensureLoggedIn(
  page,
  tokenFromFile
) {

  const currentUserFromPage =
    await page.evaluate(() => {

      try {

        const raw =
          localStorage.getItem(
            'currentUser'
          );

        return raw
          ? JSON.parse(raw)
          : null;

      } catch (error) {

        return null;
      }
    });


  if (
    currentUserFromPage?.access_token ||
    tokenFromFile
  ) {

    console.log(
      'Session đã có sẵn.'
    );

    return;
  }


  console.log(
    'Chưa có session hợp lệ.'
  );

  console.log(
    'Mở trang đăng nhập để bạn login thủ công...'
  );


  await page.goto(
    LOGIN_URL,
    {
      waitUntil: 'domcontentloaded',
      timeout: 120000
    }
  );


  console.log(
    'Sau khi đăng nhập xong, nhấn Enter trong terminal để tiếp tục.'
  );


  await new Promise(
    (resolve) => {

      process.stdin.once(
        'data',
        () => resolve()
      );

    }
  );
}


// ============================================================
// INJECT FULL SCREEN API UI
// ============================================================

async function injectApiTestUI(page) {

  await page.evaluate(() => {

    // --------------------------------------------------------
    // XÓA UI CŨ NẾU ĐÃ TỒN TẠI
    // --------------------------------------------------------

    const oldRoot =
      document.getElementById(
        'api-test-menu-root'
      );

    if (oldRoot) {
      oldRoot.remove();
    }


    // --------------------------------------------------------
    // ROOT
    // --------------------------------------------------------

    const root =
      document.createElement('div');

    root.id =
      'api-test-menu-root';


    root.style.position = 'fixed';
    root.style.left = '0';
    root.style.top = '0';
    root.style.right = '0';
    root.style.bottom = '0';
    root.style.width = '100vw';
    root.style.height = '100vh';
    root.style.maxWidth = '100vw';
    root.style.maxHeight = '100vh';

    root.style.background =
      '#f3f4f6';

    root.style.zIndex =
      '2147483647';

    root.style.fontFamily =
      'Arial, sans-serif';

    root.style.boxSizing =
      'border-box';

    root.style.padding =
      '20px';

    root.style.overflow =
      'auto';


    // --------------------------------------------------------
    // HTML
    // --------------------------------------------------------

    root.innerHTML = `

      <div
        id="api-main-container"
        style="
          height:100%;
          display:flex;
          flex-direction:column;
          gap:16px;
        "
      >

        <!-- ================================================= -->
        <!-- HEADER -->
        <!-- ================================================= -->

        <div
          style="
            background:#ffffff;
            border:1px solid #d1d5db;
            border-radius:10px;
            padding:16px 20px;

            display:flex;
            justify-content:space-between;
            align-items:center;

            flex-shrink:0;
          "
        >

          <div>

            <div
              style="
                font-size:22px;
                font-weight:700;
                color:#111827;
              "
            >
              API Test & Network Monitor
            </div>

            <div
              style="
                margin-top:5px;
                font-size:13px;
                color:#6b7280;
              "
            >
              Công cụ kiểm tra API và theo dõi request của hệ thống
            </div>

          </div>


          <div
            style="
              display:flex;
              gap:8px;
            "
          >

            <button
              id="api-test-minimize"
              style="
                border:1px solid #d1d5db;
                background:#f3f4f6;
                color:#374151;

                border-radius:8px;
                padding:8px 16px;

                cursor:pointer;
                font-weight:600;
              "
            >
              Thu nhỏ
            </button>


            <button
              id="api-test-close"
              style="
                border:1px solid #ef4444;
                background:#fee2e2;
                color:#b91c1c;

                border-radius:8px;
                padding:8px 16px;

                cursor:pointer;
                font-weight:600;
              "
            >
              Đóng
            </button>

          </div>

        </div>


        <!-- ================================================= -->
        <!-- API TEST AREA -->
        <!-- ================================================= -->

        <div
          id="api-test-area"
          style="
            display:flex;
            flex-direction:column;
            gap:12px;
            flex-shrink:0;
          "
        >


          <!-- =============================================== -->
          <!-- API 1 -->
          <!-- =============================================== -->

          <div
            style="
              background:#ffffff;
              padding:16px;

              border-radius:10px;
              border:1px solid #d1d5db;
            "
          >

            <div
              style="
                font-size:15px;
                font-weight:700;
                margin-bottom:10px;
                color:#111827;
              "
            >
              1. DS hồ sơ
            </div>


            <div
              style="
                display:flex;
                gap:10px;
              "
            >

              <input
                id="api-list-url"

                value="https://bvrhm.hosoyte.com/api/79415/dieutri/bachoduyetky?isCapCuu=false&iBaoHiem=2&NamVien=iALL&from=01/01/2026&to=07/31/2026&idKhoa=00000000-0000-0000-0000-000000000000&idCanBo=undefined&maLoaiBenhAn=&strsearch=&iBADT=2&MaTrangThaiNode=DONE&pageIndex=1&pageSize=10&Active=true&TrangThaiKy=ChoDuyet&idTruongKhoaKy=undefined&idNguoiDuyet=undefined"

                style="
                  flex:1;
                  min-height:40px;

                  border:1px solid #d1d5db;
                  border-radius:8px;

                  padding:8px 12px;

                  font-family:Consolas,Monaco,monospace;
                  font-size:13px;

                  box-sizing:border-box;
                "
              />


              <button
                data-api="list"

                style="
                  min-width:120px;

                  border:1px solid #93c5fd;
                  background:#eff6ff;

                  color:#1d4ed8;

                  border-radius:8px;

                  font-weight:700;

                  cursor:pointer;
                "
              >
                Gọi API
              </button>

            </div>

          </div>


          <!-- =============================================== -->
          <!-- API 2 -->
          <!-- =============================================== -->

          <div
            style="
              background:#ffffff;
              padding:16px;

              border-radius:10px;
              border:1px solid #d1d5db;
            "
          >

            <div
              style="
                font-size:15px;
                font-weight:700;
                margin-bottom:10px;
                color:#111827;
              "
            >
              2. Mở hồ sơ
            </div>


            <div
              style="
                display:flex;
                gap:10px;
              "
            >

              <input
                id="api-detail-url"

                value="https://bvrhm.hosoyte.com/api/79415/hsbenhan/ba8ff0d0-cd19-4034-b40a-b4410afdac67"

                style="
                  flex:1;
                  min-height:40px;

                  border:1px solid #d1d5db;
                  border-radius:8px;

                  padding:8px 12px;

                  font-family:Consolas,Monaco,monospace;
                  font-size:13px;

                  box-sizing:border-box;
                "
              />


              <button
                data-api="detail"

                style="
                  min-width:120px;

                  border:1px solid #93c5fd;
                  background:#eff6ff;

                  color:#1d4ed8;

                  border-radius:8px;

                  font-weight:700;

                  cursor:pointer;
                "
              >
                Gọi API
              </button>

            </div>

          </div>


          <!-- =============================================== -->
          <!-- API 3 -->
          <!-- =============================================== -->

          <div
            style="
              background:#ffffff;
              padding:16px;

              border-radius:10px;
              border:1px solid #d1d5db;
            "
          >

            <div
              style="
                font-size:15px;
                font-weight:700;
                margin-bottom:10px;
                color:#111827;
              "
            >
              3. Giao nhận
            </div>


            <div
              style="
                display:flex;
                gap:10px;
              "
            >

              <input
                id="api-sign-url"

                value="https://bvrhm.hosoyte.com/api/79415/dieutri//e27af326-e9af-40a6-8063-45af44709944/guitruongkhoa?idBenhAn=e27af326-e9af-40a6-8063-45af44709944&idCanBo=5464b473-9f1c-4826-a7bd-a77bfc2ebc5f&action=4"

                style="
                  flex:1;
                  min-height:40px;

                  border:1px solid #d1d5db;
                  border-radius:8px;

                  padding:8px 12px;

                  font-family:Consolas,Monaco,monospace;
                  font-size:13px;

                  box-sizing:border-box;
                "
              />


              <button
                data-api="sign"

                style="
                  min-width:120px;

                  border:1px solid #fbbf24;
                  background:#fef3c7;

                  color:#92400e;

                  border-radius:8px;

                  font-weight:700;

                  cursor:pointer;
                "
              >
                Gọi API
              </button>

            </div>

          </div>


          <!-- =============================================== -->
          <!-- API 4 -->
          <!-- =============================================== -->

          <div
            style="
              background:#ffffff;
              padding:16px;

              border-radius:10px;
              border:1px solid #d1d5db;
            "
          >

            <div
              style="
                font-size:15px;
                font-weight:700;
                margin-bottom:10px;
                color:#111827;
              "
            >
              4. Delete
            </div>


            <div
              style="
                display:flex;
                gap:10px;
              "
            >

              <input
                id="api-delete-url"

                value="https://bvrhm.hosoyte.com/api/79415/dieutri//7ea0f5e-3638-401f-8415-d9e64d0e4a6b/guitruongkhoa?idBenhAn=7ea0f5e-3638-401f-8415-d9e64d0e4a6b&idCanBo=5464b473-9f1c-4826-a7bd-a77bfc2ebc5f&action=4"

                style="
                  flex:1;
                  min-height:40px;

                  border:1px solid #d1d5db;
                  border-radius:8px;

                  padding:8px 12px;

                  font-family:Consolas,Monaco,monospace;
                  font-size:13px;

                  box-sizing:border-box;
                "
              />


              <button
                data-api="delete"

                style="
                  min-width:120px;

                  border:1px solid #fca5a5;
                  background:#fee2e2;

                  color:#991b1b;

                  border-radius:8px;

                  font-weight:700;

                  cursor:pointer;
                "
              >
                Gọi API
              </button>

            </div>

          </div>

        </div>


        <!-- ================================================= -->
        <!-- NETWORK CONTROL -->
        <!-- ================================================= -->

        <div
          style="
            background:#ffffff;

            border:1px solid #d1d5db;
            border-radius:10px;

            padding:12px 16px;

            display:flex;
            align-items:center;
            justify-content:space-between;

            flex-shrink:0;
          "
        >

          <div>

            <span
              style="
                font-weight:700;
                color:#111827;
              "
            >
              Network Monitor
            </span>

            <span
              id="network-status"
              style="
                margin-left:10px;
                font-size:13px;
                color:#16a34a;
              "
            >
              ● Đang theo dõi
            </span>

          </div>


          <div
            style="
              display:flex;
              gap:8px;
            "
          >

            <button
              id="network-toggle"
              style="
                border:1px solid #d1d5db;
                background:#f9fafb;

                border-radius:7px;

                padding:7px 12px;

                cursor:pointer;
              "
            >
              Tạm dừng
            </button>


            <button
              id="network-clear"
              style="
                border:1px solid #d1d5db;
                background:#f9fafb;

                border-radius:7px;

                padding:7px 12px;

                cursor:pointer;
              "
            >
              Xóa log
            </button>

          </div>

        </div>


        <!-- ================================================= -->
        <!-- OUTPUT -->
        <!-- ================================================= -->

        <div
          style="
            flex:1;

            min-height:300px;

            background:#111827;

            border-radius:10px;

            padding:16px;

            box-sizing:border-box;

            overflow:hidden;

            display:flex;

            flex-direction:column;
          "
        >

          <div
            style="
              color:#ffffff;

              font-size:15px;
              font-weight:700;

              margin-bottom:10px;

              flex-shrink:0;
            "
          >
            API Response / Network Log
          </div>


          <pre
            id="api-test-output"

            style="
              flex:1;

              margin:0;

              color:#e5e7eb;

              white-space:pre-wrap;

              overflow:auto;

              font-size:13px;

              line-height:1.6;

              font-family:Consolas,Monaco,monospace;
            "
          >Chưa có kết quả API.</pre>

        </div>

      </div>
    `;


    // --------------------------------------------------------
    // ADD TO PAGE
    // --------------------------------------------------------

    document.body.appendChild(root);


    // --------------------------------------------------------
    // KHÓA SCROLL TRANG GỐC
    // --------------------------------------------------------

    const oldBodyOverflow =
      document.body.style.overflow;

    document.body.style.margin = '0';
    document.body.style.padding = '0';
    document.body.style.width = '100vw';
    document.body.style.height = '100vh';
    document.body.style.overflow =
      'hidden';

    document.documentElement.style.margin = '0';
    document.documentElement.style.padding = '0';


    // --------------------------------------------------------
    // ELEMENTS
    // --------------------------------------------------------

    const output =
      document.getElementById(
        'api-test-output'
      );

    const closeBtn =
      document.getElementById(
        'api-test-close'
      );

    const minimizeBtn =
      document.getElementById(
        'api-test-minimize'
      );

    const networkToggle =
      document.getElementById(
        'network-toggle'
      );

    const networkClear =
      document.getElementById(
        'network-clear'
      );

    const networkStatus =
      document.getElementById(
        'network-status'
      );

    const mainContainer =
      document.getElementById(
        'api-main-container'
      );


    // --------------------------------------------------------
    // NETWORK LOG STATE
    // --------------------------------------------------------

    let networkEnabled = true;

    let networkLogs = [];


    // --------------------------------------------------------
    // FORMAT TIME
    // --------------------------------------------------------

    function getTime() {

      return new Date()
        .toLocaleTimeString(
          'vi-VN',
          {
            hour12: false
          }
        );

    }


    // --------------------------------------------------------
    // ADD NETWORK LOG
    // --------------------------------------------------------

    function addNetworkLog(log) {

      if (!networkEnabled) {
        return;
      }


      networkLogs.push(log);


      // Giới hạn log để tránh RAM tăng quá lớn
      if (networkLogs.length > 500) {

        networkLogs =
          networkLogs.slice(-500);

      }


      renderNetworkLogs();

    }


    // --------------------------------------------------------
    // RENDER NETWORK LOG
    // --------------------------------------------------------

    function renderNetworkLogs() {

      if (!networkLogs.length) {

        output.textContent =
          'Chưa có request / response API.';

        return;
      }


      output.textContent =
        networkLogs
          .map(
            (item, index) => {

              return `
============================================================
#${index + 1}
TIME: ${item.time}
TYPE: ${item.type}
METHOD: ${item.method || ''}
STATUS: ${item.status || ''}
DURATION: ${item.duration || ''} ms

URL:
${item.url || ''}

${item.body
  ? `BODY:
${item.body}

`
  : ''
}

${item.responseBody
  ? `RESPONSE:
${item.responseBody}

`
  : ''
}
============================================================
`;
            }
          )
          .join('\n');

      output.scrollTop =
        output.scrollHeight;

    }


    // --------------------------------------------------------
    // GET TOKEN
    // --------------------------------------------------------

    const getToken = () => {

      try {

        const raw =
          localStorage.getItem(
            'currentUser'
          );


        if (!raw) {
          return '';
        }


        const parsed =
          JSON.parse(raw);


        return (
          parsed?.access_token ||
          ''
        );

      } catch (error) {

        return '';

      }

    };


    // --------------------------------------------------------
    // CALL API
    // --------------------------------------------------------

    async function callApi(
      url,
      method = 'GET',
      body = null
    ) {

      const token =
        getToken();


      if (!token) {

        output.textContent =
          'Không tìm thấy token trong localStorage. Hãy đăng nhập trước khi gọi API.';

        return;

      }


      const start =
        performance.now();


      output.textContent =
        `
Đang gọi API...

METHOD:
${method}

URL:
${url}
`;


      try {

        const response =
          await fetch(
            url,
            {

              method,

              headers: {

                'Authorization':
                  `Bearer ${token}`,

                'Content-Type':
                  'application/json'

              },


              body:
                method === 'GET' ||
                method === 'HEAD'

                  ? undefined

                  : body
                    ? JSON.stringify(body)
                    : undefined

            }
          );


        const duration =
          Math.round(
            performance.now() -
            start
          );


        let data;


        try {

          data =
            await response.json();

        } catch (error) {

          data =
            await response.text();

        }


        output.textContent =
          JSON.stringify(
            {

              time:
                getTime(),

              method,

              url,

              status:
                response.status,

              ok:
                response.ok,

              duration,

              data

            },
            null,
            2
          );


      } catch (error) {

        const duration =
          Math.round(
            performance.now() -
            start
          );


        output.textContent =
          `
LỖI KHI GỌI API

METHOD:
${method}

URL:
${url}

DURATION:
${duration} ms

ERROR:
${error.message}
`;

      }

    }


    // --------------------------------------------------------
    // API BUTTONS
    // --------------------------------------------------------

    document
      .querySelectorAll(
        '[data-api]'
      )
      .forEach(
        (button) => {

          button.addEventListener(
            'click',
            () => {

              const mode =
                button.getAttribute(
                  'data-api'
                );


              // ------------------------------
              // LIST
              // ------------------------------

              if (
                mode === 'list'
              ) {

                const url =
                  document
                    .getElementById(
                      'api-list-url'
                    )
                    .value
                    .trim();


                callApi(
                  url,
                  'GET'
                );

              }


              // ------------------------------
              // DETAIL
              // ------------------------------

              if (
                mode === 'detail'
              ) {

                const url =
                  document
                    .getElementById(
                      'api-detail-url'
                    )
                    .value
                    .trim();


                callApi(
                  url,
                  'GET'
                );

              }


              // ------------------------------
              // SIGN / GIAO NHẬN
              // ------------------------------

              if (
                mode === 'sign'
              ) {

                const url =
                  document
                    .getElementById(
                      'api-sign-url'
                    )
                    .value
                    .trim();


                callApi(
                  url,
                  'DELETE'
                );

              }


              // ------------------------------
              // DELETE
              // ------------------------------

              if (
                mode === 'delete'
              ) {

                const url =
                  document
                    .getElementById(
                      'api-delete-url'
                    )
                    .value
                    .trim();


                callApi(
                  url,
                  'DELETE'
                );

              }

            }
          );

        }
      );


    // --------------------------------------------------------
    // MINIMIZE
    // --------------------------------------------------------

    let isMinimized = false;

    function syncRootLayout() {
      if (isMinimized) {
        const maxWidth = Math.min(460, window.innerWidth - 24);

        root.style.inset = 'auto';
        root.style.top = '12px';
        root.style.right = '12px';
        root.style.bottom = 'auto';
        root.style.left = 'auto';

        root.style.width = `${Math.max(320, maxWidth)}px`;
        root.style.height = 'auto';

        root.style.padding = '12px';
        root.style.borderRadius = '10px';
        root.style.boxShadow =
          '0 10px 30px rgba(0,0,0,0.25)';

        mainContainer.style.height = 'auto';
        minimizeBtn.textContent = 'Toàn màn hình';

        return;
      }

      root.style.inset = '0';
      root.style.top = '0';
      root.style.right = '0';
      root.style.bottom = '0';
      root.style.left = '0';

      root.style.width = '100vw';
      root.style.height = '100vh';
      root.style.maxWidth = '100vw';
      root.style.maxHeight = '100vh';

      root.style.padding = '20px';
      root.style.borderRadius = '0';
      root.style.boxShadow = 'none';

      mainContainer.style.height = '100%';
      minimizeBtn.textContent = 'Thu nhỏ';
    }

    minimizeBtn.addEventListener('click', () => {
      isMinimized = !isMinimized;
      syncRootLayout();
    });

    window.addEventListener('resize', syncRootLayout);
    syncRootLayout();

    // --------------------------------------------------------
    // CLOSE
    // --------------------------------------------------------

    closeBtn.addEventListener(
      'click',
      () => {

        document.body.style.overflow =
          oldBodyOverflow;


        root.remove();

      }
    );


    // --------------------------------------------------------
    // NETWORK TOGGLE
    // --------------------------------------------------------

    networkToggle.addEventListener(
      'click',
      () => {

        networkEnabled =
          !networkEnabled;


        if (networkEnabled) {

          networkToggle.textContent =
            'Tạm dừng';

          networkStatus.textContent =
            '● Đang theo dõi';

          networkStatus.style.color =
            '#16a34a';

        } else {

          networkToggle.textContent =
            'Tiếp tục';

          networkStatus.textContent =
            '● Đã tạm dừng';

          networkStatus.style.color =
            '#dc2626';

        }

      }
    );


    // --------------------------------------------------------
    // CLEAR NETWORK LOG
    // --------------------------------------------------------

    networkClear.addEventListener(
      'click',
      () => {

        networkLogs = [];

        output.textContent =
          'Đã xóa network log.';

      }
    );

  }, {});
}


// ============================================================
// PLAYWRIGHT NETWORK MONITOR
// ============================================================

function setupNetworkMonitor(page) {


  // ----------------------------------------------------------
  // REQUEST
  // ----------------------------------------------------------

  page.on(
    'request',
    async (request) => {

      const url =
        request.url();


      if (!url.includes('/api/')) {
        return;
      }


      const method =
        request.method();


      const body =
        request.postData();


      console.log(
        '\n=================================================='
      );

      console.log(
        '[API REQUEST]'
      );

      console.log(
        'TIME:',
        new Date().toLocaleTimeString(
          'vi-VN',
          {
            hour12: false
          }
        )
      );

      console.log(
        'METHOD:',
        method
      );

      console.log(
        'URL:',
        url
      );


      if (body) {

        console.log(
          'BODY:',
          body
        );

      }

      console.log(
        '==================================================\n'
      );

    }
  );


  // ----------------------------------------------------------
  // RESPONSE
  // ----------------------------------------------------------

  page.on(
    'response',
    async (response) => {

      const url =
        response.url();


      if (!url.includes('/api/')) {
        return;
      }


      const request =
        response.request();


      console.log(
        '\n--------------------------------------------------'
      );

      console.log(
        '[API RESPONSE]'
      );

      console.log(
        'TIME:',
        new Date().toLocaleTimeString(
          'vi-VN',
          {
            hour12: false
          }
        )
      );

      console.log(
        'METHOD:',
        request.method()
      );

      console.log(
        'STATUS:',
        response.status()
      );

      console.log(
        'URL:',
        url
      );

      console.log(
        '--------------------------------------------------\n'
      );

    }
  );

}


// ============================================================
// MAIN
// ============================================================

(async () => {

  try {

    console.log(
      '=============================================='
    );

    console.log(
      'API TEST TOOL'
    );

    console.log(
      '=============================================='
    );


    // --------------------------------------------------------
    // TOKEN
    // --------------------------------------------------------

    const tokenFromFile =
      getAccessTokenFromStorageState();


    if (tokenFromFile) {

      console.log(
        'Đã tìm thấy access_token trong storageState.json.'
      );

    } else {

      console.log(
        'Không tìm thấy access_token trong storageState.json.'
      );

    }


    // --------------------------------------------------------
    // BROWSER
    // --------------------------------------------------------

    const browser =
      await chromium.launch(
        {
          headless: false
        }
      );


    // --------------------------------------------------------
    // CONTEXT
    // --------------------------------------------------------

    const context =
      await browser.newContext(
        {
          viewport: {
            width: 1280,
            height: 820
          },
          screen: {
            width: 1280,
            height: 820
          },

          ignoreHTTPSErrors:
            true,

          storageState:
            fs.existsSync(
              STORAGE_STATE_PATH
            )
              ? STORAGE_STATE_PATH
              : undefined

        }
      );


    // --------------------------------------------------------
    // PAGE
    // --------------------------------------------------------

    const page =
      await context.newPage();


    // --------------------------------------------------------
    // NETWORK MONITOR
    // --------------------------------------------------------

    setupNetworkMonitor(
      page
    );


    // --------------------------------------------------------
    // OPEN TARGET
    // --------------------------------------------------------

    console.log(
      'Mở trang target...'
    );


    await page.goto(
      TARGET_URL,
      {

        waitUntil:
          'domcontentloaded',

        timeout:
          120000

      }
    );


    // --------------------------------------------------------
    // LOGIN
    // --------------------------------------------------------

    await ensureLoggedIn(
      page,
      tokenFromFile
    );


    // --------------------------------------------------------
    // CHECK TOKEN AGAIN
    // --------------------------------------------------------

    if (!tokenFromFile) {

      const refreshedToken =
        getAccessTokenFromStorageState();


      if (!refreshedToken) {

        console.log(
          'Không có token hợp lệ trong storageState.json.'
        );


        console.log(
          'Hãy login vào web rồi chạy lại script.'
        );


        await page.goto(
          LOGIN_URL,
          {

            waitUntil:
              'domcontentloaded',

            timeout:
              120000

          }
        );


        await new Promise(
          () => {}
        );


        return;

      }

    }


    // --------------------------------------------------------
    // OPEN TARGET AGAIN
    // --------------------------------------------------------

    await page.goto(
      TARGET_URL,
      {

        waitUntil:
          'domcontentloaded',

        timeout:
          120000

      }
    );


    // --------------------------------------------------------
    // INJECT UI
    // --------------------------------------------------------

    await injectApiTestUI(
      page
    );


    console.log(
      ''
    );

    console.log(
      '=============================================='
    );

    console.log(
      'API Test UI đã được chèn.'
    );

    console.log(
      '=============================================='
    );

    console.log(
      'Network Monitor đang theo dõi các request /api/.'
    );

    console.log(
      'Bạn có thể thao tác trực tiếp trên website.'
    );

    console.log(
      'Đặc biệt: thử Ký File → Xác nhận để xem API nào được gọi.'
    );

    console.log(
      ''
    );

    console.log(
      'Nhấn Ctrl+C để đóng browser.'
    );


    // --------------------------------------------------------
    // GIỮ BROWSER MỞ
    // --------------------------------------------------------

    await new Promise(
      (resolve) => {

        process.stdin.resume();


        process.on(
          'SIGINT',
          async () => {

            console.log(
              '\nĐang đóng browser...'
            );


            try {

              await browser.close();

            } catch (error) {

              // ignore

            }


            resolve();

          }
        );

      }
    );


  } catch (error) {

    console.error(
      '\nLỖI CHƯƠNG TRÌNH:'
    );

    console.error(
      error
    );

    process.exit(
      1
    );

  }

})();