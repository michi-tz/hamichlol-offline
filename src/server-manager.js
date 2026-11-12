const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const AdmZip = require('adm-zip');
const portfinder = require('portfinder');
const mysql = require('mysql2/promise');
const { DOWNLOADS } = require('./versions');
const systemTools = require('./system-tools');

// Network settings. Everything binds to the loopback interface only.
const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_PHP_PORT = 8080;
const DEFAULT_MYSQL_PORT = 3306;

// LocalSettings.php reads the MySQL port from this environment variable, so the
// wiki keeps working even when a different port is chosen on a later run.
const DB_PORT_ENV = 'HAMICHLOL_DB_PORT';

const SERVER_START_TIMEOUT_MS = 60000;
const MYSQL_SHUTDOWN_TIMEOUT_MS = 15000;
const MYSQL_CONNECT_TIMEOUT_MS = 5000;
const PROCESS_KILL_TIMEOUT_MS = 5000;

// Schemas of the database server itself; (re)creating the wiki database under
// one of these names would destroy the server's own tables.
const RESERVED_DB_NAMES = ['mysql', 'information_schema', 'performance_schema', 'sys'];

const IDENTIFIER_RE = /^[A-Za-z0-9_]{1,64}$/;
// MySQL allows at most 32 characters in a user name (MariaDB allows more)
const DB_USER_RE = /^[A-Za-z0-9_]{1,32}$/;
const MIN_ADMIN_PASSWORD_LENGTH = 10;

const PHP_EXTENSIONS = ['mysqli', 'intl', 'mbstring', 'fileinfo', 'openssl', 'gd'];

// MariaDB renamed its executables (mysqld -> mariadbd, ...). Accept both names.
const MARIADB_BINARIES = {
  server: ['mariadbd.exe', 'mysqld.exe'],
  installDb: ['mariadb-install-db.exe', 'mysql_install_db.exe']
};

// Automatic downloads are Windows builds; elsewhere installed software is used.
function canDownloadServers() {
  return process.platform === 'win32';
}

// Unix socket paths are limited to about 100 characters.
const MAX_SOCKET_PATH_LENGTH = 100;

// Writable directory that holds the downloaded servers, MediaWiki and the
// database. The Electron main process points this at the user's data folder.
let dataPath = process.env.HAMICHLOL_DATA_DIR || path.join(__dirname, '..', 'resources');

// Server processes
let phpProcess = null;
let mysqlProcess = null;
let devServer = null;

// True while stopServers() runs, so exits it causes are not treated as crashes
let stopping = false;

// Servers that were spawned but do not accept connections yet: key -> { child, port }
const startingServers = new Map();

// Server ports (valid while the matching process is running)
let phpPort = null;
let mysqlPort = null;

function setDataPath(dir) {
  dataPath = dir;
}

// How files are downloaded. Node's own fetch by default; the Electron main
// process replaces it with Chromium's network stack, which honours the
// computer's proxy settings and certificate store.
let fetchImpl = (url, options) => fetch(url, options);

function setFetch(implementation) {
  fetchImpl = implementation;
}

function getPaths() {
  const serverPath = path.join(dataPath, 'server');
  const phpDir = path.join(serverPath, `php-${DOWNLOADS.php.version}`);
  const mariadbDir = path.join(serverPath, `mariadb-${DOWNLOADS.mariadb.version}`);
  const mediaWikiPath = path.join(dataPath, 'mediawiki');
  return {
    dataPath,
    serverPath,
    phpDir,
    phpExe: path.join(phpDir, 'php.exe'),
    phpIni: path.join(phpDir, 'php.ini'),
    mariadbDir,
    // Kept outside the versioned MariaDB folder so upgrades keep the data
    dbDataDir: path.join(dataPath, 'database'),
    mediaWikiPath,
    localSettings: path.join(mediaWikiPath, 'LocalSettings.php'),
    runStateFile: path.join(dataPath, 'run-state.json')
  };
}

// Path of a downloaded MariaDB executable, preferring whichever name exists on disk.
function mariadbBinary(kind) {
  const binDir = path.join(getPaths().mariadbDir, 'bin');
  const candidates = MARIADB_BINARIES[kind].map(name => path.join(binDir, name));
  return candidates.find(candidate => fs.existsSync(candidate)) || candidates[0];
}

// Software installed on the computer is used unless disabled; dev mode only
// ever works with its mock files.
function useSystemTools() {
  return !isDevMode() && systemTools.isEnabled();
}

