const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

// Lokasi file database bisa diatur lewat environment variable DB_PATH.
// PENTING untuk hosting seperti Render: kalau tidak diatur ke folder disk permanen,
// data akan hilang tiap kali aplikasi redeploy/restart (filesystem-nya sementara).
// Default (tanpa DB_PATH): simpan di folder db/ seperti biasa, cocok untuk Termux/lokal.
const dbPath = process.env.DB_PATH || path.join(__dirname, 'freelance.db');

// Pastikan foldernya ada dulu (kalau DB_PATH nunjuk ke folder disk permanen yang baru dipasang)
try {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
} catch (e) {
  console.error('Gagal siapkan folder database:', e.message);
}

console.log('Database disimpan di:', dbPath, process.env.DB_PATH ? '(dari DB_PATH, permanen)' : '(lokasi default, HATI-HATI kalau di-hosting tanpa disk permanen)');

const db = new DatabaseSync(dbPath);

// Dimatikan dulu selama proses migrasi/perbaikan skema di bawah supaya tidak saling
// mengunci antar tabel (mis. gagal DROP TABLE jobs gara-gara masih direferensikan applications).
// Dinyalakan lagi di paling bawah setelah semua migrasi selesai.
db.exec('PRAGMA foreign_keys = OFF');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  phone TEXT,
  password TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('client','freelancer','admin')),
  balance INTEGER NOT NULL DEFAULT 0,
  bank_name TEXT,
  bank_account_number TEXT,
  bank_account_holder TEXT,
  referral_code TEXT,
  referred_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
`);

try { db.exec('ALTER TABLE users ADD COLUMN phone TEXT'); } catch (e) {}

// Migrasi aman: kalau database lama belum punya kolom ini, tambahkan (diabaikan kalau sudah ada)
try { db.exec('ALTER TABLE users ADD COLUMN bank_name TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE users ADD COLUMN bank_account_number TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE users ADD COLUMN bank_account_holder TEXT'); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN level TEXT NOT NULL DEFAULT 'VIP 0'"); } catch (e) {}

// Migrasi: sistem level lama pakai Bronze/Silver/Gold, sekarang pakai VIP 0/VIP 1/VIP 2
try {
  db.prepare("UPDATE users SET level = 'VIP 0' WHERE level = 'Bronze'").run();
  db.prepare("UPDATE users SET level = 'VIP 1' WHERE level = 'Silver'").run();
  db.prepare("UPDATE users SET level = 'VIP 2' WHERE level = 'Gold'").run();
} catch (e) {
  console.error('Gagal migrasi label level ke VIP:', e.message);
}
try { db.exec('ALTER TABLE users ADD COLUMN referral_code TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE users ADD COLUMN referred_by INTEGER'); } catch (e) {}
try { db.exec('ALTER TABLE users ADD COLUMN foto_url TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE users ADD COLUMN bio TEXT'); } catch (e) {}

// Migrasi: email dulu wajib untuk semua user, sekarang hanya dipakai admin (opsional untuk user biasa).
// SQLite tidak bisa langsung hapus NOT NULL, jadi bikin ulang tabelnya kalau masih versi lama.
// PENTING: tabel baru dibuat dengan nama sementara dulu (users_new), baru tabel lama di-DROP,
// baru tabel baru di-RENAME jadi 'users'. Kalau langsung RENAME users -> users_old, SQLite otomatis
// "mengikuti" nama itu di semua tabel lain yang mereferensikan users (tasks, balance_transactions,
// withdrawal_requests, dll) sehingga FK-nya jadi nyasar ke users_old dan bikin error waktu insert.
try {
  const emailCol = db.prepare("PRAGMA table_info(users)").all().find(c => c.name === 'email');
  if (emailCol && emailCol.notnull === 1) {
    db.exec(`
      CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE,
        phone TEXT,
        password TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('client','freelancer','admin')),
        balance INTEGER NOT NULL DEFAULT 0,
        bank_name TEXT,
        bank_account_number TEXT,
        bank_account_holder TEXT,
        level TEXT NOT NULL DEFAULT 'VIP 0',
        referral_code TEXT,
        referred_by INTEGER,
        foto_url TEXT,
        bio TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    const kolomUsersLama = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
    const kolomDipakai = kolomUsersLama.filter(c =>
      ['id','name','email','phone','password','role','balance','bank_name','bank_account_number','bank_account_holder','level','referral_code','referred_by','foto_url','bio','created_at'].includes(c)
    ).join(', ');
    db.exec(`
      INSERT INTO users_new (${kolomDipakai})
      SELECT ${kolomDipakai} FROM users
    `);
    db.exec('DROP TABLE users');
    db.exec('ALTER TABLE users_new RENAME TO users');
  }
} catch (e) {
  console.error('Migrasi email nullable gagal:', e.message);
}

