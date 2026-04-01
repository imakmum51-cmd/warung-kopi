const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
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

app.use(express.json());

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
    "setting",
    "void",
    "reset_omzet",
  ],
  owner: [
    "transaksi",
    "laporan_harian",
    "laporan_keuangan",
    "kelola_menu",
    "kelola_stok",
    "void",
    "reset_omzet",
  ],
  kasir: ["transaksi", "laporan_harian"],
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

// Tabel pesanan online (tracking pesanan dari app)
db.exec(`
  CREATE TABLE IF NOT EXISTS pesanan_online (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pelanggan_id INTEGER NOT NULL,
    nama TEXT NOT NULL,
    alamat TEXT DEFAULT '',
    telp TEXT DEFAULT '',
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
  "INSERT INTO transaksi (tanggal, kasir, menu, qty, total, metode) VALUES (?, ?, ?, ?, ?, ?)",
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
  "INSERT INTO pesanan_online (pelanggan_id, nama, alamat, telp, items, total, diskon, promo_kode, metode, tipe, catatan, status, kode_pesanan) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
);
const getPesananByPelanggan = db.prepare(
  "SELECT * FROM pesanan_online WHERE pelanggan_id = ? ORDER BY id DESC LIMIT 50"
);
const getPesananById = db.prepare("SELECT * FROM pesanan_online WHERE id = ?");
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

// API: ambil daftar menu
app.get("/api/menu", (req, res) => {
  res.json(getAllMenu.all());
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
  const { nama, harga, kategori, stok } = req.body;
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
      "INSERT INTO menu (nama, harga, kategori, stok) VALUES (?, ?, ?, ?)",
    )
    .run(nama, parseInt(harga), kategori, parseInt(stok) || 50);
  res.json({ success: true, id: result.lastInsertRowid });
});

// API: hapus menu — hanya admin & owner
app.delete("/api/menu/:id", (req, res) => {
  const role = req.headers["x-role"];
  if (!role || !HAK_AKSES[role]?.includes("kelola_menu")) {
    return res.status(403).json({ success: false, pesan: "Akses ditolak." });
  }
  db.prepare("DELETE FROM menu WHERE id = ?").run(req.params.id);
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
  updateStok.run(stok, req.params.id);
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

  const existing = db.prepare("SELECT id FROM pelanggan WHERE username = ?").get(username.trim().toLowerCase());
  if (existing) return res.status(400).json({ success: false, pesan: "Username sudah dipakai." });

  const result = db.prepare("INSERT INTO pelanggan (nama, telp, username, password) VALUES (?, ?, ?, ?)").run(
    nama.trim(), (telp || "").trim(), username.trim().toLowerCase(), password
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
const SHIFT_CONFIG = [
  { nama: "Pagi", mulai: "06:00", selesai: "15:00", icon: "🌅" },
  { nama: "Sore", mulai: "15:00", selesai: "23:59", icon: "🌙" },
];

function getShiftOtomatis() {
  const jam = new Date().getHours();
  if (jam >= 6 && jam < 15) return "Pagi";
  return "Sore";
}

// Clock In
app.post("/api/shift/clock-in", (req, res) => {
  const role = req.headers["x-role"];
  if (!role || !["admin", "owner", "kasir"].includes(role)) {
    return res.status(403).json({ success: false, pesan: "Akses ditolak." });
  }
  const { username, shift } = req.body;
  if (!username)
    return res.status(400).json({ success: false, pesan: "Username wajib." });

  // Cek apakah sudah clock in dan belum clock out
  const existing = db
    .prepare("SELECT * FROM shift_log WHERE username = ? AND status = 'aktif'")
    .get(username);
  if (existing) {
    // Jika shift aktif dari hari lain, auto-close dan buat baru
    const today = new Date().toISOString().split("T")[0];
    const shiftDate = existing.clock_in.split("T")[0];
    if (shiftDate === today) {
      return res.json({
        success: true,
        pesan: "Sudah clock in.",
        shift: existing,
      });
    }
    // Close shift lama
    const trxOld = db
      .prepare(
        "SELECT COUNT(*) as trx, COALESCE(SUM(total),0) as omzet FROM transaksi WHERE kasir = ? AND created_at >= ?",
      )
      .get(username, existing.clock_in);
    db.prepare(
      "UPDATE shift_log SET clock_out = ?, total_transaksi = ?, total_omzet = ?, status = 'selesai' WHERE id = ?",
    ).run(new Date().toISOString(), trxOld.trx, trxOld.omzet, existing.id);
  }

  const karyawan = db
    .prepare("SELECT id FROM karyawan WHERE LOWER(username) = LOWER(?)")
    .get(username);
  if (!karyawan)
    return res
      .status(404)
      .json({ success: false, pesan: "Karyawan tidak ditemukan." });

  const shiftNama = shift || getShiftOtomatis();
  const now = new Date().toISOString();
  const result = db
    .prepare(
      "INSERT INTO shift_log (karyawan_id, username, shift, clock_in, status) VALUES (?, ?, ?, ?, 'aktif')",
    )
    .run(karyawan.id, username, shiftNama, now);

  const newShift = db
    .prepare("SELECT * FROM shift_log WHERE id = ?")
    .get(result.lastInsertRowid);
  res.json({ success: true, shift: newShift });
});

// Clock Out
app.post("/api/shift/clock-out", (req, res) => {
  const role = req.headers["x-role"];
  if (!role || !["admin", "owner", "kasir"].includes(role)) {
    return res.status(403).json({ success: false, pesan: "Akses ditolak." });
  }
  const { username } = req.body;
  const existing = db
    .prepare("SELECT * FROM shift_log WHERE username = ? AND status = 'aktif'")
    .get(username);
  if (!existing)
    return res.status(400).json({ success: false, pesan: "Belum clock in." });

  // Hitung transaksi & omzet selama shift
  const trxData = db
    .prepare(
      "SELECT COUNT(*) as trx, COALESCE(SUM(total),0) as omzet FROM transaksi WHERE kasir = ? AND created_at >= ?",
    )
    .get(username, existing.clock_in);

  const now = new Date().toISOString();
  db.prepare(
    "UPDATE shift_log SET clock_out = ?, total_transaksi = ?, total_omzet = ?, status = 'selesai' WHERE id = ?",
  ).run(now, trxData.trx, trxData.omzet, existing.id);

  const updated = db
    .prepare("SELECT * FROM shift_log WHERE id = ?")
    .get(existing.id);
  res.json({ success: true, shift: updated });
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
  res.json({ shifts: SHIFT_CONFIG, shiftSekarang: getShiftOtomatis() });
});

// Report shift detail per user
app.get("/api/shift/report/:username", (req, res) => {
  const username = req.params.username;
  const today = new Date().toISOString().split("T")[0];
  const tanggal = req.query.tanggal || today;

  // Riwayat shift hari ini/tanggal tertentu
  const shifts = db
    .prepare(
      "SELECT * FROM shift_log WHERE username = ? AND date(clock_in, 'localtime') = ? ORDER BY clock_in DESC",
    )
    .all(username, tanggal);

  // Detail per shift: breakdown tunai vs qris
  const report = shifts.map((s) => {
    const whereClause = s.clock_out
      ? "kasir = ? AND created_at >= ? AND created_at <= ?"
      : "kasir = ? AND created_at >= ?";
    const params = s.clock_out
      ? [username, s.clock_in, s.clock_out]
      : [username, s.clock_in];

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
      socket.emit("sync-data", {
        ...data,
        menu: getAllMenu.all(),
        hakAkses: HAK_AKSES[role],
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
    socket.emit("sync-data", {
      ...data,
      menu: getAllMenu.all(),
      hakAkses: HAK_AKSES[userRole],
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
    } else if (mode === "hari_ini") {
      deleteTransaksiHariIni.run();
      console.log(`[${userName}] RESET OMZET: transaksi hari ini dihapus`);
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
    // Simpan transaksi ke database
    const tanggal = new Date().toLocaleDateString("id-ID");
    const metode = data.metode || "Tunai";
    const kasirLabel = `Meja ${data.meja}`;
    const trxItems = [];
    for (const item of data.items) {
      insertTransaksi.run(tanggal, kasirLabel, item.nama, item.qty, item.harga * item.qty, metode);
      // Kurangi stok
      if (item.menuId) kurangiStok.run(item.qty, item.menuId, item.qty);
      trxItems.push({ Tanggal: tanggal, Kasir: kasirLabel, Menu: item.nama, Qty: item.qty, Total: item.harga * item.qty, Metode: metode });
    }
    // Broadcast ke semua kasir/admin/owner + update data
    const allData = getSemuaData();
    io.emit("customer-order", {
      meja: data.meja,
      items: data.items,
      total: data.total,
      metode,
      tipe: data.tipe || "Dine In",
      waktu: new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" }),
    });
    io.emit("transaction-update", {
      newItems: trxItems,
      totalAmount: data.total,
      history: allData.history,
      omzet: allData.omzet,
      menu: getAllMenu.all(),
    });
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
    // Simpan transaksi ke database
    const tanggal = new Date().toLocaleDateString("id-ID");
    const metode = data.metode || "Tunai";
    const kasirLabel = `Online (${data.nama || "Tanpa Nama"})`;
    const trxItems = [];
    const finalTotal = (data.total || 0) - (data.diskon || 0);
    for (const item of data.items) {
      insertTransaksi.run(tanggal, kasirLabel, item.nama, item.qty, item.harga * item.qty, metode);
      if (item.menuId) kurangiStok.run(item.qty, item.menuId, item.qty);
      trxItems.push({ Tanggal: tanggal, Kasir: kasirLabel, Menu: item.nama, Qty: item.qty, Total: item.harga * item.qty, Metode: metode });
    }
    // Update poin pelanggan jika login
    if (data.pelangganId && finalTotal > 0) {
      const poinDapat = Math.floor(finalTotal / POIN_PER_RUPIAH);
      updatePelangganBelanja.run(poinDapat, finalTotal, data.pelangganId);
    }
    // Simpan ke pesanan_online untuk tracking
    let kodePesanan = null;
    if (data.pelangganId) {
      kodePesanan = generateKodePesanan();
      insertPesananOnline.run(
        data.pelangganId, data.nama || "Tanpa Nama", data.alamat || "", data.telp || "",
        JSON.stringify(data.items), data.total || 0, data.diskon || 0, data.promoKode || "",
        metode, data.tipe || "Dine In", data.catatan || "", "menunggu", kodePesanan
      );
      // Increment promo usage
      if (data.promoKode) {
        const promo = getPromoByKode.get(data.promoKode.toUpperCase());
        if (promo) incrementPromoUsage.run(promo.id);
      }
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
      waktu: new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" }),
    });
    io.emit("transaction-update", {
      newItems: trxItems,
      totalAmount: finalTotal,
      history: allData.history,
      omzet: allData.omzet,
      menu: getAllMenu.all(),
    });
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
      title: "Pesanan Siap! — Warkop Urban",
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
    name: "Warkop Urban POS",
    type: "http",
    port: PORT,
    host: "warkop.local",
  });

  console.log("========================================");
  console.log("      SERVER WARKOP URBAN AKTIF!        ");
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