// The PHP to run: the downloaded copy if there is one, otherwise a suitable PHP
// that is already installed on the computer. `problem` says why an installed
// PHP was found but cannot be used.
function resolvePhp() {
  const { phpExe, phpIni, phpDir } = getPaths();
  if (fs.existsSync(phpExe) && fs.existsSync(phpIni)) {
    return { source: 'bundled', exe: phpExe, ini: phpIni, cwd: phpDir, version: DOWNLOADS.php.version };
  }
  const found = useSystemTools() ? systemTools.findSystemPhp() : null;
  if (found && found.usable) {
    // No -c: an installed PHP keeps using its own php.ini
    return { source: 'system', exe: found.exe, ini: null, cwd: undefined, version: found.version };
  }
  return { source: null, problem: found ? `${found.exe} (${found.version || '?'}): ${found.reason}` : null };
}

// The database server to run, chosen like PHP. Only the program is shared with
// an existing installation: the app starts its own process with its own data.
function resolveDatabase() {
  const server = mariadbBinary('server');
  if (fs.existsSync(server)) {
    return {
      source: 'bundled',
      exe: server,
      installDb: mariadbBinary('installDb'),
      flavor: 'mariadb',
      version: DOWNLOADS.mariadb.version
    };
  }
  const found = useSystemTools() ? systemTools.findSystemDatabase() : null;
  if (found && found.usable) {
    return { source: 'system', exe: found.exe, installDb: found.installDb, flavor: found.flavor, version: found.version };
  }
  return { source: null, problem: found ? `${found.exe} (${found.version || '?'}): ${found.reason}` : null };
}

// Where MediaWiki's files come from: already in the data folder, a copy of an
// installation found on the computer, or a download.
function resolveMediaWiki() {
  const { mediaWikiPath } = getPaths();
  if (fs.existsSync(path.join(mediaWikiPath, 'index.php'))) {
    return { source: 'installed', dir: mediaWikiPath, version: readMediaWikiVersion(mediaWikiPath) };
  }
  const found = useSystemTools() ? systemTools.findSystemMediaWiki() : null;
  if (found && found.usable) {
    // An installed MediaWiki newer than the available PHP supports cannot be
    // installed; the version this app downloads works with every accepted PHP
    // With no PHP available yet, the one this app would download is what counts
    const phpVersion = resolvePhp().version || DOWNLOADS.php.version;
    const phpTooOld = Boolean(found.minPhp) && systemTools.compareVersions(phpVersion, found.minPhp) < 0;
    if (!phpTooOld) {
      return { source: 'system', dir: found.dir, version: found.version };
    }
    return {
      source: 'download',
      dir: null,
      version: DOWNLOADS.mediawiki.version,
      problem: `${found.dir} (${found.version}): דורש PHP ${found.minPhp} ומעלה`
    };
  }
  return { source: 'download', dir: null, version: DOWNLOADS.mediawiki.version };
}

function readMediaWikiVersion(dir) {
  try {
    const defines = fs.readFileSync(path.join(dir, 'includes', 'Defines.php'), 'utf8');
    const match = /define\(\s*'MW_VERSION'\s*,\s*'([^']+)'/.exec(defines);
    return match ? match[1] : null;
  } catch (error) {
    return null;
  }
}

function requirePhp() {
  const php = resolvePhp();
  if (!php.source) {
    throw new Error('PHP אינו מותקן');
  }
  return php;
}

function requireDatabase() {
  const database = resolveDatabase();
  if (!database.source) {
    throw new Error('שרת מסד הנתונים אינו מותקן');
  }
  return database;
}

function phpArgs(php, args) {
  return php.ini ? ['-c', php.ini, ...args] : args;
}

// A database server refuses to run as root unless told which user to run as.
function runsAsRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

