'use strict';
// AC-7 (zgodność z bramką audytu) i AC-8 (rozdział rdzeń/lokalne wobec `standard_sync.js`, B1 bez zmian).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sync = require('../.github/standard/standard_sync');
const params = require('../.github/standard/common/params');
const gate = require('../.github/standard/audit/issue-audit-gate');
const h = require('./helpers');
const { CORE_NAMES, readCore, readLocal, syntheticLocal, runMain, fakeClient } = require('./labels-fake');

const NOW = new Date('2026-11-11T10:00:00Z');
const GATE_SOURCE = fs.readFileSync(path.join(h.REPO_ROOT, '.github', 'standard', 'audit', 'issue-audit-gate.js'), 'utf8');
const constant = (name) => new RegExp(`const ${name} = '([^']+)';`).exec(GATE_SOURCE)[1];

test('AC-7: każda etykieta, której wymaga bramka audytu, jest w rdzeniu (nazwy czytane ze źródła bramki)', () => {
  const required = ['AUDIT_PENDING', 'AUDIT_OK', 'AUDIT_CHANGES', 'NEEDS_TRIAGE'].map(constant);
  assert.deepEqual(required.sort(), ['audit:changes', 'audit:ok', 'audit:pending', 'needs-triage']);
  for (const name of required) assert.ok(CORE_NAMES.includes(name), name);
  const core = readCore().labels.map((l) => l.name);
  for (const name of [...required, 'P0', 'P1', 'P2', 'P3', 'P4', 'T1', 'T2', 'T3', 'by:agent']) assert.ok(core.includes(name), name);
});

test('AC-7: kontrola etykiet bramki (preflight) przechodzi na stanie z manifestu i wskazuje brak etykiety area spoza pliku lokalnego', () => {
  const names = [...readCore().labels, ...readLocal().labels].map((l) => l.name);
  const cfg = { gateActiveSince: '2026-11-15T00:00:00Z', triageActiveSince: '2026-11-15T00:00:00Z', auditLabels: ['audit:pending', 'audit:ok', 'audit:changes'] };
  assert.deepEqual(gate.preflight(names, cfg, { missingLabels: ['P2', 'T2', 'area:process'] }), []);
  assert.deepEqual(gate.preflight(names, cfg, { missingLabels: ['area:nieistnieje'] }), ['area:nieistnieje']);
  const lacking = names.filter((n) => n !== 'needs-triage' && n !== 'audit:ok');
  assert.deepEqual(gate.preflight(lacking, cfg, { missingLabels: [] }), ['audit:ok', 'needs-triage']);
});

test('AC-7: etykiety wymagane przez bramkę są chronione przed usunięciem i zmianą nazwy', () => {
  for (const name of ['audit:pending', 'audit:ok', 'audit:changes', 'needs-triage', 'P0', 'T3']) {
    const client = fakeClient([]);
    assert.equal(runMain(['sync'], { client, env: { GITHUB_REPOSITORY: 'owner/repo' }, local: syntheticLocal({ migrations: { delete: [name] } }) }).code, 2, name);
    assert.deepEqual(client.calls, []);
  }
});

test('manifest wzorca wpisuje rdzeń, skrypt i workflow jako exact i critical, a pliku lokalnego nie wpisuje', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(h.REPO_ROOT, 'manifest.json'), 'utf8'));
  const byPath = Object.fromEntries(manifest.files.map((entry) => [entry.path, entry]));
  for (const file of ['.github/standard/labels/labels-core.json', '.github/standard/labels/labels_sync.js', '.github/workflows/labels-sync.yml']) {
    assert.equal(byPath[file].kind, 'exact', file);
    assert.equal(byPath[file].critical, true, file);
    assert.equal(byPath[file].sha256, h.sha256(fs.readFileSync(path.join(h.REPO_ROOT, file))), file);
  }
  assert.equal('.github/labels.json' in byPath, false);
  assert.ok(fs.existsSync(path.join(h.REPO_ROOT, '.github', 'labels.json')));
});

test('AC-8c: check --self przechodzi na prawdziwym repozytorium z plikiem lokalnym poza manifestem', async () => {
  const result = await h.run(['check', '--self', '--root', h.REPO_ROOT], { now: NOW });
  assert.equal(result.code, 0, result.out);
  assert.doesNotMatch(result.out, /labels\.json/);
});

// ---- AC-8a, AC-8b: apply i check konsumenta na lokalnym serwerze https

