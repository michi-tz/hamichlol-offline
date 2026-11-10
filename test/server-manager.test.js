const { describe, it, before, after } = require('mocha');
const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Set dev mode for testing (server-manager reads the flag at call time)
process.env.DEV_MODE = 'true';

const { DOWNLOADS } = require('../src/versions');
const {
  setDataPath,
  getPaths,
  getStatus,
  isDevMode,
  validateConfig,
  buildDatabaseSetupQueries,
  patchLocalSettings,
  downloadServers,
  installMediaWiki,
  startServers,
  stopServers
} = require('../src/server-manager');

const validConfig = {
  dbName: 'test_wiki',
  dbUser: 'test_user',
  dbPassword: 'test_password',
  wikiName: 'Test Wiki',
  adminUser: 'admin',
  adminPassword: 'admin-password-123'
};

describe('Hamichlol Offline Tests', function() {
  // Increase timeout for potentially slow operations
  this.timeout(10000);

  let tempDir;

  before(function() {
    // Work in a throwaway directory instead of the repository
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hamichlol-test-'));
    setDataPath(tempDir);
  });

  after(async function() {
    await stopServers();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Dev mode', function() {
    it('should be enabled even though the flag was set before require', function() {
      expect(isDevMode()).to.be.true;
    });
  });

  describe('Initial status', function() {
    it('should report nothing done on a fresh data folder', function() {
      const status = getStatus();
      expect(status.downloaded).to.be.false;
      expect(status.installed).to.be.false;
      expect(status.running).to.be.false;
    });

    it('should refuse to start servers before installation', async function() {
      let error = null;
      try {
        await startServers();
      } catch (e) {
        error = e;
      }
      expect(error).to.be.an('error');
    });
  });

  describe('Server Downloads', function() {
    it('should download (simulate) server files', async function() {
      const result = await downloadServers();
      expect(result).to.be.true;

      const { phpExe, mariadbDir, dbDataDir, mediaWikiPath } = getPaths();
      expect(fs.existsSync(phpExe)).to.be.true;
      expect(fs.existsSync(mariadbDir)).to.be.true;
      expect(fs.existsSync(path.join(dbDataDir, 'mysql'))).to.be.true;
      expect(fs.existsSync(path.join(mediaWikiPath, 'index.php'))).to.be.true;
      expect(getPaths().dataPath).to.equal(tempDir);
    });

    it('should install servers into versioned folders and keep the database separate', function() {
      const { phpDir, mariadbDir, dbDataDir } = getPaths();
      expect(path.basename(phpDir)).to.equal(`php-${DOWNLOADS.php.version}`);
      expect(path.basename(mariadbDir)).to.equal(`mariadb-${DOWNLOADS.mariadb.version}`);
      expect(dbDataDir.startsWith(mariadbDir)).to.be.false;
    });

    it('should report downloaded but not installed', function() {
      const status = getStatus();
      expect(status.downloaded).to.be.true;
      expect(status.installed).to.be.false;
    });
  });

  describe('MediaWiki Installation', function() {
    it('should install (simulate) MediaWiki', async function() {
      const result = await installMediaWiki(validConfig);
      expect(result).to.be.true;

      expect(fs.existsSync(getPaths().localSettings)).to.be.true;
      expect(getStatus().installed).to.be.true;
    });

    it('should refuse to install twice', async function() {
      let error = null;
      try {
        await installMediaWiki(validConfig);
      } catch (e) {
        error = e;
      }
      expect(error).to.be.an('error');
    });

    it('should keep the installed state after downloading again', async function() {
      await downloadServers();
      const status = getStatus();
      expect(status.downloaded).to.be.true;
      expect(status.installed).to.be.true;
    });

    it('should reject an invalid configuration', async function() {
      let error = null;
      try {
        await installMediaWiki({ ...validConfig, dbName: 'wiki; DROP DATABASE mysql' });
      } catch (e) {
        error = e;
      }
      expect(error).to.be.an('error');
    });
  });

  describe('Config validation', function() {
    it('should accept a valid configuration', function() {
      expect(validateConfig(validConfig)).to.deep.equal(validConfig);
    });

    it('should trim names', function() {
      const result = validateConfig({ ...validConfig, dbName: ' wikidb ', adminUser: ' admin ' });
      expect(result.dbName).to.equal('wikidb');
      expect(result.adminUser).to.equal('admin');
    });

    it('should reject database names that are not plain identifiers', function() {
      expect(() => validateConfig({ ...validConfig, dbName: 'wiki-db' })).to.throw();
      expect(() => validateConfig({ ...validConfig, dbName: 'wiki`; DROP DATABASE x; --' })).to.throw();
    });

    it('should reject the database server\'s own schema names', function() {
      for (const dbName of ['mysql', 'MySQL', 'information_schema', 'performance_schema', 'sys']) {
        expect(() => validateConfig({ ...validConfig, dbName }), dbName).to.throw();
      }
      expect(validateConfig({ ...validConfig, dbName: 'mysql_wiki' }).dbName).to.equal('mysql_wiki');
    });

    it('should reject database users that are not plain identifiers', function() {
      expect(() => validateConfig({ ...validConfig, dbUser: "user'@'%" })).to.throw();
    });

    it('should limit database user names to the 32 characters MySQL accepts', function() {
      expect(validateConfig({ ...validConfig, dbUser: 'u'.repeat(32) }).dbUser).to.have.lengthOf(32);
      expect(() => validateConfig({ ...validConfig, dbUser: 'u'.repeat(33) })).to.throw();
      expect(validateConfig({ ...validConfig, dbName: 'd'.repeat(64) }).dbName).to.have.lengthOf(64);
    });

    it('should reject missing fields', function() {
      expect(() => validateConfig({ ...validConfig, dbPassword: '' })).to.throw();
      expect(() => validateConfig({ ...validConfig, wikiName: undefined })).to.throw();
      expect(() => validateConfig(null)).to.throw();
    });

    it('should reject short admin passwords', function() {
      expect(() => validateConfig({ ...validConfig, adminPassword: 'admin123' })).to.throw();
    });
  });

  describe('Database setup SQL', function() {
    it('should escape passwords and quote identifiers', function() {
      const queries = buildDatabaseSetupQueries({
        dbName: 'wikidb',
        dbUser: 'wikiuser',
        dbPassword: "x'; DROP USER root; --"
      });

      expect(queries[0]).to.equal('DROP DATABASE IF EXISTS `wikidb`');
      expect(queries[1]).to.equal('CREATE DATABASE `wikidb`');
      expect(queries[2]).to.equal(
        "CREATE USER IF NOT EXISTS 'wikiuser'@'localhost' IDENTIFIED BY 'x\\'; DROP USER root; --'"
      );
      expect(queries[4]).to.equal("GRANT ALL PRIVILEGES ON `wikidb`.* TO 'wikiuser'@'localhost'");
    });
  });

  describe('LocalSettings.php patch', function() {
    it('should make the server URL and DB port independent of install-time ports', function() {
      const file = path.join(tempDir, 'LocalSettings.test.php');
      fs.writeFileSync(file, [
        '<?php',
        '$wgServer = "http://localhost:8080";',
        '$wgDBtype = "mysql";',
        '$wgDBserver = "127.0.0.1:3307";',
        ''
      ].join('\n'));

      patchLocalSettings(file);
      const content = fs.readFileSync(file, 'utf8');

      expect(content).to.include('$wgServer = WebRequest::detectServer();');
      expect(content).to.include("$wgDBserver = '127.0.0.1:' . ( getenv( 'HAMICHLOL_DB_PORT' ) ?: '3306' );");
      expect(content).to.include('$wgDBtype = "mysql";');
      expect(content).not.to.include('8080');
      expect(content).not.to.include('3307');
    });

    it('should fail loudly if a setting is missing', function() {
      const file = path.join(tempDir, 'LocalSettings.empty.php');
      fs.writeFileSync(file, '<?php\n');
      expect(() => patchLocalSettings(file)).to.throw();
    });
  });

  describe('Server Operations', function() {
    it('should start servers and return ports', async function() {
      const result = await startServers();

      expect(result).to.have.property('phpPort');
      expect(result).to.have.property('mysqlPort');
      expect(result.phpPort).to.be.a('number');
      expect(result.mysqlPort).to.be.a('number');
      expect(getStatus().running).to.be.true;
    });

    it('should serve the mock site', async function() {
      const { phpPort } = await startServers();
      const response = await fetch(`http://127.0.0.1:${phpPort}/`);
      expect(response.status).to.equal(200);
    });

    it('should stop servers', async function() {
      const result = await stopServers();
      expect(result).to.be.true;
      expect(getStatus().running).to.be.false;
    });
  });
});

