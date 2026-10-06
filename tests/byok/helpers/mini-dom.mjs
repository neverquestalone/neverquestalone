// A small DOM for running the desktop app's settings page (app/desktop/renderer/app.js) under
// node --test: elements, text, attributes, events, focus and document.activeElement, and the
// selectors the page uses (tag, #id, .class, [attr], [attr="v"], :checked, :disabled, descendant
// and comma lists). Enough to drive the page like a keyboard user and check what it does; not a
// browser. loadPage() builds the static shell from renderer/index.html's nav, runs format.js and
// app.js in a vm context over window.nqa, and returns helpers.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const R = path.join(HERE, '..', '..', '..', 'app', 'desktop', 'renderer');

class Node {
  constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get nextSibling() { const p = this.parentNode; if (!p) return null; return p.childNodes[p.childNodes.indexOf(this) + 1] ?? null; }
  get previousSibling() { const p = this.parentNode; if (!p) return null; return p.childNodes[p.childNodes.indexOf(this) - 1] ?? null; }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === this.ownerDocument; }
  get textContent() { return this.childNodes.map(c => c.textContent).join(''); }
  set textContent(v) { this._removeAll(); if (v !== '' && v != null) this._insert(this.ownerDocument.createTextNode(String(v))); }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  _insert(n) {
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    this.childNodes.push(n);
  }
  _removeAll() { for (const c of [...this.childNodes]) this.removeChild(c); }
  append(...nodes) { for (const n of nodes) this._insert(n instanceof Node ? n : this.ownerDocument.createTextNode(String(n))); }
  appendChild(n) { this._insert(n); return n; }
  /** Like the DOM's: n goes before ref (or last with no ref), leaving its old place first. */
  insertBefore(n, ref) {
    if (!ref) { this._insert(n); return n; }
    if (ref.parentNode !== this) throw new Error('not a child');
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, n);
    return n;
  }
  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i < 0) throw new Error('not a child');
    const doc = this.ownerDocument;
    const active = doc._active;
    this.childNodes.splice(i, 1);
    n.parentNode = null;
    // Like a browser: focus inside a removed subtree goes back to the body.
    if (active && n.contains(active)) doc._active = null;
    return n;
  }
  remove() { this.parentNode?.removeChild(this); }
  replaceChildren(...nodes) { this._removeAll(); this.append(...nodes); }
}

