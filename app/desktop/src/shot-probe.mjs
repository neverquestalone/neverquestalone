// The screenshot mode's per-state probe (development runs only; desktop UI critic r2, T-2): what a
// critic checks by DOM instead of by eye, as JSON beside each PNG. main.mjs runs PROBE_JS in the
// page after each shot when --screenshots-probe is given (it never ships: the package leaves src/
// screenshots out, and a packaged app refuses --screenshots).
//
//   fit        the page's scroll height against the window (spec §2 rule 6), its top, and the slack
//              under the content (how much room is left, or how far it runs past the fold)
//   primaries  every .btn-primary on the page and banners (spec §2 rule 2: one per screen)
//   active     the focused element; tab: the tab order with accessible names and boxes
//   headings, live (the live region's lines), banners, text (the page's words)
//   overflow   an element past its parent's edge, or clipped; docOverflowX: a horizontal scroll
//   wrapped    a button or chip that wrapped; unbreak: a price, key, model or command split across lines
//   edges      where the stage bar, Finish later, Back, the H1 and the first block start and end (x),
//              and the H1's top (the frame across S1–S4, DU-07)
//   fontSizes, gaps (setup's block gaps), small (targets under 24 px), uncovered (focusables
//   with no focus style), navSetupVisible
//   sepStart   a line of links whose " ·" starts a line (desktop UI critic r4, DU-38): the line's words
//   typo       the type in use (desktop UI critic r3, DU-28): text-bearing elements by weight and by
//              size/leading, and what's set at 700 or heavier (bold); and the measure (DU-27): the
//              blocks with the most characters on one line, as [characters, lines, width, size, words]
export const PROBE_JS = `(() => {
  const vw = innerWidth, vh = innerHeight;
  const page = document.getElementById('page');
  const app = document.getElementById('app');
  const R = el => { const b = el.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; };
  const txt = el => (el.textContent || '').trim().replace(/\\s+/g, ' ');
  const accName = el => {
    const lb = el.getAttribute('aria-labelledby');
    if (lb) return lb.split(/\\s+/).map(id => { const x = document.getElementById(id); return x ? txt(x) : ''; }).join(' ');
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    if (el.labels && el.labels.length) return txt(el.labels[0]);
    return txt(el).slice(0, 90);
  };
  const vis = el => { if (!el || !el.isConnected) return false; const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden') return false; const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
  const cls = el => (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).join('.') : '');
  const focusables = [...document.querySelectorAll('button, a[href], input, select, textarea, [tabindex]')].filter(el => el.tabIndex >= 0 && !el.disabled && vis(el));
  const prim = [...document.querySelectorAll('#page .btn-primary, #banners .btn-primary')].filter(vis);
  const ae = document.activeElement;
  const over = [];
  for (const el of page.querySelectorAll('*')) {
    if (!vis(el)) continue;
    const p = el.parentElement; if (!p) continue;
    const a = el.getBoundingClientRect(), b = p.getBoundingClientRect();
    if (a.right > b.right + 1.5 || a.left < b.left - 1.5) over.push({ el: el.tagName.toLowerCase() + cls(el), in: p.tagName.toLowerCase() + cls(p), text: txt(el).slice(0, 50), dxRight: Math.round(a.right - b.right), dxLeft: Math.round(b.left - a.left) });
    const ox = getComputedStyle(el).overflowX;
    if (el.scrollWidth > el.clientWidth + 1 && ox !== 'visible') over.push({ el: el.tagName.toLowerCase() + cls(el), text: txt(el).slice(0, 50), clipped: el.scrollWidth - el.clientWidth, ox });
  }
  const sizes = {};
  const walker = document.createTreeWalker(app, NodeFilter.SHOW_TEXT);
  let n; while ((n = walker.nextNode())) { if (!n.textContent.trim()) continue; const el = n.parentElement; if (!vis(el) || el.closest('.sr-only')) continue; const f = getComputedStyle(el).fontSize; sizes[f] = (sizes[f] || 0) + 1; }
  const wrapped = [...page.querySelectorAll('button, .btn, .chip, .stage-step')].filter(vis).filter(el => { const cs = getComputedStyle(el); const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.25; return el.getBoundingClientRect().height > lh * 1.9 + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom); }).map(el => txt(el).slice(0, 50));
  const unbreak = [];
  const pats = [/\\$[\\d.,]+(–[\\d.,]+)?( a day)?/g, /Claude (Haiku|Sonnet) \\d(\\.\\d)?/g, /GPT-6 \\w+/g, /Grok \\d\\.\\d/g, /WoW: Forever/g, /sk-[a-z]+-…\\w+/g, /⌘V/g, /\\/nqa [a-z]+( [a-z]+)?/g, /\\d+(\\.\\d+)?\\s?GB/g, /Qwen3 \\w+/g];
  const tw = document.createTreeWalker(app, NodeFilter.SHOW_TEXT);
  let tn;
  while ((tn = tw.nextNode())) {
    if (!tn.parentElement || !vis(tn.parentElement) || tn.parentElement.closest('.sr-only')) continue;
    for (const re of pats) {
      re.lastIndex = 0; let m;
      while ((m = re.exec(tn.textContent))) {
        const rg = document.createRange(); rg.setStart(tn, m.index); rg.setEnd(tn, m.index + m[0].length);
        const tops = new Set([...rg.getClientRects()].filter(x => x.width > 0).map(x => Math.round(x.top)));
        if (tops.size > 1) unbreak.push(m[0]);
      }
    }
  }
  const L = sel => { const el = document.querySelector(sel); if (!el || !vis(el)) return null; const b = el.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.right), Math.round(b.top)]; };
  const edges = { stage: L('#page .stage'), finishLater: L('#page .setup-top [data-fk="finish-later"]'), back: L('#page [data-fk="back"]'), h1: L('#page h1'), firstBlock: L('#page .card, #page .ai-cards, #page .say-rows, #page .result'), setupPage: L('#page .setup-page'), banners: L('#banners > *') };
  const coveredSel = '.btn, .btn-link, .nav-item, .choice, input, select, .ai-card, .switch, pre.code';
  const uncovered = focusables.filter(el => !el.matches(coveredSel)).map(el => el.tagName.toLowerCase() + cls(el) + ':' + txt(el).slice(0, 30));
  const small = focusables.filter(el => { const b = el.getBoundingClientRect(); return b.height < 24 || b.width < 24; }).map(el => [txt(el).slice(0, 40) || accName(el).slice(0, 40), Math.round(el.getBoundingClientRect().width), Math.round(el.getBoundingClientRect().height), el.className]);
  const setupEl = document.querySelector('#page .setup');
  const gaps = setupEl ? [...setupEl.children].filter(vis).map((el, i, arr) => [el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/)[0] : ''), i ? Math.round(el.getBoundingClientRect().top - arr[i - 1].getBoundingClientRect().bottom) : Math.round(el.getBoundingClientRect().top)]) : null;
  const sepStart = [];
  for (const sp of document.querySelectorAll('#page .link-sep, #banners .link-sep')) {
    if (!vis(sp) || !sp.firstChild) continue;
    const t = sp.firstChild; const i = t.textContent.indexOf('·'); if (i < 0) continue;
    const g = document.createRange(); g.setStart(t, i); g.setEnd(t, i + 1);
    const dot = g.getBoundingClientRect();
    const item = sp.parentElement && sp.parentElement.classList.contains('link-item') ? sp.parentElement : sp;
    const prev = item.previousElementSibling ? item.previousElementSibling.getBoundingClientRect() : null;
    const own = sp.previousElementSibling ? sp.previousElementSibling.getBoundingClientRect() : prev;
    if (own && Math.round(dot.top) > Math.round(own.bottom) - 4) sepStart.push(txt(sp.closest('p') || sp.parentElement).slice(0, 80));
  }
  const navSetup = document.querySelector('[data-nav="setup-now"]') || document.querySelector('[data-nav="setup"]');
  const weights = {}, sizeLh = {}, bold = new Set();
  for (const el of document.querySelectorAll('#page *, #banners *')) {
    if (el.closest('.sr-only') || !vis(el) || ![...el.childNodes].some(c => c.nodeType === 3 && c.textContent.trim())) continue;
    const cs = getComputedStyle(el);
    weights[cs.fontWeight] = (weights[cs.fontWeight] || 0) + 1;
    sizeLh[cs.fontSize + '/' + cs.lineHeight] = (sizeLh[cs.fontSize + '/' + cs.lineHeight] || 0) + 1;
    if (Number(cs.fontWeight) >= 700) bold.add(el.tagName.toLowerCase() + cls(el) + ':' + txt(el).slice(0, 12));
  }
  const measure = [];
  for (const b of page.querySelectorAll('p, li, blockquote, dd, figcaption')) {
    if (b.closest('.sr-only') || !vis(b)) continue;
    const per = new Map();
    const bw = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
    let bn;
    while ((bn = bw.nextNode())) {
      if (!bn.parentElement || bn.parentElement.closest('.sr-only')) continue;
      for (let i = 0; i < bn.textContent.length; i++) {
        const rg = document.createRange(); rg.setStart(bn, i); rg.setEnd(bn, i + 1);
        const q = rg.getClientRects()[0]; if (!q || !q.width) continue;
        const top = Math.round(q.top / 6); per.set(top, (per.get(top) || 0) + 1);
      }
    }
    if (per.size) measure.push([Math.max(...per.values()), per.size, Math.round(b.getBoundingClientRect().width), getComputedStyle(b).fontSize, txt(b).slice(0, 60)]);
  }
  measure.sort((a, b) => b[0] - a[0]);
  return {
    viewport: [vw, vh], mode: app.getAttribute('data-mode'),
    page: { scrollH: page.scrollHeight, clientH: page.clientHeight, scrollTop: Math.round(page.scrollTop), scrollW: page.scrollWidth, clientW: page.clientWidth, top: Math.round(page.getBoundingClientRect().top) },
    fits: page.scrollHeight <= page.clientHeight,
    // The room left under the content (negative: how far it runs past the fold), padding included.
    slack: page.firstElementChild ? Math.round(page.getBoundingClientRect().bottom - page.firstElementChild.getBoundingClientRect().bottom - parseFloat(getComputedStyle(page).paddingBottom)) : null,
    docOverflowX: document.documentElement.scrollWidth - vw,
    active: ae && ae !== document.body ? { tag: ae.tagName, id: ae.id || null, fk: ae.getAttribute('data-fk'), name: accName(ae).slice(0, 80), rect: R(ae) } : null,
    h1: (document.querySelector('#page h1') || {}).textContent || null,
    primaries: prim.map(el => ({ name: accName(el).slice(0, 60), rect: R(el), aria: el.getAttribute('aria-disabled') })),
    tab: focusables.map(el => [el.tagName.toLowerCase() + (el.getAttribute('role') ? '[' + el.getAttribute('role') + ']' : ''), accName(el).slice(0, 70), R(el)]),
    headings: [...document.querySelectorAll('h1, h2, h3')].filter(vis).map(h => h.tagName + ' ' + txt(h).slice(0, 70)),
    live: [...document.getElementById('live').childNodes].map(x => x.textContent),
    overflow: over.slice(0, 40), wrapped: wrapped.slice(0, 20), fontSizes: sizes,
    text: page.innerText.slice(0, 5000), banners: document.getElementById('banners').innerText.slice(0, 1500),
    unbreak, edges, uncovered, small, gaps, sepStart, navSetupVisible: !!(navSetup && vis(navSetup)),
    typo: { weights, sizeLh, bold: [...bold].slice(0, 12), longest: measure.slice(0, 6) },
  };
})()`;

