// Zoom for the settings window (D-16): ⌘ (macOS) or Ctrl (Windows, Linux) with = or +, − and 0,
// on the keyboard and in the View menu, in half steps (Chromium's zoom levels: 0 is 100%, each 1
// is 20%), kept in the shell's settings file (src/app-state.mjs) so the window opens at the same
// size next time. Pure functions; main.mjs applies them through webContents.setZoomLevel.

export const ZOOM_MIN = -2;
export const ZOOM_MAX = 3;
export const ZOOM_STEP = 0.5;

/** A saved level, in range and on a half step; anything else is 0 (100%). */
export function cleanZoom(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  const r = Math.round(v / ZOOM_STEP) * ZOOM_STEP;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, r)) || 0;
}

/**
 * The zoom a key press asks for ('in' | 'out' | 'reset'), or null. input is Electron's
 * before-input-event Input: {type, key, code, meta, control, alt, shift}.
 */
export function zoomAction(input, platform = process.platform) {
  if (!input || input.type !== 'keyDown' || input.alt) return null;
  const mod = platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta;
  if (!mod) return null;
  const { key, code } = input;
  if (key === '=' || key === '+' || code === 'NumpadAdd' || code === 'Equal') return 'in';
  if (key === '-' || key === '_' || code === 'NumpadSubtract' || code === 'Minus') return 'out';
  if (key === '0' || code === 'Digit0' || code === 'Numpad0') return 'reset';
  return null;
}

/** The level after an action, clamped. */
export function nextZoom(level, action) {
  const cur = cleanZoom(level);
  if (action === 'reset') return 0;
  if (action === 'in') return cleanZoom(cur + ZOOM_STEP);
  if (action === 'out') return cleanZoom(cur - ZOOM_STEP);
  return cur;
}
