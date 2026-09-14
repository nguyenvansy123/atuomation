const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const STORAGE_STATE_PATH = path.join(__dirname, "storageState.json");

const TARGET_URL =
  "https://bvrhm.hosoyte.com/v2/#/HSBA/DsBenhAnChoKy?TrangThai=ChoDuyet";

const LOGIN_URL = "https://bvrhm.hosoyte.com/v2/";

const API_ORIGIN = "https://bvrhm.hosoyte.com";

// ============================================================
// ĐỌC ACCESS TOKEN
// ============================================================

function getAccessTokenFromStorageState() {
  try {
    if (!fs.existsSync(STORAGE_STATE_PATH)) {
      return null;
    }

    const raw = fs.readFileSync(STORAGE_STATE_PATH, "utf8");

    const state = JSON.parse(raw);

    const origin = (state.origins || []).find(
      (item) => item.origin === API_ORIGIN,
    );

    const currentUser = (origin?.localStorage || []).find(
      (item) => item.name === "currentUser",
    );

    if (!currentUser?.value) {
      return null;
    }

    const parsed = JSON.parse(currentUser.value);

    return parsed?.access_token || null;
  } catch (error) {
    console.error("Không đọc được token từ storageState.json:", error.message);

    return null;
  }
}

// ============================================================
// KIỂM TRA LOGIN
// ============================================================

async function ensureLoggedIn(page, tokenFromFile) {
  const currentUserFromPage = await page.evaluate(() => {
    try {
      const raw = localStorage.getItem("currentUser");

      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return null;
    }
  });

  if (currentUserFromPage?.access_token || tokenFromFile) {
    console.log("Session đã có sẵn.");

    return;
  }

  console.log("Chưa có session hợp lệ.");

  console.log("Mở trang đăng nhập để bạn login thủ công...");

  await page.goto(LOGIN_URL, {
    waitUntil: "domcontentloaded",
    timeout: 120000,
  });

  console.log("Sau khi đăng nhập xong, nhấn Enter trong terminal để tiếp tục.");

  await new Promise((resolve) => {
    process.stdin.once("data", () => resolve());
  });
}

function readCurrentUserFromStorageState() {
  try {
    if (!fs.existsSync(STORAGE_STATE_PATH)) {
      return null;
    }

    const raw = fs.readFileSync(STORAGE_STATE_PATH, "utf8");
    const state = JSON.parse(raw);
    const origin = (state.origins || []).find(
      (item) => item.origin === API_ORIGIN,
    );
    const currentUser = (origin?.localStorage || []).find(
      (item) => item.name === "currentUser",
    );

    if (!currentUser?.value) {
      return null;
    }

    return JSON.parse(currentUser.value);
  } catch (error) {
    return null;
  }
}

async function isConfirmModalVisible(page) {
  const selectors = [
    "#confirmation-dialog-btn-accept",
    "app-confirmation-dialog",
    "app-confirmation-dialog button",
    ".modal.show",
    ".modal",
    '[role="dialog"]',
    ".cdk-overlay-pane",
  ];

  for (const selector of selectors) {
    const modal = page.locator(selector).first();
    if ((await modal.count()) === 0) continue;

    const text = await modal.textContent().catch(() => "");
    const visible = await modal.isVisible().catch(() => false);

    if (visible) return true;
    if (
      text &&
      /xác nhận|xac nhan|confirm|đồng ý|dong y|ký file|ky file/i.test(text)
    )
      return true;
  }

  return false;
}

async function clickOutsideModal(page) {
  const backdrop = page
    .locator(".modal-backdrop, .cdk-overlay-backdrop")
    .first();
  if ((await backdrop.count()) > 0) {
    try {
      await backdrop.click({ force: true, timeout: 3000 });
      await page.waitForTimeout(500);
      if (!(await isConfirmModalVisible(page))) return true;
    } catch (error) {
      console.warn("Không click được backdrop:", error.message);
    }
  }

  const viewport = page.viewportSize() || { width: 1280, height: 800 };
  const points = [
    { x: 5, y: 5 },
    { x: viewport.width - 5, y: 5 },
    { x: 5, y: viewport.height - 5 },
    { x: viewport.width - 5, y: viewport.height - 5 },
  ];

  for (const point of points) {
    try {
      await page.mouse.click(point.x, point.y);
      await page.waitForTimeout(500);
      if (!(await isConfirmModalVisible(page))) return true;
    } catch (error) {
      console.warn("Click ngoài modal lỗi:", error.message);
    }
  }

  try {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    if (!(await isConfirmModalVisible(page))) return true;
  } catch (error) {
    console.warn("Escape không hoạt động:", error.message);
  }

  return false;
}

async function isSignatureGlyphAlreadyPlaced(page) {
  const selectors = [
    'button[title="Ký số"]',
    'button[title*="Ký số" i]',
  ];

  for (const selector of selectors) {
    const buttons = page.locator(selector);
    const count = await buttons.count();

    for (let i = 0; i < count; i += 1) {
      const info = await buttons.nth(i).evaluate((el) => {
        const style = window.getComputedStyle(el);
        const text = (el.textContent || "").trim();
        const title = (el.getAttribute("title") || "").trim();
        const isGlyph = /✍️|✍/u.test(text);
        const isPositioned =
          style.position === "absolute" &&
          style.left !== "auto" &&
          style.top !== "auto" &&
          Number.parseFloat(style.width || "0") > 0 &&
          Number.parseFloat(style.height || "0") > 0;

        return {
          title,
          text,
          isGlyph,
          isPositioned,
          left: style.left,
          top: style.top,
          width: style.width,
          height: style.height,
        };
      });

      if (info?.isGlyph && info?.isPositioned) {
        console.log(
          "[isSignatureGlyphAlreadyPlaced] phát hiện nút ký số đã đặt vị trí:",
          info,
        );
        return true;
      }
    }
  }

  return false;
}

