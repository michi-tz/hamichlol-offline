#!/usr/bin/env node
// Downloads PHP and MariaDB for Windows with the app's own download code, into
// <data folder>/server as the app lays it out, and prints where they are as
// HAMICHLOL_PHP=... and HAMICHLOL_MYSQLD=... lines (for $GITHUB_ENV), so the
// system tests can run on Windows against exactly what users get: the newest
// PHP release of the branch, as the app picks it.
// Nothing is downloaded again when the programs are already there.
//
// Usage: node scripts/download-servers.js <data folder>
//        node scripts/download-servers.js --versions
// --versions prints servers=php-<release>-mariadb-<release> (for $GITHUB_OUTPUT),
// with the PHP release the app would download now, as the key of a cache.

const fs = require('fs');
const path = require('path');

// Only the lines below may reach stdout, which the CI job appends to
// $GITHUB_ENV or $GITHUB_OUTPUT; the download code's own messages go to stderr
console.log = console.error;

process.env.DEV_MODE = 'false';
const serverManager = require('../src/server-manager');
const { DOWNLOADS } = require('../src/versions');
const { downloadAndExtract, downloadPhp, latestPhpRelease } = serverManager._internal;

async function printVersions() {
  const latest = await latestPhpRelease();
  const php = latest ? latest.version : DOWNLOADS.php.version;
  process.stdout.write(`servers=php-${php}-mariadb-${DOWNLOADS.mariadb.version}\n`);
}

async function download(dataDir) {
  serverManager.setDataPath(path.resolve(dataDir));
  const php = serverManager.getPaths();
  if (!fs.existsSync(php.phpExe) || !fs.existsSync(php.phpIni)) {
    await downloadPhp();
  }
  const { phpExe, mariadbDir } = serverManager.getPaths();
  const mysqld = path.join(mariadbDir, 'bin', 'mariadbd.exe');
  if (!fs.existsSync(mysqld)) {
    console.error(`Downloading MariaDB ${DOWNLOADS.mariadb.version}...`);
    await downloadAndExtract(DOWNLOADS.mariadb.urls, mariadbDir, { stripRootFolder: true });
  }
  process.stdout.write(`HAMICHLOL_PHP=${phpExe}\nHAMICHLOL_MYSQLD=${mysqld}\n`);
}

const argument = process.argv[2];
if (!argument) {
  console.error('Usage: node scripts/download-servers.js <data folder> | --versions');
  process.exit(1);
}
(argument === '--versions' ? printVersions() : download(argument)).catch(error => {
  console.error(error);
  process.exit(1);
});
