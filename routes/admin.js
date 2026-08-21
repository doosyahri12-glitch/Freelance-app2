const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { requireLogin, requireRole } = require('../middleware/auth');

// Semua route di file ini wajib login sebagai admin
router.use(requireLogin, requireRole('admin'));

// Dashboard utama admin: ringkasan statistik
router.get('/admin', (req, res) => {
  try {
  const totalUsers = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const totalBalance = db.prepare('SELECT COALESCE(SUM(balance),0) AS s FROM users').get().s;
  const pendingReview = db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE status = 'completed'").get().c;
  const pendingWithdrawal = db.prepare("SELECT COUNT(*) AS c FROM withdrawal_requests WHERE status = 'pending'").get().c;
  const totalTasksApproved = db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE status = 'approved'").get().c;
  const totalWithdrawn = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM withdrawal_requests WHERE status = 'completed'").get().s;

  // Siapkan data grafik 7 hari terakhir: saldo masuk ke user (bonus+tugas) vs penarikan yang sudah selesai
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }

  const masukRows = db.prepare(`
    SELECT date(created_at) AS day, COALESCE(SUM(amount),0) AS total
    FROM balance_transactions
    WHERE amount > 0 AND date(created_at) >= date('now', '-6 days')
    GROUP BY day
  `).all();
  const keluarRows = db.prepare(`
    SELECT date(processed_at) AS day, COALESCE(SUM(amount),0) AS total
    FROM withdrawal_requests
    WHERE status = 'completed' AND date(processed_at) >= date('now', '-6 days')
    GROUP BY day
  `).all();

  const masukMap = Object.fromEntries(masukRows.map(r => [r.day, r.total]));
  const keluarMap = Object.fromEntries(keluarRows.map(r => [r.day, r.total]));

  const chartLabels = days.map(d => d.slice(5).split('-').reverse().join('/')); // format DD/MM
  const chartMasuk = days.map(d => masukMap[d] || 0);
  const chartKeluar = days.map(d => keluarMap[d] || 0);

  // Ringkasan terbaru: yang paling butuh perhatian admin duluan
  const tugasMenunggu = db.prepare(`
    SELECT tasks.id, tasks.title, tasks.reward, users.name AS nama_user
    FROM tasks JOIN users ON users.id = tasks.assigned_to
    WHERE tasks.status = 'completed'
    ORDER BY tasks.created_at DESC LIMIT 5
  `).all();
  const penarikanMenunggu = db.prepare(`
    SELECT withdrawal_requests.id, withdrawal_requests.amount, users.name AS nama_user
    FROM withdrawal_requests JOIN users ON users.id = withdrawal_requests.user_id
    WHERE withdrawal_requests.status = 'pending'
    ORDER BY withdrawal_requests.created_at DESC LIMIT 5
  `).all();

  res.render('admin_dashboard', {
    user: req.session.user,
    stats: { totalUsers, totalBalance, pendingReview, pendingWithdrawal, totalTasksApproved, totalWithdrawn },
    chartLabels, chartMasuk, chartKeluar, tugasMenunggu, penarikanMenunggu
  });
  } catch (err) {
    console.error('ERROR DI DASHBOARD ADMIN:', err);
    res.status(500).send('<pre>ERROR DI DASHBOARD ADMIN:\n' + err.stack + '</pre>');
  }
});

// Daftar semua akun / profil user (bisa dicari berdasarkan nama)
router.get('/admin/users', (req, res) => {
  const search = (req.query.search || '').trim();
  let users;
  if (search) {
    users = db.prepare(
      'SELECT id, name, email, phone, role, balance, level, bank_name, bank_account_number, bank_account_holder, created_at FROM users WHERE name LIKE ? ORDER BY created_at DESC'
    ).all('%' + search + '%');
  } else {
    users = db.prepare(
      'SELECT id, name, email, phone, role, balance, level, bank_name, bank_account_number, bank_account_holder, created_at FROM users ORDER BY created_at DESC'
    ).all();
  }
  res.render('admin_users', { user: req.session.user, users, message: null, search });
});

