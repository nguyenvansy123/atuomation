class PhienHetHanError extends Error {}
class LoiDangNhapError extends Error {
  constructor(message, options) {
    super(message, options);
    this.chiTiet = options?.cause?.chiTiet || [];
  }
}

class PhienDangNhap {
  constructor(config) {
    this.config = config;
    this.lanDangNhapCuoi = 0;
    this.trangHetPhien = new WeakSet();
    this.trangDaTheoDoi = new WeakSet();
  }

  theoDoi(page) {
    if (this.trangDaTheoDoi.has(page)) return;
    this.trangDaTheoDoi.add(page);
    const origins = [this.config.urlLogin, this.config.urlApi].map((url) => new URL(url).origin);
    page.on('response', (response) => {
      if (response.status() === 401 && origins.includes(new URL(response.url()).origin)) {
        this.trangHetPhien.add(page);
      }
    });
  }

  async kiemTra(page) {
    const url = new URL(page.url());
    const login = new URL(this.config.urlLogin);
    if (this.trangHetPhien.has(page) ||
        (url.origin === login.origin && url.pathname.replace(/\/$/, '') === login.pathname) ||
        await page.locator(this.config.selEmail).isVisible()) {
      throw new PhienHetHanError('Phien dang nhap da het han; can dang nhap lai.');
    }
    const token = await page.evaluate(() => localStorage.getItem('token'));
    if (!token) throw new PhienHetHanError('Khong con token dang nhap.');
  }

  async dangNhap(page) {
    this.theoDoi(page);
    try {
      if (new URL(page.url()).origin === new URL(this.config.urlLogin).origin) {
        await page.evaluate(() => localStorage.removeItem('token'));
      }
      await page.goto(this.config.urlLogin);
      await page.fill(this.config.selEmail, this.config.user);
      await page.fill(this.config.selPass, this.config.pass);
      await page.click(this.config.selNutLogin);
      await page.waitForSelector(this.config.selOTimKiem, { timeout: 60000 });
      this.trangHetPhien.delete(page);
      await this.kiemTra(page);
      this.lanDangNhapCuoi = Date.now();
      console.log('  Dang nhap thanh cong; tiep tuc xu ly danh sach.');
    } catch (loi) {
      throw new LoiDangNhapError(`Khong dang nhap duoc: ${loi.message}`, { cause: loi });
    }
  }

  async xuLyVoiDangNhapLai(page, ma, xuLy) {
    if (Date.now() - this.lanDangNhapCuoi >= this.config.dangNhapLaiSauMs) {
      console.log(`  [${ma}] Da du ${this.config.dangNhapLaiSauMs / 3600000} gio; dang nhap lai truoc khi xu ly ma moi.`);
      await this.dangNhap(page);
    }
    let soLanKhoiPhuc = 0;
    for (;;) {
      try {
        await this.kiemTra(page);
        return await xuLy();
      } catch (loi) {
        if (!(loi instanceof PhienHetHanError)) {
          try {
            await this.kiemTra(page);
          } catch (loiPhien) {
            if (!(loiPhien instanceof PhienHetHanError)) throw loiPhien;
            loiPhien.chiTiet = loi.chiTiet;
            loi = loiPhien;
          }
          if (!(loi instanceof PhienHetHanError)) throw loi;
        }
        if (soLanKhoiPhuc >= this.config.soLanDangNhapLaiKhiHetPhien) {
          throw new LoiDangNhapError(`Ma ${ma}: phien van loi sau ${soLanKhoiPhuc} lan dang nhap lai.`, { cause: loi });
        }
        soLanKhoiPhuc++;
        console.log(`  [${ma}] Het phien: ${loi.message} Dang nhap lai (${soLanKhoiPhuc}/${this.config.soLanDangNhapLaiKhiHetPhien}), sau do thu lai CUNG ma BN.`);
        try {
          await this.dangNhap(page);
        } catch (loiDangNhap) {
          loiDangNhap.chiTiet = loi.chiTiet || [];
          throw loiDangNhap;
        }
      }
    }
  }
}

async function kiemTraPhanHoiDangNhap(response, moTa) {
  if (response.status === 401) {
    await response.body?.cancel();
    throw new PhienHetHanError(`${moTa}: HTTP 401 (het phien dang nhap).`);
  }
}

module.exports = { PhienDangNhap, PhienHetHanError, LoiDangNhapError, kiemTraPhanHoiDangNhap };
