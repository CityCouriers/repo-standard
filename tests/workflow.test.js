'use strict';
// AC-6 (polityka workflow) i struktura jobów AC-5 (secret-scan z kontrolą ujemną).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { workflowFindings } = require('./workflow-policy');
const { REPO_ROOT } = require('./helpers');

const WORKFLOWS = path.join(REPO_ROOT, '.github', 'workflows');
const files = fs.readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name));

const GOOD = `name: x
on: push
permissions: {}
jobs:
  a:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: ./local-action
      - run: echo ok
`;

test('wszystkie workflow w repozytorium spełniają politykę', () => {
  assert.ok(files.length > 0);
  for (const name of files) {
    assert.deepEqual(workflowFindings(fs.readFileSync(path.join(WORKFLOWS, name), 'utf8')), [], name);
  }
});

test('polityka: poprawny plik jest zielony', () => {
  assert.deepEqual(workflowFindings(GOOD), []);
});

test('polityka: czerwona na akcji z @v4', () => {
  const findings = workflowFindings(GOOD.replace(/@[0-9a-f]{40} # v7\.0\.1/, '@v4'));
  assert.match(findings.join('\n'), /bez pełnego SHA/);
});

test('polityka: czerwona na pełnym SHA bez komentarza wersji', () => {
  const findings = workflowFindings(GOOD.replace(' # v7.0.1', ''));
  assert.match(findings.join('\n'), /komentarza z wersją/);
});

test('polityka: czerwona na zapisie na poziomie workflow i na braku permissions', () => {
  assert.match(workflowFindings(GOOD.replace('permissions: {}', 'permissions:\n  contents: write')).join('\n'), /permissions na poziomie workflow/);
  assert.match(workflowFindings(GOOD.replace('permissions: {}\n', '')).join('\n'), /brak jednego bloku permissions/);
});

test('polityka: czerwona na self-hosted, wyrażeniu i etykiecie ruchomej', () => {
  for (const runner of ['self-hosted', '[self-hosted, linux]', '${{ matrix.os }}', 'ubuntu-latest']) {
    assert.match(workflowFindings(GOOD.replace('ubuntu-24.04', runner)).join('\n'), /runs-on/, runner);
  }
});

test('ci.yml: joby tests, privacy i secret-scan, gitleaks z sumą i kontrola ujemna', () => {
  const text = fs.readFileSync(path.join(WORKFLOWS, 'ci.yml'), 'utf8');
  for (const job of ['tests', 'privacy', 'secret-scan']) assert.match(text, new RegExp(`^  ${job}:`, 'm'), job);
  assert.match(text, /GITLEAKS_SHA256: "[0-9a-f]{64}"/);
  assert.match(text, /sha256sum -c -/);
  assert.match(text, /Kontrola ujemna/);
  assert.match(text, /node --test "tests\/\*\.test\.js"/);
  assert.match(text, /standard_sync\.js check --self/);
  assert.match(text, /fetch-depth: 0/);
});
