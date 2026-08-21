const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { requireLogin } = require('../middleware/auth');

// Samarkan nama untuk ditampilkan di feed publik, mis. "Budi Santoso" -> "Budi S."
function maskName(name) {
  const parts = (name || '').trim().split(/\s+/);
  if (parts.length === 1) {
    return parts[0].length > 2 ? parts[0].slice(0, 2) + '***' : parts[0] + '***';
  }
  return parts[0] + ' ' + parts[parts.length - 1].charAt(0).toUpperCase() + '.';
}

// Jumlah notifikasi yang perlu diperhatikan user: tugas belum dikerjakan + tugas/penarikan yang baru saja diproses admin
function getNotifCount(userId) {
  const pendingTasks = db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE assigned_to = ? AND status = 'pending'").get(userId).c;
  const recentProcessed = db.prepare(`
    SELECT COUNT(*) AS c FROM tasks
    WHERE assigned_to = ? AND status IN ('approved','rejected')
    AND created_at >= datetime('now', '-2 days')
  `).get(userId).c;
  return pendingTasks + recentProcessed;
}

// Ambang jumlah tugas selesai yang disarankan untuk tiap level (murni referensi buat admin, TIDAK otomatis naik level)
const LEVEL_THRESHOLDS = { 'VIP 0': 0, 'VIP 1': 5, 'VIP 2': 20 };
const LEVEL_ORDER = ['VIP 0', 'VIP 1', 'VIP 2'];

function getLevelProgress(level, approvedCount) {
  const idx = LEVEL_ORDER.indexOf(level);
  if (idx === -1 || idx === LEVEL_ORDER.length - 1) {
    return { isMax: true, nextLevel: null, needed: 0, percent: 100 };
  }
  const nextLevel = LEVEL_ORDER[idx + 1];
  const currentThreshold = LEVEL_THRESHOLDS[level];
  const nextThreshold = LEVEL_THRESHOLDS[nextLevel];
  const progressInBand = Math.max(0, approvedCount - currentThreshold);
  const bandSize = nextThreshold - currentThreshold;
  const percent = Math.min(100, Math.round((progressInBand / bandSize) * 100));
  const needed = Math.max(0, nextThreshold - approvedCount);
  return { isMax: false, nextLevel, needed, percent };
}

// Lencana pencapaian, dihitung dari data asli (bukan disimpan terpisah)
function getBadges(approvedCount, withdrawalCompletedCount, referredCount) {
  return [
    { icon: 'fa-star', label: '5 Tugas Selesai', unlocked: approvedCount >= 5 },
    { icon: 'fa-medal', label: '10 Tugas Selesai', unlocked: approvedCount >= 10 },
    { icon: 'fa-trophy', label: '25 Tugas Selesai', unlocked: approvedCount >= 25 },
    { icon: 'fa-money-bill-wave', label: 'Penarikan Pertama', unlocked: withdrawalCompletedCount >= 1 },
    { icon: 'fa-user-plus', label: 'Ajak Teman Pertama', unlocked: referredCount >= 1 },
  ];
}

// Halaman utama: arahkan ke dashboard kalau sudah login, atau ke login kalau belum
router.get('/', (req, res) => {
  if (req.session.user) {
    if (req.session.user.role === 'admin') return res.redirect('/admin');
    return res.redirect('/dashboard');
  }
  res.redirect('/login');
});

// Menu Utama: freelancer lihat ringkasan saldo + tugas. Admin diarahkan ke dashboard admin
// Kutipan motivasi harian, berganti otomatis tiap hari (bukan acak tiap refresh)
const KUTIPAN_HARIAN = [
  'Sedikit demi sedikit, lama-lama jadi bukit. Selesaikan satu tugas hari ini.',
  'Konsistensi kecil setiap hari mengalahkan usaha besar sesekali.',
  'Setiap tugas yang selesai adalah langkah lebih dekat ke tujuanmu.',
  'Mulai dari yang bisa kamu kerjakan sekarang.',
  'Kerja jujur, hasil pasti mengikuti.',
  'Fokus pada progres, bukan kesempurnaan.',
  'Hari ini adalah kesempatan baru untuk menambah penghasilan.',
  'Disiplin kecil hari ini, hasil besar nanti.',
  'Semangat! Satu tugas lagi, satu langkah lebih maju.',
  'Usaha yang konsisten akan selalu berbuah hasil.'
];
function getKutipanHarian() {
  const hariKe = Math.floor(Date.now() / (1000 * 60 * 60 * 24));
  return KUTIPAN_HARIAN[hariKe % KUTIPAN_HARIAN.length];
}

