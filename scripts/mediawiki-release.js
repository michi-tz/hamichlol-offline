#!/usr/bin/env node
// Prints the pinned MediaWiki release of src/versions.js as key=value lines,
// for GitHub Actions ($GITHUB_OUTPUT), so the workflow never repeats the version.
// Usage: node scripts/mediawiki-release.js [older version]
//
//   version=1.46.2
//   url=<the zip the app downloads>
//
// With an older version (e.g. 1.43.11), also old_version and old_url: the
// .tar.gz of that release from the same site, for the system test of a real
// upgrade.

const { DOWNLOADS, MEDIAWIKI_BRANCH } = require('../src/versions');

const { version, urls } = DOWNLOADS.mediawiki;
const url = urls[0];
const lines = [`version=${version}`, `url=${url}`];

const oldVersion = process.argv[2];
if (oldVersion) {
  const oldBranch = oldVersion.split('.').slice(0, 2).join('.');
  const oldUrl = url
    .replace(`/${MEDIAWIKI_BRANCH}/`, `/${oldBranch}/`)
    .replace(`mediawiki-${version}.zip`, `mediawiki-${oldVersion}.tar.gz`);
  if (!/^\d+\.\d+\.\d+$/.test(oldVersion) || oldUrl === url || !oldUrl.includes(`/${oldBranch}/mediawiki-${oldVersion}.tar.gz`)) {
    console.error(`Cannot derive the URL of MediaWiki ${oldVersion} from ${url}`);
    process.exit(1);
  }
  lines.push(`old_version=${oldVersion}`, `old_url=${oldUrl}`);
}

console.log(lines.join('\n'));
