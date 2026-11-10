#!/usr/bin/env node
// Checks that every download URL in src/versions.js is reachable.
// Usage: npm run check-downloads

const { DOWNLOADS } = require('../src/versions');

async function check(url) {
  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    const size = response.headers.get('content-length');
    const sizeText = size ? ` (${(Number(size) / 1024 / 1024).toFixed(1)} MB)` : '';
    return { ok: response.ok, text: `${response.status}${sizeText}` };
  } catch (error) {
    return { ok: false, text: `error: ${error.cause ? error.cause.message : error.message}` };
  }
}

(async () => {
  let allComponentsAvailable = true;

  for (const [name, { version, urls }] of Object.entries(DOWNLOADS)) {
    console.log(`${name} ${version}`);
    let available = false;
    for (const url of urls) {
      const result = await check(url);
      available = available || result.ok;
      console.log(`  ${result.ok ? 'OK  ' : 'FAIL'} ${result.text}  ${url}`);
    }
    if (!available) {
      allComponentsAvailable = false;
    }
  }

  // A fallback URL may legitimately fail (e.g. the PHP archive before a release
  // is superseded); only fail when no URL works for a component.
  process.exitCode = allComponentsAvailable ? 0 : 1;
})();