async function clickConfirmSignModal(page) {
  const selectors = [
    "#confirmation-dialog-btn-accept",
    "button:has-text(\"Đồng ý\")",
    "button:has-text(\"Xác nhận\")",
    "button:has-text(\"Confirm\")",
    "button:has-text(\"OK\")",
    "button:has-text(\"Ký File\")",
    "button:has-text(\"Ky File\")",
    "app-confirmation-dialog button",
    ".modal button",
  ];

  for (const selector of selectors) {
    const button = page.locator(selector).first();
    if ((await button.count()) === 0) continue;

    try {
      await button.scrollIntoViewIfNeeded();
      await button.click({ timeout: 8000, force: true });
      await page.waitForTimeout(1500);
      return !(await isConfirmModalVisible(page));
    } catch (error) {
      console.warn("[clickConfirmSignModal] click selector lỗi:", selector, error.message);
    }
  }

  const candidate = page
    .locator("button")
    .filter({ hasText: /đồng ý|dong y|xác nhận|xac nhan|confirm|ok|ký file|ky file/i })
    .first();

  if ((await candidate.count()) > 0) {
    try {
      await candidate.scrollIntoViewIfNeeded();
      await candidate.click({ timeout: 8000, force: true });
      await page.waitForTimeout(1500);
      return !(await isConfirmModalVisible(page));
    } catch (error) {
      console.warn("[clickConfirmSignModal] click fallback lỗi:", error.message);
    }
  }

  return false;
}

async function evaluateSidebarStateForDetail(page) {
  const isReady = await page
    .waitForFunction(
      () => {
        const anchors = Array.from(
          document.querySelectorAll("ul.toc-list li a"),
        );
        return anchors.some((anchor) => {
          const title = (anchor.getAttribute("title") || "").trim();
          const text = (anchor.textContent || "").replace(/\s+/g, " ").trim();
          return (
            title.includes("Phiếu giao nhận hồ sơ bệnh án") ||
            text.includes("Phiếu giao nhận hồ sơ bệnh án")
          );
        });
      },
      { timeout: 20000 },
    )
    .catch(() => false);

  if (!isReady) {
    return { hasUnsign: false, totalUnsignCount: 0 };
  }

  return await page.evaluate(() => {
    const lists = Array.from(
      document.querySelectorAll("ul.toc-list li"),
    ).filter((li) => !li.hasAttribute("hidden"));
    const items = lists
      .map((listItem) => {
        const anchor = listItem.querySelector("a");
        if (!anchor) return null;

        const title = (anchor.getAttribute("title") || "").trim();
        const text = (anchor.textContent || "").replace(/\s+/g, " ").trim();
        const hasUnsigned =
          /chưa ký|chua ky/i.test(text) || /chưa ký|chua ky/i.test(title);
        const anchorCount = listItem.querySelectorAll("a").length;
        const isRequired =
          text.includes("Phiếu giao nhận hồ sơ bệnh án") ||
          title.includes("Phiếu giao nhận hồ sơ bệnh án") ||
          (anchor.getAttribute("title") || "").includes(
            "Phiếu giao nhận hồ sơ bệnh án",
          );

        return { text, anchorCount, hasUnsigned, isRequired };
      })
      .filter(Boolean);

    const requiredUnsign = items.filter(
      (item) => item.hasUnsigned && item.isRequired && item.anchorCount === 1,
    );
    return {
      hasUnsign: requiredUnsign.length > 0,
      totalUnsignCount: requiredUnsign.length,
      listUnsign: requiredUnsign.map((item) => item.text),
    };
  });
}

async function debugImageTargetForModal(page) {
  const patientCodeSelector = 'span[role="presentation"][dir="ltr"]';
  const targetSelector = "img#imageid, img.ui-draggable.ui-draggable-handle";

  const targetCount = await page.locator(targetSelector).count();

  const debug = await page.evaluate(
    ({ targetSelector, patientCodeSelector }) => {
      const targetFound = Array.from(document.querySelectorAll(targetSelector));
      const patientCodeSpans = Array.from(
        document.querySelectorAll(patientCodeSelector),
      )
        .filter((span) =>
          /Mã hồ sơ bệnh án:/i.test((span.textContent || "").trim()),
        )
        .map((span) => ({
          text: span.textContent,
          style: {
            left: span.style.left,
            top: span.style.top,
            fontSize: span.style.fontSize,
            transform: span.style.transform,
          },
        }));

      const imgInfo = targetFound.map((image) => {
        const rect = image.getBoundingClientRect();
        return {
          src: image.getAttribute("src"),
          id: image.id,
          className: image.className,
          style: {
            top: image.style.top,
            left: image.style.left,
            position: image.style.position,
            zIndex: image.style.zIndex,
            visibility: image.style.visibility,
          },
          rect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
        };
      });

      return {
        targetSelector,
        targetCount: targetFound.length,
        patientCodeSpans,
        imgInfo,
      };
    },
    { targetSelector, patientCodeSelector },
  );

  console.log(
    "[debugImageTargetForModal] debug result:",
    JSON.stringify(debug, null, 2),
  );

  if (targetCount === 0) {
    console.warn(
      "[debugImageTargetForModal] Không tìm thấy thẻ img. Dừng flow.",
    );
    return { ok: false, debug };
  }

  return { ok: true, debug };
}

// ============================================================
// SO SÁNH VỊ TRÍ ẢNH TRƯỚC / SAU KHI CLICK
// (được thêm để trả lời câu hỏi: click đơn có đủ để "đặt" ảnh chữ ký
//  vào đúng vị trí, hay bắt buộc phải kéo-thả (drag) thật sự)
// ============================================================

function extractImagePosition(debug) {
  const img = debug?.imgInfo?.[0];
  if (!img) return null;

  return {
    styleLeft: img.style?.left || null,
    styleTop: img.style?.top || null,
    // rect.x/rect.y đáng tin hơn style.left/top vì đọc trực tiếp vị trí thật
    // trên màn hình (getBoundingClientRect), không phụ thuộc ảnh có set
    // style inline hay không (ví dụ nếu vị trí được set qua transform/CSS class).
    rectX: img.rect?.x ?? null,
    rectY: img.rect?.y ?? null,
  };
}

function positionsAreEqual(a, b) {
  if (!a || !b) return false;
  const round = (n) => (typeof n === "number" ? Math.round(n) : n);
  return (
    a.styleLeft === b.styleLeft &&
    a.styleTop === b.styleTop &&
    round(a.rectX) === round(b.rectX) &&
    round(a.rectY) === round(b.rectY)
  );
}