describe('Download URLs', function() {
  for (const [name, { version, urls }] of Object.entries(DOWNLOADS)) {
    it(`should point every ${name} URL at version ${version}`, function() {
      expect(urls).to.not.be.empty;
      for (const url of urls) {
        expect(url).to.match(/^https:\/\//);
        expect(url).to.include(version);
        expect(url).to.match(/\.zip$/);
      }
    });
  }
});

// Real mode with fake executables (small Node scripts) instead of PHP/MariaDB.
// Relies on /proc to identify processes, so it only runs on Linux.
describe('Real mode with fake servers', function() {
  this.timeout(30000);

  let tempDir;
  let leftover;

  function writeScript(file, source) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `#!/usr/bin/env node\n${source}\n`);
    fs.chmodSync(file, 0o755);
  }

  function isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return false;
    }
  }

  before(function() {
    if (process.platform !== 'linux') {
      this.skip();
    }
    process.env.DEV_MODE = 'false';
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hamichlol-real-'));
    setDataPath(tempDir);

    const { phpExe, phpIni, mariadbDir, dbDataDir, mediaWikiPath, localSettings } = getPaths();
    writeScript(phpExe, `
      if (process.env.FAKE_PHP_FAILS) process.exit(1);
      const [host, port] = process.argv[process.argv.indexOf('-S') + 1].split(':');
      require('http').createServer((q, r) => r.end('db=' + process.env.HAMICHLOL_DB_PORT)).listen(+port, host);
    `);
    fs.writeFileSync(phpIni, '');
    writeScript(path.join(mariadbDir, 'bin', 'mariadbd.exe'), `
      const port = +process.argv.find(a => a.startsWith('--port=')).split('=')[1];
      if (process.env.FAKE_SERVER_NEVER_READY) {
        setInterval(() => {}, 1000);
      } else {
        require('net').createServer(s => s.end()).listen(port, '127.0.0.1');
      }
    `);
    // Graceful shutdown "fails", so the code falls back to killing the process
    writeScript(path.join(mariadbDir, 'bin', 'mariadb-admin.exe'), 'process.exit(1);');
    fs.mkdirSync(path.join(dbDataDir, 'mysql'), { recursive: true });
    fs.mkdirSync(mediaWikiPath, { recursive: true });
    fs.writeFileSync(path.join(mediaWikiPath, 'index.php'), '');
    fs.writeFileSync(localSettings, '');
  });

  after(async function() {
    if (leftover && isAlive(leftover.pid)) {
      leftover.kill();
    }
    if (tempDir) {
      await stopServers();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    process.env.DEV_MODE = 'true';
  });

  it('should resume as installed', function() {
    const status = getStatus();
    expect(status.downloaded).to.be.true;
    expect(status.installed).to.be.true;
    expect(status.running).to.be.false;
  });

  it('should stop a MariaDB left running by a crashed previous run', async function() {
    const exe = path.join(getPaths().mariadbDir, 'bin', 'mariadbd.exe');
    const marker = `--datadir=${getPaths().dbDataDir}`;
    leftover = spawn(exe, ['--no-defaults', marker, '--port=0'], { stdio: 'ignore' });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(isAlive(leftover.pid)).to.be.true;

    fs.writeFileSync(getPaths().runStateFile, JSON.stringify({
      mysql: { pid: leftover.pid, port: 1, exe, marker }
    }));

    const ports = await startServers();
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(isAlive(leftover.pid)).to.be.false;

    const response = await fetch(`http://127.0.0.1:${ports.phpPort}/`);
    expect(await response.text()).to.equal(`db=${ports.mysqlPort}`);

    const state = JSON.parse(fs.readFileSync(getPaths().runStateFile, 'utf8'));
    expect(state.mysql.port).to.equal(ports.mysqlPort);
    expect(state.php.port).to.equal(ports.phpPort);
  });

  it('should remove the run state after a clean stop', async function() {
    await stopServers();
    expect(fs.existsSync(getPaths().runStateFile)).to.be.false;
  });

  it('should never kill an unrelated process that reuses a saved PID', async function() {
    const exe = path.join(getPaths().mariadbDir, 'bin', 'mariadbd.exe');
    // This test process is alive but is not mariadbd, so it must be left alone
    fs.writeFileSync(getPaths().runStateFile, JSON.stringify({
      mysql: { pid: process.pid, port: 1, exe, marker: `--datadir=${getPaths().dbDataDir}` }
    }));

    await startServers();
    expect(isAlive(process.pid)).to.be.true;
    await stopServers();
  });

  it('should never kill another server that runs the same program with other data', async function() {
    const exe = path.join(getPaths().mariadbDir, 'bin', 'mariadbd.exe');
    // E.g. the computer's own database service, which got the saved PID after a reboot
    const other = spawn(exe, ['--no-defaults', '--datadir=/var/lib/mysql', '--port=0'], { stdio: 'ignore' });
    try {
      await new Promise(resolve => setTimeout(resolve, 300));
      fs.writeFileSync(getPaths().runStateFile, JSON.stringify({
        mysql: { pid: other.pid, port: 1, exe, marker: `--datadir=${getPaths().dbDataDir}` }
      }));

      await startServers();
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(isAlive(other.pid)).to.be.true;
      await stopServers();
    } finally {
      other.kill();
    }
  });

  it('should ignore saved entries that do not say which process was ours', async function() {
    const exe = path.join(getPaths().mariadbDir, 'bin', 'mariadbd.exe');
    const other = spawn(exe, ['--no-defaults', `--datadir=${getPaths().dbDataDir}`, '--port=0'], { stdio: 'ignore' });
    try {
      await new Promise(resolve => setTimeout(resolve, 300));
      fs.writeFileSync(getPaths().runStateFile, JSON.stringify({ mysql: { pid: other.pid, port: 1, exe } }));

      await startServers();
      expect(isAlive(other.pid)).to.be.true;
      await stopServers();
    } finally {
      other.kill();
    }
  });

  it('should stop the database again when PHP fails to start', async function() {
    process.env.FAKE_PHP_FAILS = '1';
    try {
      const error = await startServers().then(() => null, failure => failure);
      expect(error).to.be.an('error');
      expect(error.message).to.include('PHP');
      expect(getStatus().running).to.be.false;
      // Nothing is left running behind a UI that says "stopped"
      expect(fs.existsSync(getPaths().runStateFile)).to.be.false;
    } finally {
      delete process.env.FAKE_PHP_FAILS;
    }
    // And a later start works normally
    await startServers();
    expect(getStatus().running).to.be.true;
    await stopServers();
  });

  it('should stop a server that is still starting', async function() {
    process.env.FAKE_SERVER_NEVER_READY = '1';
    try {
      const starting = startServers().then(() => null, error => error);
      await new Promise(resolve => setTimeout(resolve, 600));

      // Saved already, so a crash at this point would not leave it behind either
      const state = JSON.parse(fs.readFileSync(getPaths().runStateFile, 'utf8'));
      expect(isAlive(state.mysql.pid)).to.be.true;
      expect(state.mysql.marker).to.equal(`--datadir=${getPaths().dbDataDir}`);

      await stopServers();
      expect(isAlive(state.mysql.pid)).to.be.false;
      expect(await starting).to.be.an('error');
      expect(getStatus().running).to.be.false;
      expect(fs.existsSync(getPaths().runStateFile)).to.be.false;
    } finally {
      delete process.env.FAKE_SERVER_NEVER_READY;
    }
  });

  it('should wait for the servers to exit before reporting them stopped', async function() {
    await startServers();
    const state = JSON.parse(fs.readFileSync(getPaths().runStateFile, 'utf8'));
    expect(state.mysql.marker).to.equal(`--datadir=${getPaths().dbDataDir}`);
    expect(state.php.marker).to.equal(getPaths().mediaWikiPath);

    await stopServers();
    expect(isAlive(state.mysql.pid)).to.be.false;
    expect(isAlive(state.php.pid)).to.be.false;
  });
});

