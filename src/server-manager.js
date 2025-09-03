const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');
const download = require('download');
const admZip = require('adm-zip');
const portfinder = require('portfinder');
const cmd = require('node-cmd');

// Paths
const resourcesPath = path.join(process.resourcesPath || path.join(__dirname, '..'), 'resources');
const serverPath = path.join(resourcesPath, 'server');
const mediaWikiPath = path.join(resourcesPath, 'mediawiki');

// Server processes
let phpProcess = null;
let mysqlProcess = null;

// Server ports
let phpPort = 8080;
let mysqlPort = 3306;

// Development mode flag for dry run testing
const DEV_MODE = process.env.DEV_MODE === 'true';

// Download required server files
async function downloadServers() {
  // Create directories if they don't exist
  if (!fs.existsSync(serverPath)) {
    fs.mkdirSync(serverPath, { recursive: true });
  }
  
  if (!fs.existsSync(mediaWikiPath)) {
    fs.mkdirSync(mediaWikiPath, { recursive: true });
  }
  
  // In dev mode, we'll simulate the downloads with dummy files
  if (DEV_MODE) {
    console.log('DEV MODE: Simulating server downloads');
    
    // Create mock PHP directory
    if (!fs.existsSync(path.join(serverPath, 'php'))) {
      fs.mkdirSync(path.join(serverPath, 'php'), { recursive: true });
      fs.writeFileSync(path.join(serverPath, 'php', 'php.exe'), 'MOCK PHP EXE');
      fs.writeFileSync(path.join(serverPath, 'php', 'php.ini'), 'extension=mysqli\nextension=gd\nextension=intl\nextension=mbstring');
    }
    
    // Create mock MySQL directory
    if (!fs.existsSync(path.join(serverPath, 'mysql'))) {
      fs.mkdirSync(path.join(serverPath, 'mysql', 'bin'), { recursive: true });
      fs.mkdirSync(path.join(serverPath, 'mysql', 'data'), { recursive: true });
      fs.writeFileSync(path.join(serverPath, 'mysql', 'bin', 'mysqld.exe'), 'MOCK MYSQL EXE');
      fs.writeFileSync(path.join(serverPath, 'mysql', 'bin', 'mysql.exe'), 'MOCK MYSQL CLIENT');
      fs.writeFileSync(path.join(serverPath, 'mysql', 'bin', 'mysqladmin.exe'), 'MOCK MYSQLADMIN');
    }
    
    // Create mock MediaWiki files
    if (!fs.existsSync(path.join(mediaWikiPath, 'index.php'))) {
      fs.writeFileSync(path.join(mediaWikiPath, 'index.php'), '<?php echo "Mock MediaWiki"; ?>');
      fs.mkdirSync(path.join(mediaWikiPath, 'maintenance'), { recursive: true });
      fs.writeFileSync(path.join(mediaWikiPath, 'maintenance/install.php'), '<?php echo "Mock Installer"; ?>');
    }
    
    return true;
  }

  // Download and extract PHP server if not already downloaded
  if (!fs.existsSync(path.join(serverPath, 'php'))) {
    console.log('Downloading PHP server...');
    const phpUrl = 'https://windows.php.net/downloads/releases/php-8.1.22-Win32-vs16-x64.zip';
    const phpZipPath = path.join(serverPath, 'php.zip');
    
    await download(phpUrl, serverPath, { filename: 'php.zip' });
    
    const zip = new admZip(phpZipPath);
    zip.extractAllTo(path.join(serverPath, 'php'), true);
    
    // Cleanup
    fs.unlinkSync(phpZipPath);
    
    // Configure PHP
    fs.copyFileSync(
      path.join(serverPath, 'php', 'php.ini-development'),
      path.join(serverPath, 'php', 'php.ini')
    );
    
    // Enable required extensions in php.ini
    let phpIni = fs.readFileSync(path.join(serverPath, 'php', 'php.ini'), 'utf8');
    phpIni = phpIni.replace(';extension=mysqli', 'extension=mysqli');
    phpIni = phpIni.replace(';extension=gd', 'extension=gd');
    phpIni = phpIni.replace(';extension=intl', 'extension=intl');
    phpIni = phpIni.replace(';extension=mbstring', 'extension=mbstring');
    fs.writeFileSync(path.join(serverPath, 'php', 'php.ini'), phpIni);
  }

  // Download and extract MariaDB/MySQL if not already downloaded
  if (!fs.existsSync(path.join(serverPath, 'mysql'))) {
    console.log('Downloading MySQL server...');
    const mysqlUrl = 'https://downloads.mariadb.com/MariaDB/mariadb-10.11.5/winx64-packages/mariadb-10.11.5-winx64.zip';
    const mysqlZipPath = path.join(serverPath, 'mysql.zip');
    
    await download(mysqlUrl, serverPath, { filename: 'mysql.zip' });
    
    const zip = new admZip(mysqlZipPath);
    zip.extractAllTo(serverPath, true);
    
    // Rename the extracted folder to 'mysql'
    fs.renameSync(
      path.join(serverPath, 'mariadb-10.11.5-winx64'),
      path.join(serverPath, 'mysql')
    );
    
    // Cleanup
    fs.unlinkSync(mysqlZipPath);
    
    // Initialize MySQL data directory
    const dataDir = path.join(serverPath, 'mysql', 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
      
      // Initialize MySQL with mysql_install_db
      await new Promise((resolve, reject) => {
        const mysqlInstall = exec(
          `"${path.join(serverPath, 'mysql', 'bin', 'mysql_install_db.exe')}" --datadir="${dataDir}"`,
          (error, stdout, stderr) => {
            if (error) {
              console.error(`MySQL installation error: ${error}`);
              reject(error);
              return;
            }
            console.log('MySQL installed successfully');
            resolve();
          }
        );
      });
    }
  }

  // Download MediaWiki if not already downloaded
  if (!fs.existsSync(path.join(mediaWikiPath, 'index.php'))) {
    console.log('Downloading MediaWiki...');
    const mediawikiUrl = 'https://releases.wikimedia.org/mediawiki/1.39/mediawiki-1.39.5.zip';
    const mediawikiZipPath = path.join(mediaWikiPath, 'mediawiki.zip');
    
    await download(mediawikiUrl, mediaWikiPath, { filename: 'mediawiki.zip' });
    
    const zip = new admZip(mediawikiZipPath);
    zip.extractAllTo(mediaWikiPath, true);
    
    // Move files from the extracted folder to mediaWikiPath
    const extractedDir = path.join(mediaWikiPath, 'mediawiki-1.39.5');
    fs.readdirSync(extractedDir).forEach(item => {
      fs.renameSync(
        path.join(extractedDir, item),
        path.join(mediaWikiPath, item)
      );
    });
    
    // Cleanup
    fs.unlinkSync(mediawikiZipPath);
    fs.rmdirSync(extractedDir, { recursive: true });
  }

  console.log('All servers downloaded successfully');
  return true;
}

