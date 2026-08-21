const express = require('express');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

// Session secret WAJIB diisi lewat environment variable saat online ke publik.
// Kalau tidak diisi dan NODE_ENV=production, server sengaja dihentikan supaya
// tidak pernah kepasang online pakai secret bawaan yang tidak aman.
let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  if (isProduction) {
    console.error('FATAL: SESSION_SECRET belum diatur. Set environment variable SESSION_SECRET sebelum jalankan di mode production.');
    process.exit(1);
  }
  // Development lokal (Termux/testing): boleh pakai secret acak yang dibuat otomatis tiap start.
  sessionSecret = crypto.randomBytes(32).toString('hex');
  console.log('Peringatan: SESSION_SECRET tidak diatur, memakai secret acak sementara (hanya untuk development).');
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
if (isProduction) app.set('trust proxy', 1); // perlu kalau server di belakang nginx/reverse proxy dengan HTTPS

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24, // 1 hari
    secure: isProduction // cookie cuma dikirim lewat HTTPS kalau sudah production
  }
}));

// Biar user login selalu tersedia di semua view
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  next();
});

const authRoutes = require('./routes/auth');
const jobRoutes = require('./routes/jobs');
const adminRoutes = require('./routes/admin');

app.use('/', authRoutes);
app.use('/', jobRoutes);
app.use('/', adminRoutes);

app.listen(PORT, () => {
  console.log(`Server jalan di http://localhost:${PORT}`);
});
