// End-to-end tests of the real application window, driven through Playwright.
//
// Not part of `npm test`: they need the Electron binary and a display.
//   npm run test:e2e                 (on Linux without a display: xvfb-run -a npm run test:e2e)
//
// Everything runs in DEV_MODE, where downloads and servers are simulated, so
// the tests are about the window: which step is shown, what the form accepts,
// how the wiki is shown, and that the state survives a restart of the app.
//
// The wiki is a BrowserView of the main process, not part of the app page, so
// it is inspected through the main process (wikiView() below).

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
    ['step1', 'step2', 'step3'].filter(id => document.getElementById(id).checkVisibility()));
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

  const wikiMode = () => page.evaluate(() => document.body.classList.contains('wiki-mode'));

  // The wiki view as the main process sees it, or null when there is none
  const viewInfo = () => app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const view = window.getBrowserView();
    if (!view) {
      return null;
    }
    const contents = view.webContents;
    return {
      url: contents.getURL(),
      loading: contents.isLoading(),
      bounds: view.getBounds(),
      contentSize: window.getContentSize(),
      preferences: contents.getLastWebPreferences(),
      heading: contents.isLoading() ? null : await contents.executeJavaScript(
        "document.querySelector('h1') ? document.querySelector('h1').textContent : null"
      )
    };
  });

  // Run `code` in the wiki page, as if the user did it (clicks count as user
  // actions, so the history of the page behaves as it does for real clicks)
  const inWiki = code => app.evaluate(({ BrowserWindow }, source) =>
    BrowserWindow.getAllWindows()[0].getBrowserView().webContents.executeJavaScript(source, true), code);

  // Wait until the wiki is shown and its page has loaded
  async function wikiView(predicate = info => info.url.startsWith('http://127.0.0.1:')) {
    await page.waitForFunction(() => document.body.classList.contains('wiki-mode'));
    for (let i = 0; i < 100; i++) {
      const info = await viewInfo();
      if (info && !info.loading && info.heading && predicate(info)) {
        return info;
      }
      await page.waitForTimeout(100);
    }
    throw new Error('The wiki did not load');
  }

  // Record links the app hands to the system browser instead of opening them
  const captureExternalLinks = () => app.evaluate(({ shell }) => {
    global.openedExternally = [];
    shell.openExternal = async url => {
      global.openedExternally.push(url);
    };
  });
  const openedExternally = () => app.evaluate(() => global.openedExternally);

  const menuItem = id => app.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu().getMenuItemById(itemId);
    return item ? { label: item.label, enabled: item.enabled } : null;
  }, id);
  const clickMenuItem = id => app.evaluate(({ Menu }, itemId) => {
    Menu.getApplicationMenu().getMenuItemById(itemId).click();
  }, id);

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
      expect(await wikiMode()).to.be.false;
      expect(await page.isVisible('#wikiBar')).to.be.false;
      expect(await viewInfo()).to.be.null;
    });

    it('should mark the current step in the step indicator', async function() {
      const current = () => page.$eval('#stepper [aria-current=step]', item => item.dataset.step);
      expect(await current()).to.equal('1');
      await download();
      expect(await current()).to.equal('2');
      expect(await page.$eval('#stepper li[data-step="1"]', item => item.classList.contains('done'))).to.be.true;
    });

    it('should have a Hebrew menu instead of the default one', async function() {
      const labels = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.map(item => item.label));
      expect(labels).to.include.members(['שרתים', 'ויקי', 'סנכרון', 'תצוגה', 'עריכה', 'עזרה']);
      expect(await menuItem('start')).to.include({ enabled: false });
      expect(await menuItem('syncSite')).to.include({ enabled: false });
    });

    it('should be a right-to-left Hebrew page', async function() {
      expect(await page.getAttribute('html', 'dir')).to.equal('rtl');
      expect(await page.getAttribute('html', 'lang')).to.equal('he');
      expect(await page.title()).to.equal('המכלול אופליין');
    });

    it('should list the three components and what will happen with each', async function() {
      const items = await page.$$eval('#toolsList li', elements => elements.map(element => element.textContent));

      const names = await page.$$eval('#toolsList li strong', elements => elements.map(element => element.textContent));

      expect(items).to.have.lengthOf(3);
      expect(names[0]).to.equal('PHP');
      expect(names[1]).to.match(/^(MariaDB|MySQL)$/);
      expect(names[2]).to.equal('MediaWiki');
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

    const passwordRules = () => page.$$eval('#adminPasswordRules li', items =>
      Object.fromEntries(items.map(item => [item.dataset.rule, item.className])));
    const waitForRule = (id, className) => page.waitForFunction(([rule, expected]) => {
      const item = document.querySelector(`#adminPasswordRules li[data-rule="${rule}"]`);
      return item && item.className === expected;
    }, [id, className]);

    it('should not accept an administrator password shorter than ten characters', async function() {
      await fillForm({ adminPassword: 'short' });
      await waitForRule('minLength', 'fail');
      await page.click('#wikiSetupForm button[type=submit]');
      await page.waitForTimeout(300);

      expect(await visibleSteps()).to.deep.equal(['step2']);
      expect(await page.$eval('#adminPassword', input => input.validity.customError)).to.be.true;
      expect(await page.$eval('#adminPassword', input => input.validationMessage)).to.include('10');
    });

    it('should show the password rules while typing', async function() {
      expect(Object.values(await passwordRules())).to.not.be.empty;

      await page.fill('#adminPassword', 'admin');
      await waitForRule('minLength', 'fail');
      expect(await passwordRules()).to.include({ minLength: 'fail', notInUsername: 'fail' });

      await page.fill('#adminPassword', ADMIN_PASSWORD);
      await waitForRule('minLength', 'ok');
      expect(await passwordRules()).to.deep.equal({ minLength: 'ok', notInUsername: 'ok', notDefault: 'ok', notCommon: 'ok' });
      expect(await page.$eval('#adminPassword', input => input.validity.valid)).to.be.true;
    });

    it('should refuse a password from MediaWiki\'s list of common passwords', async function() {
      await fillForm({ adminPassword: 'qwertyuiop' });
      await waitForRule('notCommon', 'fail');
      await page.click('#wikiSetupForm button[type=submit]');
      await page.waitForTimeout(300);

      expect(await visibleSteps()).to.deep.equal(['step2']);
      expect(await page.$eval('#adminPassword', input => input.validationMessage)).to.include('נפוצות');
    });

    it('should refuse a password that is part of the user name', async function() {
      await fillForm({ adminUser: 'Administrator1', adminPassword: 'administrator' });
      await waitForRule('notInUsername', 'fail');
      expect(await page.$eval('#adminPassword', input => input.validity.valid)).to.be.false;
    });

    it('should refuse user names MediaWiki cannot create, and say how a name is stored', async function() {
      await page.fill('#adminUser', 'admin@site');
      await page.waitForFunction(() => document.getElementById('adminUserHint').textContent.includes('@'));
      expect(await page.$eval('#adminUser', input => input.validity.customError)).to.be.true;

      await page.fill('#adminUser', 'wiki admin');
      await page.waitForFunction(() => document.getElementById('adminUserHint').textContent.includes('Wiki admin'));
      expect(await page.$eval('#adminUser', input => input.validity.valid)).to.be.true;
    });

    it('should show and hide the password on request', async function() {
      await page.fill('#adminPassword', ADMIN_PASSWORD);
      const toggle = '.toggle-password[data-target="adminPassword"]';

      await page.click(toggle);
      expect(await page.getAttribute('#adminPassword', 'type')).to.equal('text');
      expect(await page.getAttribute(toggle, 'aria-pressed')).to.equal('true');

      await page.click(toggle);
      expect(await page.getAttribute('#adminPassword', 'type')).to.equal('password');
      expect(await page.inputValue('#adminPassword')).to.equal(ADMIN_PASSWORD);
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
      // Shown as an error, not as an ordinary status
      expect(await page.getAttribute('#status', 'class')).to.include('error');
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
      expect(settings).to.include("$wgLanguageCode = 'he';");
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
      expect(await menuItem('start')).to.include({ enabled: true });
      expect(await menuItem('stop')).to.include({ enabled: false });
    });

    it('should show the wiki across the whole window once started', async function() {
      await page.click('#startServersBtn');
      const info = await wikiView();

      expect(info.heading).to.equal('המכלול אופליין - אתר בדיקה');
      // The setup screen is gone; only the slim bar remains above the wiki
      expect(await visibleSteps()).to.deep.equal([]);
      expect(await page.isVisible('#status')).to.be.false;
      expect(await page.isVisible('#wikiBar')).to.be.true;
      const barHeight = await page.$eval('#wikiBar', bar => bar.getBoundingClientRect().height);
      const [width, height] = info.contentSize;
      expect(info.bounds).to.deep.equal({ x: 0, y: barHeight, width, height: height - barHeight });
      expect(height - barHeight).to.be.above(height * 0.9);

      expect(await page.textContent('#serversIndicator')).to.include('השרתים פועלים');
      expect(await page.isEnabled('#startServersBtn')).to.be.false;
      expect(await page.isEnabled('#stopServersBtn')).to.be.true;
      expect(await menuItem('stop')).to.include({ enabled: true });
      expect(await menuItem('wikiHome')).to.include({ enabled: true });
    });

    it('should keep filling the window when it is resized', async function() {
      await page.click('#startServersBtn');
      await wikiView();
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 640));
      await page.waitForTimeout(500);

      const info = await viewInfo();
      const [width, height] = info.contentSize;
      expect(info.bounds).to.deep.equal({ x: 0, y: 48, width, height: height - 48 });
    });

    it('should load the wiki from this computer only, in a page without Node access', async function() {
      await page.click('#startServersBtn');
      const info = await wikiView();

      expect(info.url).to.match(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      expect(info.preferences).to.include({ nodeIntegration: false, contextIsolation: true, sandbox: true });
      expect(await inWiki('typeof require')).to.equal('undefined');
      expect(await inWiki("document.documentElement.lang")).to.equal('he');
    });

    it('should follow links inside the wiki and go back from the bar', async function() {
      await page.click('#startServersBtn');
      const { url } = await wikiView();

      await inWiki("document.getElementById('internal-link').click()");
      const other = await wikiView(info => info.url.includes('title=Test'));
      expect(other.heading).to.equal('דף בדיקה');
      await page.waitForFunction(() => !document.getElementById('wikiBackBtn').disabled);

      await page.click('#wikiBackBtn');
      expect((await wikiView(info => info.url === url)).heading).to.include('אתר בדיקה');
    });

    it('should open other sites in the system browser, not in the app', async function() {
      await page.click('#startServersBtn');
      const { url } = await wikiView();
      await captureExternalLinks();

      await inWiki("document.getElementById('external-link').click()");
      await inWiki("document.getElementById('new-window-link').click()");
      await page.waitForTimeout(500);

      expect(await openedExternally()).to.deep.equal(['https://www.example.org/', 'https://www.example.org/new']);
      expect((await viewInfo()).url).to.equal(url);
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).to.equal(1);
    });

    it('should go back to the setup screen and allow a restart after stopping', async function() {
      await page.click('#startServersBtn');
      const { url } = await wikiView();

      await page.click('#stopServersBtn');
      await page.waitForFunction(() => document.getElementById('status').textContent.includes('אפשר להפעיל'));

      expect(await wikiMode()).to.be.false;
      expect(await viewInfo()).to.be.null;
      expect(await visibleSteps()).to.deep.equal(['step3']);
      expect(await page.isEnabled('#startServersBtn')).to.be.true;
      expect(await page.isEnabled('#stopServersBtn')).to.be.false;
      expect(await fetch(url).then(() => 'up', () => 'down')).to.equal('down');

      await page.click('#startServersBtn');
      expect((await wikiView()).heading).to.include('אתר בדיקה');
    });

    it('should be controlled from the menu as well, keeping the window in step', async function() {
      await clickMenuItem('start');
      await wikiView();
      expect(await page.isEnabled('#stopServersBtn')).to.be.true;

      await clickMenuItem('restart');
      await page.waitForFunction(() => !document.getElementById('stopServersBtn').disabled);
      expect((await wikiView()).heading).to.include('אתר בדיקה');

      await clickMenuItem('stop');
      await page.waitForFunction(() => !document.body.classList.contains('wiki-mode'));
      expect(await visibleSteps()).to.deep.equal(['step3']);
      expect(await menuItem('start')).to.include({ enabled: true });
    });

    it('should stop the servers when the app is closed', async function() {
      await page.click('#startServersBtn');
      const { url } = await wikiView();
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
      await wikiView();
      await close();
      await launch();

      expect(await wikiMode()).to.be.false;
      expect(await viewInfo()).to.be.null;
      expect(await visibleSteps()).to.deep.equal(['step3']);
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
