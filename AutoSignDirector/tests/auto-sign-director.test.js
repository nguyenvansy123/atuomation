const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const {
  DOCUMENT_NAME, SIGN_TITLE, checkDocumentEligibility, parseOptions, targetDocument,
  signAndSend, acceptAction, isRecordInList, collectRecords, refreshList,
  STORAGE_STATE_PATH, saveLoginSession,
  LIST_URL, isTargetListPage,
  parseDocuments,
  MEDICAL_CHART_NAME,
  transferSignatureState,
  ADMINISTRATIVE_NAME, administrativeSignatureState,
} = require('../auto-sign-director');

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const warning = fs.readFileSync(path.join(__dirname, 'fixtures', 'modal_warrning.html'), 'utf8');
const sendModal = fs.readFileSync(path.join(__dirname, 'fixtures', 'modal.html'), 'utf8');

test('opens and allows only the requested department-head waiting list', () => {
  assert.equal(LIST_URL, 'https://bvrhm.hosoyte.com/v2/#/HSBA/DsBenhAnChoKy?TrangThai=ChoKyTruongKhoa');
  assert.equal(isTargetListPage(LIST_URL), true);
  assert.equal(isTargetListPage(LIST_URL + '&filter=selected'), true);
  assert.equal(isTargetListPage(LIST_URL.replace('ChoKyTruongKhoa', 'ChoDuyet')), false);
  assert.equal(isTargetListPage(LIST_URL.replace('?TrangThai=ChoKyTruongKhoa', '')), false);
  assert.equal(isTargetListPage(LIST_URL.replace('DsBenhAnChoKy', 'OtherPage')), false);
  assert.equal(isTargetListPage(LIST_URL.replace('bvrhm.hosoyte.com', 'example.com')), false);
});

test('API eligibility allows false only on the two exact allowed document names', () => {
  const allowed = [
    { Ten: DOCUMENT_NAME, IsDaKySo: false },
    { Ten: 'Thông tin hành chính', IsDaKySo: false },
    { Ten: 'Phiếu chỉ định', IsDaKySo: true },
    { Ten: 'Thông tin bệnh án', IsDaKySo: null },
  ];
  const check = checkDocumentEligibility(parseDocuments(allowed));
  assert.equal(check.eligible, true);
  assert.deepEqual(check.unsignedDocuments, [DOCUMENT_NAME, 'Thông tin hành chính']);
  assert.deepEqual(check.blockingDocuments, []);
  assert.deepEqual(check.nullStatusDocuments, ['Thông tin bệnh án']);
  assert.equal(checkDocumentEligibility([{ Ten: DOCUMENT_NAME, IsDaKySo: false }]).eligible, true);
  assert.equal(checkDocumentEligibility([{ Ten: DOCUMENT_NAME, IsDaKySo: true }]).eligible, true);
  assert.equal(checkDocumentEligibility([
    { Ten: ' \nThông tin hành chính\u00a0', IsDaKySo: false },
  ]).eligible, true);
  const blocked = checkDocumentEligibility([
    ...allowed,
    { Ten: 'Bìa bệnh án', IsDaKySo: false },
    { Ten: 'Thông tin hành chính bổ sung', IsDaKySo: false },
  ]);
  assert.equal(blocked.eligible, false);
  assert.deepEqual(blocked.blockingDocuments, ['Bìa bệnh án', 'Thông tin hành chính bổ sung']);
  assert.match(blocked.reason, /Bìa bệnh án/);
});

test('options default to no signing and reject invalid limits/unknown flags', () => {
  assert.deepEqual(parseOptions([]), { execute: false, limit: 0, login: false });
  assert.deepEqual(parseOptions(['--execute', '--limit', '5']), { execute: true, limit: 5, login: false });
  assert.deepEqual(parseOptions(['--login']), { execute: false, limit: 0, login: true });
  assert.throws(() => parseOptions(['--login', '--execute']));
  assert.throws(() => parseOptions(['--login', '--limit', '1']));
  for (const value of ['0', '-1', '1.5', '1e2', '9007199254740992', '']) {
    assert.throws(() => parseOptions(['--limit', value]));
  }
  assert.throws(() => parseOptions(['--unknown']));
});