router.get('/dashboard', requireLogin, (req, res) => {
  const user = req.session.user;

  if (user.role === 'admin') {
    return res.redirect('/admin');
  }

  const fresh = db.prepare('SELECT balance FROM users WHERE id = ?').get(user.id);
  const balance = fresh ? fresh.balance : 0;
  const pendingTasks = db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE assigned_to = ? AND status = 'pending'").get(user.id).c;
  const tasks = db.prepare("SELECT * FROM tasks WHERE assigned_to = ? AND status IN ('pending','completed') ORDER BY created_at DESC LIMIT 5").all(user.id);

  // Ringkasan progres Paket Tugas yang lagi/baru dikerjakan user (data asli dari tabel tasks)
  const paketList = db.prepare(`
    SELECT tasks.template_id, task_templates.name AS nama_paket,
           COUNT(*) AS total_tugas,
           SUM(CASE WHEN tasks.status = 'approved' THEN 1 ELSE 0 END) AS selesai,
           SUM(CASE WHEN tasks.status = 'approved' THEN tasks.reward ELSE 0 END) AS komisi_terkumpul,
           MAX(tasks.created_at) AS terakhir_update
    FROM tasks
    JOIN task_templates ON task_templates.id = tasks.template_id
    WHERE tasks.assigned_to = ? AND tasks.template_id IS NOT NULL
    GROUP BY tasks.template_id
    ORDER BY terakhir_update DESC
  `).all(user.id);
  // Utamakan paket yang masih berjalan; kalau semua sudah tuntas, tampilkan yang paling baru selesai
  const paketAktif = paketList.find(p => p.selesai < p.total_tugas) || paketList[0] || null;

  // Feed penarikan yang BENAR-BENAR sudah selesai (bukan data karangan), nama disamarkan
  const recentWithdrawalsRaw = db.prepare(`
    SELECT withdrawal_requests.amount, withdrawal_requests.processed_at, users.name
    FROM withdrawal_requests JOIN users ON withdrawal_requests.user_id = users.id
    WHERE withdrawal_requests.status = 'completed'
    ORDER BY withdrawal_requests.processed_at DESC
    LIMIT 20
  `).all();
  const recentWithdrawals = recentWithdrawalsRaw.map(w => ({
    amount: w.amount,
    maskedName: maskName(w.name)
  }));

  res.render('dashboard_freelancer', { user, balance, pendingTasks, tasks, recentWithdrawals, notifCount: getNotifCount(user.id), paketAktif, kutipanHarian: getKutipanHarian() });
});

// Tugas: daftar tugas yang diberikan admin ke user ini
router.get('/tugas', requireLogin, (req, res) => {
  const user = req.session.user;
  if (user.role === 'admin') return res.redirect('/admin');

  // Cuma tugas yang masih aktif (belum kelar) yang ditampilkan di daftar/pop-up.
  // Tugas yang sudah disetujui/ditolak otomatis "hilang" dari sini, tapi tetap tercatat
  // penuh di Riwayat, Notifikasi, dan sisi admin.
  const tasks = db.prepare("SELECT * FROM tasks WHERE assigned_to = ? AND status IN ('pending','completed') ORDER BY created_at DESC").all(user.id);

  const fresh = db.prepare('SELECT balance, level FROM users WHERE id = ?').get(user.id);
  const ringkasan = db.prepare(`
    SELECT COUNT(*) AS total_tugas,
           SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS selesai,
           SUM(CASE WHEN status = 'approved' THEN reward ELSE 0 END) AS total_komisi
    FROM tasks WHERE assigned_to = ?
  `).get(user.id);

  res.render('tugas', {
    user, tasks, notifCount: getNotifCount(user.id),
    level: fresh.level, balance: fresh.balance,
    totalTugas: ringkasan.total_tugas || 0,
    selesai: ringkasan.selesai || 0,
    totalKomisi: ringkasan.total_komisi || 0
  });
});

