'use strict';
// AC-3, AC-4 (GREEN i RED w przebiegu), AC-5: przebieg `main` na atrapie klienta GitHub, bez sieci.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readCore, syntheticLocal, liveFor, fakeClient, runMain, CORE_NAMES } = require('./labels-fake');

const ENV = { GITHUB_REPOSITORY: 'owner/repo' };
const WRITES = /^(create|update|rename|delete):/;
const writeCalls = (client) => client.calls.filter((c) => WRITES.test(c));
const synced = (extra = []) => liveFor(readCore(), syntheticLocal(), extra);
const local = (migrations) => syntheticLocal({ migrations });

test('check: poprawny manifest, bez klienta i bez repozytorium', () => {
  const result = runMain(['check']);
  assert.equal(result.code, 0);
  assert.match(result.out, /Manifest etykiet: poprawny/);
  assert.match(result.out, /etykiety zarządzane: 17 \(rdzeń: 14\)/);
});

test('błędy walidacji: kod 2, lista błędów, klient nietknięty (także odczyt)', () => {
  const broken = syntheticLocal({ labels: [] });
  for (const command of ['check', 'diff', 'sync']) {
    const client = fakeClient([]);
    const result = runMain([command], { local: broken, client, env: ENV });
    assert.equal(result.code, 2, command);
    assert.match(result.out, /Manifest etykiet: błędy/);
    assert.match(result.out, /brak etykiety z prefiksem 'area:'/);
    assert.deepEqual(client.calls, [], 'zero wywołań klienta');
  }
});

test('brak pliku lokalnego albo rdzenia i zepsuty JSON: kod 2 z nazwą pliku', () => {
  const noLocal = runMain(['check'], { local: null });
  assert.equal(noLocal.code, 2);
  assert.match(noLocal.err, /brak pliku local\.json \(ENOENT\)/);
  const noCore = runMain(['check'], { core: null });
  assert.equal(noCore.code, 2);
  const bad = runMain(['check'], { files: { 'local.json': '{ nie json' } });
  assert.equal(bad.code, 2);
  assert.match(bad.err, /local\.json: nie jest poprawnym JSON/);
});

test('sync na pustym repozytorium: tworzy wszystko w kolejności, weryfikuje stan i kończy kodem 0', () => {
  const client = fakeClient([]);
  const result = runMain(['sync'], { client, env: ENV });
  assert.equal(result.code, 0, result.out);
  const created = writeCalls(client).map((c) => c.slice('create:'.length));
  assert.deepEqual(created, [...CORE_NAMES, 'area:one', 'area:two', 'extra']);
  assert.ok(writeCalls(client).every((c) => c.startsWith('create:')));
  assert.match(result.out, /- create P0: ok/);
  assert.match(result.out, /Stan etykiet po synchronizacji: zgodny z manifestem/);
  assert.equal(client.calls.filter((c) => c === 'list').length, 2, 'odczyt przed i po zapisie');
});

test('sync na stanie zgodnym: zero zapisów, także próby zapisu', () => {
  const client = fakeClient(synced());
  const result = runMain(['sync'], { client, env: ENV });
  assert.equal(result.code, 0);
  assert.deepEqual(writeCalls(client), []);
});

test('--dry-run: plan bez żadnego zapisu, kod 0, także gdy są zmiany', () => {
  const client = fakeClient([]);
  const result = runMain(['sync', '--dry-run'], { client, env: ENV });
  assert.equal(result.code, 0);
  assert.deepEqual(writeCalls(client), []);
  assert.match(result.out, /Plan synchronizacji owner\/repo/);
  assert.match(result.out, /Do utworzenia: P0, P1/);
});

test('diff: kod 0 bez --strict, kod 1 z --strict przy rozjeździe, 0 przy zgodności', () => {
  assert.equal(runMain(['diff'], { client: fakeClient([]), env: ENV }).code, 0);
  assert.equal(runMain(['diff', '--strict'], { client: fakeClient([]), env: ENV }).code, 1);
  const green = runMain(['diff', '--strict'], { client: fakeClient(synced()), env: ENV });
  assert.equal(green.code, 0);
  assert.match(green.out, /Stan etykiet w owner\/repo: zgodny z manifestem/);
  assert.match(runMain(['diff'], { client: fakeClient([]), env: ENV }).out, /różni się od manifestu/);
});

test('diff --live czyta stan z pliku zamiast z klienta', () => {
  const client = fakeClient([]);
  const result = runMain(['diff', '--strict', '--live', 'live.json'], { client, env: ENV, files: { 'live.json': JSON.stringify(synced()) } });
  assert.equal(result.code, 0);
  assert.deepEqual(client.calls, []);
});