test('document selection rejects absent and duplicate same-name documents', () => {
  const document = { Ten: DOCUMENT_NAME, IsDaKySo: false };
  assert.equal(targetDocument([document]), document);
  assert.throws(() => targetDocument([]));
  assert.throws(() => targetDocument([document, { ...document }]));
  assert.throws(() => targetDocument([{ ...document, IsDaKySo: null }]), /chưa có trạng thái/);
  assert.throws(() => targetDocument([{ Ten: DOCUMENT_NAME }]), /chưa có trạng thái/);
});

test('observed nullable statuses on unrelated documents do not invalidate the target', () => {
  const payload = [
    { Ten: 'Phiếu kết quả Huyết học', IsDaKySo: null, IsDaKy: true },
    { Ten: 'Thông tin bệnh án', IsDaKySo: null, IsDaKy: false },
    { Ten: DOCUMENT_NAME, IsDaKySo: false, IsDaKy: false },
  ];
  for (const value of [payload, JSON.stringify(payload)]) {
    const documents = parseDocuments(value);
    assert.equal(documents[0].IsDaKySo, null);
    assert.equal(targetDocument(documents).IsDaKySo, false);
  }
  for (const value of [[], null, { List: payload }, [{ Ten: DOCUMENT_NAME, IsDaKySo: 'false' }],
    [{ IsDaKySo: false }], [{ Ten: '', IsDaKySo: false }]]) {
    assert.throws(() => parseDocuments(value));
  }
});

test('transfer signatures use exact role positions, not aggregate status or a signed PDF', () => {
  const positions = [
    { MaViTri: 'NguoiGiaoHoSo', IsDaKy: true },
    { MaViTri: 'NguoiNhanHoSo', IsDaKy: false },
  ];
  assert.deepEqual(transferSignatureState({
    IsDaKySo: false, IsDaKy: false, UrlFileKySo: 'signed.pdf', HSDiKemViTriKy: positions,
  }), { senderSigned: true, receiverSigned: false });
  assert.deepEqual(transferSignatureState({ HSDiKemViTriKy: [
    { MaViTri: 'NguoiGiaoHoSo', IsDaKy: false },
    { MaViTri: 'NguoiNhanHoSo', IsDaKy: true },
  ] }), { senderSigned: false, receiverSigned: true });
  for (const value of [undefined, null, '[]', [], [positions[0]], [positions[1]],
    [...positions, positions[0]], [...positions, positions[1]],
    [{ ...positions[0], IsDaKy: 'true' }, positions[1]],
    [positions[0], { ...positions[1], IsDaKy: null }]]) {
    assert.throws(() => transferSignatureState({ IsDaKySo: true, HSDiKemViTriKy: value }));
  }
});

test('administrative signatures use exact doctor and department-head roles', () => {
  const document = {
    Ten: ADMINISTRATIVE_NAME, IsDaKySo: true,
    HSDiKemViTriKy: [
      { MaViTri: 'BacSi', IsDaKy: true },
      { MaViTri: 'TruongKhoa', IsDaKy: false },
    ],
  };
  assert.deepEqual(administrativeSignatureState([document]), {
    doctorSigned: true, departmentHeadSigned: false,
  });
  assert.throws(() => administrativeSignatureState([]), /đúng một mục/);
  assert.throws(() => administrativeSignatureState([document, document]), /đúng một mục/);
  for (const positions of [undefined, null, [], [document.HSDiKemViTriKy[0]],
    [...document.HSDiKemViTriKy, document.HSDiKemViTriKy[1]],
    [{ MaViTri: 'BacSi', IsDaKy: 'true' }, document.HSDiKemViTriKy[1]],
    [document.HSDiKemViTriKy[0], { MaViTri: 'TruongKhoa', IsDaKy: null }]]) {
    assert.throws(() => administrativeSignatureState([{ ...document, HSDiKemViTriKy: positions }]));
  }
});

