// The wiki, shown in a BrowserView that fills the main window below the slim
// bar of the app page.
//
// The wiki is not shown in an <iframe> of the app page: MediaWiki forbids
// framing its edit pages (X-Frame-Options), and the app page has Node access,
// which wiki content must never share. The view is sandboxed, has no Node
// access and only ever shows this computer's wiki; any other address opens in
// the system browser.

const { BrowserView, shell } = require('electron');

// Height of the bar the app page shows above the wiki (see #wikiBar in index.html)
const WIKI_BAR_HEIGHT = 48;

// Wiki cookies (logins) are kept apart from the app page and survive restarts
const WIKI_PARTITION = 'persist:wiki';

// Chromium's error code for a load that was replaced by another navigation
const ERR_ABORTED = -3;

function wikiOrigins(port) {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
}

// Whether `url` is a page of the local wiki served on `port`
function isWikiUrl(url, port) {
  try {
    return wikiOrigins(port).includes(new URL(url).origin);
  } catch (error) {
    return false;
  }
}

// Open a link that leaves the wiki in the system browser. Only web addresses:
// file:, javascript: and custom protocols are never handed to the system.
function openExternally(url) {
  let protocol;
  try {
    protocol = new URL(url).protocol;
  } catch (error) {
    return false;
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    return false;
  }
  shell.openExternal(url).catch(error => console.error(`Could not open ${url}: ${error.message}`));
  return true;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
}

// Hebrew page shown in place of the wiki when it cannot be loaded
function errorPage(homeUrl, description) {
  const html = `<!DOCTYPE html>
<html dir="rtl" lang="he"><head><meta charset="utf-8"><title>הוויקי אינו זמין</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: "Segoe UI", Tahoma, Arial, sans-serif; background: #f4f6fa; color: #1f2937; }
  main { max-width: 460px; padding: 32px; background: #fff; border-radius: 12px; text-align: center;
    box-shadow: 0 1px 3px rgba(15, 23, 42, .08), 0 8px 24px rgba(15, 23, 42, .06); }
  h1 { font-size: 20px; margin: 0 0 12px; }
  p { color: #4b5563; line-height: 1.6; margin: 0 0 8px; }
  code { direction: ltr; unicode-bidi: embed; color: #6b7280; font-size: 13px; }
  a { display: inline-block; margin-top: 16px; padding: 9px 22px; border-radius: 8px; background: #1d4ed8;
    color: #fff; text-decoration: none; font-weight: 600; }
</style></head>
<body><main>
  <h1>לא ניתן לטעון את הוויקי</h1>
  <p>ייתכן שהשרתים עדיין עולים, או שהם נעצרו. אפשר לנסות שוב, או לעצור ולהפעיל את השרתים מחדש מתפריט "שרתים".</p>
  <p><code>${escapeHtml(description)}</code></p>
  <a id="retry" href="${escapeHtml(homeUrl)}">נסה שוב</a>
</main></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

class WikiView {
  // `onChange` is called when the page shown in the view changes (title, history)
  constructor({ onChange = () => {} } = {}) {
    this.window = null;
    this.view = null;
    this.port = null;
    this.onChange = onChange;
    this.layout = this.layout.bind(this);
  }

  isShown() {
    return this.view !== null;
  }

  homeUrl() {
    return `http://127.0.0.1:${this.port}/`;
  }

  get webContents() {
    return this.view ? this.view.webContents : null;
  }

  // Show the wiki served on `port` in `window`. Does nothing if it already is.
  show(window, port) {
    if (this.view && this.window === window && this.port === port) {
      return;
    }
    this.hide();

    const view = new BrowserView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: WIKI_PARTITION
      }
    });
    this.window = window;
    this.view = view;
    this.port = port;

    const contents = view.webContents;
    // The wiki needs no camera, notifications, location, ...
    if (contents.session && contents.session.setPermissionRequestHandler) {
      contents.session.setPermissionRequestHandler((webContents, permission, callback) => callback(false));
    }
    contents.setWindowOpenHandler(({ url }) => {
      if (isWikiUrl(url, port)) {
        contents.loadURL(url);
      } else {
        openExternally(url);
      }
      return { action: 'deny' };
    });
    const keepInside = (event, url) => {
      if (!isWikiUrl(url, port)) {
        event.preventDefault();
        openExternally(url);
      }
    };
    contents.on('will-navigate', keepInside);
    contents.on('will-redirect', keepInside);
    contents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame && errorCode !== ERR_ABORTED && this.view === view) {
        contents.loadURL(errorPage(this.homeUrl(), `${errorDescription} (${errorCode})`));
      }
    });
    contents.on('render-process-gone', (event, details) => {
      if (this.view === view && details.reason !== 'clean-exit') {
        contents.loadURL(errorPage(this.homeUrl(), details.reason));
      }
    });
    for (const event of ['page-title-updated', 'did-navigate', 'did-navigate-in-page']) {
      contents.on(event, () => this.onChange());
    }

    view.setBackgroundColor('#ffffff');
    window.setBrowserView(view);
    this.layout();
    window.on('resize', this.layout);
    window.on('enter-full-screen', this.layout);
    window.on('leave-full-screen', this.layout);
    contents.loadURL(this.homeUrl());
    this.onChange();
  }

  // Remove the view and free its page
  hide() {
    const { view, window } = this;
    if (!view) {
      return;
    }
    this.view = null;
    this.window = null;
    this.port = null;
    if (window && !window.isDestroyed()) {
      window.removeListener('resize', this.layout);
      window.removeListener('enter-full-screen', this.layout);
      window.removeListener('leave-full-screen', this.layout);
      window.removeBrowserView(view);
    }
    if (!view.webContents.isDestroyed()) {
      view.webContents.close();
    }
    this.onChange();
  }

  // The whole content area of the window below the bar
  layout() {
    if (!this.view || !this.window || this.window.isDestroyed()) {
      return;
    }
    const [width, height] = this.window.getContentSize();
    this.view.setBounds({ x: 0, y: WIKI_BAR_HEIGHT, width, height: Math.max(0, height - WIKI_BAR_HEIGHT) });
  }

  // Navigation for the menu and the bar
  goHome() {
    if (this.view) {
      this.view.webContents.loadURL(this.homeUrl());
    }
  }

  goBack() {
    if (this.view && this.view.webContents.canGoBack()) {
      this.view.webContents.goBack();
    }
  }

  goForward() {
    if (this.view && this.view.webContents.canGoForward()) {
      this.view.webContents.goForward();
    }
  }

  reload() {
    if (this.view) {
      this.view.webContents.reload();
    }
  }

  // Open the page that is shown in the system browser
  openInBrowser() {
    if (!this.view) {
      return;
    }
    const url = this.view.webContents.getURL();
    openExternally(isWikiUrl(url, this.port) ? url : this.homeUrl());
  }

  focus() {
    if (this.view) {
      this.view.webContents.focus();
    }
  }

  // What the bar shows: the page title and whether back/forward are possible
  describe() {
    if (!this.view || this.view.webContents.isDestroyed()) {
      return { shown: false, title: null, canGoBack: false, canGoForward: false };
    }
    const contents = this.view.webContents;
    return {
      shown: true,
      title: contents.getTitle(),
      canGoBack: contents.canGoBack(),
      canGoForward: contents.canGoForward()
    };
  }
}

module.exports = { WikiView, WIKI_BAR_HEIGHT, WIKI_PARTITION, isWikiUrl, openExternally, errorPage };
