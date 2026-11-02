const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFile, spawn } = require('child_process');
const download = require('download');
const AdmZip = require('adm-zip');
const portfinder = require('portfinder');
const mysql = require('mysql2/promise');

// Network settings. Everything binds to the loopback interface only.
const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_PHP_PORT = 8080;
const DEFAULT_MYSQL_PORT = 3306;

// LocalSettings.php reads the MySQL port from this environment variable, so the
// wiki keeps working even when a different port is chosen on a later run.
const DB_PORT_ENV = 'HAMICHLOL_DB_PORT';

const SERVER_START_TIMEOUT_MS = 60000;
const MYSQL_SHUTDOWN_TIMEOUT_MS = 15000;

const IDENTIFIER_RE = /^[A-Za-z0-9_]{1,64}$/;
const MIN_ADMIN_PASSWORD_LENGTH = 10;

// Writable directory that holds the downloaded servers, MediaWiki and the
// database. The Electron main process points this at the user's data folder.
let dataPath = process.env.HAMICHLOL_DATA_DIR || path.join(__dirname, '..', 'resources');

// Server processes
let phpProcess = null;
let mysqlProcess = null;
let devServer = null;

// Server ports (valid while the matching process is running)
let phpPort = null;
let mysqlPort = null;

function setDataPath(dir) {
  dataPath = dir;
}

function getPaths() {
  const serverPath = path.join(dataPath, 'server');
  const phpDir = path.join(serverPath, 'php');
  const mysqlDir = path.join(serverPath, 'mysql');
  return {
    dataPath,
    serverPath,
    mediaWikiPath: path.join(dataPath, 'mediawiki'),
    phpDir,
    phpExe: path.join(phpDir, 'php.exe'),
    phpIni: path.join(phpDir, 'php.ini'),
    mysqlDir,
    mysqlDataDir: path.join(mysqlDir, 'data'),
    mysqlBin: (name) => path.join(mysqlDir, 'bin', name)
  };
}

// Read at call time (not at module load) so the flag can be set after require().
function isDevMode() {
  return process.env.DEV_MODE === 'true';
}

