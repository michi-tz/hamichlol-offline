// A real upgrade of an installed wiki: a wiki installed with an older MediaWiki
// release (1.43) gets content, and upgradeMediaWiki() then moves it to the
// release in src/versions.js, against the real PHP and MariaDB/MySQL.
//
// Part of `npm run test:system`. Besides the software real-software.system.js
// needs, it needs two release files, which nothing downloads here:
//   HAMICHLOL_TEST_OLD_MEDIAWIKI_DIR  an extracted older release, e.g. mediawiki-1.43.11
//   HAMICHLOL_TEST_MEDIAWIKI_ZIP      the release zip the app downloads (mediawiki-<pinned>.zip),
//                                     handed to the upgrade in place of the download
// Skipped when they are missing, unless HAMICHLOL_SYSTEM_TESTS_REQUIRED is set (as in CI).

const { describe, it, before, after } = require('mocha');
const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { makeTempDir, removeDir, setEnv, skipUnlessRequired } = require('../helpers');
const systemTools = require('../../src/system-tools');
const serverManager = require('../../src/server-manager');
const { DOWNLOADS } = require('../../src/versions');

const { setDataPath, setFetch, getPaths, getStatus, downloadServers, installMediaWiki, upgradeMediaWiki, startServers, stopServers } = serverManager;
const { copyMediaWiki } = serverManager._internal;

const CONFIG = {
  dbName: 'hamichlol_upgrade',
  dbUser: 'hamichlol_user',
  dbPassword: 'upgrade-db-pass-123',
  wikiName: 'המכלול אופליין - שדרוג',
  adminUser: 'WikiAdmin',
  adminPassword: 'correct horse battery staple'
};
const PAGE = 'דף לפני השדרוג';
const PAGE_TEXT = 'תוכן שנכתב בגרסה הישנה [[קטגוריה:בדיקות]]';
// A 1x1 PNG
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

