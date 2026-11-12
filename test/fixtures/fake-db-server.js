// Stand-in for mariadbd / mysqld and for mariadb-install-db, used by the tests.
//
// It speaks enough of the MySQL protocol (through mysql2's server API) for the
// app to connect, run its setup queries and send SHUTDOWN. What it was asked
// to do is written into its data folder so tests can check it:
//   args.json    - the command-line arguments of the last start
//   queries.log  - one line per SQL statement received
//
// Behaviour switches (environment variables):
//   FAKE_DB_VERSION          text printed for --version
//   FAKE_DB_NEVER_READY      start but never listen
//   FAKE_DB_REJECT_QUERIES   answer every statement with an error

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2');

const args = process.argv.slice(2);
const option = name => {
  const found = args.find(arg => arg.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : null;
};

const dataDir = option('datadir');
const isInstallTool = /install[-_]db/.test(path.basename(process.argv[1])) || process.env.FAKE_DB_ROLE === 'install';

if (args.includes('--version')) {
  console.log(process.env.FAKE_DB_VERSION || 'mariadbd  Ver 10.11.14-MariaDB for Linux on x86_64');
} else if (isInstallTool || args.includes('--initialize-insecure')) {
  // Creating a data folder: the app recognises it by the "mysql" sub-folder
  fs.mkdirSync(path.join(dataDir, 'mysql'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'init-args.json'), JSON.stringify(args));
} else {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'args.json'), JSON.stringify(args));

  if (process.env.FAKE_DB_NEVER_READY) {
    setInterval(() => {}, 1000);
  } else {
    const server = mysql.createServer();
    let connectionId = 0;
    server.on('connection', connection => {
      connection.on('error', () => {});
      // Every client command restarts packet numbering; follow it instead of
      // warning about "packets out of order"
      const handlePacket = connection.handlePacket.bind(connection);
      connection.handlePacket = packet => {
        if (packet) {
          connection.sequenceId = packet.sequenceId;
        }
        return handlePacket(packet);
      };
      connection.serverHandshake({
        protocolVersion: 10,
        serverVersion: '10.11.14-MariaDB',
        connectionId: ++connectionId,
        statusFlags: 2,
        characterSet: 45,
        capabilityFlags: 0xffffff
      });
      connection.on('query', sql => {
        fs.appendFileSync(path.join(dataDir, 'queries.log'), `${sql}\n`);
        if (process.env.FAKE_DB_REJECT_QUERIES) {
          connection.writeError({ code: 1045, message: 'Access denied (fake)' });
          return;
        }
        connection.writeOk();
        if (sql.trim().toUpperCase() === 'SHUTDOWN') {
          setTimeout(() => process.exit(0), 20);
        }
      });
      connection.on('quit', () => connection.close());
    });
    server.listen(Number(option('port')), option('bind-address') || '127.0.0.1');
  }
}
