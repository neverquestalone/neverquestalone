// Third-party notices for the About page (BYOK PRD §14.4 "generated
// third-party notices", PO-9). Walks the app's production dependency tree in
// node_modules (what electron-builder ships inside the asar) and returns each
// package's name, version, license and license text. Electron and Chromium's
// own notices ship beside the app as LICENSE.electron.txt and
// LICENSES.chromium.html, which electron-builder copies there.
import fs from 'node:fs';
import path from 'node:path';

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i;
const MAX_TEXT = 24 * 1024;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Resolve a dependency the way Node does: from the requiring package's folder up to the app. */
function resolveDir(name, fromDir, appDir) {
  const root = path.resolve(appDir);
  let dir = path.resolve(fromDir);
  for (;;) {
    const cand = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(cand, 'package.json'))) return cand;
    if (dir === root) return null;
    const up = path.dirname(dir);
    if (up === dir || !up.startsWith(root)) return null;
    dir = up;
  }
}

function licenseText(dir) {
  try {
    const f = fs.readdirSync(dir).find(n => LICENSE_FILE.test(n));
    if (!f) return '';
    const t = fs.readFileSync(path.join(dir, f), 'utf8');
    return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}\n…` : t;
  } catch { return ''; }
}

export function collectNotices(appDir, { pkg = readJson(path.join(appDir, 'package.json')) } = {}) {
  const seen = new Map();
  const queue = Object.keys(pkg?.dependencies ?? {}).map(name => ({ name, from: appDir }));
  while (queue.length && seen.size < 400) {
    const { name, from } = queue.shift();
    const dir = resolveDir(name, from, appDir);
    if (!dir) continue;
    const meta = readJson(path.join(dir, 'package.json'));
    if (!meta) continue;
    const id = `${meta.name}@${meta.version}`;
    if (seen.has(id)) continue;
    const license = typeof meta.license === 'string' ? meta.license : meta.license?.type ?? 'see text';
    seen.set(id, { name: meta.name, version: meta.version, license, text: licenseText(dir) });
    for (const dep of Object.keys(meta.dependencies ?? {})) queue.push({ name: dep, from: dir });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}
