#!/usr/bin/env node
/**
 * am-i-compromised
 *
 * Usage:
 *   node check.js <csv-file> [package-lock.json] [package.json]
 *
 * Defaults:
 *   package-lock.json → ./package-lock.json
 *   package.json      → ./package.json
 *
 * CSV columns expected (header row required):
 *   ecosystem, namespace, name, version, artifact, published, detected
 *   (artifact column is ignored)
 *
 * Matching logic:
 *   full package name = namespace ? `${namespace}/${name}` : name
 *   (namespace starting with @ is kept as-is, otherwise @ is NOT added)
 *   version must be an exact match against the resolved version in the lockfile.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── CLI args ─────────────────────────────────────────────────────────────────

const [, , csvPath, lockPath = 'package-lock.json', pkgPath = 'package.json'] = process.argv;

if (!csvPath) {
  console.error('Usage: node check.js <csv-file> [package-lock.json] [package.json]');
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readJson(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) return null;
  try {
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    console.error(`Failed to parse ${abs}: ${e.message}`);
    process.exit(1);
  }
}

/**
 * Very simple CSV parser that handles quoted fields with embedded commas/newlines.
 * Returns an array of objects keyed by the header row.
 */
function parseCsv(text) {
  const rows = [];
  let field = '';
  let inQuotes = false;
  const cells = [];
  let headers = null;

  const pushField = () => { cells.push(field.trim()); field = ''; };
  const pushRow = () => {
    if (cells.length === 0 || (cells.length === 1 && cells[0] === '')) return;
    if (!headers) {
      headers = cells.map(h => h.toLowerCase().replace(/^"|"$/g, ''));
    } else {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = (cells[i] || '').replace(/^"|"$/g, ''); });
      rows.push(obj);
    }
    cells.length = 0;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { field += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { pushField(); }
      else if (ch === '\r') { /* skip */ }
      else if (ch === '\n') { pushField(); pushRow(); }
      else { field += ch; }
    }
  }
  // trailing row without newline
  if (field || cells.length) { pushField(); pushRow(); }

  return rows;
}

/**
 * Build a Map of { "name@version" → resolvedVersion } from a lockfile.
 * Supports lockfileVersion 1, 2, and 3.
 * Returns Map<packageName, Set<resolvedVersion>>
 */
function extractLockfilePackages(lock) {
  /** @type {Map<string, Set<string>>} */
  const installed = new Map();

  const add = (name, version) => {
    if (!name || !version) return;
    if (!installed.has(name)) installed.set(name, new Set());
    installed.get(name).add(version);
  };

  // lockfileVersion 2 / 3 — `packages` field
  if (lock.packages) {
    for (const [pkgPath, meta] of Object.entries(lock.packages)) {
      if (!meta || !meta.version) continue;
      // pkgPath is like "node_modules/foo" or "node_modules/@scope/bar"
      // or "node_modules/a/node_modules/b" (nested)
      const name = pkgPath.replace(/^(.*node_modules\/)/, '');
      add(name, meta.version);
    }
  }

  // lockfileVersion 1 — `dependencies` field (also present in v2 for back-compat)
  const walkDeps = (deps) => {
    if (!deps) return;
    for (const [name, meta] of Object.entries(deps)) {
      add(name, meta.version);
      if (meta.dependencies) walkDeps(meta.dependencies);
    }
  };
  walkDeps(lock.dependencies);

  return installed;
}

/**
 * Build a Map<packageName, Set<version>> from package.json dependencies
 * (all dependency kinds). Versions here are ranges, not resolved versions,
 * so we report them separately as "declared range" matches.
 */
function extractPkgJsonPackages(pkg) {
  /** @type {Map<string, Set<string>>} */
  const declared = new Map();
  const add = (name, range) => {
    if (!name || !range) return;
    if (!declared.has(name)) declared.set(name, new Set());
    declared.get(name).add(range);
  };
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, range] of Object.entries(pkg[key] || {})) {
      add(name, range);
    }
  }
  return declared;
}

/**
 * Derive the full npm package name from CSV row.
 * namespace examples: "@babel", "", "null", "@types"
 * name examples: "core", "lodash"
 */