const SKIP = h.testCert() ? false : 'brak openssl (testy sieciowe pominięte)';
const SHA = h.fakeSha('labels-release');
const CORE_TEXT = fs.readFileSync(path.join(h.REPO_ROOT, '.github', 'standard', 'labels', 'labels-core.json'), 'utf8');
const SCRIPT_TEXT = fs.readFileSync(path.join(h.REPO_ROOT, '.github', 'standard', 'labels', 'labels_sync.js'), 'utf8');
const LOCAL_TEXT = '{\n  "lokalne": "treść konsumenta, której apply nie zna"\n}\n';

const releaseFiles = () => ({ '.github/standard/labels/labels-core.json': CORE_TEXT, '.github/standard/labels/labels_sync.js': SCRIPT_TEXT });

async function consumer(t) {
  const release = h.makeRelease(releaseFiles());
  const server = await h.startReleaseServer({ 'v1.0.0': { sha: SHA, release } });
  const root = h.tmpDir();
  t.after(async () => { await server.close(); h.rmDir(root); });
  h.writeFile(root, '.github/labels.json', LOCAL_TEXT);
  return { root, deps: { fetch: server.fetch, endpoints: server.endpoints, now: NOW } };
}

test('AC-8a: apply zostawia plik lokalny bajt w bajt, a rdzeń i skrypt zapisuje z wydania', { skip: SKIP }, async (t) => {
  const { root, deps } = await consumer(t);
  const result = await h.run(['apply', '--version', 'v1.0.0', '--root', root], deps);
  assert.equal(result.code, 0, result.out);
  assert.equal(h.readText(root, '.github/labels.json'), LOCAL_TEXT);
  assert.equal(h.readText(root, '.github/standard/labels/labels-core.json'), CORE_TEXT);
  assert.equal(h.readText(root, '.github/standard/labels/labels_sync.js'), SCRIPT_TEXT);
  const again = await h.run(['apply', '--version', 'v1.0.0', '--root', root], deps);
  assert.equal(again.code, 0, again.out);
  assert.equal(h.readText(root, '.github/labels.json'), LOCAL_TEXT, 'drugie apply też nie rusza pliku lokalnego');
});

test('AC-8b: zmieniony lokalnie rdzeń jest rozjazdem (kod 1), zmiana pliku lokalnego nie jest, a apply przywraca rdzeń', { skip: SKIP }, async (t) => {
  const { root, deps } = await consumer(t);
  assert.equal((await h.run(['apply', '--version', 'v1.0.0', '--root', root], deps)).code, 0);
  assert.equal((await h.run(['check', '--root', root], deps)).code, 0);

  h.writeFile(root, '.github/labels.json', `${LOCAL_TEXT}// zmiana lokalna\n`);
  const localChange = await h.run(['check', '--root', root], deps);
  assert.equal(localChange.code, 0, localChange.out);
  assert.equal(h.readText(root, '.github/labels.json'), `${LOCAL_TEXT}// zmiana lokalna\n`);

  h.writeFile(root, '.github/standard/labels/labels-core.json', CORE_TEXT.replace('"P0"', '"P9"'));
  const drift = await h.run(['check', '--root', root], deps);
  assert.equal(drift.code, 1, drift.out);
  assert.match(drift.out, /labels-core\.json/);
  assert.match(drift.out, /rozjazd/);

  assert.equal((await h.run(['apply', '--version', 'v1.0.0', '--root', root], deps)).code, 0);
  assert.equal(h.readText(root, '.github/standard/labels/labels-core.json'), CORE_TEXT);
  assert.equal(h.readText(root, '.github/labels.json'), `${LOCAL_TEXT}// zmiana lokalna\n`, 'plik lokalny przeżył przywrócenie rdzenia');
  const config = JSON.parse(h.readText(root, params.PARAMS_PATH));
  assert.deepEqual(config.standard, { version: 'v1.0.0', sha: SHA });
  assert.equal(typeof sync.main, 'function');
});

test('AC-8d: kontrakt pliku lokalnego waliduje skrypt etykiet: brak pliku i redefinicja nazwy rdzenia to kod 2', () => {
  assert.equal(runMain(['check'], { local: null }).code, 2);
  const redefining = syntheticLocal();
  redefining.labels.push({ name: 'P0', color: 'B60205', family: 'misc', description: 'Redefinicja.' });
  assert.equal(runMain(['check'], { local: redefining }).code, 2);
});