/**
 * Chụp vị trí ảnh chữ ký TRƯỚC khi click, thực hiện click vào vị trí ngay dưới
 * nhãn "Người nhận hồ sơ" (đúng bước 5 trong luồng bạn mô tả), rồi chụp lại vị
 * trí SAU khi click — so sánh xem có thay đổi hay không.
 *
 * Kết quả `moved: true`  => click đơn là đủ để đặt ảnh, không cần kéo-thả.
 * Kết quả `moved: false` => click không có tác dụng di chuyển ảnh, cần thay
 *                           bằng chuỗi mouse.down() -> move() -> up() (kéo-thả thật).
 */
async function verifySignatureClickMovesImage(page, receiverLabel) {
  console.log("[verifySignatureClickMovesImage] Đang chụp vị trí ảnh TRƯỚC khi click...");
  const beforeResult = await debugImageTargetForModal(page);
  const beforePos = extractImagePosition(beforeResult.debug);
  console.log("[verifySignatureClickMovesImage] Vị trí TRƯỚC:", beforePos);

  if (!beforeResult.ok) {
    console.warn("[verifySignatureClickMovesImage] Không tìm thấy ảnh TRƯỚC khi click — dừng so sánh.");
    return { ok: false, reason: "no_image_before_click", beforePos, afterPos: null, moved: false };
  }

  console.log("[verifySignatureClickMovesImage] Đang click vào vị trí dưới 'Người nhận hồ sơ'...");
  const clicked = await clickSignaturePosition(page, receiverLabel);
  if (!clicked) {
    console.warn("[verifySignatureClickMovesImage] Click thất bại, không thể so sánh.");
    return { ok: false, reason: "click_failed", beforePos, afterPos: null, moved: false };
  }

  // Đợi 1 chút phòng trường hợp trang cần thời gian re-render sau click
  // trước khi vị trí ảnh (nếu có đổi) phản ánh đầy đủ trong DOM.
  await page.waitForTimeout(1000);

  console.log("[verifySignatureClickMovesImage] Đang chụp vị trí ảnh SAU khi click...");
  const afterResult = await debugImageTargetForModal(page);
  const afterPos = extractImagePosition(afterResult.debug);
  console.log("[verifySignatureClickMovesImage] Vị trí SAU:", afterPos);

  if (!afterResult.ok) {
    console.warn("[verifySignatureClickMovesImage] Ảnh biến mất sau khi click (có thể đã được áp dụng và ẩn đi).");
    return {
      ok: true,
      beforePos,
      afterPos: null,
      moved: true,
      note: "image_disappeared_after_click_likely_applied",
    };
  }

  const unchanged = positionsAreEqual(beforePos, afterPos);
  const moved = !unchanged;

  console.log(
    moved
      ? "[verifySignatureClickMovesImage] ✅ Vị trí ảnh ĐÃ THAY ĐỔI sau khi click — click đơn thuần là đủ."
      : "[verifySignatureClickMovesImage] ❌ Vị trí ảnh KHÔNG đổi sau khi click — cần dùng kéo-thả (drag) thay vì click."
  );

  return {
    ok: true,
    beforePos,
    afterPos,
    moved,
    beforeDebug: beforeResult.debug,
    afterDebug: afterResult.debug,
  };
}

async function addClickMarker(page, x, y, label = "click") {
  await page.evaluate(
    ({ x, y, label }) => {
      const root = document.getElementById("__auto_click_marker_root") || (() => {
        const el = document.createElement("div");
        el.id = "__auto_click_marker_root";
        el.style.position = "fixed";
        el.style.left = "0";
        el.style.top = "0";
        el.style.width = "100vw";
        el.style.height = "100vh";
        el.style.pointerEvents = "none";
        el.style.zIndex = "2147483647";
        document.body.appendChild(el);
        return el;
      })();

      const marker = document.createElement("button");
      marker.type = "button";
      marker.textContent = label;
      marker.style.position = "fixed";
      marker.style.left = `${x}px`;
      marker.style.top = `${y}px`;
      marker.style.transform = "translate(-50%, -50%)";
      marker.style.minWidth = "28px";
      marker.style.height = "28px";
      marker.style.border = "2px solid #ef4444";
      marker.style.borderRadius = "999px";
      marker.style.background = "#fee2e2";
      marker.style.color = "#991b1b";
      marker.style.fontSize = "10px";
      marker.style.fontWeight = "700";
      marker.style.padding = "0 8px";
      marker.style.boxShadow = "0 4px 12px rgba(0,0,0,0.2)";
      marker.style.cursor = "default";
      marker.style.pointerEvents = "none";
      marker.style.zIndex = "2147483648";
      root.appendChild(marker);

      setTimeout(() => {
        marker.remove();
      }, 2200);
    },
    { x, y, label },
  );
}

async function clickLocatorByMouse(page, locator, options = {}) {
  const {
    offsetX = 0.5,
    offsetY = 0.5,
    moveBeforeClick = true,
    waitAfterClick = 500,
    label = "click",
  } = options;

  if (!locator) {
    console.warn("[clickLocatorByMouse] locator không tồn tại");

    return false;
  }

  try {
    await locator.scrollIntoViewIfNeeded();

    const box = await locator.boundingBox();

    if (!box) {
      console.warn("[clickLocatorByMouse] Không lấy được boundingBox");

      return false;
    }

    const x = box.x + box.width * offsetX;
    const y = box.y + box.height * offsetY;

    const hit = await page.evaluate(
      ({ x, y }) => {
        const el = document.elementFromPoint(x, y);

        return {
          tag: el?.tagName || null,
          id: el?.id || null,
          className: typeof el?.className === "string" ? el.className : "",
          text: el?.textContent?.trim().slice(0, 100) || "",
        };
      },
      { x, y },
    );

    console.log(
      "[clickLocatorByMouse] locator:",
      await locator.evaluate((el) => ({
        tag: el.tagName,
        id: el.id,
        className: el.className,
        text: el.textContent?.trim().slice(0, 100),
      })),
    );

    console.log("[clickLocatorByMouse] tọa độ:", {
      x,
      y,
      width: box.width,
      height: box.height,
      offsetX,
      offsetY,
    });

    console.log("[clickLocatorByMouse] element dưới chuột:", hit);

    if (moveBeforeClick) {
      await page.mouse.move(x, y, { steps: 10 });
    }

    await page.mouse.click(x, y);
    await addClickMarker(page, x, y, label);
    await page.waitForTimeout(waitAfterClick);

    return true;
  } catch (error) {
    console.warn("[clickLocatorByMouse] lỗi:", error.message);

    return false;
  }
}