// Run an executable without a shell, so arguments are never interpreted as commands.
function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, ...options }, (error, stdout, stderr) => {
      if (error) {
        if (stderr) {
          error.message += `\n${stderr}`;
        }
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function canConnect(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: LOOPBACK_HOST, port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

function logOutput(child, label) {
  child.stdout.on('data', data => console.log(`${label}: ${data.toString()}`));
  child.stderr.on('data', data => console.error(`${label} error: ${data.toString()}`));
}

// Spawn a server process and resolve once it accepts TCP connections on `port`.
// Rejects (and kills the process) if it fails to start, exits early or times out.
async function spawnServer(label, file, args, port, options = {}) {
  const child = spawn(file, args, { windowsHide: true, ...options });
  let failure = null;
  child.once('error', error => {
    failure = failure || error;
  });
  child.once('exit', code => {
    failure = failure || new Error(`${label} exited with code ${code}`);
  });
  logOutput(child, label);

  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (!failure) {
    if (await canConnect(port)) {
      return child;
    }
    if (Date.now() > deadline) {
      failure = new Error(`${label} did not start listening on port ${port} in time`);
      break;
    }
    await delay(250);
  }

  child.kill();
  throw failure;
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for process to exit')), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// Validate and normalise the installation settings coming from the UI.
function validateConfig(config) {
  const fields = ['dbName', 'dbUser', 'dbPassword', 'wikiName', 'adminUser', 'adminPassword'];
  const result = {};
  for (const field of fields) {
    const value = config && config[field];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`השדה ${field} חסר`);
    }
    result[field] = value;
  }

  result.dbName = result.dbName.trim();
  result.dbUser = result.dbUser.trim();
  result.wikiName = result.wikiName.trim();
  result.adminUser = result.adminUser.trim();

  if (!IDENTIFIER_RE.test(result.dbName)) {
    throw new Error('שם מסד הנתונים יכול להכיל רק אותיות לטיניות, ספרות וקו תחתון');
  }
  if (!IDENTIFIER_RE.test(result.dbUser)) {
    throw new Error('שם המשתמש למסד הנתונים יכול להכיל רק אותיות לטיניות, ספרות וקו תחתון');
  }
  if (!result.wikiName || !result.adminUser) {
    throw new Error('יש למלא שם אתר ושם משתמש מנהל');
  }
  // MediaWiki rejects shorter passwords for administrators.
  if (result.adminPassword.length < MIN_ADMIN_PASSWORD_LENGTH) {
    throw new Error(`סיסמת המנהל חייבת להכיל לפחות ${MIN_ADMIN_PASSWORD_LENGTH} תווים`);
  }

  return result;
}

// SQL that creates the wiki database and user. Values are escaped by mysql2.
function buildDatabaseSetupQueries({ dbName, dbUser, dbPassword }) {
  return [
    mysql.format('CREATE DATABASE IF NOT EXISTS ??', [dbName]),
    mysql.format("CREATE USER IF NOT EXISTS ?@'localhost' IDENTIFIED BY ?", [dbUser, dbPassword]),
    mysql.format("ALTER USER ?@'localhost' IDENTIFIED BY ?", [dbUser, dbPassword]),
    mysql.format("GRANT ALL PRIVILEGES ON ??.* TO ?@'localhost'", [dbName, dbUser])
  ];
}

function replacePhpSetting(source, name, expression) {
  const pattern = new RegExp(`^\\$${name}\\s*=.*;[ \\t]*$`, 'm');
  if (!pattern.test(source)) {
    throw new Error(`The setting $${name} was not found in LocalSettings.php`);
  }
  return source.replace(pattern, () => `$${name} = ${expression};`);
}

// Make LocalSettings.php independent of the ports chosen at install time:
// the server URL is detected per request and the DB port comes from the environment.
function patchLocalSettings(filePath) {
  let source = fs.readFileSync(filePath, 'utf8');
  source = replacePhpSetting(source, 'wgServer', 'WebRequest::detectServer()');
  source = replacePhpSetting(
    source,
    'wgDBserver',
    `'${LOOPBACK_HOST}:' . ( getenv( '${DB_PORT_ENV}' ) ?: '${DEFAULT_MYSQL_PORT}' )`
  );
  fs.writeFileSync(filePath, source);
}

function phpString(value) {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

// Download required server files
async function downloadServers() {
  const { serverPath, mediaWikiPath, phpDir, phpIni, mysqlDir, mysqlDataDir, mysqlBin } = getPaths();

  fs.mkdirSync(serverPath, { recursive: true });
  fs.mkdirSync(mediaWikiPath, { recursive: true });

  // In dev mode, we'll simulate the downloads with dummy files
  if (isDevMode()) {
    console.log('DEV MODE: Simulating server downloads');

    if (!fs.existsSync(phpDir)) {
      fs.mkdirSync(phpDir, { recursive: true });
      fs.writeFileSync(path.join(phpDir, 'php.exe'), 'MOCK PHP EXE');
      fs.writeFileSync(phpIni, 'extension=mysqli\nextension=gd\nextension=intl\nextension=mbstring');
    }

    if (!fs.existsSync(mysqlDir)) {
      fs.mkdirSync(path.join(mysqlDir, 'bin'), { recursive: true });
      fs.mkdirSync(mysqlDataDir, { recursive: true });
      fs.writeFileSync(mysqlBin('mysqld.exe'), 'MOCK MYSQL EXE');
      fs.writeFileSync(mysqlBin('mysql.exe'), 'MOCK MYSQL CLIENT');
      fs.writeFileSync(mysqlBin('mysqladmin.exe'), 'MOCK MYSQLADMIN');
    }

    if (!fs.existsSync(path.join(mediaWikiPath, 'index.php'))) {
      fs.writeFileSync(path.join(mediaWikiPath, 'index.php'), '<?php echo "Mock MediaWiki"; ?>');
      fs.mkdirSync(path.join(mediaWikiPath, 'maintenance'), { recursive: true });
      fs.writeFileSync(path.join(mediaWikiPath, 'maintenance', 'install.php'), '<?php echo "Mock Installer"; ?>');
    }

    return true;
  }

  // Download and extract PHP server if not already downloaded
  if (!fs.existsSync(phpDir)) {
    console.log('Downloading PHP server...');
    const phpUrl = 'https://windows.php.net/downloads/releases/php-8.1.22-Win32-vs16-x64.zip';
    const phpZipPath = path.join(serverPath, 'php.zip');

    await download(phpUrl, serverPath, { filename: 'php.zip' });

    const zip = new AdmZip(phpZipPath);
    zip.extractAllTo(phpDir, true);

    // Cleanup
    fs.unlinkSync(phpZipPath);

    // Configure PHP
    fs.copyFileSync(path.join(phpDir, 'php.ini-development'), phpIni);

    let phpIniContent = fs.readFileSync(phpIni, 'utf8');
    // Without an explicit extension_dir, Windows PHP looks for extensions in C:\php\ext
    phpIniContent = phpIniContent.replace(
      /^;\s*extension_dir\s*=\s*"ext"\s*$/m,
      () => `extension_dir = "${path.join(phpDir, 'ext')}"`
    );
    // Enable required extensions
    for (const extension of ['mysqli', 'gd', 'intl', 'mbstring']) {
      phpIniContent = phpIniContent.replace(`;extension=${extension}`, `extension=${extension}`);
    }
    fs.writeFileSync(phpIni, phpIniContent);
  }

  // Download and extract MariaDB/MySQL if not already downloaded
  if (!fs.existsSync(mysqlDir)) {
    console.log('Downloading MySQL server...');
    const mysqlUrl = 'https://downloads.mariadb.com/MariaDB/mariadb-10.11.5/winx64-packages/mariadb-10.11.5-winx64.zip';
    const mysqlZipPath = path.join(serverPath, 'mysql.zip');

    await download(mysqlUrl, serverPath, { filename: 'mysql.zip' });

    const zip = new AdmZip(mysqlZipPath);
    zip.extractAllTo(serverPath, true);

    // Rename the extracted folder to 'mysql'
    fs.renameSync(path.join(serverPath, 'mariadb-10.11.5-winx64'), mysqlDir);

    // Cleanup
    fs.unlinkSync(mysqlZipPath);

    // Initialize the MySQL data directory
    if (!fs.existsSync(mysqlDataDir)) {
      fs.mkdirSync(mysqlDataDir, { recursive: true });
      await run(mysqlBin('mysql_install_db.exe'), [`--datadir=${mysqlDataDir}`]);
      console.log('MySQL installed successfully');
    }
  }

  // Download MediaWiki if not already downloaded
  if (!fs.existsSync(path.join(mediaWikiPath, 'index.php'))) {
    console.log('Downloading MediaWiki...');
    const mediawikiUrl = 'https://releases.wikimedia.org/mediawiki/1.39/mediawiki-1.39.5.zip';
    const mediawikiZipPath = path.join(mediaWikiPath, 'mediawiki.zip');

    await download(mediawikiUrl, mediaWikiPath, { filename: 'mediawiki.zip' });

    const zip = new AdmZip(mediawikiZipPath);
    zip.extractAllTo(mediaWikiPath, true);

    // Move files from the extracted folder to mediaWikiPath
    const extractedDir = path.join(mediaWikiPath, 'mediawiki-1.39.5');
    fs.readdirSync(extractedDir).forEach(item => {
      fs.renameSync(path.join(extractedDir, item), path.join(mediaWikiPath, item));
    });

    // Cleanup
    fs.unlinkSync(mediawikiZipPath);
    fs.rmSync(extractedDir, { recursive: true, force: true });
  }

  console.log('All servers downloaded successfully');
  return true;
}

// Start MariaDB if it is not running yet. Resolves with its port once it accepts connections.
async function startMysql() {
  if (mysqlProcess) {
    return mysqlPort;
  }

  const { mysqlDataDir, mysqlBin } = getPaths();
  const port = await portfinder.getPortPromise({ port: DEFAULT_MYSQL_PORT });
  const child = await spawnServer(
    'MySQL',
    mysqlBin('mysqld.exe'),
    [`--datadir=${mysqlDataDir}`, `--port=${port}`, `--bind-address=${LOOPBACK_HOST}`, '--console'],
    port
  );

  mysqlProcess = child;
  mysqlPort = port;
  child.once('exit', () => {
    if (mysqlProcess === child) {
      mysqlProcess = null;
      mysqlPort = null;
    }
  });
  return port;
}

// Start the PHP built-in web server. MySQL must already be running.
async function startPhp() {
  if (phpProcess) {
    return phpPort;
  }

  const { phpExe, phpIni, phpDir, mediaWikiPath } = getPaths();
  const port = await portfinder.getPortPromise({ port: DEFAULT_PHP_PORT });
  const child = await spawnServer(
    'PHP',
    phpExe,
    ['-c', phpIni, '-S', `${LOOPBACK_HOST}:${port}`, '-t', mediaWikiPath],
    port,
    { cwd: phpDir, env: { ...process.env, [DB_PORT_ENV]: String(mysqlPort) } }
  );

  phpProcess = child;
  phpPort = port;
  child.once('exit', () => {
    if (phpProcess === child) {
      phpProcess = null;
      phpPort = null;
    }
  });
  return port;
}

async function createDatabase(config) {
  const connection = await mysql.createConnection({ host: LOOPBACK_HOST, port: mysqlPort, user: 'root' });
  try {
    for (const query of buildDatabaseSetupQueries(config)) {
      await connection.query(query);
    }
  } finally {
    await connection.end();
  }
}

// Install MediaWiki
async function installMediaWiki(rawConfig) {
  const config = validateConfig(rawConfig);
  const { dbName, dbUser, dbPassword, wikiName, adminUser, adminPassword } = config;
  const { mediaWikiPath, phpExe, phpIni } = getPaths();
  const localSettingsPath = path.join(mediaWikiPath, 'LocalSettings.php');

  // In dev mode, simulate installation without actually running commands
  if (isDevMode()) {
    console.log('DEV MODE: Simulating MediaWiki installation');
    console.log(`Creating database: ${dbName} with user: ${dbUser}`);
    console.log(`Installing MediaWiki with name: ${wikiName} and admin: ${adminUser}`);

    fs.writeFileSync(
      localSettingsPath,
      `<?php\n// Mock LocalSettings.php for development\n$wgSitename = ${phpString(wikiName)};\n$wgDBname = ${phpString(dbName)};\n`
    );

    return true;
  }

  if (fs.existsSync(localSettingsPath)) {
    throw new Error('MediaWiki כבר מותקן (הקובץ LocalSettings.php קיים)');
  }

  // The installer needs a running database server
  await startMysql();
  await createDatabase(config);

  await run(
    phpExe,
    [
      '-c', phpIni,
      path.join(mediaWikiPath, 'maintenance', 'install.php'),
      '--dbtype=mysql',
      `--dbserver=${LOOPBACK_HOST}:${mysqlPort}`,
      `--dbname=${dbName}`,
      `--dbuser=${dbUser}`,
      `--dbpass=${dbPassword}`,
      `--installdbuser=${dbUser}`,
      `--installdbpass=${dbPassword}`,
      '--dbprefix=mw_',
      `--server=http://localhost:${DEFAULT_PHP_PORT}`,
      '--scriptpath=',
      `--pass=${adminPassword}`,
      wikiName,
      adminUser
    ],
    { cwd: mediaWikiPath }
  );

  patchLocalSettings(localSettingsPath);
  console.log('MediaWiki installed successfully');
  return true;
}

// Start PHP and MySQL servers
async function startServers() {
  // In dev mode, simulate server start
  if (isDevMode()) {
    if (!devServer) {
      phpPort = await portfinder.getPortPromise({ port: DEFAULT_PHP_PORT });
      mysqlPort = await portfinder.getPortPromise({ port: DEFAULT_MYSQL_PORT });

      console.log('DEV MODE: Simulating server start');
      console.log(`Mock PHP server started at http://localhost:${phpPort}`);
      console.log(`Mock MySQL server started at port ${mysqlPort}`);

      const http = require('http');
      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <html dir="rtl">
            <head><title>המכלול - אתר בדיקה</title></head>
            <body style="font-family: Arial; direction: rtl; padding: 20px;">
              <h1>המכלול אופליין - אתר בדיקה</h1>
              <p>זהו אתר דמה לצורך בדיקת האפליקציה במצב "על יבש".</p>
              <p>פורט PHP: ${phpPort}</p>
              <p>פורט MySQL: ${mysqlPort}</p>
            </body>
          </html>
        `);
      });

      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(phpPort, LOOPBACK_HOST, resolve);
      });
      devServer = server;
    }

    return { phpPort, mysqlPort };
  }

  await startMysql();
  await startPhp();

  return { phpPort, mysqlPort };
}

async function stopMysql() {
  if (!mysqlProcess) {
    return;
  }

  const child = mysqlProcess;
  const port = mysqlPort;
  mysqlProcess = null;
  mysqlPort = null;

  try {
    const { mysqlBin } = getPaths();
    await run(mysqlBin('mysqladmin.exe'), [`--host=${LOOPBACK_HOST}`, `--port=${port}`, '--user=root', 'shutdown']);
    await waitForExit(child, MYSQL_SHUTDOWN_TIMEOUT_MS);
    console.log('MySQL shut down gracefully');
  } catch (error) {
    console.error(`MySQL graceful shutdown failed, force killing: ${error.message}`);
    child.kill();
  }
}

// Stop all servers
async function stopServers() {
  if (devServer) {
    const server = devServer;
    devServer = null;
    await new Promise(resolve => server.close(() => resolve()));
    console.log('Mock PHP server stopped');
  }

  if (phpProcess) {
    phpProcess.kill();
    phpProcess = null;
    phpPort = null;
  }

  await stopMysql();
  return true;
}

module.exports = {
  setDataPath,
  getPaths,
  isDevMode,
  validateConfig,
  buildDatabaseSetupQueries,
  patchLocalSettings,
  downloadServers,
  installMediaWiki,
  startServers,
  stopServers
};
