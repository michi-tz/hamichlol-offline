// Extensions and site settings of the local wiki, managed by the app.
//
// The app owns one file in the MediaWiki folder, HamichlolSettings.php, and
// rewrites it whenever its content should change (a new version of the app, a
// new MediaWiki release). LocalSettings.php, which belongs to the user, only
// gets one line that includes it, added once at the end. The user's own
// settings are never rewritten:
//   - a setting the user puts after that line overrides the app's
//   - commenting the line out (or removing it while leaving the file name in a
//     comment) switches the app's settings off; the line is never added again
//     while the file name appears anywhere in LocalSettings.php
//
// Goal: pages imported from the Hamichlol site (www.hamichlol.org.il, MediaWiki
// 1.46.2) render as they do there, using only extensions that ship inside the
// MediaWiki release archive. Nothing is downloaded from elsewhere.
//
// Extensions that add database tables need update.php: the app runs it when
// the generated file changes (see server-manager's syncWikiSettings), and
// records which content it ran for in SCHEMA_STAMP_FILE. When that update
// fails, the wiki is put back as it was (previousFiles / restoreFiles here, the
// database by server-manager) and SCHEMA_FAILURE_FILE records which content
// failed; while it is there, synchronisation with the site is blocked.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = 'HamichlolSettings.php';
// Which settings file update.php last ran for, successfully
const SCHEMA_STAMP_FILE = 'HamichlolSettings.schema.json';
// Which settings file the update failed for, and since when the wiki runs
// without it. In the MediaWiki folder, like the stamp: an upgrade of MediaWiki
// that succeeds brings a new tree without it (its own update.php covered the
// settings), and one that fails puts the old tree back with it.
const SCHEMA_FAILURE_FILE = 'HamichlolSettings.failed.json';

const INCLUDE_MARKER = '# Added by Hamichlol Offline: extensions and site settings managed by the app';
const INCLUDE_BLOCK = [
  INCLUDE_MARKER,
  `# (${SETTINGS_FILE}, rewritten by the app). To change one of its settings, set it again`,
  '# below this line. To switch the whole file off, comment out the next line.',
  `require_once "$IP/${SETTINGS_FILE}";`,
  ''
].join('\n');

// Bundled extensions the site uses, enabled locally. All of them are in the
// MediaWiki 1.46.2 release archive; an extension missing from the installed
// tree is skipped, so an older or trimmed MediaWiki still starts.
const EXTENSIONS = [
  // Rendering of pages, templates and modules
  'ParserFunctions', //    {{#if}}, {{#switch}}, {{#expr}}, {{#time}} (with the Hebrew names: #תנאי ...)
  'Scribunto', //          {{#invoke}} and the יחידה: namespace (Lua modules)
  'Cite', //               <ref>, <references>
  'TemplateStyles', //     <templatestyles src=...>
  'TemplateData', //       <templatedata> on template pages (shown as a table, not raw JSON)
  'CategoryTree', //       <categorytree>, {{#categorytree}}
  'ImageMap', //           <imagemap>
  'InputBox', //           <inputbox>
  'Poem', //               <poem>
  'Math', //               <math>, <ce>, <chem>; rendered to MathML in PHP ("native"), no service
  'SyntaxHighlight_GeSHi', // <syntaxhighlight>, <source>; plain <pre> where Pygments cannot run
  'Gadgets', //            the site's gadgets, once MediaWiki:Gadgets-definition is imported
  'PageImages', //         page thumbnails in the search suggestions of the skins
  'MultimediaViewer', //   the site's image viewer, for pages with local images
  // Editing
  'WikiEditor', //         the edit toolbar
  'CodeEditor', //         editing modules, CSS and JSON (needs WikiEditor)
  'VisualEditor' //        visual editing; Parsoid runs inside MediaWiki, no service
];