// ĐIỀU CHỈNH VỊ TRÍ CLICK KÝ TẠI ĐÂY nếu ảnh chữ ký bị lệch so với vị trí mong
// muốn sau khi thả. Âm (-) dịch sang trái/lên trên, dương (+) dịch sang phải/xuống dưới.
// Ví dụ: ảnh đang lệch sang phải khoảng 40px -> đặt SIGNATURE_OFFSET_X = -40.
const SIGNATURE_OFFSET_X = -80;
const SIGNATURE_OFFSET_Y = 20;

async function clickSignaturePosition(page, receiverLabel) {
  try {
    await receiverLabel.scrollIntoViewIfNeeded();

    const box = await receiverLabel.boundingBox();

    if (!box) {
      console.log("[Signature] Không lấy được vị trí Người nhận hồ sơ");
      return false;
    }

    const x = box.x + box.width / 2 + SIGNATURE_OFFSET_X;
    const y = box.y + box.height + SIGNATURE_OFFSET_Y;

    console.log("[Signature] Click vị trí:", { x, y, offsetX: SIGNATURE_OFFSET_X, offsetY: SIGNATURE_OFFSET_Y });

    await page.mouse.move(x, y, { steps: 10 });
    await page.mouse.click(x, y);
    await addClickMarker(page, x, y, "signature");
    await page.waitForTimeout(1000);

    return true;
  } catch (error) {
    console.log("[Signature] Lỗi:", error.message);
    return false;
  }
}

async function selectPageOption(page, value = "1") {
  try {
    const pageSelect = page.locator('select[name="page"]').first();
    if ((await pageSelect.count()) === 0) {
      console.warn('[selectPageOption] Không tìm thấy thẻ select[name="page"].');
      return false;
    }

    await pageSelect.scrollIntoViewIfNeeded().catch(() => {});
    const selected = await pageSelect.selectOption(value).catch((error) => {
      console.warn("[selectPageOption] selectOption lỗi:", error.message);
      return null;
    });

    if (!selected) {
      return false;
    }

    console.log(`[selectPageOption] Đã chọn option "${value}" cho select[name="page"].`);
    await page.waitForTimeout(1500);
    await page
      .waitForLoadState("networkidle", { timeout: 30000 })
      .catch(() => {});
    return true;
  } catch (error) {
    console.warn("[selectPageOption] Lỗi:", error.message);
    return false;
  }
}

async function clickReceiverSignerFallback(page) {
  const quickSigner = page
    .locator('button[title="Ký số"]')
    .filter({ hasText: "✍️" })
    .first();
  if ((await quickSigner.count()) > 0) {
    try {
      await quickSigner.click({ timeout: 10000 });
      return true;
    } catch (error) {
      console.warn("Nút ký số biểu tượng click lỗi:", error.message);
    }
  }

  const receiverLabel = page
    .locator("span")
    .filter({ hasText: /^Người nhận hồ sơ$/i })
    .first();
  if ((await receiverLabel.count()) > 0) {
    const clicked = await clickSignaturePosition(page, receiverLabel);

    if (clicked) {
      return true;
    }
  }

  return false;
}

async function submitSignedRecordToManager(
  context,
  recordId,
  token,
  userId,
  domain,
) {
  if (!recordId) {
    return { ok: false, reason: "missing_record_id" };
  }

  if (!userId) {
    return { ok: false, reason: "missing_user_id" };
  }

  const url = `https://bvrhm.hosoyte.com/api/${domain}/dieutri//${recordId}/guitruongkhoa?idBenhAn=${recordId}&idCanBo=${userId}&action=4`;

  try {
    const response = await context.request.fetch(url, {
      method: "DELETE",
      headers: {
        authorization: token ? `Bearer ${token}` : undefined,
        "Content-Type": "application/json",
      },
    });

    const text = await response.text();
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch (error) {}

    if (!response.ok()) {
      return { ok: false, status: response.status(), body: parsed };
    }

    return { ok: true, status: response.status(), body: parsed };
  } catch (error) {
    return { ok: false, reason: "request_failed", error: error.message };
  }
}

