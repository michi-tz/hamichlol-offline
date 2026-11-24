// Versions of the bundled servers and where to download them.
//
// To apply security updates, bump the versions here and run `npm run check-downloads`
// to verify that every URL is reachable. PHP and MariaDB are installed into
// versioned folders, so a new version is downloaded next to the old one and the
// database (stored separately) is kept.
//
// Compatibility notes:
// - PHP follows the branch Wikimedia runs in production, so the wiki meets the
//   same PHP behaviour its code is exercised with every day. A PHP that is
//   already installed on the computer is used only if it is of this branch:
//   a PHP newer than the MediaWiki release supports can break every page (as
//   PHP 8.5 did with the previously pinned MediaWiki 1.43).
//   Only the branch is fixed, not the patch release: PHP's security fixes come
//   as patch releases, so the app downloads the newest release of the branch
//   that windows.php.net lists (php.releases), checked against the SHA-256
//   the list gives. PHP_VERSION is the oldest release the app accepts, and
//   what it downloads when the list cannot be read.
// - MediaWiki follows the version the Hamichlol site runs (1.46.2 in November
//   2026), so pages, templates and modules behave as they do on the site. 1.46
//   is not an LTS release: when the site upgrades, bump MEDIAWIKI_VERSION too.
//   Wikis installed with an older version are upgraded in place (server-manager's
//   upgradeMediaWiki, which runs update.php); a MediaWiki already installed on
//   the computer is used only if it is of this branch.
//   MediaWiki 1.46 requires PHP 8.3.0 or later (includes/PHPVersionCheck.php and
//   composer.json of the 1.46.2 release), which PHP_VERSION meets.
// - MariaDB 11.8 is an LTS release.
// - PHP 8.0-8.3 Windows builds use Visual Studio 2019 (vs16); PHP 8.4+ uses vs17.

const PHP_VERSION = '8.3.37';
const MARIADB_VERSION = '11.8.9';
const MEDIAWIKI_VERSION = '1.46.2';

const PHP_BRANCH = PHP_VERSION.split('.').slice(0, 2).join('.');
const MEDIAWIKI_BRANCH = MEDIAWIKI_VERSION.split('.').slice(0, 2).join('.');
// The thread-safe x64 build, as the "ts-vs16-x64" entry of the release list
const PHP_BUILD = 'ts-vs16-x64';
const phpZipName = version => `php-${version}-Win32-vs16-x64.zip`;
const PHP_ZIP = phpZipName(PHP_VERSION);
const MARIADB_ZIP = `mariadb-${MARIADB_VERSION}-winx64.zip`;

const DOWNLOADS = {
  php: {
    version: PHP_VERSION,
    // The newest release of each branch, with its files and their SHA-256
    releases: 'https://windows.php.net/downloads/releases/releases.json',
    build: PHP_BUILD,
    // windows.php.net moves a release to /archives/ once a newer one is out.
    urls: [
      `https://windows.php.net/downloads/releases/${PHP_ZIP}`,
      `https://windows.php.net/downloads/releases/archives/${PHP_ZIP}`
    ]
  },
  mariadb: {
    version: MARIADB_VERSION,
    urls: [
      `https://archive.mariadb.org/mariadb-${MARIADB_VERSION}/winx64-packages/${MARIADB_ZIP}`,
      `https://downloads.mariadb.com/MariaDB/mariadb-${MARIADB_VERSION}/winx64-packages/${MARIADB_ZIP}`
    ]
  },
  mediawiki: {
    version: MEDIAWIKI_VERSION,
    urls: [
      `https://releases.wikimedia.org/mediawiki/${MEDIAWIKI_BRANCH}/mediawiki-${MEDIAWIKI_VERSION}.zip`
    ]
  }
};

module.exports = { DOWNLOADS, PHP_BRANCH, MEDIAWIKI_BRANCH, phpZipName };