test('repozytorium: --repo ma pierwszeństwo, brak repozytorium i niezgodność to kod 2', () => {
  assert.equal(runMain(['diff', '--repo', 'owner/repo'], { client: fakeClient(synced()) }).code, 0);
  const none = runMain(['diff'], { client: fakeClient(synced()) });
  assert.equal(none.code, 2);
  assert.match(none.err, /brak repozytorium/);
  const wrong = runMain(['diff'], { client: fakeClient(synced()), env: { GITHUB_REPOSITORY: 'owner/inne' } });
  assert.equal(wrong.code, 2);
  assert.match(wrong.out, /bieżące repozytorium to owner\/inne/);
  const flag = runMain(['diff', '--repo', 'owner/inne'], { client: fakeClient(synced()), env: ENV });
  assert.equal(flag.code, 2);
});

test('konflikt w stanie żywym: kod 1 i zero zapisów', () => {
  const client = fakeClient(synced([{ name: 'EXTRA', color: 'aaaaaa', description: 'Etykieta lokalna.' }]));
  const result = runMain(['sync'], { client, env: ENV });
  assert.equal(result.code, 1);
  assert.deepEqual(writeCalls(client), []);
  assert.match(result.out, /Konflikty: duplikat w repozytorium/);
});

test('etykieta spoza manifestu nigdy nie jest usuwana, ale łamie zgodność po zapisie (kod 1)', () => {
  const client = fakeClient(synced([{ name: 'obca', color: 'ffffff', description: '' }]));
  const result = runMain(['sync'], { client, env: ENV });
  assert.equal(result.code, 1);
  assert.deepEqual(writeCalls(client), []);
  assert.ok(client.labels.some((l) => l.name === 'obca'));
  assert.match(result.out, /Niesklasyfikowane w repozytorium: obca/);
});

test('kolejność operacji: zmiana nazwy, utworzenie, poprawka, usunięcie (AC-3)', () => {
  const state = synced([{ name: 'old-extra', color: 'aaaaaa', description: 'Etykieta lokalna.' }, { name: 'stale', color: 'ffffff', description: '' }])
    .filter((l) => l.name !== 'extra' && l.name !== 'area:two');
  state[0] = { ...state[0], color: '000000' };
  const client = fakeClient(state);
  const result = runMain(['sync'], { client, env: ENV, local: local({ rename: [{ from: 'old-extra', to: 'extra' }], delete: ['stale'] }) });
  assert.equal(result.code, 0, result.out);
  assert.deepEqual(writeCalls(client), ['rename:old-extra', 'create:area:two', 'update:P0', 'delete:stale']);
  assert.deepEqual(client.labels.map((l) => l.name).sort(), synced().map((l) => l.name).sort());
});

test('zmiana nazwy zachowuje przypisania: używa rename, nie create i delete', () => {
  const state = synced().map((l) => (l.name === 'extra' ? { ...l, name: 'old-extra' } : l));
  const client = fakeClient(state);
  const result = runMain(['sync'], { client, env: ENV, local: local({ rename: [{ from: 'old-extra', to: 'extra' }], delete: [] }) });
  assert.equal(result.code, 0);
  assert.deepEqual(writeCalls(client), ['rename:old-extra']);
});

test('migracja rename z konfliktem: kod 1, zero zapisów', () => {
  const client = fakeClient(synced([{ name: 'old-extra', color: 'aaaaaa', description: '' }]));
  const result = runMain(['sync'], { client, env: ENV, local: local({ rename: [{ from: 'old-extra', to: 'extra' }], delete: [] }) });
  assert.equal(result.code, 1);
  assert.deepEqual(writeCalls(client), []);
});

// ---- AC-4: usuwanie

test('AC-4 GREEN: etykieta lokalna bez użyć jest usunięta po odczycie przypisań (odczyt przed usunięciem)', () => {
  const client = fakeClient(synced([{ name: 'stale', color: 'ffffff', description: '' }]));
  const result = runMain(['sync'], { client, env: ENV, local: local({ rename: [], delete: ['stale'] }) });
  assert.equal(result.code, 0, result.out);
  const at = (call) => client.calls.indexOf(call);
  assert.ok(at('usage:stale') !== -1 && at('usage:stale') < at('delete:stale'));
  assert.equal(client.calls.filter((c) => c === 'usage:stale').length, 2, 'odczyt w preflight i tuż przed usunięciem');
  assert.ok(!client.labels.some((l) => l.name === 'stale'));
});