class Text extends Node {
  constructor(doc, data) { super(doc); this.data = data; this.nodeType = 3; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
  cloneNode() { return new Text(this.ownerDocument, this.data); }
}

class Element extends Node {
  constructor(doc, tag) {
    super(doc);
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.attributes = new Map();
    this.listeners = {};
    this.scrollTop = 0;
    this.scrolledInto = null;
    this._value = '';
    this._checked = false;
    this._selected = false;
    this.disabled = false;
    this.hidden = false;
    this.readOnly = false;
  }
  get children() { return this.childNodes.filter(c => c instanceof Element); }
  // A failed assertion prints this, never the whole tree (which loops through parentNode).
  [Symbol.for('nodejs.util.inspect.custom')]() { return `<${this.tagName.toLowerCase()}${this.id ? `#${this.id}` : ''}${this.className ? `.${this.className.split(/\s+/).join('.')}` : ''}>`; }
  get id() { return this.getAttribute('id') ?? ''; }
  set id(v) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') ?? ''; }
  set className(v) { this.setAttribute('class', v); }
  get type() { return this.getAttribute('type') ?? (this.tagName === 'INPUT' ? 'text' : ''); }
  set type(v) { this.setAttribute('type', v); }
  get classList() { const el = this; return { contains: c => el.className.split(/\s+/).includes(c) }; }
  setAttribute(k, v) { this.attributes.set(String(k), String(v)); }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  hasAttribute(k) { return this.attributes.has(k); }
  getAttributeNames() { return [...this.attributes.keys()]; }
  removeAttribute(k) { this.attributes.delete(k); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter(f => f !== fn); }
  dispatchEvent(e) {
    if (!e.target) e.target = this;
    e.currentTarget = this;
    for (const fn of [...(this.listeners[e.type] ?? [])]) fn.call(this, e);
    if (e.bubbles !== false && !e._stop && this.parentNode instanceof Element) this.parentNode.dispatchEvent(e);
    else if (e.bubbles !== false && !e._stop && this.parentNode instanceof Document) this.parentNode.dispatchEvent(e);
    return !e.defaultPrevented;
  }
  focus() {
    if (this.disabled || !this.isConnected) return;
    this.ownerDocument._active = this;
  }
  blur() { if (this.ownerDocument._active === this) this.ownerDocument._active = null; }
  click() {
    if (this.disabled) return;
    const doc = this.ownerDocument;
    if (this.tagName === 'INPUT' && this.type === 'checkbox') {
      this._checked = !this._checked;
      this.dispatchEvent(doc.event('click'));
      this.dispatchEvent(doc.event('change'));
      return;
    }
    if (this.tagName === 'INPUT' && this.type === 'radio') {
      const name = this.getAttribute('name');
      if (name) for (const r of doc.querySelectorAll(`input[name="${name}"]`)) r._checked = false;
      this._checked = true;
      this.dispatchEvent(doc.event('click'));
      this.dispatchEvent(doc.event('change'));
      return;
    }
    this.dispatchEvent(doc.event('click'));
  }
  select() { this.selectedAll = true; }
  scrollIntoView(opts) { this.scrolledInto = opts ?? true; this.ownerDocument.scrolls.push(this); }
  get checked() { return this._checked; }
  set checked(v) { this._checked = !!v; }
  get selected() { return this._selected; }
  set selected(v) {
    this._selected = !!v;
    if (v && this.parentNode) for (const o of this.parentNode.children) if (o !== this && o.tagName === 'OPTION') o._selected = false;
  }
  get options() { return this.children.filter(c => c.tagName === 'OPTION'); }
  get value() {
    if (this.tagName === 'SELECT') { const o = this.options.find(x => x._selected) ?? this.options[0]; return o ? o.value : ''; }
    if (this.tagName === 'OPTION') return this.attributes.has('value') ? this.getAttribute('value') : (this._value || this.textContent);
    return this._value;
  }
  set value(v) {
    if (this.tagName === 'SELECT') { for (const o of this.options) o._selected = o.value === String(v); return; }
    if (this.tagName === 'OPTION') { this.setAttribute('value', v); return; }
    this._value = String(v);
  }
  cloneNode(deep = false) {
    const c = new Element(this.ownerDocument, this.tagName.toLowerCase());
    for (const [k, v] of this.attributes) c.attributes.set(k, v);
    if (deep) for (const k of this.childNodes) c.append(k.cloneNode(true));
    return c;
  }
  querySelectorAll(sel) { return queryAll(this, sel); }
  querySelector(sel) { return queryAll(this, sel)[0] ?? null; }
  get innerText() { return this.textContent; }
}

// ---- selectors

function parseCompound(src) {
  const c = { tag: null, id: null, classes: [], attrs: [], pseudo: [] };
  const re = /^([a-zA-Z][a-zA-Z0-9-]*)|#([A-Za-z0-9_-]+)|\.([A-Za-z0-9_-]+)|\[([a-zA-Z-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]|:([a-z-]+)/y;
  let i = 0;
  while (i < src.length) {
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw new Error(`mini-dom: unsupported selector ${src}`);
    if (m[1]) c.tag = m[1].toUpperCase();
    else if (m[2]) c.id = m[2];
    else if (m[3]) c.classes.push(m[3]);
    else if (m[4]) c.attrs.push([m[4], m[5] ?? m[6] ?? m[7] ?? null]);
    else if (m[8]) c.pseudo.push(m[8]);
    i = re.lastIndex;
  }
  return c;
}
function matches(el, c) {
  if (c.tag && el.tagName !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  const cls = el.className.split(/\s+/);
  for (const k of c.classes) if (!cls.includes(k)) return false;
  for (const [k, v] of c.attrs) {
    const a = el.getAttribute(k);
    if (a === null) return false;
    if (v !== null && a !== v) return false;
  }
  for (const p of c.pseudo) {
    if (p === 'checked' && !el.checked) return false;
    if (p === 'disabled' && !el.disabled) return false;
  }
  return true;
}
function matchesChain(el, chain, root) {
  if (!matches(el, chain[chain.length - 1])) return false;
  let k = chain.length - 2;
  for (let a = el.parentNode; k >= 0 && a && a !== root.parentNode; a = a.parentNode) {
    if (a instanceof Element && matches(a, chain[k])) k -= 1;
  }
  return k < 0;
}
/** Split on a separator outside quotes and brackets. */
function splitTop(src, sep) {
  const out = [];
  let cur = '';
  let q = null;
  let depth = 0;
  for (const ch of src) {
    if (q) { if (ch === q) q = null; cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '[') depth += 1;
    if (ch === ']') depth -= 1;
    if (depth === 0 && sep.test(ch)) { if (cur) out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
function queryAll(root, sel) {
  const chains = splitTop(sel, /,/).map(s => splitTop(s.trim(), /\s/).map(parseCompound));
  const out = [];
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (!(c instanceof Element)) continue;
      if (chains.some(ch => matchesChain(c, ch, root))) out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}

class Document extends Node {
  constructor() {
    super(null);
    this.ownerDocument = this;
    this._active = null;
    this.scrolls = [];
    this.documentElement = new Element(this, 'html');
    this._insert(this.documentElement);
    this.body = new Element(this, 'body');
    this.documentElement.append(this.body);
  }
  get activeElement() { return this._active && this._active.isConnected ? this._active : this.body; }
  // Document-level listeners (the page's ⌘V paste listener): events bubble here from the tree.
  addEventListener(type, fn) { (this.listeners ??= {})[type] = [...(this.listeners?.[type] ?? []), fn]; }
  removeEventListener(type, fn) { if (this.listeners?.[type]) this.listeners[type] = this.listeners[type].filter(f => f !== fn); }
  dispatchEvent(e) {
    if (!e.target) e.target = this;
    e.currentTarget = this;
    for (const fn of [...(this.listeners?.[e.type] ?? [])]) fn.call(this, e);
    return !e.defaultPrevented;
  }
  createElement(tag) { return new Element(this, tag); }
  createTextNode(t) { return new Text(this, String(t)); }
  getElementById(id) { return queryAll(this, `#${id}`)[0] ?? null; }
  querySelectorAll(sel) { return queryAll(this, sel); }
  querySelector(sel) { return queryAll(this, sel)[0] ?? null; }
  event(type, extra = {}) {
    return { type, bubbles: true, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this._stop = true; }, ...extra };
  }
}

/**
 * The shell index.html builds: NeverQuestAlone's panel (the wordmark, the portrait button with its status
 * line, the tracker, the nav with its buttons as index.html has them, the foot), the stage (top
 * bar, banners, page, the sheet's host) and the live region.
 */
function buildShell(doc) {
  const html = fs.readFileSync(path.join(R, 'index.html'), 'utf8');
  const el = (tag, attrs = {}, ...kids) => {
    const e = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    e.append(...kids);
    return e;
  };
  const navButton = m => {
    const b = el('button', { type: 'button', class: m[1], 'data-nav': m[2] }, m[4].replace('&amp;', '&'));
    if (m[3]) b.hidden = true;
    return b;
  };
  const BUTTON = /<button type="button" class="(nav-item[^"]*)" data-nav="([a-z-]+)"( hidden)?>([^<]+)<\/button>/g;
  const navHtml = /<nav class="nav"[^>]*>([\s\S]*?)<\/nav>/.exec(html)[1];
  const nav = el('nav', { class: 'nav', id: 'nav', 'aria-label': 'Pages' });
  nav.hidden = true;
  for (const m of navHtml.matchAll(BUTTON)) nav.append(navButton(m));
  const tracker = el('ol', { class: 'tracker', id: 'tracker', 'aria-label': 'Setup progress' });
  tracker.hidden = true;
  const companion = el('aside', { class: 'companion', id: 'companion', 'aria-label': 'NeverQuestAlone' },
    el('p', { class: 'wordmark', id: 'wordmark', 'aria-hidden': 'true' }, 'NeverQuestAlone'),
    el('button', { type: 'button', class: 'bones-btn', id: 'bones-btn', 'aria-label': 'NeverQuestAlone' },
      el('span', { class: 'portrait', id: 'portrait', 'data-mood': 'idle', 'aria-hidden': 'true' }),
      el('span', { class: 'status-tip', id: 'status-tip', 'aria-hidden': 'true' })),
    tracker, nav,
    el('div', { class: 'side-foot', id: 'side-foot' }));
  // The banners and the page share the one <main> landmark, as in index.html.
  const stage = el('div', { class: 'stage', id: 'stage' },
    el('header', { class: 'topbar', id: 'topbar' }),
    el('main', { class: 'main-body', id: 'main-body' }, el('div', { class: 'banners', id: 'banners' }), el('div', { class: 'page', id: 'page', tabindex: '-1' })),
    el('div', { class: 'sheet-host', id: 'sheet-host' }));
  doc.body.append(el('div', { class: 'app', id: 'app', 'data-mode': 'loading' }, companion, stage));
  // The welcome's route on the map, the same way (a copy of index.html's figure).
  const map = /<figure class="ingame mapfig" id="map-src" role="img" aria-label="([^"]*)" hidden>([\s\S]*?)<\/figure>/.exec(html);
  if (map) {
    const f = el('figure', { class: 'ingame mapfig', id: 'map-src', role: 'img', 'aria-label': map[1] });
    f.hidden = true;
    for (const m of map[2].matchAll(/<img class="([^"]+)" src="([^"]+)" alt=""[^>]*>/g)) f.append(el('img', { class: m[1], src: m[2], alt: '' }));
    doc.body.append(f);
  }
  const live = /<div class="sr-only" id="live" aria-live="([a-z]+)"[^>]*><\/div>/.exec(html);
  if (live) doc.body.append(el('div', { class: 'sr-only', id: 'live', 'aria-live': live[1] }));
}

/**
 * Run the page over bones (window.nqa: every call and the three subscriptions). Returns
 * { window, document, page, settle, byText, click, press, live, pageText }.
 */
export function loadPage(bones, { hash = '' } = {}) {
  const doc = new Document();
  buildShell(doc);
  const ctx = { document: doc, Node, nqa: bones, location: { hash }, console, Intl, Promise, Object, Array, String, Number, Math, Date, JSON, isFinite, isNaN, RegExp, Error, requestAnimationFrame: fn => setImmediate(fn) };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(R, 'strings.js'), 'utf8'), ctx, { filename: 'strings.js' });
  vm.runInContext(fs.readFileSync(path.join(R, 'format.js'), 'utf8'), ctx, { filename: 'format.js' });
  vm.runInContext(fs.readFileSync(path.join(R, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
  const settle = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
  const within = sel => (sel ? doc.querySelector(sel) : doc);
  const byText = (text, sel = 'button', root = null) => within(root).querySelectorAll(sel).filter(b => b.textContent.trim() === text);
  const one = (text, sel, root) => {
    const all = byText(text, sel, root);
    if (!all.length) throw new Error(`no ${sel ?? 'button'} "${text}" (have: ${within(root).querySelectorAll(sel ?? 'button').map(b => b.textContent.trim()).join(' | ')})`);
    return all[0];
  };
  /** A keyboard user's activation: focus the control, then press it. */
  const press = async (el) => { el.focus(); el.click(); await settle(); };
  const click = async (text, sel = 'button', root = null) => press(one(text, sel, root));
  const page = () => doc.getElementById('page');
  return {
    window: ctx, document: doc, page, settle, byText, one, click, press,
    live: () => doc.getElementById('live'),
    liveText: () => doc.getElementById('live').childNodes.map(n => n.textContent),
    pageText: () => page().textContent,
    bannerText: () => doc.getElementById('banners').textContent,
    topText: () => doc.getElementById('topbar').textContent,
    sheetText: () => doc.getElementById('sheet-host').textContent,
    statusText: () => doc.getElementById('status-tip').textContent,
    footText: () => doc.getElementById('side-foot').textContent,
    stageText: () => ['topbar', 'banners', 'page'].map(id => doc.getElementById(id).textContent).join(' '),
    event: (type, extra) => doc.event(type, extra),
  };
}
