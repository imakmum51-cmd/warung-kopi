const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});
const path = require("path");
const os = require("os");
const Database = require("better-sqlite3");
const { Bonjour } = require("bonjour-service");
const qrTerminal = require("qrcode-terminal");
const { execFile } = require("child_process");
const webPush = require("web-push");

// VAPID keys untuk Web Push Notification
const VAPID_PUBLIC = "BGKT-gWNrYZOpexlInpmHplFViy-459BzLUAxggBKQStkQwBuX_TDH-z6sFiFap6hVCoqoGhXznwI7Y27qj0P5Y";
const VAPID_PRIVATE = "YaAvbE4CSgYXCC1Oym_OC__8u5jq8Ru1PFfWnz8eRtM";
webPush.setVapidDetails("mailto:warkop@urban.local", VAPID_PUBLIC, VAPID_PRIVATE);

// Simpan push subscriptions per meja
const pushSubscriptions = {}; // { meja: [subscription, ...] }

// Limit 2MB: foto menu ~150KB + margin untuk payload lain
app.use(express.json({ limit: "2mb" }));

// ============================================
// 1. KONFIGURASI ROLE & AKUN
// ============================================
const AKUN = [
  { username: "admin", pin: "0000", role: "admin" },
  { username: "owner", pin: "1234", role: "owner" },
  { username: "budi", pin: "1111", role: "kasir" },
  { username: "sari", pin: "2222", role: "kasir" },
];

// Hak akses per role
const HAK_AKSES = {
  admin: [
    "transaksi",
    "laporan_harian",
    "laporan_keuangan",
    "kelola_menu",
    "kelola_stok",
    "manajemen_user",
    "setting_toko",
    "void",
    "reset_omzet",
    "audit_log",
    "admin_db",
  ],
  owner: [
    "transaksi",
    "laporan_harian",
    "laporan_keuangan",
    "kelola_menu",
    "kelola_stok",
    "void",
    "audit_log",
  ],
  kasir: ["transaksi", "laporan_harian", "void"],
  pembeli: [], // hanya layar tampilan, tidak ada akses socket aktif
};

