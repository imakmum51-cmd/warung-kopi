# 🍵 Web Kasir Warkop — Panduan Claude Code

## Cara Menjalankan

```bash
# Install dependency (jika belum)
npm install

# Jalankan server
node app.js
```

Server berjalan di: http://localhost:5000
Layar pembeli: http://localhost:5000/pembeli

---

## Struktur Role & Akun Default

| Username | PIN  | Role  | Keterangan                        |
|----------|------|-------|-----------------------------------|
| admin    | 0000 | Admin | Akses penuh semua fitur           |
| owner    | 1234 | Owner | Laporan keuangan + transaksi      |
| budi     | 1111 | Kasir | Transaksi harian saja             |
| sari     | 2222 | Kasir | Transaksi harian saja             |

Untuk menambah/edit akun, ubah array `AKUN` di `app.js` baris ~14.

---

## Hak Akses Per Role

| Fitur                  | Admin | Owner | Kasir | Layar Pembeli |
|------------------------|:-----:|:-----:|:-----:|:-------------:|
| Proses transaksi       | ✓     | ✓     | ✓     | —             |
| Void transaksi         | ✓     | ✓     | ✓     | —             |
| Laporan harian         | ✓     | ✓     | ✓     | —             |
| Laporan keuangan/Excel | ✓     | ✓     | —     | —             |
| Kelola menu & harga    | ✓     | ✓     | —     | —             |
| Kelola stok            | ✓     | ✓     | —     | —             |
| Manajemen user         | ✓     | —     | —     | —             |
| Setting aplikasi       | ✓     | —     | —     | —             |
| Tampilan pesanan       | ✓     | ✓     | ✓     | ✓ (read-only) |

---

## Struktur File

```
warung-kopi/
├── app.js          ← Server utama (Express + Socket.IO + SQLite)
├── index.html      ← Halaman kasir/owner/admin (login)
├── pembeli.html    ← Layar tampilan pembeli (no-login)
├── package.json    ← Dependency
├── warkop.db       ← Database SQLite (auto-dibuat saat pertama run)
├── public/
│   └── qris.png.png
└── CLAUDE.md       ← File ini
```

---

## API Endpoints

| Method | Endpoint               | Keterangan                        |
|--------|------------------------|-----------------------------------|
| POST   | /api/login             | Login → dapat role + hak akses   |
| GET    | /api/menu              | Ambil daftar menu                 |
| GET    | /api/laporan-keuangan  | Laporan (butuh header x-role)     |
| GET    | /api/hak-akses/:role   | Cek hak akses role tertentu       |

---

## Socket.IO Events

### Client → Server
| Event             | Siapa      | Keterangan                     |
|-------------------|------------|--------------------------------|
| `identify`        | semua      | Kirim role & username setelah login |
| `request-sync`    | kasir+     | Minta sinkronisasi data awal   |
| `update-total`    | kasir+     | Update harga ke layar pembeli  |
| `new-transaction` | kasir+     | Simpan transaksi baru          |
| `void-transaction`| kasir+     | Hapus transaksi terakhir       |

### Server → Client
| Event                | Keterangan                        |
|----------------------|-----------------------------------|
| `sync-data`          | Data lengkap (history + menu)     |
| `transaction-update` | Broadcast setelah transaksi       |
| `update-total`       | Update total ke semua layar       |
| `error`              | Pesan error akses ditolak         |

---

## Pengembangan Berikutnya (Saran)

1. **Halaman Admin** — UI khusus untuk kelola user & menu
2. **Laporan Harian Filter** — filter per tanggal/kasir
3. **Cetak Struk** — via window.print() atau library thermal printer
4. **Autentikasi JWT** — untuk keamanan lebih baik di production
5. **Deploy** — bisa pakai PM2 + Nginx di VPS