// Detection of software that is already installed, using small shell scripts
// in place of the real programs.
describe('Installed software detection', function() {
  const systemTools = require('../src/system-tools');
  let tempDir;

  function writeScript(name, source) {
    const file = path.join(tempDir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `#!/bin/sh\n${source}\n`);
    fs.chmodSync(file, 0o755);
    return file;
  }

  function fakePhp(name, version, extensions, sapi = 'cli') {
    const info = JSON.stringify({ version, sapi, extensions });
    return writeScript(name, `echo '${info}'`);
  }

  function fakeMediaWiki(name, version) {
    const dir = path.join(tempDir, name);
    fs.mkdirSync(path.join(dir, 'includes'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'maintenance'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'vendor'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.php'), '');
    fs.writeFileSync(path.join(dir, 'maintenance', 'install.php'), '');
    fs.writeFileSync(path.join(dir, 'includes', 'Defines.php'), `<?php\ndefine( 'MW_VERSION', '${version}' );\n`);
    return dir;
  }

  before(function() {
    if (process.platform === 'win32') {
      this.skip();
    }
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hamichlol-system-'));
  });

  after(function() {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should compare versions numerically', function() {
    expect(systemTools.compareVersions('8.10.0', '8.9.9')).to.be.above(0);
    expect(systemTools.compareVersions('8.1.0', '8.1.0')).to.equal(0);
    expect(systemTools.compareVersions('7.4.33', '8.1.0')).to.be.below(0);
  });

  it('should recognise MariaDB and MySQL version output', function() {
    expect(systemTools.parseDbServerVersion(
      'mariadbd  Ver 10.11.14-MariaDB-0ubuntu0.24.04.1 for debian-linux-gnu on x86_64 (Ubuntu 24.04)'
    )).to.deep.equal({ version: '10.11.14', flavor: 'mariadb' });
    expect(systemTools.parseDbServerVersion(
      '/usr/sbin/mysqld  Ver 8.0.36 for Linux on x86_64 (MySQL Community Server - GPL)'
    )).to.deep.equal({ version: '8.0.36', flavor: 'mysql' });
    expect(systemTools.parseDbServerVersion('something else')).to.be.null;
  });

  it('should accept a PHP with a new enough version and all extensions', function() {
    const exe = fakePhp('php-good', '8.3.6-ubuntu', systemTools.REQUIRED_PHP_EXTENSIONS);
    expect(systemTools.findSystemPhp([exe])).to.deep.equal({ exe, version: '8.3.6', usable: true, reason: null });
  });

  it('should reject a PHP that is too old, and say why', function() {
    const result = systemTools.findSystemPhp([fakePhp('php-old', '7.4.33', systemTools.REQUIRED_PHP_EXTENSIONS)]);
    expect(result.usable).to.be.false;
    expect(result.reason).to.include(systemTools.MIN_VERSIONS.php);
  });

  it('should reject a PHP with missing extensions, and name them', function() {
    const extensions = systemTools.REQUIRED_PHP_EXTENSIONS.filter(name => name !== 'intl' && name !== 'mysqli');
    const result = systemTools.findSystemPhp([fakePhp('php-bare', '8.3.6', extensions)]);
    expect(result.usable).to.be.false;
    expect(result.reason).to.include('mysqli').and.to.include('intl');
  });

  it('should skip unusable candidates and files that are not PHP', function() {
    const broken = writeScript('php-broken', 'exit 1');
    const old = fakePhp('php-old2', '8.0.30', systemTools.REQUIRED_PHP_EXTENSIONS);
    const good = fakePhp('php-good2', '8.4.1', systemTools.REQUIRED_PHP_EXTENSIONS);
    expect(systemTools.findSystemPhp([broken, old, good]).exe).to.equal(good);
    expect(systemTools.findSystemPhp([]) ).to.be.null;
  });

  it('should accept a MariaDB server together with its install tool', function() {
    const exe = writeScript('maria/sbin/mariadbd', "echo 'mariadbd  Ver 11.4.2-MariaDB for Linux on x86_64'");
    const installDb = writeScript('maria/bin/mariadb-install-db', 'exit 0');
    const result = systemTools.findSystemDatabase([exe]);
    expect(result).to.include({ exe, version: '11.4.2', flavor: 'mariadb', usable: true });
    expect(fs.realpathSync(result.installDb)).to.equal(fs.realpathSync(installDb));
  });

  it('should reject a database server that is too old', function() {
    const exe = writeScript('oldmaria/bin/mariadbd', "echo 'mysqld  Ver 10.1.48-MariaDB for Linux'");
    const result = systemTools.findSystemDatabase([exe]);
    expect(result.usable).to.be.false;
    expect(result.reason).to.include(systemTools.MIN_VERSIONS.mariadb);
  });

  it('should accept MySQL, which needs no separate install tool', function() {
    const exe = writeScript('mysql/bin/mysqld', "echo 'mysqld  Ver 8.4.0 for Linux on x86_64 (MySQL Community Server - GPL)'");
    expect(systemTools.findSystemDatabase([exe])).to.include({ version: '8.4.0', flavor: 'mysql', usable: true });
  });

  it('should reject a MySQL too old to create its own data folder', function() {
    const exe = writeScript('oldmysql/bin/mysqld', "echo 'mysqld  Ver 5.7.5 for Linux on x86_64 (MySQL Community Server (GPL))'");
    const result = systemTools.findSystemDatabase([exe]);
    expect(result.usable).to.be.false;
    expect(result.reason).to.include(systemTools.MIN_VERSIONS.mysql);
  });

  it('should disable the MySQL X port in a way every MySQL version accepts', function() {
    const { dbServerArgs } = require('../src/server-manager');
    const args = (flavor, version) => dbServerArgs({ flavor, version }, 3306);
    // "loose" lets a MySQL without the X plugin ignore the option
    expect(args('mysql', '8.0.36')).to.include('--loose-mysqlx=OFF');
    expect(args('mysql', '5.7.44')).to.include('--loose-mysqlx=OFF');
    expect(args('mariadb', '11.4.2').join(' ')).to.not.include('mysqlx');
  });

  it('should accept a complete MediaWiki and reject old or incomplete ones', function() {
    const good = fakeMediaWiki('mw-good', '1.39.7');
    const old = fakeMediaWiki('mw-old', '1.35.14');
    const incomplete = fakeMediaWiki('mw-incomplete', '1.43.0');
    fs.rmSync(path.join(incomplete, 'vendor'), { recursive: true });

    expect(systemTools.findSystemMediaWiki([good])).to.deep.equal({
      dir: good, version: '1.39.7', minPhp: null, usable: true, reason: null
    });

    fs.writeFileSync(path.join(good, 'composer.json'), JSON.stringify({ require: { php: '>=7.4.3', 'ext-xml': '*' } }));
    expect(systemTools.findSystemMediaWiki([good]).minPhp).to.equal('7.4.3');
    expect(systemTools.findSystemMediaWiki([old]).usable).to.be.false;
    expect(systemTools.findSystemMediaWiki([incomplete]).usable).to.be.false;
    expect(systemTools.findSystemMediaWiki([path.join(tempDir, 'missing')]).usable).to.be.false;
    expect(systemTools.findSystemMediaWiki([old, good]).dir).to.equal(good);
  });

  it('should be switched off by HAMICHLOL_USE_SYSTEM=false', function() {
    expect(systemTools.isEnabled()).to.be.true;
    process.env.HAMICHLOL_USE_SYSTEM = 'false';
    try {
      expect(systemTools.isEnabled()).to.be.false;
    } finally {
      delete process.env.HAMICHLOL_USE_SYSTEM;
    }
  });
});

// Server manager behaviour when installed software is used. The programs are
// located through the HAMICHLOL_* variables, so nothing real is needed.
describe('Real mode with installed software', function() {
  const systemTools = require('../src/system-tools');
  this.timeout(30000);

  let tempDir;
  let dataDir;
  const savedEnv = {};

  function writeNodeScript(file, source) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `#!/usr/bin/env node\n${source}\n`);
    fs.chmodSync(file, 0o755);
    return file;
  }

  before(function() {
    if (process.platform !== 'linux') {
      this.skip();
    }
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hamichlol-installed-'));
    dataDir = path.join(tempDir, 'data');

    // Answers the inspection call, runs install.php and serves pages
    const php = writeNodeScript(path.join(tempDir, 'bin', 'php'), `
      const args = process.argv.slice(2);
      if (args[0] === '-r') {
        console.log(JSON.stringify({ version: '8.3.6', sapi: 'cli', extensions: ${JSON.stringify(systemTools.REQUIRED_PHP_EXTENSIONS)} }));
      } else if (args.includes('-c')) {
        process.exit(9); // an installed PHP must keep its own php.ini
      } else if (args.includes('-S')) {
        const [host, port] = args[args.indexOf('-S') + 1].split(':');
        require('http').createServer((q, r) => r.end('db=' + process.env.HAMICHLOL_DB_PORT)).listen(+port, host);
      }
    `);
    const mysqld = writeNodeScript(path.join(tempDir, 'sbin', 'mariadbd'), `
      const args = process.argv.slice(2);
      if (args.includes('--version')) {
        console.log('mariadbd  Ver 10.11.14-MariaDB for Linux on x86_64');
      } else {
        require('fs').writeFileSync(${JSON.stringify(path.join(tempDir, 'mariadbd-args.json'))}, JSON.stringify(args));
        const port = +args.find(a => a.startsWith('--port=')).split('=')[1];
        require('net').createServer(s => s.end()).listen(port, '127.0.0.1');
      }
    `);
    writeNodeScript(path.join(tempDir, 'bin', 'mariadb-install-db'), `
      const dir = process.argv.find(a => a.startsWith('--datadir=')).split('=')[1];
      require('fs').mkdirSync(require('path').join(dir, 'mysql'), { recursive: true });
    `);

    // An existing MediaWiki with its own wiki, which must not be carried over
    const mediawiki = path.join(tempDir, 'mediawiki');
    for (const dir of ['includes', 'maintenance', 'vendor', 'images', 'cache']) {
      fs.mkdirSync(path.join(mediawiki, dir), { recursive: true });
    }
    fs.writeFileSync(path.join(mediawiki, 'index.php'), 'existing');
    fs.writeFileSync(path.join(mediawiki, 'maintenance', 'install.php'), '');
    fs.writeFileSync(path.join(mediawiki, 'includes', 'Defines.php'), "<?php\ndefine( 'MW_VERSION', '1.39.7' );\n");
    fs.writeFileSync(path.join(mediawiki, 'LocalSettings.php'), 'secret');
    fs.writeFileSync(path.join(mediawiki, 'images', 'upload.png'), 'x');
    fs.symlinkSync(path.join(mediawiki, 'includes'), path.join(mediawiki, 'linked'));

    for (const name of Object.values(systemTools.ENV)) {
      savedEnv[name] = process.env[name];
    }
    process.env[systemTools.ENV.php] = php;
    process.env[systemTools.ENV.dbServer] = mysqld;
    process.env[systemTools.ENV.mediawiki] = mediawiki;
    delete process.env[systemTools.ENV.enabled];
    process.env.DEV_MODE = 'false';
    systemTools.resetCache();
    setDataPath(dataDir);
  });

  after(async function() {
    if (!tempDir) {
      return;
    }
    await stopServers();
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    process.env.DEV_MODE = 'true';
    systemTools.resetCache();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should report the installed software before anything is set up', function() {
    const status = getStatus();
    expect(status.downloaded).to.be.false;
    expect(status.tools.php).to.include({ source: 'system', version: '8.3.6', path: process.env[systemTools.ENV.php] });
    expect(status.tools.database).to.include({ source: 'system', version: '10.11.14', flavor: 'mariadb' });
    expect(status.tools.mediawiki).to.include({ source: 'system', version: '1.39.7' });
  });

  it('should set up without downloading PHP or the database server', async function() {
    await downloadServers();

    const paths = getPaths();
    expect(fs.existsSync(paths.phpDir)).to.be.false;
    expect(fs.existsSync(paths.mariadbDir)).to.be.false;
    expect(fs.existsSync(path.join(paths.dbDataDir, 'mysql'))).to.be.true;

    const status = getStatus();
    expect(status.downloaded).to.be.true;
    expect(status.tools.mediawiki).to.include({ source: 'installed', version: '1.39.7' });
  });

  it('should copy MediaWiki without the existing wiki and without touching it', function() {
    const { mediaWikiPath } = getPaths();
    const source = process.env[systemTools.ENV.mediawiki];

    expect(fs.readFileSync(path.join(mediaWikiPath, 'index.php'), 'utf8')).to.equal('existing');
    expect(fs.existsSync(path.join(mediaWikiPath, 'LocalSettings.php'))).to.be.false;
    expect(fs.readdirSync(path.join(mediaWikiPath, 'images'))).to.deep.equal([]);
    // Symlinks are copied as real folders, so the copy does not depend on the original
    expect(fs.lstatSync(path.join(mediaWikiPath, 'linked')).isSymbolicLink()).to.be.false;
    expect(fs.existsSync(path.join(mediaWikiPath, 'linked', 'Defines.php'))).to.be.true;

    expect(fs.readFileSync(path.join(source, 'LocalSettings.php'), 'utf8')).to.equal('secret');
    expect(fs.existsSync(path.join(source, 'images', 'upload.png'))).to.be.true;
  });

  it('should run the installed servers with their own data, port and socket', async function() {
    fs.writeFileSync(getPaths().localSettings, '');
    const ports = await startServers();

    const response = await fetch(`http://127.0.0.1:${ports.phpPort}/`);
    expect(await response.text()).to.equal(`db=${ports.mysqlPort}`);

    const args = JSON.parse(fs.readFileSync(path.join(tempDir, 'mariadbd-args.json'), 'utf8'));
    expect(args[0]).to.equal('--no-defaults');
    expect(args).to.include(`--datadir=${getPaths().dbDataDir}`);
    expect(args).to.include(`--port=${ports.mysqlPort}`);
    expect(args).to.include('--bind-address=127.0.0.1');
    expect(args.some(arg => arg.startsWith('--socket='))).to.be.true;

    const state = JSON.parse(fs.readFileSync(getPaths().runStateFile, 'utf8'));
    expect(state.mysql.exe).to.equal(process.env[systemTools.ENV.dbServer]);
    expect(state.php.exe).to.equal(process.env[systemTools.ENV.php]);

    await stopServers();
    expect(getStatus().running).to.be.false;
  });

  it('should not use an installed MediaWiki that needs a newer PHP', function() {
    const source = process.env[systemTools.ENV.mediawiki];
    const copy = getPaths().mediaWikiPath;
    const hidden = `${copy}.hidden`;
    fs.renameSync(copy, hidden);
    fs.writeFileSync(path.join(source, 'composer.json'), JSON.stringify({ require: { php: '>=8.4.0' } }));
    systemTools.resetCache();
    try {
      const { mediawiki } = getStatus().tools;
      expect(mediawiki.source).to.equal('download');
      expect(mediawiki.version).to.equal(DOWNLOADS.mediawiki.version);
      expect(mediawiki.problem).to.include('8.4.0');

      fs.writeFileSync(path.join(source, 'composer.json'), JSON.stringify({ require: { php: '>=8.1.0' } }));
      systemTools.resetCache();
      expect(getStatus().tools.mediawiki.source).to.equal('system');
    } finally {
      fs.rmSync(path.join(source, 'composer.json'));
      fs.renameSync(hidden, copy);
      systemTools.resetCache();
    }
  });

  it('should ignore installed software when it is switched off', function() {
    process.env[systemTools.ENV.enabled] = 'false';
    try {
      const status = getStatus();
      expect(status.tools.php.source).to.be.null;
      expect(status.tools.database.source).to.be.null;
      expect(status.downloaded).to.be.false;
    } finally {
      delete process.env[systemTools.ENV.enabled];
    }
  });

  it('should explain what is missing where nothing can be downloaded', async function() {
    process.env[systemTools.ENV.enabled] = 'false';
    try {
      await downloadServers();
      expect.fail('should have thrown');
    } catch (error) {
      expect(error.message).to.include('PHP').and.to.include('Windows');
    } finally {
      delete process.env[systemTools.ENV.enabled];
    }
  });
});