// On the site but not enabled here:
//   AbuseFilter, CheckUser, ConfirmEdit, Nuke - protection against other
//     users' abuse; a single-user offline copy has none, and AbuseFilter,
//     CheckUser and Nuke add tables (ConfirmEdit would put captchas on the
//     user's own edits)
//   Echo, Thanks, DiscussionTools - notifications and talk-page tools of a
//     shared wiki; they add tables (DiscussionTools also needs Linter). The
//     user's notifications from the site come from the site itself (sync step 5)
//   Linter - lint tracking for the site's maintainers; adds a table and work
//     on every save
//   ReplaceText - bulk replacement across pages, which would turn imported
//     pages into local edits that conflict with later updates from the site
//   TextExtracts - plain-text extracts for API clients (Popups, apps); nothing
//     in the local wiki reads them
//   PdfHandler - needs Ghostscript and poppler on the computer; images are
//     optional and come as thumbnails

// Namespaces of the site (siteinfo, November 2026). Custom ones, all with subpages.
const EXTRA_NAMESPACES = {
  3000: 'טיוטה',
  3001: 'שיחת_טיוטה',
  4000: 'פורטל',
  4001: 'שיחת_פורטל',
  5000: 'תיקון',
  5001: 'שיחת_תיקון'
};

// Name of namespace 4 on the site. Titles of namespace 4 import by number
// (importDump maps namespaces below 100 by number), but links and
// transclusions in the content, such as [[המכלול:...]], only resolve if the
// local name is the same.
const PROJECT_NAMESPACE = 'המכלול';

// Namespace aliases of the site
const NAMESPACE_ALIASES = {
  'מי': -1,
  'ש': 1,
  'U': 2,
  'מש': 2,
  'משתמשת': 2,
  'שיחת_משתמשת': 3,
  'שמש': 3,
  'ויקיפדיה': 4,
  'מכ': 4,
  'שיחת_ויקיפדיה': 5,
  'שמכ': 5,
  'Image': 6,
  'קו': 6,
  'תמונה': 6,
  'Image_talk': 7,
  'שיחת_תמונה': 7,
  'שקו': 7,
  'מו': 8,
  'שמו': 9,
  'תב': 10,
  'שתב': 11,
  'עז': 12,
  'שעז': 13,
  'קט': 14,
  'שקט': 15,
  'י': 828,
  'שי': 829,
  'טי': 3000,
  'שטי': 3001,
  'פ': 4000,
  'שפ': 4001
};

// Programs inside the release that the extensions run. A zip archive keeps
// their executable bit, but extracting it with adm-zip does not, so MediaWiki
// downloaded by the app (on Linux and macOS) has them without it.
const BUNDLED_PROGRAMS = [
  'extensions/Scribunto/includes/Engines/LuaStandalone/binaries/lua5_1_5_linux_64_generic/lua',
  'extensions/Scribunto/includes/Engines/LuaStandalone/binaries/lua5_1_5_linux_32_generic/lua',
  'extensions/Scribunto/includes/Engines/LuaStandalone/binaries/lua5_1_5_mac_lion_fat_generic/lua',
  'extensions/SyntaxHighlight_GeSHi/pygments/pygmentize'
];