// Riwayat: riwayat saldo user, bisa difilter berdasarkan rentang tanggal
router.get('/riwayat', requireLogin, (req, res) => {
  const user = req.session.user;
  if (user.role === 'admin') return res.redirect('/admin');

  const startDate = req.query.start_date || '';
  const endDate = req.query.end_date || '';

  let query = 'SELECT * FROM balance_transactions WHERE user_id = ?';
  const params = [user.id];

  if (startDate) {
    query += ' AND date(created_at) >= date(?)';
    params.push(startDate);
  }
  if (endDate) {
    query += ' AND date(created_at) <= date(?)';
    params.push(endDate);
  }
  query += ' ORDER BY created_at DESC';

  const transactions = db.prepare(query).all(...params);

  // Grafik komisi 7 hari terakhir (data asli, sama caranya seperti grafik admin, tanpa library luar)
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  const komisiRows = db.prepare(`
    SELECT date(created_at) AS day, COALESCE(SUM(amount),0) AS total
    FROM balance_transactions
    WHERE user_id = ? AND amount > 0 AND date(created_at) >= date('now', '-6 days')
    GROUP BY day
  `).all(user.id);
  const komisiMap = Object.fromEntries(komisiRows.map(r => [r.day, r.total]));
  const grafikLabel = days.map(d => d.slice(5).split('-').reverse().join('/'));
  const grafikKomisi = days.map(d => komisiMap[d] || 0);

  res.render('riwayat', { user, transactions, startDate, endDate, notifCount: getNotifCount(user.id), grafikLabel, grafikKomisi });
});

// Notifikasi: gabungan update tugas & penarikan milik user sendiri
router.get('/notifikasi', requireLogin, (req, res) => {
  const user = req.session.user;
  if (user.role === 'admin') return res.redirect('/admin');

  const taskEvents = db.prepare(`
    SELECT 'task' AS type, title AS label, status, created_at AS waktu, reward AS amount
    FROM tasks WHERE assigned_to = ? AND status != 'locked'
  `).all(user.id);

  const withdrawalEvents = db.prepare(`
    SELECT 'withdrawal' AS type, 'Penarikan' AS label, status, COALESCE(processed_at, created_at) AS waktu, amount, catatan
    FROM withdrawal_requests WHERE user_id = ?
  `).all(user.id);

  const notifications = [...taskEvents, ...withdrawalEvents]
    .sort((a, b) => new Date(b.waktu) - new Date(a.waktu))
    .slice(0, 30);

  // Kalau notifikasi paling atas adalah komisi yang baru cair, tampilkan animasi konfeti sekali
  const adaKomisiBaru = notifications.length > 0 &&
    ((notifications[0].type === 'task' && notifications[0].status === 'approved') ||
     (notifications[0].type === 'withdrawal' && notifications[0].status === 'completed'));

  res.render('notifikasi', { user, notifications, adaKomisiBaru });
});

// Papan Peringkat: user paling produktif berdasarkan jumlah tugas selesai (data asli), nama disamarkan
router.get('/papan-peringkat', requireLogin, (req, res) => {
  const user = req.session.user;
  if (user.role === 'admin') return res.redirect('/admin');

  const topRaw = db.prepare(`
    SELECT users.id, users.name, COUNT(tasks.id) AS jumlah_tugas
    FROM users
    JOIN tasks ON tasks.assigned_to = users.id AND tasks.status = 'approved'
    WHERE users.role = 'freelancer'
    GROUP BY users.id
    ORDER BY jumlah_tugas DESC
    LIMIT 10
  `).all();

  const top = topRaw.map((u, i) => ({
    rank: i + 1,
    maskedName: maskName(u.name),
    jumlahTugas: u.jumlah_tugas,
    isMe: u.id === user.id
  }));

  const myApproved = db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE assigned_to = ? AND status = 'approved'").get(user.id).c;

  res.render('papan_peringkat', { user, top, myApproved, notifCount: getNotifCount(user.id) });
});

