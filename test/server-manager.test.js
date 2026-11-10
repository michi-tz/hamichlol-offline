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

    it('should reject database users that are not plain identifiers', function() {
      expect(() => validateConfig({ ...validConfig, dbUser: "user'@'%" })).to.throw();
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
      const [host, port] = process.argv[process.argv.indexOf('-S') + 1].split(':');
      require('http').createServer((q, r) => r.end('db=' + process.env.HAMICHLOL_DB_PORT)).listen(+port, host);
    `);
    fs.writeFileSync(phpIni, '');
    writeScript(path.join(mariadbDir, 'bin', 'mariadbd.exe'), `
      const port = +process.argv.find(a => a.startsWith('--port=')).split('=')[1];
      require('net').createServer(s => s.end()).listen(port, '127.0.0.1');
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
    leftover = spawn(exe, ['--no-defaults', '--port=0'], { stdio: 'ignore' });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(isAlive(leftover.pid)).to.be.true;

    fs.writeFileSync(getPaths().runStateFile, JSON.stringify({
      mysql: { pid: leftover.pid, port: 1, exe }
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
      mysql: { pid: process.pid, port: 1, exe }
    }));

    await startServers();
    expect(isAlive(process.pid)).to.be.true;
    await stopServers();
  });
});
