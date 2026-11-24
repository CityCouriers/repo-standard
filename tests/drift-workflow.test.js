'use strict';
// Kontrola struktury workflow `standard-drift.yml`: wyzwalacze, uprawnienia per job, brak wykonania kodu z PR,
// wartości zdarzeń tylko przez `env`. Rozbiór tekstowy bez zależności (polityka SHA i runnerów: workflow.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');

const TEXT = fs.readFileSync(path.join(h.REPO_ROOT, '.github', 'workflows', 'standard-drift.yml'), 'utf8');
const LINES = TEXT.split('\n');
const code = LINES.filter((line) => !/^\s*#/.test(line));

/** Bloki jobów: nazwa klucza -> linie bloku (do następnego klucza joba na tym samym wcięciu). */
function jobs() {
  const start = LINES.findIndex((line) => line === 'jobs:');
  const result = {};
  let name = null;
  for (const line of LINES.slice(start + 1)) {
    const key = /^  ([a-z-]+):\s*$/.exec(line);
    if (key) { name = key[1]; result[name] = []; } else if (name) result[name].push(line);
  }
  return result;
}

const permissionsOf = (block) => {
  const from = block.findIndex((line) => /^    permissions:\s*$/.test(line));
  const out = {};
  for (const line of block.slice(from + 1)) {
    const entry = /^      ([a-z-]+): ([a-z]+)/.exec(line);
    if (!entry) break;
    out[entry[1]] = entry[2];
  }
  return out;
};

test('wyzwalacze: harmonogram w sobotę, ręcznie, push na main, pull_request_target bez filtra ścieżek', () => {
  const on = TEXT.slice(TEXT.indexOf('\non:'), TEXT.indexOf('\npermissions:'));
  assert.match(on, /schedule:\n    - cron: '\d+ \d+ \* \* 6'/);
  assert.match(on, /\n  workflow_dispatch:\n/);
  assert.match(on, /\n  push:\n    branches: \[main\]\n/);
  assert.match(on, /\n  pull_request_target:\n    types: \[opened, synchronize, reopened, edited\][^\n]*\n\n?(?!    )/);
  assert.ok(!/paths:|paths-ignore:|branches-ignore:/.test(on.replace(/push:\n    branches: \[main\]/, '')));
  assert.ok(!/\n  pull_request:/.test(on));
});

test('uprawnienia: poziom workflow {}, status write tylko w drift-pr i drift-push, issues write tylko w drift-issue', () => {
  assert.equal(code.filter((line) => /^permissions:/.test(line)).length, 1);
  assert.ok(code.includes('permissions: {}'));
  const all = jobs();
  assert.deepEqual(Object.keys(all), ['drift-pr', 'drift-push', 'drift-check', 'drift-issue']);
  const perms = Object.fromEntries(Object.entries(all).map(([name, block]) => [name, permissionsOf(block)]));
  assert.deepEqual(perms['drift-pr'], { contents: 'read', issues: 'read', 'pull-requests': 'read', statuses: 'write' });
  assert.deepEqual(perms['drift-push'], { contents: 'read', issues: 'read', 'pull-requests': 'read', statuses: 'write' });
  assert.deepEqual(perms['drift-check'], { contents: 'read', issues: 'read' });
  assert.deepEqual(perms['drift-issue'], { contents: 'read', issues: 'write' });
  const writes = Object.entries(perms).flatMap(([name, p]) => Object.entries(p).filter(([, v]) => v === 'write').map(([k]) => `${name}:${k}`));
  assert.deepEqual(writes, ['drift-pr:statuses', 'drift-push:statuses', 'drift-issue:issues']);
});

test('każdy job ma warunek zdarzenia i uruchamia dokładnie jedną komendę skryptu kontroli', () => {
  const expected = {
    'drift-pr': [/if: github\.event_name == 'pull_request_target' && \(github\.event\.action != 'edited' \|\| github\.event\.changes\.base != null\)/,'drift_run.js pr'],
    'drift-push': [/if: github\.event_name == 'push'/, 'drift_run.js push'],
    'drift-check': [/if: github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'/, 'drift_run.js check'],
    'drift-issue': [/if: github\.event_name == 'schedule'/, 'drift_run.js issue'],
  };
  for (const [name, block] of Object.entries(jobs())) {
    const text = block.join('\n');
    assert.match(text, expected[name][0], name);
    const runs = block.filter((line) => /^\s+run:/.test(line));
    assert.deepEqual(runs, [`        run: node .github/standard/drift/${expected[name][1]}`], name);
  }
});

test('HEAD PR nie jest wykonywany: checkout bez ref i repository, brak odwołań do head PR, brak sekretów', () => {
  const text = code.join('\n');
  assert.ok(!/^\s+ref:/m.test(text));
  assert.ok(!/^\s+repository:/m.test(text));
  assert.ok(!/pull_request\.head|head_ref|head\.sha|head\.ref/.test(text));
  assert.ok(!/secrets\./.test(text));
  assert.ok(!/allow-unsafe-pr-checkout/.test(text));
  assert.equal(code.filter((line) => /uses: actions\/checkout@/.test(line)).length, 4);
  assert.equal(code.filter((line) => /persist-credentials: false/.test(line)).length, 4);
});

test('wartości zdarzeń tylko przez env albo grupę współbieżności; run: bez interpolacji', () => {
  for (const line of code) {
    if (/^\s+run:/.test(line)) assert.ok(!/\$\{\{/.test(line), line);
  }
  const interpolated = code.filter((line) => /\$\{\{/.test(line));
  for (const line of interpolated) {
    assert.ok(/^\s+(GH_TOKEN|GITHUB_TOKEN|PR_NUMBER): \$\{\{ (github\.token|github\.event\.pull_request\.number) \}\}$/.test(line)
      || /^  group: standard-drift-\$\{\{ github\.event_name \}\}-\$\{\{ github\.event\.pull_request\.number \|\| 'none' \}\}$/.test(line), line);
  }
  assert.equal(code.filter((line) => /PR_NUMBER:/.test(line)).length, 1);
});

test('nazwy jobów różnią się od kontekstu statusu, współbieżność nie anuluje biegów', () => {
  for (const line of code.filter((entry) => /^    name:/.test(entry))) assert.ok(!/name: standard-drift\s*$/.test(line), line);
  assert.match(TEXT, /concurrency:\n  group: [^\n]+\n  cancel-in-progress: false\n/);
  assert.ok(!/cancel-in-progress: true/.test(TEXT));
});

test('wpis w manifeście: workflow i cztery moduły jako exact i critical, bez odstępstwa', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(h.REPO_ROOT, 'manifest.json'), 'utf8'));
  for (const file of ['.github/workflows/standard-drift.yml', '.github/standard/drift/commit_status.js', '.github/standard/drift/drift_api.js', '.github/standard/drift/drift_core.js', '.github/standard/drift/drift_run.js']) {
    const entry = manifest.files.find((candidate) => candidate.path === file);
    assert.ok(entry, file);
    assert.equal(entry.kind, 'exact');
    assert.equal(entry.critical, true);
    assert.notEqual(entry.overridable, true);
  }
});