// Akun: profil, saldo, kaitkan rekening bank, dan logout
router.get('/akun', requireLogin, (req, res) => {
  const user = req.session.user;
  if (user.role === 'admin') return res.redirect('/admin');

  const fresh = db.prepare('SELECT balance, level, bank_name, bank_account_number, bank_account_holder, referral_code, foto_url, bio FROM users WHERE id = ?').get(user.id);
  const balance = fresh ? fresh.balance : 0;
  const level = fresh ? fresh.level : 'VIP 0';
  const bank = fresh || { bank_name: '', bank_account_number: '', bank_account_holder: '' };

  const pendingWithdrawal = db.prepare(
    "SELECT COALESCE(SUM(amount),0) AS s FROM withdrawal_requests WHERE user_id = ? AND status = 'pending'"
  ).get(user.id).s;

  const withdrawals = db.prepare(
    'SELECT * FROM withdrawal_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 5'
  ).all(user.id);

  const approvedCount = db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE assigned_to = ? AND status = 'approved'").get(user.id).c;
  const withdrawalCompletedCount = db.prepare("SELECT COUNT(*) AS c FROM withdrawal_requests WHERE user_id = ? AND status = 'completed'").get(user.id).c;
  const referredCount = db.prepare('SELECT COUNT(*) AS c FROM users WHERE referred_by = ?').get(user.id).c;
  const belumSelesaiCount = db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE assigned_to = ? AND status = 'pending'").get(user.id).c;

  const levelProgress = getLevelProgress(level, approvedCount);
  const badges = getBadges(approvedCount, withdrawalCompletedCount, referredCount);

  res.render('akun', {
    user, balance, level, bank, pendingWithdrawal, withdrawals, belumSelesaiCount,
    error: req.query.error || null, notifCount: getNotifCount(user.id),
    referralCode: fresh.referral_code, referredCount, levelProgress, badges,
    fotoUrl: fresh.foto_url, bio: fresh.bio
  });
});

