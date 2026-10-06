'use strict';
// The private terms for the tests that prove a private word never reaches a player (security
// review SR-02). Those words are the owner's own (names, hostnames, paths): no test writes them,
// and these files go out with the public tree. A test reads them at run time from the private
// terms file SCRUB_TERMS names (tools/scrub-terms.example.txt shows the format), through the scrub
// scanner's own patterns, and skips its check when SCRUB_TERMS isn't set, saying so. A failure
// shows the text with each term masked ("[name]"), never the term.
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PRIVATE_TERMS = process.env.SCRUB_TERMS || null;
const PRIVATE_SKIP = PRIVATE_TERMS ? false : 'SCRUB_TERMS is not set, so the private terms aren\'t checked here (set SCRUB_TERMS=<the private terms file> to run it)';

/**
 * The terms in SCRUB_TERMS, as the scanner reads them (each term and its joined twin):
 * hits(texts) → each text that carries one, masked, with the patterns it hit ([] when none does).
 */
async function privateTerms(file = PRIVATE_TERMS) {
  if (!file) throw new Error(PRIVATE_SKIP);
  const scan = await import(pathToFileURL(path.join(__dirname, '..', '..', 'tools', 'scrub-scan.mjs')).href);
  const { patterns } = scan.loadTerms({ file });
  // A line is shown decoded (as the scanner reads one with escapes), so an escaped term is masked too.
  const masked = text => text.split(/\r?\n/).map(l => scan.maskText(scan.decodeLine(l) ?? l, patterns)).join('\n');
  const hits = texts => texts.map(String).flatMap(text => {
    const found = scan.scanText(text, { patterns });
    return found.length ? [`${[...new Set(found.map(h => h.pattern))].join(', ')}: ${masked(text)}`] : [];
  });
  return { patterns, hits };
}

module.exports = { PRIVATE_TERMS, PRIVATE_SKIP, privateTerms };
