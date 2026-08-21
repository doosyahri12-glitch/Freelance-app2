function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  next();
}

function requireRole(roles) {
  const allowed = Array.isArray(roles) ? roles : [roles];
  return function (req, res, next) {
    if (!req.session.user || !allowed.includes(req.session.user.role)) {
      return res.status(403).send('Akses ditolak: hanya untuk ' + allowed.join(' / '));
    }
    next();
  };
}

module.exports = { requireLogin, requireRole };
