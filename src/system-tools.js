// Finds PHP, MariaDB/MySQL and MediaWiki that are already installed on this
// computer, so they can be used instead of downloading separate copies.
//
// Only the programs are reused. The app still runs its own database server
// process on its own port with its own data folder, and never touches the
// databases or the configuration of an existing installation.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const IS_WINDOWS = process.platform === 'win32';
const INSPECT_TIMEOUT_MS = 15000;

// Oldest versions that work with the MediaWiki versions this app installs.
const MIN_VERSIONS = {
  php: '8.1.0',
  mariadb: '10.3.0',
  // 5.7.6 introduced "mysqld --initialize-insecure", which creates the data folder
  mysql: '5.7.6',
  mediawiki: '1.39.0'
};

// Extensions MediaWiki cannot run without (gd is optional: thumbnails only).
const REQUIRED_PHP_EXTENSIONS = [
  'mysqli', 'ctype', 'dom', 'fileinfo', 'iconv', 'intl', 'json', 'mbstring', 'openssl', 'xml', 'xmlreader'
];

// Explicit locations, for installations that are not found automatically.
const ENV = {
  enabled: 'HAMICHLOL_USE_SYSTEM',
  php: 'HAMICHLOL_PHP',
  dbServer: 'HAMICHLOL_MYSQLD',
  mediawiki: 'HAMICHLOL_MEDIAWIKI_DIR'
};

// MariaDB renamed its executables (mysqld -> mariadbd, ...). Accept both names.
const DB_SERVER_NAMES = ['mariadbd', 'mysqld'];
const DB_INSTALL_NAMES = ['mariadb-install-db', 'mysql_install_db'];

let cache = {};

function resetCache() {
  cache = {};
}

function cached(key, compute) {
  if (!(key in cache)) {
    cache[key] = compute();
  }
  return cache[key];
}

// System software is used unless HAMICHLOL_USE_SYSTEM is set to false/0/no.
function isEnabled() {
  return !/^(false|0|no|off)$/i.test(process.env[ENV.enabled] || '');
}

function compareVersions(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] || 0) - (right[i] || 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch (error) {
    return false;
  }
}

function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch (error) {
    return false;
  }
}

// Sub-folders of `base` whose name matches `pattern` (e.g. "MariaDB 11.4"),
// each joined with `suffix`. Newest version first.
function matchingDirs(base, pattern, suffix = '') {
  let names;
  try {
    names = fs.readdirSync(base);
  } catch (error) {
    return [];
  }
  return names
    .filter(name => pattern.test(name))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map(name => path.join(base, name, suffix));
}

function pathDirs() {
  return (process.env.PATH || '').split(path.delimiter).filter(Boolean);
}

