// The whole application flow against the real PHP, MariaDB/MySQL and MediaWiki
// installed on this computer. Nothing is faked and nothing is downloaded.
//
// Not part of `npm test`:
//   npm run test:system
//
// The suite is skipped when suitable software is not installed. On Ubuntu:
//   sudo apt install php-cli php-mysql php-intl php-mbstring php-xml mariadb-server mediawiki
// The system's own database service is not used or touched, and does not need
// to be running: the app starts its own server process on its own data folder.

const { describe, it, before, after } = require('mocha');
const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { makeTempDir, removeDir, isAlive, waitFor, readJson, setEnv } = require('../helpers');
const systemTools = require('../../src/system-tools');
const serverManager = require('../../src/server-manager');

const { setDataPath, getPaths, getStatus, downloadServers, installMediaWiki, startServers, stopServers } = serverManager;

const CONFIG = {
  dbName: 'hamichlol_test',
  dbUser: 'hamichlol_user',
  // Characters that break naive shell or SQL quoting
  dbPassword: `p' w"x;\\ $(id) \`id\` %s`,
  wikiName: 'המכלול אופליין - בדיקה',
  adminUser: 'WikiAdmin',
  adminPassword: 'correct horse battery staple'
};

describe('Real installed software', function() {
  this.timeout(300000);

  let dataDir;
  let restoreEnv;
  let ports;

  const api = async query => (await fetch(`http://127.0.0.1:${ports.phpPort}/api.php?format=json&${query}`)).json();

  before(async function() {
    restoreEnv = setEnv({ DEV_MODE: 'false', HAMICHLOL_USE_SYSTEM: undefined });
    systemTools.resetCache();

    const found = {
      PHP: systemTools.findSystemPhp(),
      'MariaDB/MySQL': systemTools.findSystemDatabase(),
      MediaWiki: systemTools.findSystemMediaWiki()
    };
    const missing = Object.entries(found)
      .filter(([, tool]) => !tool || !tool.usable)
      .map(([name, tool]) => `${name}${tool ? ` (${tool.reason})` : ''}`);
    if (missing.length > 0) {
      console.log(`    Skipped: not installed or not suitable: ${missing.join(', ')}`);
      restoreEnv();
      restoreEnv = null;
      this.skip();
    }
    console.log(`    PHP ${found.PHP.version}, ${found['MariaDB/MySQL'].flavor} ${found['MariaDB/MySQL'].version}, MediaWiki ${found.MediaWiki.version}`);

    dataDir = makeTempDir('system');
    setDataPath(dataDir);
  });

  after(async function() {
    await stopServers();
    if (restoreEnv) {
      restoreEnv();
    }
    process.env.DEV_MODE = 'true';
    removeDir(dataDir);
  });

  it('should report everything as installed on the computer', function() {
    const { tools, downloaded } = getStatus();

    expect(downloaded).to.be.false;
    expect(tools.php.source).to.equal('system');
    expect(tools.database.source).to.equal('system');
    expect(tools.mediawiki.source).to.equal('system');
  });

  it('should set up without downloading anything', async function() {
    await downloadServers();

    const paths = getPaths();
    expect(getStatus()).to.include({ downloaded: true, installed: false });
    expect(fs.readdirSync(paths.serverPath)).to.deep.equal([]);
    expect(fs.existsSync(path.join(paths.dbDataDir, 'mysql'))).to.be.true;
    expect(fs.existsSync(path.join(paths.mediaWikiPath, 'index.php'))).to.be.true;
    expect(fs.existsSync(path.join(paths.mediaWikiPath, 'includes', 'Defines.php'))).to.be.true;
    expect(fs.existsSync(paths.localSettings)).to.be.false;
  });

  it('should leave the installed MediaWiki as it was', function() {
    const source = systemTools.findSystemMediaWiki().dir;
    // Our copy is independent: no link back into the original
    const entries = fs.readdirSync(getPaths().mediaWikiPath);
    for (const entry of entries) {
      expect(fs.lstatSync(path.join(getPaths().mediaWikiPath, entry)).isSymbolicLink(), entry).to.be.false;
    }
    expect(fs.existsSync(path.join(source, 'index.php'))).to.be.true;
  });

  it('should install MediaWiki with awkward passwords and a Hebrew site name', async function() {
    await installMediaWiki(CONFIG);

    const settings = fs.readFileSync(getPaths().localSettings, 'utf8');
    expect(settings).to.include('$wgServer = WebRequest::detectServer();');
    expect(settings).to.include("getenv( 'HAMICHLOL_DB_PORT' )");
    expect(settings).to.include(CONFIG.wikiName);
    expect(getStatus()).to.include({ installed: true, running: false });
    // The database started for the installer is not left running
    expect(fs.existsSync(getPaths().runStateFile)).to.be.false;
  });

  it('should start both servers and serve the wiki', async function() {
    ports = await startServers();

    const response = await fetch(`http://127.0.0.1:${ports.phpPort}/index.php`);
    const html = await response.text();
    expect(response.status).to.equal(200);
    expect(html).to.include(CONFIG.wikiName);
    expect(getStatus()).to.include({ running: true, phpPort: ports.phpPort, mysqlPort: ports.mysqlPort });
  });

  it('should answer API requests with the configured site', async function() {
    const { query } = await api('action=query&meta=siteinfo&siprop=general');

    expect(query.general.sitename).to.equal(CONFIG.wikiName);
    expect(query.general.dbtype).to.equal('mysql');
    // The address is detected from the request, not fixed at install time
    expect(query.general.server).to.equal(`http://127.0.0.1:${ports.phpPort}`);
  });

  it('should have created the administrator account', async function() {
    const { query } = await api(`action=query&list=users&usprop=groups&ususers=${encodeURIComponent(CONFIG.adminUser)}`);

    expect(query.users[0].name).to.equal(CONFIG.adminUser);
    expect(query.users[0].groups).to.include('sysop');
  });

  it('should let the administrator log in with the chosen password', async function() {
    const base = `http://127.0.0.1:${ports.phpPort}/api.php`;
    const tokenResponse = await fetch(`${base}?format=json&action=query&meta=tokens&type=login`);
    const cookies = tokenResponse.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');
    const { logintoken } = (await tokenResponse.json()).query.tokens;

    const login = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies },
      body: new URLSearchParams({
        format: 'json',
        action: 'clientlogin',
        username: CONFIG.adminUser,
        password: CONFIG.adminPassword,
        logintoken,
        loginreturnurl: `http://127.0.0.1:${ports.phpPort}/`
      })
    });

    expect((await login.json()).clientlogin).to.include({ status: 'PASS', username: CONFIG.adminUser });
  });

  it('should listen on the loopback interface only', async function() {
    if (process.platform !== 'linux') {
      this.skip();
    }
    const state = readJson(getPaths().runStateFile);
    const command = pid => fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');

    expect(command(state.mysql.pid)).to.include('--bind-address=127.0.0.1');
    expect(command(state.mysql.pid)).to.include(`--datadir=${getPaths().dbDataDir}`);
    expect(command(state.php.pid)).to.include(`127.0.0.1:${ports.phpPort}`);
  });

  it('should shut the database down cleanly', async function() {
    const state = readJson(getPaths().runStateFile);

    await stopServers();

    expect(isAlive(state.mysql.pid)).to.be.false;
    expect(isAlive(state.php.pid)).to.be.false;
    expect(getStatus().running).to.be.false;
    expect(fs.existsSync(getPaths().runStateFile)).to.be.false;
  });

  it('should keep the wiki content across a restart of the servers', async function() {
    ports = await startServers();

    const { query } = await api('action=query&meta=siteinfo&siprop=statistics');
    expect(query.statistics.pages).to.be.at.least(1);
    const page = await fetch(`http://127.0.0.1:${ports.phpPort}/index.php?title=Special:Version`);
    expect(page.status).to.equal(200);

    await stopServers();
  });

  it('should recover when the app was killed while the servers were running', async function() {
    // A separate process plays the app, starts the servers and dies
    const script = `
      const manager = require(${JSON.stringify(require.resolve('../../src/server-manager'))});
      manager.setDataPath(${JSON.stringify(dataDir)});
      manager.startServers().then(() => process.kill(process.pid, 'SIGKILL'));
    `;
    const crashed = spawn(process.execPath, ['-e', script], { stdio: 'ignore', env: { ...process.env, DEV_MODE: 'false' } });
    await new Promise(resolve => crashed.once('exit', resolve));

    const leftover = readJson(getPaths().runStateFile);
    expect(isAlive(leftover.mysql.pid), 'database left running by the crash').to.be.true;

    ports = await startServers();

    expect(await waitFor(() => !isAlive(leftover.mysql.pid))).to.be.true;
    const { query } = await api('action=query&meta=siteinfo&siprop=general');
    expect(query.general.sitename).to.equal(CONFIG.wikiName);

    await stopServers();
  });

  it('should refuse to install a second time', async function() {
    const error = await installMediaWiki(CONFIG).then(() => null, failure => failure);

    expect(error).to.be.an('error');
    expect(getStatus()).to.include({ installed: true, running: false });
  });
});