// Nomor HP jadi identitas login utama user biasa, harus unik (email tetap unik juga untuk admin)
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone IS NOT NULL'); } catch (e) {}
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code) WHERE referral_code IS NOT NULL'); } catch (e) {}

// Kasih kode referral ke user lama yang belum punya (user baru dapat otomatis saat daftar)
try {
  const belumPunyaKode = db.prepare('SELECT id FROM users WHERE referral_code IS NULL').all();
  const updateKode = db.prepare('UPDATE users SET referral_code = ? WHERE id = ?');
  belumPunyaKode.forEach(u => {
    let kode;
    do {
      kode = Math.random().toString(36).slice(2, 8).toUpperCase();
    } while (db.prepare('SELECT id FROM users WHERE referral_code = ?').get(kode));
    updateKode.run(kode, u.id);
  });
} catch (e) {
  console.error('Gagal buat kode referral user lama:', e.message);
}

// PERBAIKAN: kalau database ini sempat kena bug migrasi versi sebelumnya (FK tabel lain nyasar
// merujuk ke 'users_old' yang sudah dihapus), betulkan di sini dengan bikin ulang tabelnya
// pakai skema yang benar (FK ke 'users'), sambil pertahankan semua data yang sudah ada.
function perbaikiFkNyasar(tableName, createSqlBenar) {
  try {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
    if (row && row.sql && row.sql.includes('users_old')) {
      // Buang dulu sisa tabel sementara dari percobaan sebelumnya yang mungkin gagal
      // di tengah jalan (mis. karena ada 2 server nyala bersamaan), supaya bisa dicoba ulang.
      try { db.exec(`DROP TABLE IF EXISTS ${tableName}_fix`); } catch (e2) {}

      const cols = db.prepare(`PRAGMA table_info(${tableName})`).all().map(c => c.name).join(', ');
      db.exec(createSqlBenar.replace(`CREATE TABLE ${tableName}`, `CREATE TABLE ${tableName}_fix`));
      db.exec(`INSERT INTO ${tableName}_fix (${cols}) SELECT ${cols} FROM ${tableName}`);
      db.exec(`DROP TABLE ${tableName}`);
      db.exec(`ALTER TABLE ${tableName}_fix RENAME TO ${tableName}`);
      console.log(`Perbaikan skema tabel '${tableName}' berhasil (FK yang tadinya nyasar sudah dibetulkan).`);
    } else {
      // Tabel utama sudah normal. Kalau ada sisa tabel sementara nyangkut dari percobaan
      // gagal sebelumnya (sudah tidak terpakai), buang saja supaya tidak numpuk.
      try { db.exec(`DROP TABLE IF EXISTS ${tableName}_fix`); } catch (e2) {}
    }
  } catch (e) {
    console.error(`Gagal perbaiki tabel '${tableName}':`, e.message);
  }
}

perbaikiFkNyasar('withdrawal_requests', `
  CREATE TABLE withdrawal_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    bank_name TEXT,
    bank_account_number TEXT,
    bank_account_holder TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','rejected')),
    catatan TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    processed_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

perbaikiFkNyasar('jobs', `
  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    budget INTEGER NOT NULL,
    category TEXT,
    client_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (client_id) REFERENCES users(id)
  )
`);

perbaikiFkNyasar('applications', `
  CREATE TABLE applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    freelancer_id INTEGER NOT NULL,
    message TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (job_id) REFERENCES jobs(id),
    FOREIGN KEY (freelancer_id) REFERENCES users(id),
    UNIQUE(job_id, freelancer_id)
  )
`);

perbaikiFkNyasar('balance_transactions', `
  CREATE TABLE balance_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    note TEXT,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (created_by) REFERENCES users(id)
  )
`);

perbaikiFkNyasar('tasks', `
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    harga INTEGER NOT NULL DEFAULT 0,
    kategori TEXT NOT NULL DEFAULT 'Lainnya',
    reward INTEGER NOT NULL,
    assigned_to INTEGER NOT NULL,
    assigned_by INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('locked','pending','completed','approved','rejected')),
    template_id INTEGER,
    urutan INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    FOREIGN KEY (assigned_to) REFERENCES users(id),
    FOREIGN KEY (assigned_by) REFERENCES users(id)
  )
`);

db.exec(`
CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  bank_name TEXT,
  bank_account_number TEXT,
  bank_account_holder TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','rejected')),
  catatan TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  processed_at DATETIME,
  FOREIGN KEY (user_id) REFERENCES users(id)
)
`);

// Migrasi aman: kalau tabel withdrawal_requests sudah ada dari versi lama, tambahkan kolom catatan
try { db.exec('ALTER TABLE withdrawal_requests ADD COLUMN catatan TEXT'); } catch (e) {}

db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  budget INTEGER NOT NULL,
  category TEXT,
  client_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES users(id)
)
`);

