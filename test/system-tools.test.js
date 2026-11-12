// How installed software is located: search order, explicit paths, caching and
// the details of version parsing. (Whether a found program is acceptable is
// covered in server-manager.test.js.)

const { describe, it, before, beforeEach, afterEach } = require('mocha');
const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const {
  FAKE_PHP,
  FAKE_DB_SERVER,
  CAN_RUN_FAKE_PROGRAMS,
  makeTempDir,
  removeDir,
  installFakeProgram,
  setEnv
} = require('./helpers');
const systemTools = require('../src/system-tools');

// The fake programs are started through "#!/usr/bin/env node", so a PATH
// built for a test still has to contain the folder of the node binary.
const NODE_DIR = path.dirname(process.execPath);

describe('Locating installed software', function() {
  let tempDir;
  let restoreEnv;

  function fakeMediaWiki(name, version, composer) {
    const dir = path.join(tempDir, name);
    for (const sub of ['includes', 'maintenance', 'vendor']) {
      fs.mkdirSync(path.join(dir, sub), { recursive: true });
    }
    fs.writeFileSync(path.join(dir, 'index.php'), '');
    fs.writeFileSync(path.join(dir, 'maintenance', 'install.php'), '');
    fs.writeFileSync(path.join(dir, 'includes', 'Defines.php'), `<?php\ndefine( 'MW_VERSION', '${version}' );\n`);
    if (composer !== undefined) {
      fs.writeFileSync(path.join(dir, 'composer.json'), composer);
    }
    return dir;
  }

  beforeEach(function() {
    tempDir = makeTempDir('locate');
    restoreEnv = setEnv({
      PATH: process.env.PATH,
      HAMICHLOL_USE_SYSTEM: undefined,
      HAMICHLOL_PHP: undefined,
      HAMICHLOL_MYSQLD: undefined,
      HAMICHLOL_MEDIAWIKI_DIR: undefined,
      FAKE_PHP_VERSION: undefined,
      FAKE_PHP_SAPI: undefined,
      FAKE_PHP_EXTENSIONS: undefined,
      FAKE_DB_VERSION: undefined
    });
    systemTools.resetCache();
  });

  afterEach(function() {
    restoreEnv();
    systemTools.resetCache();
    removeDir(tempDir);
  });

  describe('Version comparison', function() {
    it('should compare each part as a number', function() {
      expect(systemTools.compareVersions('10.0.0', '9.9.9')).to.be.above(0);
      expect(systemTools.compareVersions('8.3.10', '8.3.9')).to.be.above(0);
      expect(systemTools.compareVersions('8.3.6', '8.3.36')).to.be.below(0);
    });

    it('should treat missing parts as zero', function() {
      expect(systemTools.compareVersions('8.1', '8.1.0')).to.equal(0);
      expect(systemTools.compareVersions('8', '8.0.1')).to.be.below(0);
      expect(systemTools.compareVersions('8.2', '8.1.99')).to.be.above(0);
    });
  });

  describe('Database server version output', function() {
    const parse = systemTools.parseDbServerVersion;

    it('should recognise MariaDB builds from different distributions', function() {
      expect(parse('mysqld  Ver 10.3.39-MariaDB-0+deb10u1 for debian-linux-gnu on x86_64 (Debian 10)'))
        .to.deep.equal({ version: '10.3.39', flavor: 'mariadb' });
      expect(parse('C:\\xampp\\mysql\\bin\\mysqld.exe  Ver 10.4.32-MariaDB for Win64 on AMD64 (mariadb.org binary distribution)'))
        .to.deep.equal({ version: '10.4.32', flavor: 'mariadb' });
      expect(parse('mariadbd  Ver 11.8.2-MariaDB for osx10.20 on arm64 (Homebrew)'))
        .to.deep.equal({ version: '11.8.2', flavor: 'mariadb' });
    });

    it('should recognise MySQL builds', function() {
      expect(parse('mysqld  Ver 5.7.44 for Linux on x86_64 (MySQL Community Server (GPL))'))
        .to.deep.equal({ version: '5.7.44', flavor: 'mysql' });
      expect(parse('C:\\Program Files\\MySQL\\MySQL Server 8.4\\bin\\mysqld.exe  Ver 8.4.3 for Win64 on x86_64 (MySQL Community Server - GPL)'))
        .to.deep.equal({ version: '8.4.3', flavor: 'mysql' });
      expect(parse('/usr/sbin/mysqld  Ver 8.0.36-0ubuntu0.22.04.1 for Linux on x86_64 ((Ubuntu))'))
        .to.deep.equal({ version: '8.0.36', flavor: 'mysql' });
    });

    it('should return null for anything else', function() {
      expect(parse('')).to.be.null;
      expect(parse('command not found')).to.be.null;
      expect(parse('Ver unknown')).to.be.null;
    });
  });

  describe('Switching the feature off', function() {
    it('should be on by default and for unrelated values', function() {
      for (const value of [undefined, '', 'true', '1', 'yes']) {
        const restore = setEnv({ HAMICHLOL_USE_SYSTEM: value });
        expect(systemTools.isEnabled(), String(value)).to.be.true;
        restore();
      }
    });

    it('should be off for false, 0, no and off in any letter case', function() {
      for (const value of ['false', 'FALSE', '0', 'no', 'No', 'off']) {
        const restore = setEnv({ HAMICHLOL_USE_SYSTEM: value });
        expect(systemTools.isEnabled(), value).to.be.false;
        restore();
      }
    });
  });

  describe('PHP', function() {
    before(function() {
      if (!CAN_RUN_FAKE_PROGRAMS) {
        this.skip();
      }
    });

    it('should prefer the PHP that comes first on PATH', function() {
      const first = installFakeProgram(path.join(tempDir, 'first', 'php'), FAKE_PHP);
      installFakeProgram(path.join(tempDir, 'second', 'php'), FAKE_PHP);
      process.env.PATH = [path.join(tempDir, 'first'), path.join(tempDir, 'second'), process.env.PATH].join(path.delimiter);
      process.env.FAKE_PHP_VERSION = '8.2.99';

      expect(systemTools.findSystemPhp()).to.include({ exe: first, version: '8.2.99', usable: true });
    });

    it('should prefer an explicitly configured PHP over PATH', function() {
      installFakeProgram(path.join(tempDir, 'onpath', 'php'), FAKE_PHP);
      const explicit = installFakeProgram(path.join(tempDir, 'elsewhere', 'my-php'), FAKE_PHP);
      process.env.PATH = [path.join(tempDir, 'onpath'), process.env.PATH].join(path.delimiter);
      process.env.HAMICHLOL_PHP = explicit;

      expect(systemTools.findSystemPhp().exe).to.equal(explicit);
    });

    it('should fall back to PATH when the configured PHP does not exist', function() {
      const onPath = installFakeProgram(path.join(tempDir, 'onpath', 'php'), FAKE_PHP);
      process.env.PATH = [path.join(tempDir, 'onpath'), process.env.PATH].join(path.delimiter);
      process.env.HAMICHLOL_PHP = path.join(tempDir, 'missing', 'php');

      expect(systemTools.findSystemPhp().exe).to.equal(onPath);
    });

    it('should skip an unusable PHP in favour of a usable one further down', function() {
      const old = path.join(tempDir, 'old');
      const good = path.join(tempDir, 'good');
      fs.mkdirSync(old);
      fs.writeFileSync(path.join(old, 'php'), '#!/bin/sh\necho \'{"version":"7.4.33","sapi":"cli","extensions":[]}\'\n', { mode: 0o755 });
      const usable = installFakeProgram(path.join(good, 'php'), FAKE_PHP);
      process.env.PATH = [old, good, NODE_DIR].join(path.delimiter);
      process.env.HAMICHLOL_PHP = path.join(old, 'php');

      expect(systemTools.findSystemPhp()).to.include({ exe: usable, usable: true });
    });

    it('should ignore folders and non-existent PATH entries', function() {
      fs.mkdirSync(path.join(tempDir, 'dir', 'php'), { recursive: true }); // a folder called "php"
      const real = installFakeProgram(path.join(tempDir, 'real', 'php'), FAKE_PHP);
      process.env.PATH = [path.join(tempDir, 'dir'), path.join(tempDir, 'nowhere'), '', path.join(tempDir, 'real'), NODE_DIR]
        .join(path.delimiter);

      expect(systemTools.findSystemPhp().exe).to.equal(real);
    });

    it('should reject the CGI build, which cannot run the installer or the web server', function() {
      const exe = installFakeProgram(path.join(tempDir, 'php-cgi'), FAKE_PHP);
      process.env.FAKE_PHP_SAPI = 'cgi-fcgi';

      const result = systemTools.findSystemPhp([exe]);
      expect(result).to.include({ usable: false, version: '8.3.6' });
      expect(result.reason).to.include('CLI');
    });

    it('should accept the oldest supported version and reject the one before it', function() {
      const exe = installFakeProgram(path.join(tempDir, 'php'), FAKE_PHP);

      process.env.FAKE_PHP_VERSION = systemTools.MIN_VERSIONS.php;
      expect(systemTools.findSystemPhp([exe]).usable).to.be.true;

      process.env.FAKE_PHP_VERSION = '8.0.30';
      expect(systemTools.findSystemPhp([exe]).usable).to.be.false;
    });

    it('should read the version from distribution-specific version strings', function() {
      const exe = installFakeProgram(path.join(tempDir, 'php'), FAKE_PHP);
      process.env.FAKE_PHP_VERSION = '8.3.6-0ubuntu0.24.04.5';

      expect(systemTools.findSystemPhp([exe])).to.include({ version: '8.3.6', usable: true });
    });

    it('should name each missing extension', function() {
      const exe = installFakeProgram(path.join(tempDir, 'php'), FAKE_PHP);

      for (const missing of systemTools.REQUIRED_PHP_EXTENSIONS) {
        process.env.FAKE_PHP_EXTENSIONS = systemTools.REQUIRED_PHP_EXTENSIONS.filter(name => name !== missing).join(',');
        const result = systemTools.findSystemPhp([exe]);
        expect(result.usable, missing).to.be.false;
        expect(result.reason, missing).to.include(missing);
      }
    });

    it('should not require optional extensions such as gd', function() {
      const exe = installFakeProgram(path.join(tempDir, 'php'), FAKE_PHP);
      process.env.FAKE_PHP_EXTENSIONS = systemTools.REQUIRED_PHP_EXTENSIONS.join(',');

      expect(systemTools.REQUIRED_PHP_EXTENSIONS).to.not.include('gd');
      expect(systemTools.findSystemPhp([exe]).usable).to.be.true;
    });

    it('should report a program that prints something other than the expected answer', function() {
      const exe = path.join(tempDir, 'php');
      fs.writeFileSync(exe, '#!/bin/sh\necho "PHP Warning: something"\n', { mode: 0o755 });

      const result = systemTools.findSystemPhp([exe]);
      expect(result).to.include({ exe, usable: false, version: null });
      expect(result.reason).to.be.a('string');
    });

    it('should report a file that cannot be executed', function() {
      const exe = path.join(tempDir, 'php');
      fs.writeFileSync(exe, 'not a program', { mode: 0o644 });

      expect(systemTools.findSystemPhp([exe])).to.include({ usable: false, version: null });
    });

    it('should remember the result until the cache is reset', function() {
      const dir = path.join(tempDir, 'bin');
      const exe = installFakeProgram(path.join(dir, 'php'), FAKE_PHP);
      process.env.PATH = [dir, process.env.PATH].join(path.delimiter);
      process.env.FAKE_PHP_VERSION = '8.2.1';

      expect(systemTools.findSystemPhp()).to.include({ exe, version: '8.2.1' });

      // The installation changes, but the cached answer is returned...
      process.env.FAKE_PHP_VERSION = '8.4.2';
      expect(systemTools.findSystemPhp().version).to.equal('8.2.1');

      // ...until the cache is reset
      systemTools.resetCache();
      expect(systemTools.findSystemPhp().version).to.equal('8.4.2');
    });

    it('should not cache or be influenced by lookups with explicit candidates', function() {
      const dir = path.join(tempDir, 'bin');
      const onPath = installFakeProgram(path.join(dir, 'php'), FAKE_PHP);
      const other = installFakeProgram(path.join(tempDir, 'other', 'php'), FAKE_PHP);
      process.env.PATH = [dir, process.env.PATH].join(path.delimiter);

      expect(systemTools.findSystemPhp([other]).exe).to.equal(other);
      expect(systemTools.findSystemPhp().exe).to.equal(onPath);
      expect(systemTools.findSystemPhp([other]).exe).to.equal(other);
    });
  });

  describe('Database server', function() {
    before(function() {
      if (!CAN_RUN_FAKE_PROGRAMS) {
        this.skip();
      }
    });

    function installServer(dir, name = 'mariadbd') {
      return installFakeProgram(path.join(tempDir, dir, name), FAKE_DB_SERVER);
    }

    it('should prefer mariadbd over mysqld in the same folder', function() {
      installServer('bin', 'mysqld');
      const mariadbd = installServer('bin', 'mariadbd');
      installServer('bin', 'mariadb-install-db');
      process.env.PATH = [path.join(tempDir, 'bin'), process.env.PATH].join(path.delimiter);

      expect(systemTools.findSystemDatabase().exe).to.equal(mariadbd);
    });

    it('should count a symlink and its target as one installation', function() {
      const mariadbd = installServer('bin', 'mariadbd');
      fs.symlinkSync(mariadbd, path.join(tempDir, 'bin', 'mysqld'));
      installServer('bin', 'mariadb-install-db');
      process.env.FAKE_DB_VERSION = 'mariadbd  Ver 10.1.0-MariaDB'; // too old: the next candidate is tried

      const result = systemTools.findSystemDatabase([mariadbd, path.join(tempDir, 'bin', 'mysqld')]);
      expect(result).to.include({ exe: mariadbd, usable: false });
    });

    it('should use an explicitly configured server', function() {
      const explicit = installServer('custom/sbin', 'mariadbd');
      installServer('custom/bin', 'mariadb-install-db');
      process.env.HAMICHLOL_MYSQLD = explicit;

      expect(systemTools.findSystemDatabase()).to.include({ exe: explicit, usable: true });
    });

    it('should find the install tool next to the server', function() {
      const exe = installServer('same', 'mariadbd');
      const tool = installServer('same', 'mariadb-install-db');

      expect(systemTools.findSystemDatabase([exe]).installDb).to.equal(tool);
    });

    it('should find the install tool in a sibling bin or scripts folder', function() {
      const withBin = installServer('a/sbin', 'mariadbd');
      const inBin = installServer('a/bin', 'mysql_install_db');
      const withScripts = installServer('b/bin', 'mariadbd');
      const inScripts = installServer('b/scripts', 'mariadb-install-db');

      expect(fs.realpathSync(systemTools.findSystemDatabase([withBin]).installDb)).to.equal(inBin);
      expect(fs.realpathSync(systemTools.findSystemDatabase([withScripts]).installDb)).to.equal(inScripts);
    });

    it('should prefer the new tool name over the legacy one', function() {
      const exe = installServer('bin', 'mariadbd');
      installServer('bin', 'mysql_install_db');
      const modern = installServer('bin', 'mariadb-install-db');

      expect(systemTools.findSystemDatabase([exe]).installDb).to.equal(modern);
    });

    it('should accept the oldest supported MariaDB and MySQL and reject older ones', function() {
      const exe = installServer('bin', 'mariadbd');
      installServer('bin', 'mariadb-install-db');
      const usable = version => {
        process.env.FAKE_DB_VERSION = version;
        return systemTools.findSystemDatabase([exe]).usable;
      };

      expect(usable(`mariadbd  Ver ${systemTools.MIN_VERSIONS.mariadb}-MariaDB`)).to.be.true;
      expect(usable('mariadbd  Ver 10.2.44-MariaDB')).to.be.false;
      expect(usable(`mysqld  Ver ${systemTools.MIN_VERSIONS.mysql} for Linux (MySQL Community Server)`)).to.be.true;
      expect(usable('mysqld  Ver 5.6.51 for Linux (MySQL Community Server)')).to.be.false;
    });

    it('should report a program whose version cannot be read', function() {
      const exe = installServer('bin', 'mariadbd');
      process.env.FAKE_DB_VERSION = 'unexpected output';

      const result = systemTools.findSystemDatabase([exe]);
      expect(result).to.include({ exe, usable: false, version: null, flavor: null });
      expect(result.reason).to.be.a('string');
    });
  });

  describe('MediaWiki', function() {
    it('should use the explicitly configured folder', function() {
      const dir = fakeMediaWiki('wiki', '1.43.1');
      process.env.HAMICHLOL_MEDIAWIKI_DIR = dir;

      expect(systemTools.findSystemMediaWiki()).to.include({ dir, version: '1.43.1', usable: true });
    });

    it('should read the PHP requirement in the forms composer.json uses', function() {
      const minPhp = composer => systemTools.findSystemMediaWiki([fakeMediaWiki(`w${Math.random()}`, '1.43.0', composer)]).minPhp;

      expect(minPhp('{"require":{"php":">=8.1.0"}}')).to.equal('8.1.0');
      expect(minPhp('{"require":{"php":">= 8.2"}}')).to.equal('8.2');
      expect(minPhp('{"require":{"php":">=7.4.3 <8.4"}}')).to.equal('7.4.3');
    });

    it('should carry on without a PHP requirement when composer.json is missing or unusable', function() {
      const minPhp = composer => systemTools.findSystemMediaWiki([fakeMediaWiki(`w${Math.random()}`, '1.43.0', composer)]);

      expect(minPhp(undefined)).to.include({ minPhp: null, usable: true });
      expect(minPhp('{ not json')).to.include({ minPhp: null, usable: true });
      expect(minPhp('{"require":{}}')).to.include({ minPhp: null, usable: true });
      expect(minPhp('{"require":{"php":"^8.1"}}')).to.include({ minPhp: null, usable: true });
      expect(minPhp('{}')).to.include({ minPhp: null, usable: true });
    });

    it('should accept the oldest supported version and reject the one before it', function() {
      expect(systemTools.findSystemMediaWiki([fakeMediaWiki('min', systemTools.MIN_VERSIONS.mediawiki)]).usable).to.be.true;
      const old = systemTools.findSystemMediaWiki([fakeMediaWiki('old', '1.38.7')]);
      expect(old).to.include({ usable: false, version: '1.38.7' });
      expect(old.reason).to.include(systemTools.MIN_VERSIONS.mediawiki);
    });

    it('should read pre-release versions', function() {
      expect(systemTools.findSystemMediaWiki([fakeMediaWiki('rc', '1.44.0-rc.0')])).to.include({ version: '1.44.0', usable: true });
      expect(systemTools.findSystemMediaWiki([fakeMediaWiki('alpha', '1.45.0-alpha')])).to.include({ version: '1.45.0', usable: true });
    });

    it('should reject a source checkout without installed dependencies', function() {
      const dir = fakeMediaWiki('git', '1.43.0');
      fs.rmSync(path.join(dir, 'vendor'), { recursive: true });

      expect(systemTools.findSystemMediaWiki([dir])).to.include({ usable: false });
    });

    it('should reject a folder whose Defines.php has no version', function() {
      const dir = fakeMediaWiki('odd', '1.43.0');
      fs.writeFileSync(path.join(dir, 'includes', 'Defines.php'), '<?php // nothing here');

      expect(systemTools.findSystemMediaWiki([dir])).to.include({ usable: false, version: null });
    });

    it('should return null when there is nothing to look at', function() {
      expect(systemTools.findSystemMediaWiki([])).to.be.null;
    });

    it('should remember the result until the cache is reset', function() {
      const dir = fakeMediaWiki('wiki', '1.43.1');
      process.env.HAMICHLOL_MEDIAWIKI_DIR = dir;
      expect(systemTools.findSystemMediaWiki().version).to.equal('1.43.1');

      fs.writeFileSync(path.join(dir, 'includes', 'Defines.php'), "<?php\ndefine( 'MW_VERSION', '1.43.9' );\n");
      expect(systemTools.findSystemMediaWiki().version).to.equal('1.43.1');

      systemTools.resetCache();
      expect(systemTools.findSystemMediaWiki().version).to.equal('1.43.9');
    });
  });
});