// ============================================
// 2. DATABASE SETUP (SQLite)
// ============================================
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, "warkop.db");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS transaksi (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tanggal TEXT NOT NULL,
    kasir TEXT NOT NULL,
    menu TEXT NOT NULL,
    qty INTEGER NOT NULL,
    total INTEGER NOT NULL,
    metode TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS menu (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nama TEXT NOT NULL,
    harga INTEGER NOT NULL,
    kategori TEXT DEFAULT 'minuman',
    stok INTEGER DEFAULT 50,
    tersedia INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS karyawan (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    pin TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'kasir',
    aktif INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pelanggan (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nama TEXT NOT NULL,
    telp TEXT DEFAULT '',
    poin INTEGER DEFAULT 0,
    total_belanja INTEGER DEFAULT 0,
    total_kunjungan INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS menu_opsi (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipe TEXT NOT NULL,
    nama TEXT NOT NULL,
    harga INTEGER DEFAULT 0,
    icon TEXT DEFAULT '',
    urutan INTEGER DEFAULT 0,
    aktif INTEGER DEFAULT 1,
    kategori_menu TEXT DEFAULT ''
  );
`);

// Migrasi: tambah kolom stok jika belum ada
try {
  db.exec("ALTER TABLE menu ADD COLUMN stok INTEGER DEFAULT 50");
} catch (e) {}
// Migrasi: tambah kolom pelanggan_id di transaksi
try {
  db.exec("ALTER TABLE transaksi ADD COLUMN pelanggan_id INTEGER DEFAULT NULL");
} catch (e) {}
// Migrasi: tambah kolom username & password di pelanggan
try {
  db.exec("ALTER TABLE pelanggan ADD COLUMN username TEXT DEFAULT ''");
} catch (e) {}
try {
  db.exec("ALTER TABLE pelanggan ADD COLUMN password TEXT DEFAULT ''");
} catch (e) {}
// Migrasi: tambah kolom alamat di pelanggan
try {
  db.exec("ALTER TABLE pelanggan ADD COLUMN alamat TEXT DEFAULT ''");
} catch (e) {}

// Migrasi: tambah kolom catatan, diskon, diskon_info di transaksi
try { db.exec("ALTER TABLE transaksi ADD COLUMN catatan TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE transaksi ADD COLUMN diskon INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE transaksi ADD COLUMN diskon_info TEXT DEFAULT ''"); } catch(e) {}

// Migrasi: tambah kolom foto di menu (data URL base64, JPG/WebP <150KB)
try { db.exec("ALTER TABLE menu ADD COLUMN foto TEXT DEFAULT ''"); } catch(e) {}

// Tabel review menu
db.exec(`
  CREATE TABLE IF NOT EXISTS review (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    menu_id INTEGER NOT NULL,
    pelanggan_id INTEGER NOT NULL,
    pesanan_id INTEGER DEFAULT 0,
    rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
    komentar TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
// Index biar agregasi rating cepat
try { db.exec("CREATE INDEX IF NOT EXISTS idx_review_menu ON review(menu_id)"); } catch(e) {}

// Tabel push subscription untuk app pelanggan (persistent, bukan in-memory)
db.exec(`
  CREATE TABLE IF NOT EXISTS push_pelanggan (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pelanggan_id INTEGER DEFAULT 0,
    endpoint TEXT NOT NULL UNIQUE,
    subscription TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migrasi: tambah kolom jadwal_ambil di pesanan_online untuk pre-order
try { db.exec("ALTER TABLE pesanan_online ADD COLUMN jadwal_ambil TEXT DEFAULT ''"); } catch(e) {}

// Tabel OTP verification (untuk register via WA)
db.exec(`
  CREATE TABLE IF NOT EXISTS otp_verification (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telp TEXT NOT NULL,
    kode TEXT NOT NULL,
    expired_at DATETIME NOT NULL,
    attempts INTEGER DEFAULT 0,
    used INTEGER DEFAULT 0,
    verified_at DATETIME DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
try { db.exec("CREATE INDEX IF NOT EXISTS idx_otp_telp ON otp_verification(telp)"); } catch(e) {}

// Tabel pengeluaran operasional (buat profit bersih)
db.exec(`
  CREATE TABLE IF NOT EXISTS pengeluaran (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tanggal TEXT NOT NULL,
    kategori TEXT NOT NULL,
    keterangan TEXT DEFAULT '',
    nominal INTEGER NOT NULL,
    dibuat_oleh TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
try { db.exec("CREATE INDEX IF NOT EXISTS idx_pengeluaran_tanggal ON pengeluaran(tanggal)"); } catch(e) {}

// Kas opname: tambah kolom di shift_log
try { db.exec("ALTER TABLE shift_log ADD COLUMN kas_fisik INTEGER DEFAULT NULL"); } catch(e) {}
try { db.exec("ALTER TABLE shift_log ADD COLUMN kas_expected INTEGER DEFAULT NULL"); } catch(e) {}
try { db.exec("ALTER TABLE shift_log ADD COLUMN kas_selisih INTEGER DEFAULT NULL"); } catch(e) {}
try { db.exec("ALTER TABLE shift_log ADD COLUMN kas_catatan TEXT DEFAULT ''"); } catch(e) {}

// Tabel pesanan online & QR meja (tracking semua pesanan masuk)
db.exec(`
  CREATE TABLE IF NOT EXISTS pesanan_online (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pelanggan_id INTEGER DEFAULT 0,
    nama TEXT NOT NULL,
    alamat TEXT DEFAULT '',
    telp TEXT DEFAULT '',
    meja TEXT DEFAULT '',
    sumber TEXT DEFAULT 'online',
    items TEXT NOT NULL,
    total INTEGER NOT NULL,
    diskon INTEGER DEFAULT 0,
    promo_kode TEXT DEFAULT '',
    metode TEXT NOT NULL,
    tipe TEXT DEFAULT 'Dine In',
    catatan TEXT DEFAULT '',
    status TEXT DEFAULT 'menunggu',
    kode_pesanan TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migrasi: tambah kolom meja & sumber jika belum ada, dan ubah pelanggan_id nullable
try {
  const tableInfo = db.pragma("table_info(pesanan_online)");
  const hasMeja = tableInfo.find(c => c.name === "meja");
  const hasSumber = tableInfo.find(c => c.name === "sumber");
  const pelangganCol = tableInfo.find(c => c.name === "pelanggan_id");
  const needMigrate = !hasMeja || !hasSumber || (pelangganCol && pelangganCol.notnull === 1);
  if (needMigrate) {
    db.exec(`
      CREATE TABLE pesanan_online_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pelanggan_id INTEGER DEFAULT 0,
        nama TEXT NOT NULL,
        alamat TEXT DEFAULT '',
        telp TEXT DEFAULT '',
        meja TEXT DEFAULT '',
        sumber TEXT DEFAULT 'online',
        items TEXT NOT NULL,
        total INTEGER NOT NULL,
        diskon INTEGER DEFAULT 0,
        promo_kode TEXT DEFAULT '',
        metode TEXT NOT NULL,
        tipe TEXT DEFAULT 'Dine In',
        catatan TEXT DEFAULT '',
        status TEXT DEFAULT 'menunggu',
        kode_pesanan TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    // Copy existing data (old columns)
    const oldCols = tableInfo.map(c => c.name);
    const commonCols = oldCols.filter(c => ['id','pelanggan_id','nama','alamat','telp','items','total','diskon','promo_kode','metode','tipe','catatan','status','kode_pesanan','created_at','updated_at'].includes(c));
    if (commonCols.length > 0) {
      db.exec(`INSERT INTO pesanan_online_new (${commonCols.join(',')}) SELECT ${commonCols.join(',')} FROM pesanan_online;`);
    }
    db.exec(`DROP TABLE pesanan_online; ALTER TABLE pesanan_online_new RENAME TO pesanan_online;`);
    console.log("[DB] Migrasi pesanan_online: tambah kolom meja & sumber, pelanggan_id nullable");
  }
} catch(e) { /* tabel baru, tidak perlu migrasi */ }

// Tabel favorit menu pelanggan
db.exec(`
  CREATE TABLE IF NOT EXISTS favorit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pelanggan_id INTEGER NOT NULL,
    menu_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(pelanggan_id, menu_id)
  );
`);

// Tabel promo/voucher
db.exec(`
  CREATE TABLE IF NOT EXISTS promo (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kode TEXT NOT NULL UNIQUE,
    nama TEXT NOT NULL,
    deskripsi TEXT DEFAULT '',
    tipe TEXT NOT NULL,
    nilai INTEGER NOT NULL,
    min_belanja INTEGER DEFAULT 0,
    max_diskon INTEGER DEFAULT 0,
    kuota INTEGER DEFAULT -1,
    terpakai INTEGER DEFAULT 0,
    mulai TEXT NOT NULL,
    selesai TEXT NOT NULL,
    aktif INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Seed promo contoh jika kosong
const promoCount = db.prepare("SELECT COUNT(*) as c FROM promo").get();
if (promoCount.c === 0) {
  const seedPromo = db.prepare(
    "INSERT INTO promo (kode, nama, deskripsi, tipe, nilai, min_belanja, max_diskon, kuota, mulai, selesai) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const seedP = db.transaction(() => {
    seedPromo.run("WELCOME20", "Diskon 20% Pelanggan Baru", "Diskon 20% untuk pembelian pertama", "persen", 20, 20000, 15000, -1, "2025-01-01", "2027-12-31");
    seedPromo.run("HEMAT10K", "Potongan Rp 10.000", "Potongan langsung Rp 10.000 min. belanja Rp 50.000", "nominal", 10000, 50000, 0, 100, "2025-01-01", "2027-12-31");
    seedPromo.run("KOPI50", "Diskon 50% Menu Kopi", "Diskon 50% untuk semua menu kopi, max Rp 20.000", "persen", 50, 15000, 20000, 50, "2025-01-01", "2027-12-31");
  });
  seedP();
}

// Tabel shift karyawan
db.exec(`
  CREATE TABLE IF NOT EXISTS shift_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    karyawan_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    shift TEXT NOT NULL,
    clock_in DATETIME NOT NULL,
    clock_out DATETIME DEFAULT NULL,
    total_transaksi INTEGER DEFAULT 0,
    total_omzet INTEGER DEFAULT 0,
    status TEXT DEFAULT 'aktif',
    FOREIGN KEY (karyawan_id) REFERENCES karyawan(id)
  );
`);

// Tabel setting toko
db.exec(`
  CREATE TABLE IF NOT EXISTS setting_toko (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Seed setting defaults
const settingDefaults = {
  // Identitas
  nama_toko: "Cafe Soluna",
  alamat: "Jl. Contoh No. 1",
  telp: "08123456789",
  footer_struk: "Terima kasih telah berkunjung!",
  target_harian: "500000",
  // Quick Win — Identitas tambahan
  logo_url: "/public/soluna.png",
  instagram: "",
  email_toko: "",
  // Quick Win — Operasional
  jam_buka: "07:00",
  jam_tutup: "23:00",
  // Quick Win — Pajak & biaya
  pajak_aktif: "0",
  pajak_persen: "11",
  service_charge: "0",
  // Quick Win — Pembayaran
  qris_statis_url: "/public/qris.png.png",
  // Quick Win — Security & operasi
  auto_logout_menit: "30",
  notif_stok_habis: "5",
};
const seedSetting = db.prepare("INSERT OR IGNORE INTO setting_toko (key, value) VALUES (?, ?)");
Object.entries(settingDefaults).forEach(([k, v]) => seedSetting.run(k, v));
db.prepare("UPDATE setting_toko SET value = ? WHERE key = 'nama_toko' AND value = 'Warkop Urban'").run("Cafe Soluna");

// Tabel audit log
db.exec(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    waktu DATETIME DEFAULT CURRENT_TIMESTAMP,
    user TEXT NOT NULL,
    role TEXT NOT NULL,
    aksi TEXT NOT NULL,
    detail TEXT DEFAULT '',
    ip TEXT DEFAULT ''
  );
`);

// Seed karyawan awal jika kosong
const karyawanCount = db.prepare("SELECT COUNT(*) as c FROM karyawan").get();
if (karyawanCount.c === 0) {
  const seedKaryawan = db.prepare(
    "INSERT OR IGNORE INTO karyawan (username, pin, role) VALUES (?, ?, ?)",
  );
  const seedK = db.transaction(() => {
    AKUN.forEach((a) => seedKaryawan.run(a.username, a.pin, a.role));
  });
  seedK();
}

// Seed menu awal jika kosong
const menuCount = db.prepare("SELECT COUNT(*) as c FROM menu").get();
if (menuCount.c === 0) {
  const seedMenu = db.prepare(
    "INSERT INTO menu (nama, harga, kategori, stok) VALUES (?, ?, ?, ?)",
  );
  const seeds = db.transaction(() => {
    seedMenu.run("Indomie Goreng Telur", 10000, "makanan", 50);
    seedMenu.run("Indomie Rebus Telur", 10000, "makanan", 50);
    seedMenu.run("Nasi Goreng Urban", 13000, "makanan", 50);
    seedMenu.run("Kentang Goreng", 10000, "makanan", 50);
    seedMenu.run("Snack Platter", 15000, "makanan", 50);
    seedMenu.run("Otak-Otak", 10000, "makanan", 50);
    seedMenu.run("Risol Mayo", 15000, "makanan", 50);
    seedMenu.run("Dimsum Ayam", 15000, "makanan", 50);
    seedMenu.run("Cireng Rujak", 15000, "makanan", 50);
    seedMenu.run("Extrajoss Susu", 6000, "minuman", 50);
    seedMenu.run("Kukubima Susu", 6000, "minuman", 50);
    seedMenu.run("Es Teh Manis", 5000, "minuman", 50);
    seedMenu.run("Nutrisari Jeruk", 6000, "minuman", 50);
    seedMenu.run("Kopi Hitam Tubruk", 4000, "kopi", 50);
    seedMenu.run("Spanish Latte", 18000, "kopi", 50);
    seedMenu.run("Butterscoth Latte", 22000, "kopi", 50);
  });
  seeds();
}

// Seed menu_opsi awal jika kosong
const opsiCount = db.prepare("SELECT COUNT(*) as c FROM menu_opsi").get();
if (opsiCount.c === 0) {
  const seedOpsi = db.prepare(
    "INSERT INTO menu_opsi (tipe, nama, harga, icon, urutan, kategori_menu) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const seedO = db.transaction(() => {
    // Ukuran cup
    seedOpsi.run("ukuran", "Small", 0, "☕", 1, "kopi,minuman");
    seedOpsi.run("ukuran", "Medium", 3000, "☕", 2, "kopi,minuman");
    seedOpsi.run("ukuran", "Large", 5000, "☕", 3, "kopi,minuman");
    // Suhu
    seedOpsi.run("suhu", "Iced", 0, "🧊", 1, "kopi,minuman");
    seedOpsi.run("suhu", "Hot", 0, "🔥", 2, "kopi,minuman");
    // Topping
    seedOpsi.run("topping", "No Topping", 0, "", 1, "kopi,minuman");
    seedOpsi.run("topping", "Sea Salt Cloud", 5000, "", 2, "kopi,minuman");
    seedOpsi.run("topping", "Cheese Cloud", 5000, "", 3, "kopi,minuman");
    seedOpsi.run("topping", "Whipping Cream", 5000, "", 4, "kopi,minuman");
    seedOpsi.run("topping", "Boba", 5000, "", 5, "kopi,minuman");
    // Add-on
    seedOpsi.run("addon", "Sugar Syrup", 0, "", 1, "kopi,minuman");
    seedOpsi.run("addon", "Extra Espresso Shot", 5000, "", 2, "kopi");
    seedOpsi.run("addon", "Caramel Sauce", 5000, "", 3, "kopi,minuman");
    seedOpsi.run("addon", "Hazelnut Syrup", 5000, "", 4, "kopi,minuman");
    seedOpsi.run("addon", "Granola Topping", 3000, "", 5, "kopi,minuman,makanan");
    // Level pedas (untuk makanan)
    seedOpsi.run("level", "Tidak Pedas", 0, "", 1, "makanan");
    seedOpsi.run("level", "Pedas Sedang", 0, "", 2, "makanan");
    seedOpsi.run("level", "Extra Pedas", 0, "", 3, "makanan");
  });
  seedO();
}

// Prepared statements
const insertTransaksi = db.prepare(
  "INSERT INTO transaksi (tanggal, kasir, menu, qty, total, metode, catatan, diskon, diskon_info) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
);
const getAllTransaksi = db.prepare("SELECT * FROM transaksi ORDER BY id ASC");
const getOmzet = db.prepare(
  "SELECT COALESCE(SUM(total), 0) as omzet FROM transaksi",
);
const deleteLastTransaksi = db.prepare(
  "DELETE FROM transaksi WHERE id = (SELECT MAX(id) FROM transaksi)",
);
const deleteAllTransaksi = db.prepare("DELETE FROM transaksi");
const deleteTransaksiHariIni = db.prepare(
  "DELETE FROM transaksi WHERE DATE(created_at) = DATE('now', 'localtime')",
);
const getLastTransaksi = db.prepare(
  "SELECT * FROM transaksi ORDER BY id DESC LIMIT 1",
);
const getAllMenu = db.prepare("SELECT * FROM menu ORDER BY kategori, nama");
const updateStok = db.prepare("UPDATE menu SET stok = ? WHERE id = ?");
const kurangiStok = db.prepare(
  "UPDATE menu SET stok = stok - ? WHERE id = ? AND stok >= ?",
);
const tambahStok = db.prepare("UPDATE menu SET stok = stok + ? WHERE id = ?");

// Setting toko
const getAllSettings = db.prepare("SELECT * FROM setting_toko");
const upsertSetting = db.prepare("INSERT OR REPLACE INTO setting_toko (key, value) VALUES (?, ?)");

// Audit log
const insertAuditLog = db.prepare(
  "INSERT INTO audit_log (user, role, aksi, detail, ip) VALUES (?, ?, ?, ?, ?)"
);
function logAudit(user, role, aksi, detail, ip) {
  try { insertAuditLog.run(user, role, aksi, detail, ip || ""); } catch(e) { console.error("Audit log error:", e); }
}

// Pelanggan
const getAllPelanggan = db.prepare("SELECT * FROM pelanggan ORDER BY nama ASC");
const getPelangganById = db.prepare("SELECT * FROM pelanggan WHERE id = ?");
const getPelangganByTelp = db.prepare("SELECT * FROM pelanggan WHERE telp = ?");
const insertPelanggan = db.prepare(
  "INSERT INTO pelanggan (nama, telp) VALUES (?, ?)",
);
const updatePelangganBelanja = db.prepare(
  "UPDATE pelanggan SET poin = poin + ?, total_belanja = total_belanja + ?, total_kunjungan = total_kunjungan + 1 WHERE id = ?",
);
const updatePelangganPoin = db.prepare(
  "UPDATE pelanggan SET poin = ? WHERE id = ?",
);
const deletePelangganStmt = db.prepare("DELETE FROM pelanggan WHERE id = ?");
const updatePelangganInfo = db.prepare(
  "UPDATE pelanggan SET nama = ?, telp = ? WHERE id = ?",
);

// Pesanan Online
const insertPesananOnline = db.prepare(
  "INSERT INTO pesanan_online (pelanggan_id, nama, alamat, telp, meja, sumber, items, total, diskon, promo_kode, metode, tipe, catatan, status, kode_pesanan, jadwal_ambil) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
);
const getPesananByPelanggan = db.prepare(
  "SELECT * FROM pesanan_online WHERE pelanggan_id = ? ORDER BY id DESC LIMIT 50"
);
const getPesananById = db.prepare("SELECT * FROM pesanan_online WHERE id = ?");
const getPesananPending = db.prepare(
  "SELECT * FROM pesanan_online WHERE status IN ('menunggu', 'diproses', 'siap') ORDER BY id DESC"
);
const updatePesananStatus = db.prepare(
  "UPDATE pesanan_online SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
);

// Favorit
const getFavoritByPelanggan = db.prepare(
  "SELECT menu_id FROM favorit WHERE pelanggan_id = ?"
);
const insertFavorit = db.prepare(
  "INSERT OR IGNORE INTO favorit (pelanggan_id, menu_id) VALUES (?, ?)"
);
const deleteFavorit = db.prepare(
  "DELETE FROM favorit WHERE pelanggan_id = ? AND menu_id = ?"
);

// Promo
const getPromoAktif = db.prepare(
  "SELECT id, kode, nama, deskripsi, tipe, nilai, min_belanja, max_diskon, kuota, terpakai, mulai, selesai FROM promo WHERE aktif = 1 AND DATE('now','localtime') BETWEEN mulai AND selesai AND (kuota = -1 OR terpakai < kuota)"
);
const getPromoByKode = db.prepare(
  "SELECT * FROM promo WHERE kode = ? AND aktif = 1"
);
const incrementPromoUsage = db.prepare(
  "UPDATE promo SET terpakai = terpakai + 1 WHERE id = ?"
);

// Poin config: 1 poin per 10.000 belanja
const POIN_PER_RUPIAH = 10000;

// Generate kode pesanan: WU-YYYYMMDD-NNN
function generateKodePesanan() {
  const now = new Date();
  const tgl = now.toISOString().slice(0, 10).replace(/-/g, "");
  const count = db.prepare(
    "SELECT COUNT(*) as c FROM pesanan_online WHERE DATE(created_at, 'localtime') = DATE('now', 'localtime')"
  ).get().c;
  return `WU-${tgl}-${String(count + 1).padStart(3, "0")}`;
}

function getSemuaData() {
  const rows = getAllTransaksi.all();
  const omzet = getOmzet.get().omzet;
  const history = rows.map((r) => ({
    Tanggal: r.tanggal,
    Kasir: r.kasir,
    Menu: r.menu,
    Qty: r.qty,
    Total: r.total,
    Metode: r.metode,
    Catatan: r.catatan || "",
    Diskon: r.diskon || 0,
    DiskonInfo: r.diskon_info || "",
  }));
  return { history, omzet };
}

const insertBatch = db.transaction((items) => {
  for (const item of items) {
    insertTransaksi.run(
      item.Tanggal,
      item.Kasir,
      item.Menu,
      item.Qty,
      item.Total,
      item.Metode,
      item.Catatan || "",
      item.Diskon || 0,
      item.DiskonInfo || "",
    );
  }
});

console.log(`Database SQLite terhubung: ${dbPath}`);

// ============================================
// 3. API ENDPOINTS
// ============================================
app.use(express.static(path.join(__dirname, "public")));
app.use(express.static(__dirname));

// Login API — verifikasi dari database karyawan
app.post("/api/login", (req, res) => {
  const { username, pin } = req.body;
  // Cek di database dulu
  const akun = db
    .prepare(
      "SELECT * FROM karyawan WHERE username COLLATE BINARY = ? AND pin = ? AND aktif = 1",
    )
    .get(username || "", pin);
  if (!akun) {
    return res
      .status(401)
      .json({ success: false, pesan: "Username atau PIN salah." });
  }
  res.json({
    success: true,
    user: { username: akun.username, role: akun.role },
    hakAkses: HAK_AKSES[akun.role] || [],
  });
});

// Public URL dari tunnel (diisi otomatis saat server start)
let publicURL = null;

// API: info server (IP & port) untuk QR code di halaman web
app.get("/api/server-info", (req, res) => {
  res.json({ ip: getLocalIP(), port: PORT, publicURL: publicURL || null });
});

// API: ambil daftar menu + agregat rating
app.get("/api/menu", (req, res) => {
  const rows = db.prepare(`
    SELECT m.*,
      (SELECT ROUND(AVG(rating), 1) FROM review WHERE menu_id = m.id) AS avg_rating,
      (SELECT COUNT(*) FROM review WHERE menu_id = m.id) AS review_count
    FROM menu m
    ORDER BY m.kategori, m.nama
  `).all();
  res.json(rows);
});

// API: ambil opsi kustomisasi menu (ukuran, suhu, topping, addon)
app.get("/api/menu-opsi", (req, res) => {
  const rows = db
    .prepare("SELECT * FROM menu_opsi WHERE aktif = 1 ORDER BY tipe, urutan")
    .all();
  // Group by tipe
  const grouped = {};
  rows.forEach((r) => {
    if (!grouped[r.tipe]) grouped[r.tipe] = [];
    grouped[r.tipe].push(r);
  });
  res.json(grouped);
});

// API: laporan keuangan — hanya admin & owner
app.get("/api/laporan-keuangan", (req, res) => {
  const role = req.headers["x-role"];
  if (!role || !["admin", "owner"].includes(role)) {
    return res.status(403).json({ success: false, pesan: "Akses ditolak." });
  }
  const data = getSemuaData();
  res.json(data);
});

// API: tambah menu baru — hanya admin & owner
app.post("/api/menu", (req, res) => {
  const role = req.headers["x-role"];
  if (!role || !HAK_AKSES[role]?.includes("kelola_menu")) {
    return res.status(403).json({ success: false, pesan: "Akses ditolak." });
  }
  const { nama, harga, kategori, stok, foto } = req.body;
  if (!nama || !harga || !kategori) {
    return res
      .status(400)
      .json({
        success: false,
        pesan: "Nama, harga, dan kategori wajib diisi.",
      });
  }
  const result = db
    .prepare(
      "INSERT INTO menu (nama, harga, kategori, stok, foto) VALUES (?, ?, ?, ?, ?)",
    )
    .run(nama, parseInt(harga), kategori, parseInt(stok) || 50, foto || "");
  logAudit(req.headers["x-user"] || role, role, "tambah_menu", `${nama} — Rp ${harga} (${kategori})`);
  res.json({ success: true, id: result.lastInsertRowid });
});

// API: update foto menu — hanya admin & owner
app.put("/api/menu/:id/foto", (req, res) => {
  const role = req.headers["x-role"];
  if (!role || !HAK_AKSES[role]?.includes("kelola_menu")) {
    return res.status(403).json({ success: false, pesan: "Akses ditolak." });
  }
  const { foto } = req.body;
  const m = db.prepare("SELECT nama FROM menu WHERE id = ?").get(req.params.id);
  if (!m) return res.status(404).json({ success: false, pesan: "Menu tidak ditemukan." });
  db.prepare("UPDATE menu SET foto = ? WHERE id = ?").run(foto || "", req.params.id);
  logAudit(req.headers["x-user"] || role, role, "ubah_foto_menu", m.nama);
  res.json({ success: true });
});

// ============================================
// REVIEW API
// ============================================
// GET: daftar review per menu
app.get("/api/review/menu/:id", (req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.rating, r.komentar, r.created_at, p.nama AS nama_pelanggan
    FROM review r
    LEFT JOIN pelanggan p ON p.id = r.pelanggan_id
    WHERE r.menu_id = ?
    ORDER BY r.id DESC
    LIMIT 50
  `).all(req.params.id);
  res.json({ success: true, data: rows });
});

// POST: customer submit review (butuh pelanggan_id & menu_id)
app.post("/api/review", (req, res) => {
  const { menu_id, pelanggan_id, pesanan_id, rating, komentar } = req.body;
  const r = parseInt(rating);
  if (!menu_id || !pelanggan_id || !r || r < 1 || r > 5) {
    return res.status(400).json({ success: false, pesan: "Data review tidak valid." });
  }
  // Satu pelanggan hanya bisa review 1x per menu per pesanan (kalau pesanan_id=0, boleh unlimited)
  if (pesanan_id && pesanan_id > 0) {
    const exists = db.prepare(
      "SELECT id FROM review WHERE pelanggan_id = ? AND menu_id = ? AND pesanan_id = ?"
    ).get(pelanggan_id, menu_id, pesanan_id);
    if (exists) {
      return res.status(400).json({ success: false, pesan: "Menu ini sudah direview." });
    }
  }
  db.prepare(
    "INSERT INTO review (menu_id, pelanggan_id, pesanan_id, rating, komentar) VALUES (?, ?, ?, ?, ?)"
  ).run(menu_id, pelanggan_id, pesanan_id || 0, r, (komentar || "").slice(0, 300));
  res.json({ success: true });
});

// ============================================
// PUSH NOTIFICATION (APP PELANGGAN)
// ============================================
// Customer app subscribe notif
app.post("/api/app-push-subscribe", (req, res) => {
  const { subscription, pelanggan_id } = req.body;
  if (!subscription || !subscription.endpoint) return res.status(400).json({ success: false });
  db.prepare(
    "INSERT OR REPLACE INTO push_pelanggan (pelanggan_id, endpoint, subscription) VALUES (?, ?, ?)"
  ).run(pelanggan_id || 0, subscription.endpoint, JSON.stringify(subscription));
  res.json({ success: true });
});

// Admin broadcast promo push notification
app.post("/api/broadcast-promo", async (req, res) => {
  const role = req.headers["x-role"];
  if (!role || !["admin", "owner"].includes(role)) {
    return res.status(403).json({ success: false, pesan: "Akses ditolak." });
  }
  const { title, body, url } = req.body;
  if (!title || !body) return res.status(400).json({ success: false, pesan: "Title & body wajib." });
  const subs = db.prepare("SELECT id, endpoint, subscription FROM push_pelanggan").all();
  const payload = JSON.stringify({
    title: title.slice(0, 80),
    body: body.slice(0, 200),
    icon: "/icon-192.svg",
    badge: "/icon-192.svg",
    tag: "promo-" + Date.now(),
    url: url || "/app",
  });
  let sent = 0, failed = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webPush.sendNotification(JSON.parse(s.subscription), payload);
      sent++;
    } catch (err) {
      failed++;
      // Hapus subscription yg sudah expired (410 Gone)
      if (err.statusCode === 410 || err.statusCode === 404) {
        db.prepare("DELETE FROM push_pelanggan WHERE id = ?").run(s.id);
      }
    }
  }));
  logAudit(req.headers["x-user"] || role, role, "broadcast_promo", `${title} → ${sent} terkirim, ${failed} gagal`);
  res.json({ success: true, sent, failed, total: subs.length });
});

// ============================================
// OTP VERIFIKASI (WhatsApp via Fonnte)
// ============================================
const FONNTE_TOKEN = process.env.FONNTE_TOKEN || "";
const OTP_EXPIRE_MINUTES = 5;
const OTP_MAX_ATTEMPTS = 3;
const OTP_COOLDOWN_SECONDS = 60; // jeda antar request OTP
const OTP_REQUEST_LIMIT = 5;     // max 5 OTP per 10 menit per nomor
const REGISTER_WINDOW_MINUTES = 30; // OTP verified berlaku 30 menit untuk register

// Normalize nomor: 0812... / +62812... / 62812... → 62812...
function normalizeTelp(raw) {
  if (!raw) return "";
  let t = String(raw).replace(/[^\d]/g, "");
  if (t.startsWith("0")) t = "62" + t.slice(1);
  else if (t.startsWith("62")) { /* noop */ }
  else if (t.startsWith("8")) t = "62" + t;
  return t;
}

function generateOtpCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// Kirim pesan WhatsApp via Fonnte API
async function sendWhatsApp(target, message) {
  if (!FONNTE_TOKEN) {
    console.log(`[OTP-DEV] WA to ${target}:\n${message}`);
    return { success: true, dev: true };
  }
  try {
    const form = new URLSearchParams();
    form.append("target", target);
    form.append("message", message);
    form.append("countryCode", "62");
    const res = await fetch("https://api.fonnte.com/send", {
      method: "POST",
      headers: { Authorization: FONNTE_TOKEN },
      body: form,
    });
    const data = await res.json().catch(() => ({}));
    if (data.status === false) {
      console.error("[FONNTE ERROR]", data);
      return { success: false, error: data.reason || "Gagal kirim WA." };
    }
    return { success: true, data };
  } catch (err) {
    console.error("[FONNTE EXCEPTION]", err.message);
    return { success: false, error: err.message };
  }
}

// POST /api/otp/request — generate + kirim OTP
app.post("/api/otp/request", async (req, res) => {
  const telp = normalizeTelp(req.body?.telp);
  if (!telp || telp.length < 10 || telp.length > 14) {
    return res.status(400).json({ success: false, pesan: "Nomor WhatsApp tidak valid." });
  }
  // Cek nomor sudah terdaftar → tolak (biar gak bisa dipakai duplicate)
  const existing = db.prepare("SELECT id FROM pelanggan WHERE telp = ?").get(telp);
  if (existing) {
    return res.status(400).json({ success: false, pesan: "Nomor ini sudah terdaftar. Silakan login." });
  }
  // Rate limit: cooldown antar request
  const recent = db.prepare(
    "SELECT created_at FROM otp_verification WHERE telp = ? ORDER BY id DESC LIMIT 1"
  ).get(telp);
  if (recent) {
    const delta = (Date.now() - new Date(recent.created_at).getTime()) / 1000;
    if (delta < OTP_COOLDOWN_SECONDS) {
      return res.status(429).json({
        success: false,
        pesan: `Tunggu ${Math.ceil(OTP_COOLDOWN_SECONDS - delta)} detik sebelum request lagi.`,
      });
    }
  }
  // Rate limit: max 5 request per 10 menit
  const recentCount = db.prepare(
    "SELECT COUNT(*) as c FROM otp_verification WHERE telp = ? AND datetime(created_at) > datetime('now','-10 minutes')"
  ).get(telp).c;
  if (recentCount >= OTP_REQUEST_LIMIT) {
    return res.status(429).json({
      success: false,
      pesan: "Terlalu banyak permintaan OTP. Coba lagi 10 menit lagi.",
    });
  }
  // Generate OTP & simpan
  const kode = generateOtpCode();
  const expiredAt = new Date(Date.now() + OTP_EXPIRE_MINUTES * 60 * 1000).toISOString();
  db.prepare(
    "INSERT INTO otp_verification (telp, kode, expired_at) VALUES (?, ?, ?)"
  ).run(telp, kode, expiredAt);
  // Kirim via WA
  const message = `🌙 *Cafe Soluna*\n\nKode verifikasi Anda: *${kode}*\n\nMasukkan kode ini di aplikasi untuk menyelesaikan pendaftaran.\n\n⏱️ Berlaku ${OTP_EXPIRE_MINUTES} menit.\nJangan bagikan ke siapapun.`;
  const waRes = await sendWhatsApp(telp, message);
  if (!waRes.success) {
    return res.status(500).json({
      success: false,
      pesan: "Gagal kirim OTP. Pastikan nomor WA aktif & coba lagi.",
    });
  }
  res.json({
    success: true,
    pesan: `OTP dikirim ke ${telp.replace(/^62/, "0").replace(/(\d{4})(\d{4})(\d+)/, "$1-$2-$3")}`,
    expired_in_seconds: OTP_EXPIRE_MINUTES * 60,
    dev_mode: waRes.dev || false,
    // Hanya di dev mode (no FONNTE_TOKEN), kirim kode ke response untuk testing
    dev_code: waRes.dev ? kode : undefined,
  });
});

// POST /api/otp/verify — validasi kode
app.post("/api/otp/verify", (req, res) => {
  const telp = normalizeTelp(req.body?.telp);
  const kode = String(req.body?.kode || "").trim();
  if (!telp || !kode) {
    return res.status(400).json({ success: false, pesan: "Nomor & kode wajib." });
  }
  // Ambil OTP aktif terbaru
  const otp = db.prepare(
    "SELECT * FROM otp_verification WHERE telp = ? AND used = 0 AND datetime(expired_at) > datetime('now') ORDER BY id DESC LIMIT 1"
  ).get(telp);
  if (!otp) {
    return res.status(400).json({ success: false, pesan: "Kode tidak ditemukan atau sudah kadaluarsa. Silakan request ulang." });
  }
  if (otp.attempts >= OTP_MAX_ATTEMPTS) {
    return res.status(429).json({ success: false, pesan: "Terlalu banyak percobaan. Request OTP baru." });
  }
  if (otp.kode !== kode) {
    db.prepare("UPDATE otp_verification SET attempts = attempts + 1 WHERE id = ?").run(otp.id);
    const sisa = OTP_MAX_ATTEMPTS - (otp.attempts + 1);
    return res.status(400).json({
      success: false,
      pesan: `Kode salah. Sisa percobaan: ${Math.max(0, sisa)}.`,
    });
  }
  // Mark verified
  db.prepare(
    "UPDATE otp_verification SET used = 1, verified_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(otp.id);
  res.json({ success: true, telp, pesan: "Verifikasi berhasil. Silakan lanjutkan pendaftaran." });
});

// Helper: cek apakah nomor sudah terverifikasi belum lama ini
function isRecentlyVerified(telp) {
  const row = db.prepare(
    `SELECT id FROM otp_verification
     WHERE telp = ? AND used = 1 AND verified_at IS NOT NULL
       AND datetime(verified_at) > datetime('now','-${REGISTER_WINDOW_MINUTES} minutes')
     ORDER BY id DESC LIMIT 1`
  ).get(telp);
  return !!row;
}

// ============================================
// PENGELUARAN OPERASIONAL — admin & owner
// ============================================
const PENGELUARAN_KATEGORI = [
  "Bahan Baku", "Gaji Karyawan", "Listrik & Air", "Sewa Tempat",
  "Kemasan", "Peralatan", "Marketing", "Transportasi", "Lain-lain",
];

// GET list pengeluaran (filter tanggal & kategori opsional)
app.get("/api/pengeluaran", (req, res) => {
  const role = req.headers["x-role"];
  if (!role || !["admin", "owner"].includes(role)) {
    return res.status(403).json({ success: false, pesan: "Akses ditolak." });
  }
  const { tanggal_dari, tanggal_sampai, kategori } = req.query;
  const today = new Date().toISOString().split("T")[0];
  const dari = tanggal_dari || today;
  const sampai = tanggal_sampai || today;
  let sql = "SELECT * FROM pengeluaran WHERE tanggal BETWEEN ? AND ?";
  const params = [dari, sampai];
  if (kategori && kategori !== "semua") { sql += " AND kategori = ?"; params.push(kategori); }
  sql += " ORDER BY tanggal DESC, id DESC";
  const rows = db.prepare(sql).all(...params);
  const totals = db.prepare(
    "SELECT kategori, COALESCE(SUM(nominal),0) as total FROM pengeluaran WHERE tanggal BETWEEN ? AND ? GROUP BY kategori ORDER BY total DESC"
  ).all(dari, sampai);
  const grandTotal = rows.reduce((s, r) => s + r.nominal, 0);
  res.json({ success: true, data: rows, totals, grandTotal, kategori: PENGELUARAN_KATEGORI });
});

// POST tambah pengeluaran
app.post("/api/pengeluaran", (req, res) => {
  const role = req.headers["x-role"];
  if (!role || !["admin", "owner"].includes(role)) {
    return res.status(403).json({ success: false, pesan: "Akses ditolak." });
  }
  const { tanggal, kategori, keterangan, nominal } = req.body;
  const tgl = tanggal || new Date().toISOString().split("T")[0];
  const nom = parseInt(nominal);
  if (!kategori || !nom || nom <= 0) {
    return res.status(400).json({ success: false, pesan: "Kategori & nominal (>0) wajib." });
  }
  const user = req.headers["x-user"] || role;
  const result = db.prepare(
    "INSERT INTO pengeluaran (tanggal, kategori, keterangan, nominal, dibuat_oleh) VALUES (?, ?, ?, ?, ?)"
  ).run(tgl, kategori, (keterangan || "").slice(0, 200), nom, user);
  logAudit(user, role, "tambah_pengeluaran", `${kategori}: Rp ${nom.toLocaleString("id-ID")} — ${keterangan || "-"}`);
  res.json({ success: true, id: result.lastInsertRowid });
});

// DELETE pengeluaran
app.delete("/api/pengeluaran/:id", (req, res) => {
  const role = req.headers["x-role"];
  if (!role || !["admin", "owner"].includes(role)) {
    return res.status(403).json({ success: false, pesan: "Akses ditolak." });
  }
  const row = db.prepare("SELECT * FROM pengeluaran WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ success: false, pesan: "Tidak ditemukan." });
  db.prepare("DELETE FROM pengeluaran WHERE id = ?").run(req.params.id);
  logAudit(req.headers["x-user"] || role, role, "hapus_pengeluaran", `${row.kategori}: Rp ${row.nominal.toLocaleString("id-ID")}`);
  res.json({ success: true });
});

// GET profit bersih per periode (omzet - pengeluaran)
app.get("/api/profit-bersih", (req, res) => {
  const role = req.headers["x-role"];
  if (!role || !["admin", "owner"].includes(role)) {
    return res.status(403).json({ success: false, pesan: "Akses ditolak." });
  }
  const today = new Date().toISOString().split("T")[0];
  const dari = req.query.dari || today;
  const sampai = req.query.sampai || today;
  const omzet = db.prepare(
    "SELECT COALESCE(SUM(total),0) as total FROM transaksi WHERE date(created_at,'localtime') BETWEEN ? AND ?"
  ).get(dari, sampai).total;
  const pengeluaran = db.prepare(
    "SELECT COALESCE(SUM(nominal),0) as total FROM pengeluaran WHERE tanggal BETWEEN ? AND ?"
  ).get(dari, sampai).total;
  res.json({
    success: true,
    periode: { dari, sampai },
    omzet,
    pengeluaran,
    profit_bersih: omzet - pengeluaran,
    margin: omzet > 0 ? Math.round(((omzet - pengeluaran) / omzet) * 100) : 0,
  });
});

// API: hapus menu — hanya admin & owner
app.delete("/api/menu/:id", (req, res) => {
  const role = req.headers["x-role"];
  if (!role || !HAK_AKSES[role]?.includes("kelola_menu")) {
    return res.status(403).json({ success: false, pesan: "Akses ditolak." });
  }
  const menuInfo = db.prepare("SELECT nama FROM menu WHERE id = ?").get(req.params.id);
  db.prepare("DELETE FROM menu WHERE id = ?").run(req.params.id);
  logAudit(req.headers["x-user"] || role, role, "hapus_menu", menuInfo?.nama || `ID: ${req.params.id}`);
  res.json({ success: true });
});

// API: update stok menu — hanya admin & owner
app.put("/api/menu/:id/stok", (req, res) => {
  const role = req.headers["x-role"];
  if (!role || !HAK_AKSES[role]?.includes("kelola_stok")) {
    return res.status(403).json({ success: false, pesan: "Akses ditolak." });
  }
  const { stok } = req.body;
  if (stok == null || stok < 0) {
    return res.status(400).json({ success: false, pesan: "Stok tidak valid." });
  }
  const menuForLog = db.prepare("SELECT nama FROM menu WHERE id = ?").get(req.params.id);
  updateStok.run(stok, req.params.id);
  logAudit(req.headers["x-user"] || role, role, "ubah_stok", `${menuForLog?.nama || 'ID:' + req.params.id} → stok: ${stok}`);
  res.json({ success: true });
});

// ============================================
// KARYAWAN API
// ============================================
app.get("/api/karyawan", (req, res) => {
  const role = req.headers["x-role"];
  if (!role || !["admin", "owner"].includes(role)) {
    return res.status(403).json({ success: false, pesan: "Akses ditolak." });
  }
  const rows = db
    .prepare(
      "SELECT id, username, role, aktif, created_at FROM karyawan ORDER BY role, username",
    )
    .all();
  res.json(rows);
});

app.post("/api/karyawan", (req, res) => {
  const role = req.headers["x-role"];
  if (!role || !["admin", "owner"].includes(role)) {
    return res.status(403).json({ success: false, pesan: "Akses ditolak." });
  }
  const { username, pin, karyawanRole } = req.body;
  if (!username || !pin)
    return res
      .status(400)
      .json({ success: false, pesan: "Username dan PIN wajib diisi." });
  if (pin.length < 4)
    return res
      .status(400)
      .json({ success: false, pesan: "PIN minimal 4 digit." });
  // Cek duplikat
  const exists = db
    .prepare("SELECT id FROM karyawan WHERE LOWER(username) = LOWER(?)")
    .get(username.trim());
  if (exists)
    return res
      .status(400)
      .json({ success: false, pesan: "Username sudah dipakai." });
  // Owner hanya bisa tambah kasir, admin bisa tambah semua
  const allowedRoles = role === "admin" ? ["kasir", "owner"] : ["kasir"];
  const finalRole = allowedRoles.includes(karyawanRole)
    ? karyawanRole
    : "kasir";
  const result = db
    .prepare("INSERT INTO karyawan (username, pin, role) VALUES (?, ?, ?)")
    .run(username.trim(), pin, finalRole);
  logAudit(req.headers["x-user"] || role, role, "tambah_karyawan", `${username.trim()} (${finalRole})`);
  res.json({ success: true, id: result.lastInsertRowid });
});

app.put("/api/karyawan/:id", (req, res) => {
  const role = req.headers["x-role"];
  if (!role || !["admin", "owner"].includes(role)) {
    return res.status(403).json({ success: false, pesan: "Akses ditolak." });
  }
  const { username, pin, karyawanRole, aktif } = req.body;
  const target = db
    .prepare("SELECT * FROM karyawan WHERE id = ?")
    .get(req.params.id);
  if (!target)
    return res
      .status(404)
      .json({ success: false, pesan: "Karyawan tidak ditemukan." });
  // Jangan bisa edit akun admin utama
  if (target.username === "admin" && role !== "admin") {
    return res
      .status(403)
      .json({ success: false, pesan: "Tidak bisa edit akun admin." });
  }
  if (username && username.trim()) {
    const dup = db
      .prepare(
        "SELECT id FROM karyawan WHERE LOWER(username) = LOWER(?) AND id != ?",
      )
      .get(username.trim(), req.params.id);
    if (dup)
      return res
        .status(400)
        .json({ success: false, pesan: "Username sudah dipakai." });
    db.prepare("UPDATE karyawan SET username = ? WHERE id = ?").run(
      username.trim(),
      req.params.id,
    );
  }
  if (pin && pin.length >= 4)
    db.prepare("UPDATE karyawan SET pin = ? WHERE id = ?").run(
      pin,
      req.params.id,
    );
  if (karyawanRole && ["kasir", "owner"].includes(karyawanRole)) {
    db.prepare("UPDATE karyawan SET role = ? WHERE id = ?").run(
      karyawanRole,
      req.params.id,
    );
  }
  if (aktif !== undefined)
    db.prepare("UPDATE karyawan SET aktif = ? WHERE id = ?").run(
      aktif ? 1 : 0,
      req.params.id,
    );
  logAudit(req.headers["x-user"] || role, role, "ubah_karyawan", `${target.username} (ID:${req.params.id})`);
  res.json({ success: true });
});

app.delete("/api/karyawan/:id", (req, res) => {
  const role = req.headers["x-role"];
  if (!role || !["admin"].includes(role)) {
    return res
      .status(403)
      .json({ success: false, pesan: "Hanya admin yang bisa hapus karyawan." });
  }
  const target = db
    .prepare("SELECT * FROM karyawan WHERE id = ?")
    .get(req.params.id);
  if (!target)
    return res
      .status(404)
      .json({ success: false, pesan: "Karyawan tidak ditemukan." });
  if (target.username === "admin")
    return res
      .status(403)
      .json({ success: false, pesan: "Tidak bisa hapus akun admin." });
  db.prepare("DELETE FROM karyawan WHERE id = ?").run(req.params.id);
  logAudit(req.headers["x-user"] || role, role, "hapus_karyawan", `${target.username} (${target.role})`);
  res.json({ success: true });
});

// ============================================
// PELANGGAN AUTH (Register & Login untuk app)
// ============================================
app.post("/api/pelanggan/register", (req, res) => {
  const { username, password, nama, telp } = req.body;
  if (!username || !username.trim()) return res.status(400).json({ success: false, pesan: "Username wajib diisi." });
  if (!password || password.length < 4) return res.status(400).json({ success: false, pesan: "Password minimal 4 karakter." });
  if (!nama || !nama.trim()) return res.status(400).json({ success: false, pesan: "Nama wajib diisi." });
  if (!telp || !telp.trim()) return res.status(400).json({ success: false, pesan: "Nomor WhatsApp wajib diisi." });

  const telpNorm = normalizeTelp(telp);
  if (telpNorm.length < 10 || telpNorm.length > 14) {
    return res.status(400).json({ success: false, pesan: "Format nomor WhatsApp tidak valid." });
  }

  // Wajib OTP terverifikasi dalam 30 menit terakhir
  if (!isRecentlyVerified(telpNorm)) {
    return res.status(400).json({
      success: false,
      pesan: "Nomor WhatsApp belum diverifikasi. Silakan verifikasi OTP dulu.",
      need_otp: true,
    });
  }

  const existingUsername = db.prepare("SELECT id FROM pelanggan WHERE username = ?").get(username.trim().toLowerCase());
  if (existingUsername) return res.status(400).json({ success: false, pesan: "Username sudah dipakai." });

  const existingTelp = db.prepare("SELECT id FROM pelanggan WHERE telp = ?").get(telpNorm);
  if (existingTelp) return res.status(400).json({ success: false, pesan: "Nomor WhatsApp sudah terdaftar." });

  const result = db.prepare("INSERT INTO pelanggan (nama, telp, username, password) VALUES (?, ?, ?, ?)").run(
    nama.trim(), telpNorm, username.trim().toLowerCase(), password
  );
  const plg = db.prepare("SELECT id, nama, telp, username, poin, total_belanja, total_kunjungan FROM pelanggan WHERE id = ?").get(result.lastInsertRowid);
  res.json({ success: true, pelanggan: plg });
});

app.post("/api/pelanggan/login", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ success: false, pesan: "Username dan password wajib diisi." });

  const plg = db.prepare("SELECT id, nama, telp, username, password, poin, total_belanja, total_kunjungan FROM pelanggan WHERE username = ?").get(username.trim().toLowerCase());
  if (!plg || plg.password !== password) return res.status(401).json({ success: false, pesan: "Username atau password salah." });

  const { password: _, ...data } = plg;
  res.json({ success: true, pelanggan: data });
});

// ============================================
// PELANGGAN (CRM) API
// ============================================
app.get("/api/pelanggan", (req, res) => {
  res.json(getAllPelanggan.all());
});

app.get("/api/pelanggan/cari-telp/:telp", (req, res) => {
  const plg = getPelangganByTelp.get(req.params.telp);
  if (plg) res.json({ found: true, pelanggan: plg });
  else res.json({ found: false });
});

app.post("/api/pelanggan", (req, res) => {
  const role = req.headers["x-role"];
  if (!role || !["admin", "owner", "kasir"].includes(role)) {
    return res.status(403).json({ success: false, pesan: "Akses ditolak." });
  }
  const { nama, telp } = req.body;
  if (!nama || !nama.trim())
    return res.status(400).json({ success: false, pesan: "Nama wajib diisi." });
  const result = insertPelanggan.run(nama.trim(), (telp || "").trim());
  res.json({ success: true, id: result.lastInsertRowid });
});

app.put("/api/pelanggan/:id", (req, res) => {
  const role = req.headers["x-role"];
  if (!role || !["admin", "owner"].includes(role)) {
    return res.status(403).json({ success: false, pesan: "Akses ditolak." });
  }
  const { nama, telp } = req.body;
  if (!nama || !nama.trim())
    return res.status(400).json({ success: false, pesan: "Nama wajib diisi." });
  updatePelangganInfo.run(nama.trim(), (telp || "").trim(), req.params.id);
  res.json({ success: true });
});

app.delete("/api/pelanggan/:id", (req, res) => {
  const role = req.headers["x-role"];
  if (!role || !["admin", "owner"].includes(role)) {
    return res.status(403).json({ success: false, pesan: "Akses ditolak." });
  }
  deletePelangganStmt.run(req.params.id);
  res.json({ success: true });
});

// Membership tier config (berdasarkan total_belanja)
const TIER_CONFIG = [
  { id: "bronze",   nama: "Bronze",   emoji: "🥉", min_belanja: 0,        bonus_pct: 0,  color: "#c97b38" },
  { id: "silver",   nama: "Silver",   emoji: "🥈", min_belanja: 500000,   bonus_pct: 25, color: "#94a3b8" },
  { id: "gold",     nama: "Gold",     emoji: "🥇", min_belanja: 2000000,  bonus_pct: 50, color: "#f59e0b" },
  { id: "platinum", nama: "Platinum", emoji: "💎", min_belanja: 5000000,  bonus_pct: 100, color: "#8b5cf6" },
];

function getTierFor(totalBelanja) {
  let current = TIER_CONFIG[0];
  for (const t of TIER_CONFIG) {
    if (totalBelanja >= t.min_belanja) current = t;
  }
  const idx = TIER_CONFIG.findIndex(t => t.id === current.id);
  const next = TIER_CONFIG[idx + 1] || null;
  return {
    current,
    next,
    progress: next ? Math.min(100, Math.round(((totalBelanja - current.min_belanja) / (next.min_belanja - current.min_belanja)) * 100)) : 100,
    butuh_lagi: next ? next.min_belanja - totalBelanja : 0,
  };
}

// Tier info pelanggan
app.get("/api/pelanggan/:id/tier-info", (req, res) => {
  const plg = getPelangganById.get(req.params.id);
  if (!plg) return res.status(404).json({ success: false, pesan: "Tidak ditemukan." });
  const tier = getTierFor(plg.total_belanja || 0);
  res.json({
    success: true,
    poin: plg.poin,
    total_belanja: plg.total_belanja,
    total_kunjungan: plg.total_kunjungan,
    poin_per_rupiah: POIN_PER_RUPIAH,
    diskon_per_poin: 300,
    tier: tier.current,
    next_tier: tier.next,
    tier_progress: tier.progress,
    butuh_lagi: tier.butuh_lagi,
  });
});

// Tukar poin
app.post("/api/pelanggan/:id/tukar-poin", (req, res) => {
  const role = req.headers["x-role"];
  if (!role || !["admin", "owner", "kasir"].includes(role)) {
    return res.status(403).json({ success: false, pesan: "Akses ditolak." });
  }
  const { poin } = req.body;
  const plg = getPelangganById.get(req.params.id);
  if (!plg)
    return res
      .status(404)
      .json({ success: false, pesan: "Pelanggan tidak ditemukan." });
  if (!poin || poin <= 0 || poin > plg.poin) {
    return res
      .status(400)
      .json({ success: false, pesan: "Poin tidak valid atau tidak cukup." });
  }
  updatePelangganPoin.run(plg.poin - poin, req.params.id);
  const diskon = poin * 300; // 1 poin = Rp 300 diskon
  res.json({ success: true, diskon, sisaPoin: plg.poin - poin });
});

// ============================================
// PELANGGAN APP API (Profil, Pesanan, Favorit)
// ============================================

// Profil
app.get("/api/pelanggan/:id/profil", (req, res) => {
  const plg = db.prepare(
    "SELECT id, nama, telp, username, alamat, poin, total_belanja, total_kunjungan, created_at FROM pelanggan WHERE id = ?"
  ).get(req.params.id);
  if (!plg) return res.status(404).json({ success: false, pesan: "Tidak ditemukan." });
  res.json({ success: true, pelanggan: plg });
});

app.put("/api/pelanggan/:id/profil", (req, res) => {
  const { nama, telp, alamat } = req.body;
  if (!nama || !nama.trim()) return res.status(400).json({ success: false, pesan: "Nama wajib diisi." });
  db.prepare("UPDATE pelanggan SET nama = ?, telp = ?, alamat = ? WHERE id = ?").run(
    nama.trim(), (telp || "").trim(), (alamat || "").trim(), req.params.id
  );
  res.json({ success: true });
});

app.put("/api/pelanggan/:id/password", (req, res) => {
  const { passwordLama, passwordBaru } = req.body;
  if (!passwordBaru || passwordBaru.length < 4) return res.status(400).json({ success: false, pesan: "Password baru minimal 4 karakter." });
  const plg = db.prepare("SELECT password FROM pelanggan WHERE id = ?").get(req.params.id);
  if (!plg) return res.status(404).json({ success: false, pesan: "Tidak ditemukan." });
  if (plg.password !== passwordLama) return res.status(400).json({ success: false, pesan: "Password lama salah." });
  db.prepare("UPDATE pelanggan SET password = ? WHERE id = ?").run(passwordBaru, req.params.id);
  res.json({ success: true });
});

// Riwayat Pesanan
app.get("/api/pelanggan/:id/pesanan", (req, res) => {
  const rows = getPesananByPelanggan.all(req.params.id);
  const pesanan = rows.map(r => ({ ...r, items: JSON.parse(r.items) }));
  res.json({ success: true, pesanan });
});

app.get("/api/pesanan-online/:id", (req, res) => {
  const row = getPesananById.get(req.params.id);
  if (!row) return res.status(404).json({ success: false });
  res.json({ success: true, pesanan: { ...row, items: JSON.parse(row.items) } });
});

app.put("/api/pesanan-online/:id/status", (req, res) => {
  const { status } = req.body;
  const valid = ["menunggu", "diproses", "siap", "selesai"];
  if (!valid.includes(status)) return res.status(400).json({ success: false, pesan: "Status tidak valid." });
  updatePesananStatus.run(status, req.params.id);
  const pesanan = getPesananById.get(req.params.id);
  if (pesanan) {
    io.emit("order-status-changed", {
      pesananId: pesanan.id,
      kodePesanan: pesanan.kode_pesanan,
      pelangganId: pesanan.pelanggan_id,
      status,
    });
  }
  res.json({ success: true });
});

// Favorit
app.get("/api/pelanggan/:id/favorit", (req, res) => {
  const rows = getFavoritByPelanggan.all(req.params.id);
  res.json({ success: true, favorit: rows.map(r => r.menu_id) });
});

app.post("/api/pelanggan/:id/favorit", (req, res) => {
  const { menuId } = req.body;
  if (!menuId) return res.status(400).json({ success: false });
  insertFavorit.run(req.params.id, menuId);
  res.json({ success: true });
});

app.delete("/api/pelanggan/:id/favorit/:menuId", (req, res) => {
  deleteFavorit.run(req.params.id, req.params.menuId);
  res.json({ success: true });
});

// Promo
app.get("/api/promo/aktif", (req, res) => {
  res.json({ success: true, promo: getPromoAktif.all() });
});

app.post("/api/promo/validasi", (req, res) => {
  const { kode, total } = req.body;
  if (!kode) return res.status(400).json({ success: false, pesan: "Kode promo wajib diisi." });
  const promo = getPromoByKode.get(kode.toUpperCase());
  if (!promo) return res.status(404).json({ success: false, pesan: "Kode promo tidak ditemukan." });
  const now = new Date().toISOString().slice(0, 10);
  if (now < promo.mulai || now > promo.selesai) return res.status(400).json({ success: false, pesan: "Promo sudah berakhir." });
  if (promo.kuota !== -1 && promo.terpakai >= promo.kuota) return res.status(400).json({ success: false, pesan: "Kuota promo sudah habis." });
  if (total < promo.min_belanja) return res.status(400).json({ success: false, pesan: `Minimum belanja Rp ${promo.min_belanja.toLocaleString("id-ID")}.` });

  let diskon = 0;
  if (promo.tipe === "persen") {
    diskon = Math.floor(total * promo.nilai / 100);
    if (promo.max_diskon > 0 && diskon > promo.max_diskon) diskon = promo.max_diskon;
  } else {
    diskon = promo.nilai;
  }
  if (diskon > total) diskon = total;

  res.json({ success: true, promo: { id: promo.id, kode: promo.kode, nama: promo.nama, tipe: promo.tipe, nilai: promo.nilai }, diskon });
});

app.post("/api/promo", (req, res) => {
  const role = req.headers["x-role"];
  if (!role || !["admin", "owner"].includes(role)) return res.status(403).json({ success: false, pesan: "Akses ditolak." });
  const { kode, nama, deskripsi, tipe, nilai, min_belanja, max_diskon, kuota, mulai, selesai } = req.body;
  if (!kode || !nama || !tipe || !nilai || !mulai || !selesai) return res.status(400).json({ success: false, pesan: "Data tidak lengkap." });
  try {
    const result = db.prepare(
      "INSERT INTO promo (kode, nama, deskripsi, tipe, nilai, min_belanja, max_diskon, kuota, mulai, selesai) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(kode.toUpperCase(), nama, deskripsi || "", tipe, nilai, min_belanja || 0, max_diskon || 0, kuota || -1, mulai, selesai);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ success: false, pesan: "Kode promo sudah ada." });
  }
});

// ============================================
// SHIFT API
// ============================================
// Jam operasional: Senin-Jumat 08:00-22:00, Sabtu-Minggu 08:00-00:00
// Shift 1 (Pagi): 08:00 - 15:00, Shift 2 (Sore): 15:00 - tutup
const SHIFT_CONFIG = [
  { nama: "Pagi", mulai: "08:00", selesai: "15:00", icon: "🌅" },
  { nama: "Sore", mulai: "15:00", selesai: "22:00", icon: "🌙" },
];

function getJamTutup() {
  const hari = new Date().getDay(); // 0=Minggu, 6=Sabtu
  return (hari === 0 || hari === 6) ? 0 : 22; // Sabtu-Minggu tutup jam 00:00, Senin-Jumat jam 22:00
}

function getShiftOtomatis() {
  const jam = new Date().getHours();
  if (jam >= 8 && jam < 15) return "Pagi";
  return "Sore";
}

function getJamOperasional() {
  const hari = new Date().getDay();
  const isWeekend = (hari === 0 || hari === 6);
  return {
    buka: "08:00",
    tutup: isWeekend ? "00:00" : "22:00",
    label: isWeekend ? "Sabtu/Minggu: 08:00 - 00:00" : "Senin-Jumat: 08:00 - 22:00",
    isWeekend,
  };
}

// Clock In
// Helper: konversi ISO UTC ke format lokal SQLite (YYYY-MM-DD HH:MM:SS)
function isoToLocalSql(isoStr) {
  if (!isoStr) return null;
  const d = new Date(isoStr);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Helper: hitung omzet shift dengan format waktu yang benar
function hitungOmzetShift(username, clockInIso, clockOutIso) {
  const clockInLocal = isoToLocalSql(clockInIso);
  const clockOutLocal = isoToLocalSql(clockOutIso);
  const whereClause = clockOutLocal
    ? "kasir = ? AND created_at >= ? AND created_at <= ?"
    : "kasir = ? AND created_at >= ?";
  const params = clockOutLocal
    ? [username, clockInLocal, clockOutLocal]
    : [username, clockInLocal];
  const total = db.prepare(
    `SELECT COUNT(*) as trx, COALESCE(SUM(total),0) as omzet,
            COALESCE(SUM(CASE WHEN LOWER(metode) = 'tunai' THEN total ELSE 0 END),0) as kas_tunai
     FROM transaksi WHERE ${whereClause}`,
  ).get(...params);
  return total;
}

// Helper: close shift aktif, hitung omzet, + kas opname opsional
function closeShift(shiftRow, clockOutIso, kasOpname) {
  const trxData = hitungOmzetShift(shiftRow.username, shiftRow.clock_in, clockOutIso);
  if (kasOpname && kasOpname.kas_fisik != null) {
    const kasExpected = trxData.kas_tunai || 0;
    const kasFisik = parseInt(kasOpname.kas_fisik) || 0;
    const selisih = kasFisik - kasExpected;
    db.prepare(
      `UPDATE shift_log
       SET clock_out = ?, total_transaksi = ?, total_omzet = ?,
           kas_fisik = ?, kas_expected = ?, kas_selisih = ?, kas_catatan = ?,
           status = 'selesai'
       WHERE id = ?`,
    ).run(clockOutIso, trxData.trx, trxData.omzet, kasFisik, kasExpected, selisih, kasOpname.catatan || "", shiftRow.id);
    return { ...trxData, kas_fisik: kasFisik, kas_expected: kasExpected, kas_selisih: selisih };
  }
  db.prepare(
    "UPDATE shift_log SET clock_out = ?, total_transaksi = ?, total_omzet = ?, status = 'selesai' WHERE id = ?",
  ).run(clockOutIso, trxData.trx, trxData.omzet, shiftRow.id);
  return trxData;
}

app.post("/api/shift/clock-in", (req, res) => {
  const role = req.headers["x-role"];
  if (!role || !["admin", "owner", "kasir"].includes(role)) {
    return res.status(403).json({ success: false, pesan: "Akses ditolak." });
  }
  const { username, shift } = req.body;
  if (!username)
    return res.status(400).json({ success: false, pesan: "Username wajib." });

  const shiftSekarang = shift || getShiftOtomatis();
  const now = new Date();
  const nowIso = now.toISOString();
  const todayLocal = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;

  // Cek apakah sudah clock in dan belum clock out
  const existing = db
    .prepare("SELECT * FROM shift_log WHERE username = ? AND status = 'aktif'")
    .get(username);

  if (existing) {
    const clockInDate = new Date(existing.clock_in);
    const clockInLocal = `${clockInDate.getFullYear()}-${String(clockInDate.getMonth()+1).padStart(2,"0")}-${String(clockInDate.getDate()).padStart(2,"0")}`;
    const isSameDay = clockInLocal === todayLocal;
    const isSameShift = existing.shift === shiftSekarang;

    if (isSameDay && isSameShift) {
      // Hari sama, shift sama → lanjutkan shift yang ada
      return res.json({
        success: true,
        pesan: "Sudah clock in.",
        shift: existing,
      });
    }

    // Hari berbeda ATAU shift berbeda → close shift lama, buka shift baru
    closeShift(existing, nowIso);
    console.log(`[SHIFT] Auto close shift ${existing.shift} untuk ${username} (${isSameDay ? 'pergantian shift' : 'hari baru'})`);
  }

  const karyawan = db
    .prepare("SELECT id FROM karyawan WHERE LOWER(username) = LOWER(?)")
    .get(username);
  if (!karyawan)
    return res
      .status(404)
      .json({ success: false, pesan: "Karyawan tidak ditemukan." });

  const result = db
    .prepare(
      "INSERT INTO shift_log (karyawan_id, username, shift, clock_in, status) VALUES (?, ?, ?, ?, 'aktif')",
    )
    .run(karyawan.id, username, shiftSekarang, nowIso);

  const newShift = db
    .prepare("SELECT * FROM shift_log WHERE id = ?")
    .get(result.lastInsertRowid);
  console.log(`[SHIFT] ${username} clock-in shift ${shiftSekarang}`);
  res.json({ success: true, shift: newShift });
});

// Clock Out (support kas opname: kas_fisik + catatan opsional)
app.post("/api/shift/clock-out", (req, res) => {
  const role = req.headers["x-role"];
  if (!role || !["admin", "owner", "kasir"].includes(role)) {
    return res.status(403).json({ success: false, pesan: "Akses ditolak." });
  }
  const { username, kas_fisik, catatan } = req.body;
  const existing = db
    .prepare("SELECT * FROM shift_log WHERE username = ? AND status = 'aktif'")
    .get(username);
  if (!existing)
    return res.status(400).json({ success: false, pesan: "Belum clock in." });

  const nowIso = new Date().toISOString();
  const opname = (kas_fisik != null && kas_fisik !== "") ? { kas_fisik, catatan } : null;
  closeShift(existing, nowIso, opname);

  const updated = db
    .prepare("SELECT * FROM shift_log WHERE id = ?")
    .get(existing.id);
  console.log(`[SHIFT] ${username} clock-out shift ${existing.shift}${opname ? ` (opname: ${opname.kas_fisik})` : ''}`);
  res.json({ success: true, shift: updated });
});

// Preview kas expected (tunai) untuk shift aktif — sebelum tutup shift
app.get("/api/shift/kas-preview/:username", (req, res) => {
  const row = db
    .prepare("SELECT * FROM shift_log WHERE LOWER(username) = LOWER(?) AND status = 'aktif'")
    .get(req.params.username);
  if (!row) return res.json({ success: false, pesan: "Shift tidak aktif." });
  const trxData = hitungOmzetShift(row.username, row.clock_in, new Date().toISOString());
  res.json({
    success: true,
    shift: row,
    total_transaksi: trxData.trx,
    total_omzet: trxData.omzet,
    kas_expected: trxData.kas_tunai,
  });
});

// Get shift aktif
app.get("/api/shift/aktif", (req, res) => {
  const rows = db
    .prepare(
      "SELECT * FROM shift_log WHERE status = 'aktif' ORDER BY clock_in DESC",
    )
    .all();
  res.json(rows);
});

// Get shift aktif per user
app.get("/api/shift/aktif/:username", (req, res) => {
  const row = db
    .prepare(
      "SELECT * FROM shift_log WHERE LOWER(username) = LOWER(?) AND status = 'aktif'",
    )
    .get(req.params.username);
  res.json({ shift: row || null });
});

// Get riwayat shift (filter hari ini default)
app.get("/api/shift/riwayat", (req, res) => {
  const role = req.headers["x-role"];
  if (!role || !["admin", "owner"].includes(role)) {
    return res.status(403).json({ success: false, pesan: "Akses ditolak." });
  }
  const today = new Date().toISOString().split("T")[0];
  const tanggal = req.query.tanggal || today;
  const rows = db
    .prepare(
      "SELECT * FROM shift_log WHERE date(clock_in, 'localtime') = ? ORDER BY clock_in DESC",
    )
    .all(tanggal);
  res.json(rows);
});

// Get config shift
app.get("/api/shift/config", (req, res) => {
  res.json({ shifts: SHIFT_CONFIG, shiftSekarang: getShiftOtomatis(), operasional: getJamOperasional() });
});

// Report shift detail per user
app.get("/api/shift/report/:username", (req, res) => {
  const username = req.params.username;
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
  const tanggal = req.query.tanggal || today;

  // Riwayat shift hari ini/tanggal tertentu
  // clock_in disimpan ISO UTC, konversi ke lokal untuk filter tanggal
  const allShifts = db
    .prepare("SELECT * FROM shift_log WHERE username = ? ORDER BY clock_in DESC")
    .all(username);
  const shifts = allShifts.filter((s) => {
    const d = new Date(s.clock_in);
    const localDate = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    return localDate === tanggal;
  });

  // Detail per shift: breakdown tunai vs qris
  const report = shifts.map((s) => {
    const clockInLocal = isoToLocalSql(s.clock_in);
    const clockOutLocal = isoToLocalSql(s.clock_out);
    const whereClause = clockOutLocal
      ? "kasir = ? AND created_at >= ? AND created_at <= ?"
      : "kasir = ? AND created_at >= ?";
    const params = clockOutLocal
      ? [username, clockInLocal, clockOutLocal]
      : [username, clockInLocal];

    const tunai = db
      .prepare(
        `SELECT COUNT(*) as trx, COALESCE(SUM(total),0) as total FROM transaksi WHERE ${whereClause} AND metode = 'Tunai'`,
      )
      .get(...params);
    const qris = db
      .prepare(
        `SELECT COUNT(*) as trx, COALESCE(SUM(total),0) as total FROM transaksi WHERE ${whereClause} AND metode = 'QRIS'`,
      )
      .get(...params);
    const totalTrx = db
      .prepare(
        `SELECT COUNT(*) as trx, COALESCE(SUM(total),0) as total FROM transaksi WHERE ${whereClause}`,
      )
      .get(...params);

    return {
      ...s,
      detail: {
        tunai: { trx: tunai.trx, total: tunai.total },
        qris: { trx: qris.trx, total: qris.total },
        total: { trx: totalTrx.trx, total: totalTrx.total },
      },
    };
  });

  res.json({ tanggal, username, shifts: report });
});

// API: cek hak akses role
app.get("/api/hak-akses/:role", (req, res) => {
  const hak = HAK_AKSES[req.params.role];
  if (!hak) return res.status(404).json({ success: false });
  res.json({ hakAkses: hak });
});

// Setting Toko API
app.get("/api/setting-toko", (req, res) => {
  const rows = getAllSettings.all();
  const settings = {};
  rows.forEach((r) => { settings[r.key] = r.value; });
  res.json(settings);
});

app.post("/api/setting-toko", (req, res) => {
  const role = req.headers["x-role"];
  if (!HAK_AKSES[role]?.includes("setting_toko"))
    return res.status(403).json({ success: false, pesan: "Akses ditolak." });
  const { settings } = req.body;
  if (!settings) return res.status(400).json({ success: false, pesan: "Data tidak valid." });
  const username = req.headers["x-user"] || "admin";
  const changes = [];
  Object.entries(settings).forEach(([k, v]) => {
    upsertSetting.run(k, String(v));
    changes.push(`${k}=${v}`);
  });
  logAudit(username, role, "ubah_setting", changes.join(", "));
  res.json({ success: true });
});

// Audit Log API
app.get("/api/audit-log", (req, res) => {
  const role = req.headers["x-role"];
  if (!HAK_AKSES[role]?.includes("audit_log"))
    return res.status(403).json({ success: false, pesan: "Akses ditolak." });
  const limit = parseInt(req.query.limit) || 100;
  const offset = parseInt(req.query.offset) || 0;
  const logs = db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?").all(limit, offset);
  const total = db.prepare("SELECT COUNT(*) as c FROM audit_log").get().c;
  res.json({ success: true, data: logs, total });
});

// Reset audit log — hanya admin. Sisakan 1 baris self-audit supaya jejak reset tetap ada.
app.delete("/api/audit-log", (req, res) => {
  const role = req.headers["x-role"];
  if (!HAK_AKSES[role]?.includes("audit_log"))
    return res.status(403).json({ success: false, pesan: "Akses ditolak." });
  const user = req.headers["x-user"] || role;
  const totalDihapus = db.prepare("SELECT COUNT(*) as c FROM audit_log").get().c;
  db.prepare("DELETE FROM audit_log").run();
  try { db.prepare("DELETE FROM sqlite_sequence WHERE name = 'audit_log'").run(); } catch (e) {}
  logAudit(user, role, "reset_audit_log", `${totalDihapus} baris riwayat dihapus`);
  res.json({ success: true, dihapus: totalDihapus });
});

// ============================================
// ADMIN DATABASE BROWSER (phpMyAdmin-like, khusus admin)
// ============================================
function requireAdmin(req, res) {
  const role = req.headers["x-role"];
  if (role !== "admin") {
    res.status(403).json({ success: false, pesan: "Hanya admin yang boleh akses database." });
    return false;
  }
  return true;
}
function getUserTables() {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
}
function assertValidTable(tableName) {
  if (!getUserTables().includes(tableName)) throw new Error("Tabel tidak dikenal: " + tableName);
}
function getTableColumns(tableName) {
  assertValidTable(tableName);
  return db.prepare(`PRAGMA table_info(${tableName})`).all();
}

// Daftar tabel + jumlah baris
app.get("/api/admin-db/tables", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const tables = getUserTables().map(name => {
    const count = db.prepare(`SELECT COUNT(*) as c FROM ${name}`).get().c;
    return { name, rows: count };
  });
  res.json({ success: true, data: tables });
});

// Schema tabel (kolom + tipe)
app.get("/api/admin-db/schema/:table", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const cols = getTableColumns(req.params.table);
    res.json({ success: true, data: cols });
  } catch (e) {
    res.status(400).json({ success: false, pesan: e.message });
  }
});

// Browse baris dengan pagination + search
app.get("/api/admin-db/table/:table", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const table = req.params.table;
    assertValidTable(table);
    const cols = getTableColumns(table).map(c => c.name);
    const limit  = Math.min(parseInt(req.query.limit) || 50, 500);
    const offset = parseInt(req.query.offset) || 0;
    const q      = (req.query.q || "").trim();
    let where = "";
    let params = [];
    if (q) {
      const likeClauses = cols.map(c => `CAST(${c} AS TEXT) LIKE ?`).join(" OR ");
      where = `WHERE ${likeClauses}`;
      params = cols.map(() => `%${q}%`);
    }
    const orderCol = cols.includes("id") ? "id" : cols[0];
    const rows = db.prepare(`SELECT * FROM ${table} ${where} ORDER BY ${orderCol} DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    const total = db.prepare(`SELECT COUNT(*) as c FROM ${table} ${where}`).get(...params).c;
    res.json({ success: true, data: rows, total, columns: cols });
  } catch (e) {
    res.status(400).json({ success: false, pesan: e.message });
  }
});

// Tambah baris
app.post("/api/admin-db/row/:table", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const table = req.params.table;
    const cols = getTableColumns(table);
    const editableCols = cols.filter(c => !(c.pk && c.type.toUpperCase().includes("INT"))); // skip autoinc PK
    const data = req.body || {};
    const usedCols = editableCols.filter(c => data[c.name] !== undefined).map(c => c.name);
    if (!usedCols.length) return res.status(400).json({ success: false, pesan: "Tidak ada data." });
    const placeholders = usedCols.map(() => "?").join(",");
    const values = usedCols.map(c => data[c]);
    const info = db.prepare(`INSERT INTO ${table} (${usedCols.join(",")}) VALUES (${placeholders})`).run(...values);
    logAudit(req.headers["x-user"] || "admin", "admin", "admin_db_insert", `INSERT INTO ${table}, id=${info.lastInsertRowid}`);
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ success: false, pesan: e.message });
  }
});

// Update baris (by id)
app.put("/api/admin-db/row/:table/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const table = req.params.table;
    const cols = getTableColumns(table);
    const colNames = cols.map(c => c.name);
    if (!colNames.includes("id")) return res.status(400).json({ success: false, pesan: "Tabel tidak punya kolom 'id', edit tidak didukung." });
    const data = req.body || {};
    const usedCols = colNames.filter(c => c !== "id" && data[c] !== undefined);
    if (!usedCols.length) return res.status(400).json({ success: false, pesan: "Tidak ada perubahan." });
    const setClause = usedCols.map(c => `${c} = ?`).join(", ");
    const values = usedCols.map(c => data[c]);
    const info = db.prepare(`UPDATE ${table} SET ${setClause} WHERE id = ?`).run(...values, req.params.id);
    logAudit(req.headers["x-user"] || "admin", "admin", "admin_db_update", `UPDATE ${table} id=${req.params.id} (${info.changes} baris)`);
    res.json({ success: true, changes: info.changes });
  } catch (e) {
    res.status(400).json({ success: false, pesan: e.message });
  }
});

// Hapus baris (by id)
app.delete("/api/admin-db/row/:table/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const table = req.params.table;
    assertValidTable(table);
    const cols = getTableColumns(table).map(c => c.name);
    if (!cols.includes("id")) return res.status(400).json({ success: false, pesan: "Tabel tidak punya kolom 'id'." });
    const info = db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(req.params.id);
    logAudit(req.headers["x-user"] || "admin", "admin", "admin_db_delete", `DELETE FROM ${table} id=${req.params.id}`);
    res.json({ success: true, changes: info.changes });
  } catch (e) {
    res.status(400).json({ success: false, pesan: e.message });
  }
});

// Export tabel ke CSV
app.get("/api/admin-db/export/:table", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const table = req.params.table;
    assertValidTable(table);
    const rows = db.prepare(`SELECT * FROM ${table}`).all();
    if (!rows.length) { res.type("text/csv").send(""); return; }
    const cols = Object.keys(rows[0]);
    const escape = (v) => {
      if (v === null || v === undefined) return "";
      const s = String(v).replace(/"/g, '""');
      return /[",\n\r]/.test(s) ? `"${s}"` : s;
    };
    const csv = [cols.join(","), ...rows.map(r => cols.map(c => escape(r[c])).join(","))].join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${table}.csv"`);
    res.send(csv);
  } catch (e) {
    res.status(400).json({ success: false, pesan: e.message });
  }
});

// Jalankan SQL custom (SELECT saja untuk keamanan)
app.post("/api/admin-db/query", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const sql = (req.body?.sql || "").trim();
  if (!sql) return res.status(400).json({ success: false, pesan: "Query kosong." });
  // Hanya izinkan SELECT/PRAGMA/EXPLAIN — blok perintah destruktif
  const firstWord = sql.split(/\s+/)[0].toUpperCase();
  const allowed = ["SELECT", "PRAGMA", "EXPLAIN", "WITH"];
  if (!allowed.includes(firstWord)) {
    return res.status(400).json({ success: false, pesan: "Hanya query SELECT / PRAGMA / EXPLAIN / WITH yang diizinkan. Untuk edit data, pakai tombol di tabel." });
  }
  if (/;\s*\S/.test(sql)) return res.status(400).json({ success: false, pesan: "Satu query saja — titik koma di tengah tidak diizinkan." });
  try {
    const stmt = db.prepare(sql);
    const rows = stmt.all();
    logAudit(req.headers["x-user"] || "admin", "admin", "admin_db_query", sql.slice(0, 200));
    res.json({ success: true, data: rows, rowCount: rows.length });
  } catch (e) {
    res.status(400).json({ success: false, pesan: e.message });
  }
});

