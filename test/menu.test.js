// The application menu (src/menu.js), built from the app's state.

const { describe, it } = require('mocha');
const { expect } = require('chai');

const { buildMenuTemplate, findItem } = require('../src/menu');

const ACTIONS = [
  'start', 'stop', 'restart', 'quit', 'wikiHome', 'wikiBack', 'wikiForward', 'wikiReload',
  'wikiOpenExternal', 'zoomIn', 'zoomOut', 'zoomReset', 'toggleDevTools', 'about', 'openDataFolder'
];

// Actions that record which of them was called
function recordingActions() {
  const calls = [];
  const actions = Object.fromEntries(ACTIONS.map(name => [name, () => calls.push(name)]));
  return { actions, calls };
}

const STATES = {
  notInstalled: { installed: false, running: false, busy: null, wikiShown: false },
  stopped: { installed: true, running: false, busy: null, wikiShown: false },
  running: { installed: true, running: true, busy: null, wikiShown: true },
  busy: { installed: true, running: true, busy: 'restart', wikiShown: true }
};

function build(state, platform = 'linux') {
  return buildMenuTemplate(state, recordingActions().actions, { platform });
}

// Every item of the template, submenus included
function allItems(template) {
  return template.flatMap(item => [item, ...(Array.isArray(item.submenu) ? allItems(item.submenu) : [])]);
}

describe('Application menu', function() {
  it('should have the Hebrew menus in order', function() {
    expect(build(STATES.stopped).map(menu => menu.label))
      .to.deep.equal(['שרתים', 'ויקי', 'סנכרון', 'תצוגה', 'עריכה', 'עזרה']);
  });

  it('should keep the standard application menu first on macOS', function() {
    const template = build(STATES.stopped, 'darwin');
    expect(template[0].label).to.equal('המכלול אופליין');
    expect(template[0].submenu.map(item => item.role).filter(Boolean)).to.include.members(['hide', 'hideOthers', 'unhide']);
    expect(template.slice(1).map(menu => menu.label)).to.deep.equal(['שרתים', 'ויקי', 'סנכרון', 'תצוגה', 'עריכה', 'עזרה']);
    // Quit and about live in the application menu there
    expect(findItem(template, 'quit')).to.be.null;
    expect(findItem(template, 'about')).to.be.null;
  });

  it('should only offer what can be done in each state', function() {
    const enabled = (state, id) => findItem(build(state), id).enabled;
    const table = Object.fromEntries(Object.entries(STATES).map(([name, state]) => [name, {
      start: enabled(state, 'start'),
      stop: enabled(state, 'stop'),
      restart: enabled(state, 'restart'),
      wiki: enabled(state, 'wikiHome')
    }]));

    expect(table).to.deep.equal({
      notInstalled: { start: false, stop: false, restart: false, wiki: false },
      stopped: { start: true, stop: false, restart: false, wiki: false },
      running: { start: false, stop: true, restart: true, wiki: true },
      busy: { start: false, stop: false, restart: false, wiki: true }
    });
  });

  it('should list start, stop, restart, a separator and quit under "servers"', function() {
    const servers = build(STATES.stopped)[0].submenu;
    expect(servers.map(item => item.label || item.type))
      .to.deep.equal(['הפעל שרתים', 'עצור שרתים', 'הפעל מחדש', 'separator', 'יציאה']);
    expect(findItem(build(STATES.notInstalled), 'quit').enabled).to.not.equal(false);
  });

  it('should enable every wiki command only while the wiki is shown', function() {
    for (const [state, expected] of [[STATES.stopped, false], [STATES.running, true]]) {
      const wiki = findItem(build(state), 'wiki');
      expect(wiki.submenu.filter(item => item.type !== 'separator').map(item => item.label))
        .to.deep.equal(['עמוד ראשי', 'אחורה', 'קדימה', 'רענון', 'פתח בדפדפן חיצוני']);
      for (const item of wiki.submenu.filter(entry => entry.type !== 'separator')) {
        expect(item.enabled, item.label).to.equal(expected);
      }
    }
  });

  it('should only hold disabled placeholders under "sync"', function() {
    const sync = findItem(build(STATES.running), 'sync');
    expect(sync.submenu.length).to.be.within(1, 3);
    for (const item of sync.submenu) {
      expect(item.enabled).to.be.false;
      expect(item.click).to.be.undefined;
      expect(item.label).to.include('בקרוב');
    }
  });

  it('should keep the standard editing commands, so shortcuts work in forms and in the wiki', function() {
    const roles = findItem(build(STATES.running), 'edit').submenu.map(item => item.role).filter(Boolean);
    expect(roles).to.include.members(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']);
  });

  it('should offer zoom, full screen and developer tools under "view"', function() {
    const template = build(STATES.running);
    for (const id of ['zoomIn', 'zoomOut', 'zoomReset', 'devTools']) {
      expect(findItem(template, id).accelerator, id).to.be.a('string');
    }
    expect(findItem(template, 'fullScreen').role).to.equal('togglefullscreen');
  });

  it('should call the matching action for every command', function() {
    const { actions, calls } = recordingActions();
    const template = buildMenuTemplate(STATES.running, actions, { platform: 'linux' });
    const ids = {
      start: 'start', stop: 'stop', restart: 'restart', quit: 'quit',
      wikiHome: 'wikiHome', wikiBack: 'wikiBack', wikiForward: 'wikiForward', wikiReload: 'wikiReload',
      wikiOpenExternal: 'wikiOpenExternal', zoomIn: 'zoomIn', zoomOut: 'zoomOut', zoomReset: 'zoomReset',
      devTools: 'toggleDevTools', about: 'about', openDataFolder: 'openDataFolder'
    };
    for (const [id, action] of Object.entries(ids)) {
      findItem(template, id).click();
      expect(calls.pop(), id).to.equal(action);
    }
  });

  it('should only describe the menu, without calling anything', function() {
    const { actions, calls } = recordingActions();
    buildMenuTemplate(STATES.running, actions, { platform: 'win32' });
    expect(calls).to.be.empty;
  });

  it('should give every command a label and no duplicate ids', function() {
    const items = allItems(build(STATES.running));
    const ids = items.map(item => item.id).filter(Boolean);
    expect(new Set(ids).size).to.equal(ids.length);
    for (const item of items) {
      if (item.type !== 'separator' && !item.role) {
        expect(item.label, JSON.stringify(item.id)).to.be.a('string').and.not.empty;
      }
    }
  });
});
