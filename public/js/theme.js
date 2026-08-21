// Terapkan tema tersimpan sedini mungkin (sebelum halaman kelihatan) supaya tidak "kedip"
(function () {
  var t = localStorage.getItem('theme') || 'light';
  if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
})();

function toggleTheme() {
  var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  if (isDark) {
    document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('theme', 'light');
  } else {
    document.documentElement.setAttribute('data-theme', 'dark');
    localStorage.setItem('theme', 'dark');
  }
  updateThemeIcon();
}

function updateThemeIcon() {
  var icon = document.getElementById('themeIcon');
  if (!icon) return;
  var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  icon.className = isDark ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
}

document.addEventListener('DOMContentLoaded', updateThemeIcon);