/** axe-core's run in the page, over a local copy of axe loaded first (--screenshots-axe=<file>). */
export const AXE_RUN_JS = `axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] }, resultTypes: ['violations', 'incomplete'] })
  .then(r => ({ violations: r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map(n => ({ target: n.target.join(' '), html: n.html.slice(0, 220), summary: (n.failureSummary || '').slice(0, 500) })) })),
    incomplete: r.incomplete.map(v => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 12).map(n => ({ target: n.target.join(' '), html: n.html.slice(0, 180) })) })) }))`;

// ---------------------------------------------------------------------------
// The redesign's acceptance checks (its build spec §8), run on every scene of the screenshot mode
// (development runs only). The page side is here; main.mjs drives the keyboard, the mouse, the
// reduced-motion switch and the clock through the DevTools protocol.

/** Colour helpers every check below shares (a string, spliced into each script). */
const COLOR_LIB = `
  const parse = c => { const m = /rgba?\\(([^)]+)\\)/.exec(c || ''); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const over = (top, bot) => ({ r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a), a: 1 });
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const bgOf = el => { const stack = []; for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; } } let out = parse(getComputedStyle(document.body).backgroundColor) || { r: 15, g: 14, b: 18, a: 1 }; for (let i = stack.length - 1; i >= 0; i--) out = over(stack[i], out); return out; };
  const hex = c => c ? '#' + [c.r, c.g, c.b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('') : null;
`;

