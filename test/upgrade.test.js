// Upgrading an installed wiki to the MediaWiki version of src/versions.js, end
// to end with the fake PHP and database server. The new release is served as a
// small zip from a local HTTP server, like the real download.
//
// The fake update.php sends one statement ('ALTER TABLE fake_update') to the
// database, which the fake server logs in queries.log inside the database
// folder; whether that line is there shows which copy of the database is live.

const { describe, it, before, after, beforeEach, afterEach } = require('mocha');
const { expect } = require('chai');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');

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
  setEnv
} = require('./helpers');
const { DOWNLOADS } = require('../src/versions');
const serverManager = require('../src/server-manager');
const wikiSettings = require('../src/wiki-settings');

const { setDataPath, getPaths, getStatus, installMediaWiki, upgradeMediaWiki, recoverInterruptedUpgrade, startServers, stopServers } = serverManager;

const OLD_VERSION = '1.43.11';
const NEW_VERSION = DOWNLOADS.mediawiki.version;
const UPDATE_QUERY = 'ALTER TABLE fake_update';

function zipOf(entries) {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(entries)) {
    zip.addFile(name, Buffer.from(content));
  }
  return zip.toBuffer();
}

const defines = version => `<?php\ndefine( 'MW_VERSION', '${version}' );\n`;

// A release archive shaped like mediawiki-<version>.zip
function releaseZip(version, extra = {}) {
  const root = `mediawiki-${version}`;
  return zipOf({
    [`${root}/index.php`]: `<?php // ${version}`,
    [`${root}/includes/Defines.php`]: defines(version),
    [`${root}/maintenance/install.php`]: '<?php',
    [`${root}/maintenance/update.php`]: '<?php',
    [`${root}/maintenance/run.php`]: '<?php',
    [`${root}/composer.json`]: JSON.stringify({ require: { php: '>=8.3.0' } }),
    [`${root}/images/README`]: 'placeholder',
    [`${root}/cache/.htaccess`]: 'Require all denied',
    [`${root}/extensions/Cite/extension.json`]: '{}',
    [`${root}/skins/Vector/skin.json`]: '{}',
    ...extra
  });
}