// VAPID public key untuk client
app.get("/api/vapid-public-key", (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC });
});

// Push subscription dari pembeli
app.post("/api/push-subscribe", (req, res) => {
  const { meja, subscription } = req.body;
  if (!meja || !subscription) return res.status(400).json({ success: false });
  if (!pushSubscriptions[meja]) pushSubscriptions[meja] = [];
  // Hindari duplikat
  const exists = pushSubscriptions[meja].find(s => s.endpoint === subscription.endpoint);
  if (!exists) pushSubscriptions[meja].push(subscription);
  console.log(`  Push subscription terdaftar untuk meja ${meja}`);
  res.json({ success: true });
});

// Halaman utama kasir/owner/admin
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

// Halaman layar pembeli
app.get("/pembeli", (req, res) =>
  res.sendFile(path.join(__dirname, "pembeli.html")),
);
app.get("/pembeli.html", (req, res) =>
  res.sendFile(path.join(__dirname, "pembeli.html")),
);

// Halaman pesan (self-order pelanggan)
app.get("/pesan", (req, res) =>
  res.sendFile(path.join(__dirname, "pesan.html")),
);
app.get("/pesan.html", (req, res) =>
  res.sendFile(path.join(__dirname, "pesan.html")),
);

// Halaman app (pesan online dari rumah)
app.get("/app", (req, res) =>
  res.sendFile(path.join(__dirname, "app.html")),
);