function phpString(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function phpArrayLines(entries, indent = '\t') {
  return entries.map(([key, value]) => `${indent}${typeof key === 'number' ? key : phpString(key)} => ${value},`);
}

// Extensions of EXTENSIONS that are present in `mediaWikiDir`.
function availableExtensions(mediaWikiDir) {
  return EXTENSIONS.filter(name => fs.existsSync(path.join(mediaWikiDir, 'extensions', name, 'extension.json')));
}

// Content of HamichlolSettings.php for the MediaWiki tree in `mediaWikiDir`.
function buildSettings(mediaWikiDir) {
  const extensions = availableExtensions(mediaWikiDir);
  // CodeEditor cannot be loaded without WikiEditor
  const loaded = extensions.filter(name => name !== 'CodeEditor' || extensions.includes('WikiEditor'));
  const lines = [
    '<?php',
    '# Hamichlol Offline: extensions and site settings, managed by the app.',
    '# This file is rewritten by the app; changes made here are lost. To change a',
    '# setting, set it again in LocalSettings.php after the line that includes this file.',
    '',
    "if ( !defined( 'MEDIAWIKI' ) ) {",
    '\texit;',
    '}',
    '',
    '## Extensions bundled with MediaWiki that the Hamichlol site uses',
    'wfLoadExtensions( [',
    ...loaded.map(name => `\t${phpString(name)},`),
    '] );',
    '',
    '## Namespaces as on the site, so imported titles land in the same namespace',
    '# The name of namespace 4 install.php derived from the site name stays an alias,',
    "# so links to the wiki's own project pages keep working",
    '$hamichlolOldProjectNamespace = $wgMetaNamespace ?: str_replace( \' \', \'_\', $wgSitename );',
    `if ( $hamichlolOldProjectNamespace !== ${phpString(PROJECT_NAMESPACE)} ) {`,
    '\t$wgNamespaceAliases[$hamichlolOldProjectNamespace] = NS_PROJECT;',
    "\t$wgNamespaceAliases['שיחת_' . $hamichlolOldProjectNamespace] = NS_PROJECT_TALK;",
    '}',
    'unset( $hamichlolOldProjectNamespace );',
    `$wgMetaNamespace = ${phpString(PROJECT_NAMESPACE)};`,
    ...Object.entries(EXTRA_NAMESPACES).map(([id, name]) => `$wgExtraNamespaces[${id}] = ${phpString(name)};`),
    ...Object.keys(EXTRA_NAMESPACES).map(id => `$wgNamespacesWithSubpages[${id}] = true;`),
    '$wgNamespaceAliases = [',
    ...phpArrayLines(Object.entries(NAMESPACE_ALIASES).map(([alias, id]) => [alias, id])),
    '] + $wgNamespaceAliases;',
    '',
    '## Settings of the site that change how a page parses or looks',
    "$wgLocaltimezone = 'Asia/Jerusalem';",
    "$wgCategoryCollation = 'uppercase';",
    "$wgExternalLinkTarget = '_blank';",
    '# The site allows pages of up to 30,000 KiB; with the default (2,048 KiB) the import',
    '# of a longer page fails',
    '$wgMaxArticleSize = 30000;',
    '$wgThumbLimits = [ 120, 150, 180, 200, 220, 250, 300, 400 ];',
    '$wgCiteResponsiveReferences = true;',
    '# Off on the site too: {{#len:}} and the other string functions stay unparsed there',
    '$wgPFEnableStringFunctions = false;',
    '',
    '## Offline: nothing may wait for a service on the network',
    '$wgUseInstantCommons = false;',
    '$wgPingback = false;',
    '# Math renders to MathML in PHP; the other modes need a service or MathJax',
    "$wgDefaultUserOptions['math'] = 'native';",
    '',
    '## Scribunto: the Lua interpreter bundled with the extension (Windows x86/x64,',
    '## Linux x86/x64, macOS x86_64), unless PHP has the luasandbox extension.',
    '## The limits are higher than on the site, which runs the faster LuaSandbox;',
    '## a slow page is better than a script error the site does not show.',
    "$wgScribuntoDefaultEngine = 'luaautodetect';",
    "$wgScribuntoEngineConf['luastandalone']['cpuLimit'] = 30;",
    "$wgScribuntoEngineConf['luastandalone']['memoryLimit'] = 100 * 1024 * 1024;",
    "$wgScribuntoEngineConf['luasandbox']['cpuLimit'] = 30;",
    "$wgScribuntoEngineConf['luasandbox']['memoryLimit'] = 100 * 1024 * 1024;",
    ''
  ];
  return lines.join('\n');
}

// Fingerprint of a settings file's content, for SCHEMA_STAMP_FILE.
function settingsHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

// LocalSettings.php source with the include line added at the end, unless
// the settings file is already mentioned anywhere (included, or switched off
// by the user).
function addInclude(localSettingsSource) {
  if (localSettingsSource.includes(SETTINGS_FILE)) {
    return localSettingsSource;
  }
  return `${localSettingsSource.replace(/\s*$/, '')}\n\n${INCLUDE_BLOCK}`;
}

// LocalSettings.php source without the include block addInclude() added, or
// null when the block is there but not as the app wrote it (the user changed
// it): the app then does not guess what to take out.
function removeInclude(localSettingsSource) {
  if (!localSettingsSource.includes(SETTINGS_FILE)) {
    return localSettingsSource;
  }
  const at = localSettingsSource.lastIndexOf(INCLUDE_BLOCK);
  if (at === -1 || localSettingsSource.indexOf(SETTINGS_FILE) < at ||
      localSettingsSource.slice(at + INCLUDE_BLOCK.length).includes(SETTINGS_FILE)) {
    return null;
  }
  const before = localSettingsSource.slice(0, at).replace(/\s*$/, '\n');
  return before + localSettingsSource.slice(at + INCLUDE_BLOCK.length);
}

// Restore the executable bit of the programs the extensions run (Unix only).
function makeProgramsExecutable(mediaWikiDir) {
  if (process.platform === 'win32') {
    return;
  }
  for (const relative of BUNDLED_PROGRAMS) {
    const file = path.join(mediaWikiDir, relative);
    let stats;
    try {
      stats = fs.statSync(file);
    } catch (error) {
      continue;
    }
    if (stats.isFile() && (stats.mode & 0o111) !== 0o111) {
      fs.chmodSync(file, (stats.mode & 0o777) | 0o755);
    }
  }
}

// Written aside and renamed, so PHP never reads half a file
function replaceFile(file, content) {
  fs.writeFileSync(`${file}.tmp`, content);
  fs.renameSync(`${file}.tmp`, file);
}

// What writeSettings() would write, without writing anything:
// { hash, schemaUpToDate }, as writeSettings() returns it.
function planSettings(mediaWikiDir) {
  const hash = settingsHash(buildSettings(mediaWikiDir));
  return { hash, schemaUpToDate: readSchemaStamp(mediaWikiDir) === hash };
}

// Write the app's settings into the MediaWiki tree in `mediaWikiDir`, whose
// LocalSettings.php must exist. Returns { hash, schemaUpToDate }: whether
// update.php has already run for exactly this content.
function writeSettings(mediaWikiDir) {
  const settingsFile = path.join(mediaWikiDir, SETTINGS_FILE);
  const localSettings = path.join(mediaWikiDir, 'LocalSettings.php');
  const content = buildSettings(mediaWikiDir);
  if (readIfExists(settingsFile) !== content) {
    replaceFile(settingsFile, content);
  }
  const source = fs.readFileSync(localSettings, 'utf8');
  const patched = addInclude(source);
  if (patched !== source) {
    fs.writeFileSync(localSettings, patched);
  }
  makeProgramsExecutable(mediaWikiDir);
  const hash = settingsHash(content);
  return { hash, schemaUpToDate: readSchemaStamp(mediaWikiDir) === hash };
}

// The files writeSettings() changes, as the wiki last ran with them, so that
// restoreFiles() can put them back when the schema update for new settings
// fails: { settings, stamp, localSettings }, each the file's content, or null
// for a file that is not there.
//
// Without a schema stamp, update.php never succeeded for any of the app's
// settings, so the wiki never ran with them (until it does, the app does not
// start it on them): what it ran as is the wiki without the settings file and
// without the line that includes it. That is a wiki installed by a version of
// the app that had no settings file, or a fresh installation (whose
// LocalSettings.php gets the line at installation, before the first start).
// If the user changed that line, it is kept as it is, and so is the file.
function previousFiles(mediaWikiDir) {
  const local = fs.readFileSync(path.join(mediaWikiDir, 'LocalSettings.php'), 'utf8');
  const found = {
    settings: readIfExists(path.join(mediaWikiDir, SETTINGS_FILE)),
    stamp: readIfExists(path.join(mediaWikiDir, SCHEMA_STAMP_FILE)),
    localSettings: local
  };
  if (readSchemaStamp(mediaWikiDir) !== null) {
    return found;
  }
  const withoutInclude = removeInclude(local);
  return withoutInclude === null ? found : { ...found, settings: null, localSettings: withoutInclude };
}

// Put back the files previousFiles() described. Can be repeated.
function restoreFiles(mediaWikiDir, previous) {
  const localSettings = path.join(mediaWikiDir, 'LocalSettings.php');
  // LocalSettings.php first: it must never include a settings file that is gone
  // (rewritten in place, as writeSettings() does, so it keeps its permissions;
  // a write cut off by a crash is simply repeated)
  if (typeof previous.localSettings === 'string' && readIfExists(localSettings) !== previous.localSettings) {
    fs.writeFileSync(localSettings, previous.localSettings);
  }
  for (const [name, content] of [[SETTINGS_FILE, previous.settings], [SCHEMA_STAMP_FILE, previous.stamp]]) {
    const file = path.join(mediaWikiDir, name);
    if (typeof content === 'string') {
      if (readIfExists(file) !== content) {
        replaceFile(file, content);
      }
    } else {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}.tmp`, { force: true });
    }
  }
}

function readSchemaStamp(mediaWikiDir) {
  try {
    const stamp = JSON.parse(fs.readFileSync(path.join(mediaWikiDir, SCHEMA_STAMP_FILE), 'utf8'));
    return stamp && typeof stamp.settings === 'string' ? stamp.settings : null;
  } catch (error) {
    return null;
  }
}

// Record that update.php ran successfully for the settings with `hash`.
function writeSchemaStamp(mediaWikiDir, hash) {
  fs.writeFileSync(path.join(mediaWikiDir, SCHEMA_STAMP_FILE), JSON.stringify({ settings: hash }, null, 2));
}

// The failed update: { settings, since, failedAt, error }, or null. A damaged
// record still counts as a failure (of no particular content, so the next
// start tries again): sync is never unblocked by damage.
function readSchemaFailure(mediaWikiDir) {
  const file = path.join(mediaWikiDir, SCHEMA_FAILURE_FILE);
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return null;
  }
  try {
    const record = JSON.parse(source);
    if (record && typeof record === 'object' && typeof record.settings === 'string') {
      return record;
    }
  } catch (error) {
    // damaged
  }
  return { settings: null, since: null, failedAt: null, error: null };
}

// Record that the update for the settings with `hash` failed with `error`
// (a message), keeping the time of the first failure while sync stays blocked.
function writeSchemaFailure(mediaWikiDir, hash, error, now = new Date()) {
  const earlier = readSchemaFailure(mediaWikiDir);
  const record = {
    settings: hash,
    since: (earlier && earlier.since) || now.toISOString(),
    failedAt: now.toISOString(),
    error
  };
  replaceFile(path.join(mediaWikiDir, SCHEMA_FAILURE_FILE), JSON.stringify(record, null, 2));
}

function clearSchemaFailure(mediaWikiDir) {
  const file = path.join(mediaWikiDir, SCHEMA_FAILURE_FILE);
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}.tmp`, { force: true });
}

module.exports = {
  SETTINGS_FILE,
  SCHEMA_STAMP_FILE,
  SCHEMA_FAILURE_FILE,
  INCLUDE_MARKER,
  EXTENSIONS,
  EXTRA_NAMESPACES,
  NAMESPACE_ALIASES,
  PROJECT_NAMESPACE,
  BUNDLED_PROGRAMS,
  availableExtensions,
  buildSettings,
  addInclude,
  removeInclude,
  settingsHash,
  makeProgramsExecutable,
  planSettings,
  writeSettings,
  previousFiles,
  restoreFiles,
  readSchemaStamp,
  writeSchemaStamp,
  readSchemaFailure,
  writeSchemaFailure,
  clearSchemaFailure
};