// Install MediaWiki
async function installMediaWiki(config) {
  const { dbName, dbUser, dbPassword, wikiName, adminUser, adminPassword } = config;
  
  // In dev mode, simulate installation without actually running commands
  if (DEV_MODE) {
    console.log('DEV MODE: Simulating MediaWiki installation');
    console.log(`Creating database: ${dbName} with user: ${dbUser}`);
    console.log(`Installing MediaWiki with name: ${wikiName} and admin: ${adminUser}`);
    
    // Create a mock LocalSettings.php to simulate successful installation
    fs.writeFileSync(path.join(mediaWikiPath, 'LocalSettings.php'), 
      `<?php\n// Mock LocalSettings.php for development\n$wgSitename = "${wikiName}";\n$wgDBname = "${dbName}";\n?>`
    );
    
    return true;
  }
  
  // Create database and user in non-dev mode
  await new Promise((resolve, reject) => {
    const mysqlCmd = `"${path.join(serverPath, 'mysql', 'bin', 'mysql.exe')}" -u root -e "CREATE DATABASE IF NOT EXISTS ${dbName}; GRANT ALL PRIVILEGES ON ${dbName}.* TO '${dbUser}'@'localhost' IDENTIFIED BY '${dbPassword}';FLUSH PRIVILEGES;"`;
    
    exec(mysqlCmd, (error, stdout, stderr) => {
      if (error) {
        console.error(`MySQL command error: ${error}`);
        reject(error);
        return;
      }
      console.log('Database and user created successfully');
      resolve();
    });
  });
  
  // Run MediaWiki installation script
  await new Promise((resolve, reject) => {
    const phpCmd = `"${path.join(serverPath, 'php', 'php.exe')}" "${path.join(mediaWikiPath, 'maintenance/install.php')}" --dbname=${dbName} --dbuser=${dbUser} --dbpass=${dbPassword} --dbserver=localhost --dbprefix=mw_ --installdbuser=${dbUser} --installdbpass=${dbPassword} --server="http://localhost:${phpPort}" --scriptpath="" --pass=${adminPassword} "${wikiName}" "${adminUser}"`;
    
    exec(phpCmd, (error, stdout, stderr) => {
      if (error) {
        console.error(`MediaWiki installation error: ${error}`);
        reject(error);
        return;
      }
      console.log('MediaWiki installed successfully');
      resolve();
    });
  });

  return true;
}