async function signRecordById(page, context, recordId) {
  const detailUrl = `https://bvrhm.hosoyte.com/v2/#/view/HSBA/HsBenhAn/${encodeURIComponent(recordId)}/HSBA%2FDsBenhAnChoKy`;

  const savedUser = readCurrentUserFromStorageState();
  const userId = savedUser?.id || savedUser?.Id || savedUser?.userId || null;
  const domain = savedUser?.Domain || "79415";
  const token = savedUser?.access_token || null;

  await page.goto(detailUrl, {
    waitUntil: "domcontentloaded",
    timeout: 120000,
  });

  await page.waitForTimeout(8000);
  await page
    .waitForLoadState("networkidle", { timeout: 120000 })
    .catch(() => {});

  const docLink = page
    .getByText("Phiếu giao nhận hồ sơ bệnh án", { exact: false })
    .first();
  if ((await docLink.count()) === 0) {
    return { ok: false, reason: "missing_required_doc" };
  }

  await docLink.click({ timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(8000);
  await page
    .waitForLoadState("networkidle", { timeout: 120000 })
    .catch(() => {});

  const senderSigner = page
    .locator(
      'button[title*="ký người giao hồ sơ" i], button[title*="ky nguoi giao ho so" i]',
    )
    .first();
  if ((await senderSigner.count()) > 0) {
    return { ok: false, reason: "sender_signer_present" };
  }

  const glyphReceiverSigner = page
    .locator('button[title="Ký số"]')
    .filter({ hasText: "✍️" })
    .first();
  const receiverSigner = page
    .locator(
      'button[title*="Ký số Người nhận hồ sơ" i], button[title*="Ký số người nhận hồ sơ" i], button[title*="ký số người nhận hồ sơ" i]',
    )
    .first();

  if ((await glyphReceiverSigner.count()) > 0) {
    await glyphReceiverSigner.click({ timeout: 10000 });
  } else if ((await receiverSigner.count()) > 0) {
    await receiverSigner.click({ timeout: 10000 });
  } else {
    const fallbackWorked = await clickReceiverSignerFallback(page);
    if (!fallbackWorked) {
      return { ok: false, reason: "missing_receiver_signer" };
    }
  }

  await page.waitForTimeout(5000);

  let modalWasClosed = false;
  if (await isConfirmModalVisible(page)) {
    modalWasClosed = await clickOutsideModal(page);
    if (modalWasClosed) {
      await page.waitForTimeout(1000);
    }
  }

  const receiverLabel = page
    .locator("span")
    .filter({ hasText: /^Người nhận hồ sơ$/i })
    .first();
  const hasReceiverLabel = (await receiverLabel.count()) > 0;

  let imageDebug = null;
  let clickVerification = null;
  const alreadyPlacedSignature = await isSignatureGlyphAlreadyPlaced(page);

  if (modalWasClosed && hasReceiverLabel) {
    if (alreadyPlacedSignature) {
      console.log(
        "[signRecordById] Phát hiện chữ ký đã được thả sẵn ở vị trí tuyệt đối, bỏ qua bước click di chuyển ảnh và đi thẳng tiếp tục.",
      );
      imageDebug = { ok: true, debug: null };
    } else {
      // THAY ĐỔI: thay vì chỉ chụp ảnh 1 lần (debugImageTargetForModal) rồi click
      // mù mà không biết click có tác dụng gì không, giờ gọi verifySignatureClickMovesImage
      // để chụp TRƯỚC + click + chụp SAU, biết chắc click đơn có di chuyển được ảnh
      // chữ ký vào vị trí hay không (bước 5-6 trong luồng bạn mô tả).
      console.log(
        "[signRecordById] Modal đã đóng, đang so sánh vị trí ảnh trước/sau khi click vào vị trí ký...",
      );
      clickVerification = await verifySignatureClickMovesImage(page, receiverLabel);

      if (!clickVerification.ok) {
        return {
          ok: false,
          reason: "click_verification_failed",
          clickVerification,
        };
      }

      if (!clickVerification.moved) {
        console.warn(
          "[signRecordById] ❌ Click KHÔNG di chuyển được ảnh chữ ký. Thử chọn option 1 ở select[name=\"page\"] rồi click thả chữ ký lại...",
        );

        const pageSelected = await selectPageOption(page, "1");
        if (!pageSelected) {
          console.warn(
            "[signRecordById] Không chọn được option 1 ở select[name=\"page\"]. Dừng flow để bạn xem log.",
          );
          return {
            ok: false,
            reason: "click_did_not_move_image_need_drag",
            clickVerification,
          };
        }

        console.log(
          "[signRecordById] Đã chọn trang 1, thử lại click thả chữ ký...",
        );
        const retryVerification = await verifySignatureClickMovesImage(
          page,
          receiverLabel,
        );

        if (!retryVerification.ok || !retryVerification.moved) {
          console.warn(
            "[signRecordById] ❌ Sau khi chọn trang 1, click vẫn KHÔNG di chuyển được ảnh chữ ký. Cần dùng kéo-thả (drag) thật sự. Dừng flow tại đây để bạn xem log.",
          );
          return {
            ok: false,
            reason: "click_did_not_move_image_need_drag",
            clickVerification: retryVerification,
          };
        }

        console.log(
          "[signRecordById] ✅ Sau khi chọn trang 1, click đã di chuyển ảnh chữ ký thành công. Tiếp tục tìm nút Ký File.",
        );
        clickVerification = retryVerification;
      } else {
        console.log(
          "[signRecordById] ✅ Click đã di chuyển ảnh chữ ký thành công. Tiếp tục tìm nút Ký File.",
        );
      }

      // Vẫn giữ lại 1 bản debug cuối để log/return giống hành vi cũ.
      imageDebug = { ok: true, debug: clickVerification.afterDebug };
    }
  }

  const signerButtonAfterModal = page
    .locator('button[title="Ký số"], button[title*="Ký số" i]')
    .first();
  if ((await signerButtonAfterModal.count()) === 0) {
    if (hasReceiverLabel && !clickVerification) {
      console.log(
        '[signRecordById] Không còn button[title="Ký số"] sau modal, chuyển sang debug img riêng.',
      );
      imageDebug = imageDebug || (await debugImageTargetForModal(page));

      if (!imageDebug.ok) {
        return {
          ok: false,
          reason: "missing_img_debug_target",
          debug: imageDebug.debug,
        };
      }
    } else if (!hasReceiverLabel) {
      console.warn(
        "[signRecordById] Không tìm thấy span Người nhận hồ sơ sau modal, dừng flow.",
      );
      return { ok: false, reason: "missing_receiver_label_after_modal" };
    }
  }

  const signFileButtonSelector =
    'button.btn.btn-sm.btn-warning:has-text("Ký File"), button:has-text("Ký File")';
  const signFileButton = page.locator(signFileButtonSelector).first();

  if ((await signFileButton.count()) === 0) {
    console.warn(
      "[signRecordById] Không tìm thấy nút Ký File sau khi debug xong.",
    );
    return {
      ok: false,
      reason: "missing_sign_file_button",
      debug: imageDebug?.debug || null,
      clickVerification,
    };
  }

  try {
    await signFileButton.scrollIntoViewIfNeeded();
    await signFileButton.click({ timeout: 10000 });
    console.log("[signRecordById] Đã click nút Ký File.");
  } catch (error) {
    console.warn(
      "[signRecordById] Click Ký File lỗi, thử click bằng tọa độ ảnh:",
      error.message,
    );
    const fallbackClick = await clickLocatorByMouse(page, signFileButton, {
      moveBeforeClick: true,
      waitAfterClick: 1500,
      label: "Ký File",
    });
    if (!fallbackClick) {
      return {
        ok: false,
        reason: "click_sign_file_failed",
        error: error.message,
        debug: imageDebug?.debug || null,
        clickVerification,
      };
    }
  }

  await page.waitForTimeout(1500);

  if (await isConfirmModalVisible(page)) {
    console.log("[signRecordById] Modal xác nhận hiển thị, đang đồng ý ký hồ sơ...");
    const confirmed = await clickConfirmSignModal(page);
    console.log("[signRecordById] Kết quả đồng ý ký hồ sơ:", confirmed);
  }

  return {
    ok: true,
    reason: "sign_file_clicked_and_confirmed",
    debug: imageDebug?.debug || null,
    clickVerification,
    confirmationModalVisible: await isConfirmModalVisible(page),
  };
}

// ============================================================
// INJECT FULL SCREEN API UI
// ============================================================

async function injectApiTestUI(page) {
  await page.evaluate(() => {
    // --------------------------------------------------------
    // XÓA UI CŨ NẾU ĐÃ TỒN TẠI
    // --------------------------------------------------------

    const oldRoot = document.getElementById("api-test-menu-root");

    if (oldRoot) {
      oldRoot.remove();
    }

    // --------------------------------------------------------
    // ROOT
    // --------------------------------------------------------

    const root = document.createElement("div");

    root.id = "api-test-menu-root";
    root.style.pointerEvents = "none";
    root.style.position = "fixed";
    root.style.left = "0";
    root.style.top = "0";
    root.style.right = "0";
    root.style.bottom = "0";
    root.style.width = "100vw";
    root.style.height = "100vh";
    root.style.maxWidth = "100vw";
    root.style.maxHeight = "100vh";

    root.style.background = "#f3f4f6";

    root.style.zIndex = "2147483647";

    root.style.fontFamily = "Arial, sans-serif";

    root.style.boxSizing = "border-box";

    root.style.padding = "20px";

    root.style.overflow = "auto";

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
          pointer-events:auto;
        "
      >

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


        <div
          id="api-test-area"
          style="
            display:flex;
            flex-direction:column;
            gap:12px;
            flex-shrink:0;
          "
        >


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
              3. Mở chi tiết hồ sơ theo ID
            </div>


            <div
              style="
                display:flex;
                gap:10px;
              "
            >

              <input
                id="record-detail-id"
                placeholder="Nhập ID hồ sơ..."
                style="
                  flex:1;
                  min-height:40px;

                  border:1px solid #d1d5db;
                  border-radius:8px;

                  padding:8px 12px;

                  font-size:14px;

                  box-sizing:border-box;
                "
              />


              <button
                data-open-detail="open-detail"
                style="
                  min-width:140px;

                  border:1px solid #10b981;
                  background:#ecfdf5;

                  color:#065f46;

                  border-radius:8px;

                  font-weight:700;

                  cursor:pointer;
                "
              >
                Mở chi tiết
              </button>


              <button
                data-sign-record="sign-record"
                style="
                  min-width:140px;

                  border:1px solid #f59e0b;
                  background:#fffbeb;

                  color:#92400e;

                  border-radius:8px;

                  font-weight:700;

                  cursor:pointer;
                "
              >
                Ký hồ sơ
              </button>

              <button
                data-debug-image="debug-image"
                style="
                  min-width:150px;

                  border:1px solid #8b5cf6;
                  background:#f5f3ff;

                  color:#5b21b6;

                  border-radius:8px;

                  font-weight:700;

                  cursor:pointer;
                "
              >
                Debug ảnh modal
              </button>

              <button
                data-verify-click="verify-click"
                style="
                  min-width:190px;

                  border:1px solid #06b6d4;
                  background:#ecfeff;

                  color:#0e7490;

                  border-radius:8px;

                  font-weight:700;

                  cursor:pointer;
                "
              >
                So sánh trước/sau click
              </button>

            </div>

          </div>


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
              4. Giao nhận
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
              5. Delete
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

    document.body.appendChild(root);

    const oldBodyOverflow = document.body.style.overflow;

    document.body.style.margin = "0";
    document.body.style.padding = "0";
    document.body.style.width = "100vw";
    document.body.style.height = "100vh";
    document.body.style.overflow = "hidden";

    document.documentElement.style.margin = "0";
    document.documentElement.style.padding = "0";

    const output = document.getElementById("api-test-output");

    const closeBtn = document.getElementById("api-test-close");

    const minimizeBtn = document.getElementById("api-test-minimize");

    const networkToggle = document.getElementById("network-toggle");

    const networkClear = document.getElementById("network-clear");

    const networkStatus = document.getElementById("network-status");

    const mainContainer = document.getElementById("api-main-container");

    let networkEnabled = true;

    let networkLogs = [];

    function getTime() {
      return new Date().toLocaleTimeString("vi-VN", {
        hour12: false,
      });
    }

    function addNetworkLog(log) {
      if (!networkEnabled) {
        return;
      }

      networkLogs.push(log);

      if (networkLogs.length > 500) {
        networkLogs = networkLogs.slice(-500);
      }

      renderNetworkLogs();
    }

    function renderNetworkLogs() {
      if (!networkLogs.length) {
        output.textContent = "Chưa có request / response API.";

        return;
      }

      output.textContent = networkLogs
        .map((item, index) => {
          return `
============================================================
#${index + 1}
TIME: ${item.time}
TYPE: ${item.type}
METHOD: ${item.method || ""}
STATUS: ${item.status || ""}
DURATION: ${item.duration || ""} ms

URL:
${item.url || ""}

${
  item.body
    ? `BODY:
${item.body}

`
    : ""
}

${
  item.responseBody
    ? `RESPONSE:
${item.responseBody}

`
    : ""
}
============================================================
`;
        })
        .join("\n");

      output.scrollTop = output.scrollHeight;
    }

    const getToken = () => {
      try {
        const raw = localStorage.getItem("currentUser");

        if (!raw) {
          return "";
        }

        const parsed = JSON.parse(raw);

        return parsed?.access_token || "";
      } catch (error) {
        return "";
      }
    };

    async function callApi(url, method = "GET", body = null) {
      const token = getToken();

      if (!token) {
        output.textContent =
          "Không tìm thấy token trong localStorage. Hãy đăng nhập trước khi gọi API.";

        return;
      }

      const start = performance.now();

      output.textContent = `
Đang gọi API...

METHOD:
${method}

URL:
${url}
`;

      try {
        const response = await fetch(url, {
          method,

          headers: {
            Authorization: `Bearer ${token}`,

            "Content-Type": "application/json",
          },

          body:
            method === "GET" || method === "HEAD"
              ? undefined
              : body
                ? JSON.stringify(body)
                : undefined,
        });

        const duration = Math.round(performance.now() - start);

        let data;

        try {
          data = await response.json();
        } catch (error) {
          data = await response.text();
        }

        output.textContent = JSON.stringify(
          {
            time: getTime(),

            method,

            url,

            status: response.status,

            ok: response.ok,

            duration,

            data,
          },
          null,
          2,
        );
      } catch (error) {
        const duration = Math.round(performance.now() - start);

        output.textContent = `
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

    document
      .querySelectorAll(
        "[data-api], [data-open-detail], [data-sign-record], [data-debug-image], [data-verify-click]",
      )
      .forEach((button) => {
        button.addEventListener("click", async () => {
          const mode =
            button.getAttribute("data-api") ||
            button.getAttribute("data-open-detail") ||
            button.getAttribute("data-sign-record") ||
            button.getAttribute("data-debug-image") ||
            button.getAttribute("data-verify-click");

          if (mode === "list") {
            const url = document.getElementById("api-list-url").value.trim();

            callApi(url, "GET");
          }

          if (mode === "detail") {
            const url = document.getElementById("api-detail-url").value.trim();

            callApi(url, "GET");
          }

          if (mode === "open-detail") {
            const id = document.getElementById("record-detail-id").value.trim();

            if (!id) {
              output.textContent =
                "Vui lòng nhập ID hồ sơ trước khi mở chi tiết.";
              return;
            }

            const detailUrl = `https://bvrhm.hosoyte.com/v2/#/view/HSBA/HsBenhAn/${encodeURIComponent(id)}/HSBA%2FDsBenhAnChoKy`;

            window.location.href = detailUrl;
            output.textContent = `Đang mở trang chi tiết hồ sơ ID: ${id}\nURL:\n${detailUrl}`;
          }

          if (mode === "sign-record") {
            const id = document.getElementById("record-detail-id").value.trim();

            if (!id) {
              output.textContent = "Vui lòng nhập ID hồ sơ trước khi ký.";
              return;
            }

            output.textContent = `Đang thực hiện ký hồ sơ ID: ${id}...`;

            try {
              const result = await window.signRecordByIdFromPage(id);
              output.textContent = JSON.stringify(result, null, 2);
            } catch (error) {
              output.textContent = `Lỗi khi ký hồ sơ: ${error.message}`;
            }
          }

          if (mode === "debug-image") {
            output.textContent = "Đang chạy debugImageTargetForModal...";

            try {
              console.log("[UI] Bấm nút debugImageTargetForModal");
              const result = await window.debugImageTargetForModal();
              console.log("[UI] Kết quả debugImageTargetForModal:", result);
              output.textContent = JSON.stringify(result, null, 2);
            } catch (error) {
              console.error(
                "[UI] Lỗi khi gọi debugImageTargetForModal:",
                error,
              );
              output.textContent = `Lỗi khi chạy debugImageTargetForModal: ${error.message}`;
            }
          }

          if (mode === "verify-click") {
            output.textContent =
              "Đang chụp vị trí ảnh TRƯỚC, click, rồi chụp lại vị trí SAU để so sánh...\n(Yêu cầu: modal xác nhận đã đóng, nhãn 'Người nhận hồ sơ' đang hiển thị trên trang)";

            try {
              console.log("[UI] Bấm nút verifySignatureClickMovesImage");
              const result = await window.verifySignatureClickMovesImageFromPage();
              console.log("[UI] Kết quả verifySignatureClickMovesImage:", result);
              output.textContent = JSON.stringify(result, null, 2);
            } catch (error) {
              console.error(
                "[UI] Lỗi khi gọi verifySignatureClickMovesImage:",
                error,
              );
              output.textContent = `Lỗi khi chạy so sánh: ${error.message}`;
            }
          }

          if (mode === "sign") {
            const url = document.getElementById("api-sign-url").value.trim();

            callApi(url, "DELETE");
          }

          if (mode === "delete") {
            const url = document.getElementById("api-delete-url").value.trim();

            callApi(url, "DELETE");
          }
        });
      });

    let isMinimized = false;

    function syncRootLayout() {
      if (isMinimized) {
        const maxWidth = Math.min(460, window.innerWidth - 24);

        root.style.inset = "auto";
        root.style.top = "12px";
        root.style.right = "12px";
        root.style.bottom = "auto";
        root.style.left = "auto";

        root.style.width = `${Math.max(320, maxWidth)}px`;
        root.style.height = "auto";

        root.style.padding = "12px";
        root.style.borderRadius = "10px";
        root.style.boxShadow = "0 10px 30px rgba(0,0,0,0.25)";

        mainContainer.style.height = "auto";
        minimizeBtn.textContent = "Toàn màn hình";

        return;
      }

      root.style.inset = "0";
      root.style.top = "0";
      root.style.right = "0";
      root.style.bottom = "0";
      root.style.left = "0";

      root.style.width = "100vw";
      root.style.height = "100vh";
      root.style.maxWidth = "100vw";
      root.style.maxHeight = "100vh";

      root.style.padding = "20px";
      root.style.borderRadius = "0";
      root.style.boxShadow = "none";

      mainContainer.style.height = "100%";
      minimizeBtn.textContent = "Thu nhỏ";
    }

    minimizeBtn.addEventListener("click", () => {
      isMinimized = !isMinimized;
      syncRootLayout();
    });

    window.addEventListener("resize", syncRootLayout);
    syncRootLayout();

    closeBtn.addEventListener("click", () => {
      document.body.style.overflow = oldBodyOverflow;

      root.remove();
    });

    networkToggle.addEventListener("click", () => {
      networkEnabled = !networkEnabled;

      if (networkEnabled) {
        networkToggle.textContent = "Tạm dừng";

        networkStatus.textContent = "● Đang theo dõi";

        networkStatus.style.color = "#16a34a";
      } else {
        networkToggle.textContent = "Tiếp tục";

        networkStatus.textContent = "● Đã tạm dừng";

        networkStatus.style.color = "#dc2626";
      }
    });

    networkClear.addEventListener("click", () => {
      networkLogs = [];

      output.textContent = "Đã xóa network log.";
    });
  }, {});
}