/**
 * The checks one render of a scene answers (spec §8.1, 8.2, 8.3, 8.4, 8.8, 8.11): the visible words
 * (data left out), the fit, sideways overflow, text and control contrast, the primaries, Bones on the
 * stage, first person on the stage, and the length of Bones's line. screens: SCREEN_OF.
 */
export const checkJs = (screens) => `(() => {
  ${COLOR_LIB}
  const SCREENS = ${JSON.stringify(screens)};
  const app = document.getElementById('app');
  const page = document.getElementById('page');
  const sheetHost = document.getElementById('sheet-host');
  const sheetOpen = !!(sheetHost && sheetHost.querySelector('.sheet'));
  const col = page.querySelector(':scope > .col');
  const colCls = col ? [...col.classList].find(c => SCREENS[c]) : null;
  const screen = colCls ? SCREENS[colCls] : null;
  const mode = app.getAttribute('data-mode');
  const vis = el => !!el && el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true }) && el.getClientRects().length > 0;
  // Words: every visible text node, data and screen-reader-only text left out; app pages leave out the nav and the wordmark.
  // Behind a click (spec §6): the sheet, a row's own disclosure; a native dialog's preview isn't the page's.
  const skipSel = '[data-count="data"], [data-behind="click"], #confirm-preview, .sr-only, #live, script, style' + (mode === 'app' ? ', #nav' : '') + ', #wordmark, #side-foot, #status-tip' + (sheetOpen ? ', #sheet-host' : '');
  const parts = [];
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = tw.nextNode())) {
    const el = n.parentElement;
    if (!el || !n.textContent.trim() || el.closest(skipSel) || !vis(el)) continue;
    parts.push(n.textContent);
  }
  const words = parts.join(' ').split(/\\s+/).filter(Boolean).length;
  // Fit.
  const se = document.scrollingElement;
  const fit = { doc: se.scrollHeight <= innerHeight + 1, page: page.scrollHeight <= page.clientHeight + 1, pageOver: page.scrollHeight - page.clientHeight };
  const companion = document.getElementById('companion');
  const stage = document.getElementById('stage');
  const overflowX = [['html', document.documentElement], ['body', document.body], ['panel', companion], ['stage', stage], ['page', page]]
    .filter(([, el]) => el && el.scrollWidth > el.clientWidth + 1).map(([k, el]) => k + '+' + (el.scrollWidth - el.clientWidth));
  const panelClipped = companion ? Math.max(0, [...companion.children].filter(vis).reduce((m, c) => Math.max(m, c.getBoundingClientRect().bottom), 0) - companion.getBoundingClientRect().bottom) : 0;
  // Contrast: text 4.5:1 (3:1 at 24 px); control edges 3:1.
  const contrast = [];
  const seen = new Set();
  const tw2 = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while ((n = tw2.nextNode())) {
    const el = n.parentElement;
    if (!el || seen.has(el) || !n.textContent.trim() || el.closest('.sr-only, #live, [aria-disabled="true"], #confirm-preview') || !vis(el)) continue;
    seen.add(el);
    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    if (!fg) continue;
    const bg = bgOf(el);
    const r = ratio(fg.a < 1 ? over(fg, bg) : fg, bg);
    const big = parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.66 && Number(cs.fontWeight) >= 700);
    if (r < (big ? 3 : 4.5) - 0.01) contrast.push({ text: n.textContent.trim().slice(0, 30), fg: hex(fg), bg: hex(bg), ratio: Math.round(r * 100) / 100 });
  }
  const edges = [];
  for (const el of document.querySelectorAll('.radio, .input, .select, .money, .switch[aria-checked="false"]')) {
    if (!vis(el) || el.closest('[aria-disabled="true"]')) continue;
    const cs = getComputedStyle(el);
    const edge = el.matches('.switch') ? parse(cs.backgroundColor) : parse(cs.borderTopColor);
    const around = bgOf(el.parentElement);
    const r = ratio(edge, around);
    if (r < 2.99) edges.push({ el: el.className, edge: hex(edge), bg: hex(around), ratio: Math.round(r * 100) / 100 });
  }
  const faintText = [...document.querySelectorAll('body *')].filter(el => vis(el) && [...el.childNodes].some(c => c.nodeType === 3 && c.textContent.trim()) && getComputedStyle(el).color === 'rgb(127, 123, 115)').map(el => el.textContent.trim().slice(0, 30));
  // One primary outside an open sheet.
  const primaries = [...document.querySelectorAll('#page .btn-primary, #banners .btn-primary, #topbar .btn-primary')].filter(vis).map(el => el.textContent.trim().slice(0, 40));
  // A click on any control must reach it: on a Mac a window-drag region swallows clicks on whatever is
  // drawn over it (the owner's 'the X doesn't close the panel', 2026-10-02). Regions are built as
  // Chromium builds them, not by hit-testing (an inert top bar still drags): every element with a drag
  // or no-drag -webkit-app-region, in document order, a later one overriding an earlier one where they
  // overlap. No visible control in any scene (a button, a link, a field, a menu, anything focusable) may
  // have its centre or a corner on drag: the sheet's ×, Back in the title row, the panel's buttons.
  const dragUnder = [];
  {
    const regions = [...document.querySelectorAll('body *')].map(el => [el, getComputedStyle(el).getPropertyValue('-webkit-app-region').trim()])
      .filter(([el, v]) => (v === 'drag' || v === 'no-drag') && vis(el)).map(([el, v]) => [el.getBoundingClientRect(), v, el]);
    const regionAt = (x, y) => { let st = null; for (const [r, v, el] of regions) if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) st = [v, el]; return st; };
    for (const c of document.querySelectorAll('button, a[href], select, input, textarea, summary, [tabindex="0"]')) {
      if (!vis(c) || c.closest('[inert]')) continue;
      // Only the part you can see: clipped by every scrolling or clipping box it sits in (a control
      // scrolled up past the page's top is hidden there, not under the top bar).
      const r0 = c.getBoundingClientRect();
      const r = { left: r0.left, top: r0.top, right: r0.right, bottom: r0.bottom };
      for (let a = c.parentElement; a && a !== document.body; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (/(auto|scroll|hidden|clip)/.test(cs.overflowX + ' ' + cs.overflowY)) {
          const ar = a.getBoundingClientRect();
          r.left = Math.max(r.left, ar.left); r.top = Math.max(r.top, ar.top); r.right = Math.min(r.right, ar.right); r.bottom = Math.min(r.bottom, ar.bottom);
        }
      }
      r.width = r.right - r.left; r.height = r.bottom - r.top;
      if (r.width < 4 || r.height < 4) continue;
      for (const [x, y] of [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 2, r.top + 2], [r.right - 2, r.top + 2], [r.left + 2, r.bottom - 2], [r.right - 2, r.bottom - 2]]) {
        if (y < 0 || y > innerHeight || x < 0 || x > innerWidth) continue;
        const at = regionAt(x, y);
        if (at && at[0] === 'drag') { dragUnder.push((c.getAttribute('aria-label') || c.textContent || c.tagName).trim().slice(0, 24) + ' over ' + (at[1].id || at[1].className)); break; }
      }
    }
  }
  // Bones: never on the stage.
  const bonesOnStage = [...document.querySelectorAll('.bones, img[src*="bones"]')].filter(el => !el.closest('.companion')).length;
  const firstPerson = [];
  for (const el of document.querySelectorAll('#page p, #page h1, #page h2, #page span, #banners p, #topbar span, #sheet-host p')) {
    if (!vis(el) || el.closest('[data-count="data"]')) continue;
    const t = el.textContent.trim();
    if (/^I(’m|'m)?\\s/.test(t) || /I(’m|'m) NeverQuestAlone/.test(t)) firstPerson.push(t.slice(0, 40));
  }
  // A class name that leaked into the text (CL-design-01: "set-tall" under every privacy switch).
  const classNames = new Set();
  for (const el of document.querySelectorAll('[class]')) for (const c of el.classList) classNames.add(c);
  const classLeak = [];
  const tw3 = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while ((n = tw3.nextNode())) {
    const t = n.textContent.trim();
    if (t && classNames.has(t) && n.parentElement && vis(n.parentElement) && !n.parentElement.closest('[data-count="data"], .code')) classLeak.push(t);
  }
  // The counted words themselves, for reading an over-budget screen.
  const text = parts.join(' ').replace(/\\s+/g, ' ').trim().slice(0, 700);
  return { screen, mode, sheetOpen, words, text, fit, overflowX, panelClipped: Math.round(panelClipped), contrast: contrast.slice(0, 12), edges, faintText: faintText.slice(0, 5), primaries, bonesOnStage, firstPerson, classLeak: classLeak.slice(0, 8), dragUnder: dragUnder.slice(0, 6), size: [innerWidth, innerHeight] };
})()`;

