// The checks of the administrator's user name and password, which mirror what
// MediaWiki 1.43's installer accepts (see src/admin-validation.js).

const { describe, it, beforeEach, afterEach } = require('mocha');
const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const {
  MIN_ADMIN_PASSWORD_LENGTH,
  MAX_ADMIN_PASSWORD_LENGTH,
  COMMON_PASSWORDS_FILE,
  canonicalUsername,
  validateAdminUsername,
  checkAdminPassword,
  validateAdminPassword,
  parseCommonPasswords,
  loadCommonPasswords
} = require('../src/admin-validation');
const { validateConfig } = require('../src/server-manager');
const { VALID_CONFIG, makeTempDir, removeDir } = require('./helpers');

const rule = (password, username, id, options) =>
  checkAdminPassword(password, username, options).find(entry => entry.id === id);

describe('Administrator account checks', function() {
  describe('Password', function() {
    it('should follow MediaWiki\'s policy for administrators: at least 10 bytes', function() {
      expect(MIN_ADMIN_PASSWORD_LENGTH).to.equal(10);
      expect(validateAdminPassword('123456789x', 'Admin')).to.be.null;
      expect(validateAdminPassword('12345678x', 'Admin')).to.include('10');
    });

    it('should count bytes like PHP\'s strlen(), not characters', function() {
      // Five Hebrew letters are ten bytes in UTF-8: MediaWiki accepts them
      expect(validateAdminPassword('אבגדה', 'Admin')).to.be.null;
      // Four Hebrew letters and a digit are nine bytes: MediaWiki refuses them
      expect(validateAdminPassword('אבגד1', 'Admin')).to.include('10');
      // An emoji is four bytes
      expect(validateAdminPassword('😀😀1a', 'Admin')).to.be.null;
    });

    it('should refuse passwords longer than 4096 bytes', function() {
      expect(MAX_ADMIN_PASSWORD_LENGTH).to.equal(4096);
      expect(validateAdminPassword('x'.repeat(4096), 'Admin')).to.be.null;
      expect(validateAdminPassword('x'.repeat(4097), 'Admin')).to.include('4096');
      expect(validateAdminPassword('א'.repeat(2049), 'Admin')).to.include('4096');
      expect(rule('x'.repeat(4097), 'Admin', 'maxLength').ok).to.be.false;
      expect(rule('x'.repeat(20), 'Admin', 'maxLength')).to.be.undefined;
    });

    it('should refuse a password contained in the user name, ignoring case', function() {
      expect(validateAdminPassword('Administrator', 'Administrator')).to.include('שם המשתמש');
      expect(validateAdminPassword('administrator', 'Administrator1')).to.include('שם המשתמש');
      expect(validateAdminPassword('NISTRATOR1', 'Administrator1')).to.include('שם המשתמש');
      // Compared with the name as MediaWiki stores it (underscores become spaces)
      expect(validateAdminPassword('wiki admin1', 'wiki_admin1')).to.include('שם המשתמש');
      // The other way round is allowed: the user name inside the password
      expect(validateAdminPassword('admin-password-123', 'admin')).to.be.null;
      expect(validateAdminPassword('Administrator!', 'Administrator')).to.be.null;
    });

    it('should refuse the default passwords MediaWiki blocks', function() {
      expect(validateAdminPassword('ExamplePassword', 'Admin')).to.include('דוגמה');
      expect(validateAdminPassword('examplepassword', 'Admin')).to.be.null;
      // Blocked only for its user; shorter than ten anyway, so also too short
      expect(rule('testpass', 'Apitestsysop', 'notDefault').ok).to.be.false;
      expect(rule('testpass', 'Other', 'notDefault').ok).to.be.true;
      expect(rule('Passpass1', 'useruser1', 'notDefault').ok).to.be.false;
    });

    it('should refuse common passwords when the list is available', function() {
      const commonPasswords = new Set(['1234567890', 'qwertyuiop']);
      expect(validateAdminPassword('qwertyuiop', 'Admin', { commonPasswords })).to.include('נפוצות');
      // Exact match, like isset() on the list
      expect(validateAdminPassword('QWERTYUIOP', 'Admin', { commonPasswords })).to.be.null;
      expect(rule('qwertyuiop', 'Admin', 'notCommon', { commonPasswords })).to.include({ ok: false });
    });

    it('should skip only the common password check without the list', function() {
      expect(validateAdminPassword('qwertyuiop', 'Admin')).to.be.null;
      expect(rule('qwertyuiop', 'Admin', 'notCommon')).to.include({ ok: true, skipped: true });
    });

    it('should refuse an empty or missing password', function() {
      expect(validateAdminPassword('', 'Admin')).to.be.a('string');
      expect(validateAdminPassword(undefined, 'Admin')).to.be.a('string');
    });

    it('should list every rule with a Hebrew label for the form', function() {
      const rules = checkAdminPassword('admin-password-123', 'admin', { commonPasswords: new Set() });
      expect(rules.map(entry => entry.id)).to.deep.equal(['minLength', 'notInUsername', 'notDefault', 'notCommon']);
      for (const entry of rules) {
        expect(entry.ok, entry.id).to.be.true;
        expect(entry.label, entry.id).to.match(/[א-ת]/);
      }
    });

    it('should report the first broken rule from the configuration check too', function() {
      expect(() => validateConfig({ ...VALID_CONFIG, adminUser: 'LongAdminName', adminPassword: 'longadminname' }))
        .to.throw('שם המשתמש');
      expect(() => validateConfig({ ...VALID_CONFIG, adminPassword: 'ExamplePassword' })).to.throw('דוגמה');
      expect(() => validateConfig({ ...VALID_CONFIG, adminPassword: 'qwertyuiop' }, { commonPasswords: new Set(['qwertyuiop']) }))
        .to.throw('נפוצות');
      expect(validateConfig({ ...VALID_CONFIG, adminPassword: 'qwertyuiop' }).adminPassword).to.equal('qwertyuiop');
    });

    it('should never put the password into an error message', function() {
      const password = 'ExamplePassword';
      expect(validateAdminPassword(password, 'Admin')).to.not.include(password);
      expect(validateAdminPassword('secret1', 'Admin')).to.not.include('secret1');
    });
  });

  describe('User name', function() {
    it('should accept ordinary names, including Hebrew ones and spaces', function() {
      for (const name of ['admin', 'Admin', 'Wiki Admin', 'wiki_admin', 'מנהל', 'מנהל האתר', 'O\'Brien', 'user.name', 'A-1']) {
        expect(validateAdminUsername(name), name).to.be.null;
      }
    });

    it('should capitalise the first letter and use spaces, as MediaWiki stores the name', function() {
      expect(canonicalUsername('admin')).to.equal('Admin');
      expect(canonicalUsername('  wiki__admin  ')).to.equal('Wiki admin');
      expect(canonicalUsername('מנהל')).to.equal('מנהל');
    });

    it('should refuse characters that MediaWiki does not allow in user names', function() {
      for (const char of ['#', '<', '>', '[', ']', '|', '{', '}', '/', '@', ':', '=']) {
        const error = validateAdminUsername(`ad${char}min`);
        expect(error, char).to.be.a('string');
        expect(error, char).to.include(char);
      }
    });

    it('should refuse control and invisible characters', function() {
      for (const name of ['ad\tmin', 'ad min', 'ad‏min', 'ad‮min', 'ad　min', 'admin', 'ad\u0085min']) {
        expect(validateAdminUsername(name), JSON.stringify(name)).to.be.a('string');
      }
    });

    it('should refuse sequences that page titles cannot contain', function() {
      for (const name of ['ad%41min', 'ad&amp;min', 'admin~~~', '.', '..', '~admin']) {
        expect(validateAdminUsername(name), name).to.be.a('string');
      }
      expect(validateAdminUsername('100% admin')).to.be.null;
      expect(validateAdminUsername('Tom & Jerry')).to.be.null;
    });

    it('should refuse names that look like IP addresses', function() {
      for (const name of ['127.0.0.1', '10.0.0.xxx', '1.2.3.4 - 1.2.3.9']) {
        expect(validateAdminUsername(name), name).to.include('IP');
      }
      expect(validateAdminUsername('1.2.3')).to.be.null;
    });

    it('should refuse names that are too long or reserved', function() {
      expect(validateAdminUsername('a'.repeat(235))).to.be.null;
      expect(validateAdminUsername('a'.repeat(236))).to.include('ארוך');
      expect(validateAdminUsername('א'.repeat(118))).to.include('ארוך');
      expect(validateAdminUsername('maintenance script')).to.include('שמור');
      expect(validateAdminUsername('MediaWiki default')).to.include('שמור');
    });

    it('should refuse an empty name', function() {
      expect(validateAdminUsername('')).to.be.a('string');
      expect(validateAdminUsername('   ')).to.be.a('string');
      expect(validateAdminUsername(undefined)).to.be.a('string');
    });

    it('should be checked by the configuration check', function() {
      expect(() => validateConfig({ ...VALID_CONFIG, adminUser: 'admin@site' })).to.throw('@');
      expect(validateConfig({ ...VALID_CONFIG, adminUser: ' מנהל ' }).adminUser).to.equal('מנהל');
    });
  });

  describe('Common password list', function() {
    let tempDir;

    beforeEach(function() {
      tempDir = makeTempDir('common-passwords');
    });

    afterEach(function() {
      removeDir(tempDir);
    });

    const LIST = [
      '<?php return [',
      "'123456' => 1,",
      "'password' => 1,",
      "'1234567890' => 1,",
      "'qwertyuiop' => 1,",
      "'pic\\\\\\'s' => 1,",
      "'it\\'s-mine1' => 1,",
      "'111111' => 1,",
      "'dragon' => 1,",
      "'baseball' => 1,",
      "'abc123' => 1,",
      "'football' => 1,",
      '',
      '];',
      ''
    ].join('\n');

    function writeList(content) {
      const file = path.join(tempDir, COMMON_PASSWORDS_FILE);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      return file;
    }

    it('should read the format of wikimedia/common-passwords', function() {
      const passwords = parseCommonPasswords(LIST);
      expect(passwords.size).to.equal(11);
      expect(passwords.has('1234567890')).to.be.true;
      // PHP single-quote escapes
      expect(passwords.has("pic\\'s")).to.be.true;
      expect(passwords.has("it's-mine1")).to.be.true;
    });

    it('should accept Windows line endings', function() {
      expect(parseCommonPasswords(LIST.replace(/\n/g, '\r\n')).has('qwertyuiop')).to.be.true;
    });

    it('should give up on an unknown format', function() {
      expect(parseCommonPasswords('<?php return json_decode( file_get_contents( "list.json" ) );')).to.be.null;
      expect(parseCommonPasswords('')).to.be.null;
    });

    it('should load the list of a MediaWiki folder', function() {
      writeList(LIST);
      expect(loadCommonPasswords(tempDir).has('qwertyuiop')).to.be.true;
    });

    it('should notice when the list changes', function() {
      const file = writeList(LIST);
      expect(loadCommonPasswords(tempDir).has('new-common-1')).to.be.false;

      fs.writeFileSync(file, LIST.replace("'123456' => 1,", "'new-common-1' => 1,"));
      const later = new Date(Date.now() + 5000);
      fs.utimesSync(file, later, later);
      expect(loadCommonPasswords(tempDir).has('new-common-1')).to.be.true;
    });

    it('should return null when there is no list', function() {
      expect(loadCommonPasswords(tempDir)).to.be.null;
      expect(loadCommonPasswords(null)).to.be.null;
    });
  });
});
