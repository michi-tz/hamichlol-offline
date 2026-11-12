// End-to-end tests of the real application window, driven through Playwright.
//
// Not part of `npm test`: they need the Electron binary and a display.
//   npm run test:e2e                 (on Linux without a display: xvfb-run -a npm run test:e2e)
//
// Everything runs in DEV_MODE, where downloads and servers are simulated, so
// the tests are about the page: which step is shown, what the form accepts,
// and that the state survives a restart of the app.

const { describe, it, beforeEach, afterEach } = require('mocha');
const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { _electron: electron } = require('playwright-core');

const { makeTempDir, removeDir } = require('../helpers');

const APP_DIR = path.join(__dirname, '..', '..');

// Chromium's sandbox cannot start as root, nor on CI runners that restrict
// unprivileged user namespaces; HAMICHLOL_E2E_NO_SANDBOX=1 turns it off there.
const NO_SANDBOX = Boolean(process.env.HAMICHLOL_E2E_NO_SANDBOX) || (process.getuid ? process.getuid() === 0 : false);
const ADMIN_PASSWORD = 'admin-password-123';

describe('Application window (dev mode)', function() {
  this.timeout(60000);

  let dataDir;
  let profileDir;
  let app;
  let page;
  let pageErrors;

  async function launch() {
    app = await electron.launch({
      executablePath: require('electron'),
      // Its own profile: nothing is written to the profile of a real
      // installation, and the single-instance lock cannot clash with an app
      // that is already open. Kept for the whole test, so restarts share it.
      args: [...(NO_SANDBOX ? ['--no-sandbox'] : []), `--user-data-dir=${profileDir}`, APP_DIR],
      env: { ...process.env, DEV_MODE: 'true', HAMICHLOL_DATA_DIR: dataDir }
    });
    page = await app.firstWindow();
    pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.waitForFunction(() => !document.getElementById('status').textContent.includes('ממתין להתקנה...') ||
      document.querySelectorAll('#toolsList li').length > 0);
  }

  async function close() {
    if (app) {
      await app.close();
      app = null;
    }
  }

  const visibleSteps = () => page.evaluate(() =>
    ['step1', 'step2', 'step3'].filter(id => getComputedStyle(document.getElementById(id)).display !== 'none'));
  const status = () => page.textContent('#status');
  const waitForStep = id => page.waitForSelector(`#${id}`, { state: 'visible' });

  async function fillForm(values = {}) {
    const fields = { dbPassword: 'db-password', adminPassword: ADMIN_PASSWORD, ...values };
    for (const [id, value] of Object.entries(fields)) {
      await page.fill(`#${id}`, value);
    }
  }

  async function download() {
    await page.click('#downloadBtn');
    await waitForStep('step2');
  }

  async function install() {
    await fillForm();
    await page.click('#wikiSetupForm button[type=submit]');
    await waitForStep('step3');
  }

  async function wikiFrame() {
    await page.waitForFunction(() => document.getElementById('wikiBrowser').style.display === 'block');
    await page.waitForFunction(() => window.frames.length > 0);
    for (let i = 0; i < 50; i++) {
      const frame = page.frames().find(candidate => candidate.url().startsWith('http://127.0.0.1:'));
      if (frame) {
        await frame.waitForLoadState();
        return frame;
      }
      await page.waitForTimeout(100);
    }
    throw new Error('The wiki frame did not load');
  }

  beforeEach(async function() {
    dataDir = makeTempDir('e2e');
    profileDir = makeTempDir('e2e-profile');
    await launch();
  });

  afterEach(async function() {
    await close();
    removeDir(dataDir);
    removeDir(profileDir);
    expect(pageErrors, 'errors thrown in the page').to.deep.equal([]);
  });

  describe('First run', function() {
    it('should show only the first step', async function() {
      expect(await visibleSteps()).to.deep.equal(['step1']);
      expect(await status()).to.include('ממתין להתקנה');
      expect(await page.isVisible('#wikiBrowser')).to.be.false;
    });

    it('should be a right-to-left Hebrew page', async function() {
      expect(await page.getAttribute('html', 'dir')).to.equal('rtl');
      expect(await page.getAttribute('html', 'lang')).to.equal('he');
      expect(await page.title()).to.equal('המכלול אופליין');
    });

    it('should list the three components and what will happen with each', async function() {
      const items = await page.$$eval('#toolsList li', elements => elements.map(element => element.textContent));

      expect(items).to.have.lengthOf(3);
      expect(items[0]).to.match(/^PHP: /);
      expect(items[1]).to.match(/^(MariaDB|MySQL): /);
      expect(items[2]).to.match(/^MediaWiki: /);
      for (const item of items) {
        expect(item).to.match(/תורד גרסה \d|כבר הורדה|שמותקנת במחשב|לא נמצא במחשב/);
      }
    });

    it('should move to the settings form after the servers are ready', async function() {
      await download();

      expect(await visibleSteps()).to.deep.equal(['step2']);
      expect(await status()).to.include('יש להגדיר את MediaWiki');
    });
  });

  describe('Settings form', function() {
    beforeEach(download);

    it('should offer sensible names and never a default password', async function() {
      expect(await page.inputValue('#dbName')).to.equal('wikidb');
      expect(await page.inputValue('#dbUser')).to.equal('wikiuser');
      expect(await page.inputValue('#wikiName')).to.equal('המכלול אופליין');
      expect(await page.inputValue('#adminUser')).to.equal('admin');
      expect(await page.inputValue('#dbPassword')).to.equal('');
      expect(await page.inputValue('#adminPassword')).to.equal('');
      expect(await page.getAttribute('#dbPassword', 'type')).to.equal('password');
      expect(await page.getAttribute('#adminPassword', 'type')).to.equal('password');
    });

    it('should not submit while a required field is empty', async function() {
      await page.click('#wikiSetupForm button[type=submit]');
      await page.waitForTimeout(300);

      expect(await visibleSteps()).to.deep.equal(['step2']);
      expect(await page.$eval('#wikiSetupForm', form => form.checkValidity())).to.be.false;
    });

    it('should not accept an administrator password shorter than ten characters', async function() {
      await fillForm({ adminPassword: 'short' });
      await page.click('#wikiSetupForm button[type=submit]');
      await page.waitForTimeout(300);

      expect(await visibleSteps()).to.deep.equal(['step2']);
      expect(await page.$eval('#adminPassword', input => input.validity.tooShort)).to.be.true;
    });

    it('should not accept database names with spaces, hyphens or Hebrew letters', async function() {
      for (const name of ['wiki db', 'wiki-db', 'ויקי']) {
        await fillForm({ dbName: name });
        expect(await page.$eval('#dbName', input => input.validity.patternMismatch), name).to.be.true;
      }
      await fillForm({ dbName: 'wiki_db_2' });
      expect(await page.$eval('#dbName', input => input.validity.valid)).to.be.true;
    });

    it('should not accept a database user name longer than 32 characters', async function() {
      await fillForm({ dbUser: 'u'.repeat(33) });
      expect(await page.$eval('#dbUser', input => input.validity.patternMismatch)).to.be.true;

      await fillForm({ dbUser: 'u'.repeat(32) });
      expect(await page.$eval('#dbUser', input => input.validity.valid)).to.be.true;
    });

    it('should show the reason when the app rejects the settings, and allow a new attempt', async function() {
      // "mysql" passes the form's own pattern but is refused by the app
      await fillForm({ dbName: 'mysql' });
      await page.click('#wikiSetupForm button[type=submit]');
      await page.waitForFunction(() => document.getElementById('status').textContent.includes('שגיאה'));

      expect(await status()).to.include('mysql');
      expect(await visibleSteps()).to.deep.equal(['step2']);
      expect(await page.isEnabled('#wikiSetupForm button[type=submit]')).to.be.true;

      await fillForm({ dbName: 'wikidb' });
      await page.click('#wikiSetupForm button[type=submit]');
      await waitForStep('step3');
    });

    it('should move to the last step and clear the passwords after installing', async function() {
      await install();

      expect(await visibleSteps()).to.deep.equal(['step3']);
      expect(await status()).to.include('אפשר להפעיל את השרתים');
      expect(await page.inputValue('#dbPassword')).to.equal('');
      expect(await page.inputValue('#adminPassword')).to.equal('');
    });

    it('should write the settings that were typed', async function() {
      await fillForm({ dbName: 'my_wiki', wikiName: "המכלול של 'בדיקה'" });
      await page.click('#wikiSetupForm button[type=submit]');
      await waitForStep('step3');

      const settings = fs.readFileSync(path.join(dataDir, 'mediawiki', 'LocalSettings.php'), 'utf8');
      expect(settings).to.include("$wgDBname = 'my_wiki';");
      expect(settings).to.include("$wgSitename = 'המכלול של \\'בדיקה\\'';");
    });
  });

  describe('Running the servers', function() {
    beforeEach(async function() {
      await download();
      await install();
    });

    it('should offer only "start" before the servers run', async function() {
      expect(await page.isEnabled('#startServersBtn')).to.be.true;
      expect(await page.isEnabled('#stopServersBtn')).to.be.false;
    });

    it('should show the wiki inside the window once started', async function() {
      await page.click('#startServersBtn');
      const frame = await wikiFrame();

      expect(await frame.textContent('h1')).to.equal('המכלול אופליין - אתר בדיקה');
      expect(await status()).to.match(/השרתים פועלים \(PHP: \d+, MySQL: \d+\)/);
      expect(await page.isEnabled('#startServersBtn')).to.be.false;
      expect(await page.isEnabled('#stopServersBtn')).to.be.true;
    });

    it('should load the wiki from this computer only', async function() {
      await page.click('#startServersBtn');
      const frame = await wikiFrame();

      expect(frame.url()).to.match(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    });

    it('should hide the wiki and allow a restart after stopping', async function() {
      await page.click('#startServersBtn');
      const frame = await wikiFrame();
      const url = frame.url();

      await page.click('#stopServersBtn');
      await page.waitForFunction(() => document.getElementById('status').textContent.includes('אפשר להפעיל'));

      expect(await page.isVisible('#wikiBrowser')).to.be.false;
      expect(await page.isEnabled('#startServersBtn')).to.be.true;
      expect(await page.isEnabled('#stopServersBtn')).to.be.false;
      expect(await fetch(url).then(() => 'up', () => 'down')).to.equal('down');

      await page.click('#startServersBtn');
      expect(await (await wikiFrame()).textContent('h1')).to.include('אתר בדיקה');
    });

    it('should stop the servers when the app is closed', async function() {
      await page.click('#startServersBtn');
      const url = (await wikiFrame()).url();
      expect((await fetch(url)).status).to.equal(200);

      await close();

      expect(await fetch(url).then(() => 'up', () => 'down')).to.equal('down');
    });
  });

  describe('Starting the app again', function() {
    it('should resume at the settings form when only the servers were set up', async function() {
      await download();
      await close();
      await launch();

      expect(await visibleSteps()).to.deep.equal(['step2']);
    });

    it('should resume at the last step when the wiki is installed', async function() {
      await download();
      await install();
      await close();
      await launch();

      expect(await visibleSteps()).to.deep.equal(['step3']);
      expect(await status()).to.include('אפשר להפעיל את השרתים');
      expect(await page.isEnabled('#startServersBtn')).to.be.true;
    });

    it('should not keep the servers running across a restart', async function() {
      await download();
      await install();
      await page.click('#startServersBtn');
      await wikiFrame();
      await close();
      await launch();

      expect(await page.isVisible('#wikiBrowser')).to.be.false;
      expect(await page.isEnabled('#stopServersBtn')).to.be.false;
    });

    it('should keep separate data folders completely apart', async function() {
      await download();
      await install();
      await close();

      const first = dataDir;
      dataDir = makeTempDir('e2e-other');
      try {
        await launch();
        expect(await visibleSteps()).to.deep.equal(['step1']);
      } finally {
        await close();
        removeDir(first);
      }
    });
  });
});