async function fixture(t, options = {}) {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(1500);
  let signed = false;
  let sent = false;
  const calls = [];
  const origin = 'https://bvrhm.hosoyte.com';
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('/hsdikembenhan/hsDiKem/')) {
      calls.push('documents');
      if (signed && options.rejectDocumentsAfterSign) {
        await route.fulfill({ status: 500, body: 'Document API must not be read after signing' });
        return;
      }
      await route.fulfill({ json: [
        {
          Ten: DOCUMENT_NAME,
          IsDaKySo: options.targetUnknown ? null : !!options.alreadySigned,
          HSDiKemViTriKy: [
            { MaViTri: 'NguoiGiaoHoSo', IsDaKy: !options.senderUnsigned },
            { MaViTri: 'NguoiNhanHoSo', IsDaKy: !!options.receiverSigned },
          ],
        },
        ...(options.adminMissing ? [] : [{
          Ten: ADMINISTRATIVE_NAME,
          IsDaKySo: !!options.adminAggregateSigned,
          HSDiKemViTriKy: options.adminPositions || [
            { MaViTri: 'BacSi', IsDaKy: !options.doctorUnsigned },
            { MaViTri: 'TruongKhoa', IsDaKy: !!options.headSigned },
          ],
        }]),
        ...(options.extraDocuments || []),
      ] });
    } else if (url.pathname.endsWith('/dieutri/bachoduyetky')) {
      calls.push('list');
      const index = Number(url.searchParams.get('pageIndex') || 1);
      if (options.malformedList) await route.fulfill({ json: { List: [{}], total: 1 } });
      else if (sent) await route.fulfill({ json: { List: [], total: 0 } });
      else await route.fulfill({
        json: { List: [{ Id: index === 1 ? OTHER_ID : ID }], total: 2 },
      });
    } else if (url.href === `${origin}/v2/`) {
      await route.fulfill({ contentType: 'text/html', body: `
        <meta charset="utf-8">
        <button title="Kiểm tra hồ sơ" id="check">Kiểm tra</button>
        <ul class="toc-list">
          <li id="medical-chart"><a href="#chart" title="${MEDICAL_CHART_NAME}">${MEDICAL_CHART_NAME}(chưa ký)</a></li>
          <li><a href="#document" title="${DOCUMENT_NAME}">${DOCUMENT_NAME}</a></li>
        </ul>
        <button title="${SIGN_TITLE}" id="sign">Ký</button>
        <button id="send" style="display:${options.alreadyAuthorized ? '' : 'none'}" ${options.iconSend ? 'title="Gửi ký hồ sơ" aria-label="Gửi"' : ''}>${options.iconSend ? '<i class="fa fa-paper-plane-o" style="font-size:15pt;"></i>' : 'Gửi ký hồ sơ'}</button>
        <div id="dialogs"></div>
        <script>
          localStorage.setItem('currentUser', JSON.stringify({Domain: '79415', access_token: 'fixture-token'}));
          window.actionSequence = [];
          document.querySelector('#medical-chart a').onclick = async () => {
            window.chartClicks = (window.chartClicks || 0) + 1;
            window.actionSequence.push('medical-chart');
            document.querySelector('#medical-chart').classList.add('active');
            const response = await fetch('/api/79415/hsdikembenhan/hsDiKem/${ID}');
            await response.json();
          };
          check.onclick = () => {
            window.checkClicks = (window.checkClicks || 0) + 1;
            dialogs.innerHTML = ${JSON.stringify(warning)};
            if (${!!options.cleanCheck}) {
              dialogs.querySelector('.modal-body').textContent = '-- Không có phiếu nào cần chỉnh sửa --';
            }
            dialogs.querySelector('button.btn-info').onclick = () => dialogs.innerHTML = '';
          };
          document.querySelector('ul.toc-list a[title="${DOCUMENT_NAME}"]').onclick = () => {
            window.documentClicks = (window.documentClicks || 0) + 1;
            window.actionSequence.push('handover');
          };
          sign.onclick = () => {
            window.signClicks = (window.signClicks || 0) + 1;
            dialogs.innerHTML = '<div class="modal-dialog"><h4>Xác nhận ký số!</h4><button id="confirmation-dialog-btn-accept">Đồng ý</button></div>';
            dialogs.querySelector('button').onclick = async () => {
              await window.markSigned();
              dialogs.innerHTML = '';
              if (!${!!options.sendNeverAppears}) {
                document.querySelector('#send').style.display = '';
              }
            };
          };
          send.onclick = () => {
            window.sendClicks = (window.sendClicks || 0) + 1;
            dialogs.innerHTML = ${JSON.stringify(sendModal)};
            dialogs.querySelector('.swal2-confirm').onclick = async () => {
              await window.markSent();
              dialogs.innerHTML = '';
            };
          };
        </script>` });
    } else {
      throw new Error(`Unexpected fixture request: ${url.href}`);
    }
  });
  await page.exposeFunction('markSigned', () => { signed = true; calls.push('sign-confirmed'); });
  await page.exposeFunction('markSent', () => { sent = true; calls.push('send-confirmed'); });
  await page.goto(`${origin}/v2/`);
  return { page, calls };
}

