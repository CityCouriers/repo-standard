'use strict';
// Testy zabijające mutanty `labels_sync.js`: dokładne komunikaty, wejścia graniczne, wywołanie jako skrypt.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { validate, merge, plan, pending, inSync, ghClient, main } = require('../.github/standard/labels/labels_sync');
const { readCore, syntheticLocal, liveFor, fakeClient, runMain } = require('./labels-fake');

const SCRIPT = path.join(__dirname, '..', '.github', 'standard', 'labels', 'labels_sync.js');
const ENV = { GITHUB_REPOSITORY: 'owner/repo' };

const errorsOf = (change) => {
  const core = readCore();
  const local = syntheticLocal();
  change(core, local);
  return validate(core, local, 'owner/repo');
};

test('kolor: ósmy znak przed sześcioma cyframi, liczba i tablica nie są kolorem (etykieta i rodzina)', () => {
  assert.match(errorsOf((core, local) => { local.labels[0].color = '#0E8A16'; }).join('\n'), /kolor nie jest 6 znakami hex/);
  assert.match(errorsOf((core, local) => { local.labels[0].color = 123456; }).join('\n'), /kolor nie jest 6 znakami hex/);
  assert.match(errorsOf((core, local) => { local.labels[0].color = ['0E8A16']; }).join('\n'), /kolor nie jest 6 znakami hex/);
  assert.deepEqual(errorsOf((core, local) => { local.families.misc = { color: '#AAAAAA' }; local.labels[2].color = '#AAAAAA'; }).filter((e) => /families/.test(e)), ['plik lokalny.families.misc.color: nie jest 6 znakami hex']);
  assert.deepEqual(errorsOf((core, local) => { local.families.misc = { color: 123456 }; }), ['plik lokalny.families.misc.color: nie jest 6 znakami hex']);
});

test('prefiks rodziny: pusty i nie-napis są błędem z dokładnym komunikatem', () => {
  assert.deepEqual(errorsOf((core, local) => { local.families.misc = { prefix: '' }; }), ['plik lokalny.families.misc.prefix: pusty albo nie jest napisem']);
  assert.deepEqual(errorsOf((core, local) => { local.families.misc = { prefix: 5 }; }), ['plik lokalny.families.misc.prefix: pusty albo nie jest napisem']);
});

test('komunikaty o etykiecie niosą nazwę i źródło (rdzeń albo plik lokalny)', () => {
  assert.deepEqual(errorsOf((core) => { core.labels[0].color = 'zz'; }), ['etykieta "P0" (rdzeń): kolor nie jest 6 znakami hex']);
  assert.ok(errorsOf((core, local) => { local.labels[0].color = 'zz'; }).includes('etykieta "area:one" (plik lokalny): kolor nie jest 6 znakami hex'));
});

test('opis nie będący napisem nie wywołuje kontroli pauz, a pauza w opisie napisu tak', () => {
  const errors = errorsOf((core, local) => { local.labels[0].description = ['—']; });
  assert.deepEqual(errors, ['etykieta "area:one" (plik lokalny) opis: pusty albo nie jest napisem']);
  assert.match(errorsOf((core, local) => { local.labels[0].description = 'a — b'; }).join('\n'), /pauza albo półpauza/);
});

test('migracje: komunikaty niosą migrację, nazwy from i to są kontrolowane osobno', () => {
  const errors = errorsOf((core, local) => { local.migrations = { rename: [{ from: 'a,b', to: 'area:one' }] }; });
  assert.deepEqual(errors, ['migracja "a,b" -> "area:one" from: przecinek w nazwie (kontrola użycia byłaby zawodna)']);
  const toErrors = errorsOf((core, local) => { local.migrations = { rename: [{ from: 'old', to: '..' }] }; });
  assert.ok(toErrors.includes('migracja "old" -> ".." to: nazwa \'.\' i \'..\' jest zabroniona'), toErrors.join('\n'));
  assert.deepEqual(errorsOf((core, local) => { local.migrations = { delete: ['a,b'] }; }), ['migracja delete "a,b": przecinek w nazwie (kontrola użycia byłaby zawodna)']);
  assert.ok(errorsOf((core, local) => { local.migrations = { rename: [{ from: 'old', to: 5 }] }; }).includes('migracja "old" -> 5: from i to muszą być napisami'));
  assert.ok(errorsOf((core, local) => { local.migrations = { rename: [{ from: 5, to: 'area:one' }] }; }).includes('migracja 5 -> "area:one": from i to muszą być napisami'));
});

test('migracje o złym kształcie dają błędy zamiast wyjątku', () => {
  assert.doesNotThrow(() => errorsOf((core, local) => { local.migrations = { rename: 5 }; }));
  assert.deepEqual(errorsOf((core, local) => { local.migrations = { rename: 5 }; }), ['migrations.rename: oczekiwano tablicy']);
  assert.deepEqual(errorsOf((core, local) => { local.migrations = { delete: 5 }; }), ['migrations.delete: oczekiwano tablicy']);
});

