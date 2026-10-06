// The settings window's own scheme (BYOK PRD §11.2 "Hardening the shell", SC-3, SC-9).
//
// The page is served from nqa://app/, a privileged custom scheme (standard and secure, so it
// has an origin, 'self' means it, and it counts as a secure context), never from file:. That
// lets the GrantFileProtocolExtraPrivileges fuse go off: file: pages get no extra privileges,
// and the app never loads one. The handler serves only files inside the renderer folder (inside
// app.asar when packaged): the path is decoded once, resolved, prefix-checked against the folder
// (and again after following links), must name a regular file with a known type, and only GET
// and HEAD are answered. No directory listing, no redirects, no other host. Every answer carries
// the page's CSP as a header too, nosniff, and no-store.
//
// Pure except createSchemeHandler, which reads files through the fs it is given; nothing here
// imports Electron, so it is tested under plain node --test.
import fs from 'node:fs';
import path from 'node:path';

export const SCHEME = 'nqa';
export const APP_HOST = 'app';
export const ORIGIN = `${SCHEME}://${APP_HOST}`;
export const PAGE = 'index.html';
export const PAGE_URL = `${ORIGIN}/${PAGE}`;

/** The one CSP, as a header; index.html carries the same policy in its meta. */
export const CSP = [
  "default-src 'none'",
  `script-src ${ORIGIN}`,
  `style-src ${ORIGIN}`,
  `img-src ${ORIGIN}`,
  `font-src ${ORIGIN}`,
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** File types the renderer folder holds; anything else is refused. */
export const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
});

/** protocol.registerSchemesAsPrivileged's entry: standard and secure, nothing more. */
export function schemePrivileges() {
  return [{ scheme: SCHEME, privileges: { standard: true, secure: true } }];
}

const deny = (status, why) => ({ ok: false, status, why });

function inside(root, file) {
  const rel = path.relative(root, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Where a request for rawUrl may be served from: { ok: true, rel, mime } where rel is the path
 * inside the renderer folder, or { ok: false, status, why }. Checks the URL only; resolveFile
 * then checks the file itself.
 */
export function checkSchemeUrl(rawUrl, { method = 'GET' } = {}) {
  if (method !== 'GET' && method !== 'HEAD') return deny(405, 'method');
  let u;
  try { u = new URL(String(rawUrl)); } catch { return deny(400, 'bad_url'); }
  if (u.protocol !== `${SCHEME}:`) return deny(400, 'scheme');
  if (u.host !== APP_HOST || u.username || u.password || u.port) return deny(404, 'host');
  let p;
  try { p = decodeURIComponent(u.pathname); } catch { return deny(400, 'bad_path'); }
  // After the URL parser's own dot-segment removal, anything still odd is refused outright:
  // encoded separators or dots, backslashes, NULs, empty segments, a trailing slash (a folder).
  if (!p.startsWith('/') || p.endsWith('/') || /[\\\0]|\/\/|(^|\/)\.\.?(\/|$)/.test(p)) return deny(404, 'path');
  const rel = p.slice(1);
  if (!rel || rel.split('/').some(seg => seg.startsWith('.'))) return deny(404, 'path');
  const mime = MIME[path.extname(rel).toLowerCase()];
  if (!mime) return deny(404, 'type');
  return { ok: true, rel, mime };
}

/**
 * The file a checked URL maps to under root, or a denial: resolved and prefix-checked, then the
 * real path prefix-checked again (a link can't lead out), and it must be a regular file.
 */
export function resolveFile(rel, root, { fsImpl = fs } = {}) {
  const base = path.resolve(root);
  const file = path.resolve(base, ...rel.split('/'));
  if (!inside(base, file)) return deny(404, 'outside');
  let st;
  try { st = fsImpl.statSync(file); } catch { return deny(404, 'missing'); }
  if (!st.isFile()) return deny(404, 'not_a_file');
  try {
    const realBase = fsImpl.realpathSync(base);
    const realFile = fsImpl.realpathSync(file);
    if (!inside(realBase, realFile)) return deny(404, 'outside');
  } catch { /* inside app.asar realpath may not apply; the lexical check above holds */ }
  return { ok: true, file };
}

export const SECURITY_HEADERS = Object.freeze({
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
});

/**
 * protocol.handle's handler: (Request) → Response. onServe({url, status, why}) sees each answer
 * (the ledger and the log); the body of a refusal is empty.
 */
export function createSchemeHandler({ root, fsImpl = fs, onServe = null }) {
  const answer = (status, body = null, extra = {}) => new Response(body, { status, headers: { ...SECURITY_HEADERS, ...extra } });
  return async function handle(request) {
    const url = request?.url;
    const c = checkSchemeUrl(url, { method: request?.method ?? 'GET' });
    const f = c.ok ? resolveFile(c.rel, root, { fsImpl }) : c;
    if (!f.ok) {
      onServe?.({ url, status: f.status, why: f.why });
      return answer(f.status);
    }
    let body;
    try { body = fsImpl.readFileSync(f.file); } catch {
      onServe?.({ url, status: 404, why: 'unreadable' });
      return answer(404);
    }
    onServe?.({ url, status: 200, why: null });
    return answer(200, request.method === 'HEAD' ? null : body, { 'content-type': c.mime, 'content-length': String(body.length) });
  };
}

/** Is this URL the app's own page (any hash), as a frame's URL reports it? */
export function isAppPage(rawUrl) {
  try {
    const u = new URL(String(rawUrl));
    return u.protocol === `${SCHEME}:` && u.host === APP_HOST && u.pathname === `/${PAGE}` && !u.search && !u.username && !u.password && !u.port;
  } catch { return false; }
}

/** The page's URL with a page name in the hash (the window opens on it). */
export function pageUrl(page = null) {
  return page && /^[a-z][a-z-]{0,31}$/.test(page) ? `${PAGE_URL}#${page}` : PAGE_URL;
}
