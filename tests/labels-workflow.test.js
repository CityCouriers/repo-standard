'use strict';
// AC-6: kontrakt workflow `labels-sync.yml`: czyta prawdziwy plik, zielony na nim i czerwony na wariantach.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { workflowFindings } = require('./workflow-policy');
const { REPO_ROOT } = require('./helpers');

const FILE = path.join(REPO_ROOT, '.github', 'workflows', 'labels-sync.yml');
const REAL = fs.readFileSync(FILE, 'utf8');

/** Joby jako mapa nazwa -> linie bloku (rozbiór wiersz po wierszu, bez wyrażeń z nawrotami). */
function jobsOf(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line === 'jobs:');
  const jobs = {};
  let current = null;
  for (const line of lines.slice(start + 1)) {
    const header = /^ {2}([a-z][a-z-]*):\s*$/.exec(line);
    if (header) { current = header[1]; jobs[current] = []; } else if (current) jobs[current].push(line);
  }
  return jobs;
}

const field = (lines, key) => lines.map((line) => new RegExp(`^ {4}${key}:\\s*(.*)$`).exec(line)).find(Boolean)?.[1];
const permissionsOf = (lines) => {
  const at = lines.findIndex((line) => line === '    permissions:');
  const out = {};
  for (const line of lines.slice(at + 1)) {
    const entry = /^ {6}([a-z-]+):\s*(\w+)/.exec(line);
    if (!entry) break;
    out[entry[1]] = entry[2];
  }
  return out;
};

