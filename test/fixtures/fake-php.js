// Stand-in for the PHP command-line program, used by the tests.
//
// Handles the three ways the app runs PHP:
//   php -r <code>                 inspection: prints version, SAPI and extensions
//   php [-c ini] .../install.php  MediaWiki installer: writes LocalSettings.php
//                                 and install-args.json into the current folder
//   php [-c ini] -S host:port -t docroot
//                                 web server: answers every request with JSON
//                                 describing how it was started
//
// Behaviour switches (environment variables):
//   FAKE_PHP_VERSION, FAKE_PHP_SAPI, FAKE_PHP_EXTENSIONS (comma separated)
//   FAKE_PHP_INSTALL_FAILS   the installer prints an error and exits with 1
//   FAKE_PHP_SERVER_FAILS    the web server exits immediately

const fs = require('fs');
const http = require('http');
const path = require('path');

const DEFAULT_EXTENSIONS = 'mysqli,ctype,dom,fileinfo,iconv,intl,json,mbstring,openssl,xml,xmlreader';

const args = process.argv.slice(2);
const valueAfter = flag => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
const installer = args.find(arg => path.basename(arg) === 'install.php');

if (args[0] === '-r') {
  console.log(JSON.stringify({
    version: process.env.FAKE_PHP_VERSION || '8.3.6',
    sapi: process.env.FAKE_PHP_SAPI || 'cli',
    extensions: (process.env.FAKE_PHP_EXTENSIONS || DEFAULT_EXTENSIONS).split(',').filter(Boolean)
  }));
} else if (installer) {
  fs.writeFileSync('install-args.json', JSON.stringify(args));
  if (process.env.FAKE_PHP_INSTALL_FAILS) {
    console.log('Fake installer: checking the environment');
    console.error('Fake installer error: database refused the connection');
    process.exit(1);
  }
  const dbServer = args.find(arg => arg.startsWith('--dbserver=')).split('=')[1];
  const server = args.find(arg => arg.startsWith('--server=')).split('=')[1];
  // Like install.php: --lang sets the wiki's language (English by default)
  const lang = (args.find(arg => arg.startsWith('--lang=')) || '--lang=en').split('=')[1];
  fs.writeFileSync('LocalSettings.php', [
    '<?php',
    '$wgSitename = "Fake";',
    `$wgServer = "${server}";`,
    '$wgDBtype = "mysql";',
    `$wgDBserver = "${dbServer}";`,
    `$wgLanguageCode = "${lang}";`,
    ''
  ].join('\n'));
} else if (args.includes('-S')) {
  if (process.env.FAKE_PHP_SERVER_FAILS) {
    process.exit(1);
  }
  const [host, port] = valueAfter('-S').split(':');
  http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({
      dbPort: process.env.HAMICHLOL_DB_PORT || null,
      docroot: valueAfter('-t'),
      ini: valueAfter('-c'),
      cwd: process.cwd(),
      url: request.url
    }));
  }).listen(Number(port), host);
}
