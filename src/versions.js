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
//   MediaWiki 1.43 with PHP 8.5, for example, fails on every page.
// - MariaDB 11.8 is an LTS release.
// - PHP 8.0-8.3 Windows builds use Visual Studio 2019 (vs16); PHP 8.4+ uses vs17.

const PHP_VERSION = '8.3.36';
const MARIADB_VERSION = '11.8.9';
const MEDIAWIKI_VERSION = '1.43.11';

const PHP_BRANCH = PHP_VERSION.split('.').slice(0, 2).join('.');
const MEDIAWIKI_BRANCH = MEDIAWIKI_VERSION.split('.').slice(0, 2).join('.');
const PHP_ZIP = `php-${PHP_VERSION}-Win32-vs16-x64.zip`;
const MARIADB_ZIP = `mariadb-${MARIADB_VERSION}-winx64.zip`;

const DOWNLOADS = {
  php: {
    version: PHP_VERSION,
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

module.exports = { DOWNLOADS, PHP_BRANCH };