/** The interactive elements the hover check moves the mouse over: their centres. */
export const HOVER_TARGETS_JS = `(() => {
  const vis = el => el.checkVisibility({ visibilityProperty: true }) && el.getClientRects().length > 0;
  const inert = el => !!el.closest('[inert]');
  const out = [];
  for (const el of document.querySelectorAll('button, a[href], input, select, [role="radio"], [role="switch"], .lastrow, .set-link, .choice')) {
    if (!vis(el) || inert(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
    out.push({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), what: (el.getAttribute('data-fk') || el.getAttribute('data-nav') || el.id || el.textContent.trim()).slice(0, 30) });
  }
  return out.slice(0, 48);
})()`;

/**
 * Every element's box and visibility (the hover and timer checks compare two of these). Opacity only
 * where it isn't an animation the spec allows: the Listening dot and the in-game frames.
 */
export const SNAP_JS = `(() => {
  const out = [];
  for (const el of document.querySelectorAll('#app *, #sheet-host *')) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    // Bones's state beside his portrait shows on hover: the owner's one exception to "nothing appears
    // on hover" (2026-10-02). It's an overlay, so nothing else moves.
    if (el.matches('.status-tip')) continue;
    const anim = el.matches('.listen-dot, .ingame-frame');
    out.push([Math.round(r.left * 2) / 2, Math.round(r.top * 2) / 2, Math.round(r.width * 2) / 2, Math.round(r.height * 2) / 2, cs.visibility, cs.display, anim ? '*' : cs.opacity].join(','));
  }
  return out;
})()`;

