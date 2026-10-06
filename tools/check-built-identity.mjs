#!/usr/bin/env node
// What electron-builder builds the app with, against the app's identity (open-shell lane 2a, for 1.4.5):
// the app id, product name and NSIS guid it takes are the ones in plugins/<plugin>/identity.json
// (bridge/identity.mjs reads it, and frozen_names_test holds NeverQuestAlone's to the names 1.4.4 shipped
// with), so what's built equals identity.json, which equals 1.4.4.
//
//   node tools/check-built-identity.mjs <electron-builder project folder | builder-effective-config.yaml>
//
// A folder (release.yml's Windows job runs this on the app's right after its build): electron-builder's
// config for it, read with electron-builder's own loader (app-builder-lib's getConfig, which its build
// reads the config with), and the effective config the build wrote in its directories.output, when there
// is one. A file: that effective config. electron-builder writes builder-effective-config.yaml only off
// CI and on a terminal (app-builder-lib's packager.js), so a CI build has none: there the loader is the
// record. YAML is read with electron-builder's own parser (js-yaml). Nothing is installed for this.
//
// One line for each name missing or different. exit: 0 all three match · 1 one doesn't · 2 usage
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readIdentity, ROOT } from '../bridge/identity.mjs';

/** The three names: where each is in electron-builder's config, and in the identity. */
export const BUILT = Object.freeze([
  ['appId', c => c?.appId, id => id.appId],
  ['productName', c => c?.productName, id => id.productName],
  ['nsis.guid', c => c?.nsis?.guid, id => id.nsisGuid],
]);

/** A line for each name the config lacks or holds differently from the identity; none when all three match. */
export function builtIdentityProblems(config, identity) {
  const out = [];
  for (const [field, built, own] of BUILT) {
    const value = built(config);
    if (value === undefined || value === null || value === '') out.push(`${field} is missing`);
    else if (String(value) !== own(identity)) out.push(`${field} is ${JSON.stringify(String(value))}, not the identity's ${JSON.stringify(own(identity))}`);
  }
  return out;
}

// electron-builder's own modules, from the app's dependencies (app/desktop's npm ci).
const desktop = createRequire(path.join(ROOT, 'app', 'desktop', 'package.json'));

/** An effective config electron-builder wrote (builder-effective-config.yaml). */
export function readEffectiveConfig(file) {
  return desktop('js-yaml').load(fs.readFileSync(file, 'utf8'));
}

/** electron-builder's config for a project folder, read as its build reads it. */
export function loadBuilderConfig(projectDir) {
  const { getConfig } = desktop('app-builder-lib/out/util/config/config.js');
  return getConfig(projectDir, null, null);
}

async function main(argv) {
  if (argv.length !== 1) {
    process.stderr.write('usage: node tools/check-built-identity.mjs <electron-builder project folder | builder-effective-config.yaml>\n');
    return 2;
  }
  const target = path.resolve(argv[0]);
  const kind = fs.statSync(target, { throwIfNoEntry: false });
  if (!kind) {
    process.stderr.write(`check-built-identity: no such folder or file: ${argv[0]}\n`);
    return 2;
  }
  const records = [];
  if (kind.isDirectory()) {
    const config = await loadBuilderConfig(target);
    records.push(["electron-builder's config", config]);
    // Its output folder as the config names it (electron-builder's default is dist).
    const effective = path.join(target, config.directories?.output ?? 'dist', 'builder-effective-config.yaml');
    if (fs.existsSync(effective)) records.push([path.relative(process.cwd(), effective), readEffectiveConfig(effective)]);
  } else {
    records.push([argv[0], readEffectiveConfig(target)]);
  }
  const { identity } = readIdentity(ROOT);
  let bad = 0;
  for (const [where, config] of records) {
    for (const line of builtIdentityProblems(config, identity)) {
      bad += 1;
      process.stdout.write(`check-built-identity: ${where}: ${line}\n`);
    }
  }
  if (!bad) process.stdout.write(`check-built-identity: ${records.map(([where]) => where).join(' and ')}: the app id, product name and NSIS guid are the identity's\n`);
  return bad ? 1 : 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