test('repo w pliku lokalnym: tablica z poprawnym napisem nie jest nazwą repozytorium', () => {
  assert.deepEqual(errorsOf((core, local) => { local.repo = ['owner/repo']; }), ['plik lokalny: repo musi mieć postać wlasciciel/nazwa']);
});

test('domyślne puste listy nie wprowadzają nazw: etykieta o dowolnej nazwie nie koliduje z brakującymi system, foreign i migrations', () => {
  const core = readCore();
  const local = syntheticLocal();
  delete local.system;
  delete local.foreign;
  delete local.migrations;
  local.labels.push({ name: 'Stryker was here', color: 'AAAAAA', family: 'misc', description: 'Nazwa pusta w domyślnych listach.' });
  assert.deepEqual(validate(core, local, 'owner/repo'), []);
  assert.deepEqual(merge(core, local).system, []);
  assert.deepEqual(merge(core, local).foreign, []);
  assert.deepEqual(merge(core, local).migrations, { rename: [], delete: [] });
});

test('wielkość liter: ß i SS to różne nazwy (porównanie przez małe litery)', () => {
  assert.deepEqual(errorsOf((core, local) => {
    local.labels.push({ name: 'ß', color: 'AAAAAA', family: 'misc', description: 'Eszet.' }, { name: 'SS', color: 'AAAAAA', family: 'misc', description: 'Dwie litery.' });
  }), []);
});

test('plan na pustych danych zwraca puste listy we wszystkich polach', () => {
  const empty = { labels: [], system: [], foreign: [], migrations: { rename: [], delete: [] } };
  assert.deepEqual(plan(empty, []), { create: [], update: [], rename: [], delete: [], unchanged: [], unclassified: [], missingKnown: [], conflicts: [] });
});

test('opis w stanie żywym: brak lub null to różnica "opis", także dla opisu podobnego do domyślnego', () => {
  const manifest = { labels: [{ name: 'x', color: 'AAAAAA', description: 'Stryker was here!' }], system: [], foreign: [], migrations: { rename: [], delete: [] } };
  for (const description of [undefined, null, '']) {
    assert.deepEqual(plan(manifest, [{ name: 'x', color: 'aaaaaa', description }]).update.map((u) => u.what), [['opis']]);
  }
});

test('pending i inSync: każdy rodzaj zmiany z osobna liczy się, a konflikt i niesklasyfikowane łamią zgodność', () => {
  const none = plan({ labels: [], system: [], foreign: [], migrations: { rename: [], delete: [] } }, []);
  assert.equal(pending(none), false);
  assert.equal(inSync(none), true);
  for (const key of ['create', 'update', 'rename', 'delete']) assert.equal(pending({ ...none, [key]: ['x'] }), true, key);
  assert.equal(inSync({ ...none, conflicts: ['x'] }), false);
  assert.equal(inSync({ ...none, unclassified: ['x'] }), false);
  assert.equal(inSync({ ...none, unchanged: ['x'] }), true);
});

test('raport diff: dokładne linie wszystkich ośmiu sekcji planu', () => {
  const core = readCore();
  const local = syntheticLocal({ migrations: { rename: [{ from: 'old', to: 'area:one' }], delete: ['gone'] } });
  const live = liveFor(core, local).filter((l) => l.name !== 'area:one' && l.name !== 'area:two');
  live.find((l) => l.name === 'P0').color = '000000';
  live.find((l) => l.name === 'P0').description = 'inny';
  live.push({ name: 'old', color: '0e8a16', description: 'Pierwszy obszar.' }, { name: 'gone', color: 'aaaaaa', description: '' }, { name: 'stray', color: 'aaaaaa', description: '' });
  const result = runMain(['diff', '--live', 'live.json'], { core, local, client: fakeClient([]), env: ENV, files: { 'live.json': JSON.stringify(live) } });
  assert.equal(result.code, 0);
  assert.equal(result.out, [
    '## Stan etykiet w owner/repo: różni się od manifestu',
    '- Do utworzenia: area:two',
    '- Do zmiany: P0 (kolor/opis)',
    '- Do przemianowania: old -> area:one',
    '- Do usunięcia (migracja): gone',
    '- Bez zmian: P1, P2, P3, P4, T1, T2, T3, blocked, needs-triage, by:agent, audit:pending, audit:changes, audit:ok, extra',
    '- Niesklasyfikowane w repozytorium: stray',
    '- Znane (system/obce) nieobecne w repozytorium: bug, vendor',
    '- Konflikty: -'
  ].join('\n'));
});

