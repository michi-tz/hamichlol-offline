// Shared helpers for the test suites.

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const FIXTURES = path.join(__dirname, 'fixtures');
const FAKE_PHP = path.join(FIXTURES, 'fake-php.js');
const FAKE_DB_SERVER = path.join(FIXTURES, 'fake-db-server.js');

// The fake programs are Node scripts started through a shebang line, which
// only works on Unix-like systems.
const CAN_RUN_FAKE_PROGRAMS = process.platform !== 'win32';

function makeTempDir(name) {
  // realpath: on macOS the temp folder is a symlink, and the app compares paths
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `hamichlol-${name}-`)));
}

function removeDir(dir) {
  if (dir) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// An executable file at `file` that runs the fixture script `fixture`.
function installFakeProgram(file, fixture) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/usr/bin/env node\nrequire(${JSON.stringify(fixture)});\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return false;
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(condition, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return true;
    }
    await delay(50);
  }
  return false;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readLines(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}

// Listen on `port` so the app has to pick another one. Resolves with the
// server, or null if the port is already taken by something else.
function occupyPort(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(null));
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise(resolve => (server ? server.close(() => resolve()) : resolve()));
}

// Set environment variables for a test and get a function that restores them.
function setEnv(values) {
  const saved = {};
  for (const [name, value] of Object.entries(values)) {
    saved[name] = process.env[name];
    if (value === undefined || value === null) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  return () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
}

const VALID_CONFIG = {
  dbName: 'test_wiki',
  dbUser: 'test_user',
  dbPassword: 'test_password',
  wikiName: 'Test Wiki',
  adminUser: 'admin',
  adminPassword: 'admin-password-123'
};

module.exports = {
  FAKE_PHP,
  FAKE_DB_SERVER,
  CAN_RUN_FAKE_PROGRAMS,
  VALID_CONFIG,
  makeTempDir,
  removeDir,
  installFakeProgram,
  isAlive,
  delay,
  waitFor,
  readJson,
  readLines,
  occupyPort,
  closeServer,
  setEnv
};
