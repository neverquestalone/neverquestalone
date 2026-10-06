// The settings window's own scheme (BYOK PRD §11.2 "Hardening the shell", SC-3, SC-9;
// app/desktop/src/scheme.mjs): nqa://app/ serves the renderer folder and nothing else
// (resolved, prefix-checked, links followed and checked again, regular files of known types,
// GET and HEAD only, no listing), every answer carries the page's CSP, nosniff and no-store, and
// main.mjs registers it as privileged (standard, secure) before ready, serves it with
// protocol.handle and loads the window from it, never from file:. The fuse that gave file:
// pages extra privileges is off. No Electron needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCHEME, APP_HOST, ORIGIN, PAGE_URL, CSP, MIME, SECURITY_HEADERS, schemePrivileges, checkSchemeUrl, resolveFile,
  createSchemeHandler, isAppPage, pageUrl,
} from '../../app/desktop/src/scheme.mjs';

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'app', 'desktop');
const RENDERER = path.join(APP, 'renderer');
const code = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bones-scheme-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'renderer');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>x</title>');
  fs.writeFileSync(path.join(root, 'app.js'), 'void 0;');
  fs.writeFileSync(path.join(root, 'sub', 'deep.css'), 'p{}');
  fs.writeFileSync(path.join(dir, 'secret.js'), 'SECRET');
  fs.mkdirSync(path.join(root, 'folder.js'));
  if (process.platform !== 'win32') fs.symlinkSync(path.join(dir, 'secret.js'), path.join(root, 'link.js'));
  return { dir, root };
}

const req = (url, method = 'GET') => ({ url, method });

test('the scheme: nqa://app, standard and secure, nothing more', () => {
  assert.equal(SCHEME, 'nqa');
  assert.equal(APP_HOST, 'app');
  assert.equal(ORIGIN, 'nqa://app');
  assert.equal(PAGE_URL, 'nqa://app/index.html');
  assert.deepEqual(schemePrivileges(), [{ scheme: 'nqa', privileges: { standard: true, secure: true } }]);
  // The page's own files: markup, script and style, its images (NeverQuestAlone's mark, the in-game frames,
  // the line icons) and its bundled faces.
  assert.deepEqual(Object.keys(MIME).sort(), ['.css', '.html', '.js', '.png', '.svg', '.webp', '.woff2']);
  assert.equal(MIME['.woff2'], 'font/woff2');
  assert.equal(MIME['.svg'], 'image/svg+xml');
});

test('checkSchemeUrl: renderer-file shapes only, the app host only, GET and HEAD only', () => {
  for (const [url, rel] of [['nqa://app/index.html', 'index.html'], ['nqa://app/app.js', 'app.js'], ['nqa://app/sub/deep.css', 'sub/deep.css'], ['nqa://app/index.html#setup', 'index.html'], ['nqa://app/mark.png?v=1', 'mark.png']]) {
    const c = checkSchemeUrl(url);
    assert.equal(c.ok, true, url);
    assert.equal(c.rel, rel);
  }
  assert.equal(checkSchemeUrl('nqa://app/app.js').mime, 'text/javascript; charset=utf-8');
  assert.equal(checkSchemeUrl('nqa://app/x.PNG').mime, 'image/png');
  for (const url of ['nqa://app/', 'nqa://app', 'nqa://app/sub/', 'nqa://app/main.mjs', 'nqa://app/preload.cjs', 'nqa://app/package.json', 'nqa://app/x',
    'nqa://app/sub%2f..%2f..%2fmain.js', 'nqa://app/..%5cmain.js', 'nqa://app/a//b.js', 'nqa://app/x.js%00.png',
    'nqa://app/.hidden.js', 'nqa://app/sub/.x.css', 'nqa://app/%E0%A4%A.js', 'nqa://evil/index.html', 'nqa://app:1/index.html', 'nqa://u:p@app/index.html',
    'file:///etc/passwd', 'https://app/index.html', 'nonsense']) {
    assert.equal(checkSchemeUrl(url).ok, false, url);
  }
  // Dot segments (plain or %2e) are resolved by the URL parser at the root, so they can't climb out.
  assert.equal(checkSchemeUrl('nqa://app/%2e%2e/%2e%2e/app.js').rel, 'app.js');
  assert.equal(checkSchemeUrl('nqa://app/index.html', { method: 'POST' }).status, 405);
  assert.equal(checkSchemeUrl('nqa://app/index.html', { method: 'HEAD' }).ok, true);
});

test('resolveFile: inside the root, a regular file; a link that leads out is refused', (t) => {
  const { root } = sandbox(t);
  assert.equal(resolveFile('index.html', root).ok, true);
  assert.equal(resolveFile('sub/deep.css', root).ok, true);
  assert.equal(resolveFile('nothing.js', root).why, 'missing');
  assert.equal(resolveFile('folder.js', root).why, 'not_a_file', 'no directory is ever served');
  assert.equal(resolveFile('../secret.js', root).why, 'outside');
  if (process.platform !== 'win32') assert.equal(resolveFile('link.js', root).why, 'outside', 'a link out of the folder');
});