test('dedicated session path cannot default to the old account file', () => {
  assert.equal(STORAGE_STATE_PATH, path.join(__dirname, '..', 'storageState.director.json'));
});

test('login saves authenticated account only to the supplied session file', async (t) => {
  const { page } = await fixture(t);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'director-session-'));
  const file = path.join(directory, 'session.json');
  t.after(() => {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(directory);
  });
  await saveLoginSession(page.context(), page, file);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  const user = JSON.parse(saved.origins[0].localStorage.find((entry) => entry.name === 'currentUser').value);
  assert.equal(user.access_token, 'fixture-token');
  fs.unlinkSync(file);
  await page.evaluate(() => localStorage.removeItem('currentUser'));
  await assert.rejects(saveLoginSession(page.context(), page, file), /Chưa đăng nhập thành công/);
  assert.equal(fs.existsSync(file), false);
  await page.evaluate(() => localStorage.setItem('currentUser', JSON.stringify({
    Domain: '79415', access_token: ' ',
  })));
  await assert.rejects(saveLoginSession(page.context(), page, file), /Chưa đăng nhập thành công/);
  assert.equal(fs.existsSync(file), false);
});

test('another unsigned document blocks opening the target even if Kiểm tra would say clean', async (t) => {
  const { page } = await fixture(t, {
    cleanCheck: true,
    extraDocuments: [{ Ten: 'Bìa bệnh án', IsDaKySo: false }],
  });
  for (const execute of [false, true]) {
    const result = await signAndSend(page, { id: ID }, execute);
    assert.equal(result.status, 'skipped');
    assert.deepEqual(result.check.blockingDocuments, ['Bìa bệnh án']);
    assert.match(result.note, /Bìa bệnh án/);
  }
  assert.deepEqual(await page.evaluate(() => [
    window.documentClicks || 0, window.checkClicks || 0, window.signClicks || 0, window.sendClicks || 0,
  ]), [0, 0, 0, 0]);
  assert.equal(await page.evaluate(() => window.chartClicks), 2);
  assert.deepEqual(await page.evaluate(() => window.actionSequence), ['medical-chart', 'medical-chart']);
});

test('dry-run verifies exact sign control but never clicks sign/send', async (t) => {
  const { page } = await fixture(t);
  assert.equal((await signAndSend(page, { id: ID }, false)).status, 'test_ready');
  assert.deepEqual(await page.evaluate(() => [window.signClicks || 0, window.sendClicks || 0]), [0, 0]);
  assert.deepEqual(await page.evaluate(() => [window.documentClicks || 0, window.checkClicks || 0]), [0, 0]);
  assert.deepEqual(await page.evaluate(() => window.actionSequence), ['medical-chart']);
});