// Options for a database server that shares the computer with other installations.
function dbServerArgs(database, port) {
  const { dataPath, dbDataDir } = getPaths();
  // --no-defaults must come first; it ignores my.ini / my.cnf of other installations
  const args = ['--no-defaults', `--datadir=${dbDataDir}`, `--port=${port}`, `--bind-address=${LOOPBACK_HOST}`];
  if (process.platform === 'win32') {
    args.push('--console');
  } else {
    // The default socket and PID file belong to the system-wide server
    let socket = path.join(dataPath, 'mysql.sock');
    if (socket.length > MAX_SOCKET_PATH_LENGTH) {
      socket = path.join(os.tmpdir(), `hamichlol-mysql-${port}.sock`);
    }
    args.push(`--socket=${socket}`, `--pid-file=${path.join(dataPath, 'mysql.pid')}`);
    if (runsAsRoot()) {
      args.push('--user=root');
    }
  }
  if (database.flavor === 'mysql') {
    // MySQL 8 also listens on a second (X protocol) port unless disabled.
    // "loose": servers without the X plugin ignore the option instead of refusing to start.
    args.push('--loose-mysqlx=OFF');
  }
  return args;
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
//
function startError(label, file, error) {
  const wrapped = new Error(`${label} could not be started (${file}): ${error.code || error.message}`);
  wrapped.code = error.code;
  return wrapped;
}

// `key` ('mysql' or 'php') tracks the process while it is still starting, so
// that stopping the servers or a crash at that moment does not leave it behind.
async function spawnServer(label, key, file, args, port, options = {}) {
  let child;
  try {
    child = spawn(file, args, { windowsHide: true, ...options });
  } catch (error) {
    // Windows reports a file that is not a program as just "spawn UNKNOWN"
    throw startError(label, file, error);
  }
  startingServers.set(key, { child, port });
  writeRunState();
  try {
    return await waitUntilListening(label, child, port);
  } finally {
    startingServers.delete(key);
  }
}

async function waitUntilListening(label, child, port) {
  let failure = null;
  child.once('error', error => {
    failure = failure || startError(label, child.spawnfile, error);
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

  try {
    await terminate(child);
  } catch (error) {
    console.error(`${label} could not be stopped after it failed to start: ${error.message}`);
  }
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

// Kill a child process and wait until it has really exited, so its files and
// port are free again. Rejects if it is still running after a forced kill.
async function terminate(child) {
  child.kill();
  try {
    await waitForExit(child, PROCESS_KILL_TIMEOUT_MS);
  } catch (error) {
    child.kill('SIGKILL');
    await waitForExit(child, PROCESS_KILL_TIMEOUT_MS);
  }
}

// ---------------------------------------------------------------------------
// Leftover processes from a previous run
//
// If the app crashed or was killed, Windows does not stop its child processes.
// A leftover MariaDB keeps the database locked, so the next start would fail.
// The PIDs of running servers are saved to run-state.json and cleaned up on start.
// ---------------------------------------------------------------------------

function readRunState() {
  try {
    const state = JSON.parse(fs.readFileSync(getPaths().runStateFile, 'utf8'));
    // A damaged file must not stop the servers from ever starting again
    return state && typeof state === 'object' ? state : {};
  } catch (error) {
    return {};
  }
}

// Entries of servers this process could not confirm as stopped; they are kept in
// the file so a later start can try again.
let unresolvedRunState = {};

// A command-line argument only this app's server has, so that another server
// started from the same program is never mistaken for a leftover of ours.
function dbProcessMarker() {
  return `--datadir=${getPaths().dbDataDir}`;
}

function phpProcessMarker() {
  return getPaths().mediaWikiPath;
}

function writeRunState() {
  const { runStateFile } = getPaths();
  const state = { ...unresolvedRunState };
  if (mysqlProcess) {
    state.mysql = { pid: mysqlProcess.pid, port: mysqlPort, exe: mysqlProcess.spawnfile, marker: dbProcessMarker() };
  }
  if (phpProcess) {
    state.php = { pid: phpProcess.pid, port: phpPort, exe: phpProcess.spawnfile, marker: phpProcessMarker() };
  }
  // Servers that are still starting are saved too, in case the app dies meanwhile
  const markers = { mysql: dbProcessMarker(), php: phpProcessMarker() };
  for (const [key, { child, port }] of startingServers) {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      state[key] = { pid: child.pid, port, exe: child.spawnfile, marker: markers[key] };
    }
  }
  if (Object.keys(state).length === 0) {
    fs.rmSync(runStateFile, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(runStateFile), { recursive: true });
  fs.writeFileSync(runStateFile, JSON.stringify(state, null, 2));
}

// Full command line of a running process. Throws when it cannot be read.
async function readCommandLine(pid) {
  if (process.platform === 'linux') {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
  }
  if (process.platform === 'win32') {
    return run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`
    ]);
  }
  // macOS and other Unix systems; -ww: do not truncate the command
  return run('ps', ['-ww', '-o', 'command=', '-p', String(pid)]);
}

// Whether the process saved in a run-state entry is still this app's server:
// 'ours'    - alive, and its command line has the program and our marker
// 'gone'    - exited, or the PID now belongs to some other process
// 'unknown' - alive, but its command line could not be read
async function identifyProcess(entry) {
  const { pid, exe, marker } = entry || {};
  if (!Number.isInteger(pid) || pid <= 0 || typeof exe !== 'string' || typeof marker !== 'string' || !marker) {
    return 'gone';
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code !== 'EPERM') {
      return 'gone';
    }
  }

  let commandLine;
  try {
    commandLine = await readCommandLine(pid);
  } catch (error) {
    // The process may have exited between the two checks
    try {
      process.kill(pid, 0);
    } catch (killError) {
      if (killError.code !== 'EPERM') {
        return 'gone';
      }
    }
    return 'unknown';
  }

  if (process.platform === 'win32') {
    commandLine = commandLine.toLowerCase();
    return commandLine.includes(path.basename(exe).toLowerCase()) && commandLine.includes(marker.toLowerCase())
      ? 'ours' : 'gone';
  }
  return commandLine.includes(exe) && commandLine.includes(marker) ? 'ours' : 'gone';
}

// Resolves true once the process of `entry` is no longer ours.
async function waitForEntryExit(entry, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await identifyProcess(entry)) === 'gone') {
      return true;
    }
    await delay(250);
  }
  return false;
}

function killPid(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    // Already gone
  }
}

// Stop one leftover server. Returns false if it could not be confirmed as
// stopped, in which case its entry has to stay in the run state.
async function stopLeftover(label, entry, gracefulStop) {
  const identity = await identifyProcess(entry);
  if (identity === 'gone') {
    return true;
  }
  if (identity === 'unknown') {
    console.error(`Cannot verify leftover ${label} server (pid ${entry.pid}); leaving it alone`);
    return false;
  }

  console.log(`Stopping leftover ${label} server (pid ${entry.pid})`);
  if (gracefulStop) {
    try {
      await gracefulStop(entry);
      if (await waitForEntryExit(entry, MYSQL_SHUTDOWN_TIMEOUT_MS)) {
        return true;
      }
    } catch (error) {
      console.error(`Graceful shutdown of leftover ${label} failed: ${error.message}`);
    }
  }
  killPid(entry.pid);
  if (await waitForEntryExit(entry, PROCESS_KILL_TIMEOUT_MS)) {
    return true;
  }
  killPid(entry.pid, 'SIGKILL');
  return waitForEntryExit(entry, PROCESS_KILL_TIMEOUT_MS);
}

async function cleanupStaleProcesses() {
  const state = readRunState();
  const unresolved = {};

  const stalePhp = state.php;
  if (stalePhp && !(phpProcess && phpProcess.pid === stalePhp.pid) &&
      !(await stopLeftover('PHP', stalePhp))) {
    unresolved.php = stalePhp;
  }

  const staleMysql = state.mysql;
  if (staleMysql && !(mysqlProcess && mysqlProcess.pid === staleMysql.pid) &&
      !(await stopLeftover('MySQL', staleMysql, entry => mysqlAdminShutdown(entry.port)))) {
    unresolved.mysql = staleMysql;
  }

  unresolvedRunState = unresolved;
  writeRunState();
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

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
  if (RESERVED_DB_NAMES.includes(result.dbName.toLowerCase())) {
    throw new Error(`השם ${result.dbName} שמור לשימוש שרת מסד הנתונים. יש לבחור שם אחר`);
  }
  if (!DB_USER_RE.test(result.dbUser)) {
    throw new Error('שם המשתמש למסד הנתונים יכול להכיל רק אותיות לטיניות, ספרות וקו תחתון, עד 32 תווים');
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

// SQL that (re)creates the wiki database and user. Values are escaped by mysql2.
// The database is dropped first so a previously failed installation can be
// retried; it is only called while MediaWiki is not installed yet.
function buildDatabaseSetupQueries({ dbName, dbUser, dbPassword }) {
  return [
    mysql.format('DROP DATABASE IF EXISTS ??', [dbName]),
    mysql.format('CREATE DATABASE ??', [dbName]),
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

// Distribution packages of MediaWiki (Debian, Ubuntu) point the cache and the
// error logs at system folders such as /var/cache/mediawiki, which only the
// web server's user may write to; every page then fails for an ordinary user.
// This block, appended to LocalSettings.php, keeps them inside the wiki folder.
const LOCAL_PATHS_MARKER = '# Added by Hamichlol Offline: keep caches and logs inside this folder';
const LOCAL_PATHS_SETTINGS = [
  LOCAL_PATHS_MARKER,
  '$wgCacheDirectory = "$IP/cache";',
  'if ( $wgDBerrorLog ) {',
  '\t$wgDBerrorLog = "$IP/cache/dberror.log";',
  '}',
  "foreach ( [ 'exception', 'error', 'fatal' ] as $hamichlolLogGroup ) {",
  '\tif ( isset( $wgDebugLogGroups[$hamichlolLogGroup] ) ) {',
  '\t\t$wgDebugLogGroups[$hamichlolLogGroup] = "$IP/cache/$hamichlolLogGroup.log";',
  '\t}',
  '}',
  'unset( $hamichlolLogGroup );',
  ''
].join('\n');

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
  if (!source.includes(LOCAL_PATHS_MARKER)) {
    source = `${source.replace(/\s*$/, '')}\n\n${LOCAL_PATHS_SETTINGS}`;
  }
  fs.writeFileSync(filePath, source);
}

// `sourceDir` is where the files are now; `finalDir` is where PHP will run from.
function configurePhpIni(sourceDir, finalDir) {
  const phpIni = path.join(sourceDir, 'php.ini');
  let content = fs.readFileSync(path.join(sourceDir, 'php.ini-development'), 'utf8');
  // Without an explicit extension_dir, Windows PHP looks for extensions in C:\php\ext
  content = content.replace(
    /^;\s*extension_dir\s*=\s*"ext"[ \t]*(?=\r?$)/m,
    () => `extension_dir = "${path.join(finalDir, 'ext')}"`
  );
  for (const extension of PHP_EXTENSIONS) {
    content = content.replace(
      // Only trailing blanks may follow, so line endings and neighbours are kept
      new RegExp(`^;extension=${extension}[ \\t]*(?=\\r?$)`, 'm'),
      `extension=${extension}`
    );
  }
  fs.writeFileSync(phpIni, content);
}

function phpString(value) {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function isDatabaseInitialized() {
  return fs.existsSync(path.join(getPaths().dbDataDir, 'mysql'));
}

// What has already been done, so the UI can resume after the app restarts.
function getStatus() {
  const paths = getPaths();
  const php = resolvePhp();
  const database = resolveDatabase();
  const mediawiki = resolveMediaWiki();
  const downloaded =
    php.source !== null &&
    database.source !== null &&
    isDatabaseInitialized() &&
    mediawiki.source === 'installed';
  const installed = fs.existsSync(paths.localSettings);
  const running = isDevMode() ? devServer !== null : phpProcess !== null && mysqlProcess !== null;

  return {
    downloaded,
    installed,
    running,
    phpPort: running ? phpPort : null,
    mysqlPort: running ? mysqlPort : null,
    devMode: isDevMode(),
    // What each component is (or will be) taken from: 'bundled' = downloaded by
    // the app, 'system' = installed on the computer, null = has to be downloaded
    tools: {
      php: { source: php.source, version: php.version || null, path: php.exe || null, problem: php.problem || null },
      database: {
        source: database.source,
        version: database.version || null,
        flavor: database.flavor || null,
        path: database.exe || null,
        problem: database.problem || null
      },
      mediawiki: { source: mediawiki.source, version: mediawiki.version, path: mediawiki.dir, problem: mediawiki.problem || null }
    },
    canDownloadServers: canDownloadServers(),
    versions: {
      php: DOWNLOADS.php.version,
      mariadb: DOWNLOADS.mariadb.version,
      mediawiki: DOWNLOADS.mediawiki.version
    }
  };
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

// Save `url` to `filePath`, following redirects.
async function downloadFile(url, filePath) {
  const response = await fetchImpl(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
  }
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(filePath));
}

async function downloadFirstAvailable(urls, zipPath) {
  let lastError = null;
  for (const url of urls) {
    try {
      console.log(`Downloading ${url}`);
      await downloadFile(url, zipPath);
      return;
    } catch (error) {
      console.error(`Download failed from ${url}: ${error.message}`);
      lastError = error;
    }
  }
  throw lastError;
}

// Download a zip and extract it into `targetDir`. Work happens in temporary
// paths and the result is renamed into place only when complete, so an
// interrupted download is never mistaken for a finished one.
// On Windows an antivirus scanning a file that was just written keeps it
// locked for a while; opening, moving or deleting it (or a folder holding it)
// then fails with EPERM, EBUSY or EACCES. Such operations are retried.
const LOCK_ERROR_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const lockRetry = { attempts: 60, delayMs: 500 };

async function retryWhileLocked(file, action) {
  for (let attempt = 1; ; attempt++) {
    try {
      return action();
    } catch (error) {
      if (process.platform !== 'win32' || !LOCK_ERROR_CODES.has(error.code)) {
        throw error;
      }
      if (attempt >= lockRetry.attempts) {
        const locked = new Error(
          `אין גישה לקובץ ${file} (${error.code}). ייתכן שתוכנת אנטי-וירוס חוסמת אותו: ` +
          'יש לבדוק ב"היסטוריית ההגנה" של אבטחת Windows ולנסות שוב'
        );
        locked.code = error.code;
        throw locked;
      }
      await delay(lockRetry.delayMs);
    }
  }
}

function removePath(target) {
  return retryWhileLocked(target, () => fs.rmSync(target, { recursive: true, force: true }));
}

// Clean-up that must not hide the error that made it necessary; whatever is
// left is removed at the start of the next attempt.
async function removeQuietly(target) {
  try {
    await removePath(target);
  } catch (error) {
    console.error(`Could not remove ${target}: ${error.message}`);
  }
}

async function downloadAndExtract(urls, targetDir, { stripRootFolder = false, prepare } = {}) {
  const zipPath = `${targetDir}.zip`;
  const partialDir = `${targetDir}.partial`;
  await removePath(zipPath);
  await removePath(partialDir);
  fs.mkdirSync(partialDir, { recursive: true });

  try {
    await downloadFirstAvailable(urls, zipPath);
    const zipData = await retryWhileLocked(zipPath, () => fs.readFileSync(zipPath));
    new AdmZip(zipData).extractAllTo(partialDir, true);

    let root = partialDir;
    if (stripRootFolder) {
      const entries = fs.readdirSync(partialDir);
      if (entries.length === 1 && fs.statSync(path.join(partialDir, entries[0])).isDirectory()) {
        root = path.join(partialDir, entries[0]);
      }
    }

    if (prepare) {
      prepare(root, targetDir);
    }

    await removePath(targetDir);
    await retryWhileLocked(targetDir, () => fs.renameSync(root, targetDir));
  } finally {
    await removeQuietly(zipPath);
    await removeQuietly(partialDir);
  }
}

async function initializeDatabase() {
  const { dbDataDir } = getPaths();
  const partialDir = `${dbDataDir}.partial`;
  await removePath(partialDir);

  const database = requireDatabase();
  const asRoot = runsAsRoot() ? ['--user=root'] : [];
  if (database.flavor === 'mysql') {
    // MySQL has no separate install tool; root gets an empty password, as with MariaDB
    await run(database.exe, ['--no-defaults', '--initialize-insecure', `--datadir=${partialDir}`, ...asRoot]);
  } else if (process.platform === 'win32') {
    await run(database.installDb, [`--datadir=${partialDir}`]);
  } else {
    await run(database.installDb, [
      '--no-defaults',
      `--datadir=${partialDir}`,
      // Password-less root over TCP, like the Windows tool sets up. The server
      // only listens on the loopback interface.
      '--auth-root-authentication-method=normal',
      '--skip-test-db',
      ...asRoot
    ]);
  }
  await removePath(dbDataDir);
  await retryWhileLocked(dbDataDir, () => fs.renameSync(partialDir, dbDataDir));
  console.log('MySQL data directory initialized');
}

function assertCanDownload(name, problem) {
  if (canDownloadServers()) {
    return;
  }
  const details = problem ? ` נמצאה התקנה שאינה מתאימה: ${problem}.` : '';
  throw new Error(
    `${name} אינו מותקן במחשב, והורדה אוטומטית נתמכת רק ב-Windows.${details} יש להתקין את ${name} ולנסות שוב`
  );
}

// Copy a MediaWiki installation found on the computer into the data folder, so
// the existing installation (and its wiki, if any) is never modified.
async function copyMediaWiki(sourceDir, targetDir) {
  const partialDir = `${targetDir}.partial`;
  // Per-wiki state of the existing installation; a fresh wiki starts without it
  const skipped = ['LocalSettings.php', 'images', 'cache'];
  // Compared in one canonical form: on Windows the copy reports paths in a
  // different spelling from the one it was given
  const root = path.toNamespacedPath(path.resolve(sourceDir));
  const isSkipped = source => skipped.includes(path.relative(root, path.toNamespacedPath(path.resolve(source))));
  await removePath(partialDir);

  try {
    fs.cpSync(sourceDir, partialDir, {
      recursive: true,
      // Distribution packages are full of symlinks into other system folders
      dereference: true,
      filter: source => !isSkipped(source)
    });
    fs.mkdirSync(path.join(partialDir, 'images'), { recursive: true });
    fs.mkdirSync(path.join(partialDir, 'cache'), { recursive: true });
    await removePath(targetDir);
    await retryWhileLocked(targetDir, () => fs.renameSync(partialDir, targetDir));
  } finally {
    await removeQuietly(partialDir);
  }
}

function createMockServers() {
  const { phpDir, phpIni, mariadbDir, dbDataDir, mediaWikiPath } = getPaths();

  if (!fs.existsSync(phpIni)) {
    fs.mkdirSync(phpDir, { recursive: true });
    fs.writeFileSync(path.join(phpDir, 'php.exe'), 'MOCK PHP EXE');
    fs.writeFileSync(phpIni, PHP_EXTENSIONS.map(extension => `extension=${extension}`).join('\n'));
  }

  const binDir = path.join(mariadbDir, 'bin');
  if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
    for (const kind of Object.keys(MARIADB_BINARIES)) {
      fs.writeFileSync(path.join(binDir, MARIADB_BINARIES[kind][0]), 'MOCK MARIADB EXE');
    }
  }

  fs.mkdirSync(path.join(dbDataDir, 'mysql'), { recursive: true });

  if (!fs.existsSync(path.join(mediaWikiPath, 'index.php'))) {
    fs.mkdirSync(path.join(mediaWikiPath, 'maintenance'), { recursive: true });
    fs.writeFileSync(path.join(mediaWikiPath, 'index.php'), '<?php echo "Mock MediaWiki"; ?>');
    fs.writeFileSync(path.join(mediaWikiPath, 'maintenance', 'install.php'), '<?php echo "Mock Installer"; ?>');
  }
}

// Download required server files. Components that are already present are skipped.
async function downloadServers() {
  const { serverPath, phpDir, mariadbDir, mediaWikiPath } = getPaths();
  fs.mkdirSync(serverPath, { recursive: true });

  // In dev mode, we'll simulate the downloads with dummy files
  if (isDevMode()) {
    console.log('DEV MODE: Simulating server downloads');
    createMockServers();
    return true;
  }

  // Look again for installed software: it may have been added since the last check
  systemTools.resetCache();

  const php = resolvePhp();
  if (php.source === 'system') {
    console.log(`Using installed PHP ${php.version} (${php.exe})`);
  } else if (!php.source) {
    assertCanDownload('PHP', php.problem);
    console.log(`Downloading PHP ${DOWNLOADS.php.version}...`);
    await downloadAndExtract(DOWNLOADS.php.urls, phpDir, {
      prepare: (root, finalDir) => configurePhpIni(root, finalDir)
    });
  }

  const database = resolveDatabase();
  if (database.source === 'system') {
    console.log(`Using installed ${database.flavor} ${database.version} (${database.exe})`);
  } else if (!database.source) {
    assertCanDownload('MariaDB', database.problem);
    console.log(`Downloading MariaDB ${DOWNLOADS.mariadb.version}...`);
    await downloadAndExtract(DOWNLOADS.mariadb.urls, mariadbDir, { stripRootFolder: true });
  }

  if (!isDatabaseInitialized()) {
    await initializeDatabase();
  }

  // Only ever replace an incomplete MediaWiki folder, never an installed wiki
  if (!fs.existsSync(path.join(mediaWikiPath, 'index.php'))) {
    if (fs.existsSync(getPaths().localSettings)) {
      throw new Error('תיקיית MediaWiki פגומה: LocalSettings.php קיים אך קבצי MediaWiki חסרים');
    }
    const mediawiki = resolveMediaWiki();
    if (mediawiki.source === 'system') {
      console.log(`Copying installed MediaWiki ${mediawiki.version} from ${mediawiki.dir}`);
      await copyMediaWiki(mediawiki.dir, mediaWikiPath);
    } else {
      console.log(`Downloading MediaWiki ${DOWNLOADS.mediawiki.version}...`);
      await downloadAndExtract(DOWNLOADS.mediawiki.urls, mediaWikiPath, { stripRootFolder: true });
    }
  }

  console.log('All servers downloaded successfully');
  return true;
}

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------

// Ask the database server on `port` to shut down cleanly. Done over SQL so no
// extra admin tool has to be located.
async function mysqlAdminShutdown(port) {
  const connection = await mysql.createConnection({
    host: LOOPBACK_HOST, port, user: 'root', connectTimeout: MYSQL_CONNECT_TIMEOUT_MS
  });
  // The server closes the connection while shutting down
  connection.on('error', () => {});
  // A server that accepts the connection but never answers must not block the
  // forced kill that follows a failed graceful shutdown
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Timed out waiting for the SHUTDOWN command')), MYSQL_SHUTDOWN_TIMEOUT_MS);
  });
  try {
    await Promise.race([connection.query('SHUTDOWN'), timeout]);
  } finally {
    clearTimeout(timer);
    connection.destroy();
  }
}

// When one server dies on its own, stop the other one too. Otherwise the app
// would report "not running" while a server it can no longer stop keeps going.
function stopSurvivor(exitedLabel, survivor) {
  if (stopping || !survivor) {
    return;
  }
  console.error(`${exitedLabel} server exited unexpectedly; stopping the other server`);
  stopServers().catch(error => console.error(`Failed to stop servers: ${error.message}`));
}

// Start MariaDB if it is not running yet. Resolves with its port once it accepts connections.
async function startMysql() {
  if (mysqlProcess) {
    return mysqlPort;
  }

  await cleanupStaleProcesses();

  const database = requireDatabase();
  const port = await portfinder.getPortPromise({ port: DEFAULT_MYSQL_PORT });
  const child = await spawnServer('MySQL', 'mysql', database.exe, dbServerArgs(database, port), port);

  mysqlProcess = child;
  mysqlPort = port;
  writeRunState();
  child.once('exit', () => {
    if (mysqlProcess === child) {
      mysqlProcess = null;
      mysqlPort = null;
      writeRunState();
      stopSurvivor('MySQL', phpProcess);
    }
  });
  return port;
}

// Start the PHP built-in web server. MySQL must already be running.
async function startPhp() {
  if (phpProcess) {
    return phpPort;
  }

  await cleanupStaleProcesses();

  const { mediaWikiPath } = getPaths();
  const php = requirePhp();
  const port = await portfinder.getPortPromise({ port: DEFAULT_PHP_PORT });
  const child = await spawnServer(
    'PHP',
    'php',
    php.exe,
    phpArgs(php, ['-S', `${LOOPBACK_HOST}:${port}`, '-t', mediaWikiPath]),
    port,
    { cwd: php.cwd, env: { ...process.env, [DB_PORT_ENV]: String(mysqlPort) } }
  );

  phpProcess = child;
  phpPort = port;
  writeRunState();
  child.once('exit', () => {
    if (phpProcess === child) {
      phpProcess = null;
      phpPort = null;
      writeRunState();
      stopSurvivor('PHP', mysqlProcess);
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
  const { mediaWikiPath, localSettings } = getPaths();

  if (fs.existsSync(localSettings)) {
    throw new Error('MediaWiki כבר מותקן (הקובץ LocalSettings.php קיים)');
  }

  // In dev mode, simulate installation without actually running commands
  if (isDevMode()) {
    console.log('DEV MODE: Simulating MediaWiki installation');
    console.log(`Creating database: ${dbName} with user: ${dbUser}`);
    console.log(`Installing MediaWiki with name: ${wikiName} and admin: ${adminUser}`);

    fs.writeFileSync(
      localSettings,
      `<?php\n// Mock LocalSettings.php for development\n$wgSitename = ${phpString(wikiName)};\n$wgDBname = ${phpString(dbName)};\n`
    );

    return true;
  }

  // The installer needs a running database server. It is stopped again afterwards
  // (unless it was already running), so the app is never left half-started.
  const mysqlWasRunning = mysqlProcess !== null;
  await startMysql();
  try {
    await createDatabase(config);

    const php = requirePhp();
    await run(
      php.exe,
      phpArgs(php, [
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
      ]),
      { cwd: mediaWikiPath }
    );
  } finally {
    if (!mysqlWasRunning) {
      await stopMysql().catch(error => console.error(`Failed to stop MySQL: ${error.message}`));
      writeRunState();
    }
  }

  patchLocalSettings(localSettings);
  console.log('MediaWiki installed successfully');
  return true;
}

// Start PHP and MySQL servers
async function startServers() {
  if (!getStatus().installed) {
    throw new Error('MediaWiki עדיין לא הותקן');
  }

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

  const mysqlWasRunning = mysqlProcess !== null;
  await startMysql();
  try {
    await startPhp();
  } catch (error) {
    // Half-started servers would be reported as "not running", with no way to stop them
    if (!mysqlWasRunning) {
      await stopMysql().catch(stopError => console.error(`Failed to stop MySQL: ${stopError.message}`));
      writeRunState();
    }
    throw error;
  }

  return { phpPort, mysqlPort };
}

async function stopMysql() {
  if (!mysqlProcess) {
    return;
  }

  const child = mysqlProcess;
  const port = mysqlPort;

  try {
    await mysqlAdminShutdown(port);
    await waitForExit(child, MYSQL_SHUTDOWN_TIMEOUT_MS);
    console.log('MySQL shut down gracefully');
  } catch (error) {
    console.error(`MySQL graceful shutdown failed, force killing: ${error.message}`);
    // Throws if the process survives; the handle and run state are then kept
    await terminate(child);
  }

  if (mysqlProcess === child) {
    mysqlProcess = null;
    mysqlPort = null;
  }
}

// Stop all servers
async function stopServers() {
  if (devServer) {
    const server = devServer;
    devServer = null;
    await new Promise(resolve => {
      server.close(() => resolve());
      // Do not wait for idle keep-alive connections (e.g. the wiki frame's)
      server.closeAllConnections();
    });
    console.log('Mock PHP server stopped');
  }

  const wasRunning = phpProcess !== null || mysqlProcess !== null || startingServers.size > 0;

  stopping = true;
  try {
    // Servers caught in the middle of starting; their pending start then fails
    for (const { child } of [...startingServers.values()]) {
      await terminate(child);
    }
    if (phpProcess) {
      await terminate(phpProcess);
      phpProcess = null;
      phpPort = null;
    }
    await stopMysql();
  } finally {
    stopping = false;
    if (wasRunning) {
      writeRunState();
    }
  }
  return true;
}

module.exports = {
  setDataPath,
  setFetch,
  dbServerArgs,
  getPaths,
  getStatus,
  cleanupStaleProcesses,
  isDevMode,
  validateConfig,
  buildDatabaseSetupQueries,
  patchLocalSettings,
  downloadServers,
  installMediaWiki,
  startServers,
  stopServers,
  // Building blocks, exported for the tests only
  _internal: {
    configurePhpIni,
    downloadAndExtract,
    copyMediaWiki,
    lockRetry,
    identifyProcess,
    mysqlAdminShutdown,
    createDatabase
  }
};
