import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const htmlPath = path.join(root, 'tsukue_toolbox.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const appPath = path.join(root, 'src', 'app.js');
const cssPath = path.join(root, 'styles', 'tsukue-toolbox.css');
const findModules = (dir) => fs.readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
  const target = path.join(dir, entry.name);
  if (entry.isDirectory()) return findModules(target);
  return entry.isFile() && entry.name.endsWith('.js') ? [target] : [];
});
const modulePaths = findModules(path.join(root, 'src'));
assert.ok(modulePaths.includes(appPath), 'application entry module must exist');
const mainScript = modulePaths.map((file) => fs.readFileSync(file, 'utf8')).join('\n');

const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1]);
assert.equal(inlineScripts.length, 0, 'application code must not remain inline');
assert.match(html, /<script\s+type="module"\s+src="\.\/src\/app\.js"><\/script>/, 'HTML must load the application ES module');
assert.match(html, /<link\s+rel="stylesheet"\s+href="\.\/styles\/tsukue-toolbox\.css">/, 'HTML must load the external stylesheet');
assert.doesNotMatch(html, /<style\b/i, 'application CSS must not remain inline');
assert.ok(fs.statSync(cssPath).size > 1000, 'external stylesheet must contain the application styles');
for (const modulePath of modulePaths) {
  const moduleSource = fs.readFileSync(modulePath, 'utf8');
  assert.doesNotThrow(
    () => execFileSync(process.execPath, ['--check', modulePath], {stdio: 'pipe'}),
    `${path.relative(root, modulePath)} must parse`,
  );
  for (const match of moduleSource.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)) {
    const importedPath = path.resolve(path.dirname(modulePath), match[1]);
    assert.ok(
      fs.existsSync(importedPath),
      `${path.relative(root, modulePath)} imports missing file ${match[1]}`,
    );
  }
}