test('doctor signed and department head unsigned permits chart signing regardless of aggregate status', async (t) => {
  const { page } = await fixture(t, { adminAggregateSigned: true });
  const result = await signAndSend(page, { id: ID }, true);
  assert.equal(result.status, 'send_confirmed');
  assert.deepEqual(result.initialAdministrativeSignature, {
    doctorSigned: true, departmentHeadSigned: false,
  });
  assert.equal(result.postAdministrativeSignature, undefined);
  assert.deepEqual(await page.evaluate(() => window.actionSequence), ['medical-chart']);
  assert.deepEqual(await page.evaluate(() => [window.documentClicks || 0, window.signClicks, window.sendClicks]), [0, 1, 1]);
});

test('unsigned doctor or already signed department head prevents signing and sending', async (t) => {
  for (const options of [{ doctorUnsigned: true }, { headSigned: true },
    { doctorUnsigned: true, headSigned: true }]) {
    const { page } = await fixture(t, options);
    const result = await signAndSend(page, { id: ID }, true);
    assert.equal(result.status, 'skipped');
    assert.match(result.note, /Thông tin hành chính/);
    assert.deepEqual(await page.evaluate(() => [window.signClicks || 0, window.sendClicks || 0]), [0, 0]);
  }
});

test('missing or duplicate administrative document reports an error without signing', async (t) => {
  for (const options of [{ adminMissing: true }, {
    extraDocuments: [{ Ten: ADMINISTRATIVE_NAME, IsDaKySo: true }],
  }]) {
    const { page } = await fixture(t, options);
    await assert.rejects(signAndSend(page, { id: ID }, true), /đúng một mục Thông tin hành chính/);
    assert.deepEqual(await page.evaluate(() => [window.signClicks || 0, window.sendClicks || 0]), [0, 0]);
  }
});

test('API is checked before signing, then sending follows confirmation and button readiness without another document read', async (t) => {
  const { page, calls } = await fixture(t, { rejectDocumentsAfterSign: true, iconSend: true });
  const result = await signAndSend(page, { id: ID }, true);
  assert.equal(result.status, 'send_confirmed');
  assert.deepEqual(result.initialAdministrativeSignature, {
    doctorSigned: true, departmentHeadSigned: false,
  });
  assert.deepEqual(calls, ['documents', 'sign-confirmed', 'send-confirmed']);
  assert.deepEqual(await page.evaluate(() => window.actionSequence), ['medical-chart']);
  assert.deepEqual(await page.evaluate(() => [window.signClicks, window.sendClicks]), [1, 1]);
});

test('opens medical chart using visible name when title is absent', async (t) => {
  const { page } = await fixture(t);
  await page.locator('#medical-chart a').evaluate((anchor) => anchor.removeAttribute('title'));
  assert.equal((await signAndSend(page, { id: ID }, false)).status, 'test_ready');
  assert.deepEqual(await page.evaluate(() => window.actionSequence), ['medical-chart']);
});

test('ambiguous medical chart prevents any document inspection or signing', async (t) => {
  const { page } = await fixture(t);
  await page.locator('#medical-chart').evaluate((item) => item.after(item.cloneNode(true)));
  await assert.rejects(signAndSend(page, { id: ID }, true), /Không xác định duy nhất mục Phiếu bệnh án/);
  assert.deepEqual(await page.evaluate(() => window.actionSequence), []);
  assert.deepEqual(await page.evaluate(() => [window.signClicks || 0, window.sendClicks || 0]), [0, 0]);
});

test('administrative false is allowed together with target false and other true statuses', async (t) => {
  const { page } = await fixture(t, {
    extraDocuments: [
      { Ten: 'Bìa bệnh án', IsDaKySo: true },
    ],
  });
  const result = await signAndSend(page, { id: ID }, true);
  assert.equal(result.status, 'send_confirmed');
  assert.deepEqual(result.check.unsignedDocuments, [DOCUMENT_NAME, 'Thông tin hành chính']);
});