/** The focused element after a Tab: where it is, and whether it shows the 2 px focus ring (3:1 against what's around it). */
export const FOCUS_JS = `(() => {
  ${COLOR_LIB}
  const a = document.activeElement;
  if (!a || a === document.body) return null;
  const ringEl = a.matches('.money-in') ? a.closest('.money') : a;
  const cs = getComputedStyle(ringEl);
  const r = a.getBoundingClientRect();
  const ring = parse(cs.outlineColor);
  const around = bgOf(ringEl.parentElement || ringEl);
  const region = a.closest('#companion') ? 0 : a.closest('#topbar') ? 1 : a.closest('#banners') ? 2 : a.closest('#page') ? 3 : a.closest('#sheet-host') ? 4 : 5;
  return {
    key: a.tagName + '|' + (a.id || a.getAttribute('data-fk') || a.getAttribute('data-nav') || a.className || '').slice(0, 40),
    // 2 px, which a zoomed window reports in device-snapped CSS px (1.9 at 131%, 1.7 at 173%).
    ok: a.matches(':focus-visible') && cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 1.5 && !!ring && ring.a > 0 && ratio(ring, around) >= 3,
    ring: [cs.outlineStyle, cs.outlineWidth, cs.outlineColor].join(' '), region, visible: r.width > 0 && r.height > 0,
  };
})()`;
