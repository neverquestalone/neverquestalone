// Every string literal in a source file, with where it sits, for the string
// lint (docs/STYLE.md §15): the call it's an argument of and its index, the
// table or object key it's the value of, the variable it's assigned to, and
// whether it's one piece of a `..` or `+` join. Classifying a string as a
// label, a heading or body text is the lint's job; this only finds them.
//   Lua:  luaparse (5.1), so comments and long strings are exact.
//   JS:   a small tokenizer that knows strings, template literals, comments,
//         regular expressions and brackets; enough for this repo's code.
//   Markdown and HTML: the text a reader sees, by line.
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Wrappers that pass their string through: a string inside them keeps the
// place of the wrapper itself (so `title = string.format("Stop %d", n)` is
// still a title).
const LUA_PASS = new Set(['string.format', 'format', 'ns.Escape', 'Esc', 'tostring', 'ns.Str', 'ns.SafeText', 'ns.Clean', 'ns.P', 'PW', 'PTip', 'PText', 'ns.OurTip', 'ns.Fill', 'ns.Plural']);
const JS_PASS = new Set(['String', 'F.clean', 'F.fill', 'fill', 'clean']);

function luaDecode(raw) {
  // raw is the literal's source bytes as latin1 characters, quotes included.
  if (raw[0] === '[') return Buffer.from(raw.replace(/^\[(=*)\[\n?/, '').replace(/\](=*)\]$/, ''), 'latin1').toString('utf8');
  const s = raw.slice(1, -1);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') { out.push(c.charCodeAt(0) & 255); continue; }
    const n = s[++i];
    const simple = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '\\': 92, '"': 34, "'": 39, '\n': 10 };
    if (n in simple) out.push(simple[n]);
    else if (/[0-9]/.test(n)) {
      let d = n;
      while (d.length < 3 && /[0-9]/.test(s[i + 1])) d += s[++i];
      out.push(Number(d) & 255);
    } else { out.push(92, n.charCodeAt(0) & 255); }
  }
  return Buffer.from(out).toString('utf8');
}

function luaName(e) {
  if (!e) return '';
  if (e.type === 'Identifier') return e.name;
  if (e.type === 'MemberExpression') return `${luaName(e.base)}${e.indexer}${e.identifier.name}`;
  if (e.type === 'IndexExpression') return `${luaName(e.base)}[]`;
  return '';
}

