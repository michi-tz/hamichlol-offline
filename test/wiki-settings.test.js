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
});