// Tambah saldo user
router.post('/admin/users/:id/balance/add', (req, res) => {
  const targetId = req.params.id;
  const amount = parseInt(req.body.amount, 10);
  const note = req.body.note || '';

  if (isNaN(amount) || amount <= 0) {
    const users = db.prepare('SELECT id, name, email, phone, role, balance, level, bank_name, bank_account_number, bank_account_holder, created_at FROM users ORDER BY created_at DESC').all();
    return res.render('admin_users', { user: req.session.user, users, message: 'Jumlah saldo tidak valid.', search: '' });
  }

  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).send('User tidak ditemukan.');

  db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(amount, targetId);
  db.prepare('INSERT INTO balance_transactions (user_id, amount, note, created_by) VALUES (?, ?, ?, ?)')
    .run(targetId, amount, note, req.session.user.id);
  db.catatLog(req.session.user, `Menambah saldo Rp${amount.toLocaleString('id-ID')} untuk ${target.name}`);

  res.redirect('/admin/users');
});

// Kurangi saldo user (tidak bisa sampai minus)
router.post('/admin/users/:id/balance/subtract', (req, res) => {
  const targetId = req.params.id;
  const amount = parseInt(req.body.amount, 10);
  const note = req.body.note || '';

  if (isNaN(amount) || amount <= 0) {
    const users = db.prepare('SELECT id, name, email, phone, role, balance, level, bank_name, bank_account_number, bank_account_holder, created_at FROM users ORDER BY created_at DESC').all();
    return res.render('admin_users', { user: req.session.user, users, message: 'Jumlah saldo tidak valid.', search: '' });
  }

  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).send('User tidak ditemukan.');

  const actualDeduction = Math.min(amount, target.balance);

  db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(actualDeduction, targetId);
  db.prepare('INSERT INTO balance_transactions (user_id, amount, note, created_by) VALUES (?, ?, ?, ?)')
    .run(targetId, -actualDeduction, note, req.session.user.id);
  db.catatLog(req.session.user, `Mengurangi saldo Rp${actualDeduction.toLocaleString('id-ID')} dari ${target.name}`);

  res.redirect('/admin/users');
});

// Hapus user beserta semua data terkait (lamaran, tugas, riwayat saldo, pekerjaan yang dia posting)
router.post('/admin/users/:id/delete', (req, res) => {
  const targetId = req.params.id;

  if (parseInt(targetId, 10) === req.session.user.id) {
    return res.status(400).send('Tidak bisa menghapus akun sendiri yang sedang login.');
  }

  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).send('User tidak ditemukan.');

  db.prepare('DELETE FROM tasks WHERE assigned_to = ? OR assigned_by = ?').run(targetId, targetId);
  db.prepare('DELETE FROM balance_transactions WHERE user_id = ? OR created_by = ?').run(targetId, targetId);
  db.prepare('DELETE FROM withdrawal_requests WHERE user_id = ?').run(targetId);
  db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
  db.catatLog(req.session.user, `Menghapus akun user ${target.name}`);

  res.redirect('/admin/users');
});

