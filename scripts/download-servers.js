#!/usr/bin/env node
// Downloads PHP and MariaDB for Windows with the app's own download code, into
// <data folder>/server as the app lays it out, and prints where they are as
// HAMICHLOL_PHP=... and HAMICHLOL_MYSQLD=... lines (for $GITHUB_ENV), so the
// system tests can run on Windows against exactly what users get.
// Nothing is downloaded again when the programs are already there.
// Usage: node scripts/download-servers.js <data folder>

const fs = require('fs');
const path = require('path');

const dataDir = process.argv[2];
if (!dataDir) {
  console.error('Usage: node scripts/download-servers.js <data folder>');
  process.exit(1);
}

process.env.DEV_MODE = 'false';
const serverManager = require('../src/server-manager');
const { DOWNLOADS } = require('../src/versions');
const { downloadAndExtract, configurePhpIni } = serverManager._internal;

async function main() {
  serverManager.setDataPath(path.resolve(dataDir));
  const { phpDir, phpExe, phpIni, mariadbDir } = serverManager.getPaths();
  const mysqld = path.join(mariadbDir, 'bin', 'mariadbd.exe');

  if (!fs.existsSync(phpExe) || !fs.existsSync(phpIni)) {
    console.error(`Downloading PHP ${DOWNLOADS.php.version}...`);
    await downloadAndExtract(DOWNLOADS.php.urls, phpDir, { prepare: (root, finalDir) => configurePhpIni(root, finalDir) });
  }
  if (!fs.existsSync(mysqld)) {
    console.error(`Downloading MariaDB ${DOWNLOADS.mariadb.version}...`);
    await downloadAndExtract(DOWNLOADS.mariadb.urls, mariadbDir, { stripRootFolder: true });
  }
  console.log(`HAMICHLOL_PHP=${phpExe}`);
  console.log(`HAMICHLOL_MYSQLD=${mysqld}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
