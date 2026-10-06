// The app's icon is glass Bones (2026-10-02, the owner: "a modern aesthetic of our logo" in a glassy,
// iridescent macOS style): winking Bones "Ember" (round 6, 2026-09-30) in smoked amber glass with a few
// stars inside, an iridescent rim and the gold diamond eye lit, on a blue-violet tile (2026-10-04, the owner: the site's and the app's dark; 1.4.2: lifted from near-black,
// with the skull at about 77% of its width, so it reads as a whole tile in a dark Dock; its 1024 px inner edge
// tapers from the top to the bottom as Apple's do); 16 to 40 px drawn
// on the pixel grid. Its kit's ship/ folder (ship-glass,
// built by the brand master's tools/glass-icons.mjs) is the one source of the four app files; the tray
// is the kit's flat mark (glass-tray.mjs). This copies them in, and checks the copies; never edit them by hand.
//
//   node scripts/make-icons.mjs --from <kit>/ship   copy the kit's app files into build/
//   node scripts/make-icons.mjs --check             exit 1 unless every file is the pinned one, byte for byte
//
// From the kit (ship/README.md): build/icon.icns is macos/NeverQuestAlone.icns (mac.icon, the
// CFBundleIconFile macOS 11 to 15 draw); build/Assets.car is macos/catalog/Assets.car (in
// Contents/Resources, with CFBundleIconName = AppIcon, so macOS 26+ draws 16 and 32 full-bleed instead of
// plating the icon); build/icon.ico is windows/NeverQuestAlone.ico (16 to 256, each the master resampled:
// the installer, the exe and the shortcuts); build/icon.png is macos/app-icon-1024.png
// (Linux).
//
// The tray is drawn from the kit's flat mark (ship/mark), never the rendered icon: the macOS menu-bar
// templates at 1x and 2x (trayTemplate*.png, black and alpha) are mark-16-mono and mark-32-mono; the
// Windows and Linux tray at 16, 20, 24 and 32 px (tray.png, tray@1.25x.png, tray@1.5x.png, tray@2x.png,
// the names Electron's nativeImage picks by display scale) is the lit mark in the glass icon's amber, toned to clear 3:1 on light and dark taskbars
// (2026-10-04, ship-glass/tray from the kit's tools/glass-tray.mjs): mark-16 at 16, mark-lit at 20 and 24,
// mark-32 at 32. Each has its attention variant: a dot at the top right, cut clear of the skull (black on
// the templates, #e5533d on the tray), while a state needs the player (D-01). main.mjs loads the 1x
// names. They aren't among the four app files --from copies, so only --check covers them.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const TRAY = ['tray', 'tray-attention'].flatMap(n => ['', '@1.25x', '@1.5x', '@2x'].map(s => `${n}${s}.png`))
  .concat(['trayTemplate.png', 'trayTemplate@2x.png', 'trayAttentionTemplate.png', 'trayAttentionTemplate@2x.png']);

/** Each file (relative to app/desktop) and the kit file it is (relative to ship/), or null for the tray. */
export const ICONS = Object.freeze({
  'build/icon.png': 'macos/app-icon-1024.png',
  'build/icon.icns': 'macos/NeverQuestAlone.icns',
  'build/Assets.car': 'macos/catalog/Assets.car',
  'build/icon.ico': 'windows/NeverQuestAlone.ico',
  ...Object.fromEntries(TRAY.map(f => [`assets/${f}`, null])),
});

/** Every file's SHA-256, as copied from the glass kit (the tray from its ship-glass/tray and the Ember kit's templates). */
export const SHA256 = Object.freeze({
  'build/icon.png': '804a727105c07e2d6df7a5af72e52e83692dd89ec59b65e64b9cf85c7a0439f6',
  'build/icon.icns': '88888b4c89eed470d53e33d075f654e414115b9b667db8d20dd16c956cc3d1df',
  'build/icon.ico': '07b5ba66a5e0b5626de8ee59efb324744a76dd3f5ded721ad7342c7319c757e4',
  'build/Assets.car': '815fb5f5c06876d054821b10534b1fb614d28cce5fce8ef450cefddcfbc23c18',
  'assets/tray-attention.png': '2e02cb9e405c3fd4f7f2223df1b0f98fb6badcc61a349549b2bf3db5b7cf5390',
  'assets/tray-attention@1.25x.png': 'f9166fb3b5ff9ebc62ba419204cf2a9f106a673e5ee3a58dd888771421a25de0',
  'assets/tray-attention@1.5x.png': '1aabfaddc066c625686e69a3ab4e85f210a76db096cb4f97fec7d25add98ec5b',
  'assets/tray-attention@2x.png': 'c4f4eede3bde9b133210257727abdd1162d08e11c0eec032d8c8fc1868a8b07d',
  'assets/tray.png': '2a0cc54559bd9b1c978ef7cd7ba70fe46437c8d8c0355718c5408f08970ccec7',
  'assets/tray@1.25x.png': '7929415b8a0470e92471aa6b681619d29e1bf1182111714c61290507f2551483',
  'assets/tray@1.5x.png': '9f32b3bf3e2cba1cccbe3e92d7c23900c72cab0ca1882f3a9fc5cfb9a1677b23',
  'assets/tray@2x.png': '19ff5fef5ad29591922412b406fd5d1aa7dfc60d47e0a5af29235c23786e9fd7',
  'assets/trayAttentionTemplate.png': '1a14ed293ff37793f09699e3315258d858bb8596e140860b86fc8181d1f4a66e',
  'assets/trayAttentionTemplate@2x.png': '282b719ce7f713f2fb39d58cda03dcda3449f86afa26ac53bd094312d9c2d72a',
  'assets/trayTemplate.png': '264770c9ed582e9f25ad570c4e0b97a34a6c883715e5625ddf75eb0585014e22',
  'assets/trayTemplate@2x.png': '55889702055f0bd59d9231c819d3aafb561ba388e163cebb5e05df9f6dd5654c',
});

const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** The files that aren't the pinned ones: [{copy, why}] (empty when all are). */
export function checkIcons({ root = ROOT } = {}) {
  const bad = [];
  for (const copy of Object.keys(ICONS)) {
    const file = path.join(root, copy);
    if (!fs.existsSync(file)) bad.push({ copy, why: 'missing' });
    else if (!SHA256[copy]) bad.push({ copy, why: 'not pinned' });
    else if (sha256(file) !== SHA256[copy]) bad.push({ copy, why: 'differs from the kit' });
  }
  return bad;
}

/** Copy the kit's files in from its ship/ folder. Returns the copies written. */
export function copyIcons({ root = ROOT, from }) {
  if (!from || !fs.existsSync(path.join(from, 'README.md'))) throw new Error('--from <kit>/ship: the kit\'s ship folder (its README.md says where every file goes)');
  const out = [];
  for (const [copy, kit] of Object.entries(ICONS)) {
    if (!kit) continue;
    fs.copyFileSync(path.join(from, kit), path.join(root, copy));
    out.push(copy);
  }
  return out;
}

// Run as a command (not imported): the same file whatever case Windows gives its drive letter.
const runAsCommand = () => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (runAsCommand()) {
  if (process.argv.includes('--check')) {
    const bad = checkIcons();
    for (const b of bad) console.error(`${b.copy}: ${b.why}`);
    process.exit(bad.length ? 1 : 0);
  }
  try {
    const at = process.argv.indexOf('--from');
    for (const f of copyIcons({ from: at > 0 ? process.argv[at + 1] : null })) console.log(`copied ${f}`);
  } catch (e) {
    console.error(`make-icons: ${e.message}`);
    process.exit(2);
  }
}