test('the handler: serves the file with its type and the security headers; everything else is an empty 404/405', async (t) => {
  const { root } = sandbox(t);
  const seen = [];
  const handle = createSchemeHandler({ root, onServe: v => seen.push(v) });
  const ok = await handle(req('nqa://app/index.html'));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'text/html; charset=utf-8');
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) assert.equal(ok.headers.get(k), v, k);
  assert.equal(await ok.text(), '<!doctype html><title>x</title>');
  const head = await handle(req('nqa://app/app.js', 'HEAD'));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  for (const [url, status] of [['nqa://app/nothing.js', 404], ['nqa://app/folder.js', 404], ['nqa://app/%2e%2e/secret.js', 404], ['nqa://app/', 404],
    ['nqa://other/index.html', 404], ['nqa://app/secret.txt', 404], ...(process.platform !== 'win32' ? [['nqa://app/link.js', 404]] : [])]) {
    const r = await handle(req(url));
    assert.equal(r.status, status, url);
    assert.equal(await r.text(), '', `${url}: no body`);
    assert.equal(r.headers.get('content-security-policy'), CSP);
  }
  assert.equal((await handle(req('nqa://app/index.html', 'POST'))).status, 405);
  assert.ok(seen.some(v => v.status === 200) && seen.filter(v => v.status !== 200).every(v => typeof v.why === 'string'));
  assert.ok(!JSON.stringify(seen).includes('SECRET'));
});

test('the real renderer folder: every file the page loads is served; nothing else in the app is', async () => {
  const handle = createSchemeHandler({ root: RENDERER });
  const files = fs.readdirSync(RENDERER, { recursive: true }).filter(f => fs.statSync(path.join(RENDERER, f)).isFile());
  assert.ok(files.length > 20);
  for (const f of files) {
    const r = await handle(req(`nqa://app/${f.split(path.sep).join('/')}`));
    // The fonts' licence texts sit beside the faces they cover; the page never loads them.
    assert.equal(r.status, f.endsWith('.txt') ? 404 : 200, f);
  }
  for (const d of ['fonts', 'icons', 'img']) assert.equal((await handle(req(`nqa://app/${d}`))).status, 404, `${d}: no listing`);
  for (const f of ['main.mjs', 'preload.cjs', 'ipc.mjs', 'package.json', 'src/redact.mjs']) {
    assert.equal((await handle(req(`nqa://app/../${f}`))).status, 404, f);
  }
});

test('the CSP: index.html’s meta is the header’s policy (less frame-ancestors, which a meta can’t carry); the scheme is the only source', () => {
  const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
  const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)[1];
  assert.equal(meta, CSP.replace("; frame-ancestors 'none'", ''));
  const parts = Object.fromEntries(CSP.split('; ').map(s => { const [k, ...v] = s.split(' '); return [k, v.join(' ')]; }));
  assert.equal(parts['default-src'], "'none'");
  for (const k of ['script-src', 'style-src', 'img-src', 'font-src']) assert.equal(parts[k], 'nqa://app', k);
  for (const k of ['connect-src', 'media-src', 'object-src', 'frame-src', 'worker-src', 'manifest-src', 'base-uri', 'form-action', 'frame-ancestors']) assert.equal(parts[k], "'none'", k);
  assert.doesNotMatch(CSP, /'self'|unsafe|file:|https?:|data:|blob:|\*/);
});

test('isAppPage and pageUrl: the app page (any hash), nothing else', () => {
  assert.equal(isAppPage('nqa://app/index.html'), true);
  assert.equal(isAppPage('nqa://app/index.html#usage'), true);
  for (const u of ['nqa://app/index.html?x=1', 'nqa://app/app.js', 'nqa://evil/index.html', 'file:///x/renderer/index.html', 'https://app/index.html', '', null]) assert.equal(isAppPage(u), false, String(u));
  assert.equal(pageUrl(), 'nqa://app/index.html');
  assert.equal(pageUrl('last-request'), 'nqa://app/index.html#last-request');
  assert.equal(pageUrl('x"><script>'), 'nqa://app/index.html', 'only page names go in the hash');
});

test('main.mjs: the scheme privileged before ready, served by protocol.handle from the renderer folder, the window loaded from it, file: never', () => {
  const main = code(fs.readFileSync(path.join(APP, 'main.mjs'), 'utf8'));
  const privileged = main.indexOf('protocol.registerSchemesAsPrivileged(schemePrivileges())');
  assert.ok(privileged > 0);
  assert.ok(privileged < main.indexOf('await app.whenReady()'), 'registered at load, before ready');
  assert.match(main, /protocol\.handle\(SCHEME, createSchemeHandler\(\{\s*root: RENDERER_DIR,/);
  assert.match(main, /win\.loadURL\(pageUrl\(page\)\)/);
  assert.doesNotMatch(main, /loadFile\(/);
  assert.match(main, /return isAppPage\(frame\.url\);/, 'IPC answers only the app page');
  const fuses = fs.readFileSync(path.join(APP, 'scripts', 'fuses.cjs'), 'utf8');
  assert.match(code(fuses), /GrantFileProtocolExtraPrivileges: false,/);
});
