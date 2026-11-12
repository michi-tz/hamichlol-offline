// Checks of the wiki administrator's user name and password.
//
// MediaWiki's installer (maintenance/install.php -> CliInstaller) refuses an
// administrator whose name or password breaks its rules, but only after this
// app has already created the database. These checks mirror MediaWiki 1.43's
// rules so that the problem is reported while the user is still filling in the
// form. They are deliberately never more lenient than MediaWiki itself.
//
// Password policy (MainConfigSchema::PasswordPolicy, checked by CliInstaller
// with UserPasswordPolicy::checkUserPasswordForGroups() for the groups
// bureaucrat, sysop and interface-admin; checks in PasswordPolicyChecks):
//   MinimalPasswordLength 10           strlen(): measured in UTF-8 bytes
//   MaximalPasswordLength 4096         strlen(): bytes
//   PasswordCannotBeSubstringInUsername stripos( username, password ) === false
//   PasswordCannotMatchDefaults        hard-coded user name / password pairs
//   PasswordNotInCommonList            wikimedia/common-passwords (exact match)
//
// User name: User::newFromName() (UserNameUtils::getCanonical / isValid), plus
// the stricter account-creation rules of UserNameUtils::isCreatable().

const fs = require('fs');
const path = require('path');

const MIN_ADMIN_PASSWORD_LENGTH = 10;
const MAX_ADMIN_PASSWORD_LENGTH = 4096;

// PasswordPolicyChecks::checkPasswordCannotMatchDefaults()
const BLOCKED_LOGINS = {
  Useruser: 'Passpass',
  Useruser1: 'Passpass1',
  Apitestsysop: 'testpass',
  Apitestuser: 'testpass'
};
const BLOCKED_PASSWORD = 'ExamplePassword';

// UserNameUtils::isCreatable(): user JS/CSS pages must stay below the title limit
const MAX_USERNAME_BYTES = 235;

// $wgReservedUsernames (the entries that are not interface messages)
const RESERVED_USERNAMES = [
  'MediaWiki default',
  'Conversion script',
  'Maintenance script',
  'Template namespace initialisation script',
  'ScriptImporter',
  'Delete page script',
  'Move page script',
  'Command line script',
  'Unknown user'
];

// Characters that are not allowed in page titles ($wgLegalTitleChars), plus
// '/' (UserNameUtils::isValid) and $wgInvalidUsernameCharacters ('@:>=').
const FORBIDDEN_USERNAME_CHARS = ['#', '<', '>', '[', ']', '|', '{', '}', '/', '@', ':', '='];

// Control characters and the "troublemaker" characters of UserNameUtils::isValid()
// eslint-disable-next-line no-control-regex
const INVALID_USERNAME_CHARS_RE = /[\u0000-\u001f\u007f-\u00a0\u2000-\u200f\u2028-\u202f\u3000\ue000-\uf8ff\ufffd]/u;

// Location of the common password list inside a MediaWiki installation
const COMMON_PASSWORDS_FILE = path.join('vendor', 'wikimedia', 'common-passwords', 'src', 'common.php');

const byteLength = value => Buffer.byteLength(value, 'utf8');

// Language::ucfirst() for the purpose of these checks
function ucfirst(value) {
  const [first = '', ...rest] = Array.from(value);
  return first.toUpperCase() + rest.join('');
}

// The name MediaWiki will store: underscores become spaces, runs of spaces are
// collapsed, and the first letter is capitalised.
function canonicalUsername(name) {
  const cleaned = String(name || '').replace(/_/g, ' ').replace(/ {2,}/g, ' ').trim();
  return ucfirst(cleaned);
}

// UserNameUtils::isIP() and isLikeIPv4DashRange(). IPv6 addresses and ranges
// need ':' or '/', which are rejected anyway.
function looksLikeIp(name) {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.(?:xxx|\d{1,3})$/i.test(name) ||
    /^\d{1,3}(\.\d{1,3}){3}\s*-\s*\d{1,3}(\.\d{1,3}){3}$/.test(name);
}

// Hebrew error message, or null if MediaWiki will accept `name` as the
// administrator's user name.
function validateAdminUsername(name) {
  const raw = typeof name === 'string' ? name.trim() : '';
  if (!raw) {
    return 'יש להזין שם משתמש מנהל';
  }
  const forbidden = FORBIDDEN_USERNAME_CHARS.filter(char => raw.includes(char));
  if (forbidden.length > 0) {
    return `שם המשתמש לא יכול להכיל את התווים: ${forbidden.join(' ')}`;
  }
  if (INVALID_USERNAME_CHARS_RE.test(raw)) {
    return 'שם המשתמש מכיל תווים בלתי נראים או תווי בקרה';
  }
  // Sequences that page titles may not contain: percent-encoding, HTML
  // entities, signatures, and relative path parts
  if (/%[0-9A-Fa-f]{2}/.test(raw) || /&[A-Za-z0-9\u0080-\uffff]+;/.test(raw) || raw.includes('~~~')) {
    return 'שם המשתמש לא יכול להכיל את הצירופים %XX, ‏&...; או ~~~';
  }
  // Names starting with "~" are reserved for temporary accounts
  if (raw.startsWith('~')) {
    return 'שם המשתמש לא יכול להתחיל בתו ~';
  }
  const canonical = canonicalUsername(raw);
  if (!canonical || canonical === '.' || canonical === '..') {
    return 'שם המשתמש אינו תקין';
  }
  if (looksLikeIp(canonical)) {
    return 'שם המשתמש לא יכול להיות כתובת IP';
  }
  if (byteLength(canonical) > MAX_USERNAME_BYTES) {
    return 'שם המשתמש ארוך מדי';
  }
  if (RESERVED_USERNAMES.includes(canonical)) {
    return `השם "${canonical}" שמור לשימוש פנימי של MediaWiki`;
  }
  return null;
}

