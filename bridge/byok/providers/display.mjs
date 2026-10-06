// What setup shows of an AI (onboarding spec §9.5; plan §6.3), from its manifest's display block:
// shared by the app API (providers()) and the desktop app's mock, so both show one text.
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const LINK_KINDS = new Set(['keys', 'billing']);
const STEPS = ['step1', 'step2', 'step3', 'step4'];

/**
 * What setup shows of an AI (onboarding spec §9.5; plan §6.3): data only. The card's name, the
 * company, the order, the terms' version, the key's prefix and placeholder, which page card 1's
 * button and each step's button open (openLink, stepLinks: 'keys' or 'billing') and the AI company's
 * own field and button names the renderer bolds in the steps (fields). The words themselves are the
 * renderer's table (renderer/strings.js providers.<id>.*, STYLE §12); a manifest without a display
 * block gets its name.
 */
export function displayOf(m) {
  const d = isObj(m?.display) ? m.display : {};
  const s = v => (typeof v === 'string' && v ? v : null);
  const stepLinks = {};
  if (isObj(d.stepLinks)) for (const k of STEPS) if (LINK_KINDS.has(d.stepLinks[k])) stepLinks[k] = d.stepLinks[k];
  return {
    card: s(d.card), maker: s(d.maker) ?? s(m?.name), order: Number.isFinite(d.order) ? d.order : (Number.isFinite(m?.order) ? m.order : 100),
    termsVersion: Number.isInteger(d.termsVersion) && d.termsVersion > 0 ? d.termsVersion : 1,
    keyPrefix: s(d.keyPrefix), placeholder: s(d.placeholder),
    freeAvailable: d.freeAvailable === true,
    // The company documents "no credit yet" apart from a rejected key (T1: a first key is saved anyway).
    noCreditDocumented: d.noCreditDocumented === true,
    ...(LINK_KINDS.has(d.openLink) ? { openLink: d.openLink } : {}),
    ...(Object.keys(stepLinks).length ? { stepLinks } : {}),
    ...(Array.isArray(d.fields) ? { fields: d.fields.filter(f => typeof f === 'string' && f && f.length <= 40).slice(0, 12) } : {}),
    ...(Number.isFinite(d.downloadGb) ? { downloadGb: d.downloadGb } : {}),
  };
}