/** Lua: [{ file, line, text, call, method, arg, key, assign, join, fn }]; fn the named function it sits in */
export function luaStrings(file, src = fs.readFileSync(file, 'latin1')) {
  const luaparse = require('luaparse');
  const ast = luaparse.parse(src, { locations: true, luaVersion: '5.1', encodingMode: 'pseudo-latin1', comments: false });
  const out = [];
  const walk = (node, ctx) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, ctx);
      return;
    }
    switch (node.type) {
      case 'StringLiteral':
        out.push({ file, line: node.loc.start.line, text: luaDecode(node.raw), call: ctx.call || '', method: ctx.method || '', arg: ctx.arg ?? -1, key: ctx.key || '', assign: ctx.assign || '', path: ctx.path || '', join: !!ctx.join, fmt: !!ctx.fmt, fn: ctx.fn || '' });
        return;
      case 'FunctionDeclaration':
        // The function a string sits in, by name (a diagnostics function's output may name anything, §10).
        walk(node.body, { ...ctx, fn: node.identifier ? luaName(node.identifier) : ctx.fn });
        return;
      case 'IfStatement':
        for (const cl of node.clauses) {
          if (cl.condition) walk(cl.condition, ctx);
          walk(cl.body, ctx);
        }
        return;
      case 'TableConstructorExpression': {
        let pos = 0;
        for (const f of node.fields) {
          if (f.type === 'TableValue') { pos += 1; walk(f.value, { ...ctx, path: ctx.path ? `${ctx.path}.${pos}` : String(pos), join: false }); }
          else walk(f, ctx);
        }
        return;
      }
      case 'CallExpression':
      case 'StringCallExpression':
      case 'TableCallExpression': {
        const name = luaName(node.base);
        walk(node.base, { ...ctx, join: false });
        const args = node.type === 'CallExpression' ? node.arguments : [node.argument];
        const method = node.base && node.base.type === 'MemberExpression' ? node.base.identifier.name : name;
        args.forEach((a, i) => {
          if (LUA_PASS.has(name)) walk(a, { ...ctx, join: false, fmt: name.endsWith('format') && i === 0 });
          else walk(a, { call: name, method, arg: i, key: '', assign: '', path: '', join: false, fmt: false, fn: ctx.fn });
        });
        return;
      }
      case 'BinaryExpression':
        if (node.operator === '..') { walk(node.left, { ...ctx, join: true }); walk(node.right, { ...ctx, join: true }); return; }
        walk(node.left, ctx); walk(node.right, ctx);
        return;
      case 'LogicalExpression':
        walk(node.left, ctx); walk(node.right, ctx);
        return;
      case 'TableKeyString':
        walk(node.value, { ...ctx, key: node.key.name, path: '', join: false });
        return;
      case 'TableKey':
        walk(node.key, ctx);
        walk(node.value, { ...ctx, key: node.key.type === 'StringLiteral' ? luaDecode(node.key.raw) : ctx.key, join: false });
        return;
      case 'AssignmentStatement':
      case 'LocalStatement':
        node.init.forEach((v, i) => {
          const t = node.variables[i];
          walk(v, { ...ctx, assign: t ? (t.type === 'Identifier' ? t.name : luaName(t)) : '', path: '', join: false });
        });
        for (const v of node.variables) if (v.type !== 'Identifier') walk(v, ctx);
        return;
      default:
        for (const k of Object.keys(node)) if (k !== 'loc' && k !== 'range' && k !== 'type') walk(node[k], ctx);
    }
  };
  walk(ast, {});
  return out;
}