function programFilesDirs() {
  return [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
}

// Well-known install folders that are often missing from PATH.
function phpDirs() {
  if (IS_WINDOWS) {
    return [
      'C:\\xampp\\php',
      'C:\\php',
      ...programFilesDirs().map(dir => path.join(dir, 'PHP')),
      ...programFilesDirs().flatMap(dir => matchingDirs(dir, /^php/i)),
      ...matchingDirs('C:\\wamp64\\bin\\php', /^php/i),
      ...matchingDirs('C:\\laragon\\bin\\php', /^php/i)
    ];
  }
  return ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'];
}

function dbDirs() {
  if (IS_WINDOWS) {
    return [
      ...programFilesDirs().flatMap(dir => matchingDirs(dir, /^MariaDB/i, 'bin')),
      ...programFilesDirs().flatMap(dir => matchingDirs(path.join(dir, 'MySQL'), /^MySQL Server/i, 'bin')),
      'C:\\xampp\\mysql\\bin',
      ...matchingDirs('C:\\wamp64\\bin\\mariadb', /^mariadb/i, 'bin'),
      ...matchingDirs('C:\\wamp64\\bin\\mysql', /^mysql/i, 'bin'),
      ...matchingDirs('C:\\laragon\\bin\\mysql', /./, 'bin')
    ];
  }
  return [
    '/usr/sbin', '/usr/local/sbin', '/usr/bin', '/usr/local/bin', '/usr/libexec',
    '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/mysql/bin'
  ];
}

function mediaWikiDirs() {
  if (IS_WINDOWS) {
    return ['C:\\xampp\\htdocs\\mediawiki', 'C:\\wamp64\\www\\mediawiki', 'C:\\laragon\\www\\mediawiki'];
  }
  return ['/usr/share/mediawiki', '/usr/share/webapps/mediawiki', '/var/www/html/mediawiki', '/var/www/mediawiki'];
}

// Existing executables called one of `names` in `dirs`, without duplicates
// (the same file is often reachable through several folders or symlinks).
function findExecutables(names, dirs) {
  const found = [];
  const seen = new Set();
  for (const dir of dirs) {
    for (const name of names) {
      const file = path.join(dir, IS_WINDOWS ? `${name}.exe` : name);
      if (!isFile(file)) {
        continue;
      }
      const real = fs.realpathSync(file);
      if (!seen.has(real)) {
        seen.add(real);
        found.push(file);
      }
    }
  }
  return found;
}

// The explicitly configured file (if any) followed by the automatic candidates.
function withOverride(envName, candidates) {
  const override = process.env[envName];
  return override ? [override, ...candidates.filter(candidate => candidate !== override)] : candidates;
}

function runForOutput(file, args) {
  return execFileSync(file, args, {
    encoding: 'utf8',
    timeout: INSPECT_TIMEOUT_MS,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore']
  });
}

// ---------------------------------------------------------------------------
// PHP
// ---------------------------------------------------------------------------

const PHP_INSPECT_CODE =
  "echo json_encode(['version' => PHP_VERSION, 'sapi' => PHP_SAPI, " +
  "'extensions' => array_map('strtolower', get_loaded_extensions())]);";

// Returns { exe, version, usable, reason }. `reason` explains why an existing
// PHP cannot be used.
function inspectPhp(exe) {
  let info;
  try {
    info = JSON.parse(runForOutput(exe, ['-r', PHP_INSPECT_CODE]));
  } catch (error) {
    return { exe, version: null, usable: false, reason: 'לא ניתן להריץ את PHP' };
  }

  const version = String(info.version).match(/^\d+\.\d+\.\d+/);
  const result = { exe, version: version ? version[0] : String(info.version), usable: false, reason: null };

  if (info.sapi !== 'cli') {
    result.reason = 'נדרש PHP בגרסת שורת הפקודה (CLI)';
  } else if (!version || compareVersions(result.version, MIN_VERSIONS.php) < 0) {
    result.reason = `נדרשת גרסה ${MIN_VERSIONS.php} ומעלה`;
  } else {
    const missing = REQUIRED_PHP_EXTENSIONS.filter(extension => !info.extensions.includes(extension));
    if (missing.length > 0) {
      result.reason = `חסרות הרחבות: ${missing.join(', ')}`;
    } else {
      result.usable = true;
    }
  }
  return result;
}

function phpCandidates() {
  return withOverride(ENV.php, findExecutables(['php'], [...pathDirs(), ...phpDirs()]));
}

// The first usable candidate, or the first unusable one (so the UI can say why).
function pickFirstUsable(candidates, inspect) {
  let rejected = null;
  for (const candidate of candidates) {
    const result = inspect(candidate);
    if (result.usable) {
      return result;
    }
    rejected = rejected || result;
  }
  return rejected;
}

function findSystemPhp(candidates) {
  if (candidates) {
    return pickFirstUsable(candidates, inspectPhp);
  }
  return cached('php', () => pickFirstUsable(phpCandidates(), inspectPhp));
}

// ---------------------------------------------------------------------------
// MariaDB / MySQL
// ---------------------------------------------------------------------------

// "mariadbd  Ver 10.11.14-MariaDB-0ubuntu0.24.04.1 for debian-linux-gnu ..."
// "/usr/sbin/mysqld  Ver 8.0.36 for Linux on x86_64 (MySQL Community Server - GPL)"
function parseDbServerVersion(output) {
  const match = /Ver\s+(\d+\.\d+\.\d+)(\S*)/i.exec(output);
  if (!match) {
    return null;
  }
  return { version: match[1], flavor: /mariadb/i.test(output) ? 'mariadb' : 'mysql' };
}

// The tool that creates a new data folder, looked up next to the server first.
function findDbInstaller(serverExe) {
  const serverDir = path.dirname(serverExe);
  const dirs = [serverDir, path.join(serverDir, '..', 'bin'), path.join(serverDir, '..', 'scripts'), ...pathDirs(), ...dbDirs()];
  return findExecutables(DB_INSTALL_NAMES, dirs)[0] || null;
}

// Returns { exe, installDb, version, flavor, usable, reason }.
function inspectDbServer(exe) {
  let parsed;
  try {
    parsed = parseDbServerVersion(runForOutput(exe, ['--version']));
  } catch (error) {
    parsed = null;
  }
  if (!parsed) {
    return { exe, installDb: null, version: null, flavor: null, usable: false, reason: 'לא ניתן להריץ את שרת מסד הנתונים' };
  }

  const result = { exe, installDb: null, ...parsed, usable: false, reason: null };
  const minimum = MIN_VERSIONS[parsed.flavor];
  if (compareVersions(parsed.version, minimum) < 0) {
    result.reason = `נדרשת גרסה ${minimum} ומעלה`;
    return result;
  }

  // MySQL creates its data folder with "mysqld --initialize-insecure";
  // MariaDB needs its separate install tool.
  result.installDb = findDbInstaller(exe);
  if (parsed.flavor === 'mariadb' && !result.installDb) {
    result.reason = 'לא נמצא הכלי mariadb-install-db';
    return result;
  }

  result.usable = true;
  return result;
}

function dbServerCandidates() {
  return withOverride(ENV.dbServer, findExecutables(DB_SERVER_NAMES, [...pathDirs(), ...dbDirs()]));
}

function findSystemDatabase(candidates) {
  if (candidates) {
    return pickFirstUsable(candidates, inspectDbServer);
  }
  return cached('database', () => pickFirstUsable(dbServerCandidates(), inspectDbServer));
}

// ---------------------------------------------------------------------------
// MediaWiki
// ---------------------------------------------------------------------------

// The oldest PHP a MediaWiki installation accepts, from its composer.json
// ("php": ">=8.1.0"), or null when it does not say.
function readMediaWikiMinPhp(dir) {
  try {
    const composer = JSON.parse(fs.readFileSync(path.join(dir, 'composer.json'), 'utf8'));
    const match = />=\s*(\d+(?:\.\d+){0,2})/.exec(String(composer.require && composer.require.php));
    return match ? match[1] : null;
  } catch (error) {
    return null;
  }
}

// Returns { dir, version, minPhp, usable, reason }.
function inspectMediaWiki(dir) {
  const result = { dir, version: null, minPhp: null, usable: false, reason: null };
  let defines;
  try {
    defines = fs.readFileSync(path.join(dir, 'includes', 'Defines.php'), 'utf8');
  } catch (error) {
    result.reason = 'התיקייה אינה מכילה התקנת MediaWiki';
    return result;
  }

  const match = /define\(\s*'MW_VERSION'\s*,\s*'(\d+\.\d+\.\d+)/.exec(defines);
  const complete =
    isFile(path.join(dir, 'index.php')) &&
    isFile(path.join(dir, 'maintenance', 'install.php')) &&
    isDirectory(path.join(dir, 'vendor'));
  if (!match || !complete) {
    result.reason = 'התקנת MediaWiki אינה שלמה';
    return result;
  }

  result.version = match[1];
  result.minPhp = readMediaWikiMinPhp(dir);
  if (compareVersions(result.version, MIN_VERSIONS.mediawiki) < 0) {
    result.reason = `נדרשת גרסה ${MIN_VERSIONS.mediawiki} ומעלה`;
    return result;
  }
  result.usable = true;
  return result;
}

function mediaWikiCandidates() {
  return withOverride(ENV.mediawiki, mediaWikiDirs().filter(isDirectory));
}

function findSystemMediaWiki(candidates) {
  if (candidates) {
    return pickFirstUsable(candidates, inspectMediaWiki);
  }
  return cached('mediawiki', () => pickFirstUsable(mediaWikiCandidates(), inspectMediaWiki));
}

module.exports = {
  ENV,
  MIN_VERSIONS,
  REQUIRED_PHP_EXTENSIONS,
  isEnabled,
  resetCache,
  compareVersions,
  parseDbServerVersion,
  findSystemPhp,
  findSystemDatabase,
  findSystemMediaWiki
};