test('nullable non-target API entries allow dry-run and verified signing', async (t) => {
  const { page } = await fixture(t, {
    extraDocuments: [{ Ten: 'Phiếu kết quả Huyết học', IsDaKySo: null, IsDaKy: true }],
  });
  assert.equal((await signAndSend(page, { id: ID }, false)).status, 'test_ready');
  assert.equal((await signAndSend(page, { id: ID }, true)).status, 'send_confirmed');
  assert.deepEqual(await page.evaluate(() => [window.signClicks, window.sendClicks]), [1, 1]);
  assert.deepEqual(await page.evaluate(() => window.actionSequence), ['medical-chart', 'medical-chart']);
  assert.equal(await page.evaluate(() => window.documentClicks || 0), 0);
});

test('unknown target signature status cannot trigger signing or sending', async (t) => {
  const { page } = await fixture(t, { targetUnknown: true });
  await assert.rejects(signAndSend(page, { id: ID }, true), /chưa có trạng thái/);
  assert.deepEqual(await page.evaluate(() => [window.signClicks || 0, window.sendClicks || 0]), [0, 0]);
});

test('exact accessible button name also works without title', async (t) => {
  const { page } = await fixture(t);
  await page.locator('#sign').evaluate((button, title) => {
    button.removeAttribute('title');
    button.textContent = title;
  }, SIGN_TITLE);
  assert.equal((await signAndSend(page, { id: ID }, false)).status, 'test_ready');
});

test('signing verifies API state then confirms exact saved send modal and verifies list absence', async (t) => {
  const { page, calls } = await fixture(t);
  assert.equal((await signAndSend(page, { id: ID }, true)).status, 'send_confirmed');
  assert.deepEqual(await page.evaluate(() => [window.signClicks, window.sendClicks]), [1, 1]);
  assert.equal(calls.filter((call) => call === 'documents').length, 1);
  assert.equal(await isRecordInList(page, 'https://bvrhm.hosoyte.com/api/79415/dieutri/bachoduyetky', ID), false);
});

test('already signed document does not sign or send again', async (t) => {
  const { page } = await fixture(t, { alreadySigned: true });
  assert.equal((await signAndSend(page, { id: ID }, true)).status, 'skipped');
  assert.deepEqual(await page.evaluate(() => [window.signClicks || 0, window.sendClicks || 0]), [0, 0]);
});

test('sender signature permits sending while aggregate document status remains false', async (t) => {
  const { page, calls } = await fixture(t, { iconSend: true });
  const result = await signAndSend(page, { id: ID }, true);
  assert.equal(result.status, 'send_confirmed');
  assert.deepEqual(result.initialSignature, { senderSigned: true, receiverSigned: false });
  assert.deepEqual(result.check.unsignedDocuments, [DOCUMENT_NAME, ADMINISTRATIVE_NAME]);
  assert.deepEqual(await page.evaluate(() => [window.signClicks, window.sendClicks]), [1, 1]);
  assert.equal(calls.filter((call) => call === 'documents').length, 1);
  assert.equal(result.signedThisRun, true);
});

test('existing send button permits sending without signing authorization again', async (t) => {
  const { page } = await fixture(t, { alreadyAuthorized: true, iconSend: true });
  await page.locator('#sign').evaluate((button) => button.remove());
  const result = await signAndSend(page, { id: ID }, true);
  assert.equal(result.status, 'send_confirmed');
  assert.equal(result.signedThisRun, false);
  assert.deepEqual(await page.evaluate(() => [window.signClicks || 0, window.sendClicks || 0]), [0, 1]);
});

test('dry-run with existing send button never signs or sends', async (t) => {
  const { page } = await fixture(t, { alreadyAuthorized: true, iconSend: true });
  const result = await signAndSend(page, { id: ID }, false);
  assert.equal(result.status, 'test_ready');
  assert.equal(result.sendReady, true);
  assert.deepEqual(await page.evaluate(() => [window.signClicks || 0, window.sendClicks || 0]), [0, 0]);
});

test('confirmation alone cannot send when send button never appears', async (t) => {
  const { page, calls } = await fixture(t, { sendNeverAppears: true });
  await assert.rejects(signAndSend(page, { id: ID }, true), /nút Gửi ký hồ sơ chưa xuất hiện/);
  assert.deepEqual(await page.evaluate(() => [window.signClicks || 0, window.sendClicks || 0]), [1, 0]);
  assert.equal(calls.filter((call) => call === 'documents').length, 1);
});

