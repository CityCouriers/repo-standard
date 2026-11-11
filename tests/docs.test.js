'use strict';
// AC-6a: dokumentacja nie odsyła do innej implementacji synchronizatora niż Node.js i zawiera rzeczywiste polecenia.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('./helpers');

const FORBIDDEN = [
  [/standard_sync\.py/, 'standard_sync.py'],
  [/\bpython3?\s+(-\S+\s+)*standard_sync/i, 'python standard_sync'],
  [/setup-python/, 'setup-python'],
  [/common\/params\.py/, 'common/params.py'],
  [/python3?\s+-m\s+unittest/i, 'python -m unittest'],
];

/** Odwołania do Pythonowej implementacji synchronizatora w podanym tekście. */
function pythonReferences(text) {
  return FORBIDDEN.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
}

function githubFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
    const full = path.join(dir, item.name);
    return item.isDirectory() ? githubFiles(full) : [full];
  });
}

const read = (relPath) => fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');

test('wykrywacz jest czerwony na README z poleceniem Pythona i zielony na README Node.js', () => {
  assert.deepEqual(pythonReferences('uruchom: python standard_sync.py apply --version v1.0.0'), ['standard_sync.py', 'python standard_sync']);
  assert.deepEqual(pythonReferences('uses: actions/setup-python@abc'), ['setup-python']);
  assert.deepEqual(pythonReferences('python -m unittest discover'), ['python -m unittest']);
  assert.deepEqual(pythonReferences('node .github/standard/standard_sync.js apply --version v1.0.0'), []);
});

test('README, THIRD_PARTY i .github nie odsyłają do Pythonowego synchronizatora', () => {
  const targets = ['README.md', 'THIRD_PARTY.md', ...githubFiles(path.join(REPO_ROOT, '.github')).map((file) => path.relative(REPO_ROOT, file))];
  assert.ok(targets.length >= 5);
  for (const target of targets) assert.deepEqual(pythonReferences(read(target)), [], target);
});

test('README zawiera rzeczywiste polecenia check, check --self, apply --version i uruchamianie testów', () => {
  const readme = read('README.md');
  assert.match(readme, /node \.github\/standard\/standard_sync\.js check \[--root \.\]/);
  assert.match(readme, /node \.github\/standard\/standard_sync\.js check --self/);
  assert.match(readme, /node \.github\/standard\/standard_sync\.js apply --version v1\.0\.0/);
  assert.match(readme, /node --test "tests\/\*\.test\.js"/);
  assert.match(readme, /CommonJS/);
  assert.match(readme, /bez zależności/);
});

test('THIRD_PARTY wymienia środowisko Node zgodnie z workflow', () => {
  const third = read('THIRD_PARTY.md');
  const workflow = read('.github/workflows/ci.yml');
  assert.match(workflow, /actions\/setup-node@/);
  assert.match(third, /actions\/setup-node/);
  assert.match(third, new RegExp(`wersja ${/GITLEAKS_VERSION: "([0-9.]+)"/.exec(workflow)[1].replace(/\./g, '\\.')} `));
});

test('pliki wskazane w README istnieją', () => {
  for (const file of ['.github/standard/standard_sync.js', '.github/standard/common/params.js', 'scripts/ci/privacy-scan.sh', '.github/workflows/ci.yml', 'manifest.json']) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, file)), file);
  }
});
