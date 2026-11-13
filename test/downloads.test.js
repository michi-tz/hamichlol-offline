// Downloading and unpacking the servers, against a local HTTP server that
// hands out small zip files shaped like the real downloads.

const { describe, it, before, after, beforeEach, afterEach } = require('mocha');
const { expect } = require('chai');
const fs = require('fs');
const http = require('http');
const path = require('path');
const AdmZip = require('adm-zip');

const {
  FAKE_DB_SERVER,
  CAN_RUN_FAKE_PROGRAMS,
  installFakeProgram,
  makeTempDir,
  removeDir,
  setEnv
} = require('./helpers');
const { DOWNLOADS } = require('../src/versions');
const { setDataPath, getPaths, getStatus, downloadServers, stopServers, _internal } = require('../src/server-manager');

// Read with Unix line endings whatever the checkout converted them to
const PHP_INI_DEVELOPMENT = Buffer.from(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'php.ini-development'), 'utf8').replace(/\r\n/g, '\n')
);
function zipOf(entries) {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(entries)) {
    zip.addFile(name, Buffer.isBuffer(content) ? content : Buffer.from(content));
  }
  return zip.toBuffer();
}

describe('Downloads', function() {
  this.timeout(30000);

  let tempDir;
  let server;
  let baseUrl;
  let files;       // URL path -> zip buffer (missing = 404)
  let requests;    // URL paths requested, in order
  let redirects;   // URL path -> path it redirects to
  let truncated;   // URL paths whose download is cut off half-way
  let restoreEnv;
  let savedUrls;

  before(async function() {
    server = http.createServer((request, response) => {
      requests.push(request.url);
      if (redirects[request.url]) {
        response.writeHead(302, { Location: redirects[request.url] });
        response.end();
        return;
      }
      const body = files[request.url];
      if (!body) {
        response.statusCode = 404;
        response.end('not found');
        return;
      }
      response.setHeader('Content-Type', 'application/zip');
      if (truncated.has(request.url)) {
        // Promise the whole file, send half and cut the connection
        response.setHeader('Content-Length', body.length);
        response.write(body.subarray(0, Math.floor(body.length / 2)), () => response.destroy());
        return;
      }
      response.end(body);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async function() {
    await new Promise(resolve => server.close(resolve));
    process.env.DEV_MODE = 'true';
  });

  beforeEach(function() {
    restoreEnv = setEnv({ DEV_MODE: 'false', HAMICHLOL_USE_SYSTEM: 'false' });
    tempDir = makeTempDir('download');
    setDataPath(tempDir);
    files = {};
    requests = [];
    redirects = {};
    truncated = new Set();
    savedUrls = {};
    for (const [name, entry] of Object.entries(DOWNLOADS)) {
      savedUrls[name] = entry.urls;
    }
  });

  afterEach(async function() {
    await stopServers();
    for (const [name, urls] of Object.entries(savedUrls)) {
      DOWNLOADS[name].urls = urls;
    }
    restoreEnv();
    removeDir(tempDir);
  });

  describe('Downloading and extracting one archive', function() {
    const { downloadAndExtract } = _internal;

    it('should extract the archive into the target folder', async function() {
      files['/a.zip'] = zipOf({ 'one.txt': '1', 'sub/two.txt': '2' });
      const target = path.join(tempDir, 'out');

      await downloadAndExtract([`${baseUrl}/a.zip`], target);

      expect(fs.readFileSync(path.join(target, 'one.txt'), 'utf8')).to.equal('1');
      expect(fs.readFileSync(path.join(target, 'sub', 'two.txt'), 'utf8')).to.equal('2');
    });

    it('should leave no zip or partial folder behind', async function() {
      files['/a.zip'] = zipOf({ 'one.txt': '1' });
      const target = path.join(tempDir, 'out');

      await downloadAndExtract([`${baseUrl}/a.zip`], target);

      expect(fs.readdirSync(tempDir)).to.deep.equal(['out']);
    });

    it('should strip the single top-level folder when asked to', async function() {
      files['/a.zip'] = zipOf({ 'product-1.2.3/index.php': 'x', 'product-1.2.3/lib/a.php': 'y' });
      const target = path.join(tempDir, 'out');

      await downloadAndExtract([`${baseUrl}/a.zip`], target, { stripRootFolder: true });

      expect(fs.readdirSync(target).sort()).to.deep.equal(['index.php', 'lib']);
    });

    it('should keep the layout when there is more than one top-level entry', async function() {
      files['/a.zip'] = zipOf({ 'a/one.txt': '1', 'b/two.txt': '2' });
      const target = path.join(tempDir, 'out');

      await downloadAndExtract([`${baseUrl}/a.zip`], target, { stripRootFolder: true });

      expect(fs.readdirSync(target).sort()).to.deep.equal(['a', 'b']);
    });

    it('should fall back to the next URL when one is unavailable', async function() {
      files['/archive/a.zip'] = zipOf({ 'one.txt': '1' });
      const target = path.join(tempDir, 'out');

      await downloadAndExtract([`${baseUrl}/current/a.zip`, `${baseUrl}/archive/a.zip`], target);

      expect(requests).to.deep.equal(['/current/a.zip', '/archive/a.zip']);
      expect(fs.existsSync(path.join(target, 'one.txt'))).to.be.true;
    });

    it('should not try further URLs once one worked', async function() {
      files['/current/a.zip'] = zipOf({ 'one.txt': '1' });

      await downloadAndExtract([`${baseUrl}/current/a.zip`, `${baseUrl}/archive/a.zip`], path.join(tempDir, 'out'));

      expect(requests).to.deep.equal(['/current/a.zip']);
    });

    it('should fail without leaving anything behind when no URL works', async function() {
      const target = path.join(tempDir, 'out');

      const error = await downloadAndExtract([`${baseUrl}/x.zip`, `${baseUrl}/y.zip`], target)
        .then(() => null, failure => failure);

      expect(error).to.be.an('error');
      expect(requests).to.deep.equal(['/x.zip', '/y.zip']);
      expect(fs.readdirSync(tempDir)).to.deep.equal([]);
    });

    it('should fail on a file that is not a zip archive, leaving nothing behind', async function() {
      files['/a.zip'] = Buffer.from('<html>captive portal</html>');
      const target = path.join(tempDir, 'out');

      const error = await downloadAndExtract([`${baseUrl}/a.zip`], target).then(() => null, failure => failure);

      expect(error).to.be.an('error');
      expect(fs.readdirSync(tempDir)).to.deep.equal([]);
    });

    it('should follow redirects', async function() {
      files['/real.zip'] = zipOf({ 'one.txt': '1' });
      redirects['/moved.zip'] = '/real.zip';
      const target = path.join(tempDir, 'out');

      await downloadAndExtract([`${baseUrl}/moved.zip`], target);

      expect(requests).to.deep.equal(['/moved.zip', '/real.zip']);
      expect(fs.existsSync(path.join(target, 'one.txt'))).to.be.true;
    });

    it('should say which HTTP error a failed download got', async function() {
      const error = await downloadAndExtract([`${baseUrl}/gone.zip`], path.join(tempDir, 'out'))
        .then(() => null, failure => failure);

      expect(error.message).to.include('404');
    });

    it('should fail when the connection drops in the middle of a file', async function() {
      truncated.add('/a.zip');
      files['/a.zip'] = zipOf({ 'one.txt': '1' });
      const target = path.join(tempDir, 'out');

      const error = await downloadAndExtract([`${baseUrl}/a.zip`], target).then(() => null, failure => failure);

      expect(error).to.be.an('error');
      expect(fs.readdirSync(tempDir)).to.deep.equal([]);
    });

    // An antivirus scanning a file that was just written can keep it locked
    describe('Files locked by another program (Windows)', function() {
      let platform;
      let restoreFs;
      let savedRetry;

      // Make fs[method] fail with `code` for paths ending in `suffix`, `times` times
      function lockFor(method, suffix, times, code = 'EPERM') {
        const original = fs[method];
        const calls = { failed: 0 };
        fs[method] = function(target, ...rest) {
          if (String(target).endsWith(suffix) && calls.failed < times) {
            calls.failed += 1;
            throw Object.assign(new Error(`${code}: operation not permitted, ${method} '${target}'`), { code });
          }
          return original.call(this, target, ...rest);
        };
        restoreFs = () => {
          fs[method] = original;
        };
        return calls;
      }

      beforeEach(function() {
        platform = Object.getOwnPropertyDescriptor(process, 'platform');
        savedRetry = { ..._internal.lockRetry };
        Object.assign(_internal.lockRetry, { attempts: 5, delayMs: 10 });
        files['/a.zip'] = zipOf({ 'product-1.0/index.php': 'x' });
      });

      afterEach(function() {
        Object.defineProperty(process, 'platform', platform);
        Object.assign(_internal.lockRetry, savedRetry);
        if (restoreFs) {
          restoreFs();
          restoreFs = null;
        }
      });

      const asWindows = () => Object.defineProperty(process, 'platform', { value: 'win32' });
      const asLinux = () => Object.defineProperty(process, 'platform', { value: 'linux' });

      it('should never need to read the archive back from disk', async function() {
        asWindows();
        // Even a file that stays locked for good does not matter
        const calls = lockFor('readFileSync', '.zip', Infinity);
        const target = path.join(tempDir, 'out');

        await downloadAndExtract([`${baseUrl}/a.zip`], target, { stripRootFolder: true });

        expect(calls.failed).to.equal(0);
        expect(fs.readdirSync(target)).to.deep.equal(['index.php']);
        expect(fs.readdirSync(tempDir)).to.deep.equal(['out']);
      });

      it('should wait for an extracted folder that cannot be moved yet', async function() {
        asWindows();
        const calls = lockFor('renameSync', 'product-1.0', 3, 'EBUSY');
        const target = path.join(tempDir, 'out');

        await downloadAndExtract([`${baseUrl}/a.zip`], target, { stripRootFolder: true });

        expect(calls.failed).to.equal(3);
        expect(fs.readdirSync(target)).to.deep.equal(['index.php']);
        expect(fs.readdirSync(tempDir)).to.deep.equal(['out']);
      });

      it('should explain a lock that does not go away, and leave nothing behind', async function() {
        asWindows();
        const calls = lockFor('renameSync', 'product-1.0', Infinity);
        const target = path.join(tempDir, 'out');

        const error = await downloadAndExtract([`${baseUrl}/a.zip`], target, { stripRootFolder: true })
          .then(() => null, failure => failure);

        expect(calls.failed).to.equal(5);
        expect(error.code).to.equal('EPERM');
        expect(error.message).to.include(target).and.to.include('אנטי-וירוס');
        expect(fs.readdirSync(tempDir)).to.deep.equal([]);
      });

      it('should not retry on other systems, where these errors mean a real permission problem', async function() {
        asLinux();
        const calls = lockFor('renameSync', 'product-1.0', Infinity);

        const error = await downloadAndExtract([`${baseUrl}/a.zip`], path.join(tempDir, 'out'), { stripRootFolder: true })
          .then(() => null, failure => failure);

        expect(calls.failed).to.equal(1);
        expect(error.code).to.equal('EPERM');
      });

      it('should not retry errors that are not locks', async function() {
        asWindows();
        const calls = lockFor('renameSync', 'product-1.0', Infinity, 'ENOSPC');

        const error = await downloadAndExtract([`${baseUrl}/a.zip`], path.join(tempDir, 'out'), { stripRootFolder: true })
          .then(() => null, failure => failure);

        expect(calls.failed).to.equal(1);
        expect(error.code).to.equal('ENOSPC');
      });
    });

    it('should replace an existing target folder completely', async function() {
      const target = path.join(tempDir, 'out');
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'stale.txt'), 'old');
      files['/a.zip'] = zipOf({ 'one.txt': '1' });

      await downloadAndExtract([`${baseUrl}/a.zip`], target);

      expect(fs.readdirSync(target)).to.deep.equal(['one.txt']);
    });

    it('should keep the existing target when the download fails', async function() {
      const target = path.join(tempDir, 'out');
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'keep.txt'), 'old');

      await downloadAndExtract([`${baseUrl}/missing.zip`], target).catch(() => {});

      expect(fs.readdirSync(target)).to.deep.equal(['keep.txt']);
    });

    it('should clean up leftovers of an interrupted earlier download', async function() {
      const target = path.join(tempDir, 'out');
      fs.mkdirSync(`${target}.partial`);
      fs.writeFileSync(path.join(`${target}.partial`, 'half.txt'), 'x');
      fs.writeFileSync(`${target}.zip`, 'truncated');
      files['/a.zip'] = zipOf({ 'one.txt': '1' });

      await downloadAndExtract([`${baseUrl}/a.zip`], target);

      expect(fs.readdirSync(tempDir)).to.deep.equal(['out']);
      expect(fs.readdirSync(target)).to.deep.equal(['one.txt']);
    });

    it('should run the prepare step before the folder appears, and abort if it fails', async function() {
      files['/a.zip'] = zipOf({ 'one.txt': '1' });
      const target = path.join(tempDir, 'out');
      const seen = [];

      await downloadAndExtract([`${baseUrl}/a.zip`], target, {
        prepare: (root, finalDir) => seen.push([fs.existsSync(path.join(root, 'one.txt')), fs.existsSync(finalDir), finalDir])
      });
      expect(seen).to.deep.equal([[true, false, target]]);

      const other = path.join(tempDir, 'other');
      const error = await downloadAndExtract([`${baseUrl}/a.zip`], other, {
        prepare: () => {
          throw new Error('prepare failed');
        }
      }).then(() => null, failure => failure);
      expect(error.message).to.equal('prepare failed');
      expect(fs.existsSync(other)).to.be.false;
    });
  });

  describe('Configuring the downloaded PHP', function() {
    const { configurePhpIni } = _internal;

    function configure(finalDir) {
      const source = path.join(tempDir, 'php');
      fs.mkdirSync(source);
      fs.writeFileSync(path.join(source, 'php.ini-development'), PHP_INI_DEVELOPMENT);
      configurePhpIni(source, finalDir);
      return fs.readFileSync(path.join(source, 'php.ini'), 'utf8');
    }

    it('should enable exactly the extensions MediaWiki needs', function() {
      const ini = configure(path.join(tempDir, 'final'));

      for (const extension of ['mysqli', 'intl', 'mbstring', 'fileinfo', 'openssl', 'gd']) {
        expect(ini, extension).to.match(new RegExp(`^extension=${extension}$`, 'm'));
      }
      for (const extension of ['bz2', 'curl', 'gettext', 'pdo_mysql', 'sodium']) {
        expect(ini, extension).to.match(new RegExp(`^;extension=${extension}$`, 'm'));
      }
      // A commented line with a trailing remark is not one of ours and stays as is
      expect(ini).to.include(';extension=exif      ; Must be after mbstring');
    });

    it('should point extension_dir at the folder PHP will finally run from', function() {
      const finalDir = path.join(tempDir, 'final dir');
      const ini = configure(finalDir);

      expect(ini).to.include(`extension_dir = "${path.join(finalDir, 'ext')}"`);
      // The Unix example line above it is left alone
      expect(ini).to.include(';extension_dir = "./"');
      expect(ini.match(/^extension_dir/gm)).to.have.lengthOf(1);
    });

    it('should leave the rest of the file untouched', function() {
      const ini = configure(path.join(tempDir, 'final'));

      expect(ini).to.include('memory_limit = 128M');
      expect(ini).to.include(';date.timezone =');
      expect(ini.split('\n')).to.have.lengthOf(PHP_INI_DEVELOPMENT.toString().split('\n').length);
    });

    it('should handle the Windows line endings of the real file', function() {
      const source = path.join(tempDir, 'php-crlf');
      const finalDir = path.join(tempDir, 'final');
      const original = PHP_INI_DEVELOPMENT.toString().replace(/\n/g, '\r\n');
      fs.mkdirSync(source);
      fs.writeFileSync(path.join(source, 'php.ini-development'), original);

      configurePhpIni(source, finalDir);
      const ini = fs.readFileSync(path.join(source, 'php.ini'), 'utf8');

      expect(ini).to.include('\r\nextension=mysqli\r\n');
      expect(ini).to.include('\r\nextension=gd\r\n');
      expect(ini).to.include(`\r\nextension_dir = "${path.join(finalDir, 'ext')}"\r\n`);
      // Every line still ends the same way and none was swallowed
      expect(ini.split('\r\n')).to.have.lengthOf(original.split('\r\n').length);
      expect(ini.replace(/\r\n/g, '')).to.not.include('\n');
    });

    it('should not treat special characters in the path as replacement patterns', function() {
      const finalDir = path.join(tempDir, "we$&ird $1 dir");
      expect(configure(finalDir)).to.include(`extension_dir = "${path.join(finalDir, 'ext')}"`);
    });

    it('should fail when the archive has no php.ini-development', function() {
      const source = path.join(tempDir, 'empty');
      fs.mkdirSync(source);
      expect(() => configurePhpIni(source, source)).to.throw();
      expect(fs.existsSync(path.join(source, 'php.ini'))).to.be.false;
    });
  });

  // The whole first step on a computer with nothing installed. Automatic
  // downloads exist for Windows only, so the platform is reported as win32
  // while downloadServers() runs.
  //
  // Files unpacked from a zip are not executable here, so the one program the
  // step has to run (the tool that creates the database) cannot come out of
  // an archive. Most tests therefore start with the database already created;
  // creating it is tested separately with an executable fake tool.
  describe('Downloading everything', function() {
    let platform;

    function createDatabaseFolder() {
      fs.mkdirSync(path.join(getPaths().dbDataDir, 'mysql'), { recursive: true });
    }

    function useArchives() {
      files['/php.zip'] = zipOf({
        'php.exe': 'MZ',
        'php.ini-development': PHP_INI_DEVELOPMENT,
        'ext/php_mysqli.dll': ''
      });
      files['/mariadb.zip'] = zipOf({
        'mariadb-9.9.9-winx64/bin/mariadbd.exe': 'MZ',
        'mariadb-9.9.9-winx64/bin/mariadb-install-db.exe': 'MZ',
        'mariadb-9.9.9-winx64/share/english/errmsg.sys': ''
      });
      files['/mediawiki.zip'] = zipOf({
        'mediawiki-9.9.9/index.php': '<?php',
        'mediawiki-9.9.9/maintenance/install.php': '<?php',
        'mediawiki-9.9.9/includes/Defines.php': "<?php\ndefine( 'MW_VERSION', '9.9.9' );\n"
      });
      DOWNLOADS.php.urls = [`${baseUrl}/php.zip`];
      DOWNLOADS.mariadb.urls = [`${baseUrl}/mariadb.zip`];
      DOWNLOADS.mediawiki.urls = [`${baseUrl}/mediawiki.zip`];
    }

    async function downloadAsWindows() {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      try {
        return await downloadServers();
      } finally {
        Object.defineProperty(process, 'platform', platform);
      }
    }

    before(function() {
      platform = Object.getOwnPropertyDescriptor(process, 'platform');
    });

    beforeEach(function() {
      useArchives();
      createDatabaseFolder();
    });

    it('should download and set up all three components', async function() {
      expect(getStatus()).to.include({ downloaded: false, installed: false });

      await downloadAsWindows();

      const paths = getPaths();
      expect(fs.existsSync(paths.phpExe)).to.be.true;
      expect(fs.existsSync(path.join(paths.mariadbDir, 'bin', 'mariadbd.exe'))).to.be.true;
      expect(fs.existsSync(path.join(paths.mariadbDir, 'share', 'english', 'errmsg.sys'))).to.be.true;
      expect(fs.existsSync(path.join(paths.mediaWikiPath, 'index.php'))).to.be.true;
      expect(fs.existsSync(path.join(paths.dbDataDir, 'mysql'))).to.be.true;
      expect(requests.sort()).to.deep.equal(['/mariadb.zip', '/mediawiki.zip', '/php.zip']);

      const status = getStatus();
      expect(status).to.include({ downloaded: true, installed: false, running: false });
      expect(status.tools.php).to.include({ source: 'bundled', version: DOWNLOADS.php.version, path: paths.phpExe });
      expect(status.tools.database).to.include({ source: 'bundled', version: DOWNLOADS.mariadb.version, flavor: 'mariadb' });
      expect(status.tools.mediawiki).to.include({ source: 'installed', version: '9.9.9' });
    });

    it('should install PHP and MariaDB into folders named after their versions', async function() {
      await downloadAsWindows();

      expect(fs.readdirSync(getPaths().serverPath).sort()).to.deep.equal([
        `mariadb-${DOWNLOADS.mariadb.version}`,
        `php-${DOWNLOADS.php.version}`
      ]);
    });

    it('should write a php.ini that points at the final PHP folder', async function() {
      await downloadAsWindows();

      const { phpIni, phpDir } = getPaths();
      const ini = fs.readFileSync(phpIni, 'utf8');
      expect(ini).to.include(`extension_dir = "${path.join(phpDir, 'ext')}"`);
      expect(ini).to.match(/^extension=mysqli$/m);
    });

    it('should report "not downloaded" until the database has been created', async function() {
      fs.rmSync(getPaths().dbDataDir, { recursive: true });
      await downloadAsWindows().catch(() => {}); // the unpacked tool cannot run here

      expect(fs.existsSync(getPaths().phpExe)).to.be.true;
      expect(getStatus().downloaded).to.be.false;
    });

    it('should create the database with the install tool of the downloaded server', async function() {
      if (!CAN_RUN_FAKE_PROGRAMS) {
        this.skip();
      }
      fs.rmSync(getPaths().dbDataDir, { recursive: true });
      // MariaDB is already in place, with a tool that can be executed
      installFakeProgram(path.join(getPaths().mariadbDir, 'bin', 'mariadbd.exe'), FAKE_DB_SERVER);
      installFakeProgram(path.join(getPaths().mariadbDir, 'bin', 'mariadb-install-db.exe'), FAKE_DB_SERVER);

      await downloadAsWindows();
      expect(requests.sort()).to.deep.equal(['/mediawiki.zip', '/php.zip']);

      const args = JSON.parse(fs.readFileSync(path.join(getPaths().dbDataDir, 'init-args.json'), 'utf8'));
      // The Windows tool takes the data folder only; it was created under a
      // temporary name and moved into place once complete
      expect(args).to.have.lengthOf(1);
      expect(args[0]).to.equal(`--datadir=${getPaths().dbDataDir}.partial`);
      expect(fs.existsSync(`${getPaths().dbDataDir}.partial`)).to.be.false;
    });

    it('should not download again what is already there', async function() {
      await downloadAsWindows();
      requests.length = 0;

      await downloadAsWindows();

      expect(requests).to.deep.equal([]);
    });

    it('should continue where an interrupted download stopped', async function() {
      delete files['/mariadb.zip'];
      const error = await downloadAsWindows().then(() => null, failure => failure);
      expect(error).to.be.an('error');
      expect(getStatus().downloaded).to.be.false;
      expect(fs.existsSync(getPaths().phpExe)).to.be.true;

      useArchives();
      requests.length = 0;
      await downloadAsWindows();

      // PHP was complete and is kept; only the rest is fetched
      expect(requests.sort()).to.deep.equal(['/mariadb.zip', '/mediawiki.zip']);
      expect(getStatus().downloaded).to.be.true;
    });

    it('should download PHP again when its configuration never finished', async function() {
      await downloadAsWindows();
      fs.rmSync(getPaths().phpIni);
      requests.length = 0;

      expect(getStatus().downloaded).to.be.false;
      await downloadAsWindows();

      expect(requests).to.deep.equal(['/php.zip']);
      expect(fs.existsSync(getPaths().phpIni)).to.be.true;
    });

    it('should use the fallback URL of a component whose first URL is gone', async function() {
      DOWNLOADS.php.urls = [`${baseUrl}/releases/php.zip`, `${baseUrl}/php.zip`];

      await downloadAsWindows();

      expect(requests).to.include('/releases/php.zip').and.to.include('/php.zip');
      expect(fs.existsSync(getPaths().phpExe)).to.be.true;
    });

    it('should never replace the files of an installed wiki', async function() {
      await downloadAsWindows();
      const { mediaWikiPath, localSettings } = getPaths();
      fs.writeFileSync(localSettings, '<?php // my wiki');
      fs.rmSync(path.join(mediaWikiPath, 'index.php'));
      requests.length = 0;

      const error = await downloadAsWindows().then(() => null, failure => failure);

      expect(error).to.be.an('error');
      expect(error.message).to.include('LocalSettings.php');
      expect(requests).to.deep.equal([]);
      expect(fs.readFileSync(localSettings, 'utf8')).to.equal('<?php // my wiki');
    });

    it('should keep the database when a new server version is downloaded', async function() {
      await downloadAsWindows();
      const marker = path.join(getPaths().dbDataDir, 'mysql', 'my-table.frm');
      fs.writeFileSync(marker, 'data');
      const oldDir = getPaths().mariadbDir;

      const savedVersion = DOWNLOADS.mariadb.version;
      DOWNLOADS.mariadb.version = '99.0.0';
      try {
        expect(getStatus().downloaded).to.be.false;
        await downloadAsWindows();

        expect(getPaths().mariadbDir).to.not.equal(oldDir);
        expect(fs.existsSync(path.join(getPaths().mariadbDir, 'bin', 'mariadbd.exe'))).to.be.true;
        expect(fs.existsSync(oldDir)).to.be.true;
        expect(fs.readFileSync(marker, 'utf8')).to.equal('data');
        expect(getStatus().downloaded).to.be.true;
      } finally {
        DOWNLOADS.mariadb.version = savedVersion;
      }
    });

    it('should refuse to download server programs on other systems', async function() {
      if (process.platform === 'win32') {
        this.skip();
      }
      const error = await downloadServers().then(() => null, failure => failure);

      expect(error).to.be.an('error');
      expect(error.message).to.include('Windows');
      expect(requests).to.deep.equal([]);
      expect(getStatus().canDownloadServers).to.be.false;
    });
  });
});