const csp = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i)?.[1] ?? '';
assert.ok(csp, 'a meta Content Security Policy is required on GitHub Pages');
assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/, 'script CSP must block inline event handlers');
assert.match(csp, /script-src[^;]*'self'/, 'script CSP must allow same-origin modules');
assert.match(csp, /script-src[^;]*'wasm-unsafe-eval'/, 'OCR requires narrowly scoped WebAssembly compilation permission');
assert.doesNotMatch(csp, /'sha256-/, 'obsolete inline-script hashes must be removed');

const appSource = fs.readFileSync(appPath, 'utf8');
const dependencyGuardIndex = appSource.indexOf('if(!window.PDFLib||!window.pdfjsLib)');
const workerConfigIndex = appSource.indexOf('pdfjsLib.GlobalWorkerOptions.workerSrc');
assert.ok(dependencyGuardIndex >= 0 && dependencyGuardIndex < workerConfigIndex, 'PDF.js must be checked before workerSrc is configured');

const workerMatch = mainScript.match(/const src=`([\s\S]*?)`;\s*\n\s*const url=URL\.createObjectURL/);
assert.ok(workerMatch, 'embedded PDF worker source must be discoverable');
assert.doesNotThrow(
  () => new vm.Script(workerMatch[1], { filename: 'embedded-pdf-worker.js' }),
  'embedded PDF worker must parse',
);

for (const unsafePattern of [
  /d\.innerHTML\s*=\s*['"][\s\S]*?e\.fileName/,
  /li\.innerHTML\s*=\s*['"][\s\S]*?m\.name/,
  /li\.innerHTML\s*=\s*['"][\s\S]*?label/,
]) {
  assert.doesNotMatch(mainScript, unsafePattern, 'user-controlled values must not reach innerHTML');
}

const externalScripts = [...html.matchAll(/<script\s+([^>]*\bsrc="[^"]+"[^>]*)><\/script>/gi)];
assert.ok(externalScripts.length >= 4, 'expected initial external dependencies');
for (const [, attrs] of externalScripts) {
  if(/\bsrc="\.\//.test(attrs)) continue;
  assert.match(attrs, /\bintegrity="sha(256|384|512)-[^"]+"/, 'external scripts need SRI');
  assert.match(attrs, /\bcrossorigin="anonymous"/, 'external scripts need anonymous CORS for SRI');
}
assert.doesNotMatch(html, /tesseract\.js@5\//, 'Tesseract.js major-only URLs must be pinned');
assert.doesNotMatch(html, /googlefonts\/noto-cjk@main/, 'font URLs must not follow a mutable branch');
assert.doesNotMatch(html, /corePath:[^\n]+tesseract-core\.wasm\.js/, 'Tesseract corePath must point to its versioned directory');

assert.match(mainScript, /const\s+pdfLoadParams\b/, 'central PDF.js limits are required');
assert.match(mainScript, /maxImageSize\s*:/, 'PDF.js maxImageSize must be configured');
assert.match(mainScript, /canvasMaxAreaInBytes\s*:/, 'PDF.js canvasMaxAreaInBytes must be configured');
assert.doesNotMatch(mainScript, /pdfjsLib\.getDocument\(\s*\{\s*data\s*:/, 'all PDF.js loads must use the central limits');
assert.match(mainScript, /maxFileBytes\s*:/, 'upload file-size limit is required');
assert.match(mainScript, /maxWorkspacePages\s*:/, 'PDF page-count limit is required');

const fontFunction = mainScript.match(/async function getSearchableFont[\s\S]*?\n}\n/);
assert.ok(fontFunction, 'searchable-font function must exist');
assert.match(fontFunction[0], /if\s*\(\s*lang\s*!==\s*['"]jpn['"]\s*\)\s+return await doc\.embedFont\(StandardFonts\.Helvetica\)/, 'English OCR may keep the standard-font path');
assert.doesNotMatch(fontFunction[0], /catch[\s\S]*StandardFonts\.Helvetica/, 'Japanese OCR must not silently fall back to Helvetica');

const previewFunction = mainScript.match(/async function wsBuildPreviewSource[\s\S]*?\n}\n/);
assert.ok(previewFunction, 'workspace preview function must exist');
assert.match(previewFunction[0], /finally/, 'workspace preview must release resources in finally');
assert.match(previewFunction[0], /destroy/, 'workspace preview must destroy its PDF.js document/loading task');

const workerClientSource = fs.readFileSync(path.join(root, 'src', 'services', 'pdf-worker-client.js'), 'utf8');
assert.match(workerClientSource, /export class PdfWorkerClient\{/, 'PDF worker bridge class must exist');
assert.match(workerClientSource, /onerror/, 'worker crashes must be handled');
assert.match(workerClientSource, /onmessageerror/, 'worker message errors must be handled');
assert.match(workerClientSource, /setTimeout/, 'worker calls need a timeout');
assert.match(workerClientSource, /crypto\.subtle\.digest\(['"]SHA-384['"]/, 'worker dependencies must be hash verified');
assert.doesNotMatch(workerMatch[1], /importScripts\(\s*['"]https?:/, 'worker code must not directly import unverified remote scripts');

assert.match(mainScript, /stRenderTask/, 'stamp rendering must track its active render task');
assert.match(mainScript, /\.cancel\(\)/, 'an in-flight render must be cancellable');
const stampRenderFunction = mainScript.match(/async function renderStampPage[\s\S]*?\n}\n/);
assert.ok(stampRenderFunction, 'stamp preview renderer must exist');
assert.match(stampRenderFunction[0], /finally\{[\s\S]*page\.cleanup/, 'stamp preview pages must be cleaned up even after cancellation');
assert.match(workerMatch[1], /TSUKUE_TOOLBOX_SPREAD_V1:/, 'spread merge output must carry round-trip metadata');
assert.match(workerMatch[1], /out\.setSubject\(spreadMetaPrefix\+JSON\.stringify/, 'spread metadata must be saved with the merged PDF');
assert.match(workerMatch[1], /hint\?\.kind===['"]single['"]/, 'standalone cover and odd trailing pages must remain single when re-split');
assert.match(workerMatch[1], /out\.embedPage\(cur\.srcPage,\{/, 'recorded spread regions must be clipped with embedPage bounding boxes');
assert.match(workerMatch[1], /left:\{width:[\s\S]*right:\{width:/, 'merged pairs must record the exact left and right page sizes');
assert.match(workerMatch[1], /needsTextFont=stamps\.some/, 'mask-only saves must not wait for an unrelated text font');
assert.match(workerMatch[1], /s\.pdfRect/, 'mask saves must accept exact PDF coordinates from the preview viewport');
assert.match(mainScript, /convertToPdfPoint/, 'mask preview coordinates must be converted through the PDF.js viewport');
assert.match(mainScript, /function ocrStartupStatusText/, 'OCR startup stages must be visible to the user');
assert.match(mainScript, /OCRエンジンの起動が90秒以内に完了しませんでした/, 'OCR worker startup needs a bounded timeout');
assert.match(mainScript, /errorHandler:[\s\S]*OCR Workerエラー/, 'OCR worker startup errors must be surfaced while initializing');
assert.match(mainScript, /Promise\.race\(\[\s*workerPromise\s*,\s*timeoutPromise\s*,\s*cancelPromise\s*\]\)/, 'OCR startup must support timeout and cancellation');
assert.match(mainScript, /createTesseractWorkerSafe\(\s*lang\s*,[\s\S]*?\(\s*\)\s*=>\s*C\.ocrAbort\s*\)/, 'OCR extraction startup must be cancellable');
assert.match(mainScript, /createTesseractWorkerSafe\(\s*lang\s*,[\s\S]*?\(\s*\)\s*=>\s*C\.srcAbort\s*\)/, 'searchable-PDF startup must be cancellable');
assert.match(html, /ワークスペース合計600ページ／750MB/, 'the operation manual must document workspace limits');

console.log('tsukue_toolbox.html verification passed');