describe('Real upgrade of an installed wiki', function() {
  this.timeout(300000);

  const pinned = DOWNLOADS.mediawiki.version;
  let dataDir;
  let restoreEnv;
  let php;
  let oldVersion;
  let releaseZip;
  let ports;
  const requested = [];

  const api = async query => (await fetch(`http://127.0.0.1:${ports.phpPort}/api.php?format=json&${query}`)).json();
  const wikitext = async title => (await api(`action=parse&prop=wikitext&page=${encodeURIComponent(title)}`)).parse.wikitext['*'];

  // A maintenance script of the installed wiki, run as the app's wiki would be
  function maintenance(args, input) {
    const mediaWikiPath = getPaths().mediaWikiPath;
    return execFileSync(php.exe, [path.join(mediaWikiPath, 'maintenance', 'run.php'), ...args], {
      cwd: mediaWikiPath,
      input,
      encoding: 'utf8',
      env: { ...process.env, HAMICHLOL_DB_PORT: String(ports.mysqlPort) }
    });
  }

  before(async function() {
    restoreEnv = setEnv({ DEV_MODE: 'false', HAMICHLOL_USE_SYSTEM: undefined });
    systemTools.resetCache();

    const oldDir = process.env.HAMICHLOL_TEST_OLD_MEDIAWIKI_DIR;
    releaseZip = process.env.HAMICHLOL_TEST_MEDIAWIKI_ZIP;
    const oldMediaWiki = oldDir ? systemTools.findSystemMediaWiki([oldDir]) : null;
    oldVersion = oldMediaWiki && oldMediaWiki.version;
    const problems = [];
    const found = {
      PHP: systemTools.findSystemPhp(),
      'MariaDB/MySQL': systemTools.findSystemDatabase(),
      MediaWiki: systemTools.findSystemMediaWiki()
    };
    for (const [name, tool] of Object.entries(found)) {
      if (!tool || !tool.usable) {
        problems.push(`${name}${tool ? ` (${tool.reason})` : ''}`);
      }
    }
    if (!oldVersion || systemTools.compareVersions(oldVersion, pinned) >= 0) {
      problems.push(`an older MediaWiki in HAMICHLOL_TEST_OLD_MEDIAWIKI_DIR (${oldDir ? `${oldDir}: ${oldVersion || 'not a MediaWiki release'}` : 'not set'})`);
    }
    if (!releaseZip || !fs.existsSync(releaseZip)) {
      problems.push(`mediawiki-${pinned}.zip in HAMICHLOL_TEST_MEDIAWIKI_ZIP (${releaseZip || 'not set'})`);
    }
    if (problems.length > 0) {
      restoreEnv();
      restoreEnv = null;
      skipUnlessRequired(this, `not installed or not provided: ${problems.join(', ')}`);
    }
    php = found.PHP;
    console.log(`    MediaWiki ${oldVersion} to ${pinned}, with PHP ${php.version}`);

    dataDir = makeTempDir('upgrade');
    setDataPath(dataDir);
    // The data folder as step 1 sets it up, with the older MediaWiki in it, as
    // an earlier version of the app installed it
    await downloadServers();
    await copyMediaWiki(oldDir, getPaths().mediaWikiPath);
    await installMediaWiki(CONFIG);
  });

  after(async function() {
    setFetch((url, options) => fetch(url, options));
    await stopServers();
    if (restoreEnv) {
      restoreEnv();
    }
    process.env.DEV_MODE = 'true';
    removeDir(dataDir);
  });

  it('should run the older wiki and offer the upgrade', async function() {
    ports = await startServers();

    const { query } = await api('action=query&meta=siteinfo&siprop=general');
    expect(query.general.generator).to.equal(`MediaWiki ${oldVersion}`);
    expect(getStatus().upgrade).to.deep.equal({ from: oldVersion, to: pinned });
  });

  it('should keep a page and an uploaded file of the older wiki', async function() {
    maintenance(['edit', '--user', CONFIG.adminUser, '--summary', 'before the upgrade', PAGE], PAGE_TEXT);
    const images = path.join(dataDir, 'import');
    fs.mkdirSync(images);
    fs.writeFileSync(path.join(images, 'Pixel.png'), PIXEL);
    maintenance(['importImages', '--user', CONFIG.adminUser, images]);

    expect(await wikitext(PAGE)).to.equal(PAGE_TEXT);
    await stopServers();
  });

  it('should upgrade to the pinned release', async function() {
    const release = fs.readFileSync(releaseZip);
    setFetch(async url => {
      requested.push(url);
      return new Response(release);
    });

    await upgradeMediaWiki();

    // Exactly the file CI cached is what the app downloads
    expect(requested).to.deep.equal([DOWNLOADS.mediawiki.urls[0]]);
    expect(getStatus().upgrade).to.be.null;
    const defines = fs.readFileSync(path.join(getPaths().mediaWikiPath, 'includes', 'Defines.php'), 'utf8');
    expect(defines).to.include(`'MW_VERSION', '${pinned}'`);
    // Nothing of the upgrade is left behind: old tree, backup, journal
    expect(fs.readdirSync(dataDir).filter(name => name.includes('upgrade'))).to.deep.equal([]);
    expect(fs.existsSync(getPaths().runStateFile)).to.be.false;
  });

  it('should serve the upgraded wiki with its content', async function() {
    ports = await startServers();

    const { query } = await api('action=query&meta=siteinfo&siprop=general');
    expect(query.general).to.include({ generator: `MediaWiki ${pinned}`, sitename: CONFIG.wikiName, lang: 'he' });
    expect(await wikitext(PAGE)).to.equal(PAGE_TEXT);

    const image = await api('action=query&titles=File:Pixel.png&prop=imageinfo&iiprop=url|size');
    const info = Object.values(image.query.pages)[0].imageinfo[0];
    expect(info).to.include({ width: 1, height: 1 });
    const file = await fetch(new URL(info.url, `http://127.0.0.1:${ports.phpPort}/`));
    expect(Buffer.from(await file.arrayBuffer()).equals(PIXEL)).to.be.true;

    const page = await fetch(`http://127.0.0.1:${ports.phpPort}/index.php?title=${encodeURIComponent(PAGE)}`);
    expect(page.status).to.equal(200);
    expect(await page.text()).to.include('תוכן שנכתב בגרסה הישנה');
  });

  it('should let the administrator log in after the upgrade', async function() {
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
    await stopServers();
  });
});
