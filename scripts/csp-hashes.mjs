import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const htmlPath = path.resolve(import.meta.dirname, '..', 'tsukue_toolbox.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1].replace(/\r\n?/g, '\n'));

for (const [index, source] of scripts.entries()) {
  const digest = crypto.createHash('sha256').update(source, 'utf8').digest('base64');
  console.log(`inline-script-${index + 1} sha256-${digest}`);
}