test('raport diff: konflikt i puste sekcje jako myślnik', () => {
  const core = readCore();
  const local = syntheticLocal();
  const live = [...liveFor(core, local), { name: 'stray', color: 'aaaaaa', description: '' }, { name: 'Stray', color: 'aaaaaa', description: '' }];
  const result = runMain(['diff', '--live', 'live.json'], { core, local, client: fakeClient([]), env: ENV, files: { 'live.json': JSON.stringify(live) } });
  assert.match(result.out, /- Konflikty: duplikat w repozytorium: "Stray"$/);
  assert.match(result.out, /- Do utworzenia: -\n- Do zmiany: -\n- Do przemianowania: -\n- Do usunięcia \(migracja\): -\n/);
});

test('podsumowanie GITHUB_STEP_SUMMARY: dokładna treść, linie bez separatora, pusty wiersz na końcu', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'labels-summary-'));
  const file = path.join(dir, 'summary.md');
  try {
    const core = readCore();
    const local = syntheticLocal();
    const live = [...liveFor(core, local), { name: 'stray', color: 'aaaaaa', description: '' }];
    const result = runMain(['diff', '--live', 'live.json'], { core, local, client: fakeClient([]), env: { ...ENV, GITHUB_STEP_SUMMARY: file }, files: { 'live.json': JSON.stringify(live) } });
    assert.equal(result.code, 0);
    const [title, ...lines] = result.out.split('\n');
    assert.equal(fs.readFileSync(file, 'utf8'), `${title}\n\n${lines.map((line) => `${line}\n`).join('')}\n`);
    assert.equal(lines.length, 8);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('błąd gh: komunikat bierze pierwszą niepustą linię po obcięciu białych znaków z całości', () => {
  const original = childProcess.execFileSync;
  childProcess.execFileSync = () => { throw Object.assign(new Error('x'), { stderr: '\n  gh: HTTP 500\ndruga' }); };
  try {
    assert.throws(() => ghClient('o/r').listLabels(), { message: 'gh api --paginate repos/o/r/labels?per_page=100: gh: HTTP 500' });
  } finally {
    childProcess.execFileSync = original;
  }
});

test('log operacji update łączy zmiany ukośnikiem', () => {
  const core = readCore();
  const local = syntheticLocal();
  const live = liveFor(core, local);
  live.find((l) => l.name === 'P0').color = '000000';
  live.find((l) => l.name === 'P0').description = 'inny';
  const client = fakeClient(live);
  const result = runMain(['sync'], { core, local, client, env: ENV });
  assert.equal(result.code, 0);
  assert.match(result.out, /- update P0 \(kolor\/opis\): ok/);
});

test('plik bez kodu błędu: komunikat o braku pliku podaje "błąd odczytu"', () => {
  const err = [];
  const code = main(['check'], { env: ENV, out: { log() {} }, err: { error: (m) => err.push(m) }, readFile: () => { throw new Error('boom'); } });
  assert.equal(code, 2);
  assert.match(err[0], /brak pliku .*labels-core\.json \(błąd odczytu\)$/);
});

test('błędny argument: komunikat parsera dociera do użytkownika, kod 2', () => {
  const err = [];
  const code = main(['check', '--zly'], { env: ENV, out: { log() {} }, err: { error: (m) => err.push(m) } });
  assert.equal(code, 2);
  assert.match(err[0], /^labels_sync: .*--zly/);
});

test('sync z konfliktem w repozytorium kończy się kodem 1 bez żadnego zapisu ani sondy', () => {
  const core = readCore();
  const local = syntheticLocal();
  const live = [...liveFor(core, local), { name: 'p0', color: 'aaaaaa', description: '' }, { name: 'area:two', color: 'zzz', description: 'x' }];
  const client = fakeClient(live);
  const result = runMain(['sync'], { core, local, client, env: ENV });
  assert.equal(result.code, 1);
  assert.equal(client.writes, 0);
  assert.ok(!client.calls.some((c) => /^(create|update|probe|rename|delete):/.test(c)), client.calls.join());
});

test('sync na stanie zgodnym nie wykonuje sondy zapisu', () => {
  const core = readCore();
  const local = syntheticLocal();
  const client = fakeClient([...liveFor(core, local), { name: 'bug', color: 'aaaaaa', description: '' }, { name: 'vendor', color: 'aaaaaa', description: '' }]);
  const result = runMain(['sync'], { core, local, client, env: ENV });
  assert.equal(result.code, 0);
  assert.deepEqual(client.calls, ['list', 'list']);
});

test('wywołanie jako skrypt: check kończy się kodem 0 z raportem, zły argument kodem 2', () => {
  const ok = childProcess.spawnSync(process.execPath, [SCRIPT, 'check'], { encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: '', GITHUB_STEP_SUMMARY: '' } });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /## Manifest etykiet: poprawny/);
  const bad = childProcess.spawnSync(process.execPath, [SCRIPT, 'nope'], { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /użycie: labels_sync\.js check \| diff \| sync/);
});