db.exec(`
CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  freelancer_id INTEGER NOT NULL,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (job_id) REFERENCES jobs(id),
  FOREIGN KEY (freelancer_id) REFERENCES users(id),
  UNIQUE(job_id, freelancer_id)
)
`);

db.exec(`
CREATE TABLE IF NOT EXISTS balance_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  note TEXT,
  created_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
)
`);

db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  harga INTEGER NOT NULL DEFAULT 0,
  kategori TEXT NOT NULL DEFAULT 'Lainnya',
  reward INTEGER NOT NULL,
  assigned_to INTEGER NOT NULL,
  assigned_by INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('locked','pending','completed','approved','rejected')),
  template_id INTEGER,
  urutan INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  FOREIGN KEY (assigned_to) REFERENCES users(id),
  FOREIGN KEY (assigned_by) REFERENCES users(id)
)
`);

// Migrasi aman: kalau tabel tasks sudah ada dari versi lama, tambahkan kolom harga & kategori
try { db.exec('ALTER TABLE tasks ADD COLUMN harga INTEGER NOT NULL DEFAULT 0'); } catch (e) {}
try { db.exec("ALTER TABLE tasks ADD COLUMN kategori TEXT NOT NULL DEFAULT 'Lainnya'"); } catch (e) {}
try { db.exec('ALTER TABLE tasks ADD COLUMN template_id INTEGER'); } catch (e) {}
try { db.exec('ALTER TABLE tasks ADD COLUMN urutan INTEGER'); } catch (e) {}

// Migrasi aman: kalau CHECK constraint status di tabel tasks belum mengizinkan 'locked'
// (dipakai untuk tugas berantai dari Paket Tugas), bikin ulang tabelnya sambil pertahankan semua data.
// Pola create-baru-dulu-baru-drop-yang-lama dipakai supaya tabel lain yang mereferensikan tasks
// (kalau ada nanti) tidak ikut nyasar namanya, sama seperti perbaikan users_old sebelumnya.
try {
  const tasksSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get();
  if (tasksSql && tasksSql.sql && !tasksSql.sql.includes("'locked'")) {
    db.exec(`
      CREATE TABLE tasks_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        harga INTEGER NOT NULL DEFAULT 0,
        kategori TEXT NOT NULL DEFAULT 'Lainnya',
        reward INTEGER NOT NULL,
        assigned_to INTEGER NOT NULL,
        assigned_by INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('locked','pending','completed','approved','rejected')),
        template_id INTEGER,
        urutan INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        FOREIGN KEY (assigned_to) REFERENCES users(id),
        FOREIGN KEY (assigned_by) REFERENCES users(id)
      )
    `);
    const cols = db.prepare('PRAGMA table_info(tasks)').all().map(c => c.name).join(', ');
    db.exec(`INSERT INTO tasks_new (${cols}) SELECT ${cols} FROM tasks`);
    db.exec('DROP TABLE tasks');
    db.exec('ALTER TABLE tasks_new RENAME TO tasks');
    console.log("Perbaikan skema tabel 'tasks' berhasil (status 'locked' untuk tugas berantai sudah didukung).");
  }
} catch (e) {
  console.error("Gagal migrasi status 'locked' di tabel tasks:", e.message);
}

// Paket Tugas: satu paket berisi beberapa tugas sekaligus, admin bikin sekali, dipakai berkali-kali ke banyak user
db.exec(`
CREATE TABLE IF NOT EXISTS task_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id)
)
`);

db.exec(`
CREATE TABLE IF NOT EXISTS task_template_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  harga INTEGER NOT NULL DEFAULT 0,
  kategori TEXT NOT NULL DEFAULT 'Lainnya',
  reward INTEGER NOT NULL,
  FOREIGN KEY (template_id) REFERENCES task_templates(id)
)
`);

// Log aktivitas admin
db.exec(`
CREATE TABLE IF NOT EXISTS activity_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER,
  admin_name TEXT,
  action TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (admin_id) REFERENCES users(id)
)
`);

// Semua migrasi dan pembuatan tabel sudah selesai, nyalakan kembali pengecekan relasi
db.exec('PRAGMA foreign_keys = ON');

// Helper: catat satu baris log aktivitas admin. Dipakai di routes/admin.js.
function catatLog(adminUser, action) {
  try {
    db.prepare('INSERT INTO activity_logs (admin_id, admin_name, action) VALUES (?, ?, ?)')
      .run(adminUser.id, adminUser.name, action);
  } catch (e) {
    console.error('Gagal catat log aktivitas:', e.message);
  }
}

module.exports = db;
module.exports.catatLog = catatLog;

// Bonus flat sekali untuk user yang berhasil ajak teman daftar (bukan skema berjenjang)
module.exports.REFERRAL_BONUS = 10000;
