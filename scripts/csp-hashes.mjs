import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const htmlPath = path.resolve(import.meta.dirname, '..', 'tsukue_toolbox.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1]);
const csp = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i)?.[1] ?? '';

assert.equal(scripts.length, 0, 'inline scripts require CSP hashes; move them into src/ instead');
assert.match(csp, /script-src[^;]*'self'/, 'script-src must allow same-origin modules');
assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/, 'script-src must not allow inline JavaScript');
console.log('CSP audit passed: no inline script hashes are required');
