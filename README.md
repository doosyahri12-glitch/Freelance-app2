# FreelanceKu — Website Job Freelance dengan Login

Website sederhana untuk mencari/posting pekerjaan freelance.
- Client bisa posting pekerjaan
- Freelancer bisa melamar pekerjaan
- Login & register dengan password terenkripsi
- Database SQLite (file, tidak perlu install server terpisah)

## Cara Menjalankan di Termux (HP Android)

### 1. Install Termux
Download Termux dari **F-Droid** (bukan Play Store, versi Play Store sudah tidak dikembangkan).
https://f-droid.org/packages/com.termux/

### 2. Update paket & install Node.js
Buka Termux, lalu ketik:
```
pkg update && pkg upgrade -y
pkg install nodejs git -y
```
Cek instalasi berhasil:
```
node -v
npm -v
```

### 3. Pindahkan folder project ke HP
Beberapa cara:
- **Cara termudah:** extract file `freelance-app.zip` yang saya berikan ke folder `Download` di HP kamu, lalu di Termux ketik:
  ```
  termux-setup-storage
  cp -r /storage/emulated/0/Download/freelance-app ~/freelance-app
  cd ~/freelance-app
  ```
  (saat `termux-setup-storage` muncul izin akses, tekan Izinkan)

### 4. Install dependency
```
npm install
```
Proses ini butuh waktu beberapa menit karena `better-sqlite3` di-compile langsung di HP.

Jika muncul error saat install `better-sqlite3` (butuh compiler), install dulu:
```
pkg install python clang make -y
npm install
```

### 5. Jalankan server
```
npm start
```
Kalau berhasil akan muncul tulisan:
```
Server jalan di http://localhost:3000
```

### 6. Buka di browser
Buka browser di HP yang sama, kunjungi:
```
http://localhost:3000
```

## Struktur Project
```
freelance-app/
├── server.js          -> file utama server
├── db/database.js     -> setup database SQLite
├── middleware/auth.js -> proteksi halaman login
├── routes/auth.js     -> register, login, logout
├── routes/jobs.js     -> posting & lamar pekerjaan
├── views/              -> halaman HTML (EJS)
└── public/css/         -> styling
```

## Catatan Keamanan
- Ganti nilai `secret` di `server.js` (bagian `session(...)`) dengan teks acak sebelum dipakai publik.
- Database tersimpan di `db/freelance.db`, jangan diupload ke tempat publik karena berisi data user.

## Mengembangkan Lebih Lanjut
Beberapa ide fitur tambahan yang bisa ditambahkan nanti:
- Upload foto profil / portofolio
- Fitur chat antara client & freelancer
- Sistem rating setelah pekerjaan selesai
- Filter & pencarian pekerjaan berdasarkan kategori