/** Naruszenia kontraktu specyficznego dla etykiet (polityka ogólna: `workflowFindings`). */
function labelsFindings(text) {
  const findings = [...workflowFindings(text)];
  const onBlock = text.slice(text.indexOf('\non:'), text.indexOf('\npermissions:'));
  if (/pull_request_target/.test(onBlock)) findings.push('pull_request_target jest zabronione');
  if (!/dry_run:\n(?: {8}.*\n)*? {8}default: true\n/.test(onBlock)) findings.push('dry_run musi mieć domyślnie true');
  const jobs = jobsOf(text);
  if (Object.keys(jobs).sort().join() !== 'check,plan,sync') findings.push(`joby: ${Object.keys(jobs).join()}`);
  const { check, plan, sync } = jobs;
  if (!check || !plan || !sync) return findings;
  if (!/refs\/heads\/main/.test(field(sync, 'if') || '')) findings.push('job sync musi być ograniczony do refs/heads/main');
  if (/pull_request/.test(field(sync, 'if') || '')) findings.push('job sync nie może biec na pull_request');
  if (!/workflow_dispatch/.test(field(plan, 'if') || '')) findings.push('job plan tylko ręcznie');
  if (field(check, 'if') !== "github.event_name == 'pull_request'") findings.push('job check tylko na pull_request');
  if (permissionsOf(sync).issues !== 'write') findings.push('sync wymaga issues: write');
  if (permissionsOf(plan).issues !== 'read') findings.push('plan ma mieć issues: read');
  if ('issues' in permissionsOf(check)) findings.push('check nie ma uprawnień do zgłoszeń');
  for (const [name, lines] of Object.entries(jobs)) {
    if (permissionsOf(lines).contents !== 'read') findings.push(`${name}: contents: read`);
    if (Object.keys(permissionsOf(lines)).some((key) => !['contents', 'issues'].includes(key))) findings.push(`${name}: dodatkowe uprawnienia`);
  }
  if (jobs.check.some((line) => /GH_TOKEN/.test(line))) findings.push('check nie dostaje tokenu');
  const runs = (lines) => lines.filter((line) => /^\s+run:/.test(line)).map((line) => line.replace(/^\s+run:\s*/, ''));
  if (runs(check).join() !== 'node .github/standard/labels/labels_sync.js check') findings.push('check uruchamia tylko `check`');
  if (runs(plan).join() !== 'node .github/standard/labels/labels_sync.js sync --dry-run') findings.push('plan uruchamia tylko `sync --dry-run`');
  if (runs(sync).join() !== 'node .github/standard/labels/labels_sync.js sync') findings.push('sync uruchamia `sync` bez flag');
  text.split('\n').forEach((line, index) => {
    if (!line.includes('${{')) return;
    const allowed = /^\s*GH_TOKEN: \$\{\{ github\.token \}\}$/.test(line) || /^\s*if:/.test(line);
    if (!allowed) findings.push(`wiersz ${index + 1}: wyrażenie \${{ }} poza env/if`);
  });
  for (const [name, lines] of Object.entries(jobs)) {
    if (/^\s*run:.*\$\{\{/m.test(lines.join('\n'))) findings.push(`${name}: interpolacja w run`);
  }
  if (!/concurrency:\n {6}group: labels-sync\n {6}cancel-in-progress: false/.test(plan.join('\n'))) findings.push('plan: współbieżność bez anulowania');
  if (!/concurrency:\n {6}group: labels-sync\n {6}cancel-in-progress: false/.test(sync.join('\n'))) findings.push('sync: współbieżność bez anulowania');
  return findings;
}

const expectRed = (variant, pattern) => assert.match(labelsFindings(variant).join('\n'), pattern);

test('prawdziwy workflow spełnia kontrakt etykiet i politykę ogólną (GREEN)', () => {
  assert.deepEqual(labelsFindings(REAL), []);
});

test('każde wyrażenie z kontekstem leży w env albo w warunku, a persist-credentials jest wyłączone w każdym checkoucie', () => {
  const checkouts = REAL.match(/uses: actions\/checkout@/g).length;
  assert.equal(checkouts, 3);
  assert.equal(REAL.match(/persist-credentials: false/g).length, checkouts);
  assert.equal(REAL.match(/node-version: 22/g).length, 3);
});

test('wariant: akcja z tagiem zamiast SHA, ubuntu-latest, uprawnienia workflow', () => {
  expectRed(REAL.replace(/checkout@[0-9a-f]{40} # v7\.0\.1/, 'checkout@v4'), /bez pełnego SHA/);
  expectRed(REAL.replaceAll('ubuntu-24.04', 'ubuntu-latest'), /runs-on/);
  expectRed(REAL.replace('permissions: {}\n', 'permissions:\n  contents: write\n'), /permissions na poziomie workflow/);
});

test('wariant: pull_request_target, dry_run domyślnie false', () => {
  expectRed(REAL.replace('  pull_request:\n', '  pull_request_target:\n'), /pull_request_target/);
  expectRed(REAL.replace('default: true', 'default: false'), /dry_run musi mieć domyślnie true/);
});

test('wariant: zapis z gałęzi innej niż main, zapis na pull_request', () => {
  expectRed(REAL.replace("github.ref == 'refs/heads/main' && (github.event_name == 'push'", "(github.event_name == 'push'"), /ograniczony do refs\/heads\/main/);
  expectRed(REAL.replace("github.ref == 'refs/heads/main' && (github.event_name == 'push'", "github.ref == 'refs/heads/main' && (github.event_name == 'pull_request' || github.event_name == 'push'"), /nie może biec na pull_request/);
});

test('wariant: uprawnienia jobów', () => {
  expectRed(REAL.replace('issues: read  # odczyt etykiet', 'issues: write  # odczyt etykiet'), /plan ma mieć issues: read/);
  expectRed(REAL.replace('      issues: write  # tworzenie', '      issues: read  # tworzenie'), /sync wymaga issues: write/);
  expectRed(REAL.replace('      contents: read  # odczyt manifestu etykiet; bez tokenu zapisu', '      contents: read\n      issues: write'), /check nie ma uprawnień do zgłoszeń/);
  expectRed(REAL.replace('      issues: write  # tworzenie', '      pull-requests: write\n      issues: write  # tworzenie'), /sync: dodatkowe uprawnienia/);
});

test('wariant: interpolacja kontekstu w run i token w jobie check', () => {
  expectRed(REAL.replace('run: node .github/standard/labels/labels_sync.js check', 'run: node .github/standard/labels/labels_sync.js check ${{ github.event.pull_request.title }}'), /interpolacja w run/);
  expectRed(REAL.replace('    steps:\n      - name: Checkout\n        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false\n\n      - name: Node\n        uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0\n        with:\n          node-version: 22\n\n      - name: Kontrola', '    env:\n      GH_TOKEN: ${{ github.token }}\n    steps:\n      - name: Checkout\n        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false\n\n      - name: Node\n        uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0\n        with:\n          node-version: 22\n\n      - name: Kontrola'), /check nie dostaje tokenu/);
});

test('wariant: polecenia jobów i współbieżność', () => {
  expectRed(REAL.replace('labels_sync.js sync\n', 'labels_sync.js sync --force\n'), /sync uruchamia `sync` bez flag/);
  expectRed(REAL.replace('sync --dry-run', 'sync'), /plan uruchamia tylko/);
  expectRed(REAL.replaceAll('cancel-in-progress: false', 'cancel-in-progress: true'), /współbieżność bez anulowania/);
});