test('disabled existing send button cannot trigger signing or sending', async (t) => {
  const { page } = await fixture(t, { alreadyAuthorized: true, iconSend: true });
  await page.locator('#send').evaluate((button) => { button.disabled = true; });
  await assert.rejects(signAndSend(page, { id: ID }, true), /Không có duy nhất nút Gửi ký hồ sơ/);
  assert.deepEqual(await page.evaluate(() => [window.signClicks || 0, window.sendClicks || 0]), [0, 0]);
});

test('receiver signed without sender prevents signing and sending', async (t) => {
  const { page } = await fixture(t, { receiverSigned: true, senderUnsigned: true });
  assert.equal((await signAndSend(page, { id: ID }, true)).status, 'skipped');
  assert.deepEqual(await page.evaluate(() => [window.signClicks || 0, window.sendClicks || 0]), [0, 0]);
});

test('unsigned sender prevents authorization signing and sending', async (t) => {
  const { page } = await fixture(t, { senderUnsigned: true });
  assert.equal((await signAndSend(page, { id: ID }, true)).status, 'skipped');
  assert.deepEqual(await page.evaluate(() => [window.signClicks || 0, window.sendClicks || 0]), [0, 0]);
});

test('receiver already signed prevents authorization signing and sending', async (t) => {
  const { page } = await fixture(t, { receiverSigned: true });
  assert.equal((await signAndSend(page, { id: ID }, true)).status, 'skipped');
  assert.deepEqual(await page.evaluate(() => [window.signClicks || 0, window.sendClicks || 0]), [0, 0]);
});

test('icon-only send button appearing after signing is found by its exact title', async (t) => {
  const { page } = await fixture(t, { iconSend: true });
  assert.equal(await page.locator('#send').isVisible(), false);
  assert.equal((await signAndSend(page, { id: ID }, true)).status, 'send_confirmed');
  assert.deepEqual(await page.evaluate(() => [window.signClicks, window.sendClicks]), [1, 1]);
});

test('multiple visible send buttons prevent signing and sending', async (t) => {
  const { page } = await fixture(t, { iconSend: true });
  await page.evaluate(() => {
    const duplicate = document.createElement('button');
    duplicate.title = 'Gửi ký hồ sơ';
    document.body.append(duplicate);
  });
  await page.locator('#send').evaluate((button) => { button.style.display = ''; });
  await assert.rejects(signAndSend(page, { id: ID }, true), /Không có duy nhất nút Gửi ký hồ sơ/);
  assert.deepEqual(await page.evaluate(() => [window.signClicks || 0, window.sendClicks || 0]), [0, 0]);
});

test('hidden send buttons do not make the visible icon button ambiguous', async (t) => {
  const { page } = await fixture(t, { iconSend: true });
  await page.evaluate(() => {
    const hidden = document.createElement('button');
    hidden.title = 'Gửi ký hồ sơ';
    hidden.style.display = 'none';
    document.body.append(hidden);
  });
  assert.equal((await signAndSend(page, { id: ID }, true)).status, 'send_confirmed');
  assert.deepEqual(await page.evaluate(() => [window.signClicks, window.sendClicks]), [1, 1]);
});

test('warning modal cannot be accepted as sign or send confirmation', async (t) => {
  const { page } = await fixture(t);
  await page.locator('#check').click();
  await assert.rejects(acceptAction(page, 'sign'), /không đúng thao tác/);
  await assert.rejects(acceptAction(page, 'send'), /không đúng thao tác/);
  assert.equal(await page.locator('.modal-dialog').count(), 1);
});

