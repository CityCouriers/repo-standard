#!/usr/bin/env node
'use strict';
// Przelicza sumy SHA-256 w `manifest.json` z plików repozytorium wzorca (narzędzie wydawcy, nie jest kopiowane).
//
// Wpisy (ścieżka, rodzaj, flagi `critical` i `overridable`, znaczniki) prowadzi człowiek w `manifest.json`;
// to narzędzie tylko odświeża pola `sha256` i, gdy podano `--version`, wersję wydania. Po odświeżeniu
// `node .github/standard/standard_sync.js check --self` musi być zielone.
//
// Użycie:
//   node scripts/build_manifest.js [--root .] [--version v1.0.0]

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const sync = require('../.github/standard/standard_sync');
const params = require('../.github/standard/common/params');

/** Kopia manifestu z sumami wyliczonymi z plików; brak pliku albo bloku to `SyncError`. */
function refreshed(manifest, root) {
  const files = manifest.files.map((original) => {
    const entry = { ...original };
    if (entry.kind === 'param') return entry;
    const origin = entry.source || entry.path;
    let data = sync.readPlainFile(root, origin);
    if (data === null) throw new sync.SyncError(`${origin}: brak pliku`);
    if (entry.kind === 'block') {
      const block = sync.blockOf(sync.textOf(data) ?? '', entry.block);
      if (block === null) throw new sync.SyncError(`${origin}: brak znaczników bloku '${entry.block}'`);
      data = Buffer.from(block, 'utf8');
    }
    entry.sha256 = sync.sha256(data);
    return entry;
  });
  return { ...manifest, files };
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: { root: { type: 'string', default: '.' }, version: { type: 'string' } }, strict: true });
  const root = path.resolve(values.root);
  const target = path.join(root, sync.MANIFEST_PATH);
  try {
    const manifest = sync.parseManifest(fs.readFileSync(target, 'utf8'));
    if (values.version !== undefined) {
      if (params.parseVersion(values.version) === null) throw new sync.SyncError(`wersja musi mieć postać v1.2.3: ${values.version}`);
      manifest.version = values.version;
    }
    const result = refreshed(manifest, root);
    fs.writeFileSync(target, sync.dumpJson(result));
    console.log(`manifest.json: ${result.files.length} plików, wersja ${result.version}`);
    return 0;
  } catch (error) {
    console.error(`build_manifest: ${error.message}`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { refreshed };