function fullPackageName(namespace, name) {
  const ns = (namespace || '').trim();
  const n = (name || '').trim();
  if (!ns || ns.toLowerCase() === 'null' || ns.toLowerCase() === 'n/a') return n;
  // if namespace already starts with @, use namespace/name directly
  if (ns.startsWith('@')) return `${ns}/${n}`;
  // otherwise treat as a plain prefix (uncommon but possible)
  return `${ns}/${n}`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const csvText = (() => {
  const abs = path.resolve(csvPath);
  if (!fs.existsSync(abs)) { console.error(`CSV not found: ${abs}`); process.exit(1); }
  return fs.readFileSync(abs, 'utf8');
})();

const lock = readJson(lockPath);
const pkg = readJson(pkgPath);

if (!lock && !pkg) {
  console.error(`Neither ${lockPath} nor ${pkgPath} could be read. Provide at least one.`);
  process.exit(1);
}

const csvRows = parseCsv(csvText);
if (!csvRows.length) { console.log('CSV is empty or could not be parsed.'); process.exit(0); }

const lockPackages = lock ? extractLockfilePackages(lock) : new Map();
const pkgPackages = pkg ? extractPkgJsonPackages(pkg) : new Map();

// Filter to npm / node ecosystem rows (case-insensitive); warn about others.
const npmRows = csvRows.filter(r => {
  const eco = (r.ecosystem || '').toLowerCase();
  return eco === 'npm' || eco === 'node' || eco === '';
});
const skipped = csvRows.length - npmRows.length;
if (skipped > 0) {
  const others = [...new Set(csvRows.filter(r => {
    const eco = (r.ecosystem || '').toLowerCase();
    return eco !== 'npm' && eco !== 'node' && eco !== '';
  }).map(r => r.ecosystem))];
  console.warn(`Skipping ${skipped} non-npm row(s) (ecosystems: ${others.join(', ')})\n`);
}

// ── Compare ───────────────────────────────────────────────────────────────────

const matches = [];
const noMatches = [];

for (const row of npmRows) {
  const fullName = fullPackageName(row.namespace, row.name);
  const csvVersion = (row.version || '').trim();

  const lockVersions = lockPackages.get(fullName);
  const pkgRanges = pkgPackages.get(fullName);

  const lockMatch = lockVersions && lockVersions.has(csvVersion);
  const pkgMatch = pkgRanges && pkgRanges.has(csvVersion);  // exact range string match

  if (lockMatch || pkgMatch) {
    matches.push({ fullName, csvVersion, lockMatch, pkgMatch, row });
  } else {
    noMatches.push({ fullName, csvVersion, lockVersions, pkgRanges });
  }
}

// ── Output ────────────────────────────────────────────────────────────────────

console.log('='.repeat(60));
console.log(`  am-i-compromised`);
console.log(`  CSV:  ${path.resolve(csvPath)}`);
if (lock) console.log(`  Lock: ${path.resolve(lockPath)}  (lockfileVersion ${lock.lockfileVersion ?? '?'})`);
if (pkg) console.log(`  Pkg:  ${path.resolve(pkgPath)}`);
console.log('='.repeat(60));
console.log();

if (matches.length === 0) {
  console.log('✓  No matches found — none of the flagged package versions appear to be installed.\n');
} else {
  console.log(`⚠  ${matches.length} MATCH(ES) FOUND:\n`);
  for (const { fullName, csvVersion, lockMatch, pkgMatch, row } of matches) {
    const sources = [lockMatch && 'lockfile', pkgMatch && 'package.json'].filter(Boolean).join(' + ');
    console.log(`  PACKAGE : ${fullName}@${csvVersion}`);
    if (row.published) console.log(`  Published: ${row.published}`);
    if (row.detected) console.log(`  Detected : ${row.detected}`);
    console.log(`  Found in : ${sources}`);
    console.log();
  }
}

if (noMatches.length > 0) {
  console.log('-'.repeat(60));
  console.log(`  ${noMatches.length} flagged package(s) NOT found in this project:\n`);
  for (const { fullName, csvVersion, lockVersions } of noMatches) {
    const installed = lockVersions ? `  (installed: ${[...lockVersions].join(', ')})` : '';
    console.log(`  ${fullName}@${csvVersion}${installed}`);
  }
  console.log();
}

console.log('='.repeat(60));
console.log(`  Summary: ${matches.length} match(es) / ${npmRows.length} checked`);
console.log('='.repeat(60));
process.exit(matches.length > 0 ? 1 : 0);