// Start PHP and MySQL servers
async function startServers() {
  // Find available ports
  phpPort = await portfinder.getPortPromise({ port: 8080 });
  mysqlPort = await portfinder.getPortPromise({ port: 3306 });

  // In dev mode, simulate server start
  if (DEV_MODE) {
    console.log('DEV MODE: Simulating server start');
    console.log(`Mock PHP server started at http://localhost:${phpPort}`);
    console.log(`Mock MySQL server started at port ${mysqlPort}`);
    
    // Create a simple HTTP server for testing
    const http = require('http');
    const server = http.createServer((req, res) => {
      res.writeHead(200, {'Content-Type': 'text/html'});
      res.end(`
        <html dir="rtl">
          <head><title>המכלול - אתר בדיקה</title></head>
          <body style="font-family: Arial; direction: rtl; padding: 20px;">
            <h1>המכלול אופליין - אתר בדיקה</h1>
            <p>זהו אתר דמה לצורך בדיקת האפליקציה במצב "על יבש".</p>
            <p>פורט PHP: ${phpPort}</p>
            <p>פורט MySQL: ${mysqlPort}</p>
          </body>
        </html>
      `);
    });
    
    // Store server reference for stopping later
    phpProcess = server;
    server.listen(phpPort);
    
    return {
      phpPort,
      mysqlPort
    };
  }

  // Start MySQL server (normal mode)
  if (!mysqlProcess) {
    const dataDir = path.join(serverPath, 'mysql', 'data');
    mysqlProcess = spawn(
      path.join(serverPath, 'mysql', 'bin', 'mysqld.exe'),
      [
        `--datadir=${dataDir}`,
        `--port=${mysqlPort}`,
        '--console'
      ]
    );
    
    mysqlProcess.stdout.on('data', (data) => {
      console.log(`MySQL: ${data.toString()}`);
    });
    
    mysqlProcess.stderr.on('data', (data) => {
      console.error(`MySQL error: ${data.toString()}`);
    });
    
    // Wait for MySQL to start
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  // Start PHP server
  if (!phpProcess) {
    phpProcess = spawn(
      path.join(serverPath, 'php', 'php.exe'),
      [
        '-S',
        `localhost:${phpPort}`,
        '-t',
        mediaWikiPath
      ]
    );
    
    phpProcess.stdout.on('data', (data) => {
      console.log(`PHP: ${data.toString()}`);
    });
    
    phpProcess.stderr.on('data', (data) => {
      console.error(`PHP error: ${data.toString()}`);
    });
  }

  return {
    phpPort,
    mysqlPort
  };
}

// Stop all servers
async function stopServers() {
  if (DEV_MODE) {
    console.log('DEV MODE: Simulating server shutdown');
    
    // In dev mode, close the HTTP server if it exists
    if (phpProcess && phpProcess.close) {
      phpProcess.close();
      console.log('Mock PHP server stopped');
    }
    
    phpProcess = null;
    mysqlProcess = null;
    return true;
  }
  
  if (phpProcess) {
    phpProcess.kill();
    phpProcess = null;
  }

  if (mysqlProcess) {
    if (process.platform === 'win32') {
      // Graceful shutdown for Windows
      try {
        await new Promise((resolve, reject) => {
          exec(`"${path.join(serverPath, 'mysql', 'bin', 'mysqladmin.exe')}" -u root shutdown`, (error, stdout, stderr) => {
            if (error) {
              console.error(`MySQL shutdown error: ${error}`);
              // Still try to kill the process
              mysqlProcess.kill();
              resolve();
              return;
            }
            console.log('MySQL shut down gracefully');
            resolve();
          });
        });
      } catch (error) {
        console.error('Failed to shut down MySQL gracefully, force killing...');
        mysqlProcess.kill();
      }
    } else {
      mysqlProcess.kill();
    }
    mysqlProcess = null;
  }

  return true;
}

module.exports = {
  downloadServers,
  installMediaWiki,
  startServers,
  stopServers
};