test('AC-4: etykieta w użyciu zatrzymuje całość: kod 1, zero zapisów, także poprawek i utworzeń', () => {
  const state = synced([{ name: 'stale', color: 'ffffff', description: '' }]).filter((l) => l.name !== 'area:two');
  const client = fakeClient(state, { uses: { stale: 3 } });
  const result = runMain(['sync'], { client, env: ENV, local: local({ rename: [], delete: ['stale'] }) });
  assert.equal(result.code, 1);
  assert.deepEqual(writeCalls(client), []);
  assert.match(result.out, /Usunięcie wstrzymane: etykieta w użyciu/);
  assert.match(result.out, /stale: 3 zgłoszeń lub PR/);
  assert.ok(client.labels.some((l) => l.name === 'stale'));
});

test('AC-4: --dry-run też odczytuje użycie i zgłasza blokadę (kod 1), bez zapisu', () => {
  const client = fakeClient(synced([{ name: 'stale', color: 'ffffff', description: '' }]), { uses: { stale: 1 } });
  const result = runMain(['sync', '--dry-run'], { client, env: ENV, local: local({ rename: [], delete: ['stale'] }) });
  assert.equal(result.code, 1);
  assert.deepEqual(writeCalls(client), []);
});

test('AC-4: użycie pojawiające się tuż przed usunięciem wstrzymuje usunięcie (kod 2), wcześniejsze operacje zostają', () => {
  let reads = 0;
  const base = fakeClient(synced([{ name: 'stale', color: 'ffffff', description: '' }]).filter((l) => l.name !== 'area:two'));
  const client = { ...base, usage: (name) => { base.calls.push(`usage:${name}`); reads += 1; return reads > 1 ? 2 : 0; } };
  const result = runMain(['sync'], { client, env: ENV, local: local({ rename: [], delete: ['stale'] }) });
  assert.equal(result.code, 2);
  assert.match(result.err, /etykieta stale jest w użyciu \(2\), usunięcie wstrzymane/);
  assert.deepEqual(writeCalls(base), ['create:area:two']);
  assert.ok(base.labels.some((l) => l.name === 'stale'));
});

test('AC-4 RED: wpis migracji z etykietą rdzenia (także z flagą) zatrzymuje synchronizację: kod 2, zero wywołań klienta', () => {
  for (const name of CORE_NAMES) {
    for (const migrations of [{ delete: [name] }, { delete: [{ name, allow_in_use: true, reason: 'x' }] }, { rename: [{ from: name, to: 'extra' }] }]) {
      const client = fakeClient(synced());
      const result = runMain(['sync'], { client, env: ENV, local: local(migrations) });
      assert.equal(result.code, 2, name);
      assert.deepEqual(client.calls, [], name);
    }
  }
});

// ---- AC-5: błąd połowy migracji, weryfikacja po zapisie

test('AC-5: zmiana nazwy udana, utworzenie nieudane (429): usunięcie niewywołane, kod 2, log każdej operacji', () => {
  const state = synced([{ name: 'old-extra', color: 'aaaaaa', description: 'Etykieta lokalna.' }, { name: 'stale', color: 'ffffff', description: '' }])
    .filter((l) => l.name !== 'extra' && l.name !== 'area:two');
  const client = fakeClient(state, { failOn: ['create:area:two'] });
  const migrations = { rename: [{ from: 'old-extra', to: 'extra' }], delete: ['stale'] };
  const result = runMain(['sync'], { client, env: ENV, local: local(migrations) });
  assert.equal(result.code, 2);
  assert.match(result.err, /create area:two: atrapa: create area:two odrzucone \(429\); dalsze operacje \(w tym usunięcia\) wstrzymane/);
  assert.ok(!client.calls.includes('delete:stale'), 'usunięcie nie zostało wywołane');
  assert.match(result.out, /- rename old-extra -> extra: ok/);
  assert.match(result.out, /- create area:two: BŁĄD/);
  assert.ok(client.labels.some((l) => l.name === 'stale'));

  // drugi bieg: plan od nowa ze stanu żywego, bez duplikatów i bez kasowania przypisań
  client.calls.length = 0;
  const retry = fakeClient(client.labels, {});
  const second = runMain(['sync'], { client: retry, env: ENV, local: local(migrations) });
  assert.equal(second.code, 0, second.out);
  assert.deepEqual(writeCalls(retry), ['create:area:two', 'delete:stale']);
  const names = retry.labels.map((l) => l.name.toLowerCase());
  assert.equal(new Set(names).size, names.length, 'bez duplikatów');
});

