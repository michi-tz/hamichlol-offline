const { describe, it, before, after } = require('mocha');
const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

// Set dev mode for testing (must happen before server-manager is loaded,
// since it reads the flag at require time)
process.env.DEV_MODE = 'true';

const { downloadServers, installMediaWiki, startServers, stopServers } = require('../src/server-manager');

// Test paths
const resourcesPath = path.join(__dirname, '..', 'resources');
const serverPath = path.join(resourcesPath, 'server');
const mediaWikiPath = path.join(resourcesPath, 'mediawiki');

describe('Hamichlol Offline Tests', function() {
  // Increase timeout for potentially slow operations
  this.timeout(10000);
  
  before(async function() {
    // Create test directories if they don't exist
    if (!fs.existsSync(resourcesPath)) {
      fs.mkdirSync(resourcesPath, { recursive: true });
    }
    if (!fs.existsSync(serverPath)) {
      fs.mkdirSync(serverPath, { recursive: true });
    }
    if (!fs.existsSync(mediaWikiPath)) {
      fs.mkdirSync(mediaWikiPath, { recursive: true });
    }
  });
  
  after(async function() {
    // Clean up if necessary
    await stopServers();
  });

  describe('Server Downloads', function() {
    it('should download (simulate) server files', async function() {
      const result = await downloadServers();
      expect(result).to.be.true;
      
      // Check that mock directories were created
      expect(fs.existsSync(path.join(serverPath, 'php'))).to.be.true;
      expect(fs.existsSync(path.join(serverPath, 'mysql'))).to.be.true;
      expect(fs.existsSync(path.join(mediaWikiPath, 'index.php'))).to.be.true;
    });
  });
  
  describe('MediaWiki Installation', function() {
    it('should install (simulate) MediaWiki', async function() {
      const config = {
        dbName: 'test_wiki',
        dbUser: 'test_user',
        dbPassword: 'test_password',
        wikiName: 'Test Wiki',
        adminUser: 'admin',
        adminPassword: 'adminpass'
      };
      
      const result = await installMediaWiki(config);
      expect(result).to.be.true;
      
      // Check for LocalSettings.php
      expect(fs.existsSync(path.join(mediaWikiPath, 'LocalSettings.php'))).to.be.true;
    });
  });
  
  describe('Server Operations', function() {
    it('should start servers and return ports', async function() {
      const result = await startServers();
      
      expect(result).to.have.property('phpPort');
      expect(result).to.have.property('mysqlPort');
      expect(result.phpPort).to.be.a('number');
      expect(result.mysqlPort).to.be.a('number');
    });
    
    it('should stop servers', async function() {
      const result = await stopServers();
      expect(result).to.be.true;
    });
  });
});
