// The application menu (Hebrew). Built from the app's state, and rebuilt
// whenever it changes, so items are only enabled when they can be used.
//
// buildMenuTemplate() is pure: it only describes the menu, and every action is
// a function of `actions`, which the main process shares with the buttons of
// the app page.

const APP_NAME = 'המכלול אופליין';

// `state`: { installed, running, busy, wikiShown }
// `actions`: start, stop, restart, quit, wikiHome, wikiBack, wikiForward,
//   wikiReload, wikiOpenExternal, zoomIn, zoomOut, zoomReset, toggleDevTools,
//   about, openDataFolder
function buildMenuTemplate(state, actions, { platform = process.platform } = {}) {
  const busy = Boolean(state.busy);
  const canStart = Boolean(state.installed) && !state.running && !busy;
  const canStop = Boolean(state.running) && !busy;
  const wiki = Boolean(state.wikiShown);
  const isMac = platform === 'darwin';

  const template = [];

  if (isMac) {
    template.push({
      label: APP_NAME,
      submenu: [
        { id: 'about', label: 'אודות', click: () => actions.about() },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: 'יציאה', accelerator: 'Cmd+Q', click: () => actions.quit() }
      ]
    });
  }

  template.push({
    id: 'servers',
    label: 'שרתים',
    submenu: [
      { id: 'start', label: 'הפעל שרתים', enabled: canStart, click: () => actions.start() },
      { id: 'stop', label: 'עצור שרתים', enabled: canStop, click: () => actions.stop() },
      { id: 'restart', label: 'הפעל מחדש', enabled: canStop, click: () => actions.restart() },
      ...(isMac ? [] : [
        { type: 'separator' },
        { id: 'quit', label: 'יציאה', accelerator: 'Ctrl+Q', click: () => actions.quit() }
      ])
    ]
  });

  template.push({
    id: 'wiki',
    label: 'ויקי',
    enabled: wiki,
    submenu: [
      { id: 'wikiHome', label: 'עמוד ראשי', accelerator: 'Alt+Home', enabled: wiki, click: () => actions.wikiHome() },
      { id: 'wikiBack', label: 'אחורה', accelerator: isMac ? 'Cmd+[' : 'Alt+Left', enabled: wiki, click: () => actions.wikiBack() },
      { id: 'wikiForward', label: 'קדימה', accelerator: isMac ? 'Cmd+]' : 'Alt+Right', enabled: wiki, click: () => actions.wikiForward() },
      { id: 'wikiReload', label: 'רענון', accelerator: 'CmdOrCtrl+R', enabled: wiki, click: () => actions.wikiReload() },
      { type: 'separator' },
      { id: 'wikiOpenExternal', label: 'פתח בדפדפן חיצוני', enabled: wiki, click: () => actions.wikiOpenExternal() }
    ]
  });

  // Room for synchronising with the Hamichlol website, which is still to come
  template.push({
    id: 'sync',
    label: 'סנכרון',
    submenu: [
      { id: 'syncSite', label: 'סנכרון עם אתר המכלול (בקרוב)', enabled: false },
      { id: 'syncSettings', label: 'הגדרות סנכרון (בקרוב)', enabled: false }
    ]
  });

  // Zoom applies to the wiki while it is shown (see actions.zoomIn and friends)
  template.push({
    id: 'view',
    label: 'תצוגה',
    submenu: [
      { id: 'zoomIn', label: 'הגדל', accelerator: 'CmdOrCtrl+=', click: () => actions.zoomIn() },
      // Second shortcut for the same command, on keyboards with a separate "+" key
      { label: 'הגדל', accelerator: 'CmdOrCtrl+Plus', visible: false, acceleratorWorksWhenHidden: true, click: () => actions.zoomIn() },
      { id: 'zoomOut', label: 'הקטן', accelerator: 'CmdOrCtrl+-', click: () => actions.zoomOut() },
      { id: 'zoomReset', label: 'גודל רגיל', accelerator: 'CmdOrCtrl+0', click: () => actions.zoomReset() },
      { type: 'separator' },
      { id: 'fullScreen', label: 'מסך מלא', role: 'togglefullscreen' },
      { type: 'separator' },
      { id: 'devTools', label: 'כלי פיתוח', accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I', click: () => actions.toggleDevTools() }
    ]
  });

  template.push({
    id: 'edit',
    label: 'עריכה',
    submenu: [
      { label: 'בטל', role: 'undo' },
      { label: 'בצע שוב', role: 'redo' },
      { type: 'separator' },
      { label: 'גזור', role: 'cut' },
      { label: 'העתק', role: 'copy' },
      { label: 'הדבק', role: 'paste' },
      { label: 'בחר הכול', role: 'selectAll' }
    ]
  });

  template.push({
    id: 'help',
    label: 'עזרה',
    submenu: [
      ...(isMac ? [] : [{ id: 'about', label: 'אודות', click: () => actions.about() }]),
      { id: 'openDataFolder', label: 'פתח את תיקיית הנתונים', click: () => actions.openDataFolder() }
    ]
  });

  return template;
}

// Find a menu item (or submenu) of a template by its id, for tests and updates
function findItem(template, id) {
  for (const item of template) {
    if (item.id === id) {
      return item;
    }
    if (Array.isArray(item.submenu)) {
      const found = findItem(item.submenu, id);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

module.exports = { APP_NAME, buildMenuTemplate, findItem };