/** JS/MJS: [{ file, line, text, call, arg, key, join, template }] */
export function jsStrings(file, src = fs.readFileSync(file, 'utf8')) {
  const out = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  let prev = ''; // the last significant token, to tell a regex from a division
  let prevWord = '';
  let lastBefore = ''; // the token before the last string, to tell `'a-key': v` from `c ? 'a' : 'b'`
  // Bracket stack: { t: '(' | '{' | '[' | '${', call, arg, key }
  const stack = [{ t: 'top', call: '', arg: -1, key: '' }];
  const top = () => stack[stack.length - 1];
  const place = () => {
    // The innermost call, the nearest key inside it, the position in the
    // innermost array, and the variable the outermost array or object went to.
    let call = '', arg = -1, key = '', pos = -1, assign = '';
    const t = top();
    if (t.t === '[') pos = t.idx;
    for (let k = stack.length - 1; k >= 0; k--) {
      const f = stack[k];
      if (!assign && f.assign) assign = f.assign;
      if (!key && f.t === '{' && f.key) key = f.key;
      if (f.t === '(' ) {
        if (JS_PASS.has(f.call)) continue;
        if (!call) { call = f.call; arg = f.arg; }
      }
    }
    return { call, arg, key, pos, assign };
  };
  let pendingAssign = '';
  const joinedBefore = () => /\+\s*$/.test(src.slice(Math.max(0, i - 40), i));
  const regexAllowed = () => !prev || /^[(,=:[!&|?{};+\-*%<>~^]$/.test(prev) || /^(return|typeof|case|in|of|delete|void|throw|new|else|do)$/.test(prevWord);
  const readString = (q) => {
    const start = line;
    let s = '';
    let j = i + 1;
    let template = false;
    while (j < n && src[j] !== q) {
      const c = src[j];
      if (c === '\\') {
        const e = src[j + 1];
        if (e === 'u') {
          if (src[j + 2] === '{') { const end = src.indexOf('}', j); s += String.fromCodePoint(parseInt(src.slice(j + 3, end), 16)); j = end + 1; continue; }
          s += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)); j += 6; continue;
        }
        if (e === 'x') { s += String.fromCharCode(parseInt(src.slice(j + 2, j + 4), 16)); j += 4; continue; }
        s += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' })[e] ?? e;
        if (e === '\n') line++;
        j += 2;
        continue;
      }
      if (q === '`' && c === '$' && src[j + 1] === '{') {
        // A placeholder: its name stands in, like a table string's {name}.
        let depth = 1;
        let k = j + 2;
        while (k < n && depth) { if (src[k] === '{') depth++; else if (src[k] === '}') depth--; if (src[k] === '\n') line++; k++; }
        const expr = src.slice(j + 2, k - 1).trim();
        const nm = (expr.match(/([A-Za-z_$][\w$]*)\s*(?:\(|$|\)|\.|\?)/) || [])[1] || 'x';
        s += `{${nm}}`;
        template = true;
        j = k;
        continue;
      }
      if (c === '\n') line++;
      s += c;
      j++;
    }
    const pl = place();
    const after = src.slice(j + 1, j + 8);
    lastBefore = prev;
    // A string compared with == or === is a value the code tests, never shown.
    const cmp = /[!=]==?\s*$/.test(src.slice(Math.max(0, i - 8), i)) || /^\s*[!=]==?[^=>]/.test(after);
    out.push({ file, line: start, text: s, call: pl.call, arg: pl.arg, key: pl.key, assign: pl.assign, pos: pl.pos, join: joinedBefore() || /^\s*\+/.test(after), template, cmp });
    i = j + 1;
    prev = 'str';
    prevWord = '';
  };
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; } i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') { readString(c); continue; }
    if (c === '/' && regexAllowed()) {
      let j = i + 1;
      let cls = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; else if (src[j] === '/' && !cls) break;
        j++;
      }
      i = j + 1;
      while (/[a-z]/.test(src[i])) i++;
      prev = 'str';
      prevWord = '';
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[\w$.]/.test(src[j])) j++;
      const word = src.slice(i, j);
      i = j;
      {
        let k2 = i;
        while (src[k2] === ' ') k2++;
        pendingAssign = src[k2] === '=' && src[k2 + 1] !== '=' && src[k2 + 1] !== '>' ? word : '';
      }
      // A key: `word:` inside an object literal (not `a ? b : c`).
      let k = i;
      while (src[k] === ' ') k++;
      if (src[k] === ':' && src[k + 1] !== ':' && top().t === '{' && /^[,{]$|^$/.test(prev)) top().key = word;
      prev = 'word';
      prevWord = word;
      continue;
    }
    if (c === '(') {
      stack.push({ t: '(', call: prev === 'word' ? prevWord : '', arg: 0 });
      prev = '('; prevWord = ''; i++; continue;
    }
    if (c === '{') { stack.push({ t: '{', key: '', assign: prev === '=' ? pendingAssign : '' }); prev = '{'; prevWord = ''; i++; continue; }
    if (c === '[') {
      stack.push({ t: '[', idx: 0, assign: prev === '=' ? pendingAssign : '' }); prev = '['; prevWord = ''; i++; continue;
    }
    if (c === ')' || c === '}' || c === ']') { if (stack.length > 1) stack.pop(); prev = c === ')' ? 'word' : c; prevWord = ''; i++; continue; }
    if (c === ',') {
      const t = top();
      if (t.t === '(') t.arg += 1;
      if (t.t === '[') t.idx += 1;
      if (t.t === '{') t.key = '';
      prev = ','; prevWord = ''; i++; continue;
    }
    if (c === ':' && top().t === '{' && prev === 'str' && out.length && /^[,{]$/.test(lastBefore)) {
      // `'quoted-key': value`: the last string was the key, not a string.
      top().key = out.pop().text;
      prev = ':'; i++; continue;
    }
    prev = c;
    prevWord = '';
    i++;
  }
  return out;
}

