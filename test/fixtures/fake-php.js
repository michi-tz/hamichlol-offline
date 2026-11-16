// Stand-in for the PHP command-line program, used by the tests.
//
// Handles the four ways the app runs PHP:
//   php -r <code>                 inspection: prints version, SAPI and extensions
//   php [-c ini] .../install.php  MediaWiki installer: writes LocalSettings.php
//                                 and install-args.json into the current folder
//   php [-c ini] .../run.php update --quick  (or .../update.php --quick)
//                                 schema update: needs LocalSettings.php in the
//                                 current folder, sends one query to the database
//                                 on $HAMICHLOL_DB_PORT (so it shows in the fake
//                                 server's queries.log) and writes update-args.json
//   php [-c ini] -S host:port -t docroot
//                                 web server: answers every request with JSON
//                                 describing how it was started
//
// Behaviour switches (environment variables):
//   FAKE_PHP_VERSION, FAKE_PHP_SAPI, FAKE_PHP_EXTENSIONS (comma separated)
//   FAKE_PHP_INSTALL_FAILS   the installer prints an error and exits with 1
//   FAKE_PHP_SERVER_FAILS    the web server exits immediately
//   FAKE_PHP_UPDATE_FAILS    the schema update changes the database, then fails
//   FAKE_PHP_UPDATE_HANGS    the schema update changes the database, then waits
//                            until the database server goes away
//   FAKE_PHP_UPDATE_THEN_MKDIR  after a successful schema update, create this
//                            folder (e.g. to make a later file write fail)

const fs = require('fs');
const http = require('http');
const path = require('path');

const DEFAULT_EXTENSIONS = 'mysqli,ctype,dom,fileinfo,iconv,intl,json,mbstring,openssl,xml,xmlreader';

const args = process.argv.slice(2);
const valueAfter = flag => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
const installer = args.find(arg => path.basename(arg) === 'install.php');
const updater = args.find(arg => path.basename(arg) === 'update.php') ||
  (args.some(arg => path.basename(arg) === 'run.php') && args.includes('update'));

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
} else if (updater) {
  fs.writeFileSync('update-args.json', JSON.stringify({ args, dbPort: process.env.HAMICHLOL_DB_PORT || null }));
  if (!fs.existsSync('LocalSettings.php')) {
    console.error('A copy of your installation\'s LocalSettings.php must exist');
    process.exit(1);
  }
  const mysql = require('mysql2');
  const connection = mysql.createConnection({ host: '127.0.0.1', port: Number(process.env.HAMICHLOL_DB_PORT), user: 'root' });
  connection.query('ALTER TABLE fake_update', error => {
    if (error) {
      console.error(`Fake updater: ${error.message}`);
      process.exit(1);
    }
    if (process.env.FAKE_PHP_UPDATE_HANGS) {
      // Like update.php, it gives up once the database server is gone
      connection.on('error', () => process.exit(1));
      connection.on('end', () => process.exit(1));
      setInterval(() => connection.ping(), 200);
      return;
    }
    connection.destroy();
    console.log('MediaWiki fake Updater');
    if (process.env.FAKE_PHP_UPDATE_FAILS) {
      console.error('Fake updater error: table mw_fake is broken');
      process.exit(1);
    }
    if (process.env.FAKE_PHP_UPDATE_THEN_MKDIR) {
      fs.mkdirSync(process.env.FAKE_PHP_UPDATE_THEN_MKDIR, { recursive: true });
    }
    console.log('Done.');
  });
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