// User mengajukan penarikan saldo
router.post('/penarikan', requireLogin, (req, res) => {
  const userId = req.session.user.id;
  const amount = parseInt(req.body.amount, 10);

  const fresh = db.prepare('SELECT balance, bank_name, bank_account_number, bank_account_holder FROM users WHERE id = ?').get(userId);
  const pendingWithdrawal = db.prepare(
    "SELECT COALESCE(SUM(amount),0) AS s FROM withdrawal_requests WHERE user_id = ? AND status = 'pending'"
  ).get(userId).s;
  const available = fresh.balance - pendingWithdrawal;

  if (!fresh.bank_account_number) {
    return res.redirect('/akun?error=' + encodeURIComponent('Isi dulu rekening bank kamu sebelum menarik saldo.'));
  }

  const belumSelesai = db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE assigned_to = ? AND status = 'pending'").get(userId).c;
  if (belumSelesai > 0) {
    return res.redirect('/akun?error=' + encodeURIComponent('Penarikan tidak dapat dilakukan karena terdapat tugas yang belum selesai.'));
  }

  if (isNaN(amount) || amount <= 0) {
    return res.redirect('/akun?error=' + encodeURIComponent('Jumlah penarikan tidak valid.'));
  }
  if (amount < 50000) {
    return res.redirect('/akun?error=' + encodeURIComponent('Minimal penarikan Rp50.000.'));
  }
  if (amount > available) {
    return res.redirect('/akun?error=' + encodeURIComponent('Jumlah melebihi saldo yang tersedia untuk ditarik.'));
  }

  db.prepare(`
    INSERT INTO withdrawal_requests (user_id, amount, bank_name, bank_account_number, bank_account_holder)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, amount, fresh.bank_name, fresh.bank_account_number, fresh.bank_account_holder);

  res.redirect('/akun');
});

// Simpan / update rekening bank milik user sendiri
router.post('/account/bank', requireLogin, (req, res) => {
  const { bank_name, bank_account_number, bank_account_holder } = req.body;
  db.prepare('UPDATE users SET bank_name = ?, bank_account_number = ?, bank_account_holder = ? WHERE id = ?')
    .run(bank_name || '', bank_account_number || '', bank_account_holder || '', req.session.user.id);
  res.redirect('/akun');
});

// User menandai tugas dari admin sebagai selesai
router.post('/tasks/:id/complete', requireLogin, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).send('Tugas tidak ditemukan.');
  if (task.assigned_to !== req.session.user.id) return res.status(403).send('Akses ditolak.');
  if (task.status !== 'pending') return res.redirect('/tugas');

  if (task.harga > 0) {
    // Tugas yang punya harga (mis. perlu bukti pembelian produk) tetap perlu direview admin dulu
    db.prepare("UPDATE tasks SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?").run(task.id);
  } else {
    // Tugas tanpa harga: otomatis disetujui begitu ditandai selesai, komisi langsung cair
    db.prepare("UPDATE tasks SET status = 'approved', completed_at = CURRENT_TIMESTAMP WHERE id = ?").run(task.id);
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(task.reward, task.assigned_to);
    db.prepare('INSERT INTO balance_transactions (user_id, amount, note, created_by) VALUES (?, ?, ?, ?)')
      .run(task.assigned_to, task.reward, 'Tugas selesai (otomatis disetujui): ' + task.title, task.assigned_by);

    // Kalau bagian dari Paket Tugas berantai, buka otomatis tugas berikutnya
    if (task.template_id && task.urutan) {
      db.prepare(`
        UPDATE tasks SET status = 'pending'
        WHERE template_id = ? AND assigned_to = ? AND urutan = ? AND status = 'locked'
      `).run(task.template_id, task.assigned_to, task.urutan + 1);
    }
  }

  res.redirect('/tugas');
});

// Form edit profil (nama & nomor hp)
router.get('/akun/edit', requireLogin, (req, res) => {
  const user = req.session.user;
  if (user.role === 'admin') return res.redirect('/admin');

  const fresh = db.prepare('SELECT name, phone, email, foto_url, bio FROM users WHERE id = ?').get(user.id);
  res.render('akun_edit', { user, profile: fresh, error: req.query.error || null, notifCount: getNotifCount(user.id) });
});

// Simpan perubahan profil
router.post('/akun/edit', requireLogin, (req, res) => {
  const userId = req.session.user.id;
  const { name, phone, foto_url, bio } = req.body;

  if (!name || !phone) {
    return res.redirect('/akun/edit?error=' + encodeURIComponent('Nama dan nomor HP wajib diisi.'));
  }

  const existingPhone = db.prepare('SELECT id FROM users WHERE phone = ? AND id != ?').get(phone, userId);
  if (existingPhone) {
    return res.redirect('/akun/edit?error=' + encodeURIComponent('Nomor HP sudah dipakai akun lain.'));
  }

  const bioTrimmed = (bio || '').trim().slice(0, 150);
  db.prepare('UPDATE users SET name = ?, phone = ?, foto_url = ?, bio = ? WHERE id = ?').run(name, phone, foto_url || null, bioTrimmed || null, userId);

  // Update juga nama di session supaya langsung berubah tanpa perlu login ulang
  req.session.user.name = name;

  res.redirect('/akun');
});

// Bantuan / FAQ, nomor WA diambil otomatis dari akun admin
router.get('/bantuan', requireLogin, (req, res) => {
  const admin = db.prepare("SELECT phone FROM users WHERE role = 'admin' AND phone IS NOT NULL LIMIT 1").get();
  res.render('bantuan', { user: req.session.user, adminPhone: admin ? admin.phone : null, notifCount: getNotifCount(req.session.user.id) });
});

// Tentang Aplikasi
router.get('/tentang', (req, res) => {
  res.render('tentang', { user: req.session.user || null, notifCount: req.session.user ? getNotifCount(req.session.user.id) : 0 });
});

// Syarat & Ketentuan
router.get('/syarat-ketentuan', (req, res) => {
  res.render('syarat_ketentuan', { user: req.session.user || null });
});

module.exports = router;
