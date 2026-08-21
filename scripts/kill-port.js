// Matikan otomatis proses lama yang masih menempel di port (default 3000)
// sebelum server baru dijalankan. Ini mencegah error EADDRINUSE kalau
// Termux ditutup tanpa CTRL+C dulu dan proses node lama masih nyangkut.
const fs = require('fs');

const port = process.argv[2] || '3000';
const portHex = parseInt(port, 10).toString(16).toUpperCase().padStart(4, '0');

function findPidsUsingPort() {
  const inodes = new Set();

  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n').slice(1);
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 10) continue;
        const localPort = parts[1].split(':')[1];
        if (localPort === portHex) inodes.add(parts[9]);
      }
    } catch (e) {
      // file tidak ada / tidak bisa dibaca, lewati saja
    }
  }

  const pids = new Set();
  if (inodes.size === 0) return pids;

  let procDirs = [];
  try {
    procDirs = fs.readdirSync('/proc').filter(d => /^\d+$/.test(d));
  } catch (e) {
    return pids;
  }

  for (const pid of procDirs) {
    try {
      const fdDir = `/proc/${pid}/fd`;
      const fds = fs.readdirSync(fdDir);
      for (const fd of fds) {
        try {
          const link = fs.readlinkSync(`${fdDir}/${fd}`);
          const m = link.match(/socket:\[(\d+)\]/);
          if (m && inodes.has(m[1])) pids.add(pid);
        } catch (e) {
          // fd tidak bisa dibaca (proses punya orang lain, dll), lewati
        }
      }
    } catch (e) {
      // proses sudah tidak ada / tidak bisa diakses, lewati
    }
  }

  return pids;
}

try {
  const pids = findPidsUsingPort();
  if (pids.size === 0) {
    console.log(`Port ${port} bersih, tidak ada proses lama.`);
  } else {
    for (const pid of pids) {
      try {
        process.kill(parseInt(pid, 10), 'SIGKILL');
        console.log(`Proses lama (PID ${pid}) di port ${port} sudah dimatikan.`);
      } catch (e) {
        console.log(`Tidak bisa matikan PID ${pid}: ${e.message}`);
      }
    }
  }
} catch (e) {
  // Kalau /proc tidak bisa dibaca sama sekali, jangan gagalkan start,
  // biarkan Express yang kasih tahu kalau port masih dipakai.
  console.log('Cek port dilewati:', e.message);
}