describe('Upgrading an installed wiki', function() {
  this.timeout(30000);

  let tempDir;
  let restoreEnv;
  let server;
  let baseUrl;
  let files;
  let requests;
  let savedUrls;

  const queries = () => readLines(path.join(getPaths().dbDataDir, 'queries.log'));
  const version = () => getStatus().tools.mediawiki.version;
  const failure = promise => promise.then(() => null, error => error);
  const leftovers = () => fs.readdirSync(tempDir).filter(name => /upgrade|\.partial$|\.tmp$/.test(name));

  // Servers in the data folder, and a wiki installed with OLD_VERSION, with an
  // upload, a cache, and an extension the old release shipped
  async function createInstalledWiki() {
    const paths = getPaths();
    installFakeProgram(paths.phpExe, FAKE_PHP);
    fs.writeFileSync(paths.phpIni, '');
    installFakeProgram(path.join(paths.mariadbDir, 'bin', 'mariadbd.exe'), FAKE_DB_SERVER);
    installFakeProgram(path.join(paths.mariadbDir, 'bin', 'mariadb-install-db.exe'), FAKE_DB_SERVER);
    fs.mkdirSync(path.join(paths.dbDataDir, 'mysql'), { recursive: true });
    const mw = paths.mediaWikiPath;
    for (const dir of ['maintenance', 'includes', 'images/a/ab', 'cache', 'extensions/Interwiki', 'skins/Vector']) {
      fs.mkdirSync(path.join(mw, dir), { recursive: true });
    }
    fs.writeFileSync(path.join(mw, 'index.php'), `<?php // ${OLD_VERSION}`);
    fs.writeFileSync(path.join(mw, 'maintenance', 'install.php'), '');
    fs.writeFileSync(path.join(mw, 'includes', 'Defines.php'), defines(OLD_VERSION));
    fs.writeFileSync(path.join(mw, 'extensions', 'Interwiki', 'extension.json'), '{}');
    fs.writeFileSync(path.join(mw, 'skins', 'Vector', 'skin.json'), '{"old":true}');

    await installMediaWiki(VALID_CONFIG);
    // As install.php writes it: all bundled skins
    fs.appendFileSync(paths.localSettings, "wfLoadSkin( 'Vector' );\n");
    fs.writeFileSync(path.join(mw, 'images', 'a', 'ab', 'Upload.png'), 'picture');
    fs.writeFileSync(path.join(mw, 'cache', 'l10n_cache-he.cdb'), 'old cache');
  }

  // Everything that must survive a failed or undone upgrade unchanged
  function snapshot() {
    const { mediaWikiPath, localSettings, dbDataDir } = getPaths();
    return {
      index: fs.readFileSync(path.join(mediaWikiPath, 'index.php'), 'utf8'),
      version: version(),
      localSettings: fs.readFileSync(localSettings, 'utf8'),
      upload: fs.readFileSync(path.join(mediaWikiPath, 'images', 'a', 'ab', 'Upload.png'), 'utf8'),
      extensions: fs.readdirSync(path.join(mediaWikiPath, 'extensions')).sort(),
      database: fs.readdirSync(dbDataDir).sort(),
      queries: queries()
    };
  }

  before(async function() {
    if (!CAN_RUN_FAKE_PROGRAMS) {
      this.skip();
    }
    server = http.createServer((request, response) => {
      requests.push(request.url);
      const body = files[request.url];
      if (!body) {
        response.statusCode = 404;
        response.end('not found');
        return;
      }
      response.setHeader('Content-Type', 'application/zip');
      response.end(body);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async function() {
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }
    process.env.DEV_MODE = 'true';
  });

  beforeEach(async function() {
    restoreEnv = setEnv({ DEV_MODE: 'false', HAMICHLOL_USE_SYSTEM: 'false' });
    tempDir = makeTempDir('upgrade');
    setDataPath(tempDir);
    files = { '/mediawiki.zip': releaseZip(NEW_VERSION) };
    requests = [];
    savedUrls = DOWNLOADS.mediawiki.urls;
    DOWNLOADS.mediawiki.urls = [`${baseUrl}/mediawiki.zip`];
    await createInstalledWiki();
  });

  afterEach(async function() {
    await stopServers();
    DOWNLOADS.mediawiki.urls = savedUrls;
    for (const name of ['FAKE_PHP_UPDATE_FAILS', 'FAKE_PHP_UPDATE_HANGS', 'FAKE_PHP_UPDATE_THEN_MKDIR']) {
      delete process.env[name];
    }
    restoreEnv();
    removeDir(tempDir);
  });

  describe('Offering the upgrade', function() {
    it('should offer an upgrade for a wiki installed with an older MediaWiki', function() {
      expect(getStatus()).to.include({ installed: true, downloaded: true });
      expect(getStatus().upgrade).to.deep.equal({ from: OLD_VERSION, to: NEW_VERSION });
    });

    it('should offer nothing for a wiki that is not installed yet', function() {
      fs.rmSync(getPaths().localSettings);
      expect(getStatus().upgrade).to.be.null;
    });

    it('should offer nothing when the version cannot be read', function() {
      fs.rmSync(path.join(getPaths().mediaWikiPath, 'includes', 'Defines.php'));
      expect(getStatus().upgrade).to.be.null;
    });
  });

  describe('A successful upgrade', function() {
    it('should replace the MediaWiki code and keep the wiki\'s own files', async function() {
      const before = snapshot();

      await upgradeMediaWiki();

      const { mediaWikiPath, localSettings } = getPaths();
      expect(version()).to.equal(NEW_VERSION);
      expect(fs.readFileSync(path.join(mediaWikiPath, 'index.php'), 'utf8')).to.equal(`<?php // ${NEW_VERSION}`);
      expect(fs.readFileSync(localSettings, 'utf8')).to.equal(before.localSettings);
      expect(fs.readFileSync(path.join(mediaWikiPath, 'images', 'a', 'ab', 'Upload.png'), 'utf8')).to.equal('picture');
      // The release's placeholder images folder does not replace the uploads
      expect(fs.existsSync(path.join(mediaWikiPath, 'images', 'README'))).to.be.false;
      // Extensions and skins are the new release's
      expect(fs.readdirSync(path.join(mediaWikiPath, 'extensions'))).to.deep.equal(['Cite']);
      expect(fs.readFileSync(path.join(mediaWikiPath, 'skins', 'Vector', 'skin.json'), 'utf8')).to.equal('{}');
      // The old cache is dropped
      expect(fs.existsSync(path.join(mediaWikiPath, 'cache', 'l10n_cache-he.cdb'))).to.be.false;
      expect(fs.existsSync(path.join(mediaWikiPath, 'cache'))).to.be.true;
      expect(getStatus().upgrade).to.be.null;
      expect(requests).to.deep.equal(['/mediawiki.zip']);
    });

    it('should run the schema update through run.php with the database running', async function() {
      await upgradeMediaWiki();

      const { mediaWikiPath, phpIni, dbDataDir } = getPaths();
      const update = readJson(path.join(mediaWikiPath, 'update-args.json'));
      expect(update.args).to.deep.equal(['-c', phpIni, path.join(mediaWikiPath, 'maintenance', 'run.php'), 'update', '--quick']);
      // The port the database server was started with
      expect(readJson(path.join(dbDataDir, 'args.json'))).to.include(`--port=${update.dbPort}`);
      // The update reached the live database, which was shut down cleanly afterwards
      expect(queries()).to.include(UPDATE_QUERY);
      expect(queries().slice(-1)).to.deep.equal(['SHUTDOWN']);
      expect(getStatus().running).to.be.false;
      expect(fs.existsSync(getPaths().runStateFile)).to.be.false;
    });

    it('should run update.php itself when the release has no run.php', async function() {
      const zip = new AdmZip(releaseZip(NEW_VERSION));
      zip.deleteFile(`mediawiki-${NEW_VERSION}/maintenance/run.php`);
      files['/mediawiki.zip'] = zip.toBuffer();

      await upgradeMediaWiki();

      const { args } = readJson(path.join(getPaths().mediaWikiPath, 'update-args.json'));
      expect(args.slice(2)).to.deep.equal([path.join(getPaths().mediaWikiPath, 'maintenance', 'update.php'), '--quick']);
    });

    it('should leave neither the old version nor the database copy behind', async function() {
      await upgradeMediaWiki();

      expect(leftovers()).to.deep.equal([]);
      expect(fs.readdirSync(tempDir).sort()).to.deep.equal(['database', 'mediawiki', 'server']);
    });

    it('should leave a wiki the servers run as before', async function() {
      await upgradeMediaWiki();
      const ports = await startServers();

      const info = await (await fetch(`http://127.0.0.1:${ports.phpPort}/`)).json();
      expect(info.docroot).to.equal(getPaths().mediaWikiPath);
      expect(info.dbPort).to.equal(String(ports.mysqlPort));
    });

    it('should keep uploads apart from the old tree: hard links, never the same folder', async function() {
      if (process.platform === 'win32') {
        this.skip();
      }
      const upload = path.join(getPaths().mediaWikiPath, 'images', 'a', 'ab', 'Upload.png');
      const inode = fs.statSync(upload).ino;

      await upgradeMediaWiki();

      // The same file content, without copying it
      expect(fs.statSync(upload).ino).to.equal(inode);
    });
  });

  describe('The app\'s extensions and settings', function() {
    // A wiki installed by an earlier version of the app: no settings file and
    // no include line, as the 1.43 wikis out there are
    function asInstalledByEarlierVersion() {
      const { localSettings, mediaWikiPath } = getPaths();
      const source = fs.readFileSync(localSettings, 'utf8').replace(/\n# Added by Hamichlol Offline: extensions[\s\S]*$/, '\n');
      fs.writeFileSync(localSettings, source);
      fs.rmSync(path.join(mediaWikiPath, wikiSettings.SETTINGS_FILE), { force: true });
      return source;
    }

    it('should be written for the new release and covered by the upgrade\'s schema update', async function() {
      const own = asInstalledByEarlierVersion();

      await upgradeMediaWiki();

      const { mediaWikiPath, localSettings } = getPaths();
      const settings = fs.readFileSync(path.join(mediaWikiPath, wikiSettings.SETTINGS_FILE), 'utf8');
      // The new release's extensions (its zip has Cite)
      expect(settings).to.equal(wikiSettings.buildSettings(mediaWikiPath));
      expect(settings).to.include("'Cite',");
      const local = fs.readFileSync(localSettings, 'utf8');
      expect(local.startsWith(own.trimEnd())).to.be.true;
      expect(local).to.include(`require_once "$IP/${wikiSettings.SETTINGS_FILE}";`);
      expect(wikiSettings.readSchemaStamp(mediaWikiPath)).to.equal(wikiSettings.settingsHash(settings));
      expect(queries().filter(sql => sql === UPDATE_QUERY)).to.have.lengthOf(1);

      // update.php ran during the upgrade, so the first start does not repeat it
      await startServers();
      expect(queries().filter(sql => sql === UPDATE_QUERY)).to.have.lengthOf(1);
    });

    it('should unblock sync after a failed update of the settings once an upgrade succeeds, and only then', async function() {
      // The first start's update of the settings fails: the wiki runs without them
      process.env.FAKE_PHP_UPDATE_FAILS = '1';
      await startServers();
      await stopServers();
      expect(getStatus().syncBlocked).to.include({ reason: 'settings-update-failed' });

      await failure(upgradeMediaWiki());
      expect(getStatus().syncBlocked).to.include({ reason: 'settings-update-failed' });
      delete process.env.FAKE_PHP_UPDATE_FAILS;

      // The upgrade's update.php covers the settings of the new release
      await upgradeMediaWiki();
      expect(getStatus().syncBlocked).to.be.null;
      const { mediaWikiPath } = getPaths();
      expect(fs.readFileSync(getPaths().localSettings, 'utf8')).to.include(`require_once "$IP/${wikiSettings.SETTINGS_FILE}";`);
      expect(wikiSettings.readSchemaStamp(mediaWikiPath))
        .to.equal(wikiSettings.settingsHash(fs.readFileSync(path.join(mediaWikiPath, wikiSettings.SETTINGS_FILE), 'utf8')));
    });

    it('should leave the old wiki without them when the upgrade fails', async function() {
      asInstalledByEarlierVersion();
      const before = snapshot();
      process.env.FAKE_PHP_UPDATE_FAILS = '1';

      await failure(upgradeMediaWiki());

      expect(snapshot()).to.deep.equal(before);
      expect(fs.existsSync(path.join(getPaths().mediaWikiPath, wikiSettings.SETTINGS_FILE))).to.be.false;
    });
  });

  describe('A failed upgrade', function() {
    it('should keep the old wiki and its database when update.php fails', async function() {
      const before = snapshot();
      process.env.FAKE_PHP_UPDATE_FAILS = '1';

      const error = await failure(upgradeMediaWiki());

      expect(error.message).to.include('update.php').and.to.include('table mw_fake is broken');
      expect(error.message).to.include(`הוויקי נשאר בגרסה ${OLD_VERSION}`);
      const after = snapshot();
      expect(after).to.deep.equal(before);
      // The update had reached the database; the copy taken before it is back
      expect(after.queries).to.not.include(UPDATE_QUERY);
      expect(leftovers()).to.deep.equal([]);
      expect(getStatus().upgrade).to.deep.equal({ from: OLD_VERSION, to: NEW_VERSION });
      expect(getStatus().running).to.be.false;
    });

    it('should be able to start the old wiki, and to upgrade again, after a failure', async function() {
      process.env.FAKE_PHP_UPDATE_FAILS = '1';
      await failure(upgradeMediaWiki());
      delete process.env.FAKE_PHP_UPDATE_FAILS;

      const ports = await startServers();
      expect((await fetch(`http://127.0.0.1:${ports.phpPort}/`)).status).to.equal(200);
      await stopServers();

      await upgradeMediaWiki();
      expect(version()).to.equal(NEW_VERSION);
    });

    it('should restore the database too when the journal of the last phase cannot be written', async function() {
      const before = snapshot();
      // update.php succeeds, then a folder in the way makes the "cleanup" journal unwritable
      process.env.FAKE_PHP_UPDATE_THEN_MKDIR = `${getPaths().upgradeJournal}.tmp`;

      const error = await failure(upgradeMediaWiki());

      expect(error).to.be.an('error');
      expect(error.message).to.include(`הוויקי נשאר בגרסה ${OLD_VERSION}`);
      const after = snapshot();
      expect(after).to.deep.equal(before);
      // Old code with the old database: the update's change is gone
      expect(after.queries).to.not.include(UPDATE_QUERY);
      expect(leftovers()).to.deep.equal([]);
    });

    it('should stop a database server left by a crashed run before copying the database', async function() {
      const { mariadbDir, dbDataDir, runStateFile } = getPaths();
      const exe = path.join(mariadbDir, 'bin', 'mariadbd.exe');
      const marker = `--datadir=${dbDataDir}`;
      const port = await require('portfinder').getPortPromise({ port: 33306 });
      const stale = spawn(exe, ['--no-defaults', marker, `--port=${port}`, '--bind-address=127.0.0.1'], { stdio: 'ignore' });
      try {
        // Running and listening, as a crashed run leaves it (its args.json
        // proves nothing: the installation's own server already wrote one)
        expect(await waitFor(() => new Promise(resolve => {
          const socket = require('net').connect({ host: '127.0.0.1', port }, () => {
            socket.destroy();
            resolve(true);
          });
          socket.once('error', () => resolve(false));
        }))).to.be.true;
        fs.writeFileSync(runStateFile, JSON.stringify({ mysql: { pid: stale.pid, port, exe, marker } }));
        // The download fails, so the upgrade never gets as far as starting its
        // own database server: only a check before the copy stops the stale one
        delete files['/mediawiki.zip'];

        const error = await failure(upgradeMediaWiki());

        expect(error.message).to.include('404');
        expect(await waitFor(() => !isAlive(stale.pid))).to.be.true;
        expect(fs.existsSync(runStateFile)).to.be.false;

        files['/mediawiki.zip'] = releaseZip(NEW_VERSION);
        await upgradeMediaWiki();
        expect(version()).to.equal(NEW_VERSION);
      } finally {
        if (isAlive(stale.pid)) {
          stale.kill('SIGKILL');
        }
      }
    });

    it('should refuse, changing nothing, while a stale database server cannot be stopped', async function() {
      const { mariadbDir, dbDataDir, runStateFile } = getPaths();
      const exe = path.join(mariadbDir, 'bin', 'mariadbd.exe');
      // A process that is alive but whose command line cannot be read: it is
      // neither confirmed as ours nor as gone, so it is left alone
      const pid = 4194000;
      fs.writeFileSync(runStateFile, JSON.stringify({ mysql: { pid, port: 1, exe, marker: `--datadir=${dbDataDir}` } }));
      const before = snapshot();
      const realKill = process.kill;
      process.kill = (target, signal) => {
        if (target === pid) {
          const error = new Error('Operation not permitted');
          error.code = 'EPERM';
          throw error;
        }
        return realKill.call(process, target, signal);
      };
      let error;
      try {
        error = await failure(upgradeMediaWiki());
      } finally {
        process.kill = realKill;
      }

      expect(error.message).to.include('שרת מסד נתונים מהפעלה קודמת');
      expect(requests).to.deep.equal([]);
      expect(snapshot()).to.deep.equal(before);
      expect(leftovers()).to.deep.equal([]);
      expect(readJson(runStateFile).mysql.pid).to.equal(pid);
      fs.rmSync(runStateFile);
    });

    it('should keep the old wiki when the download fails', async function() {
      const before = snapshot();
      delete files['/mediawiki.zip'];

      const error = await failure(upgradeMediaWiki());

      expect(error.message).to.include('404');
      expect(snapshot()).to.deep.equal(before);
      expect(leftovers()).to.deep.equal([]);
    });

    it('should refuse a release that does not contain MediaWiki', async function() {
      files['/mediawiki.zip'] = zipOf({ 'something/readme.txt': 'not MediaWiki' });
      const before = snapshot();

      const error = await failure(upgradeMediaWiki());

      expect(error.message).to.include('אינם התקנת MediaWiki שלמה');
      expect(snapshot()).to.deep.equal(before);
      expect(leftovers()).to.deep.equal([]);
    });

    it('should refuse when LocalSettings.php loads an extension the new release lacks', async function() {
      fs.appendFileSync(getPaths().localSettings, "wfLoadExtension( 'Interwiki' );\nwfLoadExtensions( [ 'Cite', \"Gadgets\" ] );\n");
      const before = snapshot();

      const error = await failure(upgradeMediaWiki());

      expect(error.message).to.include('Interwiki, Gadgets').and.to.include('LocalSettings.php');
      expect(error.message).to.not.include('Cite');
      expect(snapshot()).to.deep.equal(before);
      // Refused before the database was touched
      expect(queries()).to.not.include(UPDATE_QUERY);
      expect(leftovers()).to.deep.equal([]);
    });

    it('should refuse a release that needs a newer PHP than the one in use', async function() {
      files['/mediawiki.zip'] = releaseZip(NEW_VERSION, {
        [`mediawiki-${NEW_VERSION}/composer.json`]: JSON.stringify({ require: { php: '>=99.0.0' } })
      });
      const before = snapshot();

      const error = await failure(upgradeMediaWiki());

      expect(error.message).to.include('PHP 99.0.0');
      expect(snapshot()).to.deep.equal(before);
    });

    it('should refuse while the servers are running, without touching anything', async function() {
      await startServers();
      const before = snapshot();

      const error = await failure(upgradeMediaWiki());

      expect(error.message).to.include('יש לעצור את השרתים');
      expect(requests).to.deep.equal([]);
      expect(snapshot()).to.deep.equal(before);
      expect(getStatus().running).to.be.true;
    });

    it('should refuse a wiki that is not installed', async function() {
      fs.rmSync(getPaths().localSettings);

      const error = await failure(upgradeMediaWiki());

      expect(error.message).to.include('עדיין לא הותקן');
      expect(requests).to.deep.equal([]);
    });
  });

  describe('Never downgrading', function() {
    for (const [name, installed] of [['a newer branch', '9.0.0'], ['a newer release of the branch', `${NEW_VERSION.split('.').slice(0, 2).join('.')}.99`]]) {
      it(`should leave a wiki of ${name} alone`, async function() {
        fs.writeFileSync(path.join(getPaths().mediaWikiPath, 'includes', 'Defines.php'), defines(installed));
        expect(getStatus().upgrade).to.be.null;

        const error = await failure(upgradeMediaWiki());

        expect(error.message).to.include('שדרוג לאחור אינו נתמך');
        expect(requests).to.deep.equal([]);
        expect(version()).to.equal(installed);
      });
    }

    it('should say so when the wiki is already up to date', async function() {
      fs.writeFileSync(path.join(getPaths().mediaWikiPath, 'includes', 'Defines.php'), defines(NEW_VERSION));

      const error = await failure(upgradeMediaWiki());

      expect(error.message).to.include(`כבר בגרסה ${NEW_VERSION}`);
      expect(requests).to.deep.equal([]);
    });

    it('should refuse a downloaded release that is not newer than the wiki', async function() {
      files['/mediawiki.zip'] = releaseZip('1.43.2');
      const before = snapshot();

      const error = await failure(upgradeMediaWiki());

      expect(error.message).to.include('1.43.2').and.to.include('שדרוג לאחור אינו נתמך');
      expect(snapshot()).to.deep.equal(before);
      expect(leftovers()).to.deep.equal([]);
    });
  });

  // The app may die at any point. The on-disk state of each phase is built
  // here as the upgrade leaves it, and recovered as the next start does.
  describe('Recovery after an interruption', function() {
    const journal = phase => fs.writeFileSync(getPaths().upgradeJournal, JSON.stringify({ from: OLD_VERSION, to: NEW_VERSION, phase }));

    // The new tree and the database copy, as the "prepare" phase makes them
    function prepare() {
      const { mediaWikiNew, mediaWikiPath, dbDataDir, dbBackup } = getPaths();
      new AdmZip(releaseZip(NEW_VERSION)).extractAllTo(`${mediaWikiNew}.tmp`, true);
      fs.renameSync(path.join(`${mediaWikiNew}.tmp`, `mediawiki-${NEW_VERSION}`), mediaWikiNew);
      fs.rmSync(`${mediaWikiNew}.tmp`, { recursive: true });
      fs.copyFileSync(path.join(mediaWikiPath, 'LocalSettings.php'), path.join(mediaWikiNew, 'LocalSettings.php'));
      fs.cpSync(dbDataDir, dbBackup, { recursive: true });
    }

    it('should do nothing when no upgrade was under way', async function() {
      const before = snapshot();
      expect(await recoverInterruptedUpgrade()).to.be.null;
      expect(snapshot()).to.deep.equal(before);
    });

    it('should throw away a half-prepared upgrade', async function() {
      const before = snapshot();
      const { mediaWikiNew, dbBackup } = getPaths();
      journal('prepare');
      fs.mkdirSync(`${mediaWikiNew}.partial`, { recursive: true });
      fs.mkdirSync(mediaWikiNew, { recursive: true });
      fs.mkdirSync(`${dbBackup}.partial`, { recursive: true });

      expect(await recoverInterruptedUpgrade()).to.deep.equal({ from: OLD_VERSION, to: NEW_VERSION, completed: false });

      expect(snapshot()).to.deep.equal(before);
      expect(leftovers()).to.deep.equal([]);
    });

    it('should put the old tree back when only the first rename was done', async function() {
      const before = snapshot();
      prepare();
      journal('swap');
      fs.renameSync(getPaths().mediaWikiPath, getPaths().mediaWikiOld);
      expect(getStatus().installed).to.be.false;

      await recoverInterruptedUpgrade();

      expect(snapshot()).to.deep.equal(before);
      expect(leftovers()).to.deep.equal([]);
    });

    it('should put the old tree back when both renames were done', async function() {
      const before = snapshot();
      prepare();
      journal('swap');
      fs.renameSync(getPaths().mediaWikiPath, getPaths().mediaWikiOld);
      fs.renameSync(getPaths().mediaWikiNew, getPaths().mediaWikiPath);
      expect(version()).to.equal(NEW_VERSION);

      await recoverInterruptedUpgrade();

      expect(snapshot()).to.deep.equal(before);
      expect(leftovers()).to.deep.equal([]);
    });

    it('should restore the database when update.php was cut off', async function() {
      const before = snapshot();
      prepare();
      journal('update');
      fs.renameSync(getPaths().mediaWikiPath, getPaths().mediaWikiOld);
      fs.renameSync(getPaths().mediaWikiNew, getPaths().mediaWikiPath);
      // What update.php changed before it was stopped
      fs.appendFileSync(path.join(getPaths().dbDataDir, 'queries.log'), `${UPDATE_QUERY}\n`);
      fs.writeFileSync(path.join(getPaths().dbDataDir, 'ib_new_table'), '');

      await recoverInterruptedUpgrade();

      expect(snapshot()).to.deep.equal(before);
      expect(leftovers()).to.deep.equal([]);
    });

    it('should finish the restore of the database if it was itself cut off', async function() {
      const before = snapshot();
      prepare();
      journal('update');
      fs.renameSync(getPaths().mediaWikiPath, getPaths().mediaWikiOld);
      fs.renameSync(getPaths().mediaWikiNew, getPaths().mediaWikiPath);
      // Cut off between removing the changed database and moving the copy back
      fs.rmSync(getPaths().dbDataDir, { recursive: true });

      await recoverInterruptedUpgrade();

      expect(snapshot()).to.deep.equal(before);
    });

    it('should complete an upgrade whose update had succeeded', async function() {
      prepare();
      fs.renameSync(getPaths().mediaWikiPath, getPaths().mediaWikiOld);
      fs.renameSync(getPaths().mediaWikiNew, getPaths().mediaWikiPath);
      journal('cleanup');

      expect(await recoverInterruptedUpgrade()).to.deep.equal({ from: OLD_VERSION, to: NEW_VERSION, completed: true });

      expect(version()).to.equal(NEW_VERSION);
      expect(fs.existsSync(getPaths().localSettings)).to.be.true;
      expect(leftovers()).to.deep.equal([]);
    });

    it('should recover by itself before the servers are started', async function() {
      const before = snapshot();
      prepare();
      journal('swap');
      fs.renameSync(getPaths().mediaWikiPath, getPaths().mediaWikiOld);

      const ports = await startServers();

      expect((await fetch(`http://127.0.0.1:${ports.phpPort}/`)).status).to.equal(200);
      await stopServers();
      expect(snapshot().index).to.equal(before.index);
      expect(leftovers()).to.deep.equal([]);
    });

    it('should refuse to guess when the journal is damaged', async function() {
      prepare();
      fs.writeFileSync(getPaths().upgradeJournal, '{"phase": "somethin');

      const error = await failure(recoverInterruptedUpgrade());
      expect(error.message).to.include('פגום');
      // Nothing is started on a wiki in an unknown state
      expect((await failure(startServers())).message).to.include('פגום');
      expect(fs.existsSync(getPaths().mediaWikiNew)).to.be.true;
    });

    it('should recover from the app being killed while update.php runs', async function() {
      const before = snapshot();
      // The upgrade runs in a separate process, which is killed half-way
      const script = `
        process.env.DEV_MODE = 'false';
        const serverManager = require(${JSON.stringify(require.resolve('../src/server-manager'))});
        const { DOWNLOADS } = require(${JSON.stringify(require.resolve('../src/versions'))});
        DOWNLOADS.mediawiki.urls = [${JSON.stringify(`${baseUrl}/mediawiki.zip`)}];
        serverManager.setDataPath(${JSON.stringify(tempDir)});
        serverManager.upgradeMediaWiki().then(() => console.log('finished'), error => console.log(error.message));
      `;
      const child = spawn(process.execPath, ['-e', script], {
        env: { ...process.env, FAKE_PHP_UPDATE_HANGS: '1' },
        stdio: 'ignore'
      });
      const updateArgs = path.join(getPaths().mediaWikiPath, 'update-args.json');
      try {
        expect(await waitFor(() => fs.existsSync(updateArgs) && queries().includes(UPDATE_QUERY), 15000)).to.be.true;
        expect(readJson(getPaths().upgradeJournal).phase).to.equal('update');
      } finally {
        child.kill('SIGKILL');
      }
      await waitFor(() => !isAlive(child.pid));
      // The database server it started outlived it
      const leftover = readJson(getPaths().runStateFile).mysql;
      expect(isAlive(leftover.pid)).to.be.true;

      const recovered = await recoverInterruptedUpgrade();

      expect(recovered).to.include({ completed: false });
      expect(await waitFor(() => !isAlive(leftover.pid))).to.be.true;
      const after = snapshot();
      expect(after.index).to.equal(before.index);
      expect(after.version).to.equal(OLD_VERSION);
      expect(after.localSettings).to.equal(before.localSettings);
      expect(after.upload).to.equal(before.upload);
      expect(after.queries).to.not.include(UPDATE_QUERY);
      expect(leftovers()).to.deep.equal([]);

      // And the next upgrade succeeds
      await upgradeMediaWiki();
      expect(version()).to.equal(NEW_VERSION);
    });
  });

  describe('Reading LocalSettings.php', function() {
    const { loadedExtensions } = serverManager._internal;

    it('should find extensions and skins in every form of the load functions', function() {
      const source = [
        '<?php',
        "wfLoadSkin( 'Vector' );",
        "wfLoadExtension( \"ParserFunctions\" );",
        "wfLoadExtensions( [ 'Cite', 'Scribunto' ] );",
        "wfLoadSkins( [\n\t'MonoBook',\n\t'Timeless'\n] );",
        "# wfLoadExtension( 'Disabled' );",
        "  // wfLoadExtension( 'AlsoDisabled' );",
        ''
      ].join('\n');

      expect(loadedExtensions(source)).to.deep.equal([
        { folder: 'skins', name: 'Vector' },
        { folder: 'extensions', name: 'ParserFunctions' },
        { folder: 'extensions', name: 'Cite' },
        { folder: 'extensions', name: 'Scribunto' },
        { folder: 'skins', name: 'MonoBook' },
        { folder: 'skins', name: 'Timeless' }
      ]);
    });
  });
});

// A MediaWiki folder that was set up but never installed holds no wiki, so an
// older branch there is simply replaced by the version this app installs.
describe('An older MediaWiki that was never installed', function() {
  this.timeout(30000);

  let tempDir;
  let restoreEnv;

  before(function() {
    if (!CAN_RUN_FAKE_PROGRAMS) {
      this.skip();
    }
  });

  beforeEach(function() {
    restoreEnv = setEnv({ DEV_MODE: 'false', HAMICHLOL_USE_SYSTEM: 'false' });
    tempDir = makeTempDir('outdated');
    setDataPath(tempDir);
    const mw = getPaths().mediaWikiPath;
    fs.mkdirSync(path.join(mw, 'includes'), { recursive: true });
    fs.writeFileSync(path.join(mw, 'index.php'), '');
  });

  afterEach(function() {
    restoreEnv();
    removeDir(tempDir);
    process.env.DEV_MODE = 'true';
  });

  const setVersion = version =>
    fs.writeFileSync(path.join(getPaths().mediaWikiPath, 'includes', 'Defines.php'), defines(version));

  it('should be downloaded again when it is of an older branch', function() {
    setVersion(OLD_VERSION);
    expect(getStatus().tools.mediawiki).to.include({ source: 'download', version: NEW_VERSION });
  });

  it('should be kept when it is of the pinned branch, or newer', function() {
    const branch = NEW_VERSION.split('.').slice(0, 2).join('.');
    for (const version of [`${branch}.0`, NEW_VERSION, '9.0.0']) {
      setVersion(version);
      expect(getStatus().tools.mediawiki, version).to.include({ source: 'installed', version });
    }
  });

  it('should be kept once a wiki is installed in it, to be upgraded instead', function() {
    setVersion(OLD_VERSION);
    fs.writeFileSync(getPaths().localSettings, '<?php');
    expect(getStatus().tools.mediawiki).to.include({ source: 'installed', version: OLD_VERSION });
    expect(getStatus().upgrade).to.deep.equal({ from: OLD_VERSION, to: NEW_VERSION });
  });
});