// Halaman cetak QR code meja
app.get("/qr-meja", (req, res) =>
  res.sendFile(path.join(__dirname, "qr-meja.html")),
);

// ============================================
// 4. SOCKET.IO — REAL-TIME DENGAN VALIDASI ROLE
// ============================================
io.on("connection", (socket) => {
  let userRole = null;
  let userName = null;

  console.log("Koneksi baru terhubung.");

  // Identifikasi role saat koneksi
  socket.on("identify", ({ role, username }) => {
    userRole = role;
    userName = username;
    console.log(`[${username}] terhubung sebagai [${role}]`);

    // Bergabung ke room sesuai role
    socket.join(role);

    // Kirim data awal sesuai role
    if (["admin", "owner", "kasir"].includes(role)) {
      const data = getSemuaData();
      const pendingOrders = getPesananPending.all().map(r => ({
        ...r,
        items: JSON.parse(r.items),
      }));
      socket.emit("sync-data", {
        ...data,
        menu: getAllMenu.all(),
        hakAkses: HAK_AKSES[role],
        pendingOnlineOrders: pendingOrders,
      });
    }
  });

  // Update total + detail pesanan ke layar pembeli
  socket.on("update-total", (data) => {
    if (!["admin", "owner", "kasir"].includes(userRole)) return;
    io.emit("update-total", {
      total: data.total,
      method: data.method,
      items: data.items || [],
    });
  });

  // Sync manual
  socket.on("request-sync", () => {
    if (!["admin", "owner", "kasir"].includes(userRole)) return;
    const data = getSemuaData();
    const pendingOrders = getPesananPending.all().map(r => ({
      ...r,
      items: JSON.parse(r.items),
    }));
    socket.emit("sync-data", {
      ...data,
      menu: getAllMenu.all(),
      hakAkses: HAK_AKSES[userRole],
      pendingOnlineOrders: pendingOrders,
    });
  });

  // Transaksi baru — kasir, owner, admin
  socket.on("new-transaction", (data) => {
    if (!["admin", "owner", "kasir"].includes(userRole)) {
      socket.emit("error", {
        pesan: "Akses ditolak: tidak bisa melakukan transaksi.",
      });
      return;
    }
    console.log(
      `[${userName}/${userRole}] Transaksi: ${data.items.length} item(s)`,
    );
    insertBatch(data.items);
    // Kurangi stok di database
    if (data.stockUpdates) {
      for (const su of data.stockUpdates) {
        kurangiStok.run(su.qty, su.menuId, su.qty);
      }
    }
    // Tambah poin pelanggan jika ada
    if (data.pelangganId && data.totalAmount > 0) {
      const poinDapat = Math.floor(data.totalAmount / POIN_PER_RUPIAH);
      updatePelangganBelanja.run(poinDapat, data.totalAmount, data.pelangganId);
    }
    const allData = getSemuaData();
    io.emit("transaction-update", {
      newItems: data.items,
      totalAmount: data.totalAmount,
      history: allData.history,
      omzet: allData.omzet,
      menu: getAllMenu.all(),
    });
  });

  // Void transaksi — semua role yang punya hak void
  socket.on("void-transaction", () => {
    if (!HAK_AKSES[userRole]?.includes("void")) {
      socket.emit("error", {
        pesan: "Akses ditolak: tidak bisa void transaksi.",
      });
      return;
    }
    const lastItem = getLastTransaksi.get();
    if (lastItem) {
      // Kembalikan stok
      const menuItem = db
        .prepare("SELECT id FROM menu WHERE nama = ?")
        .get(lastItem.menu);
      if (menuItem) tambahStok.run(lastItem.qty, menuItem.id);
      deleteLastTransaksi.run();
      const allData = getSemuaData();
      io.emit("transaction-update", {
        voided: {
          Tanggal: lastItem.tanggal,
          Kasir: lastItem.kasir,
          Menu: lastItem.menu,
          Qty: lastItem.qty,
          Total: lastItem.total,
          Metode: lastItem.metode,
        },
        history: allData.history,
        omzet: allData.omzet,
        menu: getAllMenu.all(),
      });
      console.log(`[${userName}] void: ${lastItem.menu}`);
      logAudit(userName, userRole, "void", `Menu: ${lastItem.menu}, Qty: ${lastItem.qty}, Total: ${lastItem.total}`);
    }
  });

  // Reset omzet — hanya admin & owner
  socket.on("reset-omzet", (data) => {
    if (!HAK_AKSES[userRole]?.includes("reset_omzet")) {
      socket.emit("error", { pesan: "Akses ditolak: tidak bisa reset omzet." });
      return;
    }
    const mode = data?.mode || "semua";
    if (mode === "semua") {
      deleteAllTransaksi.run();
      console.log(`[${userName}] RESET OMZET: semua transaksi dihapus`);
      logAudit(userName, userRole, "reset_omzet", "Mode: semua — semua transaksi dihapus");
    } else if (mode === "hari_ini") {
      deleteTransaksiHariIni.run();
      console.log(`[${userName}] RESET OMZET: transaksi hari ini dihapus`);
      logAudit(userName, userRole, "reset_omzet", "Mode: hari_ini — transaksi hari ini dihapus");
    }
    const allData = getSemuaData();
    io.emit("transaction-update", {
      resetOmzet: mode,
      history: allData.history,
      omzet: allData.omzet,
      menu: getAllMenu.all(),
    });
  });

  // Pesanan dari pelanggan (self-order via QR)
  socket.on("customer-order", (data) => {
    if (!data || !data.meja || !data.items || data.items.length === 0) {
      socket.emit("error", { pesan: "Data pesanan tidak valid." });
      return;
    }
    console.log(
      `[Meja ${data.meja}] Pesanan masuk: ${data.items.length} item, total Rp ${data.total}`,
    );
    try {
      // Simpan transaksi ke database
      const tanggal = new Date().toLocaleDateString("id-ID");
      const metode = data.metode || "Tunai";
      const kasirLabel = `Meja ${data.meja}`;
      const trxItems = [];
      for (const item of data.items) {
        insertTransaksi.run(tanggal, kasirLabel, item.nama, item.qty, item.harga * item.qty, metode, item.catatan || "", 0, "");
        // Kurangi stok
        if (item.menuId) kurangiStok.run(item.qty, item.menuId, item.qty);
        trxItems.push({ Tanggal: tanggal, Kasir: kasirLabel, Menu: item.nama, Qty: item.qty, Total: item.harga * item.qty, Metode: metode });
      }
      // Simpan ke pesanan_online untuk tracking di kasir
      const kodePesanan = generateKodePesanan();
      insertPesananOnline.run(
        0, `Meja ${data.meja}`, "", "", data.meja, "meja",
        JSON.stringify(data.items), data.total || 0, 0, "",
        metode, data.tipe || "Dine In", "", "menunggu", kodePesanan, ""
      );
      const pesananId = db.prepare("SELECT last_insert_rowid() as id").get().id;
      // Broadcast ke semua kasir/admin/owner + update data
      const allData = getSemuaData();
      io.emit("customer-order", {
        meja: data.meja,
        items: data.items,
        total: data.total,
        metode,
        tipe: data.tipe || "Dine In",
        kodePesanan,
        dbId: pesananId,
        waktu: new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" }),
      });
      console.log(`[Meja ${data.meja}] Pesanan ${kodePesanan} berhasil dikirim ke kasir`);
      io.emit("transaction-update", {
        newItems: trxItems,
        totalAmount: data.total,
        history: allData.history,
        omzet: allData.omzet,
        menu: getAllMenu.all(),
      });
    } catch (err) {
      console.error(`[Meja ${data.meja}] ERROR saat proses pesanan:`, err);
      socket.emit("error", { pesan: "Gagal memproses pesanan: " + err.message });
    }
  });

  // Pesanan online dari app (pesan dari rumah)
  socket.on("online-order", (data) => {
    if (!data || !data.items || data.items.length === 0) {
      socket.emit("error", { pesan: "Data pesanan tidak valid." });
      return;
    }
    console.log(
      `[ONLINE] ${data.nama} - ${data.items.length} item, total Rp ${data.total}`,
    );
    try {
      // Simpan transaksi ke database
      const tanggal = new Date().toLocaleDateString("id-ID");
      const metode = data.metode || "Tunai";
      const kasirLabel = `Online (${data.nama || "Tanpa Nama"})`;
      const trxItems = [];
      const finalTotal = (data.total || 0) - (data.diskon || 0);
      for (const item of data.items) {
        insertTransaksi.run(tanggal, kasirLabel, item.nama, item.qty, item.harga * item.qty, metode, item.catatan || "", 0, "");
        if (item.menuId) kurangiStok.run(item.qty, item.menuId, item.qty);
        trxItems.push({ Tanggal: tanggal, Kasir: kasirLabel, Menu: item.nama, Qty: item.qty, Total: item.harga * item.qty, Metode: metode });
      }
      // Deduct poin yg ditukar (jika ada) sebelum tambah poin baru
      if (data.pelangganId && data.poinRedeemed && data.poinRedeemed > 0) {
        const plg = getPelangganById.get(data.pelangganId);
        if (plg && plg.poin >= data.poinRedeemed) {
          updatePelangganPoin.run(plg.poin - data.poinRedeemed, data.pelangganId);
        }
      }
      // Update poin pelanggan jika login — bonus multiplier per tier
      if (data.pelangganId && finalTotal > 0) {
        const plg = getPelangganById.get(data.pelangganId);
        const tier = getTierFor(plg?.total_belanja || 0).current;
        const multiplier = 1 + (tier.bonus_pct / 100);
        const poinDapat = Math.floor((finalTotal / POIN_PER_RUPIAH) * multiplier);
        updatePelangganBelanja.run(poinDapat, finalTotal, data.pelangganId);
      }
      // Simpan ke pesanan_online untuk tracking (semua order, termasuk guest)
      const kodePesanan = generateKodePesanan();
      insertPesananOnline.run(
        data.pelangganId || 0, data.nama || "Tanpa Nama", data.alamat || "", data.telp || "",
        "", "online",
        JSON.stringify(data.items), data.total || 0, data.diskon || 0, data.promoKode || "",
        metode, data.tipe || "Dine In", data.catatan || "", "menunggu", kodePesanan,
        data.jadwalAmbil || ""
      );
      // Increment promo usage
      if (data.promoKode) {
        const promo = getPromoByKode.get(data.promoKode.toUpperCase());
        if (promo) incrementPromoUsage.run(promo.id);
      }
      // Emit order confirmed back to the ordering client
      socket.emit("order-confirmed", { kodePesanan, pelangganId: data.pelangganId });

      const allData = getSemuaData();
      io.emit("online-order", {
        nama: data.nama || "Tanpa Nama",
        alamat: data.alamat || "-",
        telp: data.telp || "-",
        items: data.items,
        total: data.total,
        diskon: data.diskon || 0,
        metode,
        tipe: data.tipe || "Dine In",
        catatan: data.catatan || "",
        kodePesanan,
        jadwalAmbil: data.jadwalAmbil || "",
        waktu: new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" }),
      });
      console.log(`[ONLINE] Pesanan ${kodePesanan || 'guest'} berhasil dikirim ke kasir`);
      io.emit("transaction-update", {
        newItems: trxItems,
        totalAmount: finalTotal,
        history: allData.history,
        omzet: allData.omzet,
        menu: getAllMenu.all(),
      });
    } catch (err) {
      console.error(`[ONLINE] ERROR saat proses pesanan:`, err);
      socket.emit("error", { pesan: "Gagal memproses pesanan: " + err.message });
    }
  });

  // Update status pesanan online (dari kasir)
  socket.on("update-order-status", (data) => {
    if (!["admin", "owner", "kasir"].includes(userRole)) {
      socket.emit("error", { pesan: "Akses ditolak." });
      return;
    }
    if (!data || !data.pesananId || !data.status) return;
    const valid = ["menunggu", "diproses", "siap", "selesai"];
    if (!valid.includes(data.status)) return;
    updatePesananStatus.run(data.status, data.pesananId);
    const pesanan = getPesananById.get(data.pesananId);
    if (pesanan) {
      io.emit("order-status-changed", {
        pesananId: pesanan.id,
        kodePesanan: pesanan.kode_pesanan,
        pelangganId: pesanan.pelanggan_id,
        status: data.status,
      });
      console.log(`[${userName}] Update pesanan ${pesanan.kode_pesanan} → ${data.status}`);

      // Kirim Web Push Notification ke HP pembeli
      if (data.status === "diproses" && pesanan.meja) {
        const subs = pushSubscriptions[pesanan.meja] || [];
        const payload = JSON.stringify({
          title: "🔥 Pesanan Diproses! — Cafe Soluna",
          body: `Pesanan ${pesanan.kode_pesanan} sedang disiapkan. Mohon tunggu sebentar!`,
          tag: "order-processing-" + pesanan.id,
          url: pesanan.meja === "online" ? "/app.html" : "/pesan?meja=" + pesanan.meja,
        });
        subs.forEach((sub, i) => {
          webPush.sendNotification(sub, payload).catch(() => {
            subs.splice(i, 1);
          });
        });
      }
    }
  });

  // Kasir memberitahu pesanan meja sudah selesai
  socket.on("order-ready", (data) => {
    if (!data || !data.meja) return;
    console.log(`[${userName}] Pesanan meja ${data.meja} SELESAI`);
    io.emit("order-ready", { meja: data.meja });

    // Kirim Web Push Notification ke semua subscriber meja ini
    const subs = pushSubscriptions[data.meja] || [];
    const payload = JSON.stringify({
      title: "Pesanan Siap! — Cafe Soluna",
      body: `Pesanan Meja ${data.meja} sudah selesai. Silakan ambil di kasir!`,
      tag: "order-ready-" + data.meja,
      url: "/pesan?meja=" + data.meja,
    });
    subs.forEach((sub, i) => {
      webPush.sendNotification(sub, payload).catch(() => {
        // Hapus subscription yang sudah expired
        subs.splice(i, 1);
      });
    });
  });

  socket.on("disconnect", () => {
    console.log(`[${userName || "?"}] terputus.`);
  });
});

