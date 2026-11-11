// The real (non-dev) installation and server lifecycle, end to end, with fake
// programs in place of PHP and MariaDB. The fake database speaks the MySQL
// protocol, so the app's own connection code, SQL and shutdown are exercised.

const { describe, it, before, after, beforeEach, afterEach } = require('mocha');
const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const {
  FAKE_PHP,
  FAKE_DB_SERVER,
  CAN_RUN_FAKE_PROGRAMS,
  VALID_CONFIG,
  makeTempDir,
  removeDir,
  installFakeProgram,
  isAlive,
  waitFor,
  readJson,
  readLines,
  occupyPort,
  closeServer,
  setEnv
} = require('./helpers');
const serverManager = require('../src/server-manager');

const { setDataPath, getPaths, getStatus, installMediaWiki, startServers, stopServers } = serverManager;

describe('Real installation flow with fake servers', function() {
  this.timeout(30000);

  let tempDir;
  let restoreEnv;

  const queriesLog = () => path.join(getPaths().dbDataDir, 'queries.log');
  const queries = () => readLines(queriesLog());
  const installArgs = () => readJson(path.join(getPaths().mediaWikiPath, 'install-args.json'));

  // A data folder that looks like the servers were downloaded: PHP, MariaDB and
  // MediaWiki in place, database initialised, MediaWiki not installed yet.
  function createDownloadedLayout() {
    const paths = getPaths();
    installFakeProgram(paths.phpExe, FAKE_PHP);
    fs.writeFileSync(paths.phpIni, '');
    installFakeProgram(path.join(paths.mariadbDir, 'bin', 'mariadbd.exe'), FAKE_DB_SERVER);
    installFakeProgram(path.join(paths.mariadbDir, 'bin', 'mariadb-install-db.exe'), FAKE_DB_SERVER);
    fs.mkdirSync(path.join(paths.dbDataDir, 'mysql'), { recursive: true });
    fs.mkdirSync(path.join(paths.mediaWikiPath, 'maintenance'), { recursive: true });
    fs.writeFileSync(path.join(paths.mediaWikiPath, 'index.php'), '');
    fs.writeFileSync(path.join(paths.mediaWikiPath, 'maintenance', 'install.php'), '');
  }

  before(function() {
    if (!CAN_RUN_FAKE_PROGRAMS) {
      this.skip();
    }
  });

  beforeEach(function() {
    restoreEnv = setEnv({ DEV_MODE: 'false', HAMICHLOL_USE_SYSTEM: 'false' });
    tempDir = makeTempDir('flow');
    setDataPath(tempDir);
    createDownloadedLayout();
  });

  afterEach(async function() {
    await stopServers();
    restoreEnv();
    removeDir(tempDir);
  });

  after(function() {
    process.env.DEV_MODE = 'true';
  });

  describe('Installing MediaWiki', function() {
    it('should start from "downloaded but not installed"', function() {
      expect(getStatus()).to.include({ downloaded: true, installed: false, running: false });
    });

    it('should create the database and user before running the installer', async function() {
      await installMediaWiki(VALID_CONFIG);

      const setup = queries().filter(sql => sql !== 'SHUTDOWN');
      expect(setup).to.deep.equal([
        'DROP DATABASE IF EXISTS `test_wiki`',
        'CREATE DATABASE `test_wiki`',
        "CREATE USER IF NOT EXISTS 'test_user'@'localhost' IDENTIFIED BY 'test_password'",
        "ALTER USER 'test_user'@'localhost' IDENTIFIED BY 'test_password'",
        "GRANT ALL PRIVILEGES ON `test_wiki`.* TO 'test_user'@'localhost'"
      ]);
    });

    it('should pass every setting to install.php as its own argument', async function() {
      const config = {
        ...VALID_CONFIG,
        dbPassword: `p' w"x; $(touch ${path.join(tempDir, 'injected')}) \`id\``,
        wikiName: 'המכלול אופליין & "more"',
        adminUser: 'Wiki Admin',
        adminPassword: 'pass word; rm -rf "$HOME"'
      };
      await installMediaWiki(config);

      const args = installArgs();
      const paths = getPaths();
      expect(args.slice(0, 3)).to.deep.equal([
        '-c', paths.phpIni, path.join(paths.mediaWikiPath, 'maintenance', 'install.php')
      ]);
      expect(args).to.include('--dbtype=mysql');
      expect(args).to.include('--dbname=test_wiki');
      expect(args).to.include('--dbuser=test_user');
      expect(args).to.include(`--dbpass=${config.dbPassword}`);
      expect(args).to.include(`--installdbpass=${config.dbPassword}`);
      expect(args).to.include(`--pass=${config.adminPassword}`);
      expect(args).to.include('--scriptpath=');
      // The site name and the administrator come last, each as one argument
      expect(args.slice(-2)).to.deep.equal([config.wikiName, config.adminUser]);
      // Nothing was interpreted by a shell
      expect(fs.existsSync(path.join(tempDir, 'injected'))).to.be.false;
    });

    it('should point the installer at the database port that was actually chosen', async function() {
      const blocker = await occupyPort(3306);
      try {
        await installMediaWiki(VALID_CONFIG);
      } finally {
        await closeServer(blocker);
      }

      const dbServer = installArgs().find(arg => arg.startsWith('--dbserver='));
      const port = Number(dbServer.split(':')[1]);
      expect(dbServer).to.match(/^--dbserver=127\.0\.0\.1:\d+$/);
      expect(port).to.not.equal(3306);
      // The same port the database server was started with
      expect(readJson(path.join(getPaths().dbDataDir, 'args.json'))).to.include(`--port=${port}`);
    });

    it('should make LocalSettings.php independent of the install-time ports', async function() {
      await installMediaWiki(VALID_CONFIG);

      const settings = fs.readFileSync(getPaths().localSettings, 'utf8');
      expect(settings).to.include('$wgServer = WebRequest::detectServer();');
      expect(settings).to.include("$wgDBserver = '127.0.0.1:' . ( getenv( 'HAMICHLOL_DB_PORT' ) ?: '3306' );");
      expect(settings).to.not.match(/\$wgServer = "http/);
      expect(getStatus()).to.include({ installed: true, running: false });
    });

    it('should shut the database down again once the installer has finished', async function() {
      await installMediaWiki(VALID_CONFIG);

      expect(queries().slice(-1)).to.deep.equal(['SHUTDOWN']);
      expect(getStatus().running).to.be.false;
      expect(fs.existsSync(getPaths().runStateFile)).to.be.false;
    });

    it('should start the database isolated from other installations', async function() {
      await installMediaWiki(VALID_CONFIG);

      const args = readJson(path.join(getPaths().dbDataDir, 'args.json'));
      expect(args[0]).to.equal('--no-defaults');
      expect(args).to.include(`--datadir=${getPaths().dbDataDir}`);
      expect(args).to.include('--bind-address=127.0.0.1');
      expect(args.find(arg => arg.startsWith('--socket='))).to.exist;
      expect(args.find(arg => arg.startsWith('--pid-file='))).to.include(tempDir);
    });

    it('should refuse to install over an existing wiki without touching the database', async function() {
      await installMediaWiki(VALID_CONFIG);
      const before = queries().length;

      const error = await installMediaWiki(VALID_CONFIG).then(() => null, failure => failure);
      expect(error).to.be.an('error');
      expect(error.message).to.include('LocalSettings.php');
      expect(queries()).to.have.lengthOf(before);
    });

    it('should reject an invalid configuration before starting anything', async function() {
      const error = await installMediaWiki({ ...VALID_CONFIG, dbName: 'mysql' }).then(() => null, failure => failure);

      expect(error).to.be.an('error');
      expect(fs.existsSync(queriesLog())).to.be.false;
      expect(fs.existsSync(path.join(getPaths().dbDataDir, 'args.json'))).to.be.false;
    });

    it('should report the installer\'s own error and stop the database', async function() {
      process.env.FAKE_PHP_INSTALL_FAILS = '1';
      const error = await installMediaWiki(VALID_CONFIG).then(() => null, failure => failure);
      delete process.env.FAKE_PHP_INSTALL_FAILS;

      expect(error).to.be.an('error');
      expect(error.message).to.include('database refused the connection');
      expect(getStatus()).to.include({ installed: false, running: false });
      expect(queries().slice(-1)).to.deep.equal(['SHUTDOWN']);
      expect(fs.existsSync(getPaths().runStateFile)).to.be.false;
    });

    it('should allow another attempt after a failed installation', async function() {
      process.env.FAKE_PHP_INSTALL_FAILS = '1';
      await installMediaWiki(VALID_CONFIG).catch(() => {});
      delete process.env.FAKE_PHP_INSTALL_FAILS;

      await installMediaWiki(VALID_CONFIG);

      expect(getStatus().installed).to.be.true;
      // The half-created database of the first attempt was dropped and recreated
      expect(queries().filter(sql => sql.startsWith('DROP DATABASE'))).to.have.lengthOf(2);
    });

    it('should stop the database when it refuses the setup queries', async function() {
      process.env.FAKE_DB_REJECT_QUERIES = '1';
      const error = await installMediaWiki(VALID_CONFIG).then(() => null, failure => failure);
      delete process.env.FAKE_DB_REJECT_QUERIES;

      expect(error).to.be.an('error');
      expect(error.message).to.include('Access denied');
      // The installer never ran
      expect(fs.existsSync(path.join(getPaths().mediaWikiPath, 'install-args.json'))).to.be.false;
      expect(getStatus()).to.include({ installed: false, running: false });
      const dbArgs = readJson(path.join(getPaths().dbDataDir, 'args.json'));
      expect(dbArgs).to.be.an('array');
      expect(await waitFor(() => !fs.existsSync(getPaths().runStateFile))).to.be.true;
    });

    it('should fail cleanly when the database never becomes ready to accept the installer', async function() {
      fs.rmSync(path.join(getPaths().mariadbDir, 'bin', 'mariadbd.exe'));
      fs.rmSync(path.join(getPaths().mariadbDir, 'bin'), { recursive: true });

      const error = await installMediaWiki(VALID_CONFIG).then(() => null, failure => failure);
      expect(error).to.be.an('error');
      expect(getStatus()).to.include({ downloaded: false, installed: false, running: false });
    });
  });

  describe('Running the servers', function() {
    beforeEach(async function() {
      await installMediaWiki(VALID_CONFIG);
    });

    it('should serve MediaWiki with PHP knowing the database port', async function() {
      const ports = await startServers();
      const paths = getPaths();

      const info = await (await fetch(`http://127.0.0.1:${ports.phpPort}/index.php`)).json();
      expect(info).to.deep.equal({
        dbPort: String(ports.mysqlPort),
        docroot: paths.mediaWikiPath,
        ini: paths.phpIni,
        cwd: paths.phpDir,
        url: '/index.php'
      });
      expect(getStatus()).to.include({ running: true, phpPort: ports.phpPort, mysqlPort: ports.mysqlPort });
    });

    it('should only listen on the loopback interface', async function() {
      if (process.platform !== 'linux') {
        this.skip(); // reads the command line from /proc
      }
      await startServers();

      const state = readJson(getPaths().runStateFile);
      const phpCommand = fs.readFileSync(`/proc/${state.php.pid}/cmdline`, 'utf8').split('\0');
      expect(phpCommand).to.include(`127.0.0.1:${state.php.port}`);
      expect(readJson(path.join(getPaths().dbDataDir, 'args.json'))).to.include('--bind-address=127.0.0.1');
    });

    it('should return the same servers when started twice', async function() {
      const first = await startServers();
      const state = readJson(getPaths().runStateFile);
      const second = await startServers();

      expect(second).to.deep.equal(first);
      expect(readJson(getPaths().runStateFile)).to.deep.equal(state);
    });

    it('should pick free ports when the usual ones are taken', async function() {
      const blockers = [await occupyPort(8080), await occupyPort(3306)];
      try {
        const ports = await startServers();
        expect(ports.phpPort).to.not.equal(8080);
        expect(ports.mysqlPort).to.not.equal(3306);
        expect(ports.phpPort).to.not.equal(ports.mysqlPort);

        const info = await (await fetch(`http://127.0.0.1:${ports.phpPort}/`)).json();
        expect(info.dbPort).to.equal(String(ports.mysqlPort));
      } finally {
        await Promise.all(blockers.map(closeServer));
      }
    });

    it('should ask the database to shut down cleanly when stopping', async function() {
      await startServers();
      const state = readJson(getPaths().runStateFile);
      const shutdownsBefore = queries().filter(sql => sql === 'SHUTDOWN').length;

      await stopServers();

      expect(queries().filter(sql => sql === 'SHUTDOWN')).to.have.lengthOf(shutdownsBefore + 1);
      expect(isAlive(state.mysql.pid)).to.be.false;
      expect(isAlive(state.php.pid)).to.be.false;
      expect(getStatus()).to.include({ running: false, phpPort: null, mysqlPort: null });
      expect(fs.existsSync(getPaths().runStateFile)).to.be.false;
    });

    it('should start again after being stopped, keeping the wiki', async function() {
      await startServers();
      await stopServers();
      const ports = await startServers();

      expect((await fetch(`http://127.0.0.1:${ports.phpPort}/`)).status).to.equal(200);
      expect(getStatus()).to.include({ installed: true, running: true });
      // Starting never recreates the database
      expect(queries().filter(sql => sql.startsWith('DROP DATABASE'))).to.have.lengthOf(1);
    });

    it('should be safe to stop when nothing is running', async function() {
      expect(await stopServers()).to.be.true;
      expect(await stopServers()).to.be.true;
      expect(getStatus().running).to.be.false;
    });

    it('should leave nothing running when PHP cannot start', async function() {
      process.env.FAKE_PHP_SERVER_FAILS = '1';
      const error = await startServers().then(() => null, failure => failure);
      delete process.env.FAKE_PHP_SERVER_FAILS;

      expect(error).to.be.an('error');
      expect(getStatus().running).to.be.false;
      expect(fs.existsSync(getPaths().runStateFile)).to.be.false;
      // The database was shut down cleanly, not killed
      expect(queries().slice(-1)).to.deep.equal(['SHUTDOWN']);
    });

    it('should recover on the next start after the app was killed', async function() {
      await startServers();
      const state = readJson(getPaths().runStateFile);

      // Simulate a crash: the module forgets its servers but they keep running
      delete require.cache[require.resolve('../src/server-manager')];
      const fresh = require('../src/server-manager');
      fresh.setDataPath(tempDir);
      try {
        expect(fresh.getStatus().running).to.be.false;
        const ports = await fresh.startServers();

        expect(isAlive(state.mysql.pid)).to.be.false;
        expect(isAlive(state.php.pid)).to.be.false;
        expect((await fetch(`http://127.0.0.1:${ports.phpPort}/`)).status).to.equal(200);
      } finally {
        await fresh.stopServers();
        require.cache[require.resolve('../src/server-manager')].exports = serverManager;
      }
    });
  });
});

// The same flow when PHP, the database server and MediaWiki are taken from the
// computer instead of the data folder, for both MariaDB and MySQL.
describe('Real installation flow with installed software', function() {
  this.timeout(30000);

  let tempDir;
  let dataDir;
  let restoreEnv;
  let programs;

  function useInstalledSoftware(dbVersionOutput) {
    programs = {
      php: installFakeProgram(path.join(tempDir, 'usr', 'bin', 'php'), FAKE_PHP),
      server: installFakeProgram(path.join(tempDir, 'usr', 'sbin', 'mysqld'), FAKE_DB_SERVER),
      installDb: installFakeProgram(path.join(tempDir, 'usr', 'bin', 'mariadb-install-db'), FAKE_DB_SERVER)
    };
    const mediawiki = path.join(tempDir, 'usr', 'share', 'mediawiki');
    for (const sub of ['includes', 'maintenance', 'vendor']) {
      fs.mkdirSync(path.join(mediawiki, sub), { recursive: true });
    }
    fs.writeFileSync(path.join(mediawiki, 'index.php'), '');
    fs.writeFileSync(path.join(mediawiki, 'maintenance', 'install.php'), '');
    fs.writeFileSync(path.join(mediawiki, 'includes', 'Defines.php'), "<?php\ndefine( 'MW_VERSION', '1.43.1' );\n");

    Object.assign(process.env, {
      HAMICHLOL_PHP: programs.php,
      HAMICHLOL_MYSQLD: programs.server,
      HAMICHLOL_MEDIAWIKI_DIR: mediawiki,
      FAKE_DB_VERSION: dbVersionOutput
    });
    require('../src/system-tools').resetCache();
  }

  before(function() {
    if (!CAN_RUN_FAKE_PROGRAMS) {
      this.skip();
    }
  });

  beforeEach(function() {
    restoreEnv = setEnv({
      DEV_MODE: 'false',
      HAMICHLOL_USE_SYSTEM: undefined,
      HAMICHLOL_PHP: undefined,
      HAMICHLOL_MYSQLD: undefined,
      HAMICHLOL_MEDIAWIKI_DIR: undefined,
      FAKE_DB_VERSION: undefined
    });
    tempDir = makeTempDir('installed');
    dataDir = path.join(tempDir, 'data');
    setDataPath(dataDir);
  });

  afterEach(async function() {
    await stopServers();
    restoreEnv();
    require('../src/system-tools').resetCache();
    removeDir(tempDir);
  });

  after(function() {
    process.env.DEV_MODE = 'true';
  });

  const initArgs = () => readJson(path.join(getPaths().dbDataDir, 'init-args.json'));
  const startArgs = () => readJson(path.join(getPaths().dbDataDir, 'args.json'));

  for (const [name, versionOutput, flavor, version] of [
    ['MariaDB', 'mariadbd  Ver 10.11.14-MariaDB-0ubuntu0.24.04.1 for debian-linux-gnu on x86_64', 'mariadb', '10.11.14'],
    ['MySQL', '/usr/sbin/mysqld  Ver 8.0.36 for Linux on x86_64 (MySQL Community Server - GPL)', 'mysql', '8.0.36']
  ]) {
    describe(`with ${name}`, function() {
      beforeEach(function() {
        useInstalledSoftware(versionOutput);
      });

      it('should go through setup, installation, start and stop', async function() {
        expect(getStatus().tools.database).to.include({ source: 'system', flavor, version, path: programs.server });

        await serverManager.downloadServers();
        expect(getStatus()).to.include({ downloaded: true, installed: false });

        await installMediaWiki(VALID_CONFIG);
        expect(getStatus()).to.include({ installed: true, running: false });

        const ports = await startServers();
        const info = await (await fetch(`http://127.0.0.1:${ports.phpPort}/`)).json();
        expect(info.dbPort).to.equal(String(ports.mysqlPort));
        expect(info.docroot).to.equal(getPaths().mediaWikiPath);

        await stopServers();
        expect(getStatus().running).to.be.false;
        expect(readLines(path.join(getPaths().dbDataDir, 'queries.log')).slice(-1)).to.deep.equal(['SHUTDOWN']);
      });

      it('should run the installed PHP with its own configuration', async function() {
        await serverManager.downloadServers();
        await installMediaWiki(VALID_CONFIG);
        const ports = await startServers();

        // No -c: neither for the installer nor for the web server
        const installArgs = readJson(path.join(getPaths().mediaWikiPath, 'install-args.json'));
        expect(installArgs[0]).to.equal(path.join(getPaths().mediaWikiPath, 'maintenance', 'install.php'));
        expect(installArgs).to.not.include('-c');
        const info = await (await fetch(`http://127.0.0.1:${ports.phpPort}/`)).json();
        expect(info.ini).to.be.null;
      });

      it('should put nothing into the data folder but the database and the wiki', async function() {
        await serverManager.downloadServers();

        expect(fs.readdirSync(dataDir).sort()).to.deep.equal(['database', 'mediawiki', 'server']);
        expect(fs.readdirSync(getPaths().serverPath)).to.deep.equal([]);
      });

      if (flavor === 'mariadb') {
        it('should create the data folder with the separate install tool', async function() {
          await serverManager.downloadServers();

          const args = initArgs();
          expect(args[0]).to.equal('--no-defaults');
          expect(args).to.include(`--datadir=${getPaths().dbDataDir}.partial`);
          expect(args).to.include('--auth-root-authentication-method=normal');
          expect(args).to.include('--skip-test-db');
          expect(args).to.not.include('--initialize-insecure');
        });

        it('should not pass MySQL-only options to MariaDB', async function() {
          await serverManager.downloadServers();
          await installMediaWiki(VALID_CONFIG);

          expect(startArgs().join(' ')).to.not.include('mysqlx');
        });
      } else {
        it('should create the data folder with the server itself', async function() {
          fs.rmSync(programs.installDb); // MySQL has no such tool
          require('../src/system-tools').resetCache();
          await serverManager.downloadServers();

          const args = initArgs();
          expect(args.slice(0, 2)).to.deep.equal(['--no-defaults', '--initialize-insecure']);
          expect(args).to.include(`--datadir=${getPaths().dbDataDir}.partial`);
        });

        it('should switch off the extra MySQL X protocol port', async function() {
          await serverManager.downloadServers();
          await installMediaWiki(VALID_CONFIG);

          expect(startArgs()).to.include('--loose-mysqlx=OFF');
        });
      }
    });
  }

  it('should initialise and run the database as root only when the app runs as root', async function() {
    useInstalledSoftware('mariadbd  Ver 10.11.14-MariaDB');
    const getuid = process.getuid;
    try {
      process.getuid = () => 1000;
      await serverManager.downloadServers();
      expect(initArgs()).to.not.include('--user=root');

      fs.rmSync(getPaths().dbDataDir, { recursive: true });
      process.getuid = () => 0;
      await serverManager.downloadServers();
      expect(initArgs()).to.include('--user=root');
    } finally {
      process.getuid = getuid;
    }
  });

  it('should prefer servers the app downloaded earlier over installed ones', async function() {
    useInstalledSoftware('mariadbd  Ver 10.11.14-MariaDB');
    const paths = getPaths();
    installFakeProgram(paths.phpExe, FAKE_PHP);
    fs.writeFileSync(paths.phpIni, '');
    installFakeProgram(path.join(paths.mariadbDir, 'bin', 'mariadbd.exe'), FAKE_DB_SERVER);

    const { tools } = getStatus();
    expect(tools.php).to.include({ source: 'bundled', path: paths.phpExe });
    expect(tools.database).to.include({ source: 'bundled' });
  });

  it('should never use an unsuitable program, and say why when nothing else is available', function() {
    useInstalledSoftware('mariadbd  Ver 10.1.48-MariaDB');
    process.env.FAKE_PHP_VERSION = '7.4.33';
    require('../src/system-tools').resetCache();
    try {
      const { tools } = getStatus();
      // If this computer has suitable software of its own, that is used instead;
      // otherwise the component is reported as missing, with the reason
      expect(tools.php.path).to.not.equal(programs.php);
      if (tools.php.source === null) {
        expect(tools.php.problem).to.include(programs.php).and.to.include('7.4.33');
      }
      expect(tools.database.path).to.not.equal(programs.server);
      if (tools.database.source === null) {
        expect(tools.database.problem).to.include(programs.server).and.to.include('10.1.48');
      }
    } finally {
      delete process.env.FAKE_PHP_VERSION;
    }
  });

  it('should pick up software that was installed after the first look', async function() {
    // Nothing usable at first: this computer's own software must not interfere
    process.env.HAMICHLOL_USE_SYSTEM = 'false';
    expect(getStatus().tools.php.source).to.be.null;
    delete process.env.HAMICHLOL_USE_SYSTEM;

    useInstalledSoftware('mariadbd  Ver 10.11.14-MariaDB');
    await serverManager.downloadServers();

    expect(getStatus()).to.include({ downloaded: true });
    expect(getStatus().tools.php).to.include({ source: 'system', path: programs.php });
  });
});
