// The real (non-dev) installation and server lifecycle, end to end, with fake
// programs in place of PHP and MariaDB. The fake database speaks the MySQL
// protocol, so the app's own connection code, SQL and shutdown are exercised.

const { describe, it, before, after, beforeEach, afterEach } = require('mocha');
const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

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
const wikiSettings = require('../src/wiki-settings');
const { MEDIAWIKI_BRANCH } = require('../src/versions');

const { setDataPath, getPaths, getStatus, installMediaWiki, startServers, stopServers } = serverManager;

const { PHP_SERVER_SETTINGS } = serverManager._internal;

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
      // A Hebrew wiki (content and interface language)
      expect(args).to.include('--lang=he');
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

    it('should install a Hebrew wiki', async function() {
      await installMediaWiki(VALID_CONFIG);

      expect(fs.readFileSync(getPaths().localSettings, 'utf8')).to.include('$wgLanguageCode = "he";');
    });

    it('should never put the passwords into the installer\'s error', async function() {
      process.env.FAKE_PHP_INSTALL_FAILS = '1';
      const config = { ...VALID_CONFIG, dbPassword: 'secret-db-pass', adminPassword: 'secret-admin-pass' };
      const error = await installMediaWiki(config).then(() => null, failure => failure);
      delete process.env.FAKE_PHP_INSTALL_FAILS;

      expect(error.message).to.include('אפשר לתקן את ההגדרות ולנסות שוב');
      expect(error.message).to.include('database refused the connection');
      expect(error.message).to.not.include('secret-db-pass');
      expect(error.message).to.not.include('secret-admin-pass');
      expect(error.message).to.not.include('--pass');
    });

    describe('with the common password list of MediaWiki', function() {
      const commonPasswordsFile = () =>
        path.join(getPaths().mediaWikiPath, 'vendor', 'wikimedia', 'common-passwords', 'src', 'common.php');
      const writeList = content => {
        fs.mkdirSync(path.dirname(commonPasswordsFile()), { recursive: true });
        fs.writeFileSync(commonPasswordsFile(), content);
      };
      const LIST = ['<?php return [', ...Array.from({ length: 20 }, (_, i) => `'common-password-${i}' => 1,`), '];', ''].join('\n');

      it('should refuse a common password before creating the database', async function() {
        writeList(LIST);
        const error = await installMediaWiki({ ...VALID_CONFIG, adminPassword: 'common-password-7' })
          .then(() => null, failure => failure);

        expect(error.message).to.include('נפוצות');
        expect(fs.existsSync(queriesLog())).to.be.false;
        expect(fs.existsSync(path.join(getPaths().mediaWikiPath, 'install-args.json'))).to.be.false;
      });

      it('should accept passwords that are not on the list', async function() {
        writeList(LIST);
        await installMediaWiki(VALID_CONFIG);
        expect(getStatus().installed).to.be.true;
      });

      it('should skip only this check when the list is in an unknown format', async function() {
        writeList('<?php return json_decode( file_get_contents( "common.json" ) );');
        await installMediaWiki({ ...VALID_CONFIG, adminPassword: 'common-password-7' });
        expect(getStatus().installed).to.be.true;
      });
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
        args: [
          '-c', paths.phpIni,
          ...Object.entries(PHP_SERVER_SETTINGS).flatMap(([name, value]) => ['-d', `${name}=${value}`]),
          '-S', `127.0.0.1:${ports.phpPort}`, '-t', paths.mediaWikiPath
        ],
        cwd: paths.phpDir,
        url: '/index.php'
      });
      expect(getStatus()).to.include({ running: true, phpPort: ports.phpPort, mysqlPort: ports.mysqlPort });
    });

    it('should pass the OPcache and realpath cache settings to the web server only', async function() {
      const ports = await startServers();
      const { args } = await (await fetch(`http://127.0.0.1:${ports.phpPort}/index.php`)).json();

      expect(PHP_SERVER_SETTINGS).to.deep.equal({
        'opcache.enable': '1',
        'opcache.memory_consumption': '192',
        'opcache.interned_strings_buffer': '16',
        'opcache.max_accelerated_files': '20000',
        realpath_cache_size: '4096K',
        realpath_cache_ttl: '600'
      });
      for (const [name, value] of Object.entries(PHP_SERVER_SETTINGS)) {
        expect(args.join(' ')).to.include(`-d ${name}=${value}`);
      }
      // The extension is loaded by php.ini; loading it twice would warn
      expect(args.join(' ')).to.not.include('zend_extension');
      // The installer ran before, without these settings
      expect(installArgs().join(' ')).to.not.include('opcache');
    });

    it('should add the file cache settings to an installation that does not have them yet', async function() {
      const { localSettings } = getPaths();
      const current = fs.readFileSync(localSettings, 'utf8');
      const old = current.slice(0, current.indexOf('# Added by Hamichlol Offline: performance settings'));
      fs.writeFileSync(localSettings, old);

      await startServers();
      const upgraded = fs.readFileSync(localSettings, 'utf8');
      expect(upgraded).to.include('$wgUseFileCache = true;');
      expect(upgraded).to.equal(current);

      // Starting again does not duplicate the block
      await stopServers();
      await startServers();
      expect(fs.readFileSync(localSettings, 'utf8')).to.equal(current);
    });

    it('should enable OPcache in the app\'s php.ini before starting PHP', async function() {
      fs.writeFileSync(getPaths().phpIni, 'extension=mysqli\n;zend_extension=opcache\n');
      await startServers();
      expect(fs.readFileSync(getPaths().phpIni, 'utf8')).to.equal('extension=mysqli\nzend_extension=opcache\n');
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

    it('should announce a server that exits by itself', async function() {
      await startServers();
      const { php } = readJson(getPaths().runStateFile);
      let changes = 0;
      const listener = () => { changes += 1; };
      serverManager.events.on('change', listener);
      try {
        process.kill(php.pid, 'SIGKILL');
        expect(await waitFor(() => changes > 0)).to.be.true;
        expect(getStatus().running).to.be.false;
      } finally {
        serverManager.events.removeListener('change', listener);
      }
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

  // The app's settings file (src/wiki-settings.js) and the schema update the
  // extensions it enables may need. The fake update.php sends one statement,
  // so queries.log shows each run.
  describe('The app\'s extensions and settings', function() {
    const UPDATE_QUERY = 'ALTER TABLE fake_update';
    const updates = () => queries().filter(sql => sql === UPDATE_QUERY).length;
    const settingsPath = () => path.join(getPaths().mediaWikiPath, wikiSettings.SETTINGS_FILE);
    const stamp = () => wikiSettings.readSchemaStamp(getPaths().mediaWikiPath);

    beforeEach(function() {
      // Two of the bundled extensions, as in the release
      for (const name of ['Cite', 'Scribunto']) {
        const dir = path.join(getPaths().mediaWikiPath, 'extensions', name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'extension.json'), '{}');
      }
    });

    it('should be in place right after the installation', async function() {
      await installMediaWiki(VALID_CONFIG);

      const settings = fs.readFileSync(getPaths().localSettings, 'utf8');
      expect(settings.trimEnd().endsWith(`require_once "$IP/${wikiSettings.SETTINGS_FILE}";`)).to.be.true;
      expect(fs.readFileSync(settingsPath(), 'utf8')).to.equal(wikiSettings.buildSettings(getPaths().mediaWikiPath));
      // The schema update is left to the first start
      expect(updates()).to.equal(0);
      expect(stamp()).to.be.null;
    });

    it('should run the schema update once, on the first start', async function() {
      await installMediaWiki(VALID_CONFIG);

      const ports = await startServers();

      expect(updates()).to.equal(1);
      expect(stamp()).to.equal(wikiSettings.settingsHash(fs.readFileSync(settingsPath(), 'utf8')));
      // The database the update started is the one the wiki runs on
      const info = await (await fetch(`http://127.0.0.1:${ports.phpPort}/`)).json();
      expect(info.dbPort).to.equal(String(ports.mysqlPort));
      // This layout has no maintenance/run.php, so update.php runs by itself
      expect(readJson(path.join(getPaths().mediaWikiPath, 'update-args.json')).args.slice(-2))
        .to.deep.equal([path.join(getPaths().mediaWikiPath, 'maintenance', 'update.php'), '--quick']);

      await stopServers();
      await startServers();
      expect(updates()).to.equal(1);
    });

    it('should run it on the database server the wiki then uses, started once', async function() {
      await installMediaWiki(VALID_CONFIG);
      const shutdowns = () => queries().filter(sql => sql === 'SHUTDOWN').length;
      const before = shutdowns();

      await startServers();

      // The update reached the server, which kept running for the wiki
      expect(updates()).to.equal(1);
      expect(shutdowns()).to.equal(before);
      const state = readJson(getPaths().runStateFile);
      expect(isAlive(state.mysql.pid)).to.be.true;
      expect(readJson(path.join(getPaths().mediaWikiPath, 'update-args.json')).dbPort).to.equal(String(state.mysql.port));
    });

    it('should report a missing PHP only after the database, and leave nothing running', async function() {
      await installMediaWiki(VALID_CONFIG);
      fs.rmSync(getPaths().phpExe);

      const error = await startServers().then(() => null, failure => failure);

      expect(error.message).to.include('PHP');
      expect(updates()).to.equal(0);
      expect(stamp()).to.be.null;
      expect(getStatus().running).to.be.false;
      expect(fs.existsSync(getPaths().runStateFile)).to.be.false;
      expect(queries().slice(-1)).to.deep.equal(['SHUTDOWN']);
    });

    it('should run it again when the settings change, e.g. a new extension', async function() {
      await installMediaWiki(VALID_CONFIG);
      await startServers();
      await stopServers();
      const dir = path.join(getPaths().mediaWikiPath, 'extensions', 'TemplateStyles');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'extension.json'), '{}');

      await startServers();

      expect(updates()).to.equal(2);
      expect(fs.readFileSync(settingsPath(), 'utf8')).to.include("'TemplateStyles',");
    });

    it('should add them to a wiki installed by an earlier version of the app, keeping its settings', async function() {
      await installMediaWiki(VALID_CONFIG);
      // As the earlier version left it: no include, no settings file, own edits
      const own = fs.readFileSync(getPaths().localSettings, 'utf8')
        .replace(/\n# Added by Hamichlol Offline: extensions[\s\S]*$/, '\n') + "$wgDefaultSkin = 'timeless';\n";
      fs.writeFileSync(getPaths().localSettings, own);
      fs.rmSync(settingsPath());

      await startServers();

      const settings = fs.readFileSync(getPaths().localSettings, 'utf8');
      expect(settings.startsWith(own.trimEnd())).to.be.true;
      expect(settings).to.include(`require_once "$IP/${wikiSettings.SETTINGS_FILE}";`);
      expect(fs.existsSync(settingsPath())).to.be.true;
      expect(updates()).to.equal(1);
    });

    it('should respect a user who switched the settings file off', async function() {
      await installMediaWiki(VALID_CONFIG);
      const switchedOff = fs.readFileSync(getPaths().localSettings, 'utf8').replace('require_once', '# require_once');
      fs.writeFileSync(getPaths().localSettings, switchedOff);

      await startServers();

      expect(fs.readFileSync(getPaths().localSettings, 'utf8')).to.equal(switchedOff);
    });

    it('should leave no copy of the database and no blocked sync after a successful update', async function() {
      await installMediaWiki(VALID_CONFIG);

      await startServers();

      expect(updates()).to.equal(1);
      expect(getStatus().syncBlocked).to.be.null;
      expect(fs.readdirSync(tempDir).sort()).to.deep.equal(['database', 'mediawiki', 'run-state.json', 'server']);
      expect(fs.existsSync(path.join(getPaths().mediaWikiPath, wikiSettings.SCHEMA_FAILURE_FILE))).to.be.false;
    });

    it('should report a missing PHP as such, not as a failed update, and keep nothing of the attempt', async function() {
      await installMediaWiki(VALID_CONFIG);
      fs.rmSync(getPaths().phpExe);

      const error = await startServers().then(() => null, failure => failure);

      expect(error.message).to.include('PHP');
      expect(getStatus().syncBlocked).to.be.null;
      expect(fs.readdirSync(tempDir).sort()).to.deep.equal(['database', 'mediawiki', 'server']);
    });
  });

  // When the schema update for changed settings fails, the wiki is put back as
  // it was before (the database and the previous settings) and started like
  // that, and synchronisation with the site is blocked until an update succeeds.
  describe('A failed update of the app\'s settings', function() {
    const UPDATE_QUERY = 'ALTER TABLE fake_update';
    const updates = () => queries().filter(sql => sql === UPDATE_QUERY).length;
    const mw = () => getPaths().mediaWikiPath;
    const read = name => {
      const file = path.join(mw(), name);
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    };
    // Everything the restore must bring back
    const snapshot = () => ({
      localSettings: read('LocalSettings.php'),
      settings: read(wikiSettings.SETTINGS_FILE),
      stamp: read(wikiSettings.SCHEMA_STAMP_FILE),
      database: fs.readdirSync(getPaths().dbDataDir).sort(),
      queries: queries()
    });
    const leftovers = () => fs.readdirSync(tempDir).filter(name => /settings|\.partial$|\.tmp$/.test(name));
    const failure = promise => promise.then(() => null, error => error);
    const addExtension = name => {
      const dir = path.join(mw(), 'extensions', name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'extension.json'), '{}');
    };
    // Copies of the database folder made for the settings update
    let copies;
    let serversDuringCopy;
    let realCpSync;

    async function startFailing(env = { FAKE_PHP_UPDATE_FAILS: '1' }) {
      const restore = setEnv(env);
      try {
        return await startServers();
      } finally {
        restore();
      }
    }

    // A wiki whose settings were updated once, and then changed (as by a new
    // version of the app): the next start runs update.php for them
    async function wikiWithChangedSettings() {
      await installMediaWiki(VALID_CONFIG);
      await startServers();
      await stopServers();
      addExtension('TemplateStyles');
      // The first start copied the database for its update too
      expect(copies).to.equal(1);
      copies = 0;
    }

    async function expectWikiRunning() {
      const { phpPort, mysqlPort, running } = getStatus();
      expect(running).to.be.true;
      const info = await (await fetch(`http://127.0.0.1:${phpPort}/`)).json();
      expect(info.dbPort).to.equal(String(mysqlPort));
    }

    beforeEach(function() {
      for (const name of ['Cite', 'Scribunto']) {
        addExtension(name);
      }
      copies = 0;
      serversDuringCopy = [];
      realCpSync = fs.cpSync;
      fs.cpSync = (source, target, ...rest) => {
        if (target === `${getPaths().settingsDbBackup}.partial`) {
          copies += 1;
          // No database server may be writing while the copy is made
          serversDuringCopy.push(fs.existsSync(getPaths().runStateFile));
        }
        return realCpSync.call(fs, source, target, ...rest);
      };
    });

    afterEach(function() {
      fs.cpSync = realCpSync;
    });

    it('should copy the database before the update, and remove the copy once it succeeded', async function() {
      await wikiWithChangedSettings();

      await startServers();

      expect(copies).to.equal(1);
      expect(serversDuringCopy).to.deep.equal([false, false]);
      expect(updates()).to.equal(2);
      expect(leftovers()).to.deep.equal([]);
      expect(getStatus().syncBlocked).to.be.null;
      expect(read(wikiSettings.SETTINGS_FILE)).to.include("'TemplateStyles',");
    });

    it('should start the wiki with the database and settings it had before, and block sync', async function() {
      await wikiWithChangedSettings();
      const before = snapshot();

      await startFailing();

      // update.php reached the database (and failed); the copy taken before it is back
      const after = snapshot();
      expect(after.queries.slice(0, before.queries.length)).to.deep.equal(before.queries);
      expect(after.queries.filter(sql => sql === UPDATE_QUERY)).to.have.lengthOf(1); // the first, successful update
      expect(after.localSettings).to.equal(before.localSettings);
      expect(after.settings).to.equal(before.settings).and.to.not.include('TemplateStyles');
      expect(after.stamp).to.equal(before.stamp);
      await expectWikiRunning();
      expect(leftovers()).to.deep.equal([]);

      const { syncBlocked } = getStatus();
      expect(syncBlocked).to.include({ reason: 'settings-update-failed' });
      expect(syncBlocked.message).to.include('נכשל').and.to.include('הוחזר למצבו הקודם').and.to.include('הסנכרון עם אתר המכלול חסום');
      expect(syncBlocked.details).to.include('update.php').and.to.include('table mw_fake is broken');
      expect(Date.parse(syncBlocked.since)).to.be.closeTo(Date.now(), 60000);
    });

    it('should keep sync blocked across a restart of the app', async function() {
      await wikiWithChangedSettings();
      await startFailing();
      const { syncBlocked } = getStatus();
      await stopServers();

      delete require.cache[require.resolve('../src/server-manager')];
      const fresh = require('../src/server-manager');
      fresh.setDataPath(tempDir);
      try {
        expect(fresh.getStatus().syncBlocked).to.deep.equal(syncBlocked);
        await fresh.startServers();
        expect(fresh.getStatus().syncBlocked).to.deep.equal(syncBlocked);
      } finally {
        await fresh.stopServers();
        require.cache[require.resolve('../src/server-manager')].exports = serverManager;
      }
    });

    it('should not try the same settings again at every start, only other settings or when asked', async function() {
      await wikiWithChangedSettings();
      await startFailing();
      const { since } = getStatus().syncBlocked;
      await stopServers();
      expect(copies).to.equal(1);
      expect(updates()).to.equal(1);

      // Same settings: no copy, no update, the wiki runs as it was put back
      await startServers();
      expect(copies).to.equal(1);
      expect(updates()).to.equal(1);
      expect(read(wikiSettings.SETTINGS_FILE)).to.not.include('TemplateStyles');
      await expectWikiRunning();
      expect(getStatus().syncBlocked.since).to.equal(since);
      await stopServers();

      // Other settings (e.g. a newer app) are tried; still failing, sync stays
      // blocked since the first failure
      addExtension('ImageMap');
      await startFailing();
      expect(copies).to.equal(2);
      expect(getStatus().syncBlocked.since).to.equal(since);
      await stopServers();

      // Asked for: tried again, and once it succeeds sync is no longer blocked
      serverManager.retrySettingsUpdate();
      await startServers();
      expect(copies).to.equal(3);
      expect(updates()).to.equal(2);
      expect(getStatus().syncBlocked).to.be.null;
      expect(read(wikiSettings.SETTINGS_FILE)).to.include("'TemplateStyles',").and.to.include("'ImageMap',");
      expect(wikiSettings.readSchemaStamp(mw())).to.equal(wikiSettings.settingsHash(read(wikiSettings.SETTINGS_FILE)));
    });

    it('should start a freshly installed wiki without the app\'s settings when their first update fails', async function() {
      await installMediaWiki(VALID_CONFIG);
      const installed = read('LocalSettings.php');
      const databaseBefore = queries();

      await startFailing();

      // The wiki as install.php made it: without the settings file and the line that includes it
      expect(read('LocalSettings.php')).to.equal(wikiSettings.removeInclude(installed));
      expect(read('LocalSettings.php')).to.not.include(wikiSettings.SETTINGS_FILE);
      expect(read(wikiSettings.SETTINGS_FILE)).to.be.null;
      expect(read(wikiSettings.SCHEMA_STAMP_FILE)).to.be.null;
      expect(queries().slice(0, databaseBefore.length)).to.deep.equal(databaseBefore);
      expect(queries()).to.not.include(UPDATE_QUERY);
      await expectWikiRunning();
      expect(getStatus().syncBlocked).to.include({ reason: 'settings-update-failed' });
      await stopServers();

      // Not tried again by itself; the line stays out
      await startServers();
      expect(read('LocalSettings.php')).to.not.include(wikiSettings.SETTINGS_FILE);
      await stopServers();

      serverManager.retrySettingsUpdate();
      await startServers();
      expect(read('LocalSettings.php')).to.equal(installed);
      expect(read(wikiSettings.SETTINGS_FILE)).to.equal(wikiSettings.buildSettings(mw()));
      expect(getStatus().syncBlocked).to.be.null;
    });

    it('should leave a wiki of an earlier version of the app exactly as it was when the first update fails', async function() {
      await installMediaWiki(VALID_CONFIG);
      const own = read('LocalSettings.php').replace(/\n# Added by Hamichlol Offline: extensions[\s\S]*$/, '\n') +
        "$wgDefaultSkin = 'timeless';\n";
      fs.writeFileSync(getPaths().localSettings, own);
      fs.rmSync(path.join(mw(), wikiSettings.SETTINGS_FILE));

      await startFailing();

      expect(read('LocalSettings.php')).to.equal(own);
      expect(read(wikiSettings.SETTINGS_FILE)).to.be.null;
      await expectWikiRunning();
      expect(getStatus().syncBlocked).to.include({ reason: 'settings-update-failed' });
    });

    it('should start the wiki as it was when the database cannot be copied', async function() {
      await wikiWithChangedSettings();
      const before = snapshot();
      fs.cpSync = () => {
        const error = new Error('ENOSPC: no space left on device, copyfile');
        error.code = 'ENOSPC';
        throw error;
      };

      await startServers();

      const after = snapshot();
      expect(after.settings).to.equal(before.settings);
      expect(after.stamp).to.equal(before.stamp);
      expect(updates()).to.equal(1);
      await expectWikiRunning();
      expect(getStatus().syncBlocked.details).to.include('no space left');
      expect(leftovers()).to.deep.equal([]);
    });

    it('should not start the wiki when it cannot be put back, and finish that on the next start', async function() {
      await wikiWithChangedSettings();
      const before = snapshot();
      const { dbDataDir, settingsJournal } = getPaths();
      const realRename = fs.renameSync;
      fs.renameSync = (from, to) => {
        if (to === dbDataDir) {
          const error = new Error(`EACCES: permission denied, rename '${from}'`);
          error.code = 'EACCES';
          throw error;
        }
        return realRename.call(fs, from, to);
      };
      let error;
      try {
        error = await failure(startFailing());
      } finally {
        fs.renameSync = realRename;
      }

      expect(error.message).to.include('table mw_fake is broken')
        .and.to.include('לא הושלמה').and.to.include('permission denied').and.to.include('בהפעלה הבאה');
      expect(getStatus().running).to.be.false;
      expect(fs.existsSync(getPaths().runStateFile)).to.be.false;
      expect(readJson(settingsJournal)).to.include({ phase: 'restore' });
      expect(getStatus().syncBlocked).to.include({ reason: 'settings-update-unfinished' });

      await startServers();

      const after = snapshot();
      expect(after.settings).to.equal(before.settings);
      expect(after.stamp).to.equal(before.stamp);
      expect(after.queries.slice(0, before.queries.length)).to.deep.equal(before.queries);
      expect(updates()).to.equal(1);
      await expectWikiRunning();
      expect(getStatus().syncBlocked).to.include({ reason: 'settings-update-failed' });
      expect(getStatus().syncBlocked.details).to.include('table mw_fake is broken');
      expect(leftovers()).to.deep.equal([]);
    });

    it('should finish a restore that a crash cut off, before the wiki starts', async function() {
      await wikiWithChangedSettings();
      const before = snapshot();
      const { dbDataDir, settingsDbBackup, settingsJournal } = getPaths();
      // As the failed update leaves it: the copy, the journal with the
      // previous files, the new settings and a changed database...
      const previous = wikiSettings.previousFiles(mw());
      fs.cpSync(dbDataDir, settingsDbBackup, { recursive: true });
      const { hash } = wikiSettings.writeSettings(mw());
      fs.writeFileSync(settingsJournal, JSON.stringify({ settings: hash, phase: 'restore', error: 'update.php: boom', previous }));
      fs.appendFileSync(path.join(dbDataDir, 'queries.log'), `${UPDATE_QUERY}\n`);
      // ...cut off between removing the changed database and moving the copy back
      fs.rmSync(dbDataDir, { recursive: true });

      await startServers();

      const after = snapshot();
      expect(after.settings).to.equal(before.settings);
      expect(after.stamp).to.equal(before.stamp);
      expect(after.queries.slice(0, before.queries.length)).to.deep.equal(before.queries);
      expect(updates()).to.equal(1);
      await expectWikiRunning();
      expect(getStatus().syncBlocked.details).to.equal('update.php: boom');
      expect(copies).to.equal(0);
      expect(leftovers()).to.deep.equal([]);
    });

    it('should throw away a copy that a crash cut off, and try the update again', async function() {
      await wikiWithChangedSettings();
      const { settingsDbBackup, settingsJournal } = getPaths();
      fs.mkdirSync(`${settingsDbBackup}.partial`, { recursive: true });
      fs.writeFileSync(settingsJournal, JSON.stringify({ settings: 'x', phase: 'prepare', previous: wikiSettings.previousFiles(mw()) }));

      await startServers();

      expect(updates()).to.equal(2);
      expect(getStatus().syncBlocked).to.be.null;
      expect(leftovers()).to.deep.equal([]);
    });

    it('should put the wiki back when the app was killed while update.php ran', async function() {
      await wikiWithChangedSettings();
      const before = snapshot();
      const { settingsJournal, runStateFile } = getPaths();
      // The start runs in a separate process, which is killed half-way
      const script = `
        process.env.DEV_MODE = 'false';
        const serverManager = require(${JSON.stringify(require.resolve('../src/server-manager'))});
        serverManager.setDataPath(${JSON.stringify(tempDir)});
        serverManager.startServers().then(() => console.log('started'), error => console.log(error.message));
      `;
      const child = spawn(process.execPath, ['-e', script], { env: { ...process.env, FAKE_PHP_UPDATE_HANGS: '1' }, stdio: 'ignore' });
      try {
        expect(await waitFor(() => fs.existsSync(settingsJournal) && readJson(settingsJournal).phase === 'update' &&
          updates() === 2, 15000)).to.be.true;
      } finally {
        child.kill('SIGKILL');
      }
      await waitFor(() => !isAlive(child.pid));
      // The database server it started outlived it
      const leftover = readJson(runStateFile).mysql;
      expect(isAlive(leftover.pid)).to.be.true;
      expect(read(wikiSettings.SETTINGS_FILE)).to.include('TemplateStyles');

      await startServers();

      expect(await waitFor(() => !isAlive(leftover.pid))).to.be.true;
      const after = snapshot();
      expect(after.settings).to.equal(before.settings);
      expect(after.stamp).to.equal(before.stamp);
      expect(after.localSettings).to.equal(before.localSettings);
      expect(after.queries.slice(0, before.queries.length)).to.deep.equal(before.queries);
      expect(updates()).to.equal(1);
      await expectWikiRunning();
      expect(getStatus().syncBlocked.details).to.include('הופסק');
      expect(leftovers()).to.deep.equal([]);
    });

    it('should refuse to guess when the journal is damaged', async function() {
      await wikiWithChangedSettings();
      fs.writeFileSync(getPaths().settingsJournal, '{"phase": "upd');

      const error = await failure(startServers());

      expect(error.message).to.include('פגום');
      expect(getStatus().running).to.be.false;
      expect(getStatus().syncBlocked).to.include({ reason: 'settings-update-unfinished' });
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
    fs.writeFileSync(path.join(mediawiki, 'includes', 'Defines.php'), `<?php\ndefine( 'MW_VERSION', '${MEDIAWIKI_BRANCH}.1' );\n`);

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