test('AC-5: błąd przy usunięciu i przy poprawce przerywa kodem 2 z nazwą operacji', () => {
  const state = synced([{ name: 'stale', color: 'ffffff', description: '' }]);
  const del = runMain(['sync'], { client: fakeClient(state, { failOn: ['delete:stale'] }), env: ENV, local: local({ rename: [], delete: ['stale'] }) });
  assert.equal(del.code, 2);
  assert.match(del.err, /delete stale:/);
  const upd = synced().map((l) => (l.name === 'P0' ? { ...l, color: '000000' } : l));
  const result = runMain(['sync'], { client: fakeClient(upd, { failOn: ['update:P0'] }), env: ENV });
  assert.equal(result.code, 2);
  assert.match(result.err, /update P0 \(kolor\):/);
});

test('AC-5: brak uprawnień do zapisu wykryty w preflight: zero zmian', () => {
  const state = synced().filter((l) => l.name !== 'area:two');
  const client = fakeClient(state, { failOn: ['probe:P0'] });
  const result = runMain(['sync'], { client, env: ENV });
  assert.equal(result.code, 2);
  assert.equal(client.writes, 0);
  assert.deepEqual(client.calls.filter((c) => c.startsWith('create:')), [], 'utworzenie nie zostało wywołane');
});

test('preflight zapisu: aktualizacja istniejącej etykiety do jej własnych wartości, tylko gdy są zmiany', () => {
  const client = fakeClient(synced().filter((l) => l.name !== 'area:two'));
  runMain(['sync'], { client, env: ENV });
  assert.deepEqual(client.calls.filter((c) => /^(probe|create):/.test(c)), ['probe:P0', 'create:area:two']);

  const unmanaged = fakeClient([{ name: 'obca', color: 'ffffff', description: '' }]);
  runMain(['sync'], { client: unmanaged, env: ENV });
  assert.ok(!unmanaged.calls.some((c) => c.startsWith('probe:')), 'brak istniejącej etykiety zarządzanej: bez próby');
});

test('AC-5: weryfikacja po zapisie: stan inny niż zapisany to kod 1, nigdy zielony', () => {
  const client = fakeClient([], { stale: true });
  const result = runMain(['sync'], { client, env: ENV });
  assert.equal(result.code, 1);
  assert.match(result.out, /Stan etykiet po synchronizacji: różni się od manifestu/);
});

test('AC-5: zepsuta albo niepełna odpowiedź API to kod 2', () => {
  const garbage = { listLabels() { throw new SyntaxError('Unexpected token') ; }, calls: [] };
  const result = runMain(['sync'], { client: garbage, env: ENV });
  assert.equal(result.code, 2);
  assert.match(result.err, /Unexpected token/);
});

test('podsumowanie kroku (GITHUB_STEP_SUMMARY) jest dopisywane, gdy zmienna jest ustawiona', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'labels-summary-'));
  const file = path.join(dir, 'summary.md');
  try {
    runMain(['diff'], { client: fakeClient(synced()), env: { ...ENV, GITHUB_STEP_SUMMARY: file } });
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /^## Stan etykiet w owner\/repo: zgodny z manifestem\n\n- Do utworzenia: -\n/);
    assert.match(text, /\n\n$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: nieznane polecenie, brak polecenia, nadmiar argumentów i nieznana flaga to kod 2', () => {
  for (const argv of [[], ['nope'], ['check', 'extra'], ['check', '--zly'], ['diff', '--live']]) {
    const result = runMain(argv, { client: fakeClient([]), env: ENV });
    assert.equal(result.code, 2, argv.join(' '));
  }
  assert.match(runMain(['nope']).err, /użycie: labels_sync\.js check \| diff \| sync/);
});

test('domyślne ścieżki: rdzeń obok skryptu, plik lokalny w .github', () => {
  const sync = require('../.github/standard/labels/labels_sync');
  assert.equal(path.basename(sync.CORE_PATH), 'labels-core.json');
  assert.equal(path.basename(path.dirname(sync.CORE_PATH)), 'labels');
  assert.equal(path.relative(path.resolve(__dirname, '..'), sync.LOCAL_PATH).split(path.sep).join('/'), '.github/labels.json');
});

test('--live jest dozwolone tylko dla diff: sync z plikiem zamiast stanu z API to kod 2 bez wywołań', () => {
  for (const argv of [['sync', '--live', 'live.json'], ['sync', '--dry-run', '--live', 'live.json'], ['check', '--live', 'live.json']]) {
    const client = fakeClient([]);
    const result = runMain(argv, { client, env: ENV, files: { 'live.json': JSON.stringify(synced()) } });
    assert.equal(result.code, 2, argv.join(' '));
    assert.match(result.err, /--live dotyczy tylko polecenia diff/);
    assert.deepEqual(client.calls, []);
  }
});