// Detail profil satu user + riwayat saldo
router.get('/admin/users/:id', (req, res) => {
  const target = db.prepare('SELECT id, name, email, phone, role, balance, level, bank_name, bank_account_number, bank_account_holder, created_at FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).send('User tidak ditemukan.');

  const transactions = db.prepare('SELECT * FROM balance_transactions WHERE user_id = ? ORDER BY created_at DESC').all(req.params.id);
  const tasks = db.prepare('SELECT * FROM tasks WHERE assigned_to = ? ORDER BY created_at DESC').all(req.params.id);
  const withdrawals = db.prepare('SELECT * FROM withdrawal_requests WHERE user_id = ? ORDER BY created_at DESC').all(req.params.id);
  const templates = db.prepare('SELECT id, name FROM task_templates ORDER BY name ASC').all();

  res.render('admin_user_detail', { user: req.session.user, target, transactions, tasks, withdrawals, templates, message: null });
});

// Assign Paket Tugas ke user ini langsung dari halaman detailnya
router.post('/admin/users/:id/assign-paket', (req, res) => {
  const targetId = req.params.id;
  const { template_id } = req.body;

  const target = db.prepare('SELECT id, name FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).send('User tidak ditemukan.');

  const template = db.prepare('SELECT * FROM task_templates WHERE id = ?').get(template_id);
  if (!template) return res.status(400).send('Paket tugas tidak ditemukan.');

  const items = db.prepare('SELECT * FROM task_template_items WHERE template_id = ?').all(template.id);
  const insertTask = db.prepare('INSERT INTO tasks (title, description, harga, kategori, reward, assigned_to, assigned_by, status, template_id, urutan) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  items.forEach((it, idx) => {
    const urutan = idx + 1;
    const status = urutan === 1 ? 'pending' : 'locked';
    insertTask.run(it.title, it.description, it.harga, it.kategori, it.reward, targetId, req.session.user.id, status, template.id, urutan);
  });

  db.catatLog(req.session.user, `Assign Paket Tugas "${template.name}" (${items.length} tugas) ke ${target.name} dari halaman detail user`);
  res.redirect('/admin/users/' + targetId);
});

// Ubah level user (dikontrol admin, tidak bisa dibeli user)
router.post('/admin/users/:id/level', (req, res) => {
  const targetId = req.params.id;
  const { level } = req.body;
  if (!['VIP 0', 'VIP 1', 'VIP 2'].includes(level)) {
    return res.status(400).send('Level tidak valid.');
  }
  const target = db.prepare('SELECT name FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).send('User tidak ditemukan.');

  db.prepare('UPDATE users SET level = ? WHERE id = ?').run(level, targetId);
  db.catatLog(req.session.user, `Mengubah level ${target.name} jadi ${level}`);
  res.redirect('/admin/users/' + targetId);
});

// Ubah kata sandi user (reset oleh admin, mis. kalau user lupa password)
router.post('/admin/users/:id/password', (req, res) => {
  const targetId = req.params.id;
  const { new_password } = req.body;

  if (!new_password || new_password.length < 6) {
    return res.status(400).send('Kata sandi minimal 6 karakter. Kembali dan coba lagi.');
  }

  const target = db.prepare('SELECT id, name FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).send('User tidak ditemukan.');

  const hashed = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashed, targetId);
  db.catatLog(req.session.user, `Mengubah kata sandi user ${target.name}`);

  res.redirect('/admin/users/' + targetId);
});

// Form beri tugas baru ke user tertentu
router.get('/admin/tasks/new', (req, res) => {
  const users = db.prepare("SELECT id, name, email, role, level FROM users WHERE role != 'admin' ORDER BY name ASC").all();
  const preselectId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
  res.render('admin_new_task', { user: req.session.user, users, preselectId, error: null });
});

// Simpan tugas baru
router.post('/admin/tasks/new', (req, res) => {
  const { assigned_to, title, description, harga, kategori, reward } = req.body;

  if (!assigned_to || !title || !description || !reward) {
    const users = db.prepare("SELECT id, name, email, role, level FROM users WHERE role != 'admin' ORDER BY name ASC").all();
    return res.render('admin_new_task', {
      user: req.session.user, users, preselectId: null,
      error: 'Judul, deskripsi, user, dan komisi tugas wajib diisi.'
    });
  }

  const target = db.prepare('SELECT id, name FROM users WHERE id = ?').get(assigned_to);
  if (!target) return res.status(404).send('User tidak ditemukan.');

  db.prepare('INSERT INTO tasks (title, description, harga, kategori, reward, assigned_to, assigned_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(title, description, harga || 0, kategori || 'Lainnya', reward, assigned_to, req.session.user.id);
  db.catatLog(req.session.user, `Memberi tugas "${title}" ke ${target.name}`);

  res.redirect('/admin/tasks');
});

// Daftar semua Paket Tugas
router.get('/admin/paket-tugas', (req, res) => {
  const templates = db.prepare(`
    SELECT task_templates.*, COUNT(task_template_items.id) AS jumlah_item
    FROM task_templates
    LEFT JOIN task_template_items ON task_template_items.template_id = task_templates.id
    GROUP BY task_templates.id
    ORDER BY task_templates.created_at DESC
  `).all();
  res.render('admin_paket_tugas', { user: req.session.user, templates });
});

// Form bikin Paket Tugas baru (isi beberapa tugas sekaligus)
router.get('/admin/paket-tugas/new', (req, res) => {
  res.render('admin_paket_tugas_new', { user: req.session.user, error: null });
});

// Simpan Paket Tugas baru beserta semua item tugas di dalamnya
router.post('/admin/paket-tugas/new', (req, res) => {
  const { name, items } = req.body;

  if (!name || !items) {
    return res.render('admin_paket_tugas_new', { user: req.session.user, error: 'Nama paket dan minimal 1 tugas wajib diisi.' });
  }

  const itemList = Object.values(items).filter(it => it && it.title && it.description && it.reward);
  if (itemList.length === 0) {
    return res.render('admin_paket_tugas_new', { user: req.session.user, error: 'Minimal harus ada 1 tugas dengan judul, deskripsi, dan komisi diisi.' });
  }

  const info = db.prepare('INSERT INTO task_templates (name, created_by) VALUES (?, ?)').run(name, req.session.user.id);
  const insertItem = db.prepare('INSERT INTO task_template_items (template_id, title, description, harga, kategori, reward) VALUES (?, ?, ?, ?, ?, ?)');
  itemList.forEach(it => {
    insertItem.run(info.lastInsertRowid, it.title, it.description, parseInt(it.harga, 10) || 0, it.kategori || 'Lainnya', parseInt(it.reward, 10));
  });

  db.catatLog(req.session.user, `Membuat Paket Tugas "${name}" berisi ${itemList.length} tugas`);
  res.redirect('/admin/paket-tugas');
});

// Detail Paket Tugas + form pilih user buat di-assign-kan
router.get('/admin/paket-tugas/:id', (req, res) => {
  const template = db.prepare('SELECT * FROM task_templates WHERE id = ?').get(req.params.id);
  if (!template) return res.status(404).send('Paket tugas tidak ditemukan.');

  const items = db.prepare('SELECT * FROM task_template_items WHERE template_id = ?').all(template.id);
  const users = db.prepare("SELECT id, name, email, level FROM users WHERE role != 'admin' ORDER BY name ASC").all();

  res.render('admin_paket_tugas_detail', { user: req.session.user, template, items, users, message: null });
});

// Assign-kan semua tugas dalam paket ke satu atau beberapa user sekaligus
router.post('/admin/paket-tugas/:id/assign', (req, res) => {
  const template = db.prepare('SELECT * FROM task_templates WHERE id = ?').get(req.params.id);
  if (!template) return res.status(404).send('Paket tugas tidak ditemukan.');

  const items = db.prepare('SELECT * FROM task_template_items WHERE template_id = ?').all(template.id);
  let userIds = req.body.user_ids || [];
  if (!Array.isArray(userIds)) userIds = [userIds];

  if (userIds.length === 0 || items.length === 0) {
    const users = db.prepare("SELECT id, name, email, level FROM users WHERE role != 'admin' ORDER BY name ASC").all();
    return res.render('admin_paket_tugas_detail', {
      user: req.session.user, template, items, users,
      message: 'Pilih minimal 1 user untuk di-assign.'
    });
  }

  const insertTask = db.prepare('INSERT INTO tasks (title, description, harga, kategori, reward, assigned_to, assigned_by, status, template_id, urutan) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  let totalDibuat = 0;
  userIds.forEach(userId => {
    items.forEach((it, idx) => {
      const urutan = idx + 1;
      const status = urutan === 1 ? 'pending' : 'locked'; // cuma tugas pertama yang langsung kelihatan user
      insertTask.run(it.title, it.description, it.harga, it.kategori, it.reward, userId, req.session.user.id, status, template.id, urutan);
      totalDibuat++;
    });
  });

  db.catatLog(req.session.user, `Assign Paket Tugas "${template.name}" (${items.length} tugas, berurutan) ke ${userIds.length} user, total ${totalDibuat} tugas dibuat`);
  res.redirect('/admin/tasks');
});

// Hapus Paket Tugas (tugas yang sudah pernah di-assign dari paket ini TIDAK ikut terhapus)
router.post('/admin/paket-tugas/:id/delete', (req, res) => {
  const template = db.prepare('SELECT * FROM task_templates WHERE id = ?').get(req.params.id);
  if (!template) return res.status(404).send('Paket tugas tidak ditemukan.');

  db.prepare('DELETE FROM task_template_items WHERE template_id = ?').run(template.id);
  db.prepare('DELETE FROM task_templates WHERE id = ?').run(template.id);
  db.catatLog(req.session.user, `Menghapus Paket Tugas "${template.name}"`);
  res.redirect('/admin/paket-tugas');
});

// Daftar semua tugas yang pernah diberikan (bisa difilter status & dicari nama user)
router.get('/admin/tasks', (req, res) => {
  const statusFilter = req.query.status || '';
  const search = (req.query.search || '').trim();

  let query = `
    SELECT tasks.*, users.name AS assignee_name
    FROM tasks JOIN users ON tasks.assigned_to = users.id
    WHERE 1=1
  `;
  const params = [];

  if (statusFilter) {
    query += ' AND tasks.status = ?';
    params.push(statusFilter);
  }
  if (search) {
    query += ' AND users.name LIKE ?';
    params.push('%' + search + '%');
  }

  query += `
    ORDER BY
      CASE tasks.status WHEN 'completed' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
      tasks.created_at DESC
  `;

  const tasks = db.prepare(query).all(...params);
  res.render('admin_tasks', { user: req.session.user, tasks, statusFilter, search });
});

// Setujui tugas yang sudah ditandai selesai user -> saldo otomatis cair
router.post('/admin/tasks/:id/approve', (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).send('Tugas tidak ditemukan.');
  if (task.status !== 'completed') return res.status(400).send('Tugas ini belum ditandai selesai oleh user.');

  const assignee = db.prepare('SELECT name FROM users WHERE id = ?').get(task.assigned_to);
  db.prepare("UPDATE tasks SET status = 'approved' WHERE id = ?").run(task.id);
  db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(task.reward, task.assigned_to);
  db.prepare('INSERT INTO balance_transactions (user_id, amount, note, created_by) VALUES (?, ?, ?, ?)')
    .run(task.assigned_to, task.reward, 'Tugas selesai: ' + task.title, req.session.user.id);
  db.catatLog(req.session.user, `Menyetujui tugas "${task.title}" milik ${assignee ? assignee.name : '-'}, komisi Rp${task.reward.toLocaleString('id-ID')} cair`);

  // Kalau tugas ini bagian dari Paket Tugas, buka otomatis tugas berikutnya dalam urutan paket itu
  if (task.template_id && task.urutan) {
    db.prepare(`
      UPDATE tasks SET status = 'pending'
      WHERE template_id = ? AND assigned_to = ? AND urutan = ? AND status = 'locked'
    `).run(task.template_id, task.assigned_to, task.urutan + 1);
  }

  res.redirect('/admin/tasks');
});

// Tolak tugas yang ditandai selesai (tidak sesuai)
router.post('/admin/tasks/:id/reject', (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).send('Tugas tidak ditemukan.');

  db.prepare("UPDATE tasks SET status = 'rejected' WHERE id = ?").run(task.id);
  db.catatLog(req.session.user, `Menolak tugas "${task.title}"`);
  res.redirect('/admin/tasks');
});

// Hapus tugas (tidak bisa dikembalikan; kalau sudah approved, saldo yang sudah cair TIDAK ditarik kembali)
router.post('/admin/tasks/:id/delete', (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).send('Tugas tidak ditemukan.');

  db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
  db.catatLog(req.session.user, `Menghapus tugas "${task.title}"`);
  res.redirect('/admin/tasks');
});

// Daftar semua permintaan penarikan saldo (bisa difilter status & dicari nama user)
router.get('/admin/penarikan', (req, res) => {
  const statusFilter = req.query.status || '';
  const search = (req.query.search || '').trim();

  let query = `
    SELECT withdrawal_requests.*, users.name AS user_name, users.phone AS user_phone
    FROM withdrawal_requests JOIN users ON withdrawal_requests.user_id = users.id
    WHERE 1=1
  `;
  const params = [];

  if (statusFilter) {
    query += ' AND withdrawal_requests.status = ?';
    params.push(statusFilter);
  }
  if (search) {
    query += ' AND (users.name LIKE ? OR users.phone LIKE ?)';
    params.push('%' + search + '%', '%' + search + '%');
  }

  query += `
    ORDER BY
      CASE withdrawal_requests.status WHEN 'pending' THEN 0 ELSE 1 END,
      withdrawal_requests.created_at DESC
  `;

  const withdrawals = db.prepare(query).all(...params);
  res.render('admin_penarikan', { user: req.session.user, withdrawals, statusFilter, search });
});

// Tandai penarikan sudah ditransfer -> saldo user dipotong
router.post('/admin/penarikan/:id/selesai', (req, res) => {
  const wd = db.prepare('SELECT * FROM withdrawal_requests WHERE id = ?').get(req.params.id);
  if (!wd) return res.status(404).send('Permintaan tidak ditemukan.');
  if (wd.status !== 'pending') return res.redirect('/admin/penarikan');

  const catatan = (req.body.catatan || '').trim() || null;
  const target = db.prepare('SELECT name, balance FROM users WHERE id = ?').get(wd.user_id);
  const actualDeduction = Math.min(wd.amount, target.balance);

  db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(actualDeduction, wd.user_id);
  db.prepare('INSERT INTO balance_transactions (user_id, amount, note, created_by) VALUES (?, ?, ?, ?)')
    .run(wd.user_id, -actualDeduction, 'Penarikan saldo ke rekening', req.session.user.id);
  db.prepare("UPDATE withdrawal_requests SET status = 'completed', processed_at = CURRENT_TIMESTAMP, catatan = ? WHERE id = ?").run(catatan, wd.id);
  db.catatLog(req.session.user, `Memproses penarikan Rp${actualDeduction.toLocaleString('id-ID')} untuk ${target.name}`);

  res.redirect('/admin/penarikan');
});

// Tolak permintaan penarikan (saldo user tidak dipotong)
router.post('/admin/penarikan/:id/tolak', (req, res) => {
  const wd = db.prepare('SELECT * FROM withdrawal_requests WHERE id = ?').get(req.params.id);
  if (!wd) return res.status(404).send('Permintaan tidak ditemukan.');
  if (wd.status !== 'pending') return res.redirect('/admin/penarikan');

  const catatan = (req.body.catatan || '').trim() || null;
  const target = db.prepare('SELECT name FROM users WHERE id = ?').get(wd.user_id);
  db.prepare("UPDATE withdrawal_requests SET status = 'rejected', processed_at = CURRENT_TIMESTAMP, catatan = ? WHERE id = ?").run(catatan, wd.id);
  db.catatLog(req.session.user, `Menolak penarikan Rp${wd.amount.toLocaleString('id-ID')} milik ${target ? target.name : '-'}`);
  res.redirect('/admin/penarikan');
});

// Log aktivitas admin (siapa melakukan apa, kapan)
router.get('/admin/log', (req, res) => {
  const logs = db.prepare('SELECT * FROM activity_logs ORDER BY created_at DESC LIMIT 200').all();
  res.render('admin_log', { user: req.session.user, logs });
});

// Export daftar user ke CSV (bisa dibuka di Excel)
router.get('/admin/export/users', (req, res) => {
  const users = db.prepare(
    'SELECT name, phone, email, role, level, balance, bank_name, bank_account_number, bank_account_holder, created_at FROM users ORDER BY created_at DESC'
  ).all();

  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v).replace(/"/g, '""');
    return `"${s}"`;
  };

  let csv = 'Nama,No HP,Email,Role,Level,Saldo,Bank,No Rekening,Nama Rekening,Terdaftar\n';
  users.forEach(u => {
    csv += [u.name, u.phone, u.email, u.role, u.level, u.balance, u.bank_name, u.bank_account_number, u.bank_account_holder, u.created_at]
      .map(escape).join(',') + '\n';
  });

  db.catatLog(req.session.user, 'Export data user ke Excel/CSV');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="daftar-user.csv"');
  res.send('\uFEFF' + csv); // BOM biar Excel baca UTF-8 dengan benar
});

// Export riwayat penarikan ke CSV
router.get('/admin/export/penarikan', (req, res) => {
  const withdrawals = db.prepare(`
    SELECT withdrawal_requests.*, users.name AS user_name
    FROM withdrawal_requests JOIN users ON withdrawal_requests.user_id = users.id
    ORDER BY withdrawal_requests.created_at DESC
  `).all();

  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v).replace(/"/g, '""');
    return `"${s}"`;
  };

  let csv = 'Nama User,Jumlah,Bank,No Rekening,Status,Diajukan,Diproses\n';
  withdrawals.forEach(w => {
    csv += [w.user_name, w.amount, w.bank_name, w.bank_account_number, w.status, w.created_at, w.processed_at]
      .map(escape).join(',') + '\n';
  });

  db.catatLog(req.session.user, 'Export data penarikan ke Excel/CSV');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="riwayat-penarikan.csv"');
  res.send('\uFEFF' + csv);
});

module.exports = router;