// ============================================================
// PLAYWRIGHT NETWORK MONITOR
// ============================================================

function setupNetworkMonitor(page) {
  page.on("request", async (request) => {
    const url = request.url();

    if (!url.includes("/api/")) {
      return;
    }

    const method = request.method();

    const body = request.postData();

    console.log("\n==================================================");

    console.log("[API REQUEST]");

    console.log(
      "TIME:",
      new Date().toLocaleTimeString("vi-VN", {
        hour12: false,
      }),
    );

    console.log("METHOD:", method);

    console.log("URL:", url);

    if (body) {
      console.log("BODY:", body);
    }

    console.log("==================================================\n");
  });

  page.on("response", async (response) => {
    const url = response.url();

    if (!url.includes("/api/")) {
      return;
    }

    const request = response.request();

    console.log("\n--------------------------------------------------");

    console.log("[API RESPONSE]");

    console.log(
      "TIME:",
      new Date().toLocaleTimeString("vi-VN", {
        hour12: false,
      }),
    );

    console.log("METHOD:", request.method());

    console.log("STATUS:", response.status());

    console.log("URL:", url);

    console.log("--------------------------------------------------\n");
  });
}

// ============================================================
// MAIN
// ============================================================

(async () => {
  try {
    console.log("==============================================");

    console.log("API TEST TOOL");

    console.log("==============================================");

    const tokenFromFile = getAccessTokenFromStorageState();

    if (tokenFromFile) {
      console.log("Đã tìm thấy access_token trong storageState.json.");
    } else {
      console.log("Không tìm thấy access_token trong storageState.json.");
    }

    const browser = await chromium.launch({
      headless: false,
    });

    const context = await browser.newContext({
      viewport: {
        width: 1280,
        height: 820,
      },
      screen: {
        width: 1280,
        height: 820,
      },

      ignoreHTTPSErrors: true,

      storageState: fs.existsSync(STORAGE_STATE_PATH)
        ? STORAGE_STATE_PATH
        : undefined,
    });

    const page = await context.newPage();

    setupNetworkMonitor(page);

    console.log("Mở trang target...");

    await page.goto(TARGET_URL, {
      waitUntil: "domcontentloaded",

      timeout: 120000,
    });

    await ensureLoggedIn(page, tokenFromFile);

    if (!tokenFromFile) {
      const refreshedToken = getAccessTokenFromStorageState();

      if (!refreshedToken) {
        console.log("Không có token hợp lệ trong storageState.json.");

        console.log("Hãy login vào web rồi chạy lại script.");

        await page.goto(LOGIN_URL, {
          waitUntil: "domcontentloaded",

          timeout: 120000,
        });

        await new Promise(() => {});

        return;
      }
    }

    await page.goto(TARGET_URL, {
      waitUntil: "domcontentloaded",

      timeout: 120000,
    });

    await page.exposeFunction("signRecordByIdFromPage", async (recordId) => {
      return await signRecordById(page, context, recordId);
    });

    await page.exposeFunction("debugImageTargetForModal", async () => {
      console.log("[page.exposeFunction] Gọi debugImageTargetForModal(page)");
      return await debugImageTargetForModal(page);
    });

    await page.exposeFunction("debugImageTargetForModalFromPage", async () => {
      console.log(
        "[page.exposeFunction] Gọi alias debugImageTargetForModalFromPage",
      );
      return await debugImageTargetForModal(page);
    });

    // MỚI: expose hàm so sánh trước/sau click ra UI, để bấm nút "So sánh
    // trước/sau click" thử độc lập bất cứ lúc nào (không cần chạy hết
    // signRecordById), miễn là modal xác nhận đã đóng và nhãn "Người nhận
    // hồ sơ" đang hiển thị trên trang.
    await page.exposeFunction(
      "verifySignatureClickMovesImageFromPage",
      async () => {
        console.log(
          "[page.exposeFunction] Gọi verifySignatureClickMovesImageFromPage",
        );

        const receiverLabel = page
          .locator("span")
          .filter({ hasText: /^Người nhận hồ sơ$/i })
          .first();

        if ((await receiverLabel.count()) === 0) {
          return {
            ok: false,
            reason: "missing_receiver_label",
            note: 'Không tìm thấy nhãn "Người nhận hồ sơ" trên trang hiện tại.',
          };
        }

        return await verifySignatureClickMovesImage(page, receiverLabel);
      },
    );

    await injectApiTestUI(page);

    console.log("");

    console.log("==============================================");

    console.log("API Test UI đã được chèn.");

    console.log("==============================================");

    console.log("Network Monitor đang theo dõi các request /api/.");

    console.log("Bạn có thể thao tác trực tiếp trên website.");

    console.log("Đặc biệt: thử Ký File → Xác nhận để xem API nào được gọi.");

    console.log(
      'Hoặc bấm nút "So sánh trước/sau click" để kiểm tra click có di chuyển được ảnh chữ ký hay không.',
    );

    console.log("");

    console.log("Nhấn Ctrl+C để đóng browser.");

    await new Promise((resolve) => {
      process.stdin.resume();

      process.on("SIGINT", async () => {
        console.log("\nĐang đóng browser...");

        try {
          await browser.close();
        } catch (error) {
          // ignore
        }

        resolve();
      });
    });
  } catch (error) {
    console.error("\nLỖI CHƯƠNG TRÌNH:");

    console.error(error);

    process.exit(1);
  }
})();