// Building blocks of the server manager that the larger flows only touch in
// passing: recognising our own processes, talking to the database, copying an
// installed MediaWiki and the options a database server is started with.

const { describe, it, before, beforeEach, afterEach, after } = require('mocha');
const { expect } = require('chai');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const {
  FAKE_DB_SERVER,
  CAN_RUN_FAKE_PROGRAMS,
  VALID_CONFIG,
  makeTempDir,
  removeDir,
  installFakeProgram,
  isAlive,
  delay,
  waitFor,
  readLines,
  setEnv
} = require('./helpers');
const {
  setDataPath,
  getPaths,
  dbServerArgs,
  cleanupStaleProcesses,
  validateConfig,
  buildDatabaseSetupQueries,
  patchLocalSettings,
  _internal
} = require('../src/server-manager');

describe('Server manager building blocks', function() {
  this.timeout(20000);

  let tempDir;
  let restoreEnv;
  const children = [];

  function spawnTracked(file, args) {
    const child = spawn(file, args, { stdio: 'ignore' });
    children.push(child);
    return child;
  }

  beforeEach(function() {
    restoreEnv = setEnv({ DEV_MODE: 'false' });
    tempDir = makeTempDir('internals');
    setDataPath(tempDir);
  });

  afterEach(function() {
    for (const child of children.splice(0)) {
      child.kill('SIGKILL');
    }
    restoreEnv();
    removeDir(tempDir);
  });

  after(function() {
    process.env.DEV_MODE = 'true';
  });

  describe('Recognising our own server processes', function() {
    const { identifyProcess } = _internal;
    const MARKER = '--datadir=/somewhere/hamichlol/database';

    before(function() {
      if (process.platform === 'win32') {
        this.skip(); // needs a real command line to inspect; covered on Unix
      }
    });

    async function startProcess(args) {
      // "--" keeps node from reading the marker as one of its own options
      const child = spawnTracked(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', ...args]);
      await waitFor(() => child.pid && isAlive(child.pid));
      await delay(150);
      expect(isAlive(child.pid), 'helper process should stay alive').to.be.true;
      return child;
    }

    it('should recognise a live process with the right program and marker', async function() {
      const child = await startProcess([MARKER]);
      expect(await identifyProcess({ pid: child.pid, exe: process.execPath, marker: MARKER })).to.equal('ours');
    });

    it('should not claim the same program started with different data', async function() {
      const child = await startProcess(['--datadir=/var/lib/mysql']);
      expect(await identifyProcess({ pid: child.pid, exe: process.execPath, marker: MARKER })).to.equal('gone');
    });

    it('should not claim a different program that happens to have the marker', async function() {
      const child = await startProcess([MARKER]);
      expect(await identifyProcess({ pid: child.pid, exe: '/usr/sbin/mariadbd', marker: MARKER })).to.equal('gone');
    });

    it('should report a process that has exited as gone', async function() {
      const child = await startProcess([MARKER]);
      const pid = child.pid;
      child.kill('SIGKILL');
      await waitFor(() => !isAlive(pid));

      expect(await identifyProcess({ pid, exe: process.execPath, marker: MARKER })).to.equal('gone');
    });

    it('should treat incomplete or malformed entries as gone', async function() {
      const child = await startProcess([MARKER]);
      const valid = { pid: child.pid, exe: process.execPath, marker: MARKER };

      for (const entry of [
        undefined,
        null,
        {},
        { ...valid, pid: String(child.pid) },
        { ...valid, pid: 0 },
        { ...valid, pid: -1 },
        { ...valid, pid: 1.5 },
        { ...valid, exe: undefined },
        { ...valid, marker: undefined },
        { ...valid, marker: '' },
        { ...valid, marker: 42 }
      ]) {
        expect(await identifyProcess(entry), JSON.stringify(entry)).to.equal('gone');
      }
    });

    it('should read the command line through ps where there is no /proc (macOS)', async function() {
      const child = await startProcess([MARKER]);
      const platform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      try {
        expect(await identifyProcess({ pid: child.pid, exe: process.execPath, marker: MARKER })).to.equal('ours');
        expect(await identifyProcess({ pid: child.pid, exe: process.execPath, marker: '--datadir=/other' })).to.equal('gone');
      } finally {
        Object.defineProperty(process, 'platform', platform);
      }
    });

    it('should say "unknown" rather than guess when the command line cannot be read', async function() {
      const child = await startProcess([MARKER]);
      // As Windows, the lookup needs PowerShell, which does not exist here
      const platform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'win32' });
      try {
        expect(await identifyProcess({ pid: child.pid, exe: process.execPath, marker: MARKER })).to.equal('unknown');
      } finally {
        Object.defineProperty(process, 'platform', platform);
      }
      expect(isAlive(child.pid)).to.be.true;
    });

    it('should never claim this test process or the init process', async function() {
      expect(await identifyProcess({ pid: process.pid, exe: process.execPath, marker: MARKER })).to.equal('gone');
      expect(await identifyProcess({ pid: 1, exe: process.execPath, marker: MARKER })).to.equal('gone');
    });
  });

  describe('Cleaning up after a crash', function() {
    before(function() {
      if (process.platform === 'win32') {
        this.skip();
      }
    });

    const runState = () => JSON.parse(fs.readFileSync(getPaths().runStateFile, 'utf8'));

    // The helper processes are children of this test process, so a killed one
    // lingers as a zombie (still "alive" to a signal check) until Node has
    // collected it. Its exit event is the reliable sign that it is gone.
    const exited = child => waitFor(() => child.exitCode !== null || child.signalCode !== null);

    async function startLeftover(marker, { stubborn = false } = {}) {
      const code = stubborn
        ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
        : 'setInterval(() => {}, 1000)';
      const child = spawnTracked(process.execPath, ['-e', code, '--', marker]);
      await waitFor(() => child.pid && isAlive(child.pid));
      await delay(150); // let it install its signal handler
      expect(isAlive(child.pid), 'helper process should stay alive').to.be.true;
      return child;
    }

    it('should stop leftover servers of both kinds and forget them', async function() {
      const php = await startLeftover(getPaths().mediaWikiPath);
      const database = await startLeftover(`--datadir=${getPaths().dbDataDir}`);
      fs.writeFileSync(getPaths().runStateFile, JSON.stringify({
        php: { pid: php.pid, port: 1, exe: process.execPath, marker: getPaths().mediaWikiPath },
        mysql: { pid: database.pid, port: 1, exe: process.execPath, marker: `--datadir=${getPaths().dbDataDir}` }
      }));

      await cleanupStaleProcesses();

      expect(await exited(php)).to.be.true;
      expect(await exited(database)).to.be.true;
      expect(fs.existsSync(getPaths().runStateFile)).to.be.false;
    });

    it('should force a leftover server that ignores the polite request', async function() {
      this.timeout(20000);
      const php = await startLeftover(getPaths().mediaWikiPath, { stubborn: true });
      fs.writeFileSync(getPaths().runStateFile, JSON.stringify({
        php: { pid: php.pid, port: 1, exe: process.execPath, marker: getPaths().mediaWikiPath }
      }));

      await cleanupStaleProcesses();

      expect(await exited(php)).to.be.true;
      expect(php.signalCode).to.equal('SIGKILL');
      expect(fs.existsSync(getPaths().runStateFile)).to.be.false;
    });

    it('should leave a process alone and remember it when it cannot be identified', async function() {
      const database = await startLeftover(`--datadir=${getPaths().dbDataDir}`);
      const entry = { pid: database.pid, port: 1, exe: process.execPath, marker: `--datadir=${getPaths().dbDataDir}` };
      fs.writeFileSync(getPaths().runStateFile, JSON.stringify({ mysql: entry }));

      const platform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'win32' });
      try {
        await cleanupStaleProcesses();
      } finally {
        Object.defineProperty(process, 'platform', platform);
      }

      expect(isAlive(database.pid)).to.be.true;
      expect(runState()).to.deep.equal({ mysql: entry });

      // Once it can be identified again, the next clean-up finishes the job
      await cleanupStaleProcesses();
      expect(await exited(database)).to.be.true;
      expect(fs.existsSync(getPaths().runStateFile)).to.be.false;
    });

    it('should cope with a run-state file that is empty or damaged', async function() {
      for (const content of ['', '{', 'null', '[]', '"text"', '{"mysql":null,"php":7}']) {
        fs.writeFileSync(getPaths().runStateFile, content);
        await cleanupStaleProcesses();
        expect(fs.existsSync(getPaths().runStateFile), JSON.stringify(content)).to.be.false;
      }
    });

    it('should do nothing when there is no run-state file', async function() {
      await cleanupStaleProcesses();
      expect(fs.existsSync(getPaths().runStateFile)).to.be.false;
    });
  });

  describe('Talking to the database server', function() {
    const { mysqlAdminShutdown } = _internal;

    before(function() {
      if (!CAN_RUN_FAKE_PROGRAMS) {
        this.skip();
      }
    });

    async function startFakeDatabase(port, env = {}) {
      const exe = installFakeProgram(path.join(tempDir, 'bin', 'mariadbd'), FAKE_DB_SERVER);
      const dataDir = path.join(tempDir, 'db');
      const child = spawn(exe, [`--datadir=${dataDir}`, `--port=${port}`], {
        stdio: 'ignore',
        env: { ...process.env, ...env }
      });
      children.push(child);
      await waitFor(() => new Promise(resolve => {
        const socket = net.connect({ host: '127.0.0.1', port });
        socket.once('connect', () => {
          socket.destroy();
          resolve(true);
        });
        socket.once('error', () => resolve(false));
      }));
      return { child, dataDir };
    }

    function freePort() {
      return new Promise(resolve => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => {
          const { port } = server.address();
          server.close(() => resolve(port));
        });
      });
    }

    it('should shut a running server down with one SHUTDOWN statement', async function() {
      const port = await freePort();
      const { child, dataDir } = await startFakeDatabase(port);

      await mysqlAdminShutdown(port);

      expect(await waitFor(() => !isAlive(child.pid))).to.be.true;
      expect(readLines(path.join(dataDir, 'queries.log'))).to.deep.equal(['SHUTDOWN']);
    });

    it('should fail when the server refuses the command', async function() {
      const port = await freePort();
      const { child } = await startFakeDatabase(port, { FAKE_DB_REJECT_QUERIES: '1' });

      const error = await mysqlAdminShutdown(port).then(() => null, failure => failure);

      expect(error).to.be.an('error');
      expect(error.message).to.include('Access denied');
      expect(isAlive(child.pid)).to.be.true;
    });

    it('should fail quickly when nothing listens on the port', async function() {
      const port = await freePort();
      const started = Date.now();

      const error = await mysqlAdminShutdown(port).then(() => null, failure => failure);

      expect(error).to.be.an('error');
      expect(Date.now() - started).to.be.below(3000);
    });

    it('should give up on a server that accepts the connection but never answers', async function() {
      this.timeout(15000);
      const sockets = [];
      const silent = net.createServer(socket => sockets.push(socket));
      await new Promise(resolve => silent.listen(0, '127.0.0.1', resolve));
      const started = Date.now();

      try {
        const error = await mysqlAdminShutdown(silent.address().port).then(() => null, failure => failure);

        expect(error).to.be.an('error');
        // Bounded by the connection timeout rather than hanging forever
        expect(Date.now() - started).to.be.within(3000, 10000);
      } finally {
        sockets.forEach(socket => socket.destroy());
        await new Promise(resolve => silent.close(resolve));
      }
    });
  });

  describe('Database setup statements', function() {
    it('should quote names and escape every kind of awkward password', function() {
      for (const dbPassword of ["it's", 'say "hi"', 'back\\slash', 'semi;colon -- comment', '`tick`', 'סיסמה', '😀', ' spaced ']) {
        const queries = buildDatabaseSetupQueries({ ...VALID_CONFIG, dbPassword });
        const create = queries.find(sql => sql.startsWith('CREATE USER'));

        // The statement is exactly one string literal after IDENTIFIED BY
        const literal = create.slice(create.indexOf('IDENTIFIED BY ') + 'IDENTIFIED BY '.length);
        expect(literal.startsWith("'") && literal.endsWith("'"), dbPassword).to.be.true;
        const unescaped = literal.slice(1, -1).replace(/\\(.)/g, '$1').replace(/''/g, "'");
        expect(unescaped, dbPassword).to.equal(dbPassword);
      }
    });

    it('should drop and recreate only the wiki database', function() {
      const queries = buildDatabaseSetupQueries(VALID_CONFIG);

      expect(queries[0]).to.equal('DROP DATABASE IF EXISTS `test_wiki`');
      expect(queries[1]).to.equal('CREATE DATABASE `test_wiki`');
      expect(queries.filter(sql => /DROP|CREATE DATABASE/.test(sql))).to.have.lengthOf(2);
    });

    it('should limit the user to local connections and to the wiki database', function() {
      const queries = buildDatabaseSetupQueries(VALID_CONFIG);

      for (const sql of queries.filter(statement => statement.includes('test_user'))) {
        expect(sql).to.include("'test_user'@'localhost'");
      }
      const grant = queries.find(sql => sql.startsWith('GRANT'));
      expect(grant).to.equal("GRANT ALL PRIVILEGES ON `test_wiki`.* TO 'test_user'@'localhost'");
      expect(queries.join('\n')).to.not.include('*.*');
    });
  });

  describe('Settings validation', function() {
    it('should accept names at their maximum length and reject one character more', function() {
      expect(validateConfig({ ...VALID_CONFIG, dbName: 'd'.repeat(64) }).dbName).to.have.lengthOf(64);
      expect(() => validateConfig({ ...VALID_CONFIG, dbName: 'd'.repeat(65) })).to.throw();
      expect(validateConfig({ ...VALID_CONFIG, dbUser: 'u'.repeat(32) }).dbUser).to.have.lengthOf(32);
      expect(() => validateConfig({ ...VALID_CONFIG, dbUser: 'u'.repeat(33) })).to.throw();
    });

    it('should reject names with anything but Latin letters, digits and underscores', function() {
      for (const name of ['wiki db', 'wiki-db', 'wiki.db', 'ויקי', 'wiki`', "wiki'", 'wiki;', 'wiki/db', 'wiki\\db', 'wi\nki']) {
        expect(() => validateConfig({ ...VALID_CONFIG, dbName: name }), `dbName ${JSON.stringify(name)}`).to.throw();
        expect(() => validateConfig({ ...VALID_CONFIG, dbUser: name }), `dbUser ${JSON.stringify(name)}`).to.throw();
      }
    });

    it('should accept digits and underscores anywhere in a name', function() {
      const config = validateConfig({ ...VALID_CONFIG, dbName: '2024_wiki_', dbUser: '_user1' });
      expect(config).to.include({ dbName: '2024_wiki_', dbUser: '_user1' });
    });

    it('should reject reserved database names in any letter case, but not as part of a name', function() {
      for (const name of ['mysql', 'MYSQL', 'Sys', 'INFORMATION_SCHEMA', 'Performance_Schema']) {
        expect(() => validateConfig({ ...VALID_CONFIG, dbName: name }), name).to.throw();
      }
      for (const name of ['mysql2', 'my_sys', 'sysadmin', 'information_schema_copy']) {
        expect(validateConfig({ ...VALID_CONFIG, dbName: name }).dbName, name).to.equal(name);
      }
    });

    it('should allow a reserved word as the user name', function() {
      expect(validateConfig({ ...VALID_CONFIG, dbUser: 'mysql' }).dbUser).to.equal('mysql');
    });

    it('should trim names but keep passwords exactly as typed', function() {
      const config = validateConfig({
        ...VALID_CONFIG,
        dbName: '  wikidb ',
        dbUser: '\twikiuser\n',
        wikiName: '  המכלול  ',
        adminUser: ' Admin ',
        dbPassword: '  spaces  ',
        adminPassword: '  ten chars and more  '
      });

      expect(config).to.deep.equal({
        dbName: 'wikidb',
        dbUser: 'wikiuser',
        wikiName: 'המכלול',
        adminUser: 'Admin',
        dbPassword: '  spaces  ',
        adminPassword: '  ten chars and more  '
      });
    });

    it('should reject names that are empty once trimmed', function() {
      expect(() => validateConfig({ ...VALID_CONFIG, wikiName: '   ' })).to.throw();
      expect(() => validateConfig({ ...VALID_CONFIG, adminUser: '\t' })).to.throw();
      expect(() => validateConfig({ ...VALID_CONFIG, dbName: '  ' })).to.throw();
    });

    it('should require an administrator password of at least ten characters', function() {
      expect(() => validateConfig({ ...VALID_CONFIG, adminPassword: '123456789' })).to.throw('10');
      expect(validateConfig({ ...VALID_CONFIG, adminPassword: '1234567890' }).adminPassword).to.equal('1234567890');
    });

    it('should reject values that are not text', function() {
      for (const value of [undefined, null, 42, true, {}, ['wikidb'], '']) {
        expect(() => validateConfig({ ...VALID_CONFIG, dbName: value }), JSON.stringify(value)).to.throw();
        expect(() => validateConfig({ ...VALID_CONFIG, adminPassword: value }), JSON.stringify(value)).to.throw();
      }
    });

    it('should reject a missing configuration', function() {
      expect(() => validateConfig(undefined)).to.throw();
      expect(() => validateConfig(null)).to.throw();
      expect(() => validateConfig('wikidb')).to.throw();
    });

    it('should ignore fields it does not know', function() {
      const config = validateConfig({ ...VALID_CONFIG, extra: 'x', __proto__: { polluted: true } });
      expect(Object.keys(config).sort()).to.deep.equal(Object.keys(VALID_CONFIG).sort());
    });
  });

  describe('Database server options', function() {
    const options = (flavor, port = 3310) => dbServerArgs({ flavor, version: '10.11.14' }, port);

    it('should always start with --no-defaults and our own data folder and port', function() {
      for (const flavor of ['mariadb', 'mysql']) {
        const args = options(flavor);
        expect(args[0]).to.equal('--no-defaults');
        expect(args).to.include(`--datadir=${getPaths().dbDataDir}`);
        expect(args).to.include('--port=3310');
        expect(args).to.include('--bind-address=127.0.0.1');
      }
    });

    it('should keep the socket and PID file inside the data folder on Unix', function() {
      if (process.platform === 'win32') {
        this.skip();
      }
      const socket = path.join(tempDir, 'mysql.sock');
      if (socket.length > 100) {
        this.skip(); // temp folder too deep for a socket (macOS); see the next test
      }
      const args = options('mariadb');

      expect(args).to.include(`--socket=${socket}`);
      expect(args).to.include(`--pid-file=${path.join(tempDir, 'mysql.pid')}`);
      expect(args).to.not.include('--console');
    });

    it('should move the socket to a short path when the data folder path is too long', function() {
      if (process.platform === 'win32') {
        this.skip();
      }
      const deep = path.join(tempDir, 'x'.repeat(120));
      setDataPath(deep);

      const socket = options('mariadb', 3311).find(arg => arg.startsWith('--socket=')).slice('--socket='.length);

      expect(socket.length).to.be.below(100);
      expect(socket.startsWith(deep)).to.be.false;
      expect(socket).to.include('3311');
    });

    it('should run as root only when the app itself runs as root', function() {
      if (process.platform === 'win32') {
        this.skip();
      }
      const getuid = process.getuid;
      try {
        process.getuid = () => 0;
        expect(options('mariadb')).to.include('--user=root');
        process.getuid = () => 1000;
        expect(options('mariadb')).to.not.include('--user=root');
      } finally {
        process.getuid = getuid;
      }
    });

    it('should use Windows options on Windows', function() {
      const platform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'win32' });
      try {
        const args = options('mariadb');
        expect(args).to.include('--console');
        expect(args.join(' ')).to.not.match(/--socket|--pid-file|--user/);
      } finally {
        Object.defineProperty(process, 'platform', platform);
      }
    });
  });

  describe('Copying an installed MediaWiki', function() {
    const { copyMediaWiki } = _internal;
    let source;
    let target;

    beforeEach(function() {
      source = path.join(tempDir, 'installed');
      target = path.join(tempDir, 'copy');
      for (const dir of ['includes', 'images/a', 'cache', 'extensions/Cite', 'skins']) {
        fs.mkdirSync(path.join(source, dir), { recursive: true });
      }
      fs.writeFileSync(path.join(source, 'index.php'), 'index');
      fs.writeFileSync(path.join(source, 'LocalSettings.php'), 'secret settings');
      fs.writeFileSync(path.join(source, 'images', 'a', 'photo.jpg'), 'photo');
      fs.writeFileSync(path.join(source, 'cache', 'l10n.cdb'), 'cache');
      fs.writeFileSync(path.join(source, 'extensions', 'Cite', 'extension.json'), '{}');
    });

    it('should copy the program files', function() {
      copyMediaWiki(source, target);

      expect(fs.readFileSync(path.join(target, 'index.php'), 'utf8')).to.equal('index');
      expect(fs.existsSync(path.join(target, 'extensions', 'Cite', 'extension.json'))).to.be.true;
      expect(fs.existsSync(path.join(target, 'skins'))).to.be.true;
    });

    it('should leave out the existing wiki\'s settings, uploads and cache', function() {
      copyMediaWiki(source, target);

      expect(fs.existsSync(path.join(target, 'LocalSettings.php'))).to.be.false;
      expect(fs.readdirSync(path.join(target, 'images'))).to.deep.equal([]);
      expect(fs.readdirSync(path.join(target, 'cache'))).to.deep.equal([]);
    });

    it('should only leave out those names at the top level', function() {
      fs.mkdirSync(path.join(source, 'resources', 'images'), { recursive: true });
      fs.writeFileSync(path.join(source, 'resources', 'images', 'logo.svg'), 'logo');
      fs.mkdirSync(path.join(source, 'includes', 'cache'));
      fs.writeFileSync(path.join(source, 'includes', 'cache', 'CacheHelper.php'), 'code');
      fs.writeFileSync(path.join(source, 'includes', 'LocalSettings.php'), 'code');

      copyMediaWiki(source, target);

      expect(fs.existsSync(path.join(target, 'resources', 'images', 'logo.svg'))).to.be.true;
      expect(fs.existsSync(path.join(target, 'includes', 'cache', 'CacheHelper.php'))).to.be.true;
      expect(fs.existsSync(path.join(target, 'includes', 'LocalSettings.php'))).to.be.true;
    });

    it('should not modify the installation it copies from', function() {
      copyMediaWiki(source, target);

      expect(fs.readFileSync(path.join(source, 'LocalSettings.php'), 'utf8')).to.equal('secret settings');
      expect(fs.readFileSync(path.join(source, 'images', 'a', 'photo.jpg'), 'utf8')).to.equal('photo');
      expect(fs.readFileSync(path.join(source, 'cache', 'l10n.cdb'), 'utf8')).to.equal('cache');
    });

    it('should turn symlinks into real files and folders', function() {
      if (process.platform === 'win32') {
        this.skip(); // creating symlinks needs special rights there
      }
      const elsewhere = path.join(tempDir, 'var-lib');
      fs.mkdirSync(path.join(elsewhere, 'Gadgets'), { recursive: true });
      fs.writeFileSync(path.join(elsewhere, 'Gadgets', 'extension.json'), '{}');
      fs.symlinkSync(path.join(elsewhere, 'Gadgets'), path.join(source, 'extensions', 'Gadgets'));
      fs.symlinkSync(path.join(source, 'index.php'), path.join(source, 'alias.php'));

      copyMediaWiki(source, target);

      expect(fs.lstatSync(path.join(target, 'extensions', 'Gadgets')).isSymbolicLink()).to.be.false;
      expect(fs.existsSync(path.join(target, 'extensions', 'Gadgets', 'extension.json'))).to.be.true;
      expect(fs.lstatSync(path.join(target, 'alias.php')).isSymbolicLink()).to.be.false;
      expect(fs.readFileSync(path.join(target, 'alias.php'), 'utf8')).to.equal('index');
    });

    it('should skip a top-level LocalSettings.php symlink that points nowhere', function() {
      if (process.platform === 'win32') {
        this.skip();
      }
      // Debian's package ships exactly this until a wiki has been configured
      fs.rmSync(path.join(source, 'LocalSettings.php'));
      fs.symlinkSync('/etc/mediawiki/does-not-exist.php', path.join(source, 'LocalSettings.php'));

      copyMediaWiki(source, target);

      expect(fs.existsSync(path.join(target, 'index.php'))).to.be.true;
      expect(fs.existsSync(path.join(target, 'LocalSettings.php'))).to.be.false;
    });

    it('should replace an incomplete earlier copy', function() {
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'stale.php'), 'old');
      fs.mkdirSync(`${target}.partial`);
      fs.writeFileSync(path.join(`${target}.partial`, 'half.php'), 'x');

      copyMediaWiki(source, target);

      expect(fs.existsSync(path.join(target, 'stale.php'))).to.be.false;
      expect(fs.existsSync(`${target}.partial`)).to.be.false;
      expect(fs.existsSync(path.join(target, 'index.php'))).to.be.true;
    });

    it('should leave no half-made copy when copying fails', function() {
      expect(() => copyMediaWiki(path.join(tempDir, 'missing'), target)).to.throw();

      expect(fs.existsSync(target)).to.be.false;
      expect(fs.existsSync(`${target}.partial`)).to.be.false;
    });
  });

  describe('Adapting LocalSettings.php', function() {
    function patch(content) {
      const file = path.join(tempDir, 'LocalSettings.php');
      fs.writeFileSync(file, content);
      patchLocalSettings(file);
      return fs.readFileSync(file, 'utf8');
    }

    const GENERATED = [
      '<?php',
      '# This file was automatically generated by the MediaWiki 1.43.1 installer.',
      '$wgSitename = "המכלול אופליין";',
      '## The protocol and server name to use in fully-qualified URLs',
      '$wgServer = "http://localhost:8080";',
      '$wgDBtype = "mysql";',
      '$wgDBserver = "127.0.0.1:3307";',
      '$wgDBname = "wikidb";',
      '$wgDBpassword = "p$1&w";',
      ''
    ].join('\n');

    it('should change only the two settings that depend on ports', function() {
      const before = GENERATED.trimEnd().split('\n');
      const after = patch(GENERATED).split('\n').slice(0, before.length);

      const changed = after.filter((line, index) => line !== before[index]);
      expect(changed).to.have.lengthOf(2);
      expect(changed[0]).to.match(/^\$wgServer = /);
      expect(changed[1]).to.match(/^\$wgDBserver = /);
    });

    it('should keep the cache and the error logs inside the wiki folder', function() {
      const settings = patch(GENERATED);
      const added = settings.slice(settings.indexOf('# Added by Hamichlol Offline'));

      // Distribution packages point these at /var/cache and /var/log, which an
      // ordinary user cannot write to
      expect(added).to.include('$wgCacheDirectory = "$IP/cache";');
      expect(added).to.include('$wgDBerrorLog = "$IP/cache/dberror.log";');
      expect(added).to.include('$wgDebugLogGroups[$hamichlolLogGroup] = "$IP/cache/$hamichlolLogGroup.log";');
      // It comes after everything the installer wrote, so it wins
      expect(settings.indexOf('# Added by Hamichlol Offline')).to.be.above(settings.indexOf('$wgDBpassword'));
      expect(added).to.not.match(/\/var\//);
    });

    it('should add that block only once', function() {
      const twice = patch(patch(GENERATED));
      expect(twice.match(/# Added by Hamichlol Offline/g)).to.have.lengthOf(1);
      expect(twice.match(/^\$wgCacheDirectory/gm)).to.have.lengthOf(1);
    });

    it('should produce valid PHP', function() {
      const { spawnSync } = require('child_process');
      if (spawnSync('php', ['-v']).status !== 0) {
        this.skip(); // no PHP on this computer to check with
      }
      patch(GENERATED);

      const check = spawnSync('php', ['-l', path.join(tempDir, 'LocalSettings.php')], { encoding: 'utf8' });
      expect(check.status, check.stdout + check.stderr).to.equal(0);
    });

    it('should not touch similar-looking settings or comments', function() {
      const settings = patch([
        '<?php',
        '# $wgServer = "http://example.org";',
        '$wgServerName = "keep";',
        '$wgServer = "http://localhost:8080";',
        '$wgDBserverPort = "keep";',
        '$wgDBserver = "localhost";',
        ''
      ].join('\n'));

      expect(settings).to.include('# $wgServer = "http://example.org";');
      expect(settings).to.include('$wgServerName = "keep";');
      expect(settings).to.include('$wgDBserverPort = "keep";');
    });

    it('should work on files with Windows line endings', function() {
      const settings = patch(GENERATED.replace(/\n/g, '\r\n'));

      expect(settings).to.include('$wgServer = WebRequest::detectServer();');
      expect(settings).to.include("getenv( 'HAMICHLOL_DB_PORT' )");
      expect(settings).to.include('$wgDBname = "wikidb";');
    });

    it('should give the same result when applied twice', function() {
      const once = patch(GENERATED);
      expect(patch(once)).to.equal(once);
    });

    it('should leave the file untouched when a setting is missing', function() {
      const file = path.join(tempDir, 'LocalSettings.php');
      const content = '<?php\n$wgServer = "http://localhost:8080";\n';
      fs.writeFileSync(file, content);

      expect(() => patchLocalSettings(file)).to.throw('wgDBserver');
      expect(fs.readFileSync(file, 'utf8')).to.equal(content);
    });
  });
});