test('send confirmation titled warning for KHTH is accepted, missing-signature warning is not', async (t) => {
  const { page } = await fixture(t);
  await page.evaluate(() => {
    dialogs.innerHTML = '<div class="modal-dialog"><h4>Cảnh báo</h4><span>×</span>' +
      '<p>Bạn xác nhận gửi Gửi KHTH bệnh án này?</p>' +
      '<button id="confirmation-dialog-btn-accept">Đồng ý</button><button>Thoát</button></div>';
    dialogs.querySelector('#confirmation-dialog-btn-accept').onclick = () => {
      window.khthAccepted = true;
      dialogs.innerHTML = '';
    };
  });
  await acceptAction(page, 'send');
  assert.equal(await page.evaluate(() => window.khthAccepted), true);

  await page.evaluate(() => {
    dialogs.innerHTML = '<div class="modal-dialog"><h4>Cảnh báo</h4>' +
      '<p>Phiếu chưa hoàn thành ký: thiếu chữ ký. Bạn xác nhận gửi Gửi KHTH bệnh án này?</p>' +
      '<button id="confirmation-dialog-btn-accept">Đồng ý</button></div>';
  });
  await assert.rejects(acceptAction(page, 'send'), /không đúng thao tác/);
  assert.equal(await page.locator('.modal-dialog').count(), 1);
});

test('verification checks all API pages and rejects malformed record IDs', async (t) => {
  const { page, calls } = await fixture(t);
  const url = 'https://bvrhm.hosoyte.com/api/79415/dieutri/bachoduyetky?department=selected';
  assert.equal(await isRecordInList(page, url, ID), true);
  assert.equal(calls.filter((call) => call === 'list').length, 2);
  const malformed = await fixture(t, { malformedList: true });
  await assert.rejects(isRecordInList(malformed.page, url, ID), /ID hồ sơ hợp lệ/);
});

test('refresh clicks the exact search button and waits for the list API', async (t) => {
  const { page, calls } = await fixture(t);
  await page.evaluate(() => {
    document.body.innerHTML = '<button class="btn btn-success btn-sm" id="s"><i class="fa fa fa-search"></i></button>' +
      '<button class="btn btn-success btn-sm"><i class="fa fa-plus"></i></button>' +
      '<table><tbody id="tblBenhNhan"></tbody></table>';
    document.querySelector('#s').onclick = () => fetch('/api/79415/dieutri/bachoduyetky?pageIndex=1');
  });
  const before = calls.filter((call) => call === 'list').length;
  await refreshList(page);
  assert.equal(calls.filter((call) => call === 'list').length, before + 1);
  await page.evaluate(() => { document.querySelector('#s').remove(); });
  await assert.rejects(refreshList(page), /nút tìm kiếm/);
});

test('pagination snapshots every page and finds records after page shifts', async (t) => {
  const { page } = await fixture(t);
  await page.evaluate(({ id, otherId }) => {
    document.body.innerHTML = `
      <table><tbody id="tblBenhNhan"></tbody></table>
      <ngb-pagination><ul>
        <li><a aria-label="First">First</a></li>
        <li><a aria-label="Next">Next</a></li>
      </ul></ngb-pagination>`;
    window.pageIndex = 1;
    window.render = () => {
      const currentId = window.pageIndex === 1 ? otherId : id;
      document.querySelector('#tblBenhNhan').innerHTML =
        '<tr><td><a href="#/view/HSBA/HsBenhAn/' + currentId + '/HSBA%2FDsBenhAnChoKy">Test</a></td></tr>';
      document.querySelector('[aria-label="First"]').setAttribute('aria-disabled', String(window.pageIndex === 1));
      document.querySelector('[aria-label="Next"]').setAttribute('aria-disabled', String(window.pageIndex === 2));
    };
    for (const link of document.querySelectorAll('ngb-pagination a')) {
      link.onclick = async () => {
        window.pageIndex = link.getAttribute('aria-label') === 'First' ? 1 : 2;
        await fetch('/api/79415/dieutri/bachoduyetky?pageIndex=' + window.pageIndex);
        window.render();
      };
    }
    window.render();
  }, { id: ID, otherId: OTHER_ID });
  assert.deepEqual((await collectRecords(page, 0)).map((record) => record.id), [OTHER_ID, ID]);
  assert.deepEqual((await collectRecords(page, 1)).map((record) => record.id), [OTHER_ID]);
});
