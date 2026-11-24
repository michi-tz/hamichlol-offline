// The app-managed settings file (src/wiki-settings.js): what it contains, how
// LocalSettings.php includes it, and that rewriting it is idempotent and never
// fights the user's own edits.

const { describe, it, beforeEach, afterEach } = require('mocha');
const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const { makeTempDir, removeDir } = require('./helpers');
const wikiSettings = require('../src/wiki-settings');

const { SETTINGS_FILE, SCHEMA_STAMP_FILE, buildSettings, addInclude, writeSettings, writeSchemaStamp, readSchemaStamp } = wikiSettings;

// As install.php writes it, shortened
const INSTALLED_SETTINGS = [
  '<?php',
  '$wgSitename = "המכלול אופליין";',
  '$wgMetaNamespace = "המכלול_אופליין";',
  '$wgLocaltimezone = "UTC";',
  "wfLoadSkin( 'Vector' );",
  ''
].join('\n');

describe('App-managed wiki settings', function() {
  let mw;

  // A MediaWiki tree with the given bundled extensions
  function tree(extensions) {
    for (const name of extensions) {
      fs.mkdirSync(path.join(mw, 'extensions', name), { recursive: true });
      fs.writeFileSync(path.join(mw, 'extensions', name, 'extension.json'), '{}');
    }
    fs.writeFileSync(path.join(mw, 'LocalSettings.php'), INSTALLED_SETTINGS);
  }

  const localSettings = () => fs.readFileSync(path.join(mw, 'LocalSettings.php'), 'utf8');
  const settingsFile = () => fs.readFileSync(path.join(mw, SETTINGS_FILE), 'utf8');
  const loaded = source => [...(/wfLoadExtensions\( \[([^\]]*)\]/.exec(source)[1]).matchAll(/'([^']+)'/g)].map(match => match[1]);

  beforeEach(function() {
    mw = makeTempDir('settings');
  });

  afterEach(function() {
    removeDir(mw);
  });

  describe('Content', function() {
    it('should load the enabled extensions that the MediaWiki tree has, and only those', function() {
      tree(['Cite', 'Scribunto', 'ParserFunctions', 'Echo', 'AbuseFilter']);

      // In the order of the list, without extensions the app leaves off
      expect(loaded(buildSettings(mw))).to.deep.equal(['ParserFunctions', 'Scribunto', 'Cite']);
    });

    it('should load every extension of the list from a full release', function() {
      tree([...wikiSettings.EXTENSIONS, 'Echo', 'Thanks', 'Linter']);

      expect(loaded(buildSettings(mw))).to.deep.equal(wikiSettings.EXTENSIONS);
    });

    it('should leave CodeEditor off without WikiEditor, which it needs', function() {
      tree(['CodeEditor', 'Scribunto']);

      expect(loaded(buildSettings(mw))).to.deep.equal(['Scribunto']);
    });

    it('should name namespace 4 as on the site and keep the installed name as an alias', function() {
      tree([]);
      const source = buildSettings(mw);

      expect(source).to.include("$wgMetaNamespace = 'המכלול';");
      // The name install.php derived from the site name, as written or as MediaWiki derives it
      expect(source).to.include('$wgMetaNamespace ?: str_replace( \' \', \'_\', $wgSitename )');
      expect(source).to.include('$wgNamespaceAliases[$hamichlolOldProjectNamespace] = NS_PROJECT;');
    });

    it('should define the site\'s own namespaces with subpages, and its aliases', function() {
      tree([]);
      const source = buildSettings(mw);

      for (const [id, name] of Object.entries({ 3000: 'טיוטה', 3001: 'שיחת_טיוטה', 4000: 'פורטל', 4001: 'שיחת_פורטל', 5000: 'תיקון', 5001: 'שיחת_תיקון' })) {
        expect(source).to.include(`$wgExtraNamespaces[${id}] = '${name}';`);
        expect(source).to.include(`$wgNamespacesWithSubpages[${id}] = true;`);
      }
      expect(source).to.include("'מכ' => 4,");
      expect(source).to.include("'Image_talk' => 7,");
      expect(source).to.include("'פ' => 4000,");
      // The user's own aliases win over the app's
      expect(source).to.include('] + $wgNamespaceAliases;');
    });

    it('should set what changes how a page of the site parses or looks', function() {
      tree([]);
      const source = buildSettings(mw);

      expect(source).to.include("$wgLocaltimezone = 'Asia/Jerusalem';");
      expect(source).to.include("$wgExternalLinkTarget = '_blank';");
      expect(source).to.include('$wgMaxArticleSize = 30000;');
      expect(source).to.include('$wgPFEnableStringFunctions = false;');
      expect(source).to.include('$wgUseInstantCommons = false;');
      expect(source).to.include("$wgDefaultUserOptions['math'] = 'native';");
    });

    it('should depend on nothing but the tree, so it is the same every time', function() {
      tree(['Cite']);

      expect(buildSettings(mw)).to.equal(buildSettings(mw));
    });
  });

  describe('Including it from LocalSettings.php', function() {
    it('should add the include line once, at the end, after the user\'s settings', function() {
      const once = addInclude(INSTALLED_SETTINGS);

      expect(once.startsWith(INSTALLED_SETTINGS.trimEnd())).to.be.true;
      expect(once.trimEnd().split('\n').pop()).to.equal(`require_once "$IP/${SETTINGS_FILE}";`);
      expect(addInclude(once)).to.equal(once);
    });

    it('should not add it again when the user switched it off', function() {
      const switchedOff = addInclude(INSTALLED_SETTINGS).replace('require_once', '# require_once');

      expect(addInclude(switchedOff)).to.equal(switchedOff);
    });

    it('should keep settings the user added after it', function() {
      const edited = `${addInclude(INSTALLED_SETTINGS)}$wgDefaultSkin = 'timeless';\n`;

      expect(addInclude(edited)).to.equal(edited);
    });
  });

  describe('Writing the files', function() {
    it('should write the settings file and include it on a fresh wiki', function() {
      tree(['Cite']);

      const result = writeSettings(mw);

      expect(settingsFile()).to.equal(buildSettings(mw));
      expect(localSettings()).to.equal(addInclude(INSTALLED_SETTINGS));
      // update.php has not run for it yet
      expect(result).to.deep.equal({ hash: wikiSettings.settingsHash(settingsFile()), schemaUpToDate: false });
      expect(fs.existsSync(path.join(mw, SCHEMA_STAMP_FILE))).to.be.false;
    });

    it('should change nothing when written again', function() {
      tree(['Cite']);
      const first = writeSettings(mw);
      writeSchemaStamp(mw, first.hash);
      const before = { local: localSettings(), settings: settingsFile(), mtime: fs.statSync(path.join(mw, SETTINGS_FILE)).mtimeMs };

      const second = writeSettings(mw);

      expect(second).to.deep.equal({ hash: first.hash, schemaUpToDate: true });
      expect(localSettings()).to.equal(before.local);
      expect(settingsFile()).to.equal(before.settings);
      expect(fs.statSync(path.join(mw, SETTINGS_FILE)).mtimeMs).to.equal(before.mtime);
    });

    it('should ask for the schema update again when the settings change', function() {
      tree(['Cite']);
      writeSchemaStamp(mw, writeSettings(mw).hash);
      // E.g. a new release of MediaWiki or of the app enables another extension
      tree(['Scribunto']);

      const result = writeSettings(mw);

      expect(result.schemaUpToDate).to.be.false;
      expect(loaded(settingsFile())).to.deep.equal(['Scribunto', 'Cite']);
    });

    it('should move the time of LocalSettings.php when the settings change, so cached pages go', function() {
      tree(['Cite']);
      writeSettings(mw);
      const local = path.join(mw, 'LocalSettings.php');
      const past = new Date(Date.now() - 60 * 60 * 1000);
      fs.utimesSync(local, past, past);
      const before = fs.statSync(local).mtimeMs;

      writeSettings(mw);
      expect(fs.statSync(local).mtimeMs).to.equal(before);

      tree(['Scribunto']);
      writeSettings(mw);
      expect(fs.statSync(local).mtimeMs).to.be.above(before);
    });

    it('should replace a settings file the user edited', function() {
      tree(['Cite']);
      writeSettings(mw);
      fs.appendFileSync(path.join(mw, SETTINGS_FILE), "$wgSomething = 'edited';\n");

      writeSettings(mw);

      expect(settingsFile()).to.equal(buildSettings(mw));
    });

    it('should keep the user\'s own changes to LocalSettings.php', function() {
      tree(['Cite']);
      writeSettings(mw);
      const edited = `${localSettings()}$wgDefaultSkin = 'timeless';\n`;
      fs.writeFileSync(path.join(mw, 'LocalSettings.php'), edited);

      writeSettings(mw);

      expect(localSettings()).to.equal(edited);
    });

    it('should treat a damaged schema stamp as missing', function() {
      tree([]);
      fs.writeFileSync(path.join(mw, SCHEMA_STAMP_FILE), '{"settings": 4');

      expect(readSchemaStamp(mw)).to.be.null;
      expect(writeSettings(mw).schemaUpToDate).to.be.false;
    });

    it('should tell what it would write without writing anything', function() {
      tree(['Cite']);

      const plan = wikiSettings.planSettings(mw);

      expect(fs.existsSync(path.join(mw, SETTINGS_FILE))).to.be.false;
      expect(localSettings()).to.equal(INSTALLED_SETTINGS);
      expect(plan).to.deep.equal(writeSettings(mw));
    });

    it('should make the programs the extensions run executable again', function() {
      if (process.platform === 'win32') {
        this.skip(); // no executable bit
      }
      tree([]);
      const lua = path.join(mw, wikiSettings.BUNDLED_PROGRAMS[0]);
      fs.mkdirSync(path.dirname(lua), { recursive: true });
      // As adm-zip extracts it
      fs.writeFileSync(lua, 'binary');
      fs.chmodSync(lua, 0o644);

      writeSettings(mw);

      expect(fs.statSync(lua).mode & 0o777).to.equal(0o755);
    });
  });

  // What a failed schema update puts back (server-manager's syncWikiSettings)
  describe('Going back after a failed update', function() {
    const { removeInclude, previousFiles, restoreFiles, readSchemaFailure, writeSchemaFailure, clearSchemaFailure, SCHEMA_FAILURE_FILE } = wikiSettings;
    const exists = name => fs.existsSync(path.join(mw, name));

    it('should take out exactly the include block it added', function() {
      const included = addInclude(INSTALLED_SETTINGS);
      expect(removeInclude(included)).to.equal(INSTALLED_SETTINGS);
      // With the user's own settings after it
      expect(removeInclude(`${included}$wgDefaultSkin = 'timeless';\n`)).to.equal(`${INSTALLED_SETTINGS}$wgDefaultSkin = 'timeless';\n`);
      // Nothing to take out
      expect(removeInclude(INSTALLED_SETTINGS)).to.equal(INSTALLED_SETTINGS);
      // Changed by the user: not guessed at
      expect(removeInclude(included.replace('require_once', '# require_once'))).to.be.null;
      expect(removeInclude(`${included}require_once "$IP/${SETTINGS_FILE}";\n`)).to.be.null;
    });

    it('should go back to the previous settings once an update has succeeded for them', function() {
      tree(['Cite']);
      writeSchemaStamp(mw, writeSettings(mw).hash);
      const before = { local: localSettings(), settings: settingsFile(), stamp: fs.readFileSync(path.join(mw, SCHEMA_STAMP_FILE), 'utf8') };
      const previous = previousFiles(mw);

      tree(['Cite', 'Scribunto']);
      writeSchemaStamp(mw, writeSettings(mw).hash);
      restoreFiles(mw, previous);

      expect(localSettings()).to.equal(before.local);
      expect(settingsFile()).to.equal(before.settings);
      expect(fs.readFileSync(path.join(mw, SCHEMA_STAMP_FILE), 'utf8')).to.equal(before.stamp);
    });

    it('should go back to the wiki without the app\'s settings when no update ever succeeded', function() {
      tree(['Cite']);
      // As installMediaWiki leaves it
      writeSettings(mw);
      const previous = previousFiles(mw);

      writeSchemaStamp(mw, writeSettings(mw).hash);
      restoreFiles(mw, previous);
      restoreFiles(mw, previous); // can be repeated

      expect(localSettings()).to.equal(INSTALLED_SETTINGS);
      expect(exists(SETTINGS_FILE)).to.be.false;
      expect(exists(SCHEMA_STAMP_FILE)).to.be.false;
    });

    it('should keep an include line the user changed, and the file it may include', function() {
      tree(['Cite']);
      writeSettings(mw);
      const edited = localSettings().replace('require_once', '# require_once');
      fs.writeFileSync(path.join(mw, 'LocalSettings.php'), edited);
      const previous = previousFiles(mw);

      restoreFiles(mw, previous);

      expect(localSettings()).to.equal(edited);
      expect(exists(SETTINGS_FILE)).to.be.true;
    });

    it('should record a failure, keeping the time sync has been blocked since', function() {
      tree([]);
      expect(readSchemaFailure(mw)).to.be.null;

      writeSchemaFailure(mw, 'aaa', 'first', new Date('2026-11-01T10:00:00Z'));
      writeSchemaFailure(mw, 'bbb', 'second', new Date('2026-11-05T10:00:00Z'));

      expect(readSchemaFailure(mw)).to.deep.equal({
        settings: 'bbb', since: '2026-11-01T10:00:00.000Z', failedAt: '2026-11-05T10:00:00.000Z', error: 'second'
      });
      clearSchemaFailure(mw);
      expect(readSchemaFailure(mw)).to.be.null;
    });

    it('should take a damaged failure record as a failure of no particular settings', function() {
      tree([]);
      fs.writeFileSync(path.join(mw, SCHEMA_FAILURE_FILE), '{"settings": ');

      expect(readSchemaFailure(mw)).to.include({ settings: null });
    });
  });
describe('Starting Lua on Windows', function() {
    const { LUA_INTERPRETER_FILE, fixWindowsLuaLaunch } = wikiSettings;
    // The part of Scribunto's LuaStandaloneInterpreter.php that matters, as released
    const ORIGINAL = [
      '<?php',
      "\t\tif ( php_uname( 's' ) == 'Windows NT' ) {",
      "\t\t\t// PHP's invokation of cmd.exe in proc_open() is broken:",
      "\t\t\t$cmd = '\"' . $cmd . '\"';",
      '\t\t}',
      ''
    ].join('\r\n');
    const interpreter = () => path.join(mw, LUA_INTERPRETER_FILE);
    const write = content => {
      fs.mkdirSync(path.dirname(interpreter()), { recursive: true });
      fs.writeFileSync(interpreter(), content);
    };
    const read = () => fs.readFileSync(interpreter(), 'utf8');

    it('should remove the extra quotes around the command', function() {
      write(ORIGINAL);

      expect(fixWindowsLuaLaunch(mw, 'win32')).to.equal('fixed');

      const fixed = read();
      expect(fixed).to.not.include(`$cmd = '"' . $cmd . '"';`);
      expect(fixed).to.include('hamichlol-offline');
      // Everything else, line endings included, is as it was
      expect(fixed.split('\r\n')).to.have.length(ORIGINAL.split('\r\n').length);
      expect(fixed).to.include("if ( php_uname( 's' ) == 'Windows NT' ) {");
    });

    it('should change nothing the second time', function() {
      write(ORIGINAL);
      fixWindowsLuaLaunch(mw, 'win32');
      const once = read();

      expect(fixWindowsLuaLaunch(mw, 'win32')).to.equal('already-fixed');
      expect(read()).to.equal(once);
    });

    it('should leave the file alone on other systems', function() {
      write(ORIGINAL);

      expect(fixWindowsLuaLaunch(mw, 'linux')).to.equal('not-needed');
      expect(fixWindowsLuaLaunch(mw, 'darwin')).to.equal('not-needed');
      expect(read()).to.equal(ORIGINAL);
    });

    it('should leave a Scribunto that changed as it is', function() {
      const changed = ORIGINAL.replace(`$cmd = '"' . $cmd . '"';`, '$cmd = wrapForCmd( $cmd );');
      const twice = ORIGINAL.replace('\t\t}', `\t\t\t$cmd = '"' . $cmd . '"';\r\n\t\t}`);
      for (const content of [changed, twice]) {
        write(content);
        expect(fixWindowsLuaLaunch(mw, 'win32')).to.equal('unrecognised');
        expect(read()).to.equal(content);
      }
    });

    it('should report a file it cannot write instead of throwing', function() {
      write(ORIGINAL);
      // The file is written aside first; a folder in that place makes it fail
      fs.mkdirSync(`${interpreter()}.tmp`);

      expect(fixWindowsLuaLaunch(mw, 'win32')).to.equal('failed');
      expect(read()).to.equal(ORIGINAL);
    });

    it('should do nothing without Scribunto', function() {
      expect(fixWindowsLuaLaunch(mw, 'win32')).to.equal('no-scribunto');
      expect(fs.existsSync(interpreter())).to.be.false;
    });

    it('should be applied whenever the settings are written', function() {
      if (process.platform !== 'win32') {
        this.skip();
      }
      tree(['Scribunto']);
      write(ORIGINAL);

      writeSettings(mw);

      expect(read()).to.not.include(`$cmd = '"' . $cmd . '"';`);
    });
  });
});