// stripos() is case-insensitive; lower-casing both sides is at least as strict.
function containsIgnoringCase(haystack, needle) {
  return haystack.toLowerCase().includes(needle.toLowerCase()) ||
    haystack.toUpperCase().includes(needle.toUpperCase());
}

// Every password rule with whether `password` passes it, for the live list
// under the password field. `commonPasswords` is a Set, or null when the list
// is not available (that rule is then reported as `skipped`).
function checkAdminPassword(password, username, { commonPasswords = null } = {}) {
  const value = typeof password === 'string' ? password : '';
  const canonical = canonicalUsername(username);
  const rawName = typeof username === 'string' ? username.trim() : '';
  const length = byteLength(value);

  const rules = [
    {
      id: 'minLength',
      label: `לפחות ${MIN_ADMIN_PASSWORD_LENGTH} תווים (אות עברית נספרת כשניים)`,
      ok: length >= MIN_ADMIN_PASSWORD_LENGTH,
      message: `סיסמת המנהל קצרה מדי: נדרשים לפחות ${MIN_ADMIN_PASSWORD_LENGTH} תווים (אות עברית נספרת כשני תווים)`
    },
    {
      id: 'notInUsername',
      label: 'אינה חלק משם המשתמש',
      ok: value.length === 0 || !(
        (canonical && containsIgnoringCase(canonical, value)) || (rawName && containsIgnoringCase(rawName, value))
      ),
      message: 'סיסמת המנהל לא יכולה להיות זהה לשם המשתמש או לחלק ממנו'
    },
    {
      id: 'notDefault',
      label: 'אינה סיסמת דוגמה ידועה',
      ok: value !== BLOCKED_PASSWORD && BLOCKED_LOGINS[canonical] !== value,
      message: 'סיסמת המנהל היא סיסמת דוגמה ידועה ש-MediaWiki חוסם. יש לבחור סיסמה אחרת'
    },
    commonPasswords
      ? {
        id: 'notCommon',
        label: 'אינה סיסמה נפוצה',
        ok: !commonPasswords.has(value),
        message: 'סיסמת המנהל נמצאת ברשימת הסיסמאות הנפוצות. יש לבחור סיסמה קשה יותר לניחוש'
      }
      : {
        id: 'notCommon',
        label: 'אינה סיסמה נפוצה (תיבדק בזמן ההתקנה)',
        ok: true,
        skipped: true,
        message: null
      }
  ];

  if (length > MAX_ADMIN_PASSWORD_LENGTH) {
    rules.push({
      id: 'maxLength',
      label: `עד ${MAX_ADMIN_PASSWORD_LENGTH} תווים`,
      ok: false,
      message: `סיסמת המנהל ארוכה מדי: מותרים עד ${MAX_ADMIN_PASSWORD_LENGTH} תווים`
    });
  }
  return rules;
}

// The first broken rule as a Hebrew message, or null if MediaWiki will accept
// `password` for the administrator `username`.
function validateAdminPassword(password, username, options) {
  if (typeof password !== 'string' || password.length === 0) {
    return 'יש להזין סיסמת מנהל';
  }
  const failed = checkAdminPassword(password, username, options).find(rule => !rule.ok);
  return failed ? failed.message : null;
}

// Parse the data file of the wikimedia/common-passwords library: a PHP file
// returning an array with one `'password' => 1,` entry per line. Returns a Set,
// or null if the file is missing or not in the expected format.
function parseCommonPasswords(source) {
  const entry = /^'((?:[^'\\]|\\.)*)' => 1,$/;
  const passwords = new Set();
  for (const line of source.split('\n')) {
    const match = entry.exec(line.replace(/\r$/, ''));
    if (match) {
      passwords.add(match[1].replace(/\\(['\\])/g, '$1'));
    }
  }
  // Version 0.5.0 has 100,000 entries; a handful means the format has changed
  return passwords.size >= 10 ? passwords : null;
}

let commonPasswordsCache = { file: null, mtimeMs: null, passwords: null };

// The common password list of the MediaWiki installation in `mediaWikiDir`,
// cached while the file does not change. Null when it cannot be used: the
// check is then skipped and left to MediaWiki's installer.
function loadCommonPasswords(mediaWikiDir) {
  if (!mediaWikiDir) {
    return null;
  }
  const file = path.join(mediaWikiDir, COMMON_PASSWORDS_FILE);
  try {
    const { mtimeMs } = fs.statSync(file);
    if (commonPasswordsCache.file === file && commonPasswordsCache.mtimeMs === mtimeMs) {
      return commonPasswordsCache.passwords;
    }
    const passwords = parseCommonPasswords(fs.readFileSync(file, 'utf8'));
    if (!passwords) {
      console.error(`Unexpected format of ${file}; skipping the common password check`);
    }
    commonPasswordsCache = { file, mtimeMs, passwords };
    return passwords;
  } catch (error) {
    return null;
  }
}

module.exports = {
  MIN_ADMIN_PASSWORD_LENGTH,
  MAX_ADMIN_PASSWORD_LENGTH,
  COMMON_PASSWORDS_FILE,
  canonicalUsername,
  validateAdminUsername,
  checkAdminPassword,
  validateAdminPassword,
  parseCommonPasswords,
  loadCommonPasswords
};
