const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db/database');

router.get('/register', (req, res) => {
  res.render('register', { error: null, refCode: (req.query.ref || '').trim().toUpperCase() });
});

router.post('/register', (req, res) => {
  const { name, phone, email, password, password_confirm, ref_code } = req.body;
  const trimmedEmail = (email || '').trim();
  const refCodeInput = (ref_code || '').trim().toUpperCase();

  if (!name || !phone || !password || !password_confirm) {
    return res.render('register', { error: 'Nama, nomor HP, dan kata sandi wajib diisi.', refCode: refCodeInput });
  }
  if (password !== password_confirm) {
    return res.render('register', { error: 'Kata sandi dan ulangi kata sandi tidak sama.', refCode: refCodeInput });
  }
  const existingPhone = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
  if (existingPhone) {
    return res.render('register', { error: 'Nomor HP sudah terdaftar.', refCode: refCodeInput });
  }
  if (trimmedEmail) {
    const existingEmail = db.prepare('SELECT id FROM users WHERE email = ?').get(trimmedEmail);
    if (existingEmail) {
      return res.render('register', { error: 'Email sudah terdaftar.', refCode: refCodeInput });
    }
  }
  let referrer = null;
  if (refCodeInput) {
    referrer = db.prepare('SELECT id, name FROM users WHERE referral_code = ?').get(refCodeInput);
    if (!referrer) {
      return res.render('register', { error: 'Kode referral tidak ditemukan.', refCode: refCodeInput });
    }
  }
  let myRefCode;
  do {
    myRefCode = Math.random().toString(36).slice(2, 8).toUpperCase();
  } while (db.prepare('SELECT id FROM users WHERE referral_code = ?').get(myRefCode));

  const role = 'freelancer';
  const hashed = bcrypt.hashSync(password, 10);
  const stmt = db.prepare('INSERT INTO users (name, phone, email, password, role, balance, referral_code, referred_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const info = stmt.run(name, phone, trimmedEmail || null, hashed, role, 15000, myRefCode, referrer ? referrer.id : null);
  db.prepare('INSERT INTO balance_transactions (user_id, amount, note, created_by) VALUES (?, ?, ?, ?)')
    .run(info.lastInsertRowid, 15000, 'Bonus pendaftaran akun baru', null);

  if (referrer) {
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(db.REFERRAL_BONUS, referrer.id);
    db.prepare('INSERT INTO balance_transactions (user_id, amount, note, created_by) VALUES (?, ?, ?, ?)')
      .run(referrer.id, db.REFERRAL_BONUS, `Bonus ajak teman: ${name} bergabung`, info.lastInsertRowid);
  }

  req.session.user = { id: info.lastInsertRowid, name, email: trimmedEmail, role };
  res.redirect('/dashboard');
});

router.get('/login', (req, res) => {
  res.render('login', { error: null });
});

router.post('/login', (req, res) => {
  const { identifier, password } = req.body;
  const value = (identifier || '').trim();
  const user = db.prepare('SELECT * FROM users WHERE phone = ? OR email = ?').get(value, value);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.render('login', { error: 'Nomor HP/Email atau kata sandi salah.' });
  }
  req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };
  res.redirect('/dashboard');
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

router.get('/setup-admin', (req, res) => {
  const { key, name, email, phone, password } = req.query;
  if (!process.env.ADMIN_SETUP_KEY) {
    return res.status(500).send('ADMIN_SETUP_KEY belum diatur di environment variable server.');
  }
  if (!key || key !== process.env.ADMIN_SETUP_KEY) {
    return res.status(403).send('Kunci rahasia salah atau tidak diisi.');
  }
  if (!name || !phone || !password) {
    return res.status(400).send('Isi dulu name, phone, dan password di URL.');
  }
  const existingAdmin = db.prepare("SELECT id FROM users WHERE role = 'admin'").get();
  if (existingAdmin) {
    return res.status(400).send('Akun admin sudah ada sebelumnya. Untuk keamanan, setup ini cuma bisa dipakai sekali.');
  }
  const existingPhone = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
  if (existingPhone) {
    return res.status(400).send('Nomor HP itu sudah dipakai akun lain.');
  }
  let refCode;
  do {
    refCode = Math.random().toString(36).slice(2, 8).toUpperCase();
  } while (db.prepare('SELECT id FROM users WHERE referral_code = ?').get(refCode));
  const hashed = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO users (name, phone, email, password, role, balance, referral_code) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(name, phone, (email || '').trim() || null, hashed, 'admin', 0, refCode);
  res.send('Akun admin berhasil dibuat! Sekarang login lewat halaman /login.');
});

router.get('/reset-admin', (req, res) => {
  const { key, password } = req.query;
  if (!process.env.ADMIN_SETUP_KEY) {
    return res.status(500).send('ADMIN_SETUP_KEY belum diatur di environment variable server.');
  }
  if (!key || key !== process.env.ADMIN_SETUP_KEY) {
    return res.status(403).send('Kunci rahasia salah atau tidak diisi.');
  }
  if (!password) {
    return res.status(400).send('Isi dulu password baru. Contoh: /reset-admin?key=...&password=rahasiaBaru123');
  }
  const admin = db.prepare("SELECT id, phone FROM users WHERE role = 'admin'").get();
  if (!admin) {
    return res.status(400).send('Belum ada akun admin sama sekali. Pakai /setup-admin dulu.');
  }
  const hashed = bcrypt.hashSync(password, 10);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashed, admin.id);
  res.send('Password admin berhasil direset! Login lewat /login pakai nomor HP ' + admin.phone + ' dan password baru yang barusan kamu isi.');
});

module.exports = router;