// ============================================
// 5. JALANKAN SERVER
// ============================================
const PORT = process.env.PORT || 5000;
// Dapatkan IP lokal otomatis (prioritas WiFi)
function getLocalIP() {
  const nets = os.networkInterfaces();
  const wifiKeywords = ["wi-fi", "wifi", "wlan", "wireless"];
  let wifiIP = null;
  let lanIP = null;
  for (const name of Object.keys(nets)) {
    const lower = name.toLowerCase();
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) {
        if (wifiKeywords.some((k) => lower.includes(k))) {
          wifiIP = net.address;
        } else if (
          !lanIP &&
          lower.includes("ethernet") &&
          !lower.includes("virtualbox") &&
          !lower.includes("vbox")
        ) {
          lanIP = net.address;
        }
      }
    }
  }
  return wifiIP || lanIP || "localhost";
}

http.listen(PORT, "0.0.0.0", () => {
  const data = getSemuaData();
  const localIP = getLocalIP();

  // Broadcast mDNS supaya bisa diakses via http://warkop.local:5000
  const bonjour = new Bonjour();
  bonjour.publish({
    name: "Cafe Soluna POS",
    type: "http",
    port: PORT,
    host: "warkop.local",
  });

  console.log("========================================");
  console.log("      SERVER CAFE SOLUNA AKTIF!        ");
  console.log(`  LOKAL     : http://localhost:${PORT}`);
  console.log(`  JARINGAN  : http://${localIP}:${PORT}`);
  console.log(`  mDNS      : http://warkop.local:${PORT}`);
  console.log(`  PEMBELI   : http://${localIP}:${PORT}/pembeli`);
  console.log(`  PESAN     : http://${localIP}:${PORT}/pesan?meja=1`);
  console.log(`  DATABASE  : warkop.db (SQLite)`);
  console.log(`  TRANSAKSI : ${data.history.length} record`);
  console.log("========================================");
  console.log("\n  AKUN DEFAULT:");
  console.log("  admin / 0000  -> Admin (akses penuh)");
  console.log("  owner / 1234  -> Owner (laporan keuangan)");
  console.log("  budi  / 1111  -> Kasir");
  console.log("  sari  / 2222  -> Kasir");
  console.log("========================================\n");

  // QR Code di terminal untuk scan dari HP Android
  const kasirURL = `http://${localIP}:${PORT}`;
  console.log("  SCAN QR DARI HP UNTUK AKSES KASIR:");
  qrTerminal.generate(kasirURL, { small: true }, (qr) => console.log(qr));

  const pembeliURL = `http://${localIP}:${PORT}/pembeli`;
  console.log("  SCAN QR DARI HP UNTUK LAYAR PEMBELI:");
  qrTerminal.generate(pembeliURL, { small: true }, (qr) => console.log(qr));

  // ===== PUBLIC TUNNEL via Cloudflare (auto-reconnect) =====
  (function () {
    let cfPath;
    try { cfPath = require("cloudflared").bin; } catch (e) {
      console.log("  Cloudflared tidak tersedia: " + e.message);
      return;
    }
    let cfChild = null;

    function startTunnel() {
      console.log("\n  Membuka tunnel Cloudflare...");
      publicURL = null;
      let found = false;

      cfChild = require("child_process").spawn(
        cfPath, ["tunnel", "--url", `http://localhost:${PORT}`],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: false }
      );

      function parseLine(line) {
        if (found) return;
        const match = line.match(/https:\/\/[a-z0-9\-]+\.trycloudflare\.com/);
        if (match) {
          found = true;
          publicURL = match[0];
          console.log("========================================");
          console.log("  LINK PUBLIK (semua jaringan internet):");
          console.log(`  KASIR     : ${publicURL}`);
          console.log(`  PEMBELI   : ${publicURL}/pembeli`);
          console.log(`  PESAN     : ${publicURL}/pesan?meja=1`);
          console.log(`  QR MEJA   : ${publicURL}/qr-meja`);
          console.log("========================================\n");
          qrTerminal.generate(`${publicURL}/pesan?meja=1`, { small: true }, (qr) => console.log(qr));
          io.emit("tunnel-ready", { publicURL });
        }
      }

      cfChild.stdout.on("data", (d) => d.toString().split("\n").forEach(parseLine));
      cfChild.stderr.on("data", (d) => d.toString().split("\n").forEach(parseLine));
      cfChild.on("error", (e) => console.log("  Tunnel error: " + e.message));
      cfChild.on("exit", (code) => {
        console.log(`  Tunnel berhenti (code ${code}). Reconnect dalam 3 detik...`);
        publicURL = null;
        io.emit("tunnel-ready", { publicURL: null });
        setTimeout(startTunnel, 3000);
      });
    }

    startTunnel();
    process.on("exit", () => { try { if (cfChild) cfChild.kill(); } catch(e){} });
  })();

  // ===== AUTO DETECT NETWORK CHANGE =====
  let currentIP = localIP;
  setInterval(() => {
    const newIP = getLocalIP();
    if (newIP !== currentIP && newIP !== "localhost") {
      currentIP = newIP;
      console.log("\n========================================");
      console.log("  ⚡ JARINGAN BERUBAH!");
      console.log(`  IP BARU    : http://${newIP}:${PORT}`);
      console.log(`  PEMBELI    : http://${newIP}:${PORT}/pembeli`);
      console.log("========================================\n");

      // Beritahu semua client yang terhubung
      io.emit("network-changed", {
        ip: newIP,
        port: PORT,
        kasir: `http://${newIP}:${PORT}`,
        pembeli: `http://${newIP}:${PORT}/pembeli`,
      });
    }
  }, 5000); // Cek setiap 5 detik
});

process.on("SIGINT", () => {
  db.close();
  console.log("Database ditutup. Server berhenti.");
  process.exit(0);
});