/** Markdown: [{ file, line, text, kind: 'heading' | 'text' }], code and comments left out.
 *  A ```game fence quotes what the game shows, a line each, checked by the game's rules
 *  (surface 'game'); a ```game-label fence, its buttons and menu items (kind 'label'). */
export function mdTexts(file, src = fs.readFileSync(file, 'utf8')) {
  const out = [];
  const lines = src.split('\n');
  let fence = false;
  let game = null; // the kind of a ```game or ```game-label fence's lines
  let comment = false;
  lines.forEach((raw, idx) => {
    let l = raw;
    const open = l.match(/^\s*```\s*([\w-]*)/);
    if (open) { fence = !fence; game = fence ? { game: 'text', 'game-label': 'label' }[open[1]] || null : null; return; }
    if (fence && game) { if (l.trim()) out.push({ file, line: idx + 1, kind: game, text: l.trim(), surface: 'game' }); return; }
    if (fence) return;
    if (comment) { if (l.includes('-->')) { comment = false; l = l.slice(l.indexOf('-->') + 3); } else return; }
    l = l.replace(/<!--.*?-->/g, '');
    if (l.includes('<!--')) { comment = true; l = l.slice(0, l.indexOf('<!--')); }
    const text = l
      .replace(/`[^`]*`/g, 'CODE')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<https?:[^>]*>/g, 'LINK')
      .replace(/https?:\/\/\S+/g, 'LINK')
      .replace(/<[A-Z_]+>/g, 'PLACEHOLDER')
      .replace(/\*\*|__/g, '')
      .trim();
    if (!text || /^[-|: ]+$/.test(text)) return;
    const h = raw.match(/^(#{1,6})\s+(.*)$/);
    if (h) out.push({ file, line: idx + 1, kind: 'heading', text: text.replace(/^#{1,6}\s+/, '') });
    else out.push({ file, line: idx + 1, kind: 'text', text: text.replace(/^[-*>]\s+|^\d+\.\s+/, '').replace(/^\|\s*|\s*\|$/g, '') });
  });
  return out;
}

/** HTML: [{ file, line, text, kind: 'heading' | 'label' | 'alt' | 'text' }] */
export function htmlTexts(file, src = fs.readFileSync(file, 'utf8')) {
  const out = [];
  const lineAt = (idx) => src.slice(0, idx).split('\n').length;
  const clean = s => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&rsquo;/g, '’').replace(/&lsquo;/g, '‘')
    .replace(/&ldquo;/g, '“').replace(/&rdquo;/g, '”').replace(/&hellip;/g, '…').replace(/&ndash;/g, '–').replace(/&mdash;/g, '—').replace(/&middot;/g, '·')
    .replace(/&reg;/g, '®').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').replace(/ ([.,;:!?])/g, '$1').trim();
  const blank = m => m.replace(/[^\n]/g, ' ');
  let body = src.replace(/<script[\s\S]*?<\/script>/gi, blank).replace(/<style[\s\S]*?<\/style>/gi, blank)
    .replace(/<!--[\s\S]*?-->/g, blank);
  // The end of the element that opens at `at` (its whole markup, nested tags of the same name counted).
  const endOf = (at, openTag, tag) => {
    if (openTag.endsWith('/>')) return at + openTag.length;
    const step = new RegExp(`<(/?)${tag}\\b[^>]*?(/?)>`, 'gi');
    step.lastIndex = at + openTag.length;
    let depth = 1, t;
    while ((t = step.exec(body))) {
      if (t[2] === '/') continue;
      depth += t[1] ? -1 : 1;
      if (depth === 0) return t.index + t[0].length;
    }
    return body.length;
  };
  const cut = (re, keep) => {
    let o;
    re.lastIndex = 0;
    while ((o = re.exec(body))) {
      const end = endOf(o.index, o[0], o[1].toLowerCase());
      if (keep) keep(body.slice(o.index, end), o.index);
      body = body.slice(0, o.index) + blank(body.slice(o.index, end)) + body.slice(end);
    }
  };
  // A replica of the game's own UI (data-surface="game") is checked with the game's rules,
  // even as decorative art: its words must be the addon's words.
  cut(/<([a-z][a-z0-9]*)\b[^>]*\bdata-surface="game"[^>]*>/gi, (html, at) => {
    const pad = src.slice(0, at).replace(/[^\n]/g, ' ');
    for (const t of htmlTexts(file, pad + html.replace(/\baria-hidden="true"|\bdata-surface="game"/g, ''))) out.push({ ...t, surface: 'game' });
  });
  // Decorative art (aria-hidden="true": an in-game mock, an icon) isn't copy: the strings it
  // pictures are checked where they live. Blank each such element with everything inside it.
  cut(/<([a-z][a-z0-9]*)\b[^>]*\baria-hidden="true"[^>]*>/gi);
  const SR = /\bclass="[^"]*\bsr-only\b[^"]*"/;
  const spans = html => [...html.matchAll(/<span\b([^>]*)>([\s\S]*?)<\/span>/gi)].map(x => ({ attrs: x[1], html: x[0], text: clean(x[2]) })).filter(x => x.text);
  // The page's own title, and the words a search result or a shared link shows.
  let m;
  const title = /<title>([\s\S]*?)<\/title>/i.exec(body);
  if (title && clean(title[1])) out.push({ file, line: lineAt(title.index), kind: 'heading', text: clean(title[1]) });
  const meta = /<meta\b[^>]*\b(?:name|property)="(description|og:title|og:description|twitter:title|twitter:description)"[^>]*\bcontent="([^"]*)"[^>]*>/gi;
  while ((m = meta.exec(body))) if (m[2].trim()) out.push({ file, line: lineAt(m.index), kind: /title/.test(m[1]) ? 'heading' : 'text', text: clean(m[2]) });
  body = body.replace(/<title>[\s\S]*?<\/title>/gi, blank).replace(/<meta\b[^>]*>/gi, blank);
  const re = /<(h[1-6]|button|a|p|li|dt|dd|figcaption|summary|label|th|td|span|small|strong|em|text|tspan|blockquote|cite)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  while ((m = re.exec(body))) {
    const tag = m[1].toLowerCase();
    let inner = m[3];
    // data-kind="label" (or another kind) says what a styled element is, where its tag can't.
    const said = /\bdata-kind="([a-z]+)"/.exec(m[2]);
    const kind = said ? said[1] : /^h\d$/.test(tag) ? 'heading' : tag === 'button' || tag === 'a' ? 'label' : tag === 'blockquote' || tag === 'cite' ? 'quote' : 'text';
    const line = lineAt(m.index);
    // A link inside a sentence: its words alone have to say where it goes (WCAG 2.4.4).
    if (kind !== 'label') for (const a of inner.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)) if (clean(a[1])) out.push({ file, line, kind: 'link', text: clean(a[1]) });
    const parts = spans(inner);
    if (kind === 'heading') {
      // A badge in a heading ("macOS <span class="yours">Your system</span>") is its own text.
      for (const sp of parts) if (/\bclass="/.test(sp.attrs) && !SR.test(sp.attrs)) { out.push({ file, line, kind: 'text', text: sp.text }); inner = inner.replace(sp.html, ' '); }
    } else if (kind === 'label') {
      // A button's label and its sub-line ("Download for macOS" / "Free · macOS 14 or later").
      const shown = parts.filter(sp => !SR.test(sp.attrs));
      if (shown.length >= 2) {
        out.push({ file, line, kind: 'label', text: shown[0].text });
        for (const sp of shown.slice(1)) out.push({ file, line, kind: 'text', text: sp.text });
        continue;
      }
    }
    const text = clean(inner);
    if (!text) continue;
    out.push({ file, line, kind, text });
  }
  const attr = /\b(alt|aria-label|title|placeholder)="([^"]*)"/gi;
  while ((m = attr.exec(body))) if (m[2].trim()) out.push({ file, line: lineAt(m.index), kind: m[1].toLowerCase() === 'alt' ? 'alt' : 'text', text: clean(m[2]) });
  return out;
}
