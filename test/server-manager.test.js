const { describe, it, before, after } = require('mocha');
const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Set dev mode for testing (server-manager reads the flag at call time)
process.env.DEV_MODE = 'true';

const {
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

  describe('Server Downloads', function() {
    it('should download (simulate) server files', async function() {
      const result = await downloadServers();
      expect(result).to.be.true;

      const { phpDir, mysqlDir, mediaWikiPath } = getPaths();
      expect(fs.existsSync(phpDir)).to.be.true;
      expect(fs.existsSync(mysqlDir)).to.be.true;
      expect(fs.existsSync(path.join(mediaWikiPath, 'index.php'))).to.be.true;
      expect(getPaths().dataPath).to.equal(tempDir);
    });
  });

  describe('MediaWiki Installation', function() {
    it('should install (simulate) MediaWiki', async function() {
      const result = await installMediaWiki(validConfig);
      expect(result).to.be.true;

      const localSettings = path.join(getPaths().mediaWikiPath, 'LocalSettings.php');
      expect(fs.existsSync(localSettings)).to.be.true;
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

      expect(queries[0]).to.equal('CREATE DATABASE IF NOT EXISTS `wikidb`');
      expect(queries[1]).to.equal(
        "CREATE USER IF NOT EXISTS 'wikiuser'@'localhost' IDENTIFIED BY 'x\\'; DROP USER root; --'"
      );
      expect(queries[3]).to.equal("GRANT ALL PRIVILEGES ON `wikidb`.* TO 'wikiuser'@'localhost'");
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
    });

    it('should serve the mock site', async function() {
      const { phpPort } = await startServers();
      const response = await fetch(`http://127.0.0.1:${phpPort}/`);
      expect(response.status).to.equal(200);
    });

    it('should stop servers', async function() {
      const result = await stopServers();
      expect(result).to.be.true;
    });
  });
});
